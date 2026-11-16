# Deploy — Book Marketing Studio (bookmarketing.amaldas.si)

Node 20+, Caddy, systemd and one SQLite file, with no database server.

## 1. DNS

In the amaldas.si DNS zone (Hostinger), add an A record:

```
bookmarketing   A   <VPS_IP>
```

## 2. Install

```
/opt/marketing/             this app (port 3001)
```

```bash
# On the VPS, as root:
mkdir -p /opt/marketing && cd /opt/marketing
git clone <your-github-repo-url> .   # or copy the files
npm ci --omit=dev
cp .env.example .env
# Edit .env:
#   ENCRYPTION_KEY:  openssl rand -hex 32   (keep a copy in your password manager)
#   SESSION_SECRET:  openssl rand -hex 32
#   HANDOFF_TOKEN:   openssl rand -hex 32   (shared secret for incoming book handoffs)
#   PUBLIC_BASE_URL: https://bookmarketing.amaldas.si
#   ADMIN_USERNAME / ADMIN_PASSWORD: the main admin, created on first start
mkdir -p data
chown -R www-data:www-data /opt/marketing
```

## 3. systemd service

`/etc/systemd/system/marketing.service`:

```ini
[Unit]
Description=Book Marketing Studio
After=network.target

[Service]
Type=simple
User=www-data
WorkingDirectory=/opt/marketing
EnvironmentFile=/opt/marketing/.env
ExecStart=/usr/bin/node server.js
Restart=on-failure
RestartSec=5
# The app flushes its database on SIGTERM; give it a moment.
TimeoutStopSec=15

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload
systemctl enable --now marketing
systemctl status marketing
```

The automation engine (scheduler, posting, digests, background jobs) runs
inside this one process. You don't need cron or a second service.

## 4. Caddy (add a block)

```caddy
bookmarketing.amaldas.si {
    reverse_proxy 127.0.0.1:3001
}
```

```bash
systemctl reload caddy
```

`https://bookmarketing.amaldas.si/api/health` should return
`{"ok":true,"app":"book-marketing-studio","version":"2.2.0"}`.

The public reader pages are served by the same app: `/p/<book>` (book
page), `/b/<book>` (smart link), `/confirm/…` and `/u/…`. They need
nothing extra in Caddy.

## 5. First sign-in and setup

1. Open https://bookmarketing.amaldas.si and sign in with ADMIN_USERNAME /
   ADMIN_PASSWORD from `.env` (or, if those are empty, create the admin
   account — the first account becomes the admin). Then change the
   password and turn on two-step sign-in.
2. **Settings → Integrations:**
   - Handoff token (the same value as in `.env`)
   - Public base URL
   - Notification email (for the daily digest)
   - Optional: the post webhook and n8n webhooks
3. **Settings → API vault.** Connect in this order:
   - **Anthropic.** Writes all the content.
   - **Perplexity.** Keyword and market research with sources.
   - **DeepL.** Translations; free keys end in `:fx`.
   - **Brevo.** Add the verified sender email and the reader list ID.
     Brevo sends ARC emails and launch campaigns, and keeps the reader
     list.
   - **Gmail.** One-to-one pitches from your own address. Create an OAuth
     client in Google Cloud, authorise the `gmail.send` and
     `gmail.readonly` scopes once (for example with the OAuth Playground),
     then paste the **refresh token**, client ID and client secret. The
     app refreshes access tokens itself.
   - **LinkedIn.** Create an app with *Share on LinkedIn* and *Sign In
     with LinkedIn using OpenID Connect*, generate a member token
     (`w_member_social openid profile`), paste it and its expiry date,
     then press **Test** (this saves your author URN). Tokens last about
     60 days; the app warns 7 days ahead.
   - **Facebook Page / Instagram.** Use a Page access token (and the
     Instagram professional account ID) from Meta for Developers.
   - **X.** Posting needs a paid API tier.
   - **ElevenLabs and Ideogram**, if you want them.
4. **Settings → Automation:** check the rules and the digest hour (UTC).
   Optionally list the languages to localize automatically before each
   launch.
5. **Settings → Budgets:** set an overall monthly AI budget (for example
   `monthly / every / 50`).
6. **Settings → Worldwide:** press **Refresh from the ECB now**, or turn
   on daily refresh.

## 6. Handoff check

Send a test book handoff to `/api/handoff`. In the app, check that:

- the book appears on the Dashboard at stage 2, with stage 1 done;
- the metadata is filled in;
- the manuscript has been split into chapters (Overview tab);
- the cover shows.

If it doesn't arrive, check:

- `journalctl -u marketing -f` for errors;
- that the handoff token matches on both sides (a wrong token returns 401);
- that the sender points at `https://bookmarketing.amaldas.si/api/handoff`.

## 7. Backups

The app's state is the database file plus the books folder:

```
/opt/marketing/data/marketing-studio.db   all records
/opt/marketing/data/books/                manuscripts, covers, audio files
/opt/marketing/.env                       the encryption key
```

v2 writes the database atomically (temp file, then rename), so a copy
taken while the app is running is always a complete file. Nightly:

```bash
tar czf /root/backups/marketing-$(date +%F).tgz -C /opt/marketing data .env
```

## 8. Updates (including v1 → v2)

```bash
cd /opt/marketing
tar czf /root/backups/marketing-before-update-$(date +%F).tgz data .env
git pull
npm ci --omit=dev
systemctl restart marketing
```

A v1 database is upgraded in place on start: the new tables and columns
are added and nothing is removed. Keys saved in v1 keep working.

## VPS notes

- The app sits behind Caddy on ports 80/443. Only ports 22, 80 and 443
  should be open in the firewall.
- The app listens on 127.0.0.1 only. It trusts `X-Forwarded-*` headers
  from loopback (Caddy) for HTTPS detection and secure cookies.
- Node 20+ is required. Node 22 LTS is recommended (the Dockerfile uses
  it).
- Docker alternative: `docker build -t marketing .` then
  `docker run -d -p 127.0.0.1:3001:3001 --env-file .env -e TRUST_PROXY=true -v /opt/marketing/data:/app/data marketing`.
