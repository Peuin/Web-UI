# Plan: Tối ưu tốc độ load & trải nghiệm Web-UI

> Phạm vi: `Web-UI` (Next.js 16 + React 19 + Supabase Edge Functions).
> Nguồn: đọc code ngày 14/11/2026, gồm `src/app/page.tsx`, `src/lib/api/edge-functions.ts`, `supabase/functions/drive-list-folder`, `supabase/functions/final-files` và `supabase/sql/*`.
> Lưu ý: phần UX được review **qua code**, chưa xem trên app thật vì app cần đăng nhập. Task U0 bổ sung một lượt review trực quan.

---

## 0. Tóm tắt chẩn đoán

### Vì sao mở folder chậm?

Thời gian mở một folder = mạng tới Edge Function + xác thực + truy vấn DB + ký URL thumbnail + tải ảnh + render. Mỗi khâu hiện đều có chỗ lãng phí:

| # | Nguyên nhân | Bằng chứng trong code | Ảnh hưởng |
|---|---|---|---|
| 1 | **URL thumbnail bị ký lại ở mỗi request**, nên trình duyệt không cache được ảnh. Mỗi lần mở lại folder là tải lại toàn bộ ảnh. | `signThumbnails()` trong `drive-list-folder/index.ts:157`, `signThumbnailField()` trong `final-files/index.ts` | **Rất cao**: phần lớn thời gian "chờ ảnh hiện" |
| 2 | **Không có cache phía client**. Vào folder con rồi bấm Back hay breadcrumb đều gọi lại API từ đầu và hiện skeleton toàn trang. | `loadDrive()` `page.tsx:456`, `FinalBrowser.openFolderId` | Cao: cảm giác "lần nào cũng chậm" |
| 3 | **Trả về toàn bộ cột, kể cả `raw_payload` (JSONB)**. `exposeDriveItem()` trả nguyên row, nên payload phình to. | `select("*")` + `exposeDriveItem = (item) => item` (`drive-list-folder/index.ts:148,315`) | Trung bình–cao, nhất là folder nhiều file |
| 4 | **Mỗi request gọi `auth.getUser()`**, tức thêm một vòng mạng tới Auth server. | `final-files/index.ts`, `drive-list-folder` | ~100–300 ms mỗi request |
| 5 | **Truy vấn tuần tự + `count: "exact"`**: query danh sách xong mới query folder cha; đếm chính xác mỗi trang. | `listDriveMetadataFolder()` | ~50–150 ms |
| 6 | **Thiếu index cho `final_items`**: chỉ có PK + unique `drive_item_id`, không có index trên `parent_drive_item_id` hay `source_folder_id`. | `supabase/sql/008_final_items.sql` | Tăng dần theo số dòng |
| 7 | **Folder rỗng phải chờ n8n**: sync lazy rồi poll tới 3 lần (0s / 2s / 4s), trong lúc đó chỉ hiện skeleton. | `fetchDriveFolder()` `page.tsx:342` | 2–6 s ở lần mở đầu tiên |
| 8 | **Component khổng lồ**: `page.tsx` dài 3.862 dòng, có 75 `useState` trong một cây. Gõ vào form bên phải cũng re-render cả lưới ảnh. `MediaCard` không được memo và nhận callback mới ở mỗi render. | `Home()` `page.tsx:219` | Giật khi gõ hoặc chọn (INP), JS bundle lớn |
| 9 | **Vị trí folder không nằm trên URL**: reload là về Root, nút Back của trình duyệt thoát khỏi app, không gửi link folder được. | state `currentFolderKey` chỉ nằm trong React | UX + phải load lại từ đầu |

### Mục tiêu đo được (định nghĩa "xong")

