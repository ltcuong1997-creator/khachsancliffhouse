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

    /* 2. Ghi lại menu để biết Sổ quỹ nằm ở đâu */
    report.menu = await page.$$eval('a', as => as
      .filter(a => a.offsetParent !== null || /quỹ|thu chi|cash/i.test(a.innerText + a.href))
      .map(a => ({ text: (a.innerText || '').trim().slice(0, 40), href: a.getAttribute('href') || '' }))
      .filter(a => a.text || a.href).slice(0, 150));

    /* 3. Mở Sổ quỹ: bấm menu nếu thấy, không thì thử các đường dẫn quen của KiotViet */
    const before = calls.length;
    let opened = false;
    const link = page.locator('a, li, span').filter({ hasText: /^\s*Sổ quỹ\s*$/i }).first();
    if (await link.count()) {
      /* Mục menu có thể nằm trong menu xổ xuống — hiện ra trước khi bấm */
      const parent = page.locator('a, li, span').filter({ hasText: /^\s*(Báo cáo|Thu chi|Tài chính)\s*$/i }).first();
      if (await parent.count()) await parent.hover().catch(() => { });
      await link.click({ timeout: 8000 }).then(() => { opened = true; }).catch(() => { });
    }
    if (!opened) {
      const base = new URL(page.url());
      for (const h of ['#/CashFlow', '#/CashBook', '#/cashflow', '#/Cashbook']) {
        await page.goto(base.origin + base.pathname + h, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => { });
        await page.waitForTimeout(2500);
        if (calls.length > before) { opened = true; break; }
      }
    }
    await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => { });
    await page.waitForTimeout(4000);
    await shot(page, 'so-quy');
    report.cashCalls = calls.slice(before).map((c, i) => before + i);
    report.ok = opened;
    if (!opened) report.error = 'Không mở được trang Sổ quỹ — xem menu trong report để tìm đường dẫn đúng';
  } catch (e) {
    report.error = scrub(e.message);
    console.log('::error::' + report.error);
    await shot(page, 'loi');
  } finally {
    fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
    /* Tóm tắt ra log để đọc nhanh — không có dữ liệu tiền, chỉ có đường dẫn và tên trường */
    console.log('\n===== TÓM TẮT =====');
    console.log('Kết quả: ' + (report.ok ? 'mở được Sổ quỹ' : 'CHƯA mở được Sổ quỹ') + (report.error ? ' · ' + report.error : ''));
    console.log('Các request API (' + calls.length + '):');
    calls.forEach((c, i) => {
      const keys = c.body && typeof c.body === 'object' ? Object.keys(c.body).slice(0, 12).join(',') : '';
      console.log(String(i).padStart(3) + ' ' + c.method + ' ' + c.status + ' ' + c.url + (keys ? '  {' + keys + '}' : ''));
    });
    await browser.close();
    process.exit(report.error ? 1 : 0);
  }
})();
