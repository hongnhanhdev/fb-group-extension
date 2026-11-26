Hãy xây dựng một Chrome Extension (Manifest V3) tên "FB Group Post Cleaner" giúp tôi xóa các bài tôi ĐÃ ĐĂNG trong các nhóm Facebook, lấy danh sách từ Nhật ký hoạt động thay vì phải vào từng nhóm.

## Bối cảnh & ràng buộc kỹ thuật
- Meta đã gỡ Groups API (04/2024) nên KHÔNG dùng Graph API. Tool tự động thao tác trên giao diện web, chạy ngay trong trình duyệt đang đăng nhập Facebook.
- Không yêu cầu, không lưu, không gửi mật khẩu/cookie/token đi đâu. Mọi dữ liệu chỉ nằm trong chrome.storage.local.
- Facebook mã hoá class CSS → chỉ được dựa vào chữ hiển thị, role và aria-label. Hỗ trợ giao diện tiếng Việt (chính) và tiếng Anh. So sánh chuỗi sau khi normalize NFC, gộp khoảng trắng.
- Kiến trúc: background.js (bấm icon mở side panel), content.js (chạy trên https://*.facebook.com/*), sidepanel.html/css/js (giao diện + điều phối). Quyền: sidePanel, storage, scripting; host_permissions: https://*.facebook.com/*.
- Click mô phỏng người thật: cuộn tới phần tử, gửi chuỗi pointerover → mousedown → mouseup → click với toạ độ ngẫu nhiên trong phần tử, nghỉ ngẫu nhiên vài trăm ms giữa các thao tác. Không gọi API nội bộ (GraphQL) của Facebook.

## Cấu trúc trang thật (đã khảo sát)
- Nhật ký hoạt động › Bài viết và bình luận trong nhóm:
  https://www.facebook.com/{UID}/allactivity?activity_history=false&category_key=GROUPPOSTS&manage_mode=false&should_load_landing_page=false
  ({UID} lấy từ cookie c_user)
- Các mục được nhóm theo tiêu đề ngày, ví dụ "2 Tháng 10, 2026". Mỗi mục gồm:
  - Tiêu đề: "<Tên tài khoản> đã đăng trong <Tên nhóm>." (bài viết) | "đã bình luận về bài viết của X." | "đã trả lời bình luận của X." (bình luận)
  - Đoạn đầu nội dung, dòng quyền riêng tư ("Nhóm công khai"/"Nhóm riêng tư"), giờ ("17:55")
  - Nút "Xem" (link tới bài) và nút "…" (menu: "Ẩn khỏi trang cá nhân", "Xóa")
  - Danh sách tải thêm khi cuộn xuống (lazy-load).
- Link bài dạng: https://www.facebook.com/groups/{groupId}/permalink/{postId}/ – mở ra hộp thoại "Bài viết của <Tên tài khoản>" phủ lên trang nhóm. Nút "…" của bài (aria-label "Hành động với bài viết này" / "Actions for this post") có menu: Lưu bài viết, Chỉnh sửa bài viết, **Xóa bài viết**, Tắt thông báo… → bấm "Xóa bài viết" hiện hộp thoại xác nhận có nút "Xóa".

## Tính năng
### Bước 1 – Mở nhật ký
- Nút "Mở Bài viết và bình luận trong nhóm": lấy UID và điều hướng tab Facebook hiện tại tới URL trên.
- Gợi ý người dùng dùng "Bộ lọc › Lọc theo ngày" có sẵn của Facebook nếu chỉ muốn xóa một khoảng thời gian.

### Bước 2 – Quét
- Tự cuộn trang cho tới khi 5 vòng liên tiếp không có mục mới (không tính lúc đang có thanh tải), nghỉ 1,2–2,2 giây ngẫu nhiên mỗi vòng.
- CHỈ lấy mục có tiêu đề chứa "đã đăng trong" / "posted in". Bỏ qua bình luận, trả lời bình luận và hoạt động khác (đếm số lượng bỏ qua để báo lại).
- Link bài lấy từ href của chính nút "Xem" bên cạnh mục (bước bắt buộc để tránh sai sót). Chuẩn hoá link: bỏ tham số theo dõi (__cft__, __tn__, ref…), tách groupId và postId, đưa về dạng /groups/{groupId}/permalink/{postId}/. Hỗ trợ thêm dạng /posts/, multi_permalinks=, permalink.php?story_fbid=.
- Với mỗi bài lưu: id (groupId_postId), tên nhóm, đoạn nội dung (≤300 ký tự), ngày, giờ, link, trạng thái. Loại trùng theo id.
- Xác định khung của từng mục = phần tử tổ tiên cao nhất chỉ chứa đúng 1 nút "Xem"; ngày = tiêu đề ngày gần nhất phía trên.
- Báo tiến độ trực tiếp ("Tìm thấy N bài đăng, bỏ qua M bình luận"), có nút "Dừng quét" (giữ kết quả đã quét).
- Quét lại thì gộp với danh sách cũ, giữ nguyên trạng thái và lựa chọn của bài đã có.
- Bài không lấy được link: đánh dấu "Không có link", không cho chọn, hiện cảnh báo gợi ý bấm "Chẩn đoán".

### Bước 3 – Kiểm tra & chọn
- Danh sách có checkbox. Mỗi dòng hiện: tên nhóm, 2 dòng đầu nội dung, ngày · giờ, link bấm được (mở tab mới để tự kiểm tra), nhãn trạng thái (Chưa xóa / Đang xử lý / Đã xóa / Chạy thử OK / Lỗi + lý do / Không còn tồn tại / Không có link).
- Ô tìm kiếm lọc theo tên nhóm hoặc nội dung (không phân biệt dấu câu/hoa thường). Bộ lọc trạng thái: Tất cả / Chưa xóa / Đã xóa / Lỗi.
- "Chọn tất cả (đang hiển thị)", "Bỏ chọn". Bấm vào dòng cũng tick/bỏ tick (trừ khi bấm vào link).
- Bộ đếm: số bài hiển thị / tổng, đã chọn, đã xóa.
- "Xuất CSV" (UTF-8 có BOM để mở bằng Excel): Trạng thái, Nhóm, Ngày, Giờ, Nội dung, Link, Ghi chú.
- "Xóa danh sách" (có hỏi xác nhận). Danh sách và cài đặt được lưu lại, đóng side panel mở lại vẫn còn.

### Bước 4 – Xóa
- Chạy tuần tự từng bài đã chọn trên CÙNG tab Facebook:
  1. Điều hướng tab tới link bài, chờ tải xong + 1,2–2 giây.
  2. Chờ tối đa 10 giây cho hộp thoại bài viết có nút "Hành động với bài viết này".
  3. Kiểm tra đúng bài trước khi xóa (bật mặc định): trong khung bài có link chứa postId, HOẶC 30 ký tự chữ/số đầu của nội dung khớp với đoạn lấy từ nhật ký, HOẶC (bài không có chữ) khớp tên nhóm. Không khớp → bỏ qua, báo lỗi "Nội dung không khớp".
     Nếu bài không nằm trong hộp thoại thì luôn bắt buộc kiểm tra, dù người dùng tắt tùy chọn này.
  4. Bấm "…" → tìm mục "Xóa bài viết". Không có (đã rời nhóm, không có quyền…) → đóng menu, báo lỗi kèm danh sách mục menu đang thấy.
  5. Bấm "Xóa bài viết" → chờ hộp thoại xác nhận ("Xóa bài viết?") → bấm "Xóa" → chờ hộp thoại đóng thì mới coi là đã xóa.
  6. Trang báo "Nội dung này hiện không hiển thị" → đánh dấu "Không còn tồn tại", bỏ qua.
- Giãn cách ngẫu nhiên 5–8 giây giữa 2 bài (chỉnh được, tối thiểu 2 giây). Tùy chọn nghỉ dài sau mỗi N bài (mặc định tắt).
- Chế độ "Chạy thử" (bật mặc định cho lần đầu): làm đủ các bước tới khi thấy nút "Xóa bài viết" rồi đóng menu, KHÔNG xóa thật.
- Hỏi xác nhận trước khi xóa thật: "Xóa VĨNH VIỄN N bài viết? Không thể hoàn tác."
- Nút Tạm dừng / Tiếp tục / Dừng; thanh tiến độ; đếm ngược tới bài tiếp theo; nhật ký chạy có giờ, màu xanh/đỏ cho thành công/lỗi.
- Đóng side panel giữa chừng → bài đang "Đang xử lý" quay về "Chưa xóa", lần sau chạy tiếp được.

### Chống spam / checkpoint
- Dừng khẩn cấp ngay khi: URL chứa /checkpoint, bị chuyển về trang đăng nhập, hoặc hộp thoại/thông báo ngắn chứa "tạm thời bị chặn", "quá nhanh", "tạm thời bị hạn chế", "xác nhận danh tính", "đã bị khóa", "temporarily blocked", "too fast", "we limit how often", "confirm your identity". Không quét chữ trong hộp thoại đang chứa chính bài viết để tránh báo nhầm. Hiện banner đỏ khuyên ngừng dùng vài giờ tới 1 ngày.
- Tự dừng sau 3 lỗi liên tiếp.
- Nhắc người dùng để tab Facebook hiển thị trong lúc chạy (tab nền bị Chrome làm chậm bộ hẹn giờ).

### Chẩn đoán
- Nút "Chẩn đoán trang hiện tại": xuất JSON gồm URL, số nút "Xem" tìm thấy, 3 mục mẫu (tag/role/href của nút Xem, chữ trong khung, các aria-label, kết quả phân tích), số nút "Hành động với bài viết này", các hộp thoại đang mở và mục menu đang hiện. Sao chép vào clipboard để gửi cho người phát triển khi Facebook đổi giao diện.

## Giao diện side panel
- Gọn trong khoảng 360–500px, chia 4 thẻ đánh số 1–4 theo đúng quy trình. Tông xanh Facebook, nút xóa màu đỏ, hỗ trợ chế độ tối (prefers-color-scheme). Danh sách cuộn riêng (tối đa ~46% chiều cao) để nút Xóa luôn dễ thấy.
- Toàn bộ chữ trên giao diện bằng tiếng Việt.

## Kiểm thử
- Tạo trang HTML mô phỏng (không cần Facebook thật):
  1. Nhật ký: tiêu đề ngày, mục bài viết lẫn bình luận, nút "Xem" là thẻ <a> có href kèm __cft__, một mục mà "Xem" không có href, tải thêm khi cuộn kèm thanh tải.
  2. Trang bài viết: hộp thoại hiện sau 1,5 giây, phía sau có bài khác cũng có nút "Hành động với bài viết này" (để chắc chắn tool không bấm nhầm), menu có "Xóa bài viết", hộp thoại xác nhận "Xóa". Thêm các chế độ: nội dung không khớp, bài không còn tồn tại, hiện cảnh báo "Bạn tạm thời bị chặn" sau khi xác nhận.
- Tiêu chí đạt: quét ra đúng số bài đăng, bỏ qua bình luận, link đã chuẩn hoá; xóa đúng bài trong hộp thoại; dừng an toàn ở các trường hợp lỗi/chặn; chạy thử không xóa gì.

## Kết quả cần giao
- Thư mục extension (manifest.json, background.js, content.js, sidepanel.html, sidepanel.css, sidepanel.js) cài được bằng chrome://extensions › Chế độ dành cho nhà phát triển › Tải tiện ích đã giải nén.
- README tiếng Việt: cách cài, quy trình 4 bước, khuyến nghị chạy thử với 3–5 bài trước, cách xử lý khi tool không nhận đúng (Chẩn đoán), và lưu ý rủi ro: tự động hóa trái điều khoản Facebook, không cài đặt nào đảm bảo 100% không bị checkpoint.