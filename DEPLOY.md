# Launching 更容易Eee (ShiftE+) — Website + Domain Guide

This repo now includes a public marketing website (`/public`) served at the root `/`
by the existing Express app in `index.js`.

- Landing page (hero, features, how it works, pricing, FAQ, CTA): `/`
- Sign-up / checkout flow (existing): `/register`
- Admin: `/requests`, `/logs`, `/companies`, `/status`

Pricing shown on the site mirrors the real `PLANS` in `index.js` (HK$299 / HK$599 per month).

---

## 1. Buy a domain

You must purchase the domain yourself (needs your account + payment). Pick a short,
memorable name, then set your nameservers/DNS as below.

Recommended registrars (all support the DNS records in step 2):
- **Namecheap** (namecheap.com) — good value, includes free WHOIS privacy
- **Cloudflare Registrar** (cloudflare.com) — at-cost pricing, built-in CDN/DNS
- **Google Domains → Squarespace Domains** (domains.squarespace.com)
- **GoDaddy** (godaddy.com) — widely used

Suggested formats (examples): `shifte.app`, `shifteplus.com`, `gengrongyieee.com`,
`shifte.hk`, or your company name `.com.hk` / `.hk`.

> `.hk` / `.com.hk` domains require a Hong Kong business/organisation (HKDNR rules).

---

## 2. Point the domain to your server (DNS)

Once you have a server IP (see step 3), add these records in your registrar's DNS panel:

| Type | Name/Host | Value                      | TTL   |
|------|-----------|----------------------------|-------|
| A    | `@`       | `YOUR_SERVER_IP`           | Auto  |
| A    | `www`     | `YOUR_SERVER_IP`           | Auto  |
| AAAA | `@`       | `YOUR_SERVER_IPV6` (opt.)  | Auto  |

If you use a PaaS (Railway/Render/Fly.io), add a **CNAME** `www` (and `@` if supported)
pointing to the cloud-provided hostname instead.

---

## 3. Choose hosting (important)

This app uses `whatsapp-web.js`, which runs a **headless Chromium** and needs a
**persistent filesystem** for two things that must survive restarts:

1. `database.sqlite` — your data
2. `.wwebjs_auth/` — the WhatsApp login session (otherwise users must re-scan the QR)

### Recommended: a small VPS (most reliable)
- **Hetzner / DigitalOcean / Linode / AWS Lightsail / Vultr** — Ubuntu 22.04+, 1–2 GB RAM.
- Install Node 18+, Chromium deps, PM2, Nginx.

```bash
sudo apt-get update && sudo apt-get install -y nodejs npm nginx chromium
npm i -g pm2
```

### Alternative PaaS (needs a persistent disk)
Railway / Render / Fly.io work **if** you attach a persistent volume for
`database.sqlite` and `.wwebjs_auth/`, and provide the Chromium binary. Add either a
`Dockerfile` or use the platform's Node buildpack with the `@sparticuz/chromium` /
`puppeteer` headless-shell to keep the binary inside the container.

---

## 4. Configure environment variables

```bash
cp .env.example .env
```

Fill in at minimum:

```env
PUBLIC_BASE_URL=https://shifteee.com   # used by Stripe return URLs
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...
ALIPAYHK_PAYMENT_URL=...                 # optional
PAYME_PAYMENT_URL=...                    # optional
DEFAULT_PAYMENT_METHOD=stripe            # or mock for testing
ADMIN_TOKEN=some-long-random-string      # protects mark-paid endpoint
```

---

## 5. Run it (PM2, on a VPS)

```bash
npm install
pm2 start index.js --name shifte
pm2 save
pm2 startup      # follow the printed instructions so it restarts on reboot
```

---

## 6. Nginx reverse proxy + HTTPS (free SSL)

Example `/etc/nginx/sites-available/shifte`:

```nginx
server {
  listen 80;
  server_name shifteee.com www.shifteee.com;
  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

Enable and get SSL (auto-renews):

```bash
sudo ln -s /etc/nginx/sites-available/shifte /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d shifteee.com -d www.shifteee.com
```

---

## 7. Webhook for Stripe (for live payments)

Set your Stripe webhook endpoint to:

```
https://shifteee.com/webhooks/stripe
```

and keep `STRIPE_WEBHOOK_SECRET` in sync with Stripe.

---

## 8. Backups

Back up regularly (these are the only things that matter):

```bash
tar czf backup-$(date +%F).tgz database.sqlite .wwebjs_auth .env
```

---

### Quick start (local, no domain)

```bash
npm install
npm start
# open http://localhost:3000  (marketing site)
# open http://localhost:3000/register  (checkout, uses mock payment by default)
```