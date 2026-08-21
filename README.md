# Redirect Monitor — Theo dõi 301 qua IP Việt Nam

Giám sát HTTP status và redirect (301/302/307/308, meta refresh, JS redirect) của danh sách domain, **quét qua IP Việt Nam** để vượt geo-block, và báo Telegram ngay khi có thay đổi — kèm **thời điểm chính xác theo giờ Việt Nam**.

---

## Kiến trúc

```
┌──────────────────────────────┐         ┌────────────────────────────┐
│  MAIN APP (VPS nước ngoài)   │         │  VN RELAY (IP Việt Nam)    │
│  FastAPI + SQLite            │  HTTPS  │  Node.js + Fastify         │
│  Scheduler + Dashboard       │────────▶│  POST /fetch  {url, mode}  │
│  Telegram alerts             │◀────────│  → {status, chain, ip, ms} │
└──────────────────────────────┘  JSON   └────────────────────────────┘
```

Main app **không bao giờ** tự gọi ra site đích. Mọi request đều đi qua relay đặt tại Việt Nam, nên site chặn geo vẫn trả kết quả đúng như người dùng VN thấy.

**Tại sao là "fetch relay API" chứ không phải HTTP proxy thuần:** relay trả JSON có cấu trúc (toàn bộ redirect chain, IP resolve được, latency, phân loại lý do bị chặn), auth bằng API key, và không thể bị người lạ quét ra xài chùa như open proxy.

---

## Điểm cốt lõi: thời điểm 301 được báo cáo thế nào

Polling **không bao giờ** cho biết thời điểm tuyệt đối. Hệ thống này báo cáo trung thực một **khoảng**:

```
[lần cuối còn thấy trạng thái CŨ]  ────  [lần đầu thấy trạng thái MỚI]
        16:41:48                              16:41:54
                     ±6 giây
```

Thời điểm 301 thật sự nằm trong khoảng đó. Độ rộng khoảng ≈ nhịp quét. Với nhịp 15s bạn có sai số ±15s; muốn hẹp hơn thì giảm nhịp (đánh đổi: dễ bị site rate-limit IP relay).

Hệ thống ghi thêm `confirmed_at` (lúc đủ số lần xác nhận) nhưng **không** dùng nó làm thời điểm thay đổi — nhờ vậy việc chống báo động giả không làm mất độ chính xác.

### Chống báo động giả

- Phải thấy trạng thái mới **2 lần liên tiếp** (`CONFIRM_THRESHOLD`) mới ghi nhận là thay đổi thật.
- Lỗi mạng/timeout **không** được coi là thay đổi trạng thái — chỉ đếm vào `consecutive_errors`.
- Query param rác (`utm_*`, `gclid`, `fbclid`…) bị loại khi so sánh URL đích.
- **Nếu relay VN chết** và hệ thống phải fallback ra IP nước ngoài, kết quả đó **bị đánh dấu không tin cậy và không dùng để kết luận trạng thái**. Nếu không có cơ chế này, mỗi lần relay chết thì mọi site geo-block sẽ "bỗng dưng 403" và bắn hàng loạt cảnh báo giả.

---

## Thiết kế lưu trữ — vì sao không phình

200 domain × nhịp 15s = **1,16 triệu lượt quét/ngày**. Không thể lưu thô.

| Bảng | Ghi khi nào | Số dòng |
|---|---|---|
| `domain_state` | update tại chỗ mỗi lần quét | **cố định = số domain** |
| `state_changes` | chỉ khi trạng thái đổi thật | vài chục/tháng |
| `hourly_stats` | rollup theo giờ | 24/domain/ngày |
| `check_errors` | chỉ lỗi, có retention | nhỏ |

**Đã kiểm chứng:** sau 5.195 lượt quét, `domain_state` vẫn đúng 201 dòng, toàn bộ DB ~2MB. Ngoại suy: khoảng **vài trăm MB/năm** cho 200 domain, không phải hàng trăm triệu dòng.

---

## Cài đặt

### Bước 1 — Dựng VN Relay (bắt buộc, đặt tại Việt Nam)

Sinh API key trước, dùng chung cho cả hai bên:

```bash
openssl rand -hex 32
```

#### Cách A — VPS Việt Nam (khuyến nghị)