| Chỉ số | Hiện tại (cần đo ở P0) | Mục tiêu |
|---|---|---|
| Mở lại folder đã xem (Back hoặc breadcrumb) | ~0,5–1,5 s, có skeleton | **< 100 ms**, không skeleton |
| Mở folder mới (p50) | đo | **< 600 ms** tới khi thấy danh sách |
| Ảnh thumbnail khi mở lại folder | tải lại 100% | **≥ 90% lấy từ disk/memory cache** |
| Kích thước response 1 folder 200 mục | đo | giảm **≥ 50%** |
| INP khi gõ vào form hoặc chọn card | đo | **< 200 ms** |
| Lighthouse Accessibility | đo | **≥ 95** |

---

## PHẦN 1 — Tối ưu tốc độ (Performance)

Thứ tự đề xuất: P0 → P1 → P2 → P3 → P4 → P5 → còn lại. Mỗi task nên là một PR riêng để dễ đo trước/sau.

### P0. Đo baseline (bắt buộc làm trước)
- [ ] Thêm header `Server-Timing` vào `drive-list-folder` và `final-files`, gồm các mốc `auth`, `db`, `sign`, `total`. Xem trực tiếp trong tab Network của DevTools.
- [ ] Ghi lại số liệu cho 3 folder (nhỏ ~10 mục, vừa ~100 mục, lớn ~500 mục) ở cả hai tab Drive Browser và Final Output: TTFB, kích thước response, thời gian tới khi ảnh hiện đủ.
- [ ] Ghi INP bằng Performance panel khi gõ vào ô mô tả sản phẩm và khi click chọn card.
- **Done khi:** có bảng số liệu baseline lưu trong `docs/perf-baseline.md`.

### P1. Cho phép trình duyệt cache ảnh thumbnail ⭐ hiệu quả lớn nhất
Vấn đề: mỗi lần list là ký URL mới, token trên query string khác nhau, nên với trình duyệt đây là một ảnh mới.
- [ ] **Cách khuyến nghị:** cache signed URL phía server theo `path`, với TTL bằng TTL của URL trừ 5 phút. Dùng Redis đã có sẵn (`redisConfig()`), hoặc một Map trong bộ nhớ của function. Trong cùng cửa sổ thời gian, mọi request trả về **đúng một URL**, nên trình duyệt cache được.
- [ ] Khi upload thumbnail vào bucket `drive-thumbnails`, set `cacheControl: "31536000"`. Path đã gắn với `drive_item_id`, còn file thay đổi thì `modified_time` thay đổi. Cân nhắc thêm `modified_time` vào path để tránh dùng nhầm ảnh cũ.
- [ ] Cách thay thế, đơn giản hơn nếu thumbnail không nhạy cảm: chuyển bucket `drive-thumbnails` sang **public** và trả về URL public cố định. Cách này bỏ hẳn bước ký → **cần chủ sản phẩm quyết định về bảo mật**.
- [ ] Với thumbnail đã resize sẵn (`s400`), dùng `unoptimized` trên `next/image` cho cả URL Supabase. Optimizer của Next không cache được URL có token thay đổi, nên chỉ thêm độ trễ.
- **Done khi:** mở lại một folder thì tab Network hiển thị ảnh `(disk cache)` / `(memory cache)`.
- File: `supabase/functions/drive-list-folder/index.ts`, `supabase/functions/final-files/index.ts`, `supabase/functions/drive-sync/index.ts`, `src/app/page.tsx` (MediaCard).

### P2. Cache dữ liệu folder phía client (stale-while-revalidate)
- [ ] Tạo hook `useFolderListing(source, folderId)` có cache theo `source + folderId`. Khi mở folder đã có cache thì **hiện ngay**, đồng thời revalidate ở nền và chỉ cập nhật nếu có thay đổi.
  - Khuyến nghị dùng **TanStack Query v5**: có sẵn dedupe, cache, prefetch, retry, `staleTime`. Nếu không muốn thêm thư viện thì viết hook nhỏ dùng `Map` + `useSyncExternalStore`.
