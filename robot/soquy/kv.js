/* =====================================================================
   KIOTVIET HOTEL — đăng nhập + đọc sổ quỹ qua API nội bộ của trang web
   ---------------------------------------------------------------------
   Không có API công khai, nên: đăng nhập bằng trình duyệt thật (Playwright) như
   người dùng, bắt lấy header của phiên đăng nhập, rồi gọi thẳng API mà chính trang
   web KiotViet đang dùng. Nhanh và ít vỡ hơn bấm và đọc giao diện.

   CHỈ ĐỌC. File này không có một lệnh POST/PUT/DELETE nào tới KiotViet ngoài
   bước đăng nhập (do chính trang đăng nhập gửi khi bấm nút).

   Những gì đã khảo sát được (robot/soquy/survey.js, tháng 9/2026):
   - Đăng nhập: trang hotel.kiotviet.vn/login → POST /api/auth/salelogin. Không có OTP.
   - Sổ quỹ:   GET /api/cashflow?format=json&$inlinecount=allpages&$top=N&$filter=...
               $filter PHẢI có đủ dạng (BranchId eq X and TransDate ... and (Status eq 0))
               thì mới được áp dụng — thiếu vế nào là nó lặng lẽ trả về mọi phiếu.
               Status 0 = đã thanh toán, 1 = đã huỷ.
               $skip gây lỗi 500 → không phân trang được, phải chia nhỏ khoảng ngày.
               TransDate là giờ Việt Nam, không có múi giờ.
   - Tổng tháng: GET /api/dashboard/cashflow-summary?Filter={StartDate,EndDate,TimeRange:"O"}
               → TotalReceipt / TotalPayment, dùng để đối chiếu.
   ===================================================================== */
const BASE = 'https://hotel.kiotviet.vn';
const PAGE = 100;

/* Tìm ô đăng nhập theo tên / placeholder — trang không có id cố định */
async function fillBy(page, filled, re, value) {
  const inputs = await page.$$('input:visible');
  for (const [i, el] of inputs.entries()) {
    if (filled.has(i)) continue;
    const meta = await el.evaluate(e => [e.type, e.id, e.name, e.placeholder, e.getAttribute('aria-label') || ''].join(' '));
    if (re.test(meta)) { filled.add(i); await el.fill(value); return true; }
  }
  return false;
}

/* Đăng nhập, trả về { headers, branchId } để gọi API. Header chỉ nằm trong bộ nhớ. */
async function login(ctx, page, { shop, user, pass }) {
  /* Chỉ lấy header SAU KHI salelogin trả về thành công: trang đăng nhập tự gọi API mang sẵn một
     header authorization "khách" từ trước khi đăng nhập — bắt nhầm cái đó là robot tưởng đã vào. */
  let headers = null, branchId = null, loggedIn = false;
  page.on('request', req => {
    if (loggedIn && !headers && req.url().startsWith(BASE + '/api/') && String(req.headers().authorization || '').length > 20) {
      headers = { ...req.headers() };
      ['content-length', 'baggage', 'sentry-trace'].forEach(k => delete headers[k]);
    }
  });
  page.on('response', async res => {
    if (/\/api\/auth\/salelogin/.test(res.url())) {
      try {
        const j = await res.json();
        if (res.status() === 200 && j.BearerToken) { branchId = j.BranchId; loggedIn = true; }
      } catch (e) { }
    }
  });

  await page.goto(BASE + '/login', { waitUntil: 'networkidle', timeout: 60000 });
  const filled = new Set();
  const ok = await fillBy(page, filled, /retailer|gian ?h[aà]ng|shop|store/i, shop)
    && await fillBy(page, filled, /user|t[eê]n ?đăng ?nh[aậ]p|email|phone|account/i, user)
    && await fillBy(page, filled, /password/i, pass);
  if (!ok) throw new Error('Không nhận ra ô đăng nhập — KiotViet có thể đã đổi trang đăng nhập');
  const btn = page.locator('button:visible, input[type=submit]:visible, a:visible')
    .filter({ hasText: /^\s*(Quản lý|Đăng nhập)\s*$/i }).first();
  if (await btn.count()) await btn.click(); else await page.keyboard.press('Enter');

  /* Chờ rời trang đăng nhập, rồi chờ trang Tổng quan tự gọi API để bắt header của phiên */
  await page.waitForURL(u => !/\/login/i.test(String(u)), { timeout: 60000 }).catch(() => { });
  await page.waitForLoadState('networkidle', { timeout: 60000 }).catch(() => { });
  for (let i = 0; i < 30 && !headers; i++) await page.waitForTimeout(1000);
  if (/\/login/i.test(page.url())) throw new Error('Đăng nhập KiotViet thất bại — sai tài khoản/mật khẩu hoặc bị hỏi thêm bước xác minh');
  if (!headers) throw new Error('Đăng nhập được nhưng không bắt được phiên làm việc (không thấy header authorization)');
  if (!branchId) branchId = Number(headers.branchid) || null;
  if (!branchId) throw new Error('Không biết mã chi nhánh');
  return { headers, branchId };
}