```bash
cd vn-relay
cp .env.example .env
nano .env          # dán RELAY_API_KEY vừa sinh
docker compose up -d --build
curl -H "x-api-key: <KEY>" http://127.0.0.1:8787/egress-ip   # phải thấy "country":"VN"
```

Mặc định relay chỉ nghe trên `127.0.0.1`. Để main app ở ngoài gọi được, mở qua Caddy/Nginx có HTTPS, hoặc dùng Cloudflare Tunnel như Cách B.

Chạy không cần Docker:

```bash
sudo useradd -r -s /bin/false relay
sudo cp -r . /opt/vn-relay && cd /opt/vn-relay
sudo -u relay npm install --omit=dev
sudo cp deploy/vn-relay.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now vn-relay
```

#### Cách B — Máy cá nhân ở VN + Cloudflare Tunnel (không cần public IP)

```bash
cd vn-relay && cp .env.example .env && nano .env
docker compose up -d --build

cloudflared tunnel login
cloudflared tunnel create vn-relay
# sửa deploy/cloudflared-config.yml → chép về ~/.cloudflared/config.yml
cloudflared tunnel route dns vn-relay relay.tenmiencuaban.com
sudo cloudflared service install
```

Relay giờ truy cập được tại `https://relay.tenmiencuaban.com`.

> **Bản nhẹ:** đổi `dockerfile: Dockerfile` → `Dockerfile.slim` trong `docker-compose.yml` để bỏ Chromium (~120MB thay vì ~1.5GB). Đánh đổi: không vượt được bot-protection và không bắt được JS redirect.

### Bước 2 — Dựng Main App (VPS nước ngoài)

```bash
cd main-app
cp .env.example .env
nano .env
```

Bắt buộc điền:

```ini
RELAY_URL=https://relay.tenmiencuaban.com
RELAY_API_KEY=<đúng key đã dùng ở relay>
DASHBOARD_PASSWORD=<mật khẩu mạnh>
TELEGRAM_BOT_TOKEN=<từ @BotFather>
TELEGRAM_CHAT_ID=<xem bên dưới>
```

Sửa domain trong `Caddyfile`, trỏ bản ghi A về IP VPS này, rồi:

```bash
docker compose up -d --build
```

Mở `https://monitor.tenmiencuaban.com`.

### Bước 3 — Telegram

1. Chat với **@BotFather** → `/newbot` → lấy token.
2. Nhắn một tin bất kỳ cho bot vừa tạo.
3. Mở `https://api.telegram.org/bot<TOKEN>/getUpdates` → lấy `chat.id`.
4. Điền vào `.env`, restart, bấm **Test Telegram** trên dashboard.

---

## Cấu hình đáng chú ý

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `DEFAULT_INTERVAL_SEC` | `15` | Nhịp quét. Chỉnh riêng từng domain trong UI. |
| `CONFIRM_THRESHOLD` | `2` | Số lần xác nhận trước khi báo. `1` = báo ngay nhưng dễ nhiễu. |
| `MAX_CONCURRENCY` | `24` | Request song song. |
| `JITTER_PCT` | `15` | Xê dịch ngẫu nhiên để không đập cùng lúc. |
| `ALLOW_DIRECT_FALLBACK` | `true` | Relay chết thì vẫn quét từ server chính (kết quả bị đánh dấu không tin cậy). Đặt `false` để tắt hẳn. |

### Chọn nhịp quét

Một vòng 200 domain mất ~10–15s. Nhịp 15s là **sát giới hạn** — hệ thống trải đều tải nên vẫn chạy tốt (đã đo: 13,8 req/s, đúng lý thuyết), nhưng rủi ro bị site chặn IP relay là có thật. Bạn chỉ có **một** IP VN — mất là mù toàn bộ.

Chiến lược an toàn hơn: để mặc định 60s, rồi chỉnh riêng **20–30s cho vài domain thật sự quan trọng**. Sai số ±20s so với ±15s gần như không khác gì, nhưng rủi ro thấp hơn nhiều.

---

## Chế độ quét

| Mode | Cách hoạt động | Dùng khi |
|---|---|---|
| `http` | Chỉ HTTP request, ~10–50ms | Nhanh nhất, mặc định cho đa số |
| `auto` | HTTP trước, tự nâng lên Chromium khi gặp bot-block hoặc nghi JS redirect | **Khuyến nghị** |
| `browser` | Luôn dùng Chromium | Site chắc chắn cần JS |

