# Trien khai production — trs.aeseo1.com

VPS `do-sgp1-03` (139.59.227.174, Ubuntu 24.04, DigitalOcean Singapore).
May nay chay chung nhieu du an khac. Quy uoc bat buoc nam trong
`/root/docs/VPS_REGISTRY.md` tren chinh VPS — doc truoc khi sua bat cu thu gi.

Khong dung Docker: may nay khong cai Docker. Moi thu chay bang systemd, y het
cach cac du an khac tren may dang chay (`bill-app`, `sitemap-crawler`,
`adbanner-*`). Vi vay `docker-compose.yml` va `Caddyfile` trong repo chi con
dung cho may dev.

## Bo tri

| Thanh phan | Vi tri | Cong | Service |
|---|---|---|---|
| main-app (FastAPI) | `/var/www/redirect-monitor/main-app` | `127.0.0.1:8002` | `trs-app` |
| vn-relay (Node)    | `/var/www/redirect-monitor/vn-relay`  | `127.0.0.1:8003` | `trs-relay` |

- User he thong: `app-trs` (nologin). Ca hai service dung chung, giong cach
  `seo1-adbanner` chay hai service duoi mot user.
- Ca hai **chi nghe 127.0.0.1**. Ra Internet duy nhat qua OpenLiteSpeed.
  `ufw` chi mo 22/80/443 — relay khong the bi goi tu ben ngoai.
- Ma nguon deploy bang git tu bare repo `/srv/git/redirect-monitor.git`.

## Diem quan trong nhat: relay lay IP Viet Nam tu dau

VPS nay o Singapore. Relay **khong** dua vao IP cua may de co IP Viet Nam — no
di qua upstream proxy khai bao trong `RELAY_PROXIES` (`vn-dc`). Da do tu chinh
VPS: egress `160.250.167.229`, `country=VN`.

Nho vay ca hai thanh phan chay chung mot may van dung kien truc trong README.
Diem `direct` cua relay la IP Singapore — chi dung de doi chieu, khong dung de
ket luan trang thai.

`ALLOW_DIRECT_FALLBACK=false`: neu proxy VN chet thi bo qua lan quet do, tuyet
doi khong quet bang IP Singapore. Quet bang IP ngoai VN cho ket qua sai voi site
chan theo vung, va sai o day nghia la bao dong gia hang loat.

## Cai lai tu dau

```bash
# 1. User + thu muc + bare repo
useradd -r -s /usr/sbin/nologin -d /var/www/redirect-monitor app-trs
git init --bare /srv/git/redirect-monitor.git
git -C /srv/git/redirect-monitor.git symbolic-ref HEAD refs/heads/main

# 2. Tu may dev: git remote add vps ssh://root@139.59.227.174/srv/git/redirect-monitor.git
#                git push vps main

# 3. Lay ma nguon ve
git clone /srv/git/redirect-monitor.git /var/www/redirect-monitor
cd /var/www/redirect-monitor && mkdir -p main-app/data vn-relay/.cache

# 4. main-app
cd main-app && python3 -m venv venv && ./venv/bin/pip install -r requirements.txt

# 5. vn-relay + Chromium
cd ../vn-relay && npm install --omit=dev
PLAYWRIGHT_BROWSERS_PATH=$PWD/.cache/ms-playwright \
  node node_modules/playwright-core/cli.js install --with-deps chromium

# 6. .env cho ca hai (xem mau ben duoi), chmod 600, chown app-trs
chown -R app-trs:app-trs /var/www/redirect-monitor

# 7. systemd
cp deploy/trs-app.service deploy/trs-relay.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now trs-relay trs-app

# 8. Backup DB hang ngay
install -m 755 deploy/backup-db.sh /usr/local/bin/trs-backup-db
# crontab: 30 3 * * * /usr/local/bin/trs-backup-db >/dev/null 2>&1
```

`RELAY_API_KEY` phai **giong nhau** o hai file `.env`. Sinh bang
`openssl rand -hex 32`.

## Cap nhat ma nguon

```bash
# May dev
git push vps main
# VPS
cd /var/www/redirect-monitor && git fetch origin && git reset --hard origin/main
chown -R app-trs:app-trs /var/www/redirect-monitor
systemctl restart trs-relay trs-app
```

Giao dien React build o may dev (`cd main-app/frontend && npm run build` — xuat
thang ra `app/webui/`) roi commit. VPS khong cai `node_modules` cua frontend.

## OpenLiteSpeed

**Sao luu `httpd_config.conf` truoc khi sua** — file nay dung chung cho ca may.

Chi them dung 4 thu vao `/usr/local/lsws/conf/httpd_config.conf`:

