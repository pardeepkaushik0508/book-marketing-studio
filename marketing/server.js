// Book Marketing Studio — server (v2).
// Node.js + Express, static frontend, SQLite (sql.js) persistence.
// "Marketing" at bookmarketing.amaldas.si: final copy → worldwide readers.
// Store listings in every marketplace, localized metadata, launch
// automation, content calendar with auto-posting, ARC reviews,
// endorsements, media pitches, foreign rights, bookstores and libraries,
// audio and translated editions, smart links and book pages, sales
// analytics, bestseller tracking and backlist refresh cycles.
// Run: npm install && npm start   (behind Caddy on the VPS)
const fs = require('fs');
const path = require('path');
const express = require('express');

// ---- tiny .env loader (no dependency) ----
(function loadEnv() {
  const envFile = path.join(__dirname, '.env');
  if (!fs.existsSync(envFile)) return;
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
})();

const db = require('./lib/db');
const { hashPassword, verifyPassword, randomToken, sha256, verifyTotp, newTotpSecret, totpSetupUrl, timingSafeEqualStr } = require('./lib/crypto');
const ai = require('./lib/ai');
const mk = require('./lib/marketing');
const jobs = require('./lib/jobs');
const scheduler = require('./lib/scheduler');
const importers = require('./lib/importers');
const manuscript = require('./lib/manuscript');

const PORT = parseInt(process.env.PORT || '3001', 10);
const HOST = process.env.HOST || '127.0.0.1';
const DB_PATH = process.env.DB_PATH || './data/marketing-studio.db';
const SESSION_DAYS = 30;
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-only-change-me';
const VERSION = '2.2.0';

const app = express();
// Async route errors go to the error handler instead of crashing the process.
for (const m of ['get', 'post', 'put', 'delete']) {
  const orig = app[m].bind(app);
  app[m] = (path, ...handlers) => (handlers.length ? orig(path, ...handlers.map((h) => (typeof h === 'function' && h.length < 4 ? (req, res, next) => { try { const r = h(req, res, next); if (r && typeof r.catch === 'function') r.catch(next); } catch (e) { next(e); } } : h))) : orig(path));
}
app.set('trust proxy', process.env.TRUST_PROXY || 'loopback'); // Caddy on the same host sets X-Forwarded-*
app.disable('x-powered-by');

// ---- security headers ----
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  // Book pages (/p/…) may be embedded on the imprint websites; the app may not.
  if (!req.path.startsWith('/p/')) res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https:", "connect-src 'self'", "media-src 'self'", "font-src 'self'",
    "form-action 'self'", req.path.startsWith('/p/') ? "frame-ancestors *" : "frame-ancestors 'none'", "base-uri 'self'", "object-src 'none'",
  ].join('; '));
  next();
});

app.use(express.json({ limit: '80mb' }));
app.use(express.static(path.join(__dirname, 'public'), { index: 'index.html', maxAge: '1h' }));

// ---- cookies (parsed manually, no dependency) ----
function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function cookieFlags(req) { return `HttpOnly; SameSite=Lax; Path=/${req.secure ? '; Secure' : ''}`; }
function setSession(req, res, token) { res.setHeader('Set-Cookie', `bms_session=${token}; ${cookieFlags(req)}; Max-Age=${SESSION_DAYS * 86400}`); }
function clearSession(req, res) { res.setHeader('Set-Cookie', `bms_session=; ${cookieFlags(req)}; Max-Age=0`); }
function csrfTokenFor(sessionToken) { return sha256(sessionToken + ':' + SESSION_SECRET); }

function auth(req, res, next) {
  const token = parseCookies(req).bms_session;
  if (!token) return res.status(401).json({ error: 'Please sign in.' });
  const session = db.get(
    "SELECT s.*, a.id AS account_id, a.name AS account_name, a.email, a.role, a.status, a.must_change_password, a.totp_enabled FROM sessions s JOIN accounts a ON a.id = s.account_id WHERE s.token_hash = ? AND s.expires_at > ?",
    [sha256(token), new Date().toISOString()]
  );
  if (!session) return res.status(401).json({ error: 'Session expired. Please sign in again.' });
  if (session.status === 'disabled') return res.status(403).json({ error: 'This account has been disabled.' });
  req.sessionToken = token;
  req.account = {
    id: session.account_id, name: session.account_name, email: session.email || '',
    role: session.role || 'member', isAdmin: session.role === 'admin',
    mustChangePassword: !!session.must_change_password, totpEnabled: !!session.totp_enabled,
  };
  next();
}

function requireAdmin(req, res, next) {
  if (!req.account.isAdmin) return res.status(403).json({ error: 'Only the admin can do that.' });
  next();
}

// CSRF: state-changing requests from a signed-in browser must carry the
// token issued at login (X-CSRF-Token). Handoff, health and the public
// reader endpoints are exempt (they never use the session cookie).
const CSRF_EXEMPT = ['/auth/login', '/auth/register', '/handoff', '/health', '/funnel/signup'];
app.use('/api', (req, res, next) => {
  if (CSRF_EXEMPT.some((p) => req.path.startsWith(p))) return next();
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const token = parseCookies(req).bms_session;
  if (!token) return next();
  if (req.headers['x-csrf-token'] !== csrfTokenFor(token)) {
    return res.status(403).json({ error: 'Security token mismatch — please sign in again.' });
  }
  next();
});

// Simple in-memory rate limiter: `max` requests per IP per window.
function rateLimit(max, windowMs, message) {
  const hits = new Map();
  return (req, res, next) => {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    const rec = hits.get(ip) || { count: 0, resetAt: now + windowMs };
    if (now > rec.resetAt) { rec.count = 0; rec.resetAt = now + windowMs; }
    if (rec.count >= max) return res.status(429).json({ error: message || 'Too many requests — wait a little and try again.' });
    rec.count += 1;
    hits.set(ip, rec);
    if (hits.size > 5000) for (const [k, v] of hits) if (now > v.resetAt) hits.delete(k);
    next();
  };
}
const loginRateLimit = rateLimit(10, 15 * 60 * 1000, 'Too many sign-in attempts. Wait 15 minutes and try again.');

function bookOr404(req, res) {
  const book = db.get('SELECT * FROM books WHERE id = ?', [req.params.id]);
  if (!book) { res.status(404).json({ error: 'Book not found.' }); return null; }
  return book;
}

function logAct(accountId, action, bookId, detail) {
  try { db.exec('INSERT INTO activity_log (account_id, action, book_id, detail) VALUES (?, ?, ?, ?)', [accountId || null, action, bookId || null, detail || '']); } catch { /* never break the request */ }
}

function getSetting(key, def = '') { const row = db.get('SELECT value FROM settings WHERE key = ?', [key]); return row ? row.value : def; }
function setSetting(key, value) { db.exec('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [key, String(value)]); }

function fireWebhook(key, payload) {
  try {
    const url = getSetting(key);
    if (url) fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }).catch(() => logAct(null, 'webhook_failed', payload.bookId, key));
  } catch { /* fire-and-forget */ }
}

function setStage(bookId, stageNo, status, payload) {
  const row = db.get('SELECT id FROM stages WHERE book_id = ? AND stage_no = ?', [bookId, stageNo]);
  const p = JSON.stringify(payload || {});
  if (row) db.exec("UPDATE stages SET status = ?, payload = ?, updated_at = datetime('now') WHERE id = ?", [status, p, row.id]);
  else db.exec('INSERT INTO stages (book_id, stage_no, status, payload) VALUES (?, ?, ?, ?)', [bookId, stageNo, status, p]);
  // current stage = first stage not done/skipped
  const open = db.get("SELECT MIN(stage_no) AS n FROM stages WHERE book_id = ? AND status NOT IN ('done','skipped')", [bookId]);
  db.exec("UPDATE books SET current_stage = ?, updated_at = datetime('now') WHERE id = ?", [open && open.n ? open.n : 11, bookId]);
}

function imprintOf(book) { return book && book.imprint_id ? db.get('SELECT * FROM imprints WHERE id = ?', [book.imprint_id]) : null; }
function imprintChannels(imp) { return imp ? db.query('SELECT * FROM channels WHERE imprint_id = ?', [imp.id]) : []; }

function promptText(task) {
  return db.get('SELECT version, text FROM prompts WHERE task = ? ORDER BY id DESC LIMIT 1', [task]) || { version: '1.0', text: '' };
}

// Public address for smart links and book pages: Settings → Integrations
// → Public base URL, else PUBLIC_BASE_URL, else the address the app was
// last opened at (remembered for background jobs).
let lastSeenBase = '';
app.use('/api', (req, res, next) => { if (req.get('host')) lastSeenBase = `${req.protocol}://${req.get('host')}`; next(); });
function publicBase(req) {
  const set = getSetting('public_base_url') || process.env.PUBLIC_BASE_URL || '';
  if (set) return set.replace(/\/$/, '');
  return req ? `${req.protocol}://${req.get('host')}` : lastSeenBase;
}

function uniqueSlug(title, id) {
  const base = mk.slugify(title);
  let slug = base, i = 2;
  while (db.get('SELECT id FROM books WHERE slug = ? AND id != ?', [slug, id || 0])) slug = `${base}-${i++}`;
  return slug;
}

function createStages(bookId, firstDone, note) {
  for (let n = 1; n <= 11; n++) setStage(bookId, n, n === 1 && firstDone ? 'done' : 'todo', n === 1 && firstDone ? { note } : {});
}

// Content types every kit can make. LinkedIn articles only for imprints
// that own a LinkedIn channel (channel rules).
const KIT_TYPES = ['description', 'social', 'email', 'linkedin', 'presskit', 'sellsheet', 'talkingpoints', 'aplus', 'author_bio', 'quote_cards', 'trailer', 'back_matter'];
const POSITIONING_TYPES = ['reader_profile', 'positioning'];
const EXTRA_COPY_TYPES = ['description_ab', 'kdp_keywords', 'categories', 'promo_sites', 'reader_magnet', 'repurpose_30', 'social_proof'];
const ANALYSIS_TYPES = ['competitor_teardown', 'ads_analysis'];
const ALL_CONTENT_TYPES = [...KIT_TYPES, 'bookbub_ad', 'ads_keywords', 'newsletter', 'rights_guide', 'media_pitch', 'podcast_pitch', 'library_pitch', 'bookstore_pitch', ...POSITIONING_TYPES, ...EXTRA_COPY_TYPES, ...ANALYSIS_TYPES];
const { AVOID_PHRASES } = require('./lib/prompts2');

// Extra context per content type, taken from what the app already knows:
// positioning, lessons from earlier books of the same imprint, chapters,
// real reviews, competitors and ad results with break-even ACOS.
function latestContent(bookId, type) {
  return db.get("SELECT text FROM content WHERE book_id = ? AND type = ? AND lang = 'English' ORDER BY approved DESC, version DESC LIMIT 1", [bookId, type])?.text || '';
}
function contextFor(book, type) {
  const parts = [];
  if (!POSITIONING_TYPES.includes(type) && !ANALYSIS_TYPES.includes(type)) {
    const rp = latestContent(book.id, 'reader_profile'), pos = latestContent(book.id, 'positioning');
    if (rp) parts.push(`READER PROFILE:\n${rp.slice(0, 2500)}`);
    if (pos) parts.push(`POSITIONING:\n${pos.slice(0, 2000)}`);
  }
  // Flywheel: what earlier books of the same imprint taught us.
  const lessons = db.query('SELECT l.text FROM lessons l JOIN books b ON b.id = l.book_id WHERE b.imprint_id IS ? AND l.text != \'\' ORDER BY l.id DESC LIMIT 8', [book.imprint_id || null]);
  if (lessons.length) parts.push(`LESSONS FROM THIS IMPRINT (apply them):\n${lessons.map((l) => '- ' + l.text).join('\n')}`);
  if (['repurpose_30', 'reader_magnet'].includes(type)) {
    const ch = db.query('SELECT no, title, text FROM chapters WHERE book_id = ? ORDER BY no', [book.id]);
    const per = ch.length ? Math.max(300, Math.floor(24000 / ch.length)) : 0;
    parts.push(ch.length ? `CHAPTERS:\n${ch.map((c) => `Chapter ${c.no}: ${c.title}\n${c.text.slice(0, per)}`).join('\n\n')}` : 'CHAPTERS: none stored — work from the description and back cover.');
  }
  if (type === 'social_proof') {
    const rv = db.query("SELECT rating, text, store, date FROM reviews WHERE book_id = ? AND text != '' ORDER BY date DESC LIMIT 60", [book.id]);
    parts.push(`REAL REVIEWS (${rv.length}):\n${rv.map((r) => `[${r.rating || '?'}★ ${r.store || ''} ${r.date || ''}] ${r.text}`).join('\n') || 'none'}`);
  }
  if (type === 'promo_sites') {
    const rv = db.query("SELECT text FROM reviews WHERE book_id = ? AND rating >= 4 AND text != '' ORDER BY date DESC LIMIT 5", [book.id]);
    if (rv.length) parts.push(`REAL REVIEWS YOU MAY QUOTE VERBATIM:\n${rv.map((r) => '- ' + r.text).join('\n')}`);
  }
  if (type === 'competitor_teardown') {
    const cs = db.query('SELECT * FROM competitors WHERE book_id = ?', [book.id]);
    parts.push(`COMPETITORS (${cs.length}):\n${cs.map((c) => `- "${c.title}" by ${c.author || '?'} · price ${c.price ?? '?'} · rank ${c.rank ?? '?'} · ${c.review_count ?? '?'} reviews · ${c.rating ?? '?'}★ · ${c.category || ''}`).join('\n') || 'none recorded — add competitors on the Refresh tab first'}`);
  }
  if (type === 'ads_analysis') {
    const be = mk.breakEvenAcos(book.id);
    const ads = db.query('SELECT * FROM ads WHERE book_id = ?', [book.id]);
    parts.push(`ROYALTY PER SALE: $${be.royaltyPerSale} (${be.basis}) · PRICE: $${be.avgPrice} · BREAK-EVEN ACOS: ${be.breakEvenAcos != null ? be.breakEvenAcos + '%' : 'unknown (add a price)'}`);
    parts.push(`CAMPAIGNS (${ads.length}):\n${ads.map((a) => { const acos = a.sales > 0 ? Math.round((a.spend / a.sales) * 1000) / 10 + '%' : 'no sales'; const ctr = a.impressions > 0 ? Math.round((a.clicks / a.impressions) * 10000) / 100 + '%' : '?'; return `- ${a.platform} "${a.campaign_name}" ${a.period || ''}: spend ${a.spend} ${a.currency}, sales ${a.sales}, orders ${a.orders}, impressions ${a.impressions}, clicks ${a.clicks}, CTR ${ctr}, ACOS ${acos}`; }).join('\n') || 'none recorded'}`);
  }
  return parts.join('\n\n');
}

