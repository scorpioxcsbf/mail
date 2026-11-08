# MEHDI MAIL: real temporary email service

Node.js + SQLite backend with a **built-in inbound SMTP server**, React (Vite) dashboard.
It only stores mail actually delivered to your server over SMTP. Nothing is simulated.

**It is NOT operational until you have: (1) a domain, (2) a public server with port 25 open, (3) correct MX/A DNS records.** Without those, the UI runs but no mail can arrive.

## 1. What you need
- A domain (or subdomain, e.g. `mail.yourdomain.com`) whose DNS you control
- A VPS with a public IPv4, Linux, Node 20+. **Port 25 inbound must be open.** Many clouds (AWS, GCP, Azure, DigitalOcean on new accounts) block or restrict port 25: check your provider or use one that allows it (Hetzner, OVH, Vultr after request, etc.)

## 2. DNS records (at your DNS provider)
Using `mail.example.com` as the mail domain and `203.0.113.10` as the server IP:

| Type | Name | Value |
|---|---|---|
| A | `mx.example.com` | `203.0.113.10` |
| MX | `mail.example.com` | `10 mx.example.com` |
| A | `app.example.com` | `203.0.113.10` (web UI; optional if you use the same host) |

Addresses will look like `anything@mail.example.com`. Do not put the MX host behind a proxy (e.g. Cloudflare orange cloud); keep it DNS-only.
Verify: `dig MX mail.example.com +short` and, from another machine, `nc -vz 203.0.113.10 25`.

## 3. Install
```bash
git clone <your repo> mehdi-mail && cd mehdi-mail
npm install
npm run build            # builds the React frontend into web/dist
cp .env.example .env     # then edit DOMAINS=mail.example.com
```
Allow Node to bind port 25 without root:
```bash
sudo setcap 'cap_net_bind_service=+ep' $(readlink -f $(which node))
```
Run: `npm start`. You should see `[smtp] listening on 25` and `[http] listening on 3000`.

## 4. Production (systemd + HTTPS)
`/etc/systemd/system/mehdi-mail.service`
```
[Unit]
Description=MEHDI MAIL
After=network.target
[Service]
WorkingDirectory=/opt/mehdi-mail
ExecStart=/usr/bin/node server/index.js
Restart=always
User=mehdimail
AmbientCapabilities=CAP_NET_BIND_SERVICE
NoNewPrivileges=true
[Install]
WantedBy=multi-user.target
```
`sudo systemctl enable --now mehdi-mail`

HTTPS for the web UI with Caddy (`/etc/caddy/Caddyfile`):
```
app.example.com {
  reverse_proxy localhost:3000
}
```
Keep `TRUST_PROXY=true`. Open firewall ports 25, 80, 443 only. Back up `data/mehdi-mail.db` if you care about it (it is temporary data by design).

## 5. Configuration (.env)
`DOMAINS` (comma-separated, each needs MX), `DEFAULT_TTL_MINUTES`, `MAX_TTL_MINUTES`, `MAX_MESSAGE_BYTES`, `MAX_MESSAGES_PER_INBOX`, `MAX_ADDRESSES_PER_IP_PER_HOUR`, `SMTP_PORT`, `HTTP_PORT`, `DB_PATH`.

## 6. API
| Method | Path | Auth |
|---|---|---|
| GET | `/api/config` | none |
| POST | `/api/addresses` `{username?, domain?, ttlMinutes?}` → `{address, token, expiresAt}` | none (rate limited) |
| GET | `/api/addresses/:address/messages` | `Authorization: Bearer <token>` |
| GET | `/api/addresses/:address/messages/:id` | Bearer |
| DELETE | `/api/addresses/:address/messages/:id` | Bearer |
| DELETE | `/api/addresses/:address` | Bearer |

## 7. Security notes
- 256-bit random token per inbox; only its SHA-256 hash is stored; compared in constant time. The token lives in the creator's browser (localStorage). Lose it and the inbox is inaccessible.
- Incoming HTML is sanitized server-side (no scripts, forms, iframes, images/tracking pixels) and displayed in a fully sandboxed iframe.
- SMTP rejects mail for unknown or expired addresses (550), enforces a size limit, has no relay and no AUTH, so it cannot be used to send spam.
- Rate limits on address creation and API; Helmet CSP headers; expired inboxes and their messages are purged every 30 s.

## 8. Using a hosted inbound provider instead
If you can't open port 25, use a provider with inbound webhooks (Mailgun Routes, Postmark Inbound, SendGrid Inbound Parse): point MX to them and add a webhook route that validates their signature and inserts into the `messages` table. The schema and sanitizer in `server/index.js` are reusable for this; the built-in SMTP path is the one implemented here.

## 9. Limits / honesty
- Not tested against the live internet in this build environment (no network/DNS here). The code is syntax-checked only; run through the checklist: MX resolves, port 25 reachable, send a test mail from Gmail.
- Many large senders (Gmail, etc.) only deliver to MX hosts with a proper reverse DNS (PTR) record for the server IP: set it at your VPS provider to `mx.example.com`.
- Single-node SQLite; for multi-node scale swap in Postgres.
