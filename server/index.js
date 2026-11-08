import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { SMTPServer } from 'smtp-server';
import { simpleParser } from 'mailparser';
import sanitizeHtml from 'sanitize-html';
import multer from 'multer';
import initSqlJs from 'sql.js';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const env = process.env;
const DOMAINS = (env.DOMAINS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const DEFAULT_TTL  = +env.DEFAULT_TTL_MINUTES  || 60;
const MAX_TTL      = +env.MAX_TTL_MINUTES       || 1440;
const MAX_BYTES    = +env.MAX_MESSAGE_BYTES      || 5 * 1024 * 1024;
const MAX_MSGS     = +env.MAX_MESSAGES_PER_INBOX || 200;
const SMTP_ENABLED       = env.SMTP_ENABLED !== 'false';
const MAILGUN_SIGNING_KEY = env.MAILGUN_WEBHOOK_SIGNING_KEY || '';
const dir = path.dirname(fileURLToPath(import.meta.url));

if (!DOMAINS.length) console.warn('[WARN] DOMAINS is empty — configure DOMAINS in .env');

const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const now = () => Date.now();

// Sanitize inbound HTML — strips scripts, iframes, images (tracking pixels), forms
const clean = html => sanitizeHtml(html || '', {
  allowedTags: sanitizeHtml.defaults.allowedTags.filter(t => t !== 'img').concat(['h1','h2','span','center','font','u']),
  allowedAttributes: { a: ['href','name'], td: ['colspan','rowspan'], '*': ['align'] },
  allowedSchemes: ['http','https','mailto'],
  transformTags: { a: sanitizeHtml.simpleTransform('a', { target:'_blank', rel:'noopener noreferrer nofollow' }) }
});

// ─────────────────────────────────────────────
//  Bootstrap — async because sql.js init is async
// ─────────────────────────────────────────────
async function main() {

  // ── Database (sql.js: pure WASM SQLite, zero native deps) ──
  const dbPath = path.resolve(env.DB_PATH || './data/mehdi-mail.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const SQL = await initSqlJs();
  const db  = fs.existsSync(dbPath)
    ? new SQL.Database(fs.readFileSync(dbPath))
    : new SQL.Database();

  // Debounced flush — batches rapid writes into one disk write per 500 ms
  let _saveTimer = null;
  const scheduleSave = () => {
    if (_saveTimer) return;
    _saveTimer = setTimeout(() => {
      _saveTimer = null;
      fs.writeFileSync(dbPath, Buffer.from(db.export()));
    }, 500);
  };
  const flushNow = () => {
    if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; }
    fs.writeFileSync(dbPath, Buffer.from(db.export()));
  };

  // Helpers that mirror better-sqlite3's .get / .all / .run
  const dbGet = (sql, params = []) => {
    const s = db.prepare(sql); s.bind(params);
    const row = s.step() ? s.getAsObject() : null;
    s.free(); return row;
  };
  const dbAll = (sql, params = []) => {
    const s = db.prepare(sql); s.bind(params);
    const rows = []; while (s.step()) rows.push(s.getAsObject());
    s.free(); return rows;
  };
  const dbRun = (sql, params = []) => { db.run(sql, params); scheduleSave(); };

  // Schema
  db.run(`
    CREATE TABLE IF NOT EXISTS addresses(
      address TEXT PRIMARY KEY, token_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS messages(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      address TEXT NOT NULL REFERENCES addresses(address) ON DELETE CASCADE,
      sender TEXT, subject TEXT, text TEXT, html TEXT, received_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_msg_addr ON messages(address, received_at);
  `);

  const liveAddr = addr => dbGet('SELECT * FROM addresses WHERE address=? AND expires_at>?', [addr, now()]);

  // Shared helper: insert a received message into the DB
  function storeMessage(address, sender, subject, text, html) {
    const a = address.toLowerCase().trim();
    if (!DOMAINS.includes(a.split('@')[1]) || !liveAddr(a)) return false;
    dbRun('INSERT INTO messages(address,sender,subject,text,html,received_at) VALUES(?,?,?,?,?,?)',
      [a, String(sender||'unknown').slice(0,300), String(subject||'(no subject)').slice(0,300),
       String(text||'').slice(0,200000), html, now()]);
    // Keep only the newest MAX_MSGS per inbox
    db.run('DELETE FROM messages WHERE address=? AND id NOT IN (SELECT id FROM messages WHERE address=? ORDER BY received_at DESC LIMIT ?)',
      [a, a, MAX_MSGS]);
    scheduleSave();
    return true;
  }

  // ── HTTP API ──
  const app = express();
  if (env.TRUST_PROXY === 'true') app.set('trust proxy', 1);
  app.use(helmet({ contentSecurityPolicy: { directives: {
    defaultSrc: ["'self'"], styleSrc: ["'self'","'unsafe-inline'"], imgSrc: ["'self'",'data:']
  }}}));
  app.use(express.json({ limit: '10kb' }));
  app.use('/api', rateLimit({ windowMs: 60_000, limit: 240 }));
  const createLimit = rateLimit({ windowMs: 3_600_000, limit: +env.MAX_ADDRESSES_PER_IP_PER_HOUR||20,
    message: { error: 'Too many addresses created, try later' } });

  app.get('/api/config', (_, res) =>
    res.json({ domains: DOMAINS, defaultTtl: DEFAULT_TTL, maxTtl: MAX_TTL, ready: DOMAINS.length > 0 }));

  app.post('/api/addresses', createLimit, (req, res) => {
    if (!DOMAINS.length) return res.status(503).json({ error: 'Server has no DOMAINS configured' });
    let { username, domain, ttlMinutes } = req.body || {};
    domain = String(domain || DOMAINS[0]).toLowerCase();
    if (!DOMAINS.includes(domain)) return res.status(400).json({ error: 'Domain not supported' });
    username = String(username||'').toLowerCase().trim() || crypto.randomBytes(5).toString('hex');
    if (!/^[a-z0-9][a-z0-9._-]{2,31}$/.test(username)) return res.status(400).json({ error: 'Username: 3-32 chars (a-z, 0-9, . _ -)' });
    const ttl = Math.min(Math.max(+ttlMinutes||DEFAULT_TTL, 1), MAX_TTL);
    const address = `${username}@${domain}`;
    if (liveAddr(address)) return res.status(409).json({ error: 'Address already in use' });
    dbRun('DELETE FROM addresses WHERE address=?', [address]);
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = now() + ttl * 60_000;
    dbRun('INSERT INTO addresses VALUES(?,?,?,?)', [address, sha(token), now(), expiresAt]);
    res.status(201).json({ address, token, expiresAt }); // token returned once — only hash stored
  });

  function auth(req, res, next) {
    const address = req.params.address.toLowerCase();
    const tok = (req.headers.authorization||'').replace(/^Bearer /, '');
    const row = liveAddr(address);
    const ok = row && tok && crypto.timingSafeEqual(Buffer.from(sha(tok)), Buffer.from(row.token_hash));
    if (!ok) return res.status(401).json({ error: 'Invalid token or expired address' });
    req.addr = row; next();
  }

  app.get('/api/addresses/:address', auth, (req, res) =>
    res.json({ address: req.addr.address, expiresAt: req.addr.expires_at }));

  app.get('/api/addresses/:address/messages', auth, (req, res) =>
    res.json(dbAll(
      'SELECT id,sender,subject,received_at AS receivedAt,substr(text,1,120) AS preview FROM messages WHERE address=? ORDER BY received_at DESC LIMIT 200',
      [req.addr.address])));

  app.get('/api/addresses/:address/messages/:id', auth, (req, res) => {
    const m = dbGet('SELECT id,sender,subject,text,html,received_at AS receivedAt FROM messages WHERE id=? AND address=?',
      [+req.params.id, req.addr.address]);
    m ? res.json(m) : res.status(404).json({ error: 'Not found' });
  });

  app.delete('/api/addresses/:address/messages/:id', auth, (req, res) => {
    dbRun('DELETE FROM messages WHERE id=? AND address=?', [+req.params.id, req.addr.address]);
    res.json({ ok: true });
  });

  app.delete('/api/addresses/:address', auth, (req, res) => {
    dbRun('DELETE FROM addresses WHERE address=?', [req.addr.address]);
    res.json({ ok: true });
  });

  // ── Webhook helpers ──
  const upload = multer({ limits: { fileSize: MAX_BYTES } });

  // Mailgun inbound webhook
  function verifyMailgunSig(ts, token, sig) {
    if (!MAILGUN_SIGNING_KEY) return false;
    if (Math.abs(Date.now()/1000 - parseInt(ts,10)) > 300) return false;
    const expected = crypto.createHmac('sha256', MAILGUN_SIGNING_KEY).update(String(ts)+String(token)).digest('hex');
    try { return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(String(sig))); } catch { return false; }
  }

  app.post('/api/webhook/mailgun', upload.none(), (req, res) => {
    const b = req.body || {};
    if (!verifyMailgunSig(b.timestamp, b.token, b.signature))
      return res.status(403).json({ error: 'Invalid signature' });
    const to = (b.recipient||'').toLowerCase().trim();
    const stored = storeMessage(to, b.from||b.sender, b.subject, b['body-plain']||'', clean(b['body-html']||''));
    console.log(stored ? `[mailgun] stored → ${to}` : `[mailgun] skipped: ${to}`);
    res.status(200).json({ ok: true });
  });

  // CloudMailin inbound webhook (Multipart Normalized format)
  app.post('/api/webhook/cloudmailin', upload.none(), (req, res) => {
    const b = req.body || {};
    const to      = (b['envelope[to]'] || b.envelope_to || '').toLowerCase().trim();
    const from    = b['envelope[from]'] || b.envelope_from || b['headers[from]'] || '';
    const subject = b['headers[subject]'] || b.subject || '(no subject)';
    if (!to) return res.status(200).json({ ok: true, skipped: 'no recipient' });
    const stored = storeMessage(to, from, subject, b.plain||'', clean(b.html||''));
    console.log(stored ? `[cloudmailin] stored → ${to}` : `[cloudmailin] skipped: ${to}`);
    res.status(200).json({ ok: true });
  });

  // ── Static frontend ──
  const dist = path.join(dir, '../web/dist');
  app.use(express.static(dist));
  app.get('*', (_, res) => res.sendFile(path.join(dist,'index.html'),
    e => e && res.status(404).send('Frontend not built — run: npm run build')));
  app.listen(+env.HTTP_PORT||3000, () => console.log(`[http] listening on ${env.HTTP_PORT||3000}`));

  // ── Built-in SMTP (optional — disable with SMTP_ENABLED=false) ──
  if (SMTP_ENABLED) {
    const smtp = new SMTPServer({
      name: DOMAINS[0]||'localhost', authOptional: true, disabledCommands: ['AUTH'],
      size: MAX_BYTES, banner: 'MEHDI MAIL',
      onRcptTo(addr, _s, cb) {
        const a = addr.address.toLowerCase();
        if (!DOMAINS.includes(a.split('@')[1]) || !liveAddr(a)) {
          const e = new Error('Mailbox does not exist'); e.responseCode = 550; return cb(e);
        }
        cb();
      },
      onData(stream, session, cb) {
        simpleParser(stream).then(mail => {
          if (stream.sizeExceeded) { const e = new Error('Message too large'); e.responseCode = 552; return cb(e); }
          const sender = mail.from?.text || session.envelope.mailFrom?.address || 'unknown';
          for (const r of session.envelope.rcptTo)
            storeMessage(r.address, sender, mail.subject, mail.text, mail.html ? clean(mail.html) : '');
          cb();
        }).catch(err => { console.error('[smtp] parse error:', err.message); cb(new Error('Processing failed')); });
      }
    });
    smtp.on('error', e => console.error('[smtp]', e.message));
    smtp.listen(+env.SMTP_PORT||25, env.SMTP_HOST||'0.0.0.0',
      () => console.log(`[smtp] listening on ${env.SMTP_PORT||25}`));
  } else {
    console.log('[smtp] disabled — using webhook mode');
  }

  // Cleanup expired addresses every 30 s
  setInterval(() => { db.run('DELETE FROM addresses WHERE expires_at<?', [now()]); scheduleSave(); }, 30_000);

  // Flush DB on graceful shutdown
  ['SIGTERM','SIGINT'].forEach(sig => process.once(sig, () => { flushNow(); process.exit(0); }));
}

main().catch(err => { console.error('Fatal startup error:', err); process.exit(1); });