- [ ] **Prefetch**: khi hover hoặc focus vào card folder (desktop), hoặc khi mở rộng node trên cây thư mục, gọi trước API list của folder đó.
- [ ] Chỉ hiện skeleton toàn trang ở **lần load đầu**. Khi chuyển folder, giữ nội dung cũ và hiện thanh progress mảnh ở đầu lưới (dùng `useTransition` hoặc cờ `isFetching`).
- [ ] Gộp logic giữa Drive Browser và `FinalBrowser`. Hai bên hiện có hai bản copy của "lazy sync + poll".
- **Done khi:** Back hoặc breadcrumb về folder đã xem thì hiện danh sách < 100 ms, không có skeleton.

### P3. Thu gọn payload & truy vấn ở Edge Function
- [ ] `select` **liệt kê cột cụ thể**, bỏ `raw_payload`: `id, drive_item_id, parent_drive_item_id, name, mime_type, item_type, size_bytes, thumbnail_url, web_view_link, modified_time, sync_status, storage_path`. Áp dụng cho `drive-list-folder` (cả query lẫn giá trị ghi vào Redis) và `final-files` (`listFinalFolder`, `listFinalFiles`).
- [ ] Chạy song song query danh sách và query thông tin folder bằng `Promise.all`.
- [ ] Bỏ `count: "exact"`, thay bằng lấy `pageSize + 1` dòng để suy ra `has_more`. Nếu UI cần tổng số thì dùng `count: "planned"`.
- [ ] Thay `supabase.auth.getUser()` bằng `supabase.auth.getClaims()`. Cách này verify JWT tại chỗ bằng JWKS, không tốn vòng mạng (supabase-js 2.112 đã hỗ trợ).
- [ ] Bật nén gzip/br cho response nếu Supabase gateway chưa tự làm (kiểm tra header `content-encoding`).
- **Done khi:** response giảm ≥ 50% và `Server-Timing` của `auth` gần bằng 0.

### P4. Index database
- [ ] Migration mới `012_perf_indexes.sql`:
  ```sql
  create index if not exists final_items_parent_type_modified_idx
    on public.final_items (parent_drive_item_id, item_type, modified_time desc);
  create index if not exists final_items_source_modified_idx
    on public.final_items (source_folder_id, modified_time desc);
  create index if not exists drive_items_list_idx
    on public.drive_items (connection_id, parent_drive_item_id, item_type, modified_time desc)
    where deleted_at is null;
  ```
- [ ] Chạy `EXPLAIN ANALYZE` cho query list trước và sau, xác nhận dùng Index Scan.
- [ ] Nếu ô tìm kiếm chuyển sang search phía server: thêm `pg_trgm` + GIN index trên `name`.

### P5. Folder rỗng / chưa sync: bỏ polling, dùng Realtime
- [ ] Thay vòng poll 0/2/4 s bằng **Supabase Realtime** (`postgres_changes` trên `drive_items` / `final_items` lọc theo `parent_drive_item_id`). Có dữ liệu là hiện ngay. Giữ poll làm fallback khi Realtime lỗi.
- [ ] Trong lúc chờ, hiện trạng thái rõ ràng: "Đang lấy dữ liệu từ Google Drive…" kèm spinner, không dùng skeleton chung chung (xem thêm U6).
- [ ] Final Output hiện tự sync mỗi 30 s, tốn 1–2 lượt chạy n8n mỗi tab đang mở. Khi đã có Realtime thì nâng lên 60–120 s. Lâu dài cân nhắc Google Drive push notifications (`changes.watch`) để n8n chủ động đẩy dữ liệu về.

### P6. Tách `page.tsx` & giảm re-render
- [ ] Tách theo feature, mỗi tab một module:
  `features/drive-browser/`, `features/final-output/`, `features/jobs/`, `features/model-library/`, `features/settings/`, cùng `components/media/` (MediaCard, MediaRow, DriveContent, DriveToolbar).
