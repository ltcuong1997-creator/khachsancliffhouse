# Cliff House — webapp quản trị khách sạn

Một file `public/index.html`, không build, không npm. Mở bằng trình duyệt là chạy.

## Chạy thử ngay

```bash
python -m http.server 5178 --directory public
```

Rồi mở http://localhost:5178

Mở thẳng file cũng được (nhấp đúp `public/index.html`), nhưng chạy qua server thì giống
môi trường thật hơn.

## Đang ở chế độ DEMO

`FB_CFG.apiKey` còn trống → app tự chạy bằng **dữ liệu mẫu lưu trong trình duyệt**.
Không nối máy chủ nào, sửa gì cũng được, không ảnh hưởng tới ai.

Số tháng 8/2026 lấy đúng từ báo cáo thật. Các tháng khác sinh tự động nhưng lợi nhuận
2026 được đặt khớp với con số đã đưa, nên biểu đồ và dòng lũy kế nhìn đúng thực tế.

Dựng lại dữ liệu mẫu: vào **Cấu hình → Dựng lại từ đầu**.

## 7 trang

| Trang | Làm gì |
|---|---|
| Báo cáo tổng hợp | Thu / chi / lương / lợi nhuận một tháng + khuôn báo cáo emoji copy được |
| Chi tiết chi phí | Từng loại chi, gom nhóm, biến động so tháng trước, bấm vào xem từng phiếu |
| P&L theo năm | Bảng doanh thu – chi phí từng loại – lợi nhuận × 12 tháng |
| Chấm công | Bảng ngang nhân viên × ngày, gõ số giờ, Enter/mũi tên đi tiếp như Excel |
| Bảng lương | Giờ × đơn giá − BHXH − tạm ứng, mã QR VietQR trên từng dòng |
| Nhân viên | Hồ sơ + tài khoản nhận lương |
| Cấu hình | Khóa KiotViet, tình trạng dữ liệu, bảng loại chi phí |

## Quy tắc tính tiền

```
Lợi nhuận tháng = Tổng thu − Tổng chi − Chi phí lương
```

- **Chi phí lương** mặc định là *tạm tính*: tổng `giờ công × đơn giá` của tháng đó.
- Khi lương được chi thật (thường ngày 10 tháng sau), vào **Bảng lương → Chốt đã chi lương**,
  chọn phiếu chi trong sổ quỹ. Từ đó:
  - tháng công dùng **số thực chi** thay cho số tạm tính;
  - phiếu chi đó **bị loại khỏi chi phí của tháng nó nằm trong**, nên không trừ lương hai lần.
- **Tạm ứng lương** không tính vào tổng chi — nó đã bị trừ ở bảng lương rồi.
- Mở chốt lại được bất cứ lúc nào.

## Còn thiếu gì trước khi chạy thật

1. **Firebase project mới** + bật Blaze (Cloud Functions cần gói này).
   Dán khối config vào `FB_CFG` ở đầu phần `<script id="src">` trong `public/index.html`.
2. **Cloud Function kéo sổ quỹ KiotViet Hotel** — cần `client_id`, `client_secret`,
   tên gian hàng. Chưa xác nhận được bản Hotel có mở API Sổ quỹ hay không; nếu không có
   thì chuyển sang nạp file Excel.
3. **Firestore rules** — 2 mức quyền: chủ thấy hết, kế toán không thấy lương và lợi nhuận.
   Hiện mới chặn ở giao diện (`ROLE_PAGES`), chưa chặn ở máy chủ.
4. **Đăng nhập Firebase Auth** — màn hình đăng nhập đã dựng sẵn, chờ cấu hình.
5. **Logo + tên thật** — sửa hằng `BRAND` ở đầu file.

## Triển khai

```bash
firebase deploy --only hosting
```