function kitTypesFor(imp) {
  const chans = imprintChannels(imp).map((c) => c.platform.toLowerCase());
  return KIT_TYPES.filter((t) => t !== 'linkedin' || chans.includes('linkedin'));
}

async function generateContentFor(book, type, channel, { lang = 'English', extra = '' } = {}) {
  const imp = imprintOf(book);
  const meta = db.get('SELECT * FROM metadata WHERE book_id = ?', [book.id]) || {};
  const parse = (s) => { try { return JSON.parse(s || '[]'); } catch { return []; } };
  const p = promptText(type);
  const author = book.author || imp?.author_name || '';
  const chans = imprintChannels(imp);
  const vars = {
    imprint: imp ? imp.name : 'the imprint', author, title: book.title,
    channel: channel || chans.filter((c) => !/email|website/i.test(c.platform)).map((c) => c.platform).join(' / ') || 'social media',
    language: lang, market: lang === 'English' ? 'US/UK' : lang,
  };
  const system = `You are a book marketer for ${vars.imprint}. Voice profile: ${imp ? imp.voice_profile : 'Plain, direct, practical.'} Channel rules: ${chans.map((c) => `${c.platform}: ${c.rules}`).join(' ')} Never invent reviews, awards, sales figures or endorsements. Never use these phrases: ${AVOID_PHRASES.join('; ')}.`;
  const ctxExtra = contextFor(book, type);
  let others = '';
  if (type === 'back_matter') {
    const list = db.query('SELECT title, subtitle FROM books WHERE imprint_id IS ? AND id != ? ORDER BY series, series_no, id', [book.imprint_id || null, book.id]);
    others = list.length ? `\nOther books by ${author}: ${list.map((b) => b.title + (b.subtitle ? ` — ${b.subtitle}` : '')).join('; ')}` : `\nOther books by ${author}: none yet (leave the section as a placeholder).`;
  }
  const prompt = `${mk.fillPrompt(p.text, vars)}${lang !== 'English' ? `\nWrite in natural ${lang} for readers in that market (localize, do not translate word for word).` : ''}

Book: "${book.title}"${book.subtitle ? ` — ${book.subtitle}` : ''}${book.series ? `\nSeries: ${book.series}${book.series_no ? ` #${book.series_no}` : ''}` : ''}
Author: ${author}
Imprint: ${vars.imprint}
Description: ${meta.description || ''}
Back cover: ${book.back_cover || ''}
Author bio: ${book.author_bio || ''}
Keywords: ${parse(meta.keywords).join(', ')}
Categories: ${parse(meta.categories).join(', ')}
Comparable titles: ${parse(meta.comparable_titles).join(', ')}
Audience: ${meta.audience || ''}
Pages: ${book.page_count || ''} · Words: ${book.words || ''}
Channel: ${channel || ''}${others}${ctxExtra ? `\n\n${ctxExtra}` : ''}${extra ? `\n${extra}` : ''}`;
  return ai.completeTask({ task: type, bookId: book.id, system, prompt, maxTokens: ['repurpose_30', 'reader_magnet', 'description_ab'].includes(type) ? 6000 : 3500 });
}

function saveContent(bookId, type, channel, out, lang = 'English') {
  const existing = db.get('SELECT MAX(version) AS v FROM content WHERE book_id = ? AND type = ? AND lang = ?', [bookId, type, lang]);
  return db.exec('INSERT INTO content (book_id, type, channel, lang, text, version, approved, provider) VALUES (?, ?, ?, ?, ?, ?, 0, ?)', [bookId, type, channel || '', lang, out.text, (existing?.v || 0) + 1, out.provider || '']);
}

// ================================================================ HEALTH ==
app.get('/api/health', (req, res) => res.json({ ok: true, app: 'book-marketing-studio', version: VERSION }));

// ================================================================ AUTH ====
app.get('/api/auth/first-run', (req, res) => res.json({ firstRun: db.get('SELECT COUNT(*) AS n FROM accounts').n === 0 }));

app.post('/api/auth/register', loginRateLimit, (req, res) => {
  const { name, email, password } = req.body || {};
  if (!name || !email || !password || String(password).length < 8) return res.status(400).json({ error: 'Name, username (or email) and a password of at least 8 characters are required.' });
  if (db.get('SELECT COUNT(*) AS n FROM accounts').n > 0) return res.status(403).json({ error: 'Accounts are created by the admin in Settings → Family accounts.' });
  const id = db.exec("INSERT INTO accounts (name, email, password_hash, role, status) VALUES (?, ?, ?, 'admin', 'active')", [name, String(email).toLowerCase().trim(), hashPassword(password)]);
  logAct(id, 'account_created', null, 'First account (admin)');
  res.json({ ok: true, id });
});

app.post('/api/auth/login', loginRateLimit, (req, res) => {
  const { email, password, totp } = req.body || {};
  const acc = db.get('SELECT * FROM accounts WHERE email = ?', [String(email || '').toLowerCase().trim()]);
  if (!acc || !verifyPassword(password || '', acc.password_hash)) return res.status(401).json({ error: 'Username or password is wrong.' });
  if (acc.status === 'disabled') return res.status(403).json({ error: 'This account has been disabled.' });
  if (acc.totp_enabled && (!totp || !verifyTotp(acc.totp_secret, totp))) {
    return res.status(401).json({ error: 'Two-step code required or wrong. Enter the 6-digit code from your authenticator app.', needTotp: true });
  }
  const token = randomToken();
  db.exec('INSERT INTO sessions (account_id, token_hash, expires_at) VALUES (?, ?, ?)', [acc.id, sha256(token), new Date(Date.now() + SESSION_DAYS * 86400000).toISOString()]);
  db.exec('DELETE FROM sessions WHERE expires_at < ?', [new Date().toISOString()]);
  setSession(req, res, token);
  logAct(acc.id, 'login', null, '');
  res.json({
    ok: true,
    account: { id: acc.id, name: acc.name, email: acc.email, role: acc.role, isAdmin: acc.role === 'admin', mustChangePassword: !!acc.must_change_password, totpEnabled: !!acc.totp_enabled },
    csrfToken: csrfTokenFor(token),
  });
});

app.post('/api/auth/logout', auth, (req, res) => {
  db.exec('DELETE FROM sessions WHERE token_hash = ?', [sha256(req.sessionToken)]);
  clearSession(req, res);
  res.json({ ok: true });
});

app.get('/api/auth/me', auth, (req, res) => res.json({ account: req.account, csrfToken: csrfTokenFor(req.sessionToken) }));

