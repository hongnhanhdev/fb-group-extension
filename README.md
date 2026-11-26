# FB Group Post Cleaner

Tiện ích Chrome giúp bạn **xóa các bài mình đã đăng trong các nhóm Facebook**. Danh sách bài được lấy từ **Nhật ký hoạt động › Bài viết và bình luận trong nhóm**, nên bạn không phải vào từng nhóm để tìm.

- Không dùng Graph API (Meta đã gỡ Groups API từ 04/2024). Công cụ tự thao tác trên giao diện web, ngay trong trình duyệt bạn đang đăng nhập Facebook.
- **Không** hỏi, lưu hay gửi mật khẩu/cookie/token đi đâu. Danh sách bài và cài đặt chỉ nằm trong `chrome.storage.local` trên máy bạn.

> ⚠️ **Rủi ro – đọc trước khi dùng**
> - Tự động hóa thao tác trên Facebook là **trái Điều khoản dịch vụ của Facebook**. Bạn tự chịu trách nhiệm khi sử dụng.
> - Công cụ có giãn cách ngẫu nhiên, mô phỏng thao tác người thật và tự dừng khi thấy dấu hiệu bị chặn, nhưng **không cài đặt nào đảm bảo 100% không bị checkpoint** hay tạm khóa tính năng.
> - Bài đã xóa **không khôi phục được**.

## Cài đặt

1. Tải/giải nén thư mục này về máy (thư mục có `manifest.json`).
2. Mở `chrome://extensions`.
3. Bật **Chế độ dành cho nhà phát triển** (góc trên bên phải).
4. Bấm **Tải tiện ích đã giải nén** và chọn thư mục này.
5. Ghim icon "FB Group Post Cleaner" lên thanh công cụ. Bấm icon để mở bảng bên (side panel).

Cần đăng nhập Facebook trên `www.facebook.com` trong cùng cửa sổ Chrome.

## Quy trình 4 bước

### 1. Mở nhật ký
Bấm **Mở Bài viết và bình luận trong nhóm**. Công cụ lấy UID của bạn (cookie `c_user`) và mở trang nhật ký trên tab Facebook hiện tại.

Chỉ muốn xóa một khoảng thời gian? Trên trang nhật ký, dùng **Bộ lọc › Lọc theo ngày** của Facebook trước khi quét.

### 2. Quét
Bấm **Bắt đầu quét**. Công cụ tự cuộn trang cho tới khi 5 vòng liên tiếp không có mục mới (nghỉ 1,2–2,2 giây mỗi vòng).
- Chỉ lấy mục "… **đã đăng trong** …" / "… **posted in** …". Bình luận, trả lời bình luận và hoạt động khác được bỏ qua (có đếm để báo lại).
- Link bài lấy từ nút **Xem** của từng mục, được làm sạch tham số theo dõi và đưa về dạng `https://www.facebook.com/groups/{groupId}/permalink/{postId}/`.
- Bấm **Dừng quét** bất cứ lúc nào – kết quả đã quét vẫn được giữ.
- Quét lại sẽ gộp với danh sách cũ, giữ nguyên trạng thái và lựa chọn.

### 3. Kiểm tra & chọn
- Mỗi dòng: tên nhóm, 2 dòng đầu nội dung, ngày · giờ, link (bấm để mở tab mới tự kiểm tra), trạng thái.
- Tìm theo tên nhóm/nội dung (không phân biệt hoa thường, dấu câu, dấu tiếng Việt); lọc theo trạng thái.
- **Chọn tất cả (đang hiển thị)** / **Bỏ chọn**; bấm vào dòng để tick/bỏ tick.
- **Xuất CSV** (mở được bằng Excel) để lưu lại danh sách.
- Danh sách được lưu, đóng bảng bên mở lại vẫn còn.

### 4. Xóa
Công cụ mở lần lượt từng bài đã chọn trên **cùng tab Facebook**, kiểm tra đúng bài, bấm **…** › **Xóa bài viết** › **Xóa**.
- **Chạy thử** (bật sẵn): làm đủ các bước tới khi thấy mục "Xóa bài viết" rồi đóng menu, **không xóa thật**.
- **Kiểm tra đúng bài** (bật sẵn): bài phải chứa link có postId, hoặc khớp 30 ký tự chữ/số đầu của nội dung, hoặc (bài không có chữ) khớp tên nhóm. Không khớp thì bỏ qua và báo lỗi "Nội dung không khớp".
- Giãn cách ngẫu nhiên 5–8 giây giữa 2 bài (chỉnh được, tối thiểu 2 giây); tùy chọn nghỉ dài sau mỗi N bài.
- Nút **Tạm dừng / Tiếp tục / Dừng**, thanh tiến độ, đếm ngược và nhật ký chạy.
- Trước khi xóa thật, công cụ hỏi lại: "Xóa VĨNH VIỄN N bài viết? Không thể hoàn tác."
- **Giữ tab Facebook hiển thị** trong lúc chạy – Chrome làm chậm bộ hẹn giờ của tab nền.
- Đóng bảng bên giữa chừng: bài đang xử lý quay về "Chưa xóa", lần sau chạy tiếp được.