- [ ] Các tab không mặc định (Jobs, Model, Final, Settings) load bằng `next/dynamic` để giảm JS ban đầu.
- [ ] Gom state của form tạo media (khoảng 12 `useState`) vào component `GenerationForm` riêng (hoặc `useReducer`), để gõ phím không re-render lưới.
- [ ] Bọc `MediaCard` / `MediaRow` bằng `React.memo`. Truyền `item.id` cùng các handler ổn định (`useCallback`) thay vì tạo closure mới cho từng card.
- [ ] Ô tìm kiếm: dùng `useDeferredValue(query)` khi lọc.
- [ ] Bật `babel-plugin-react-compiler` (React 19) thay cho việc memo thủ công, nếu team đồng ý.
- **Done khi:** INP < 200 ms, và React Profiler cho thấy gõ vào form không render lại MediaCard.

### P7. Danh sách lớn
- [ ] Nếu folder có > 300 mục: virtualize lưới hoặc danh sách bằng `@tanstack/react-virtual`, hoặc phân trang "Tải thêm" (API đã hỗ trợ `page`).
- [ ] Hiện tại `listDriveFolder` gọi tuần tự **toàn bộ** các trang (500/trang) rồi mới render. Nên render ngay trang đầu, các trang sau load dần.

### P8. Đưa vị trí lên URL (vừa tăng tốc vừa cải thiện UX)
- [ ] Đồng bộ `?tab=final&folder=<id>` với `history.pushState`. Nút Back/Forward của trình duyệt điều hướng giữa các folder. Reload thì mở lại đúng folder (kết hợp với cache ở P2).
- [ ] Breadcrumb khi reload: API trả thêm `ancestors` (một recursive CTE trên `parent_drive_item_id`) để dựng lại đường dẫn.

---

## PHẦN 2 — Review UI/UX cho end-user

Đánh giá theo 10 heuristic của Nielsen và WCAG 2.2 AA. Mức độ: 🔴 nghiêm trọng · 🟠 nên sửa sớm · 🟡 cải thiện.

### U0. Review trực quan trên app thật (bổ sung cho bản review từ code)
- [ ] Đăng nhập, chụp màn hình từng tab ở 3 kích thước: 1440 px, 768 px, 375 px. Ghi lại lỗi layout, chữ bị cắt, nút chồng nhau.
- [ ] Đi hết 3 luồng chính và đếm số click hoặc điểm bối rối: (1) chọn folder sản phẩm → tạo media; (2) theo dõi job → retry; (3) xem và tải thành phẩm ở Final Output.

### U1. 🔴 Độ tương phản màu primary không đạt WCAG AA
- Chữ trắng trên `--primary: 11 88% 65%` (cam nhạt) có tỷ lệ tương phản **2,8 : 1** (đã tính), trong khi chữ thường cần **≥ 4,5 : 1**.
- [ ] Nút có chữ dùng `--brand-dark` (`15 68% 47%`, đạt 4,52 : 1 với chữ trắng, vừa đủ), hoặc đổi chữ trên nền primary sang màu ink. Kiểm tra lại các cặp màu còn lại. `--muted-foreground` trên `--muted` đạt 5,24 : 1, ổn.
- File: `src/app/globals.css`, `src/components/ui/button.tsx`.

### U2. 🔴 Cách mở folder khó đoán
- Desktop hiện là: click 1 lần = xem trước, **double-click** mới mở folder. Trên touch thì click 1 lần là mở. Người dùng mới thường click 1 lần rồi tưởng app không phản hồi.
- [ ] Khuyến nghị: **folder click 1 lần là mở**. File click 1 lần là xem trước, double-click là mở trên Drive. Việc chọn (để chạy workflow) dùng checkbox riêng.
- [ ] Nếu muốn giữ hành vi kiểu Google Drive, ít nhất hiện gợi ý khi hover ("Nhấp đúp để mở") và một nút "Mở" trong panel xem trước.
- ⚠️ Cần chủ sản phẩm chốt một trong hai hướng.

