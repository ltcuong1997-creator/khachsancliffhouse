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

## Nạp số liệu hằng tháng

Gói KiotViet Hotel đang dùng **không mở API**, nên không tự đồng bộ được.
Bù lại màn hình Sổ quỹ **xuất được Excel** — thế là đủ, và cách này không cần khoá,
không cần mật khẩu, không gãy khi KiotViet đổi giao diện.

1. KiotViet → **Sổ quỹ** → chọn khoảng thời gian là tháng cần nạp → **Xuất file**
2. App → **Cấu hình → Nạp file sổ quỹ** → thả file vào

Lần đầu app hỏi cột nào là ngày, cột nào là số tiền. Nó **tự đoán trước** rồi cho xem bảng
trước khi lưu — nhìn thấy đúng thì bấm Nạp. Ghép một lần là nhớ luôn, lần sau thả file vào
là chạy thẳng.

**Nạp lại cùng một tháng thì đè lên, không nhân đôi số liệu.** Nên xuất bù, sửa phiếu bên
KiotViet xong cứ nạp lại thoải mái — lần nạp sau luôn đúng.

Nạp được cả nhiều tháng trong một file (xuất khoảng thời gian dài) — app tự tách theo tháng.

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