async function getJson(ctx, headers, path) {
  const r = await ctx.request.get(BASE + path, { headers, timeout: 45000 });
  if (r.status() !== 200) throw new Error('KiotViet trả lỗi ' + r.status() + ' cho ' + path.split('?')[0]);
  return r.json();
}

/* 'YYYY-MM-DD' ± n ngày */
const dayAdd = (d, n) => {
  const t = new Date(d + 'T00:00:00Z');
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
};
const daysBetween = (a, b) => Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 864e5);

/* Mọi phiếu ĐÃ THANH TOÁN có ngày trong [from, toExcl). Nếu một lần gọi không lấy hết
   (quá PAGE phiếu) thì chia đôi khoảng ngày rồi gọi tiếp — không dùng được $skip. */
async function fetchCash(ctx, headers, branchId, from, toExcl) {
  const filter = `(BranchId eq ${branchId} and TransDate ge datetime'${from}T00:00:00'`
    + ` and TransDate lt datetime'${toExcl}T00:00:00' and (Status eq 0))`;
  const path = '/api/cashflow?format=json&%24inlinecount=allpages&%24top=' + PAGE
    + '&%24orderby=TransDate&%24filter=' + encodeURIComponent(filter);
  const j = await getJson(ctx, headers, path);
  if (!Array.isArray(j.Data)) throw new Error('API sổ quỹ trả về không đúng dạng (thiếu Data)');
  if (j.Data.length >= Number(j.Total || 0)) {
    /* Chặn trường hợp bộ lọc bị bỏ qua (KiotViet đổi API): có phiếu nằm ngoài khoảng ngày là dừng ngay */
    const out = j.Data.find(x => String(x.TransDate).slice(0, 10) < from || String(x.TransDate).slice(0, 10) >= toExcl);
    if (out) throw new Error('Bộ lọc ngày của KiotViet không còn tác dụng (có phiếu ngày ' + String(out.TransDate).slice(0, 10) + ') — cần khảo sát lại');
    return j.Data;
  }
  const span = daysBetween(from, toExcl);
  if (span <= 1) throw new Error('Ngày ' + from + ' có hơn ' + PAGE + ' phiếu — cần thêm cách phân trang');
  const mid = dayAdd(from, Math.floor(span / 2));
  return (await fetchCash(ctx, headers, branchId, from, mid)).concat(await fetchCash(ctx, headers, branchId, mid, toExcl));
}

/* Tổng thu / chi KiotViet tự tính cho một khoảng — để đối chiếu */
async function fetchSummary(ctx, headers, from, toExcl) {
  const f = encodeURIComponent(JSON.stringify({ StartDate: from + 'T00:00:00+07:00', EndDate: toExcl + 'T00:00:00+07:00', TimeRange: 'O' }));
  const j = await getJson(ctx, headers, '/api/dashboard/cashflow-summary?Filter=' + f);
  return { thu: Number(j.TotalReceipt) || 0, chi: Number(j.TotalPayment) || 0 };
}

module.exports = { login, fetchCash, fetchSummary, dayAdd, daysBetween };