### U3. 🔴 Không biết đang ở đâu sau khi reload; nút Back của trình duyệt thoát app
- Xem P8. Đây vừa là lỗi UX (vi phạm heuristic "User control & freedom") vừa là lỗi hiệu năng.

### U4. 🟠 Thao tác chỉ hiện khi hover → không dùng được trên cảm ứng, khó tìm
- Checkbox chọn, nút copy link và nút mở Drive trên `MediaCard` đều đang `opacity-0` và chỉ hiện khi hover.
- [ ] Trên thiết bị `(hover: none)` thì luôn hiện. Trên desktop luôn hiện checkbox, nhưng mờ (khoảng 40%).

### U5. 🟠 Trạng thái lỗi không có lối thoát
- `DriveContent` khi lỗi chỉ hiện một hộp đỏ, không có nút gì.
- [ ] Thêm nút **"Thử lại"** và **"Về thư mục cha"**. Viết thông báo lỗi theo ngôn ngữ người dùng (ví dụ "Không tải được thư mục. Kiểm tra mạng rồi thử lại."), giấu chi tiết kỹ thuật vào mục "Chi tiết".

### U6. 🟠 Trạng thái "đang sync từ Drive" không rõ
- Folder rỗng ở lần mở đầu tự sync 2–6 s nhưng UI chỉ hiện skeleton như khi load thường. Sau đó có thể hiện "This folder is empty" dù n8n vẫn đang chạy.
- [ ] Phân biệt 3 trạng thái: *Đang tải* / *Đang lấy từ Google Drive…* / *Thư mục trống (đã kiểm tra lúc HH:mm)*.
- [ ] Hiện "Cập nhật lần cuối: x phút trước" cạnh nút Sync.

### U7. 🟠 Thông báo (toast) không thống nhất, copy có thể lỗi mà không báo
- Hiện có 3–4 cơ chế thông báo khác nhau (`jobsNotice`, `submitNotice`, `notice` của Model, notice của Final), mỗi cái một style và vị trí.
- `navigator.clipboard.writeText` không có `try/catch`. Khi bị chặn (http, iframe, quyền) thì thất bại mà không báo gì.
- [ ] Tạo một hệ thống toast chung: `aria-live="polite"`, tự ẩn sau 4 s, có nút đóng. Bọc mọi thao tác copy kèm fallback chọn sẵn text để người dùng tự copy.

### U8. 🟠 Retry dùng `window.confirm`
- Retry có thể **tốn AI credits** nhưng xác nhận bằng hộp thoại native của trình duyệt: khó đọc, không thể hiện được chi phí.
- [ ] Thay bằng dialog tự thiết kế: liệt kê các SKU sẽ retry, ước tính số ảnh/video sẽ tạo lại, nút chính "Retry n SKU" và nút phụ "Huỷ". Focus ban đầu đặt vào "Huỷ".

### U9. 🟠 Accessibility bàn phím & screen reader
- [ ] Nút icon-only thiếu `aria-label`: checkbox chọn và nút "…" trong `MediaRow` (hiện chỉ có `title`).
- [ ] Checkbox chọn nên là `role="checkbox"` + `aria-checked`, hoặc dùng `<input type="checkbox">` thật.
- [ ] Lưới item hỗ trợ phím mũi tên (roving tabindex), Space để chọn, Enter để mở.
- [ ] Mọi phần tử tương tác phải có focus ring thấy rõ (`focus-visible:ring-2`).
- [ ] Các panel trượt (SidePanel, nav mobile) phải giữ focus bên trong (focus trap), đóng được bằng Esc và trả focus về chỗ cũ khi đóng.
- [ ] `<html lang="en">` phải khớp ngôn ngữ thực tế (xem U12).

