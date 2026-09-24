/* =====================================================================
   ROBOT SỔ QUỸ — kéo phiếu thu/chi KiotViet Hotel về Firestore (ch_cash)
   ---------------------------------------------------------------------
   Chạy trên GitHub Actions (.github/workflows/robot-soquy.yml).

   Biến môi trường:
     KV_SHOP, KV_USER, KV_PASS    tài khoản KiotViet (GitHub Secrets)
     FIREBASE_SERVICE_ACCOUNT     JSON service account (GitHub Secrets) — thiếu thì chỉ chạy thử
     FROM, TO                     khoảng ngày YYYY-MM-DD (tuỳ chọn). Bỏ trống = tự chọn:
                                  cả tháng hiện tại; ngày 1–5 thì kéo thêm cả tháng trước
     DRY_RUN=true                 kéo + đối chiếu + in kết quả, KHÔNG ghi gì

   Quy tắc ghi (đúng như spec):
   - Chỉ thay phiếu có ngày NẰM TRONG khoảng vừa kéo; ngày khác trong tháng giữ nguyên.
   - Mỗi phiếu lấy mã phiếu KiotViet làm id (kv_<Code>) → chạy lại bao nhiêu lần cũng ra
     đúng một bộ, không cộng dồn.
   - Không bao giờ đụng tới tháng trước MIN_DATE (dữ liệu cũ nạp bằng Excel giữ nguyên).
   - Phiếu mà "Chốt đã chi lương" đang trỏ tới (ch_payroll/<tháng>.close.ids) nếu bị thay id
     thì nối lại sang phiếu mới cùng ngày + cùng số tiền, để lương không bị trừ hai lần.
   - Mỗi lần chạy ghi nhịp tim vào ch_config/robot để app hiện ở trang Cấu hình.
   ===================================================================== */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const kv = require('./kv');

const MIN_DATE = '2026-09-01';       /* nạp đè từ tháng 9/2026 — trước đó là dữ liệu Excel, không đụng */
const OUT = path.join(__dirname, 'out');
const env = process.env;
const DRY = /^(1|true|yes)$/i.test(env.DRY_RUN || '');
const RUN_URL = env.GITHUB_RUN_ID ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}` : '';

if (!env.KV_SHOP || !env.KV_USER || !env.KV_PASS) {
  console.log('::notice::Chưa có đủ secrets KV_SHOP / KV_USER / KV_PASS — bỏ qua lần chạy này.');
  process.exit(0);
}
fs.mkdirSync(OUT, { recursive: true });

/* ---------- Ngày giờ Việt Nam ---------- */
const vnToday = () => new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10);
const monthStart = (d) => d.slice(0, 8) + '01';
const nextMonth = (d) => { const [y, m] = d.split('-').map(Number); return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`; };
const prevMonth = (d) => { const [y, m] = d.split('-').map(Number); return m === 1 ? `${y - 1}-12-01` : `${y}-${String(m - 1).padStart(2, '0')}-01`; };
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '');

/* Khoảng ngày cần kéo: [from, to] (to là ngày cuối, TÍNH CẢ ngày đó) */
function pickRange() {
  const today = vnToday();
  let from, to;
  if (env.FROM || env.TO) {
    if (!isDate(env.FROM) || !isDate(env.TO) || env.FROM > env.TO) throw new Error('FROM / TO phải có dạng YYYY-MM-DD và FROM ≤ TO');
    from = env.FROM; to = env.TO;
  } else {
    to = today;
    from = Number(today.slice(8, 10)) <= 5 ? prevMonth(today) : monthStart(today);
  }
  if (to > today) to = today;
  if (from < MIN_DATE) from = MIN_DATE;
  if (from > to) throw new Error('Khoảng ngày rỗng sau khi áp mốc ' + MIN_DATE);
  return { from, to };
}

