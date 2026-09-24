/* =====================================================================
   KHẢO SÁT SỔ QUỸ KIOTVIET HOTEL — chạy một lần trên GitHub Actions
   ---------------------------------------------------------------------
   Mục đích: tìm xem trang Sổ quỹ lấy dữ liệu từ API nội bộ nào, để robot thật
   gọi thẳng API đó thay vì bấm và đọc giao diện.

   Robot này CHỈ ĐỌC:
   - chỉ điền ô đăng nhập và bấm nút đăng nhập, sau đó chỉ bấm vào mục menu để mở trang;
   - không bấm Lưu / Sửa / Xoá / Tạo phiếu nào;
   - không ghi gì vào Firestore.

   Kết quả nằm trong thư mục out/ (được đính kèm vào lần chạy trên GitHub):
   - report.json : danh sách request API, cấu trúc JSON trả về, mẫu vài dòng dữ liệu
   - *.png       : ảnh chụp từng bước
   Token, cookie, mật khẩu đều bị che trước khi ghi ra — không bao giờ lọt vào log.
   ===================================================================== */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const LOGIN_URL = 'https://hotel.kiotviet.vn/login';
const OUT = path.join(__dirname, 'out');
const { KV_SHOP, KV_USER, KV_PASS } = process.env;

/* Thiếu secrets thì thoát êm — không làm đỏ lần chạy */
if (!KV_SHOP || !KV_USER || !KV_PASS) {
  console.log('::notice::Chưa có đủ secrets KV_SHOP / KV_USER / KV_PASS — bỏ qua lần khảo sát này.');
  process.exit(0);
}
fs.mkdirSync(OUT, { recursive: true });

/* ---------- Che bí mật ---------- */
const SECRET_KEY = /auth|token|cookie|session|pass|secret|signature|jwt|bearer/i;
const SECRETS = [KV_PASS, KV_USER].filter(s => s && s.length >= 3);
const scrub = (s) => {
  let t = String(s == null ? '' : s);
  SECRETS.forEach(x => { t = t.split(x).join('***'); });
  /* chuỗi dài liền mạch kiểu JWT / token */
  t = t.replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, '***jwt***');
  return t;
};
const scrubUrl = (u) => {
  try {
    const x = new URL(u);
    for (const k of Array.from(x.searchParams.keys())) if (SECRET_KEY.test(k)) x.searchParams.set(k, '***');
    return scrub(x.toString());
  } catch (e) { return scrub(u); }
};
const scrubHeaders = (h) => {
  const o = {};
  for (const [k, v] of Object.entries(h || {})) {
    if (/^(accept|user-agent|sec-|referer|origin|accept-|content-length|priority)/i.test(k)) continue;
    o[k] = SECRET_KEY.test(k) || /^x-.*(key|id)$/i.test(k) && String(v).length > 24 ? '***' : scrub(v);
  }
  return o;
};
/* Cấu trúc JSON: tên trường + kiểu + ví dụ, mảng chỉ giữ 3 phần tử đầu */
const shape = (v, depth = 0) => {
  if (depth > 5) return '…';
  if (Array.isArray(v)) return { __array: v.length, sample: v.slice(0, 3).map(x => shape(x, depth + 1)) };
  if (v && typeof v === 'object') {
    const o = {};
    for (const [k, x] of Object.entries(v)) o[k] = SECRET_KEY.test(k) ? '***' : shape(x, depth + 1);
    return o;
  }
  if (typeof v === 'string') return scrub(v.length > 120 ? v.slice(0, 120) + '…' : v);
  return v;
};

/* ---------- Ghi lại mọi request API ---------- */
const calls = [];
const steps = [];
/* Header thật của một request API đã đăng nhập — CHỈ giữ trong bộ nhớ để gọi thử, không bao giờ in ra */
let liveHeaders = null;
const NOISE = /google|analytics|sentry|apm\.|trackjs|freshchat|ktarget|feature-management|portal-kma|timesheet|\/dashboard\/|reportapi\/charts|reportapi\/\/charts|einvoice|birthday|banner|third-parties|retailer-config|activities|hotellink|should-show/;
let shotNo = 0;
async function shot(page, name) {
  const f = String(++shotNo).padStart(2, '0') + '-' + name + '.png';
  try { await page.screenshot({ path: path.join(OUT, f), fullPage: true }); } catch (e) { }
  steps.push({ step: name, url: scrubUrl(page.url()), shot: f });
  console.log('• ' + name + ' → ' + scrubUrl(page.url()));
}