### U10. 🟡 Tên folder dài / có UUID khó đọc
- Ví dụ: `11-10 scarf_2026-11-14_eaeac8c4-468f-4aff-8071-8a1d57cabe58`.
- [ ] Hiển thị tên thân thiện: tách phần `_YYYY-MM-DD_<uuid>` thành badge ngày và ẩn UUID (giữ tên đầy đủ trong tooltip và panel chi tiết).
- [ ] Breadcrumb: rút gọn các cấp giữa thành "…" khi quá dài, và cho hiện đủ khi hover.

### U11. 🟡 Tìm kiếm & sắp xếp
- Ô tìm kiếm chỉ lọc trong folder hiện tại, nhưng không nói rõ điều đó.
- [ ] Đổi placeholder thành "Tìm trong thư mục này…"; khi không có kết quả thì gợi ý tìm toàn bộ (nếu sau này có search phía server).
- [ ] Thêm dropdown sắp xếp (Mới nhất / Cũ nhất / Tên A–Z). API `drive-list-folder` đã hỗ trợ tham số `sort`.
- [ ] Phím tắt `/` để focus vào ô tìm kiếm.

### U12. 🟡 Ngôn ngữ giao diện
- UI đang bằng tiếng Anh, còn user guide song ngữ. Nếu người dùng chính là người Việt thì nên có bản tiếng Việt, hoặc nút chuyển EN/VI.
- ⚠️ Cần chủ sản phẩm quyết định. Nếu làm thì gom chuỗi vào file `messages/{en,vi}.json`.

### U13. 🟡 Form tạo media (panel bên phải)
- [ ] Validate ngay trên từng field (URL ảnh tham chiếu, đường dẫn storage), không đợi tới khi Submit mới báo.
- [ ] Ghi nhớ lựa chọn gần nhất (loại sản phẩm, tỷ lệ khung hình, số ảnh) vào `localStorage`.
- [ ] Hiện tóm tắt trước khi gửi: "Sẽ tạo 4 ảnh + 1 video 8 s, 9:16, 480p cho folder X".
- [ ] Khoá nút Submit và hiện tiến trình trong lúc gửi để tránh gửi trùng. Hiện đã có thông báo nhắc, nhưng nên khoá thật.

### U14. 🟡 Responsive & mobile
- [ ] Kiểm tra ở 375 px: lưới card, panel xem trước dạng overlay, toolbar xuống dòng, vùng chạm ≥ 44 × 44 px (nút icon hiện chỉ 32 px, `h-8 w-8`).
- [ ] Panel xem trước trên mobile hiện dạng bottom sheet thay vì cột bên phải.

---

## 3. Lộ trình đề xuất

| Sprint | Task | Lý do |
|---|---|---|
| **1 (quick wins, ~2–3 ngày)** | P0, P1, P3, P4, U1, U5 | Tăng tốc rõ rệt nhất, ít rủi ro, không đổi kiến trúc |
| **2 (~1 tuần)** | P2, P8/U3, P5, U6, U7 | Cache client + URL, cảm giác "tức thì" |
| **3 (~1 tuần)** | P6, P7, U2, U4, U9 | Refactor và accessibility, cần test hồi quy kỹ |
| **4** | U8, U10–U14 | Hoàn thiện trải nghiệm |

## 4. Quyết định cần chủ sản phẩm chốt
1. **Bucket thumbnail public hay private** (P1). Public thì nhanh và đơn giản nhất, nhưng ai có link đều xem được ảnh.
2. **Click 1 lần hay double-click để mở folder** (U2).
3. **Có thêm thư viện TanStack Query không** (P2), hay tự viết cache.
4. **Giao diện tiếng Việt / song ngữ** (U12).

## 5. Cách kiểm tra mỗi PR
- So số liệu với baseline ở P0 (Server-Timing, kích thước response, cache hit của ảnh).
- Chạy `npm run lint` và `npm run typecheck`.
- Lighthouse (Performance và Accessibility) ở chế độ desktop và mobile.
- Test tay 3 luồng chính ở U0, trên cả Chrome desktop và một máy mobile thật.