/* Phiếu KiotViet → dòng sổ quỹ của app (cùng dạng với phiếu nạp từ Excel) */
function toRow(x) {
  const amt = Math.round(Number(x.Amount) || 0);
  const type = amt >= 0 ? 'thu' : 'chi';
  const cat = String(x.CashGroup || '').trim() || (type === 'thu' ? 'Doanh thu phòng' : 'Chi phí khác');
  const note = String(x.Description || '').trim() || String(x.PartnerName || '').trim() || cat;
  return {
    id: 'kv_' + x.Code,
    date: String(x.TransDate).slice(0, 10),
    type, amount: Math.abs(amt), cat, note,
    code: String(x.Code),
    method: x.Method || '',
    /* 0 = KiotViet đánh dấu loại này KHÔNG tính vào báo cáo tài chính (vd. gửi tiền vào ngân hàng) */
    fin: x.UsedForFinancialReporting === 0 ? 0 : 1,
  };
}

const monthsIn = (from, to) => {
  const out = [];
  for (let d = monthStart(from); d <= to; d = nextMonth(d)) out.push(d.slice(0, 7));
  return out;
};
const sum = (rows, type) => rows.filter(r => r.type === type).reduce((a, r) => a + r.amount, 0);

/* ---------- Firestore ---------- */
function openFirestore() {
  if (!env.FIREBASE_SERVICE_ACCOUNT) return null;
  const admin = require('firebase-admin');
  const cred = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({ credential: admin.credential.cert(cred), projectId: cred.project_id });
  return admin.firestore();
}

/* Nối lại liên kết chốt lương: id cũ không còn → tìm phiếu mới cùng ngày, cùng loại, cùng số tiền */
function remapCloses(closes, oldById, newRows, removedIds) {
  const taken = new Set();
  const changes = [], lost = [];
  for (const [mk, close] of Object.entries(closes)) {
    if (!close || !Array.isArray(close.ids)) continue;
    let dirty = false;
    const ids = close.ids.map(id => {
      if (!removedIds.has(id)) return id;
      const old = oldById.get(id);
      const cand = old && (newRows.find(r => !taken.has(r.id) && r.date === old.date && r.type === old.type && r.amount === old.amount && r.cat === old.cat)
        || newRows.find(r => !taken.has(r.id) && r.date === old.date && r.type === old.type && r.amount === old.amount));
      if (cand) { taken.add(cand.id); dirty = true; return cand.id; }
      lost.push(mk + ': ' + id + (old ? ' (' + old.date + ' ' + old.amount + ')' : ''));
      return id;
    });
    if (dirty) changes.push({ mk, ids });
  }
  return { changes, lost };
}