```
listener http        { ... map trs.aeseo1.com trs.aeseo1.com }
listener https       { ... map trs.aeseo1.com trs.aeseo1.com }
listener https-banners { ... map trs.aeseo1.com trs.aeseo1.com }

virtualhost trs.aeseo1.com {
vhRoot     /usr/local/lsws/trs.aeseo1.com/
configFile /usr/local/lsws/conf/vhosts/trs.aeseo1.com/trs.aeseo1.com.conf
allowSymbolLink 1
enableScript    1
restrained      1
maxKeepAliveReq 10000
}
```

Cong voi `deploy/trs.aeseo1.com.conf` chep vao
`/usr/local/lsws/conf/vhosts/trs.aeseo1.com/`.

### TUYET DOI KHONG them listener rieng cho domain moi

Truc giac dau tien la lam giong `listener https-bill` / `https-sm` dang co san.
Da thu va hong theo hai cach:

1. Hai `vhTemplate` mac dinh cua OLS bao loi moi lan khoi dong lai:
   `[config:template:centralConfigLog] Listener [https-banners] does not exist`.
2. Nghiem trong hon: **listener dinh nghia sau cung gianh cong 443 va chung chi
   cua no thanh chung chi mac dinh cho MOI domain**. Them `listener https-trs` o
   cuoi file khien bill, sm, banners, price deu bi tra ve chung chi cua trs.

Co che that su: `https-banners` la listener gianh duoc cong 443. Chi nhung vhost
duoc **map trong listener do** moi duoc chon dung chung chi theo SNI (lay tu khoi
`vhssl` trong vhost conf cua no). Do la ly do bill va sm co chung chi dung — ca
hai deu duoc map trong `https-banners` — con price thi khong va bi roi ve chung
chi mac dinh.

Vi vay: domain moi thi **map vao `https-banners`**, dung tao listener moi.

Kiem tra sau khi sua:

```bash
# Moi domain phai tra ve chung chi cua chinh no
for d in trs bill sm banners price; do
  printf "%-10s " "$d"
  echo | openssl s_client -connect 127.0.0.1:443 -servername $d.aeseo1.com 2>/dev/null \
    | openssl x509 -noout -subject
done
# Khong duoc sinh loi moi
tail -5 /usr/local/lsws/logs/error.log
```

## SSL

Chung chi origin tu ky tai `/etc/wptt-ssl-tu-ky/trs.aeseo1.com/`, giong het
`bill.aeseo1.com` va `sm.aeseo1.com` tren may nay.

Khach truy cap **van thay HTTPS hop le**: Cloudflare dung chung chi cua no o
bien. Chung chi tu ky chi dung cho chang Cloudflare -> origin.

Khong xin duoc Let's Encrypt: Cloudflare tra **403** cho may chu xac thuc cua LE
(da thu ca ban that lan staging; request cua nguoi dung thuong van 200). Day la
thiet lap phia Cloudflare, khong sua duoc tu VPS.

Muon chung chi that cho chang nay thi co hai duong:
- Tao **Cloudflare Origin Certificate** tren dashboard (cach `banners` va `price`
  dang dung) — song 15 nam, hop le ca voi che do "Full (strict)".
- Hoac tam tat proxy (may xam) cho ban ghi `trs`, chay certbot, roi bat lai.

Hien tai zone dang o che do **"Full"**. Neu doi sang **"Full (strict)"** thi
`trs`, `bill` va `sm` deu hong — ca ba deu dung chung chi tu ky.

## Kiem tra nhanh

```bash
systemctl status trs-app trs-relay
journalctl -u trs-relay -f

KEY=$(grep ^RELAY_API_KEY= /var/www/redirect-monitor/vn-relay/.env | cut -d= -f2)
curl -H "x-api-key: $KEY" http://127.0.0.1:8003/health
curl -H "x-api-key: $KEY" http://127.0.0.1:8003/egress-ip   # phai la country VN

curl https://trs.aeseo1.com/api/health
```

## Dang nhap: DANG TAT

`DASHBOARD_PASSWORD` de trong trong `main-app/.env` — theo `require_auth` trong
`app/main.py`, de trong nghia la **tat han xac thuc**.

Hau qua can biet: khong chi trang xem bi mo, ma **ca API ghi** cung mo. Bat ky ai
biet dia chi deu co the `POST /api/domains` va `DELETE /api/domains/{id}`.

Muon bat lai:

```bash
# Sinh mat khau moi roi dien vao main-app/.env
openssl rand -base64 24 | tr -d '/+=' | head -c 28
systemctl restart trs-app
```

Muon van mo nhung chan bot nguoi la, chon mot trong:
- Cloudflare Access (dat truoc domain, dang nhap bang email/Google)
- Chan theo IP ngay trong vhost OLS (`accessControl { allow <IP cua ban>; deny * }`)

Tren dashboard, tab **Relay VN** phai luon hien `VN`. Chuyen mau do hoac ra ma
nuoc khac thi moi ket qua ve site chan theo vung deu khong dang tin.