function watch(page) {
  page.on('response', async (res) => {
    const req = res.request();
    const type = req.resourceType();
    if (type !== 'xhr' && type !== 'fetch') return;
    if (!liveHeaders && /^https:\/\/hotel\.kiotviet\.vn\/api\//.test(req.url()) && req.headers().authorization) {
      liveHeaders = { ...req.headers() };
    }
    const rec = {
      method: req.method(),
      url: scrubUrl(req.url()),
      status: res.status(),
      reqHeaders: scrubHeaders(req.headers()),
      postData: null,
      contentType: res.headers()['content-type'] || '',
      body: null,
    };
    const pd = req.postData();
    if (pd) {
      /* Request đăng nhập chứa mật khẩu — chỉ giữ tên trường */
      try { rec.postData = shape(JSON.parse(pd)); } catch (e) { rec.postData = scrub(pd).slice(0, 400); }
      if (/login|signin|auth|token/i.test(req.url())) rec.postData = '*** (request đăng nhập, không ghi) ***';
    }
    if (/json/.test(rec.contentType)) {
      try { rec.body = shape(await res.json()); } catch (e) { rec.body = '(không đọc được JSON)'; }
    }
    calls.push(rec);
  });
}

/* ---------- Tìm ô đăng nhập bằng cách đoán theo tên / placeholder ---------- */
async function describeInputs(page) {
  return page.$$eval('input, button, a[role=button]', els => els
    .filter(e => e.offsetParent !== null)
    .map(e => ({
      tag: e.tagName.toLowerCase(), type: e.type || '', id: e.id || '', name: e.name || '',
      placeholder: e.placeholder || '', text: (e.innerText || e.value || '').trim().slice(0, 40),
    })));
}
const filled = new Set();
async function fillBy(page, re, value, label) {
  const inputs = await page.$$('input:visible');
  for (const [i, el] of inputs.entries()) {
    if (filled.has(i)) continue;
    const meta = await el.evaluate(e => [e.type, e.id, e.name, e.placeholder, e.getAttribute('aria-label') || ''].join(' '));
    if (re.test(meta)) { filled.add(i); await el.fill(value); console.log('  điền ô ' + label); return true; }
  }
  return false;
}

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 }, locale: 'vi-VN', timezoneId: 'Asia/Ho_Chi_Minh',
  });
  const page = await ctx.newPage();
  watch(page);
  const report = { at: new Date().toISOString(), ok: false, steps, calls, loginForm: null, menu: null, error: null };

  try {
    /* 1. Trang đăng nhập */
    await page.goto(LOGIN_URL, { waitUntil: 'networkidle', timeout: 60000 });
    report.loginForm = await describeInputs(page);
    await shot(page, 'trang-dang-nhap');

    const okShop = await fillBy(page, /retailer|gian ?h[aà]ng|shop|store|t[eê]n c[uử]a h[aà]ng/i, KV_SHOP, 'gian hàng');
    const okUser = await fillBy(page, /user|t[eê]n ?đăng ?nh[aậ]p|email|phone|đi[eệ]n tho[aạ]i|account/i, KV_USER, 'tên đăng nhập');
    const okPass = await fillBy(page, /password/i, KV_PASS, 'mật khẩu');
    if (!okShop || !okUser || !okPass) {
      throw new Error('Không nhận ra ô đăng nhập (gian hàng:' + okShop + ' user:' + okUser + ' pass:' + okPass + ') — xem loginForm trong report');
    }
    /* KiotViet thường có hai nút: "Quản lý" và "Bán hàng". Sổ quỹ nằm bên Quản lý. */
    const btn = page.locator('button:visible, input[type=submit]:visible, a:visible')
      .filter({ hasText: /^\s*(Quản lý|Đăng nhập)\s*$/i }).first();
    if (await btn.count()) await btn.click(); else await page.keyboard.press('Enter');
    await page.waitForLoadState('networkidle', { timeout: 60000 }).catch(() => { });
    await page.waitForTimeout(4000);
    await shot(page, 'sau-dang-nhap');
    if (/\/login/i.test(page.url())) throw new Error('Vẫn ở trang đăng nhập — sai tài khoản, hoặc bị hỏi thêm bước xác minh. Xem ảnh sau-dang-nhap.');

    /* 2. Ghi lại menu để biết Sổ quỹ nằm ở đâu — lấy cả mục đang ẩn trong menu xổ xuống */
    const shopSeg = (page.url().match(/mhqlv2\/([^/]+)\//) || [])[1];
    const hideShop = (s) => (shopSeg ? String(s).split(shopSeg).join('<gian-hang>') : String(s));
    report.menu = (await page.$$eval('a', as => as
      .map(a => ({ text: (a.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40), href: a.getAttribute('href') || '' }))
      .filter(a => a.text && a.href && a.href !== '#' && !/^javascript/i.test(a.href))))
      .map(a => ({ text: a.text, href: hideShop(a.href) }))
      .filter((a, i, arr) => arr.findIndex(b => b.href === a.href) === i)
      .slice(0, 200);

    /* 3. Mở Sổ quỹ. Chỉ coi là mở được khi tiêu đề/địa chỉ/nội dung trang thật sự đổi sang Sổ quỹ —
       không đếm request, vì trang Tổng quan cũng bắn rất nhiều request. */
    const before = calls.length;
    const isCashPage = async () => {
      const t = await page.title().catch(() => '');
      const h = await page.locator('h1, h2, h3, .page-title, .title').allTextContents().catch(() => []);
      return /sổ quỹ|so-quy|cashbook|cashflow/i.test(t + ' ' + h.join(' ')) && !/tổng quan/i.test(t);
    };
    let opened = false;
    /* a) bấm đúng link có chữ "Sổ quỹ" (kể cả đang ẩn trong menu con) */
    const cashLink = await page.$$eval('a', as => {
      const a = as.find(x => /^\s*sổ quỹ\s*$/i.test(x.textContent || ''));
      return a ? a.href : null;
    });
    report.nav = ['Link "Sổ quỹ" trong menu: ' + (cashLink ? hideShop(cashLink) : 'KHÔNG thấy')];
    if (cashLink) {
      await page.goto(cashLink, { waitUntil: 'networkidle', timeout: 45000 }).catch(() => { });
      await page.waitForTimeout(3000);
      opened = await isCashPage();
    }
    /* b) không thấy thì thử vài đường dẫn quen của KiotViet */
    if (!opened) {
      const root = page.url().split('#')[0].replace(/\/p\/[^/]+$/, '');
      for (const tail of ['/p/cashflow', '/p/CashFlow', '/p/cashbook', '/p/transaction#/CashFlow', '#/CashFlow']) {
        await page.goto(root + tail, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => { });
        await page.waitForTimeout(2500);
        if (await isCashPage()) { opened = true; break; }
      }
    }
    await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => { });
    await page.waitForTimeout(4000);
    report.nav.push('Trang cuối: ' + hideShop(scrubUrl(page.url())) + ' · tiêu đề: ' + (await page.title().catch(() => '')));
    await shot(page, 'so-quy');
    report.cashCalls = calls.slice(before).map((c, i) => before + i);
    report.ok = opened;
    if (!opened) report.error = 'Không mở được trang Sổ quỹ — xem MENU trong log để tìm đường dẫn đúng';

    /* 4. Gọi thử vài địa chỉ API sổ quỹ quen của KiotViet — CHỈ GET, dùng lại header của phiên đăng nhập.
       Chỉ ghi mã trả về + tên trường + 1 dòng mẫu. */
    report.probes = [];
    if (liveHeaders) {
      const h = { ...liveHeaders };
      ['content-length', 'baggage', 'sentry-trace'].forEach(k => delete h[k]);
      const filt = encodeURIComponent(JSON.stringify({ StartDate: '2026-09-01T00:00:00+07:00', EndDate: '2026-09-03T00:00:00+07:00', TimeRange: 'O' }));
      const odata = encodeURIComponent("(TransDate ge datetime'2026-09-01T00:00:00' and TransDate lt datetime'2026-09-03T00:00:00')");
      const cands = [
        '/api/cashflow?format=json&Includes=User&%24inlinecount=allpages&%24top=5',
        '/api/cashflow?format=json&%24inlinecount=allpages&%24top=5&%24filter=' + odata,
        '/api/cashflows?format=json&%24top=5',
        '/api/cashflow/getlist?format=json&Filter=' + filt,
        '/api/cashflow/list?format=json&Filter=' + filt,
        '/api/cashbook?format=json&%24top=5',
        '/api/cashflowgroup?format=json',
        '/api/cashflow/groups?format=json',
      ];
      for (const u of cands) {
        let status = 0, info = '';
        try {
          const r = await ctx.request.get('https://hotel.kiotviet.vn' + u, { headers: h, timeout: 20000 });
          status = r.status();
          const txt = await r.text();
          try {
            const j = JSON.parse(txt);
            const list = Array.isArray(j) ? j : (j.Data || j.data || j.Result || j.result || j.Items || null);
            info = 'trường: ' + (Array.isArray(j) ? '[mảng ' + j.length + ']' : Object.keys(j).slice(0, 15).join(','));
            if (j.Total != null || j.total != null) info += ' · Total=' + (j.Total ?? j.total);
            if (Array.isArray(list) && list.length) info += '\n      mẫu: ' + JSON.stringify(shape(list[0])).slice(0, 1500);
          } catch (e) { info = 'không phải JSON: ' + scrub(txt).slice(0, 120).replace(/\s+/g, ' '); }
        } catch (e) { info = 'lỗi: ' + scrub(e.message).slice(0, 120); }
        report.probes.push({ url: u.slice(0, 160), status, info });
      }
    } else {
      report.probes.push({ url: '-', status: 0, info: 'không bắt được header đăng nhập' });
    }
    /* 4. In chi tiết các request của trang Sổ quỹ: tên header (không có giá trị) + 1 dòng mẫu */
    console.log('\n===== REQUEST CỦA TRANG SỔ QUỸ =====');
    calls.slice(before)
      .filter(c => /kiotviet\.vn/.test(c.url) && !/analytics|sentry|apm\.|feature-management|freshchat|ktarget|portal-kma|trackjs/.test(c.url))
      .forEach(c => {
        console.log('\n' + c.method + ' ' + c.status + ' ' + hideShop(c.url));
        console.log('  header: ' + Object.keys(c.reqHeaders).join(', '));
        if (c.postData) console.log('  body gửi: ' + hideShop(JSON.stringify(c.postData)).slice(0, 600));
        if (c.body) console.log('  trả về: ' + hideShop(JSON.stringify(c.body)).slice(0, 2500));
      });
  } catch (e) {
    report.error = scrub(e.message);
    console.log('::error::' + report.error);
    await shot(page, 'loi');
  } finally {
    fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
    /* Tóm tắt ra log để đọc nhanh — không có dữ liệu tiền, chỉ có đường dẫn và tên trường */
    console.log('\n===== TÓM TẮT =====');
    console.log('Kết quả: ' + (report.ok ? 'mở được Sổ quỹ' : 'CHƯA mở được Sổ quỹ') + (report.error ? ' · ' + report.error : ''));
    const seen = new Set();
    console.log('Request API khác trang Tổng quan:');
    calls.forEach(c => {
      const key = c.method + ' ' + c.url.split('?')[0];
      if (NOISE.test(c.url) || seen.has(key)) return;
      seen.add(key);
      const keys = c.body && typeof c.body === 'object' ? Object.keys(c.body).slice(0, 14).join(',') : '';
      console.log('  ' + c.method + ' ' + c.status + ' ' + c.url.slice(0, 260) + (keys ? '  {' + keys + '}' : ''));
    });
    console.log('\n===== GỌI THỬ API SỔ QUỸ (chỉ GET) =====');
    (report.probes || []).forEach(p => console.log('  ' + p.status + ' ' + p.url + '\n      ' + p.info));
    console.log('\n===== MENU (' + (report.menu || []).length + ') =====');
    (report.menu || []).forEach(a => console.log('  ' + a.text.padEnd(32) + ' ' + a.href));
    console.log('\n' + (report.nav || []).join('\n'));
    await browser.close();
    process.exit(report.error ? 1 : 0);
  }
})();
