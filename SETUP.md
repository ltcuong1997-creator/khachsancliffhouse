# Cliff House — dựng lần đầu

Project Firebase: **`khachsancliffhouse`**. Config đã cắm sẵn vào `public/index.html`.

Còn **4 việc** phải làm trong Firebase Console. Làm xong là đăng nhập được.

---

## 1. Bật đăng nhập bằng Email/Mật khẩu

Console → **Build → Authentication** → tab **Sign-in method**
→ bấm **Email/Password** → gạt **Enable** → **Save**.

## 2. Tạo tài khoản cho mình

Vẫn trong Authentication → tab **Users** → **Add user**
→ nhập email và mật khẩu (tự đặt, tối thiểu 6 ký tự) → **Add user**.

Xong rồi **copy cái UID** ở cột bên phải — chuỗi dài kiểu `k3Jd9...`. Cần nó ở bước sau.

## 3. Cấp quyền chủ cho tài khoản đó

App **không tự cấp quyền cho ai**. Vai trò nằm trong Firestore, chỉ sửa được từ Console —
đó là lý do kế toán không thể tự nâng mình thành chủ.

Console → **Build → Firestore Database** → **Start collection**

| Ô | Điền |
|---|---|
| Collection ID | `ch_users` |
| Document ID | **dán UID vừa copy** |
| Field 1 | tên `name`, kiểu `string`, giá trị: tên mày |
| Field 2 | tên `role`, kiểu `string`, giá trị: `owner` |

→ **Save**.

Sau này thêm kế toán thì làm y hệt, chỉ khác `role` = `acct`.

| role | Thấy được |
|---|---|
| `owner` | Tất cả 7 trang |
| `acct` | Chỉ Chi tiết chi phí + Chấm công. Không thấy đơn giá giờ, bảng lương, lợi nhuận |

## 4. Nạp luật bảo mật

**Quan trọng nhất.** Firestore mới tạo thường đang ở chế độ mở — ai biết project id
cũng đọc được sạch dữ liệu.

Console → **Firestore Database** → tab **Rules** → xoá hết nội dung cũ
→ dán toàn bộ file **`firestore.rules`** vào → **Publish**.

Hoặc nếu có Firebase CLI:

```bash
firebase deploy --only firestore:rules
```

---

## Nạp số liệu: robot tự kéo từ KiotViet

Từ tháng 9/2026, **robot trên GitHub Actions tự kéo sổ quỹ** mỗi giờ từ 7h đến 23h và lúc 0h30
(giờ VN), rồi ghi vào Firestore. Code ở `robot/soquy/`, lịch ở `.github/workflows/robot-soquy.yml`.

- **Chỉ đọc KiotViet.** Đăng nhập như người dùng rồi gọi API mà chính trang web KiotViet đang dùng.
- Mỗi lần kéo lại **cả tháng hiện tại** (ngày 1–5 thì kéo thêm tháng trước), chỉ thay đúng các ngày
  vừa kéo. Mỗi phiếu lấy mã phiếu KiotViet làm id → chạy lại bao nhiêu lần cũng không nhân đôi.
- Phiếu **đã huỷ** bên KiotViet thì bị bỏ ra.
- Không đụng tới dữ liệu **trước 9/2026** (dữ liệu nạp Excel cũ giữ nguyên).
- Tự đối chiếu tổng thu/chi với con số KiotViet tự tính; lệch là báo ở trang **Cấu hình**.
- Phiếu chi lương mà "Chốt đã chi lương" đang trỏ tới được nối lại tự động; không nối được thì
  trang Cấu hình báo để mở chốt rồi chốt lại.

### Cài một lần

GitHub repo → **Settings → Secrets and variables → Actions → New repository secret**, đủ 4 cái:

| Name | Secret |
|---|---|
| `KV_SHOP` | tên gian hàng KiotViet |
| `KV_USER` | tên đăng nhập — nên là tài khoản nhân viên riêng, chỉ quyền xem Sổ quỹ |
| `KV_PASS` | mật khẩu |
| `FIREBASE_SERVICE_ACCOUNT` | toàn bộ nội dung file JSON service account (cùng cái dùng để deploy) |

Rồi merge nhánh chứa robot vào `main`. **Lịch hẹn giờ của GitHub chỉ chạy trên nhánh `main`.**

### Chạy tay / chạy thử / nạp bù

Tab **Actions → Robot sổ quỹ → Run workflow**: điền **Từ ngày / Đến ngày** (bỏ trống = cả tháng
này), tích **Chạy thử** nếu chỉ muốn xem kết quả mà không ghi. Log của lần chạy in ra số phiếu và
bảng so với KiotViet của từng tháng.

