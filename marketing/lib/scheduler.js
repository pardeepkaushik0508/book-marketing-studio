// Automation engine. One tick every minute (started by server.js):
//  - runs due background jobs (content kits, audio, translation, research)
//  - flips backlist check-ins to "due" and analyses them automatically
//  - publishes scheduled posts whose time has come (approved content only)
//  - drafts or sends ARC follow-ups; flags pitch follow-ups
//  - sends the daily digest (in-app + email) once a day
//  - re-checks competitors weekly (Google Books) and refreshes FX daily
//  - warns before social tokens expire
// Every rule can be switched off in Settings → Automation.
const db = require('./db');
const ai = require('./ai');
const mk = require('./marketing');
const jobs = require('./jobs');
const social = require('./social');
const global = require('./global');

let timer = null;
const hooks = []; // extra automation registered by route modules (publishing checks)
let ticking = false;

function setting(key, def = '') { const r = db.get('SELECT value FROM settings WHERE key = ?', [key]); return r ? r.value : def; }
function setSetting(key, value) { db.exec('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [key, String(value)]); }
function on(key) { return setting(key, '1') === '1'; }
function nowSql() { return new Date().toISOString().slice(0, 19).replace('T', ' '); }

function notify(kind, title, body = '', bookId = null) {
  return db.exec('INSERT INTO notifications (kind, title, body, book_id) VALUES (?, ?, ?, ?)', [kind, title, body, bookId]);
}

// Analyse one check-in and store its recommendations (shared with the route).
function runRefreshAnalysis(bookId, cycleId) {
  const analysis = mk.analyseRefresh(bookId);
  const ids = [];
  for (const r of analysis.recommendations) {
    ids.push(db.exec('INSERT INTO recommendations (book_id, refresh_id, kind, reason, numbers_json, status) VALUES (?, ?, ?, ?, ?, ?)', [bookId, cycleId, r.kind, r.reason, JSON.stringify(r.numbers || {}), 'proposed']));
  }
  db.exec("UPDATE refresh_cycles SET status = 'in_review', analysis_json = ? WHERE id = ?", [JSON.stringify(analysis.numbers || {}), cycleId]);
  return { ...analysis, ids };
}

function refreshCheckins() {
  mk.markDueCycles();
  if (!on('auto_refresh_analysis')) return 0;
  const due = db.query("SELECT rc.*, b.title FROM refresh_cycles rc JOIN books b ON b.id = rc.book_id WHERE rc.status = 'due'");
  for (const c of due) {
    const a = runRefreshAnalysis(c.book_id, c.id);
    notify('refresh', `${c.kind} check-in ready: ${c.title}`, `${a.recommendations.length} recommendation(s) to approve or reject.`, c.book_id);
  }
  return due.length;
}

async function publishDuePosts() {
  const due = db.query("SELECT p.*, b.title FROM scheduled_posts p JOIN books b ON b.id = p.book_id WHERE p.status = 'scheduled' AND p.scheduled_at <= ? ORDER BY p.scheduled_at LIMIT 20", [nowSql()]);
  let n = 0;
  for (const p of due) {
    const r = on('auto_post') ? await social.publish(p) : { status: 'manual', externalId: '', error: 'Auto-posting is off — post it by hand.' };
    db.exec("UPDATE scheduled_posts SET status = ?, external_id = ?, error = ?, posted_at = CASE WHEN ? = 'posted' THEN datetime('now') ELSE posted_at END WHERE id = ?", [r.status, r.externalId, r.error, r.status, p.id]);
    if (r.status === 'failed') notify('post_failed', `Post failed on ${p.channel}: ${p.title}`, r.error, p.book_id);
    n++;
  }
  return n;
}

async function arcFollowups() {
  const mode = setting('auto_arc_followup', 'draft'); // off | draft | send
  if (mode === 'off') return 0;
  const due = db.query("SELECT s.*, c.name, c.email, c.consent, c.status AS cstatus, b.title FROM arc_sends s JOIN contacts c ON c.id = s.contact_id JOIN books b ON b.id = s.book_id WHERE s.followup_done = 0 AND s.reviewed = 0 AND s.followup_due != '' AND s.followup_due <= ?", [mk.today()]);
  for (const s of due) {
    let sent = false;
    if (mode === 'send' && s.consent && s.cstatus !== 'unsubscribed' && s.email) {
      try {
        const book = db.get('SELECT * FROM books WHERE id = ?', [s.book_id]);
        const imp = book.imprint_id ? db.get('SELECT * FROM imprints WHERE id = ?', [book.imprint_id]) : null;
        const p = db.get("SELECT text FROM prompts WHERE task = 'arc_followup' ORDER BY id DESC LIMIT 1");
        const out = await ai.completeTask({ task: 'arc_followup', bookId: s.book_id, system: `Voice: ${imp?.voice_profile || ''}`, prompt: mk.fillPrompt(p?.text || '', { imprint: imp?.name || '', title: book.title, author: book.author || imp?.author_name || '' }) + `\nReader: ${s.name}` });
        if (!out.local) { await ai.sendEmail({ to: s.email, subject: `A gentle reminder: ${book.title}`, text: mk.ensureArcDisclosure(out.text) }); sent = true; }
      } catch { /* fall back to a task */ }
    }
    if (!sent) {
      db.exec('INSERT INTO tasks (book_id, title, owner, due_date, done) VALUES (?, ?, ?, ?, 0)', [s.book_id, `${(s.followups || 0) === 0 ? '1st' : '2nd (last)'} reminder to ARC reader ${s.name} (no review yet)`, '', mk.today()]);
    }
    // Two gentle reminders: day 7, then day 14. Then stop.
    if ((s.followups || 0) === 0) db.exec('UPDATE arc_sends SET followups = 1, followup_due = ? WHERE id = ?', [mk.addDays(mk.today(), 7), s.id]);
    else db.exec('UPDATE arc_sends SET followups = followups + 1, followup_done = 1 WHERE id = ?', [s.id]);
  }
  if (due.length) notify('arc', `${due.length} ARC follow-up(s) ${mode === 'send' ? 'handled' : 'added to tasks'}`, '', null);
  return due.length;
}

function pitchFollowups() {
  const due = db.query("SELECT p.*, b.title FROM pitches p JOIN books b ON b.id = p.book_id WHERE p.status = 'sent' AND p.followup_due != '' AND p.followup_due <= ?", [mk.today()]);
  for (const p of due) {
    db.exec("UPDATE pitches SET status = 'follow-up due' WHERE id = ?", [p.id]);
    db.exec('INSERT INTO tasks (book_id, title, owner, due_date, done) VALUES (?, ?, ?, ?, 0)', [p.book_id, `Follow up ${p.kind} pitch: ${p.outlet || 'outlet'}`, '', mk.today()]);
  }
  return due.length;
}

function buildDigest() {
  const today = mk.today();
  const tasks = db.query('SELECT t.title, t.due_date, b.title AS book FROM tasks t JOIN books b ON b.id = t.book_id WHERE t.done = 0 AND t.due_date != \'\' AND t.due_date <= ? ORDER BY t.due_date LIMIT 30', [mk.addDays(today, 1)]);
  const manual = db.query("SELECT p.channel, b.title AS book FROM scheduled_posts p JOIN books b ON b.id = p.book_id WHERE p.status IN ('manual','failed') LIMIT 20");
  const reviews = db.get('SELECT COUNT(*) AS n FROM reviews WHERE needs_reply = 1').n;
  const checkins = db.get("SELECT COUNT(*) AS n FROM refresh_cycles WHERE status IN ('due','in_review')").n;
  const failedJobs = db.get("SELECT COUNT(*) AS n FROM jobs WHERE status = 'failed' AND updated_at >= datetime('now','-1 day')").n;
  const milestones = db.query("SELECT m.kind, m.category, b.title AS book FROM milestones m JOIN books b ON b.id = m.book_id WHERE m.date >= ?", [mk.addDays(today, -1)]);
  const clicks = db.get("SELECT COUNT(*) AS n FROM link_clicks WHERE created_at >= datetime('now','-1 day')").n;
  const lines = [];
  lines.push(`Book Marketing Studio — daily digest ${today}`);
  lines.push('');
  if (milestones.length) lines.push(`🏆 Milestones: ${milestones.map((m) => `${m.book}: ${m.kind} in ${m.category}`).join('; ')}`);
  lines.push(`Tasks due today/overdue: ${tasks.length}`);
  for (const t of tasks.slice(0, 15)) lines.push(`  • ${t.book}: ${t.title} (${t.due_date})`);
  lines.push(`Posts to do by hand: ${manual.length}${manual.length ? ' — ' + manual.slice(0, 5).map((m) => `${m.book} on ${m.channel}`).join(', ') : ''}`);
  lines.push(`Reviews waiting for a reply: ${reviews}`);
  lines.push(`Backlist check-ins to review: ${checkins}`);
  lines.push(`Smart-link clicks (24h): ${clicks}`);
  if (failedJobs) lines.push(`⚠ Background jobs failed in the last day: ${failedJobs} — see Settings → Jobs.`);
  return { text: lines.join('\n'), counts: { tasks: tasks.length, manual: manual.length, reviews, checkins, failedJobs, clicks, milestones: milestones.length } };
}

async function dailyDigest(force = false) {
  const today = mk.today();
  const hour = parseInt(setting('digest_hour_utc', '14'), 10);
  if (!force && (setting('last_digest_date') === today || new Date().getUTCHours() < hour)) return null;
  setSetting('last_digest_date', today);
  const d = buildDigest();
  notify('digest', `Daily digest ${today}`, d.text, null);
  const to = setting('notify_email');
  let emailed = false;
  if (to) {
    try { await ai.sendEmail({ to, subject: `Daily digest ${today} — Book Marketing Studio`, text: d.text }); emailed = true; } catch (e) { notify('digest', 'Digest email not sent', e.message); }
  }
  return { ...d, emailed };
}

async function competitorRechecks() {
  if (!on('auto_competitor_recheck')) return 0;
  const rows = db.query("SELECT * FROM competitors WHERE google_volume_id != '' AND (last_checked = '' OR last_checked <= datetime('now','-7 days')) LIMIT 10");
  let n = 0;
  for (const c of rows) {
    try {
      const v = await ai.googleBooksVolume(c.google_volume_id);
      const alerts = mk.competitorAlerts(c, { price: v.price, reviewCount: v.ratingsCount });
      db.exec("UPDATE competitors SET price = COALESCE(?, price), review_count = COALESCE(?, review_count), rating = COALESCE(?, rating), alert = ?, last_checked = datetime('now') WHERE id = ?", [v.price, v.ratingsCount, v.averageRating, alerts.join(' ') || c.alert || '', c.id]);
      for (const a of alerts) notify('competitor', a, '', c.book_id);
      n++;
    } catch { db.exec("UPDATE competitors SET last_checked = datetime('now') WHERE id = ?", [c.id]); }
  }
  return n;
}

async function fxDaily() {
  if (!on('auto_fx_refresh') || setting('last_fx_date') === mk.today()) return null;
  setSetting('last_fx_date', mk.today());
  return global.refreshFx();
}

function tokenWarnings() {
  const li = ai.getConnection('linkedin');
  if (li && li.apiKey && li.extra.expires) {
    const days = Math.round((Date.parse(li.extra.expires) - Date.now()) / 86400000);
    if (days <= 7 && setting('warned_linkedin_expiry') !== li.extra.expires) {
      setSetting('warned_linkedin_expiry', li.extra.expires);
      notify('token', `LinkedIn token expires ${days <= 0 ? 'today or has expired' : `in ${days} days`}`, 'Paste a fresh token in Settings → API vault → LinkedIn.');
    }
  }
}

async function tick() {
  if (ticking) return { skipped: true };
  ticking = true;
  const out = {};
  try {
    if (setting('automation_enabled', '1') === '1') {
      out.checkins = refreshCheckins();
      out.posts = await publishDuePosts();
      out.arc = await arcFollowups();
      out.pitches = pitchFollowups();
      out.digest = await dailyDigest();
      out.competitors = await competitorRechecks();
      out.fx = await fxDaily();
      tokenWarnings();
      for (const h of hooks) { try { out[h.name || 'hook'] = await h(); } catch (e) { out[h.name || 'hook'] = `error: ${e.message}`; } }
    }
    // Jobs run even when rule-based automation is off (you queued them).
    let n = 0;
    const until = Date.now() + 45000;
    while (Date.now() < until && n < 5) { const j = await jobs.runNext(); if (!j) break; n++; }
    out.jobs = n;
  } catch (e) {
    out.error = e.message;
  } finally {
    ticking = false;
  }
  return out;
}

function start(intervalMs = 60000) {
  if (timer) return;
  jobs.recoverStuck();
  timer = setInterval(() => { tick().catch(() => {}); }, intervalMs);
  if (timer.unref) timer.unref();
  setTimeout(() => tick().catch(() => {}), 5000).unref?.();
}

module.exports = { hooks, start, tick, notify, runRefreshAnalysis, buildDigest, dailyDigest, publishDuePosts, refreshCheckins, arcFollowups, setting, setSetting };