(async () => {
  const t0 = Date.now();
  const beat = { at: new Date().toISOString(), ok: false, dry: DRY, from: null, to: null, rows: 0, months: {}, warn: [], error: null, run: RUN_URL };
  let db = null, browser = null, page = null;
  try {
    const { from, to } = pickRange();
    beat.from = from; beat.to = to;
    const toExcl = kv.dayAdd(to, 1);
    console.log(`Khoảng kéo: ${from} → ${to}${DRY ? ' (CHẠY THỬ — không ghi)' : ''}`);

    db = openFirestore();
    if (!db && !DRY) throw new Error('Thiếu secret FIREBASE_SERVICE_ACCOUNT — không ghi được Firestore');

    /* 1. Đăng nhập + kéo phiếu */
    browser = await chromium.launch();
    const ctx = await browser.newContext({ locale: 'vi-VN', timezoneId: 'Asia/Ho_Chi_Minh', viewport: { width: 1440, height: 900 } });
    page = await ctx.newPage();
    const { headers, branchId } = await kv.login(ctx, page, { shop: env.KV_SHOP, user: env.KV_USER, pass: env.KV_PASS });
    const raw = await kv.fetchCash(ctx, headers, branchId, from, toExcl);
    const seenCode = new Set();
    const rows = raw.filter(x => Number(x.Amount) && x.Code && !seenCode.has(x.Code) && seenCode.add(x.Code)).map(toRow);
    beat.rows = rows.length;
    console.log(`Kéo được ${raw.length} phiếu (${rows.length} phiếu hợp lệ)`);

    /* 2. Đối chiếu với tổng KiotViet tự tính, từng tháng */
    for (const mk of monthsIn(from, to)) {
      const a = [from, mk + '-01'].sort()[1];
      const bExcl = [toExcl, nextMonth(mk + '-01')].sort()[0];
      const mine = rows.filter(r => r.date >= a && r.date < bExcl);
      const ref = await kv.fetchSummary(ctx, headers, a, bExcl);
      const m = { from: a, to: kv.dayAdd(bExcl, -1), n: mine.length, thu: sum(mine, 'thu'), chi: sum(mine, 'chi'), kvThu: ref.thu, kvChi: ref.chi };
      m.match = m.thu === ref.thu && m.chi === ref.chi;
      beat.months[mk] = m;
      console.log(`  ${mk} (${m.from} → ${m.to}): ${m.n} phiếu · thu ${m.thu.toLocaleString('vi-VN')} / KiotViet ${ref.thu.toLocaleString('vi-VN')}`
        + ` · chi ${m.chi.toLocaleString('vi-VN')} / KiotViet ${ref.chi.toLocaleString('vi-VN')} → ${m.match ? 'KHỚP' : 'LỆCH'}`);
      if (!m.match) beat.warn.push(`${mk}: tổng không khớp KiotViet (thu ${m.thu} vs ${ref.thu}, chi ${m.chi} vs ${ref.chi})`);
    }
    const noFin = rows.filter(r => !r.fin);
    if (noFin.length) console.log(`  (${noFin.length} phiếu thuộc loại KiotViet không tính vào báo cáo tài chính: ${Array.from(new Set(noFin.map(r => r.cat))).join(', ')})`);

    /* 3. Ghép vào Firestore: mỗi tháng thay đúng các ngày trong khoảng */
    if (db) {
      const writes = [];
      const closes = {};
      const pay = await db.collection('ch_payroll').get();
      pay.docs.forEach(d => { if (d.data().close) closes[d.id] = d.data().close; });

      const oldById = new Map(), removed = new Set();
      for (const mk of monthsIn(from, to)) {
        const snap = await db.collection('ch_cash').doc(mk).get();
        const cur = (snap.exists && snap.data().rows) || [];
        const keep = cur.filter(r => r.date < from || r.date > to);
        const drop = cur.filter(r => !(r.date < from || r.date > to));
        drop.forEach(r => { oldById.set(r.id, r); removed.add(r.id); });
        const fresh = rows.filter(r => r.date.slice(0, 7) === mk);
        fresh.forEach(r => removed.delete(r.id));
        const next = keep.concat(fresh).sort((x, y) => (x.date + x.id).localeCompare(y.date + y.id));
        const kept = drop.filter(r => fresh.some(f => f.id === r.id)).length;
        console.log(`  ${mk}: có sẵn ${cur.length} phiếu · giữ ${keep.length} ngoài khoảng · thay ${drop.length} → ${fresh.length} (trùng mã ${kept})`);
        writes.push(['ch_cash', mk, { rows: next }]);
      }
      const { changes, lost } = remapCloses(closes, oldById, rows, removed);
      changes.forEach(c => {
        console.log(`  Chốt lương ${c.mk}: nối lại liên kết phiếu chi`);
        writes.push(['ch_payroll', c.mk, { close: { ...closes[c.mk], ids: c.ids } }]);
      });
      lost.forEach(l => beat.warn.push('Chốt lương mất liên kết phiếu ' + l + ' — vào Bảng lương mở chốt rồi chốt lại'));

      if (!DRY) {
        const batch = db.batch();
        writes.forEach(([col, id, data]) => batch.set(db.collection(col).doc(id), data, { merge: col === 'ch_payroll' }));
        await batch.commit();
        console.log(`Đã ghi ${writes.length} document.`);
      } else {
        console.log(`CHẠY THỬ: lẽ ra ghi ${writes.length} document — không ghi.`);
      }
    }
    beat.ok = true;
  } catch (e) {
    beat.error = String(e.message || e).split('\n')[0];
    console.log('::error::' + beat.error);
    if (page) await page.screenshot({ path: path.join(OUT, 'loi.png'), fullPage: true }).catch(() => { });
  } finally {
    beat.sec = Math.round((Date.now() - t0) / 1000);
    beat.warn.forEach(w => console.log('::warning::' + w));
    fs.writeFileSync(path.join(OUT, 'heartbeat.json'), JSON.stringify(beat, null, 2));
    if (db && !DRY) await db.collection('ch_config').doc('robot').set(beat).catch(e => console.log('::warning::Không ghi được nhịp tim: ' + e.message));
    if (browser) await browser.close();
    process.exit(beat.ok ? 0 : 1);
  }
})();
