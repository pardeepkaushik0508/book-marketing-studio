# Book Marketing Studio: go-live steps (for Pardeep)

**Address:** https://bookmarketing.amaldas.si
**Stack:** Node.js 20+ and Caddy on the VPS. The app uses port 3001.
**API keys:** Justin adds them himself after go-live, in Settings → API vault. You don't need any.

## 1. GitHub
1. Create a branch named **`publish`** in the repository.
2. Unzip `marketing-v2.2.zip` and commit all of its files to that branch.
3. Never commit `.env`, `data/` or `node_modules/`.

## 2. DNS
Add an **A record**: `bookmarketing` → the VPS IP address.

## 3. Install on the VPS
```bash
mkdir -p /opt/marketing && cd /opt/marketing
git clone -b publish <repo-url> .
npm ci --omit=dev
cp .env.example .env
mkdir -p data
```
Edit `.env` and set these values. Make each secret with `openssl rand -hex 32`:
```
ENCRYPTION_KEY=<secret>
SESSION_SECRET=<secret>
HANDOFF_TOKEN=<secret>
PUBLIC_BASE_URL=https://bookmarketing.amaldas.si
ADMIN_USERNAME=admin
ADMIN_PASSWORD=Justin@321
PORT=3001
HOST=127.0.0.1
```
Then run: `chown -R www-data:www-data /opt/marketing && chmod 600 /opt/marketing/.env`

## 4. Service
Create `/etc/systemd/system/marketing.service`:
```ini
[Unit]
Description=Book Marketing Studio
After=network.target
[Service]
User=www-data
WorkingDirectory=/opt/marketing
ExecStart=/usr/bin/node server.js
Restart=on-failure
TimeoutStopSec=15
[Install]
WantedBy=multi-user.target
```
Then run: `systemctl daemon-reload && systemctl enable --now marketing`

## 5. Caddy
Add this block to the Caddyfile, then run `systemctl reload caddy`:
```
bookmarketing.amaldas.si {
    reverse_proxy 127.0.0.1:3001
}
```

## 6. Check
- https://bookmarketing.amaldas.si/api/health should show `"ok":true` and `"version":"2.2.0"`.
- Sign in with **admin** / **Justin@321**.

## 7. Hand over
- Send Justin **ENCRYPTION_KEY** and **HANDOFF_TOKEN** privately.
- Keep a backup of `.env` and the `data/` folder. If ENCRYPTION_KEY is lost, every saved API key is lost with it.
- After the first sign-in, Justin will change the password and turn on two-step sign-in.

If port 3001 is already in use, pick a free port and use it in both `.env` and Caddy. Full details are in `DEPLOY.md`.