Relay tự phân biệt **geo-block** (chặn theo quốc gia) với **bot-protection** (Cloudflare/Incapsula/DataDome/PerimeterX) và ghi rõ bằng chứng, thay vì gộp chung thành "403".

---

## API

| Endpoint | Mô tả |
|---|---|
| `GET /api/domains` | Danh sách + trạng thái hiện tại |
| `POST /api/domains` | Thêm (`{url, label, interval_sec, mode}`) |
| `POST /api/domains/bulk` | Thêm hàng loạt, mỗi dòng `url, nhãn` |
| `PATCH /api/domains/{id}` | Sửa |
| `DELETE /api/domains/{id}` | Xoá |
| `POST /api/domains/{id}/check` | Quét ngay |
| `GET /api/domains/{id}` | Chi tiết + lịch sử + biểu đồ 7 ngày |
| `GET /api/changes` | Toàn bộ thay đổi |
| `GET /api/export/changes.csv` | Xuất CSV (giờ VN, mở được bằng Excel) |
| `GET /api/relays` · `POST /api/relays/check` | Tình trạng relay |
| `POST /api/telegram/test` | Gửi tin thử |

Bảo vệ bằng HTTP Basic (`DASHBOARD_USER` / `DASHBOARD_PASSWORD`).

---

## Các loại thay đổi được ghi nhận

| Mã | Ý nghĩa |
|---|---|
| `new_redirect` | 🔴 Từ không redirect → có redirect |
| `redirect_target_changed` | 🟠 Đổi domain đích |
| `redirect_removed` | 🟢 Gỡ redirect |
| `redirect_code_changed` | 🟡 Đổi mã (302 → 301) |
| `redirect_method_changed` | 🟡 Đổi kiểu (HTTP → meta refresh) |
| `became_blocked` / `unblocked` | 🚫 / ✅ Bắt đầu / hết bị chặn |
| `status_changed` | 🔵 Đổi HTTP status |

---

## Vận hành

```bash
docker compose logs -f app          # xem log
docker compose restart app          # khởi động lại
sqlite3 data/monitor.db ".backup '/backup/monitor-$(date +%F).db'"   # backup
```

**Cần theo dõi:** tab **Relay VN** trên dashboard phải luôn hiện quốc gia **VN** màu xanh. Nếu chuyển sang màu đỏ hoặc mã nước khác, mọi kết quả về site geo-block đều không đáng tin.

---

## Giới hạn đã biết

- **Chỉ có một IP VN** là điểm chết đơn lẻ. Nếu quan trọng, dựng 2 relay ở 2 nhà mạng (Viettel + FPT) và khai báo qua `RELAY_NODES` — hệ thống tự failover.
- **Không phát hiện được thay đổi ngắn hơn nhịp quét.** Site 301 trong 5 giây rồi trả lại với nhịp 15s thì có thể lọt.
- **Bot-protection nặng** (Cloudflare Turnstile, captcha) có thể vẫn chặn cả browser mode.
- **Chưa test build Docker** trong môi trường phát triển (không có Docker daemon). Code Python/JS và cú pháp compose đã được kiểm tra; lần `docker compose up --build` đầu tiên nên chạy thủ công và xem log.
- Nếu chuyển sang **>500 domain**, nên đổi SQLite sang Postgres (chỉ cần thay lớp `db.py`).

---

## Đã kiểm chứng

| Hạng mục | Kết quả |
|---|---|
| Phát hiện 301/302/meta refresh/403 | ✅ mọi thời điểm flip thật đều nằm trong khoảng báo cáo |
| Phân loại 7 loại thay đổi | ✅ |
| Phân biệt geo-block vs bot-protection | ✅ |
| Throughput 201 domain @ 15s | ✅ 13,8 req/s (lý thuyết 13,4) — không trượt nhịp |
| Trải tải lúc khởi động | ✅ API latency 1,4ms (trước khi sửa: timeout) |
| DB không phình | ✅ 5.195 lượt quét → vẫn 201 dòng trạng thái |
| Failover khi relay chết | ✅ circuit breaker mở, fallback direct |
| **Không báo động giả khi relay chết** | ✅ trạng thái giữ nguyên, 0 cảnh báo giả |
| Phát hiện lại sau khi relay hồi phục | ✅ |
| Chuẩn hoá URL + tên miền tiếng Việt | ✅ IDNA/punycode |
