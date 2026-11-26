# DNS 設定 — shifteee.com

## 喺你嘅網域註冊商 DNS 面板，加呢 2 條 A 記錄

| 類型 | 名稱 (Host) | 值 (Value) | TTL |
|---|---|---|---|
| A    | `@`         | `<你嘅伺服器 IP>`   | 3600 (或 Auto) |
| A    | `www`       | `<你嘅伺服器 IP>`   | 3600 (或 Auto) |

- `@`（apex）= `shifteee.com` 本身。
- `www` = `www.shifteee.com`。
- 將 `<你嘅伺服器 IP>` 換成你 VPS 真實 IPv4（例如 `203.0.113.10`）。

### 可選
| 類型 | 名稱 | 值 |
|---|---|---|
| AAAA | `@` / `www` | 你嘅 IPv6（如有） |

### 如果你冇固定 IP（用 Railway／Render／Fly.io 等 PaaS）
- 唔好用 A，改用 **CNAME**：
  - `www` → 平台俾你嘅 hostname（例如 `xxx.up.railway.app`）
  - `@`（apex）視平台：「ALIAS／ANAME／Flatten」或額外 CNAME。

> 呢個 app 用 `whatsapp-web.js`（要持久 Chromium + `.wwebjs_auth` 同 `database.sqlite`），
> 強烈建議用**有固定 IP 嘅 VPS**（Hetzner／DigitalOcean／Linode／AWS Lightsail），唔好用無狀態 PaaS。

## 完整上線順序（喺 server 上；DigitalOcean Console 你已是 root，唔使 sudo）

```bash
# 1) 安裝 Node 20 + Nginx + Git + Chromium 依賴
apt-get update
apt-get install -y curl git nginx build-essential python3
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs
apt-get install -y libnss3 libatk-bridge2.0-0 libatk1.0-0 libcups2 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2
node -v          # 應顯示 v20.x
npm i -g pm2

# 2) 攞碼落嚟 + 裝套件 + 填 .env
cd /root
git clone https://github.com/<你GitHub>/<repo>.git
cd <repo>
npm install
cp .env.example .env
nano .env        # 填 ADMIN_TOKEN=...  同  PUBLIC_BASE_URL=https://shifteee.com ；Ctrl+O 存、Ctrl+X 走

# 3) PM2 跑 + 開機自啟
pm2 start ecosystem.config.js
pm2 save
pm2 startup      # 跟佢顯示嘅指令 copy 一次並執行

# 4) Nginx 反代
cp deploy/shifteee.nginx.conf /etc/nginx/sites-available/shifteee
ln -s /etc/nginx/sites-available/shifteee /etc/nginx/sites-enabled/shifteee
nginx -t && systemctl reload nginx

# 5) 免費 HTTPS
apt-get install -y certbot python3-certbot-nginx
certbot --nginx -d shifteee.com -d www.shifteee.com
```

完成後：`https://shifteee.com`（網站）· `https://shifteee.com/register`（開通）· `https://shifteee.com/requests`（後台）

## 檢查 DNS 生效
```bash
dig +short shifteee.com     # 應回傳你嘅 server IP
dig +short www.shifteee.com
```