app.post('/api/auth/change-password', auth, (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  const acc = db.get('SELECT * FROM accounts WHERE id = ?', [req.account.id]);
  if (!acc || !verifyPassword(currentPassword || '', acc.password_hash)) return res.status(401).json({ error: 'Current password is wrong.' });
  if (!newPassword || String(newPassword).length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters.' });
  db.exec('UPDATE accounts SET password_hash = ?, must_change_password = 0 WHERE id = ?', [hashPassword(newPassword), acc.id]);
  db.exec('DELETE FROM sessions WHERE account_id = ? AND token_hash != ?', [acc.id, sha256(req.sessionToken)]);
  logAct(acc.id, 'password_changed', null, '');
  res.json({ ok: true });
});

app.post('/api/auth/totp/setup', auth, (req, res) => {
  const secret = newTotpSecret();
  db.exec('UPDATE accounts SET totp_secret = ? WHERE id = ? AND totp_enabled = 0', [secret, req.account.id]);
  const acc = db.get('SELECT totp_enabled FROM accounts WHERE id = ?', [req.account.id]);
  if (acc.totp_enabled) return res.status(400).json({ error: 'Two-step sign-in is already on. Turn it off first (needs a current code).' });
  res.json({ ok: true, secret, url: totpSetupUrl(secret, req.account.email) });
});

app.post('/api/auth/totp/enable', auth, (req, res) => {
  const acc = db.get('SELECT totp_secret FROM accounts WHERE id = ?', [req.account.id]);
  if (!acc || !acc.totp_secret || !verifyTotp(acc.totp_secret, req.body?.code || '')) {
    return res.status(400).json({ error: 'That code does not match. Scan the setup code again and enter the current 6-digit code.' });
  }
  db.exec('UPDATE accounts SET totp_enabled = 1 WHERE id = ?', [req.account.id]);
  logAct(req.account.id, 'totp_enabled', null, '');
  res.json({ ok: true });
});

// Turning two-step off needs a current code (or the password) — a stolen
// session alone cannot remove it.
app.post('/api/auth/totp/disable', auth, (req, res) => {
  const { code, password } = req.body || {};
  const acc = db.get('SELECT * FROM accounts WHERE id = ?', [req.account.id]);
  const okCode = acc.totp_enabled && verifyTotp(acc.totp_secret, code || '');
  const okPw = password && verifyPassword(password, acc.password_hash);
  if (!okCode && !okPw) return res.status(400).json({ error: 'Enter a current 6-digit code (or your password) to turn two-step sign-in off.' });
  db.exec("UPDATE accounts SET totp_enabled = 0, totp_secret = '' WHERE id = ?", [req.account.id]);
  logAct(req.account.id, 'totp_disabled', null, '');
  res.json({ ok: true });
});

// ======================================================= ADMIN: ACCOUNTS ==
app.get('/api/admin/accounts', auth, requireAdmin, (req, res) => {
  res.json({ accounts: db.query('SELECT id, name, email, role, status, must_change_password, totp_enabled, created_at FROM accounts ORDER BY id') });
});

app.post('/api/admin/accounts', auth, requireAdmin, (req, res) => {
  const { name, email, tempPassword, role } = req.body || {};
  if (!name || !email || !tempPassword || String(tempPassword).length < 8) return res.status(400).json({ error: 'Name, username (or email) and a temporary password of at least 8 characters are required.' });
  const em = String(email).toLowerCase().trim();
  if (db.get('SELECT id FROM accounts WHERE email = ?', [em])) return res.status(400).json({ error: 'An account with that username already exists.' });
  const id = db.exec("INSERT INTO accounts (name, email, password_hash, role, status, must_change_password) VALUES (?, ?, ?, ?, 'active', 1)", [name, em, hashPassword(tempPassword), role === 'admin' ? 'admin' : 'member']);
  logAct(req.account.id, 'account_created', null, `Created ${role || 'member'} account ${em}`);
  res.json({ ok: true, id });
});

app.post('/api/admin/accounts/:id/disable', auth, requireAdmin, (req, res) => {
  const acc = db.get('SELECT * FROM accounts WHERE id = ?', [req.params.id]);
  if (!acc) return res.status(404).json({ error: 'Account not found.' });
  if (acc.id === req.account.id) return res.status(400).json({ error: 'You cannot disable your own account.' });
  db.exec("UPDATE accounts SET status = 'disabled' WHERE id = ?", [acc.id]);
  db.exec('DELETE FROM sessions WHERE account_id = ?', [acc.id]);
  logAct(req.account.id, 'account_disabled', null, `Disabled ${acc.email}`);
  res.json({ ok: true });
});

app.post('/api/admin/accounts/:id/enable', auth, requireAdmin, (req, res) => {
  db.exec("UPDATE accounts SET status = 'active' WHERE id = ?", [req.params.id]);
  logAct(req.account.id, 'account_enabled', null, `Account ${req.params.id}`);
  res.json({ ok: true });
});

app.post('/api/admin/accounts/:id/reset-password', auth, requireAdmin, (req, res) => {
  const { tempPassword } = req.body || {};
  if (!tempPassword || String(tempPassword).length < 8) return res.status(400).json({ error: 'Temporary password must be at least 8 characters.' });
  db.exec('UPDATE accounts SET password_hash = ?, must_change_password = 1 WHERE id = ?', [hashPassword(tempPassword), req.params.id]);
  db.exec('DELETE FROM sessions WHERE account_id = ?', [req.params.id]);
  logAct(req.account.id, 'password_reset', null, `Reset password for account ${req.params.id}`);
  res.json({ ok: true });
});

// =================================================== ADMIN: API VAULT =====
app.get('/api/settings/providers', auth, requireAdmin, (req, res) => {
  res.json({ providers: ai.listProviders(), notConnectable: ai.NOT_CONNECTABLE });
});

// Save a key and/or the card's extra fields. A blank key keeps the saved
// key (so extra fields can be edited without re-pasting); clear:true removes it.
app.post('/api/settings/providers', auth, requireAdmin, (req, res) => {
  const { provider, apiKey, label, extra, clear } = req.body || {};
  try {
    if (!ai.PROVIDERS[provider]) throw new Error('Unknown provider.');
    if (clear) { ai.deleteConnection(provider); logAct(req.account.id, 'provider_cleared', null, provider); return res.json({ ok: true, message: 'Key removed.' }); }
    const has = ai.getConnection(provider);
    if (!apiKey && !has) throw new Error('Paste a key first.');
    ai.saveConnection(provider, apiKey || '', label || '', extra || {}, { keepKey: !apiKey });
    logAct(req.account.id, 'provider_saved', null, provider);
    res.json({ ok: true, message: apiKey ? 'Key saved (encrypted).' : 'Settings saved.' });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.delete('/api/settings/providers/:id', auth, requireAdmin, (req, res) => {
  ai.deleteConnection(req.params.id);
  res.json({ ok: true });
});

app.post('/api/settings/providers/:id/test', auth, requireAdmin, async (req, res) => {
  try { res.json(await ai.testConnection(req.params.id, req.body?.apiKey, req.body?.extra || {})); } catch (e) { res.json({ ok: false, detail: e.message }); }
});

app.get('/api/settings/routes', auth, requireAdmin, (req, res) => {
  const routes = {};
  for (const r of db.query('SELECT * FROM task_routes')) routes[r.task] = r;
  res.json({ routes, tasks: Object.keys(db.DEFAULT_ROUTES), providers: [...ai.TEXT_PROVIDERS, 'deepl'] });
});

app.post('/api/settings/routes', auth, requireAdmin, (req, res) => {
  const { task, provider, fallbackProvider, model, fallbackModel, temperature, maxTokens } = req.body || {};
  if (!task) return res.status(400).json({ error: 'Task is required.' });
  db.exec(
    `INSERT INTO task_routes (task, provider, fallback_provider, model, fallback_model, temperature, max_tokens) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(task) DO UPDATE SET provider = excluded.provider, fallback_provider = excluded.fallback_provider, model = excluded.model,
       fallback_model = excluded.fallback_model, temperature = excluded.temperature, max_tokens = excluded.max_tokens`,
    [task, provider || 'builtin', fallbackProvider || '', model || '', fallbackModel || '', temperature ?? null, maxTokens ?? null]
  );
  res.json({ ok: true });
});

app.get('/api/settings/prompts', auth, requireAdmin, (req, res) => {
  res.json({ prompts: db.query('SELECT * FROM prompts ORDER BY task, id') });
});

app.post('/api/settings/prompts', auth, requireAdmin, (req, res) => {
  const { task, text, notes } = req.body || {};
  if (!task || !text) return res.status(400).json({ error: 'Task and prompt text are required.' });
  const n = db.get('SELECT COUNT(*) AS n FROM prompts WHERE task = ?', [task]).n;
  const version = `1.${n}`;
  const id = db.exec('INSERT INTO prompts (task, version, text, notes) VALUES (?, ?, ?, ?)', [task, version, text, notes || '']);
  res.json({ ok: true, id, version });
});

app.get('/api/settings/budgets', auth, requireAdmin, (req, res) => {
  res.json({ budgets: db.query('SELECT * FROM budgets').map((b) => ({ ...b, ...ai.budgetStatus(b.kind, b.ref) })) });
});

app.post('/api/settings/budgets', auth, requireAdmin, (req, res) => {
  const { kind, ref, limitUsd } = req.body || {};
  if (!['provider', 'book', 'monthly'].includes(kind) || !ref || !(limitUsd > 0)) return res.status(400).json({ error: 'Choose a kind (provider, book or monthly), a reference and a positive limit.' });
  db.exec('INSERT INTO budgets (kind, ref, limit_usd) VALUES (?, ?, ?) ON CONFLICT(kind, ref) DO UPDATE SET limit_usd = excluded.limit_usd', [kind, String(ref), limitUsd]);
  res.json({ ok: true });
});

app.delete('/api/settings/budgets/:id', auth, requireAdmin, (req, res) => {
  db.exec('DELETE FROM budgets WHERE id = ?', [req.params.id]);
  res.json({ ok: true });
});

app.get('/api/settings/usage', auth, requireAdmin, (req, res) => {
  const month = new Date().toISOString().slice(0, 7);
  const byProvider = db.query("SELECT provider, COUNT(*) AS calls, COALESCE(SUM(tokens_in),0) AS tin, COALESCE(SUM(tokens_out),0) AS tout, COALESCE(SUM(cost_usd),0) AS cost FROM usage_log WHERE strftime('%Y-%m', created_at) = ? GROUP BY provider ORDER BY cost DESC", [month]);
  const byBook = db.query('SELECT u.book_id, b.title, COUNT(*) AS calls, COALESCE(SUM(u.cost_usd),0) AS cost FROM usage_log u LEFT JOIN books b ON b.id = u.book_id WHERE u.book_id IS NOT NULL GROUP BY u.book_id ORDER BY cost DESC LIMIT 20');
  const byTask = db.query("SELECT task, COUNT(*) AS calls, COALESCE(SUM(cost_usd),0) AS cost FROM usage_log WHERE strftime('%Y-%m', created_at) = ? GROUP BY task ORDER BY cost DESC", [month]);
  res.json({ byProvider, byBook, byTask, month });
});

// =================================================== ADMIN: SETTINGS =====
const INTEGRATION_KEYS = ['handoff_token', 'publish_url', 'publish_token', 'drive_folder_link', 'n8n_webhook_gate', 'n8n_webhook_handoff', 'n8n_webhook_launch', 'post_webhook_url', 'notify_email', 'public_base_url'];
const SECRET_KEYS = ['handoff_token', 'publish_token'];
const AUTOMATION_KEYS = ['automation_enabled', 'auto_refresh_analysis', 'auto_launch_content', 'auto_post', 'auto_arc_followup', 'auto_competitor_recheck', 'auto_fx_refresh', 'auto_live_check', 'digest_hour_utc', 'double_opt_in', 'auto_locales'];

app.get('/api/admin/settings', auth, requireAdmin, (req, res) => {
  const out = {};
  for (const k of INTEGRATION_KEYS) out[k] = SECRET_KEYS.includes(k) ? '' : getSetting(k);
  out.handoff_token_set = !!getSetting('handoff_token') || !!process.env.HANDOFF_TOKEN;
  out.publish_token_set = !!getSetting('publish_token');
  out.handoff_url = `${publicBase(req)}/api/handoff`;
  const automation = {};
  for (const k of AUTOMATION_KEYS) automation[k] = getSetting(k);
  res.json({ settings: out, automation });
});

app.post('/api/admin/settings', auth, requireAdmin, (req, res) => {
  const b = req.body || {};
  for (const k of [...INTEGRATION_KEYS, ...AUTOMATION_KEYS]) {
    if (b[k] === undefined) continue;
    if (SECRET_KEYS.includes(k) && !b[k]) continue; // blank keeps the saved secret
    setSetting(k, String(b[k]).trim());
  }
  logAct(req.account.id, 'settings_saved', null, Object.keys(b).join(', '));
  res.json({ ok: true });
});

// =================================================== IMPRINTS ============
app.get('/api/imprints', auth, (req, res) => {
  const imps = db.query('SELECT * FROM imprints ORDER BY id');
  for (const imp of imps) {
    imp.channels = imprintChannels(imp);
    imp.profiles = db.query('SELECT * FROM profiles WHERE imprint_id = ? ORDER BY id', [imp.id]);
    try { imp.socials = JSON.parse(imp.socials || '{}'); } catch { imp.socials = {}; }
  }
  res.json({ imprints: imps });
});

app.post('/api/imprints', auth, requireAdmin, (req, res) => {
  const { name, authorName, publisherName, isbnBlock, voiceProfile, website, socials, emailList, brandAssets } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Imprint name is required.' });
  const id = db.exec('INSERT INTO imprints (name, author_name, publisher_name, isbn_block, voice_profile, website, socials, email_list, brand_assets) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [name, authorName || '', publisherName || '', isbnBlock || '', voiceProfile || '', website || '', JSON.stringify(socials || {}), emailList || '', brandAssets || '']);
  for (const p of require('./lib/platforms').PROFILE_COMMON) db.exec('INSERT OR IGNORE INTO profiles (imprint_id, platform) VALUES (?, ?)', [id, p]);
  res.json({ ok: true, id });
});

app.put('/api/imprints/:id', auth, requireAdmin, (req, res) => {
  const cur = db.get('SELECT * FROM imprints WHERE id = ?', [req.params.id]);
  if (!cur) return res.status(404).json({ error: 'Imprint not found.' });
  const b = req.body || {};
  db.exec('UPDATE imprints SET author_name = ?, publisher_name = ?, isbn_block = ?, voice_profile = ?, website = ?, socials = ?, email_list = ?, brand_assets = ? WHERE id = ?', [
    b.authorName ?? cur.author_name, b.publisherName ?? cur.publisher_name, b.isbnBlock ?? cur.isbn_block, b.voiceProfile ?? cur.voice_profile,
    b.website ?? cur.website, b.socials ? JSON.stringify(b.socials) : cur.socials, b.emailList ?? cur.email_list, b.brandAssets ?? cur.brand_assets, cur.id,
  ]);
  res.json({ ok: true });
});

// Author platform checklist (Author Central per marketplace, BookBub, Goodreads …)
app.put('/api/profiles/:id', auth, (req, res) => {
  const { url, status, notes } = req.body || {};
  db.exec('UPDATE profiles SET url = COALESCE(?, url), status = COALESCE(?, status), notes = COALESCE(?, notes) WHERE id = ?', [url ?? null, status ?? null, notes ?? null, req.params.id]);
  res.json({ ok: true });
});

app.get('/api/activity', auth, requireAdmin, (req, res) => {
  res.json({ activity: db.query('SELECT a.*, acc.name AS account_name FROM activity_log a LEFT JOIN accounts acc ON acc.id = a.account_id ORDER BY a.id DESC LIMIT 200') });
});

// =================================================== HANDOFF ===
// The source app POSTs { bookId, metadata, packageBase64 } with
// Authorization: Bearer <HANDOFF_TOKEN>. Returns { marketingBookId }.
// Idempotent: a repeat handoff for the same source book updates it.
app.post('/api/handoff', async (req, res) => {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const expected = getSetting('handoff_token') || process.env.HANDOFF_TOKEN || '';
  if (!expected || !token || !timingSafeEqualStr(token, expected)) {
    return res.status(401).json({ error: 'Bad handoff token. Use the same token on the sending side and here in Settings → Integrations.' });
  }
  const { bookId: publishBookId, metadata: m = {}, packageBase64 = '' } = req.body || {};
  if (!m.title) return res.status(400).json({ error: 'Handoff package is missing metadata.title.' });
  const imprint = m.imprint ? db.get('SELECT id FROM imprints WHERE name = ?', [m.imprint]) : null;
  const existing = publishBookId ? db.get('SELECT * FROM books WHERE publish_book_id = ?', [publishBookId]) : null;
  const fields = {
    title: m.title, subtitle: m.subtitle ?? existing?.subtitle ?? '', imprint_id: imprint ? imprint.id : existing?.imprint_id ?? null,
    author: m.author ?? existing?.author ?? '', back_cover: m.backCover ?? existing?.back_cover ?? '', author_bio: m.authorBio ?? existing?.author_bio ?? '',
    trim: m.trim ?? existing?.trim ?? '', page_count: m.pageCount ?? existing?.page_count ?? 0, words: m.words ?? existing?.words ?? 0,
    production_cost_usd: m.productionCostUsd ?? existing?.production_cost_usd ?? 0, ai_use_notes: m.aiUseNotes ?? existing?.ai_use_notes ?? '',
    drive_folder: m.driveFolder ?? existing?.drive_folder ?? '', series: m.series ?? existing?.series ?? '', language: m.language ?? existing?.language ?? 'English',
  };
  let bookId;
  if (existing) {
    bookId = existing.id;
    db.exec(`UPDATE books SET ${Object.keys(fields).map((k) => `${k} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`, [...Object.values(fields), bookId]);
  } else {
    bookId = db.exec(`INSERT INTO books (publish_book_id, source, current_stage, ${Object.keys(fields).join(', ')}) VALUES (?, 'publish', 1, ${Object.keys(fields).map(() => '?').join(', ')})`, [publishBookId || null, ...Object.values(fields)]);
    createStages(bookId, true, 'Final copy received by handoff.');
    db.exec('UPDATE books SET slug = ? WHERE id = ?', [uniqueSlug(m.title, bookId), bookId]);
  }
  // Metadata sheet from the handoff (pre-filled, nothing retyped). Only
  // fields actually sent overwrite what is there.
  const cur = db.get('SELECT * FROM metadata WHERE book_id = ?', [bookId]);
  db.exec('INSERT INTO metadata (book_id, description, keywords, categories, comparable_titles, audience) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(book_id) DO UPDATE SET description = excluded.description, keywords = excluded.keywords, categories = excluded.categories, comparable_titles = excluded.comparable_titles, audience = excluded.audience', [
    bookId, m.description ?? cur?.description ?? '', m.keywords ? JSON.stringify(m.keywords) : cur?.keywords ?? '[]',
    m.categories ? JSON.stringify(m.categories) : cur?.categories ?? '[]', m.comparableTitles ? JSON.stringify(m.comparableTitles) : cur?.comparable_titles ?? '[]', m.audience ?? cur?.audience ?? '',
  ]);
  let packagePath = '', unpacked = null;
  if (packageBase64) {
    try {
      const buf = Buffer.from(packageBase64, 'base64');
      packagePath = manuscript.saveFile(bookId, 'handoff-package', `handoff-${Date.now()}.zip`, buf, 'Handoff package').path;
      unpacked = await manuscript.unpackHandoff(bookId, buf);
    } catch (e) { unpacked = { error: e.message }; }
  }
  const note = unpacked ? (unpacked.error ? unpacked.error : `Unpacked: manuscript ${unpacked.manuscript ? `(${unpacked.chapters} chapters)` : 'missing'}, cover ${unpacked.cover ? 'yes' : 'missing'}.`) : 'No package attached.';
  db.exec('INSERT INTO handoffs (publish_book_id, book_id, status, package_path, note) VALUES (?, ?, ?, ?, ?)', [publishBookId || null, bookId, 'received', packagePath, note]);
  logAct(null, 'handoff_received', bookId, `From source book ${publishBookId || '?'} — ${note}`);
  const pen = imprint ? require('./lib/platforms').PEN_NAMES[m.imprint] : '';
  if (pen && m.author && m.author !== pen) scheduler.notify('publishing', `Author name check: ${m.title}`, `The handoff gave the author as “${m.author}”, but ${m.imprint} books are published as “${pen}”. Nothing crosses between the lines — fix it on the book’s Overview tab if this is a mistake.`, bookId);
  if (pen && !m.author) db.exec("UPDATE books SET author = ? WHERE id = ? AND (author = '' OR author IS NULL)", [pen, bookId]);
  scheduler.notify('handoff', `New book received: ${m.title}`, note, bookId);
  fireWebhook('n8n_webhook_handoff', { bookId, title: m.title, event: 'handoff_received' });
  res.json({ ok: true, marketingBookId: bookId, unpacked });
});

app.get('/api/handoffs', auth, requireAdmin, (req, res) => {
  res.json({ handoffs: db.query('SELECT h.*, b.title FROM handoffs h LEFT JOIN books b ON b.id = h.book_id ORDER BY h.id DESC LIMIT 100') });
});

// =================================================== BOOKS ==============
function bookSummary(b) {
  const done = db.get("SELECT COUNT(*) AS n FROM stages WHERE book_id = ? AND status IN ('done','skipped')", [b.id]).n;
  const imp = b.imprint_id ? db.get('SELECT name FROM imprints WHERE id = ?', [b.imprint_id]) : null;
  return { ...b, imprintName: imp ? imp.name : '', stagesDone: done, stagesTotal: 11, margin: mk.bookMargin(b.id), hasCover: !!b.cover_path };
}

app.get('/api/books', auth, (req, res) => {
  const { imprint, stage } = req.query;
  let books = db.query('SELECT * FROM books ORDER BY updated_at DESC');
  if (imprint) books = books.filter((b) => String(b.imprint_id) === String(imprint));
  if (stage) books = books.filter((b) => b.current_stage === parseInt(stage, 10));
  res.json({ books: books.map(bookSummary), stages: mk.STAGES });
});

function insertBook(b, source, firstDone, note) {
  const id = db.exec('INSERT INTO books (title, subtitle, series, series_no, imprint_id, author, production_cost_usd, ai_use_notes, drive_folder, language, source, current_stage) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)', [
    b.title, b.subtitle || '', b.series || '', b.seriesNo || null, b.imprintId || null, b.author || '', b.productionCostUsd || 0, b.aiUseNotes || '', b.driveFolder || '', b.language || 'English', source,
  ]);
  createStages(id, firstDone, note);
  db.exec('INSERT OR IGNORE INTO metadata (book_id) VALUES (?)', [id]);
  db.exec('UPDATE books SET slug = ? WHERE id = ?', [uniqueSlug(b.title, id), id]);
  return id;
}

app.post('/api/books', auth, (req, res) => {
  if (!req.body?.title) return res.status(400).json({ error: 'Title is required.' });
  const id = insertBook(req.body, 'manual', false, '');
  logAct(req.account.id, 'book_created', id, `Manual book: ${req.body.title}`);
  res.json({ ok: true, id });
});

// Manual import: files plus form, for books made elsewhere. Files arrive
// as base64; a .txt/.md manuscript is split into chapters automatically.
app.post('/api/books/import', auth, async (req, res) => {
  const { files = [] } = req.body || {};
  if (!req.body?.title) return res.status(400).json({ error: 'Title is required.' });
  const id = insertBook(req.body, 'manual', true, 'Final copy uploaded by hand.');
  let chapters = 0;
  for (const f of files) {
    if (!f.name || !f.base64) continue;
    const buf = Buffer.from(f.base64, 'base64');
    const saved = manuscript.saveFile(id, f.type || 'manuscript', f.name, buf, 'Manual import');
    if ((f.type || 'manuscript') === 'manuscript' && /\.(txt|md|markdown)$/i.test(f.name)) chapters = manuscript.storeChapters(id, buf.toString('utf8'));
    if (f.type === 'cover') db.exec('UPDATE books SET cover_path = ? WHERE id = ?', [saved.path, id]);
    if (/\.zip$/i.test(f.name)) { const u = await manuscript.unpackHandoff(id, buf); chapters = u.chapters || chapters; }
  }
  logAct(req.account.id, 'book_imported', id, `Manual import: ${req.body.title} (${files.length} files, ${chapters} chapters)`);
  res.json({ ok: true, id, chapters });
});

app.get('/api/books/:id', auth, (req, res) => {
  const book = bookOr404(req, res);
  if (!book) return;
  const stages = db.query('SELECT * FROM stages WHERE book_id = ? ORDER BY stage_no', [book.id]);
  for (const s of stages) { try { s.payload = JSON.parse(s.payload || '{}'); } catch { s.payload = {}; } s.name = (mk.STAGES.find((x) => x[0] === s.stage_no) || [])[1]; s.kind = (mk.STAGES.find((x) => x[0] === s.stage_no) || [])[2]; }
  const editions = db.query('SELECT * FROM editions WHERE book_id = ? ORDER BY id', [book.id]);
  for (const e of editions) e.listings = db.query('SELECT * FROM listings WHERE edition_id = ? ORDER BY id', [e.id]);
  res.json({
    book: bookSummary(book),
    stages,
    metadata: db.get('SELECT * FROM metadata WHERE book_id = ?', [book.id]) || {},
    editions,
    campaigns: db.query('SELECT * FROM campaigns WHERE book_id = ? ORDER BY id DESC', [book.id]),
    tasks: db.query('SELECT * FROM tasks WHERE book_id = ? ORDER BY done, due_date, id', [book.id]),
    content: db.query('SELECT * FROM content WHERE book_id = ? ORDER BY id DESC', [book.id]),
    reviews: db.query('SELECT * FROM reviews WHERE book_id = ? ORDER BY date DESC, id DESC', [book.id]),
    endorsements: db.query('SELECT e.*, c.name AS contact_name FROM endorsements e LEFT JOIN contacts c ON c.id = e.contact_id WHERE e.book_id = ? ORDER BY e.id DESC', [book.id]),
    promotions: db.query('SELECT * FROM promotions WHERE book_id = ? ORDER BY id DESC', [book.id]),
    ads: db.query('SELECT * FROM ads WHERE book_id = ? ORDER BY id DESC', [book.id]),
    consignments: db.query('SELECT * FROM consignments WHERE book_id = ? ORDER BY id DESC', [book.id]),
    library: db.query('SELECT * FROM library_status WHERE book_id = ?', [book.id]),
    sales: db.query('SELECT * FROM sales WHERE book_id = ? ORDER BY period DESC LIMIT 200', [book.id]),
    ranks: db.query('SELECT * FROM rank_history WHERE book_id = ? ORDER BY recorded_at DESC LIMIT 100', [book.id]),
    milestones: db.query('SELECT * FROM milestones WHERE book_id = ? ORDER BY date DESC', [book.id]),
    competitors: db.query('SELECT * FROM competitors WHERE book_id = ? ORDER BY id DESC', [book.id]),
    priceTests: db.query('SELECT * FROM price_tests WHERE book_id = ? ORDER BY id DESC', [book.id]),
    refreshCycles: db.query('SELECT * FROM refresh_cycles WHERE book_id = ? ORDER BY due_date', [book.id]),
    recommendations: db.query('SELECT * FROM recommendations WHERE book_id = ? ORDER BY id DESC', [book.id]),
    refreshLog: db.query('SELECT * FROM refresh_log WHERE book_id = ? ORDER BY id DESC LIMIT 50', [book.id]),
    lessons: db.query('SELECT * FROM lessons WHERE book_id = ? ORDER BY id DESC', [book.id]),
    files: db.query('SELECT id, type, version, path, licence_note, created_at FROM files WHERE book_id = ? ORDER BY id DESC', [book.id]).map((f) => ({ ...f, name: path.basename(f.path || '') })),
    chapters: db.query('SELECT id, no, title, words FROM chapters WHERE book_id = ? ORDER BY no', [book.id]),
    gates: db.query('SELECT g.*, a.name AS decided_by_name FROM gates g LEFT JOIN accounts a ON a.id = g.decided_by WHERE book_id = ? ORDER BY id DESC', [book.id]),
    activity: db.query('SELECT a.*, acc.name AS account_name FROM activity_log a LEFT JOIN accounts acc ON acc.id = a.account_id WHERE a.book_id = ? ORDER BY a.id DESC LIMIT 50', [book.id]),
    margin: mk.bookMargin(book.id),
    kdpPlanner: mk.kdpPlanner(),
    channels: imprintChannels(imprintOf(book)),
    smartLink: book.slug ? `${publicBase(req)}/b/${book.slug}` : '',
    bookPage: book.slug ? `${publicBase(req)}/p/${book.slug}` : '',
    contentTypes: ALL_CONTENT_TYPES,
    kitTypes: kitTypesFor(imprintOf(book)),
  });
});

app.put('/api/books/:id', auth, (req, res) => {
  const book = bookOr404(req, res);
  if (!book) return;
  const b = req.body || {};
  const map = { title: 'title', subtitle: 'subtitle', series: 'series', seriesNo: 'series_no', imprintId: 'imprint_id', author: 'author', backCover: 'back_cover', authorBio: 'author_bio', trim: 'trim', pageCount: 'page_count', productionCostUsd: 'production_cost_usd', aiUseNotes: 'ai_use_notes', driveFolder: 'drive_folder', launchDate: 'launch_date', language: 'language', landingEnabled: 'landing_enabled' };
  const sets = [], vals = [];
  for (const [k, col] of Object.entries(map)) if (b[k] !== undefined) { sets.push(`${col} = ?`); vals.push(k === 'landingEnabled' ? (b[k] ? 1 : 0) : b[k]); }
  if (b.slug !== undefined) {
    const s = mk.slugify(b.slug);
    if (db.get('SELECT id FROM books WHERE slug = ? AND id != ?', [s, book.id])) return res.status(400).json({ error: 'That link name is taken by another book.' });
    sets.push('slug = ?'); vals.push(s);
  }
  if (sets.length) db.exec(`UPDATE books SET ${sets.join(', ')}, updated_at = datetime('now') WHERE id = ?`, [...vals, book.id]);
  logAct(req.account.id, 'book_updated', book.id, b.title || book.title);
  res.json({ ok: true });
});

app.delete('/api/books/:id', auth, requireAdmin, (req, res) => {
  const book = bookOr404(req, res);
  if (!book) return;
  db.exec('DELETE FROM books WHERE id = ?', [book.id]);
  logAct(req.account.id, 'book_deleted', book.id, book.title);
  res.json({ ok: true });
});

// Book files (manuscript, cover, audio) — download for signed-in users.
app.get('/api/files/:id/download', auth, (req, res) => {
  const f = db.get('SELECT * FROM files WHERE id = ?', [req.params.id]);
  if (!f || !f.path || !fs.existsSync(f.path)) return res.status(404).json({ error: 'File not found.' });
  res.download(f.path, path.basename(f.path));
});

// ---- Stages + gates ----
app.post('/api/books/:id/stage/:n/gate', auth, (req, res) => {
  const book = bookOr404(req, res);
  if (!book) return;
  const n = parseInt(req.params.n, 10);
  if (!(n >= 1 && n <= 11)) return res.status(400).json({ error: 'Stage must be 1–11.' });
  const { decision, reasonCode, note } = req.body || {};
  if (!['approve', 'send_back'].includes(decision)) return res.status(400).json({ error: 'Decision must be approve or send_back.' });
  if (decision === 'send_back' && !reasonCode) return res.status(400).json({ error: 'A send-back needs a reason code (for the Kaizen dashboard).' });
  if (decision === 'approve') {
    const blocked = mk.stageGateCheck(book.id, n);
    if (blocked) return res.status(400).json({ error: blocked });
  }
  const stage = db.get('SELECT * FROM stages WHERE book_id = ? AND stage_no = ?', [book.id, n]);
  const payload = stage ? JSON.parse(stage.payload || '{}') : {};
  db.exec('INSERT INTO gates (book_id, stage_no, decision, reason_code, note, decided_by) VALUES (?, ?, ?, ?, ?, ?)', [book.id, n, decision, reasonCode || '', note || '', req.account.id]);
  if (decision === 'approve') {
    setStage(book.id, n, 'done', { ...payload, gate: { decision, note: note || '' } });
    if (n === 7) {
      const launchDate = book.launch_date || mk.today();
      mk.scheduleRefreshCycles(book.id, launchDate);
      fireWebhook('n8n_webhook_launch', { bookId: book.id, title: book.title, launchDate, event: 'launched' });
    }
    logAct(req.account.id, 'gate_approve', book.id, `Stage ${n} approved`);
    fireWebhook('n8n_webhook_gate', { bookId: book.id, stage: n, decision: 'approve' });
  } else {
    setStage(book.id, n, 'active', { ...payload, gate: { decision, reasonCode, note: note || '' } });
    db.exec('INSERT INTO lessons (book_id, lesson_code, text) VALUES (?, ?, ?)', [book.id, reasonCode, `Stage ${n} sent back${note ? ': ' + note : ''}`]);
    logAct(req.account.id, 'gate_send_back', book.id, `Stage ${n} sent back: ${reasonCode}`);
  }
  res.json({ ok: true });
});

app.post('/api/books/:id/stage/:n/skip', auth, (req, res) => {
  const book = bookOr404(req, res);
  if (!book) return;
  const n = parseInt(req.params.n, 10);
  setStage(book.id, n, 'skipped', { skippedBy: req.account.name });
  logAct(req.account.id, 'stage_skip', book.id, `Stage ${n} skipped`);
  res.json({ ok: true });
});

// ---- Metadata sheet ----
app.put('/api/books/:id/metadata', auth, (req, res) => {
  const book = bookOr404(req, res);
  if (!book) return;
  const b = req.body || {};
  const kw = (b.keywords || []).map((k) => String(k).trim()).filter(Boolean);
  const warnings = [];
  if (kw.length > 7) warnings.push(`KDP takes 7 keyword boxes — you have ${kw.length}.`);
  if (kw.some((k) => k.length > 50)) warnings.push('A KDP keyword box holds 50 characters — one or more are longer.');
  if ((b.description || '').length > 4000) warnings.push(`Description is ${(b.description || '').length} characters — KDP allows 4,000.`);
  db.exec(`INSERT INTO metadata (book_id, description, keywords, categories, comparable_titles, audience) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(book_id) DO UPDATE SET description = excluded.description, keywords = excluded.keywords, categories = excluded.categories, comparable_titles = excluded.comparable_titles, audience = excluded.audience`,
  [book.id, b.description || '', JSON.stringify(kw), JSON.stringify(b.categories || []), JSON.stringify(b.comparableTitles || []), b.audience || '']);
  logAct(req.account.id, 'metadata_saved', book.id, '');
  res.json({ ok: true, warnings });
});

// ---- Editions + store/format matrix ----
app.post('/api/books/:id/editions', auth, (req, res) => {
  const book = bookOr404(req, res);
  if (!book) return;
  const { format, language, isbn, trim, price, printCost, fileSizeMb } = req.body || {};
  if (!format) return res.status(400).json({ error: 'Format is required.' });
  const id = db.exec('INSERT INTO editions (book_id, format, language, isbn, trim, price, print_cost, file_size_mb) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [book.id, format, language || book.language || 'English', isbn || '', trim || '', price ?? null, printCost ?? null, fileSizeMb ?? null]);
  res.json({ ok: true, id });
});

app.put('/api/editions/:id', auth, (req, res) => {
  const e = db.get('SELECT * FROM editions WHERE id = ?', [req.params.id]);
  if (!e) return res.status(404).json({ error: 'Edition not found.' });
  const b = req.body || {};
  db.exec('UPDATE editions SET format = ?, language = ?, isbn = ?, trim = ?, price = ?, print_cost = ?, file_size_mb = ?, status = ? WHERE id = ?', [
    b.format ?? e.format, b.language ?? e.language, b.isbn ?? e.isbn, b.trim ?? e.trim, b.price !== undefined ? b.price : e.price,
    b.printCost !== undefined ? b.printCost : e.print_cost, b.fileSizeMb !== undefined ? b.fileSizeMb : e.file_size_mb, b.status ?? e.status, e.id,
  ]);
  res.json({ ok: true });
});

app.delete('/api/editions/:id', auth, (req, res) => {
  db.exec('DELETE FROM editions WHERE id = ?', [req.params.id]);
  res.json({ ok: true });
});

// Listings, the store matrix and the publishing tracker live in routes/rollout.js.

// ---- Compliance + KDP planner ----
app.get('/api/kdp/planner', auth, (req, res) => {
  res.json({ planner: mk.kdpPlanner(), note: 'Verified rule (KDP help page G202172740, 2026-11-16): 2 NEW titles per book format per week — ebook, paperback and hardcover counted separately. Drafts count. Resets Sunday 00:00 UTC (Saturday 5pm Calgary).' });
});

app.get('/api/books/:id/compliance', auth, (req, res) => {
  const book = bookOr404(req, res);
  if (!book) return;
  const editions = db.query('SELECT * FROM editions WHERE book_id = ?', [book.id]);
  const meta = db.get('SELECT * FROM metadata WHERE book_id = ?', [book.id]) || {};
  const checks = [];
  let kw = []; try { kw = JSON.parse(meta.keywords || '[]'); } catch { /* ignore */ }
  checks.push({ ok: !!meta.description && meta.description.length <= 4000, label: 'Description present and within 4,000 characters' });
  checks.push({ ok: kw.length > 0 && kw.length <= 7 && kw.every((k) => k.length <= 50), label: 'Keywords: up to 7 boxes, 50 characters each' });
  checks.push({ ok: !!book.ai_use_notes, label: 'AI-use notes recorded (KDP asks about AI-generated content at upload)' });
  const imp = imprintOf(book);
  const pen = require('./lib/platforms').PEN_NAMES[imp?.name] || imp?.author_name || '';
  if (pen) checks.push({ ok: (book.author || pen) === pen, label: `Author name is the ${imp.name} pen name “${pen}”${book.author && book.author !== pen ? ` (this book says “${book.author}”)` : ''}` });
  for (const e of editions) if (['paperback', 'hardcover', 'large print'].includes(e.format)) checks.push({ ok: !!e.isbn, label: `${e.format}: own ISBN recorded (ISBN Canada puts the imprint on the listing; KDP's free ISBN shows "Independently published")` });
  const listings = [];
  for (const e of editions) listings.push({ edition: e, listings: db.query('SELECT * FROM listings WHERE edition_id = ?', [e.id]) });
  for (const x of listings) for (const l of x.listings) if (!l.ai_disclosure && l.store === 'KDP') checks.push({ ok: false, label: `KDP ${x.edition.format}: AI-disclosure answer not recorded` });
  res.json({ compliance: listings, checks, kdpPlanner: mk.kdpPlanner() });
});

// ---- Launch planner ----
app.post('/api/books/:id/launch', auth, (req, res) => {
  const book = bookOr404(req, res);
  if (!book) return;
  const { launchDate } = req.body || {};
  if (!/^\d{4}-\d{2}-\d{2}$/.test(launchDate || '')) return res.status(400).json({ error: 'Launch date is required (YYYY-MM-DD).' });
  const imp = imprintOf(book);
  const result = mk.generateLaunchTasks(book.id, launchDate, imp ? imp.name : 'North American Manufacturing Press');
  db.exec('UPDATE books SET launch_date = ? WHERE id = ?', [launchDate, book.id]);
  mk.scheduleRefreshCycles(book.id, launchDate);
  // Launch automation: content kit two weeks out, posts scheduled one week
  // out (from APPROVED content only), localized metadata five weeks out.
  const automated = [];
  if (getSetting('automation_enabled', '1') === '1' && getSetting('auto_launch_content', '1') === '1') {
    const at = (offset) => { const d = mk.addDays(launchDate, offset); return d <= mk.today() ? '' : `${d} 08:00:00`; };
    automated.push({ kind: 'content_batch', id: jobs.queueOnce(book.id, 'content_batch', { types: kitTypesFor(imp), reason: 'launch' }, at(-14)), when: at(-14) || 'now' });
    automated.push({ kind: 'launch_schedule_posts', id: jobs.queueOnce(book.id, 'launch_schedule_posts', { launchDate }, at(-7)), when: at(-7) || 'now' });
    const locales = getSetting('auto_locales').split(',').map((s) => s.trim()).filter(Boolean);
    if (locales.length) automated.push({ kind: 'localize_metadata', id: jobs.queueOnce(book.id, 'localize_metadata', { languages: locales }, at(-35)), when: at(-35) || 'now' });
  }
  logAct(req.account.id, 'launch_planned', book.id, `Launch ${launchDate} — ${result.made.length} tasks, ${automated.length} automated jobs`);
  res.json({ ok: true, ...result, automated });
});

app.post('/api/tasks/:id/done', auth, (req, res) => {
  db.exec('UPDATE tasks SET done = ? WHERE id = ?', [req.body?.done ? 1 : 0, req.params.id]);
  res.json({ ok: true });
});

app.post('/api/tasks', auth, (req, res) => {
  const { bookId, campaignId, title, owner, dueDate, reminder } = req.body || {};
  if (!bookId || !title) return res.status(400).json({ error: 'Book and title are required.' });
  const id = db.exec('INSERT INTO tasks (campaign_id, book_id, title, owner, due_date, reminder, done) VALUES (?, ?, ?, ?, ?, ?, 0)', [campaignId || null, bookId, title, owner || '', dueDate || '', reminder || '']);
  res.json({ ok: true, id });
});

app.put('/api/tasks/:id', auth, (req, res) => {
  const t = db.get('SELECT * FROM tasks WHERE id = ?', [req.params.id]);
  if (!t) return res.status(404).json({ error: 'Task not found.' });
  const b = req.body || {};
  db.exec('UPDATE tasks SET title = ?, owner = ?, due_date = ? WHERE id = ?', [b.title ?? t.title, b.owner ?? t.owner, b.dueDate ?? t.due_date, t.id]);
  res.json({ ok: true });
});

app.delete('/api/tasks/:id', auth, (req, res) => {
  db.exec('DELETE FROM tasks WHERE id = ?', [req.params.id]);
  res.json({ ok: true });
});

// =================================================== CONTENT STUDIO =====
// Every piece is reviewed and approved before use; versions are kept.
// Content is only offered on the imprint's own channels.
function channelAllowed(imp, channel) {
  if (!channel) return true;
  const allowed = imprintChannels(imp).map((c) => c.platform.toLowerCase());
  if (!allowed.length) return true;
  const ch = channel.toLowerCase();
  return allowed.some((a) => ch.includes(a) || a.includes(ch));
}

app.post('/api/books/:id/content/generate', auth, async (req, res) => {
  const book = bookOr404(req, res);
  if (!book) return;
  const imp = imprintOf(book);
  const { channel = '', lang = 'English', extra = '' } = req.body || {};
  const types = (req.body?.types && req.body.types.length ? req.body.types : kitTypesFor(imp)).filter((t) => ALL_CONTENT_TYPES.includes(t));
  if (!types.length) return res.status(400).json({ error: 'Pick at least one content type.' });
  if (!channelAllowed(imp, channel)) return res.status(400).json({ error: `Channel "${channel}" is not one of ${imp.name}'s channels — content is never offered on the other imprint's accounts.` });
  if (types.includes('linkedin') && !channelAllowed(imp, 'LinkedIn')) return res.status(400).json({ error: `${imp.name} has no LinkedIn channel — LinkedIn articles are only for imprints that own one.` });
  if (types.length > 3) {
    const jobId = jobs.queue(book.id, 'content_batch', { types, channel, lang });
    return res.json({ ok: true, queued: true, jobId, made: [], note: `${types.length} pieces queued — they appear here within a few minutes.` });
  }
  const made = [];
  for (const type of types) {
    const out = await generateContentFor(book, type, channel, { lang, extra });
    made.push({ id: saveContent(book.id, type, channel, out, lang), type, provider: out.provider, local: out.local, note: out.note || '' });
  }
  logAct(req.account.id, 'content_generated', book.id, types.join(', '));
  res.json({ ok: true, made });
});

app.post('/api/books/:id/content/batch', auth, (req, res) => {
  const book = bookOr404(req, res);
  if (!book) return;
  const { types, channel, lang } = req.body || {};
  const jobId = jobs.queue(book.id, 'content_batch', { types: types && types.length ? types : kitTypesFor(imprintOf(book)), channel: channel || '', lang: lang || 'English' });
  res.json({ ok: true, jobId, note: 'Queued — the pieces appear in the Content tab when done.' });
});

app.get('/api/books/:id/content', auth, (req, res) => {
  const book = bookOr404(req, res);
  if (!book) return;
  res.json({ content: db.query('SELECT * FROM content WHERE book_id = ? ORDER BY id DESC', [book.id]) });
});

app.post('/api/content/:id/approve', auth, (req, res) => {
  const c = db.get('SELECT * FROM content WHERE id = ?', [req.params.id]);
  if (!c) return res.status(404).json({ error: 'Content not found.' });
  if (/^\[LOCAL DRAFT/.test(c.text)) return res.status(400).json({ error: 'This is a local placeholder draft, not real copy — edit it (or connect an AI key and regenerate) before approving.' });
  db.exec('UPDATE content SET approved = 1 WHERE id = ?', [c.id]);
  logAct(req.account.id, 'content_approved', c.book_id, `${c.type} v${c.version}`);
  res.json({ ok: true });
});

app.post('/api/content/:id/unapprove', auth, (req, res) => {
  db.exec('UPDATE content SET approved = 0 WHERE id = ?', [req.params.id]);
  res.json({ ok: true });
});

app.put('/api/content/:id', auth, (req, res) => {
  const row = db.get('SELECT * FROM content WHERE id = ?', [req.params.id]);
  if (!row) return res.status(404).json({ error: 'Content not found.' });
  const max = db.get('SELECT MAX(version) AS v FROM content WHERE book_id = ? AND type = ? AND lang = ?', [row.book_id, row.type, row.lang || 'English']).v || row.version;
  const id = db.exec('INSERT INTO content (book_id, campaign_id, type, channel, lang, text, version, approved, provider) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)', [row.book_id, row.campaign_id, row.type, row.channel, row.lang || 'English', req.body?.text || row.text, max + 1, 'edited']);
  res.json({ ok: true, id });
});

app.delete('/api/content/:id', auth, (req, res) => {
  db.exec('DELETE FROM content WHERE id = ?', [req.params.id]);
  res.json({ ok: true });
});

// Social image (Ideogram/OpenAI when a key is saved, else the typographic template).
app.post('/api/books/:id/social-image', auth, async (req, res) => {
  const book = bookOr404(req, res);
  if (!book) return;
  const { size = '1200x628', prompt, useAi = true } = req.body || {};
  const imp = imprintOf(book);
  const aspect = size === '1080x1080' ? '1x1' : size === '1080x1920' ? '9x16' : '16x9';
  if (useAi) {
    try {
      const img = await ai.generateImage(prompt || `Book promotion banner for "${book.title}" by ${book.author || imp?.author_name || ''}. ${imp?.brand_assets || ''} Large readable title text, no other text.`, { aspect });
      if (img.url || img.b64) return res.json({ ok: true, url: img.url || '', b64: img.b64 || '', provider: img.provider });
    } catch (e) { /* fall through to the template */ }
  }
  const lamp = imp && imp.name.includes('Lamp');
  const svg = mk.socialImageSvg({ title: book.title, author: book.author || imp?.author_name || '', imprint: imp ? imp.name : '', size, bg: lamp ? '#1f3864' : '#1d4d2b', accent: lamp ? '#e8dcc0' : '#d4a017' });
  res.json({ ok: true, svg, provider: 'template', note: 'Typographic template — add an Ideogram or OpenAI key in Settings for AI-generated banners.' });
});

// =================================================== CONTACTS ===========
const CONTACT_TYPES = ['reader', 'arc', 'endorser', 'media', 'podcast', 'library', 'bookstore', 'agent', 'publisher'];

app.get('/api/contacts', auth, (req, res) => {
  const { type, q } = req.query;
  let rows = db.query('SELECT id, name, email, type, consent, consent_date, status, imprint_id, outlet, country, language, tags, source, history, created_at FROM contacts ORDER BY name');
  if (type) rows = rows.filter((r) => r.type === type);
  if (q) { const s = String(q).toLowerCase(); rows = rows.filter((r) => `${r.name} ${r.email} ${r.outlet} ${r.tags}`.toLowerCase().includes(s)); }
  res.json({ contacts: rows, types: CONTACT_TYPES });
});

function contactTokens() { return { confirm: '', unsub: randomToken(16) }; }

app.post('/api/contacts', auth, (req, res) => {
  const { name, email, type, consent, source, history, outlet, country, language, tags, imprintId } = req.body || {};
  if (!name || !type) return res.status(400).json({ error: 'Name and type are required.' });
  if (!CONTACT_TYPES.includes(type)) return res.status(400).json({ error: 'Unknown contact type.' });
  const t = contactTokens();
  const id = db.exec('INSERT INTO contacts (name, email, type, consent, consent_date, status, unsub_token, outlet, country, language, tags, imprint_id, source, history) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [
    name, String(email || '').toLowerCase().trim(), type, consent ? 1 : 0, consent ? mk.today() : '', 'confirmed', t.unsub,
    outlet || '', country || '', language || '', tags || '', imprintId || null, source || 'added by hand', history || '',
  ]);
  if (consent && email && ['reader', 'arc'].includes(type)) ai.syncSubscriber({ email, name }).catch(() => {});
  res.json({ ok: true, id });
});

// Bulk import (CSV with name,email,type,consent,…). Rows without consent
// are imported but never emailed.
app.post('/api/contacts/import', auth, (req, res) => {
  const rows = mk.parseCsv(req.body?.csv || '');
  let added = 0, skipped = 0;
  for (const r of rows) {
    const email = String(r.email || '').toLowerCase().trim();
    const type = CONTACT_TYPES.includes(String(r.type || '').toLowerCase()) ? String(r.type).toLowerCase() : (req.body?.type || 'reader');
    if (!r.name && !email) { skipped++; continue; }
    if (email && db.get('SELECT id FROM contacts WHERE email = ? AND type = ?', [email, type])) { skipped++; continue; }
    const consent = /^(1|yes|y|true|x)$/i.test(String(r.consent || ''));
    db.exec('INSERT INTO contacts (name, email, type, consent, consent_date, status, unsub_token, outlet, country, language, tags, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [
      r.name || email, email, type, consent ? 1 : 0, consent ? (r.consentdate || mk.today()) : '', 'confirmed', randomToken(16),
      r.outlet || r.show || r.publication || '', r.country || '', r.language || '', r.tags || '', r.source || 'CSV import',
    ]);
    added++;
  }
  res.json({ ok: true, added, skipped });
});

app.put('/api/contacts/:id', auth, (req, res) => {
  const c = db.get('SELECT * FROM contacts WHERE id = ?', [req.params.id]);
  if (!c) return res.status(404).json({ error: 'Contact not found.' });
  const b = req.body || {};
  const consent = b.consent !== undefined ? (b.consent ? 1 : 0) : c.consent;
  db.exec('UPDATE contacts SET name = ?, email = ?, type = ?, consent = ?, consent_date = ?, outlet = ?, country = ?, language = ?, tags = ?, source = ?, history = ? WHERE id = ?', [
    b.name ?? c.name, b.email ?? c.email, b.type ?? c.type, consent, consent && !c.consent ? mk.today() : c.consent_date,
    b.outlet ?? c.outlet, b.country ?? c.country, b.language ?? c.language, b.tags ?? c.tags, b.source ?? c.source, b.history ?? c.history, c.id,
  ]);
  res.json({ ok: true });
});

app.delete('/api/contacts/:id', auth, (req, res) => {
  const c = db.get('SELECT email FROM contacts WHERE id = ?', [req.params.id]);
  db.exec('DELETE FROM contacts WHERE id = ?', [req.params.id]);
  if (c?.email) ai.syncSubscriber({ email: c.email, unsubscribe: true }).catch(() => {});
  res.json({ ok: true });
});

// Reader list CSV export — confirmed, consenting, subscribed readers only.
app.get('/api/contacts/export.csv', auth, (req, res) => {
  const rows = db.query("SELECT * FROM contacts WHERE type IN ('reader','arc') AND consent = 1 AND status = 'confirmed' ORDER BY name");
  const esc = (s) => `"${String(s ?? '').replace(/"/g, '""')}"`;
  const csv = 'name,email,type,consent,consent_date,source,country,language\n' + rows.map((r) => [r.name, r.email, r.type, r.consent, r.consent_date, r.source, r.country, r.language].map(esc).join(',')).join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="reader-list.csv"');
  res.send(csv);
});

// =================================================== ARC & REVIEWS =======
app.get('/api/books/:id/campaigns', auth, (req, res) => {
  const book = bookOr404(req, res);
  if (!book) return;
  res.json({ campaigns: db.query('SELECT * FROM campaigns WHERE book_id = ? ORDER BY id DESC', [book.id]) });
});

app.post('/api/books/:id/campaigns', auth, (req, res) => {
  const book = bookOr404(req, res);
  if (!book) return;
  const { type, name, platform, startDate, endDate, budget } = req.body || {};
  if (!type || !name) return res.status(400).json({ error: 'Type and name are required.' });
  if (type === 'arc' && !req.body.reviewPolicyConfirmed) {
    return res.status(400).json({ error: 'Confirm the review rules first: no paid customer reviews and no review swaps. Reviews must be honest and unpaid.' });
  }
  const id = db.exec('INSERT INTO campaigns (book_id, type, name, platform, start_date, end_date, budget, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [book.id, type, name, platform || '', startDate || '', endDate || '', budget || 0, 'active']);
  res.json({ ok: true, id });
});

app.put('/api/campaigns/:id', auth, (req, res) => {
  const c = db.get('SELECT * FROM campaigns WHERE id = ?', [req.params.id]);
  if (!c) return res.status(404).json({ error: 'Campaign not found.' });
  const b = req.body || {};
  db.exec('UPDATE campaigns SET name = ?, platform = ?, start_date = ?, end_date = ?, budget = ?, spend = ?, result = ?, lesson = ?, status = ? WHERE id = ?', [
    b.name ?? c.name, b.platform ?? c.platform, b.startDate ?? c.start_date, b.endDate ?? c.end_date, b.budget ?? c.budget, b.spend ?? c.spend,
    b.result ?? c.result, b.lesson ?? c.lesson, b.status ?? c.status, c.id,
  ]);
  if (b.lesson) db.exec('INSERT INTO lessons (book_id, campaign_id, lesson_code, text) VALUES (?, ?, ?, ?)', [c.book_id, c.id, b.lessonCode || c.type, b.lesson]);
  res.json({ ok: true });
});

app.post('/api/books/:id/arc-email', auth, async (req, res) => {
  const book = bookOr404(req, res);
  if (!book) return;
  const contact = req.body?.contactId ? db.get('SELECT * FROM contacts WHERE id = ?', [req.body.contactId]) : null;
  if (contact && !contact.consent) return res.status(400).json({ error: `${contact.name} has not consented to email. Record consent before sending.` });
  const imp = imprintOf(book);
  const p = promptText('arc_request');
  const out = await ai.completeTask({
    task: 'arc_request', bookId: book.id, system: `Voice: ${imp ? imp.voice_profile : ''}`,
    prompt: `${mk.fillPrompt(p.text, { imprint: imp?.name || '', title: book.title, author: book.author || imp?.author_name || '' })}\n\nBook: "${book.title}"${book.subtitle ? ` — ${book.subtitle}` : ''}\nLaunch: ${book.launch_date || 'to be confirmed'}\nReader: ${contact ? contact.name : 'a reader'}`,
  });
  res.json({ ok: true, draft: mk.ensureArcDisclosure(out.text), provider: out.provider, local: out.local, note: out.note || '' });
});

app.post('/api/books/:id/arc-send', auth, async (req, res) => {
  const book = bookOr404(req, res);
  if (!book) return;
  const { contactIds = [], subject, body } = req.body || {};
  if (!contactIds.length) return res.status(400).json({ error: 'Pick at least one ARC reader.' });
  if (!body || /^\[LOCAL DRAFT/.test(body)) return res.status(400).json({ error: 'Write (or generate) the email first — placeholder drafts are never sent.' });
  const sent = [], failed = [];
  for (const cid of contactIds) {
    const c = db.get('SELECT * FROM contacts WHERE id = ?', [cid]);
    if (!c || !c.email) { failed.push({ id: cid, error: 'No email on file.' }); continue; }
    if (!c.consent || c.status === 'unsubscribed') { failed.push({ id: cid, error: `${c.name} has not consented (or unsubscribed).` }); continue; }
    try {
      const unsub = c.unsub_token ? `${publicBase(req)}/u/${c.unsub_token}` : '';
      const r = await ai.sendEmail({ to: c.email, subject: subject || `Advance copy: ${book.title}`, text: mk.ensureArcDisclosure(body.replace(/\[NAME\]/g, c.name)), unsubscribeUrl: unsub });
      sent.push({ id: cid, provider: r.provider });
      db.exec("UPDATE contacts SET history = COALESCE(history, '') || ? WHERE id = ?", [`\nARC email sent ${mk.today()} for "${book.title}" (${r.provider}).`, cid]);
      db.exec('INSERT INTO arc_sends (book_id, contact_id, followup_due) VALUES (?, ?, ?)', [book.id, cid, mk.addDays(mk.today(), 7)]);
    } catch (e) { failed.push({ id: cid, error: e.message }); }
  }
  logAct(req.account.id, 'arc_send', book.id, `Sent ${sent.length}, failed ${failed.length}`);
  res.json({ ok: true, sent, failed });
});

app.post('/api/books/:id/reviews', auth, (req, res) => {
  const book = bookOr404(req, res);
  if (!book) return;
  const { store, contactId, rating, text, link, date, type } = req.body || {};
  if (!rating || rating < 1 || rating > 5) return res.status(400).json({ error: 'Rating must be 1–5.' });
  const id = db.exec('INSERT INTO reviews (book_id, store, contact_id, rating, text, link, date, type, needs_reply) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [
    book.id, store || '', contactId || null, rating, text || '', link || '', date || mk.today(), type || 'customer', rating <= 2 ? 1 : 0,
  ]);
  if (contactId) db.exec('UPDATE arc_sends SET reviewed = 1 WHERE book_id = ? AND contact_id = ?', [book.id, contactId]);
  if (rating <= 2) { logAct(req.account.id, 'low_review', book.id, `${rating}★ review on ${store || 'a store'} — reply needed`); scheduler.notify('review', `${rating}★ review on ${store || 'a store'}: ${book.title}`, String(text || '').slice(0, 200), book.id); }
  const total = db.get('SELECT COUNT(*) AS n FROM reviews WHERE book_id = ?', [book.id]).n;
  if ([10, 25, 50, 100, 250, 500].includes(total)) scheduler.notify('milestone', `${book.title} reached ${total} reviews`, '', book.id);
  res.json({ ok: true, id });
});

app.post('/api/reviews/:id/reply-draft', auth, async (req, res) => {
  const review = db.get('SELECT * FROM reviews WHERE id = ?', [req.params.id]);
  if (!review) return res.status(404).json({ error: 'Review not found.' });
  const book = db.get('SELECT * FROM books WHERE id = ?', [review.book_id]);
  const imp = imprintOf(book);
  const out = await ai.completeTask({
    task: 'review_reply', bookId: book.id, system: `Voice: ${imp ? imp.voice_profile : ''}`,
    prompt: `${mk.fillPrompt(promptText('review_reply').text, { imprint: imp?.name || '' })}\n\n${review.rating}-star review of "${book.title}" on ${review.store || 'a store'}:\n"${review.text || '(no text)'}"`,
  });
  db.exec('UPDATE reviews SET reply_draft = ?, needs_reply = 1 WHERE id = ?', [out.text, review.id]);
  res.json({ ok: true, draft: out.text, provider: out.provider, local: out.local });
});

app.post('/api/reviews/:id/replied', auth, (req, res) => {
  db.exec('UPDATE reviews SET replied = 1, needs_reply = 0 WHERE id = ?', [req.params.id]);
  res.json({ ok: true });
});

// =================================================== ENDORSEMENTS ========
app.post('/api/books/:id/endorsements', auth, (req, res) => {
  const book = bookOr404(req, res);
  if (!book) return;
  const { contactId, quote, permission, whereUsed, status } = req.body || {};
  const id = db.exec('INSERT INTO endorsements (book_id, contact_id, quote, permission, where_used, status) VALUES (?, ?, ?, ?, ?, ?)', [book.id, contactId || null, quote || '', permission ? 1 : 0, whereUsed || '', status || 'requested']);
  res.json({ ok: true, id });
});

app.put('/api/endorsements/:id', auth, (req, res) => {
  const e = db.get('SELECT * FROM endorsements WHERE id = ?', [req.params.id]);
  if (!e) return res.status(404).json({ error: 'Endorsement not found.' });
  const b = req.body || {};
  db.exec('UPDATE endorsements SET contact_id = ?, quote = ?, permission = ?, where_used = ?, status = ? WHERE id = ?', [
    b.contactId ?? e.contact_id, b.quote ?? e.quote, b.permission !== undefined ? (b.permission ? 1 : 0) : e.permission, b.whereUsed ?? e.where_used, b.status ?? e.status, e.id,
  ]);
  res.json({ ok: true });
});

app.post('/api/books/:id/endorsement-email', auth, async (req, res) => {
  const book = bookOr404(req, res);
  if (!book) return;
  const contact = req.body?.contactId ? db.get('SELECT * FROM contacts WHERE id = ?', [req.body.contactId]) : null;
  const imp = imprintOf(book);
  const out = await ai.completeTask({
    task: 'endorsement_request', bookId: book.id, system: `Voice: ${imp ? imp.voice_profile : ''}`,
    prompt: `${mk.fillPrompt(promptText('endorsement_request').text, { imprint: imp?.name || '', title: book.title })}\n\nBook: "${book.title}"\nTo: ${contact ? `${contact.name}${contact.outlet ? ` (${contact.outlet})` : ''}` : 'an industry contact'}`,
  });
  res.json({ ok: true, draft: out.text, provider: out.provider, local: out.local });
});

// =================================================== PROMOTIONS & ADS =====
app.post('/api/books/:id/promotions', auth, (req, res) => {
  const book = bookOr404(req, res);
  if (!book) return;
  const { type, detail, startDate, endDate, spend, resultUnits, resultRoyalty } = req.body || {};
  const id = db.exec('INSERT INTO promotions (book_id, type, detail, start_date, end_date, spend, result_units, result_royalty) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [book.id, type || 'price', detail || '', startDate || '', endDate || '', spend || 0, resultUnits || 0, resultRoyalty || 0]);
  res.json({ ok: true, id });
});

app.post('/api/books/:id/ads', auth, (req, res) => {
  const book = bookOr404(req, res);
  if (!book) return;
  const { platform, campaignName, spend, sales, orders, impressions, clicks, period, currency } = req.body || {};
  const id = db.exec('INSERT INTO ads (book_id, platform, campaign_name, spend, sales, orders, impressions, clicks, currency, period) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [
    book.id, platform || 'Amazon Ads', campaignName || '', spend || 0, sales || 0, orders || 0, impressions || 0, clicks || 0, currency || 'USD', period || '',
  ]);
  res.json({ ok: true, id });
});

app.post('/api/books/:id/ads/import', auth, async (req, res) => {
  const book = bookOr404(req, res);
  if (!book) return;
  try {
    const r = await importers.importReport({ csv: req.body?.csv, xlsxBase64: req.body?.xlsxBase64, bookId: book.id, kind: 'ads', store: req.body?.platform });
    res.json({ ok: true, imported: r.ads, total: r.rows, skipped: r.skipped });
  } catch (e) { res.status(400).json({ error: `Could not read that file: ${e.message}` }); }
});

app.get('/api/books/:id/ads-roi', auth, (req, res) => {
  const book = bookOr404(req, res);
  if (!book) return;
  const out = db.query('SELECT * FROM ads WHERE book_id = ? ORDER BY id DESC', [book.id]).map((a) => ({
    ...a,
    acos: a.sales > 0 ? Math.round((a.spend / a.sales) * 1000) / 10 : null,
    roas: a.spend > 0 ? Math.round((a.sales / a.spend) * 100) / 100 : null,
    ctr: a.impressions > 0 ? Math.round((a.clicks / a.impressions) * 10000) / 100 : null,
    cpc: a.clicks > 0 ? Math.round((a.spend / a.clicks) * 100) / 100 : null,
  }));
  // Verdict per campaign against break-even ACOS (royalty per sale ÷ price).
  const be = mk.breakEvenAcos(book.id);
  for (const a of out) {
    if (a.spend > 0 && !a.sales && !a.orders) a.verdict = a.ctr != null && a.ctr >= 0.4 && a.clicks >= 20 ? 'clicks, no sales — fix the listing' : 'no sales — pause or cut';
    else if (a.acos == null || be.breakEvenAcos == null) a.verdict = '';
    else if (a.acos <= be.breakEvenAcos) a.verdict = 'profitable — scale';
    else if (a.acos <= be.breakEvenAcos * 1.3) a.verdict = 'near break-even — tune bids';
    else a.verdict = 'losing money — lower bids or pause';
  }
  res.json({ ads: out, breakEven: be });
});

// =================================================== BOOKSTORES & LIBRARIES
app.post('/api/books/:id/consignments', auth, (req, res) => {
  const book = bookOr404(req, res);
  if (!book) return;
  const { store, copies, sold, paid, notes } = req.body || {};
  const id = db.exec('INSERT INTO consignments (book_id, store, copies, sold, paid, notes) VALUES (?, ?, ?, ?, ?, ?)', [book.id, store || '', copies || 0, sold || 0, paid || 0, notes || '']);
  res.json({ ok: true, id });
});

app.put('/api/consignments/:id', auth, (req, res) => {
  const c = db.get('SELECT * FROM consignments WHERE id = ?', [req.params.id]);
  if (!c) return res.status(404).json({ error: 'Consignment not found.' });
  const b = req.body || {};
  db.exec('UPDATE consignments SET store = ?, copies = ?, sold = ?, paid = ?, notes = ? WHERE id = ?', [b.store ?? c.store, b.copies ?? c.copies, b.sold ?? c.sold, b.paid ?? c.paid, b.notes ?? c.notes, c.id]);
  res.json({ ok: true });
});

app.post('/api/books/:id/library', auth, (req, res) => {
  const book = bookOr404(req, res);
  if (!book) return;
  const { platform, status, notes } = req.body || {};
  if (!platform) return res.status(400).json({ error: 'Platform is required.' });
  db.exec('INSERT INTO library_status (book_id, platform, status, notes) VALUES (?, ?, ?, ?) ON CONFLICT(book_id, platform) DO UPDATE SET status = excluded.status, notes = excluded.notes', [book.id, platform, status || 'not submitted', notes || '']);
  res.json({ ok: true });
});

// Sell sheet as a printable PDF.
app.get('/api/books/:id/sellsheet.pdf', auth, (req, res) => {
  const book = bookOr404(req, res);
  if (!book) return;
  const PDFDocument = require('pdfkit');
  const imp = imprintOf(book);
  const meta = db.get('SELECT * FROM metadata WHERE book_id = ?', [book.id]) || {};
  const sheet = db.get("SELECT * FROM content WHERE book_id = ? AND type = 'sellsheet' AND lang = 'English' ORDER BY approved DESC, version DESC LIMIT 1", [book.id]);
  const editions = db.query('SELECT * FROM editions WHERE book_id = ?', [book.id]);
  const endorsements = db.query("SELECT e.quote, c.name FROM endorsements e LEFT JOIN contacts c ON c.id = e.contact_id WHERE e.book_id = ? AND e.permission = 1 AND e.quote != '' LIMIT 3", [book.id]);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="sell-sheet-${book.slug || book.id}.pdf"`);
  const doc = new PDFDocument({ size: 'LETTER', margin: 54 });
  doc.pipe(res);
  doc.fontSize(20).text(book.title, { align: 'center' });
  if (book.subtitle) doc.fontSize(13).text(book.subtitle, { align: 'center' });
  doc.moveDown();
  doc.fontSize(11).text(`Author: ${book.author || imp?.author_name || ''}`);
  doc.text(`Publisher: ${imp ? imp.publisher_name : ''}`);
  for (const e of editions) doc.text(`${e.format}: ISBN ${e.isbn || '—'} — $${e.price ?? '—'}${e.trim ? ` — ${e.trim}` : ''}${e.page_count ? ` — ${e.page_count} pp` : ''}`);
  doc.moveDown();
  if (meta.description) doc.fontSize(11).text(meta.description);
  for (const e of endorsements) { doc.moveDown(0.5); doc.fontSize(10).text(`“${e.quote}” — ${e.name || ''}`, { oblique: true }); }
  doc.moveDown();
  if (sheet && !/^\[LOCAL DRAFT/.test(sheet.text)) doc.fontSize(11).text(sheet.text);
  doc.moveDown();
  doc.fontSize(11).text('Trade terms: 55% discount, returnable (via IngramSpark).');
  if (book.slug) doc.text(`More: ${publicBase(req)}/p/${book.slug}`);
  doc.end();
});

// =================================================== SALES & ANALYTICS ===
// KDP has NO sales API. Reports are imported (CSV or XLSX) or typed in.
app.post('/api/books/:id/sales/import', auth, async (req, res) => {
  const book = bookOr404(req, res);
  if (!book) return;
  try {
    const r = await importers.importReport({ csv: req.body?.csv, xlsxBase64: req.body?.xlsxBase64, bookId: book.id, store: req.body?.store, kind: 'sales' });
    res.json({ ok: true, imported: r.sales, total: r.rows, skipped: r.skipped });
  } catch (e) { res.status(400).json({ error: `Could not read that file: ${e.message}` }); }
});

app.post('/api/books/:id/sales', auth, (req, res) => {
  const book = bookOr404(req, res);
  if (!book) return;
  const { period, store, marketplace, format, units, royalty, currency } = req.body || {};
  if (!period) return res.status(400).json({ error: 'Period (YYYY-MM or a date) is required.' });
  const cur = (currency || 'USD').toUpperCase();
  const id = db.exec('INSERT INTO sales (book_id, store, marketplace, format, period, units, royalty, currency, royalty_usd, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [
    book.id, store || 'KDP', marketplace || '', format || '', period, units || 0, royalty || 0, cur, require('./lib/global').toUsd(royalty || 0, cur), 'manual',
  ]);
  res.json({ ok: true, id });
});

app.get('/api/books/:id/sales', auth, (req, res) => {
  const book = bookOr404(req, res);
  if (!book) return;
  res.json({
    sales: db.query('SELECT * FROM sales WHERE book_id = ? ORDER BY period DESC', [book.id]),
    margin: mk.bookMargin(book.id), trend: mk.salesTrend(book.id), monthly: mk.monthlySales(book.id),
  });
});

app.get('/api/analytics/imprints', auth, (req, res) => {
  res.json({ imprints: db.query('SELECT * FROM imprints').map((i) => ({ ...i, margin: mk.imprintMargin(i.id) })) });
});

app.post('/api/books/:id/lessons', auth, (req, res) => {
  const book = bookOr404(req, res);
  if (!book) return;
  const { campaignId, code, note } = req.body || {};
  if (!code) return res.status(400).json({ error: 'A lesson code is required (e.g. description, keywords, price, cover, timing).' });
  const id = db.exec('INSERT INTO lessons (book_id, campaign_id, lesson_code, text) VALUES (?, ?, ?, ?)', [book.id, campaignId || null, code, note || '']);
  res.json({ ok: true, id });
});

app.get('/api/lessons/export.json', auth, (req, res) => {
  const rows = db.query('SELECT l.*, b.title FROM lessons l JOIN books b ON b.id = l.book_id ORDER BY l.id DESC');
  res.json({ lessons: rows, exportedAt: new Date().toISOString(), note: 'Lessons coded per campaign and per send-back — use them to improve future books.' });
});

// =================================================== BESTSELLER TRACKING ==
// There is NO Amazon rank API. Rank history is typed in or imported.
app.post('/api/books/:id/rank', auth, (req, res) => {
  const book = bookOr404(req, res);
  if (!book) return;
  const { category, rank, store, recordedAt } = req.body || {};
  if (!category || !rank || rank < 1) return res.status(400).json({ error: 'Category and a rank of 1 or better are required.' });
  const date = recordedAt || mk.today();
  const id = db.exec('INSERT INTO rank_history (book_id, category, rank, store, recorded_at) VALUES (?, ?, ?, ?, ?)', [book.id, category, rank, store || 'Amazon', date]);
  const milestones = mk.checkMilestones(book.id, category, rank, date);
  for (const m of milestones) { logAct(req.account.id, 'milestone', book.id, `${m.kind} in ${m.category}`); scheduler.notify('milestone', `🏆 ${book.title}: ${m.kind} in ${m.category}`, '', book.id); }
  res.json({ ok: true, id, milestones });
});

app.post('/api/books/:id/rank/import', auth, (req, res) => {
  const book = bookOr404(req, res);
  if (!book) return;
  const rows = mk.parseCsv(req.body?.csv || '');
  let imported = 0;
  const milestones = [];
  for (const r of rows) {
    const rank = parseInt(String(r.rank || r.position || '0').replace(/[^0-9]/g, ''), 10);
    if (!r.category || !rank) continue;
    const date = r.date || r.recordedat || mk.today();
    db.exec('INSERT INTO rank_history (book_id, category, rank, store, recorded_at) VALUES (?, ?, ?, ?, ?)', [book.id, r.category, rank, r.store || 'Amazon', date]);
    imported++;
    milestones.push(...mk.checkMilestones(book.id, r.category, rank, date));
  }
  res.json({ ok: true, imported, milestones });
});

app.get('/api/books/:id/rank-trend', auth, (req, res) => {
  const book = bookOr404(req, res);
  if (!book) return;
  let rows = db.query('SELECT * FROM rank_history WHERE book_id = ? ORDER BY recorded_at, id', [book.id]);
  if (req.query.category) rows = rows.filter((r) => r.category === req.query.category);
  res.json({ trend: mk.rankTrend(book.id), rows });
});

// =================================================== COMPETITOR WATCH ====
app.post('/api/books/:id/competitors', auth, (req, res) => {
  const book = bookOr404(req, res);
  if (!book) return;
  const { title, author, price, rank, reviewCount, category, source, googleVolumeId, isbn, rating } = req.body || {};
  if (!title) return res.status(400).json({ error: 'Competitor title is required.' });
  const id = db.exec('INSERT INTO competitors (book_id, title, author, price, rank, review_count, rating, category, source, google_volume_id, isbn) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [
    book.id, title, author || '', price ?? null, rank ?? null, reviewCount ?? 0, rating ?? null, category || '', source || (googleVolumeId ? 'google books' : 'manual'), googleVolumeId || '', isbn || '',
  ]);
  res.json({ ok: true, id });
});

app.post('/api/competitors/:id/recheck', auth, (req, res) => {
  const comp = db.get('SELECT * FROM competitors WHERE id = ?', [req.params.id]);
  if (!comp) return res.status(404).json({ error: 'Competitor not found.' });
  const { price, rank, reviewCount } = req.body || {};
  const alerts = mk.competitorAlerts(comp, { price, rank, reviewCount });
  db.exec("UPDATE competitors SET price = ?, rank = ?, review_count = ?, alert = ?, last_checked = datetime('now') WHERE id = ?", [price ?? comp.price, rank ?? comp.rank, reviewCount ?? comp.review_count, alerts.join(' ') || comp.alert || '', comp.id]);
  for (const a of alerts) logAct(req.account.id, 'competitor_alert', comp.book_id, a);
  res.json({ ok: true, alerts });
});

app.delete('/api/competitors/:id', auth, (req, res) => {
  db.exec('DELETE FROM competitors WHERE id = ?', [req.params.id]);
  res.json({ ok: true });
});

app.get('/api/books/:id/competitors/books-lookup', auth, async (req, res) => {
  if (!req.query.q) return res.status(400).json({ error: 'A search term is required.' });
  try { res.json({ ok: true, books: await ai.googleBooksLookup(req.query.q) }); } catch (e) { res.status(400).json({ error: e.message }); }
});

// =================================================== PRICE TESTS =========
app.post('/api/books/:id/price-tests', auth, (req, res) => {
  const book = bookOr404(req, res);
  if (!book) return;
  const { format, oldPrice, newPrice, startDate } = req.body || {};
  if (!format || oldPrice === undefined || newPrice === undefined || Number.isNaN(oldPrice) || Number.isNaN(newPrice)) return res.status(400).json({ error: 'Format, old price and new price are required.' });
  const id = db.exec('INSERT INTO price_tests (book_id, format, old_price, new_price, start_date) VALUES (?, ?, ?, ?, ?)', [book.id, format, oldPrice, newPrice, startDate || mk.today()]);
  res.json({ ok: true, id });
});

app.post('/api/price-tests/:id/finish', auth, (req, res) => {
  const t = db.get('SELECT * FROM price_tests WHERE id = ?', [req.params.id]);
  if (!t) return res.status(404).json({ error: 'Price test not found.' });
  const { endDate, units, royalty, verdict } = req.body || {};
  const end = endDate || mk.today();
  const days = Math.max(1, Math.round((Date.parse(end) - Date.parse(t.start_date)) / 86400000));
  // "Before" = the same number of days before the test started.
  const beforeStart = mk.addDays(t.start_date, -days);
  const rows = db.query('SELECT * FROM sales WHERE book_id = ? AND format = ? AND period >= ? AND period < ?', [t.book_id, t.format, beforeStart, t.start_date]);
  const before = { units: rows.reduce((a, r) => a + (r.units || 0), 0), royalty: Math.round(rows.reduce((a, r) => a + mk.royaltyUsd(r), 0) * 100) / 100 };
  db.exec('UPDATE price_tests SET end_date = ?, units_after = ?, royalty_after = ?, units_before = ?, royalty_before = ?, verdict = ? WHERE id = ?', [end, units ?? 0, royalty ?? 0, before.units, before.royalty, verdict || '', t.id]);
  res.json({ ok: true, comparison: { days, before, after: { units: units ?? 0, royalty: royalty ?? 0 }, verdict: verdict || '' } });
});

// =================================================== BACKLIST REFRESH ====
app.post('/api/books/:id/refresh/:cycleId/analyse', auth, (req, res) => {
  const book = bookOr404(req, res);
  if (!book) return;
  const cycle = db.get('SELECT * FROM refresh_cycles WHERE id = ? AND book_id = ?', [req.params.cycleId, book.id]);
  if (!cycle) return res.status(404).json({ error: 'Refresh cycle not found.' });
  const out = scheduler.runRefreshAnalysis(book.id, cycle.id);
  logAct(req.account.id, 'refresh_analysed', book.id, `${out.recommendations.length} recommendations`);
  res.json({ ok: true, recommendations: out.recommendations, ids: out.ids, numbers: out.numbers });
});

const REC_TASKS = {
  rewrite_description: 'Rewrite the book description (refresh)', refresh_keywords: 'Refresh keywords and categories (refresh)',
  change_categories: 'Change categories (refresh)', price_test: 'Run a price test (refresh)', new_cover: 'Brief a new cover concept (refresh)',
  new_edition: 'Plan a new edition (refresh)', promotion: 'Run a promotion (refresh)', localize: 'Localize store pages for new markets (refresh)',
  leave_as_is: 'No change — leave as is (refresh)',
};

app.post('/api/recommendations/:id/approve', auth, (req, res) => {
  const rec = db.get('SELECT * FROM recommendations WHERE id = ?', [req.params.id]);
  if (!rec) return res.status(404).json({ error: 'Recommendation not found.' });
  db.exec("UPDATE recommendations SET status = 'approved' WHERE id = ?", [rec.id]);
  let automated = '';
  if (rec.kind !== 'leave_as_is') {
    const taskId = db.exec('INSERT INTO tasks (book_id, title, owner, due_date, done) VALUES (?, ?, ?, ?, 0)', [rec.book_id, REC_TASKS[rec.kind] || `Refresh: ${rec.kind}`, '', mk.addDays(mk.today(), 7)]);
    db.exec('UPDATE recommendations SET created_task_id = ? WHERE id = ?', [taskId, rec.id]);
    // Do the first draft automatically where the app can.
    if (rec.kind === 'rewrite_description') { jobs.queue(rec.book_id, 'content_batch', { types: ['description', 'aplus'], reason: 'refresh' }); automated = 'New description and A+ drafts queued.'; }
    if (rec.kind === 'refresh_keywords' || rec.kind === 'change_categories') { jobs.queueOnce(rec.book_id, 'keyword_research', { market: 'US' }); automated = 'Keyword and category research queued.'; }
    if (rec.kind === 'localize') { jobs.queueOnce(rec.book_id, 'localize_metadata', { languages: ['German', 'French', 'Spanish', 'Italian'] }); automated = 'Localized metadata for DE/FR/ES/IT queued.'; }
  }
  db.exec('INSERT INTO refresh_log (book_id, action, detail, result) VALUES (?, ?, ?, ?)', [rec.book_id, 'refresh_approved', `${rec.kind}: ${rec.reason}`, `Task created. ${automated}`.trim()]);
  logAct(req.account.id, 'refresh_approved', rec.book_id, rec.kind);
  res.json({ ok: true, automated });
});

app.post('/api/recommendations/:id/reject', auth, (req, res) => {
  db.exec("UPDATE recommendations SET status = 'rejected' WHERE id = ?", [req.params.id]);
  res.json({ ok: true });
});

app.post('/api/books/:id/refresh/:cycleId/done', auth, (req, res) => {
  db.exec("UPDATE refresh_cycles SET status = 'done' WHERE id = ? AND book_id = ?", [req.params.cycleId, req.params.id]);
  db.exec('INSERT INTO refresh_log (book_id, action, detail, result) VALUES (?, ?, ?, ?)', [req.params.id, 'cycle_done', `Check-in ${req.params.cycleId} completed.`, req.body?.outcome || '']);
  res.json({ ok: true });
});

// =================================================== DASHBOARD ===========
// Portfolio briefing: whole catalogue figures → AI analysis, kept in settings.
function portfolioFigures() {
  return db.query('SELECT b.*, i.name AS imprint_name FROM books b LEFT JOIN imprints i ON i.id = b.imprint_id ORDER BY b.imprint_id, b.id').map((b) => {
    const m = mk.bookMargin(b.id);
    const rv = db.get('SELECT COUNT(*) AS n, AVG(rating) AS avg FROM reviews WHERE book_id = ?', [b.id]);
    const best = db.get('SELECT MIN(rank) AS r FROM rank_history WHERE book_id = ?', [b.id])?.r;
    const live = db.query("SELECT l.store, e.format FROM listings l JOIN editions e ON e.id = l.edition_id WHERE e.book_id = ? AND l.status IN ('live', 'pre-order')", [b.id]);
    const clicks = db.get('SELECT COUNT(*) AS n FROM link_clicks WHERE book_id = ?', [b.id])?.n || 0;
    const fmts = db.query('SELECT DISTINCT format FROM editions WHERE book_id = ?', [b.id]).map((e) => e.format);
    return { id: b.id, title: b.title, imprint: b.imprint_name || '', status: b.status || '', launch: b.launch_date || '', units: m.units ?? mk.bookSales(b.id).units, royalty: m.royalty, promoSpend: m.spend, productionCost: m.productionCost, net: m.net, reviews: rv.n, rating: rv.avg ? Math.round(rv.avg * 10) / 10 : null, bestRank: best ?? null, formats: fmts, livePlatforms: live.map((l) => `${l.store} ${l.format}`), clicks };
  });
}
app.get('/api/portfolio/briefing', auth, (req, res) => {
  let last = null; try { last = JSON.parse(getSetting('portfolio_briefing', '') || 'null'); } catch { last = null; }
  res.json({ last });
});
app.post('/api/portfolio/briefing', auth, async (req, res) => {
  const figures = portfolioFigures();
  if (!figures.length) return res.status(400).json({ error: 'Add a book first.' });
  const p = promptText('portfolio_briefing');
  const lines = figures.map((f) => `- [${f.imprint}] "${f.title}" (${f.status}${f.launch ? ', launch ' + f.launch : ''}): units ${f.units}, royalties $${Math.round((f.royalty || 0) * 100) / 100}, promo $${Math.round((f.promoSpend || 0) * 100) / 100}, production $${f.productionCost || 0}, net $${Math.round((f.net || 0) * 100) / 100}, reviews ${f.reviews}${f.rating ? ' @ ' + f.rating + '★' : ''}, best rank ${f.bestRank ?? '—'}, formats ${f.formats.join('/') || '—'}, live on ${f.livePlatforms.length} (${f.livePlatforms.slice(0, 12).join(', ')}), smart-link clicks ${f.clicks}`);
  const out = await ai.completeTask({ task: 'portfolio_briefing', system: `You advise a small publisher. Never use these phrases: ${AVOID_PHRASES.join('; ')}.`, prompt: `${p.text}\n\nCATALOGUE (${figures.length} books, USD):\n${lines.join('\n')}`, maxTokens: 4000 });
  const rec = { text: out.text, provider: out.provider, local: !!out.local, at: new Date().toISOString(), books: figures.length };
  setSetting('portfolio_briefing', JSON.stringify(rec));
  logAct(req.account.id, 'portfolio_briefing', null, `${figures.length} books`);
  res.json({ ok: true, ...rec });
});

app.get('/api/dashboard', auth, (req, res) => {
  const books = db.query('SELECT * FROM books ORDER BY updated_at DESC');
  const today = mk.today();
  const upcoming = mk.addDays(today, 7);
  const tasksDue = db.query("SELECT t.*, b.title AS book_title FROM tasks t JOIN books b ON b.id = t.book_id WHERE t.done = 0 AND t.due_date != '' AND t.due_date <= ? ORDER BY t.due_date LIMIT 30", [upcoming]);
  const arcReminders = db.query("SELECT c.*, b.title FROM campaigns c JOIN books b ON b.id = c.book_id WHERE c.type = 'arc' AND c.status = 'active' ORDER BY c.id DESC LIMIT 10");
  const reviewsToAnswer = db.query('SELECT r.*, b.title FROM reviews r JOIN books b ON b.id = r.book_id WHERE r.needs_reply = 1 ORDER BY r.date DESC LIMIT 10');
  const lowRatings = db.query('SELECT r.*, b.title FROM reviews r JOIN books b ON b.id = r.book_id WHERE r.rating <= 2 AND r.replied = 0 ORDER BY r.date DESC LIMIT 10');
  const refreshDue = db.query("SELECT rc.*, b.title FROM refresh_cycles rc JOIN books b ON b.id = rc.book_id WHERE rc.status IN ('due','in_review') OR (rc.status = 'scheduled' AND rc.due_date <= ?) ORDER BY rc.due_date LIMIT 10", [upcoming]);
  const manualPosts = db.query("SELECT p.*, b.title FROM scheduled_posts p JOIN books b ON b.id = p.book_id WHERE p.status IN ('manual','failed') ORDER BY p.scheduled_at LIMIT 20");
  const upcomingPosts = db.query("SELECT p.id, p.channel, p.scheduled_at, b.title FROM scheduled_posts p JOIN books b ON b.id = p.book_id WHERE p.status = 'scheduled' ORDER BY p.scheduled_at LIMIT 10");
  const month = today.slice(0, 7);
  const monthSales = db.query('SELECT units, royalty, currency, royalty_usd FROM sales WHERE substr(period, 1, 7) = ?', [month]);
  const monthAds = db.query('SELECT spend, currency FROM ads WHERE substr(period, 1, 7) = ? OR (period = \'\' AND substr(created_at, 1, 7) = ?)', [month, month]);
  const g = require('./lib/global');
  const kpis = {
    royaltyMonth: Math.round(monthSales.reduce((a, r) => a + mk.royaltyUsd(r), 0) * 100) / 100,
    unitsMonth: monthSales.reduce((a, r) => a + (r.units || 0), 0),
    adSpendMonth: Math.round(monthAds.reduce((a, r) => a + (g.toUsd(r.spend || 0, r.currency || 'USD') || 0), 0) * 100) / 100,
    netAllTime: Math.round(books.reduce((a, b) => a + mk.bookMargin(b.id).net, 0) * 100) / 100,
    readers: db.get("SELECT COUNT(*) AS n FROM contacts WHERE type IN ('reader','arc') AND consent = 1 AND status = 'confirmed'").n,
    clicks30d: db.get("SELECT COUNT(*) AS n FROM link_clicks WHERE created_at >= datetime('now','-30 days')").n,
    books: books.length,
    live: db.get("SELECT COUNT(DISTINCT e.book_id) AS n FROM listings l JOIN editions e ON e.id = l.edition_id WHERE l.status IN ('live','pre-order')").n,
  };
  res.json({
    books: books.map(bookSummary), stages: mk.STAGES,
    today: { tasksDue, arcReminders, reviewsToAnswer, lowRatings, refreshDue, manualPosts, upcomingPosts },
    kpis, monthly: mk.monthlySales(null), kdpPlanner: mk.kdpPlanner(),
    unread: db.get('SELECT COUNT(*) AS n FROM notifications WHERE read = 0').n,
    jobs: db.query("SELECT id, kind, status, progress, book_id FROM jobs WHERE status IN ('queued','running') ORDER BY id LIMIT 10"),
  });
});

// =================================================== JOBS ================
app.get('/api/jobs', auth, (req, res) => res.json({ jobs: jobs.list(100, req.query.bookId) }));
app.post('/api/jobs/run', auth, async (req, res) => { const j = await jobs.runNext(); res.json({ ok: true, ran: j ? j.id : null }); });
app.post('/api/jobs/:id/cancel', auth, (req, res) => { jobs.cancel(req.params.id); res.json({ ok: true }); });
app.post('/api/jobs/:id/retry', auth, (req, res) => { db.exec("UPDATE jobs SET status = 'queued', attempts = 0, run_after = '', error = '' WHERE id = ? AND status IN ('failed','cancelled')", [req.params.id]); res.json({ ok: true }); });

// =================================================== EXPORTS =============
app.get('/api/books/:id/export.csv', auth, (req, res) => {
  const book = bookOr404(req, res);
  if (!book) return;
  const sales = db.query('SELECT * FROM sales WHERE book_id = ? ORDER BY period', [book.id]);
  const esc = (s) => `"${String(s ?? '').replace(/"/g, '""')}"`;
  const csv = 'period,store,marketplace,format,units,kenp,royalty,currency,royalty_usd\n' + sales.map((s) => [s.period, s.store, s.marketplace, s.format, s.units, s.kenp, s.royalty, s.currency, s.royalty_usd ?? ''].map(esc).join(',')).join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="sales-${book.slug || book.id}.csv"`);
  res.send(csv);
});

app.get('/api/books/:id/export.json', auth, (req, res) => {
  const book = bookOr404(req, res);
  if (!book) return;
  res.json({
    book, metadata: db.get('SELECT * FROM metadata WHERE book_id = ?', [book.id]),
    localized: db.query('SELECT * FROM localized_metadata WHERE book_id = ?', [book.id]),
    editions: db.query('SELECT * FROM editions WHERE book_id = ?', [book.id]),
    approvedContent: db.query('SELECT type, lang, channel, text, version FROM content WHERE book_id = ? AND approved = 1', [book.id]),
    margin: mk.bookMargin(book.id), exportedAt: new Date().toISOString(),
  });
});

// =================================================== MORE ROUTES =========
const ctx = {
  db, ai, mk, jobs, scheduler, importers, manuscript, auth, requireAdmin, bookOr404, logAct, getSetting, setSetting,
  imprintOf, imprintChannels, promptText, publicBase, generateContentFor, saveContent, kitTypesFor, channelAllowed, rateLimit, ALL_CONTENT_TYPES,
};
require('./routes/rollout')(app, ctx);
require('./routes/growth')(app, ctx);
require('./routes/public')(app, ctx);

app.all('/api/*', (req, res) => res.status(404).json({ error: 'Not found.' }));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// JSON errors instead of HTML stack traces.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'That file is too large (80 MB limit).' });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on the server. It has been logged.' });
});

// First start: create the main admin from ADMIN_USERNAME / ADMIN_PASSWORD
// in .env (only when there are no accounts yet). Change it after login.
function seedAdminFromEnv() {
  const user = String(process.env.ADMIN_USERNAME || '').toLowerCase().trim();
  const pass = process.env.ADMIN_PASSWORD || '';
  if (!user || !pass) return false;
  if (db.get('SELECT COUNT(*) AS n FROM accounts').n > 0) return false;
  if (pass.length < 8) { console.warn('ADMIN_PASSWORD must be at least 8 characters — admin not created.'); return false; }
  const id = db.exec("INSERT INTO accounts (name, email, password_hash, role, status) VALUES (?, ?, ?, 'admin', 'active')", [process.env.ADMIN_NAME || 'Admin', user, hashPassword(pass)]);
  logAct(id, 'account_created', null, 'Main admin created from .env');
  console.log(`Main admin "${user}" created from .env.`);
  return true;
}
app.seedAdminFromEnv = seedAdminFromEnv;

if (require.main === module) {
  (async () => {
    await db.init(DB_PATH);
    seedAdminFromEnv();
    if (!process.env.ENCRYPTION_KEY) console.warn('WARNING: ENCRYPTION_KEY is not set — saving API keys will fail. See DEPLOY.md.');
    if (SESSION_SECRET === 'dev-only-change-me') console.warn('WARNING: SESSION_SECRET is the development default. Set it in .env.');
    scheduler.start();
    app.listen(PORT, HOST, () => {
      console.log(`Book Marketing Studio ${VERSION} listening on http://${HOST}:${PORT}`);
      console.log(`DB: ${DB_PATH}`);
    });
  })();
}

module.exports = app;