Chi phí: mỗi lần chạy khoảng 1,5 phút, 18 lần/ngày → **khoảng 800 phút/tháng**. Repo riêng tư được
miễn phí 2.000 phút/tháng; repo công khai thì không tính.

### Nạp tay bằng Excel (dự phòng)

Khi robot lỗi, hoặc cần nạp tháng trước 9/2026:

1. KiotViet → **Sổ quỹ** → chọn khoảng thời gian → **Xuất file**
2. App → **Cấu hình → Nạp file sổ quỹ** → thả file vào

Lần đầu app hỏi cột nào là ngày, cột nào là số tiền. Nó **tự đoán trước** rồi cho xem bảng
trước khi lưu. Nạp lại cùng một tháng thì **đè lên**, không nhân đôi. Tháng nào robot đang kéo thì
lần chạy kế tiếp của robot ghi đè lại theo KiotViet.

---

## Chạy thử

```bash
python -m http.server 5178 --directory public
```

Mở http://localhost:5178 → đăng nhập bằng email vừa tạo.

Lần đầu vào sẽ **trống trơn** vì chưa có số liệu. Muốn xem app chạy thật với số mẫu:
**Cấu hình → Đẩy dữ liệu mẫu lên**. Chán rồi thì **Xoá sạch dữ liệu**.

Muốn xem giao diện mà **không đụng máy chủ**: thêm `?demo` vào cuối địa chỉ
→ http://localhost:5178/?demo

## Đưa lên mạng

```bash
firebase deploy --only hosting
```

Xong sẽ chạy ở `https://khachsancliffhouse.web.app`

### Tự deploy khi merge vào `main`

`.github/workflows/deploy.yml` tự chạy lệnh trên mỗi khi `main` có code mới. Chỉ cần làm một lần:

1. Firebase Console → ⚙️ **Project settings** → **Service accounts** → **Generate new private key**
   → tải về một file `.json`.
2. GitHub repo → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**.
   Name: `FIREBASE_SERVICE_ACCOUNT`, Secret: dán **toàn bộ** nội dung file `.json`.
3. Xoá file `.json` trên máy. Không commit nó vào repo.

Xem tiến trình ở tab **Actions** của repo; muốn deploy lại bằng tay thì bấm **Run workflow**.
`firestore.rules` không tự deploy — sửa rules thì vẫn chạy `firebase deploy --only firestore:rules`.

---

## Dữ liệu nằm ở đâu trên Firestore

Mỗi tháng **một document**, không phải mỗi phiếu một document — Firestore tính tiền
theo số document trả về, gom theo tháng thì mở app tốn 12 lượt đọc thay vì 600.

| Collection | Document | Bên trong |
|---|---|---|
| `ch_cash` | `2026-08` | `rows[]` — phiếu thu/chi của tháng |
| `ch_timesheet` | `2026-08` | `cells{}` giờ công + `names{}` tên nhân viên |
| `ch_payroll` | `2026-08` | `rows{}` BHXH/tạm ứng/đã trả + `close{}` chốt lương |
| `ch_employees` | mã nhân viên | hồ sơ, đơn giá giờ, tài khoản ngân hàng |
| `ch_config` | `main` | cách ghép cột của file sổ quỹ |
| `ch_config` | `robot` | nhịp tim robot: lần chạy gần nhất, OK/lỗi, đối chiếu từng tháng |
| `ch_users` | UID | `name`, `role` — **chỉ sửa tay trong Console** |

## Thêm người dùng về sau

Làm thẳng trong Console, hai bước:

1. **Authentication → Users → Add user** (email + mật khẩu) → copy UID
2. **Firestore → `ch_users`** → thêm document, ID = UID, hai field `name` và `role`
   (`owner` thấy hết, `acct` chỉ thấy Chi tiết chi phí + Chấm công)

App cố tình KHÔNG tự cấp quyền cho ai — đó là lý do kế toán không thể tự nâng mình thành chủ.

## Ghi chú

- **Không dùng Cloud Functions.** Gói **Blaze** không bắt buộc — Firestore + Hosting nằm trọn
  trong hạn mức miễn phí ở quy mô này. Giữ Blaze cũng chẳng sao, thực tế gần 0đ; muốn chắc thì
  vào Billing đặt một cảnh báo ngân sách.
- App chỉ tải 3 thư viện ngoài: React, Babel, Firebase. Thư viện đọc Excel chỉ tải khi mở
  hộp thoại nạp file, không bắt mọi người tải kèm mỗi lần vào app.