### Khuyến nghị
1. **Chạy thử với 3–5 bài trước.** Nếu tất cả báo "Chạy thử OK", bỏ tick Chạy thử và xóa thật lại đúng 3–5 bài đó, mở link kiểm tra.
2. Sau đó mới chạy số lượng lớn, giữ giãn cách mặc định hoặc lâu hơn. Nên bật **Nghỉ dài** (ví dụ 5 phút sau mỗi 20 bài) nếu xóa hàng trăm bài.
3. Không xóa thủ công song song trong lúc công cụ chạy.

## Tự dừng an toàn
Công cụ **dừng khẩn cấp** và hiện banner đỏ khi:
- URL chứa `/checkpoint`, hoặc bị chuyển về trang đăng nhập;
- hộp thoại/thông báo chứa "tạm thời bị chặn", "quá nhanh", "tạm thời bị hạn chế", "xác nhận danh tính", "đã bị khóa", "temporarily blocked", "too fast", "we limit how often", "confirm your identity".

Khi thấy banner này, **hãy ngừng dùng công cụ từ vài giờ tới 1 ngày**. Công cụ cũng tự dừng sau **3 lỗi liên tiếp**.

## Khi công cụ không nhận đúng (Chẩn đoán)
Facebook thay đổi giao diện thường xuyên. Nếu quét ra 0 bài, có bài "Không có link", hoặc bước xóa báo lỗi lạ:
1. Mở trang có vấn đề (trang nhật ký, hoặc một trang bài viết).
2. Ở bước 2, mở **Công cụ không nhận đúng?** › **Chẩn đoán trang hiện tại**.
3. Nội dung JSON được sao chép vào clipboard (URL, số nút "Xem", 3 mục mẫu và kết quả phân tích, số nút "Hành động với bài viết này", các hộp thoại và mục menu đang mở). Gửi cho người phát triển.

JSON chẩn đoán có thể chứa đoạn nội dung bài và tên nhóm của bạn – xem lại trước khi gửi.

## Trạng thái bài
| Nhãn | Ý nghĩa |
|---|---|
| Chưa xóa | Chưa xử lý |
| Đang xử lý | Đang mở/xóa |
| Đã xóa | Đã bấm "Xóa" và hộp thoại xác nhận đã đóng |
| Chạy thử OK | Chạy thử thấy mục "Xóa bài viết" |
| Lỗi + lý do | Ví dụ: Nội dung không khớp, không có mục "Xóa bài viết" (đã rời nhóm, không có quyền…) |
| Không còn tồn tại | Trang báo "Nội dung này hiện không hiển thị" |
| Không có link | Không lấy được link từ nút "Xem" – không thể xóa, hãy Chẩn đoán |

## Cấu trúc thư mục
```
manifest.json     Manifest V3 (quyền: sidePanel, storage, scripting; host: https://*.facebook.com/*)
background.js     Bấm icon → mở side panel
content.js        Chạy trên trang Facebook: quét nhật ký, xóa bài, phát hiện chặn, chẩn đoán
sidepanel.*       Giao diện 4 bước + điều phối
tests/            Trang mô phỏng + bộ kiểm thử tự động
```

## Kiểm thử (dành cho người phát triển)
Không cần Facebook thật. Cần Node.js 22+ và Chrome:
```
node tests/run-tests.mjs
```
Bộ kiểm thử mở Chrome headless, nạp `content.js` vào:
- `tests/activity-log.html` – nhật ký mô phỏng: tiêu đề ngày, bài viết lẫn bình luận, nút "Xem" có `__cft__`, một mục "Xem" không có href, tải thêm khi cuộn kèm thanh tải;
- `tests/post.html?mode=…` – trang bài viết: hộp thoại hiện sau 1,5 giây, phía sau có bài khác cũng có nút "Hành động với bài viết này". Các chế độ: `ok`, `nolinkmatch`, `mismatch` (nội dung không khớp), `gone` (không còn tồn tại), `blocked` (hiện "Bạn tạm thời bị chặn" sau khi xác nhận), `nodelete`, `nodialog`, `nodialog-mismatch`;
- `sidepanel.html` với `chrome.*` giả lập (danh sách, tìm kiếm, lọc, chọn, lưu).

Có thể mở các trang mô phỏng trực tiếp trong trình duyệt và gọi `await __FBPC.handle({type:'startScan'})` trong Console.
