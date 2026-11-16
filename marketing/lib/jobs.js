// Background job queue — in-process worker with a SQLite jobs table.
// Long AI runs (content kits, whole-book audio and translation, localized
// metadata, research) happen off the web request, can be scheduled for a
// later time (run_after), report progress, and retry up to 3 times.
// Handlers resume where they stopped (they skip work already saved).
const db = require('./db');

const handlers = {};
let running = false;

function register(kind, fn) { handlers[kind] = fn; }

function nowIso() { return new Date().toISOString().slice(0, 19).replace('T', ' '); }

// runAfter: ISO date/time string (UTC) or '' for "as soon as possible".
function queue(bookId, kind, payload = {}, runAfter = '') {
  const ra = runAfter ? String(runAfter).replace('T', ' ').slice(0, 19) : '';
  return db.exec("INSERT INTO jobs (book_id, kind, status, payload, run_after) VALUES (?, ?, 'queued', ?, ?)", [bookId || null, kind, JSON.stringify(payload), ra]);
}

// Queue once: skip if the same kind is already queued/running for the book.
function queueOnce(bookId, kind, payload = {}, runAfter = '') {
  const dup = db.get("SELECT id FROM jobs WHERE book_id IS ? AND kind = ? AND status IN ('queued','running') AND payload = ?", [bookId || null, kind, JSON.stringify(payload)]);
  return dup ? dup.id : queue(bookId, kind, payload, runAfter);
}

function list(limit = 100, bookId) {
  return bookId
    ? db.query('SELECT * FROM jobs WHERE book_id = ? ORDER BY id DESC LIMIT ?', [bookId, limit])
    : db.query('SELECT * FROM jobs ORDER BY id DESC LIMIT ?', [limit]);
}

function progress(jobId, text) {
  db.exec("UPDATE jobs SET progress = ?, updated_at = datetime('now') WHERE id = ?", [String(text).slice(0, 300), jobId]);
}

function cancel(jobId) {
  db.exec("UPDATE jobs SET status = 'cancelled', updated_at = datetime('now') WHERE id = ? AND status = 'queued'", [jobId]);
}

async function runNext() {
  if (running) return null;
  const job = db.get("SELECT * FROM jobs WHERE status = 'queued' AND (run_after = '' OR run_after IS NULL OR run_after <= ?) ORDER BY id LIMIT 1", [nowIso()]);
  if (!job) return null;
  running = true;
  const fn = handlers[job.kind];
  db.exec("UPDATE jobs SET status = 'running', attempts = attempts + 1, updated_at = datetime('now') WHERE id = ?", [job.id]);
  try {
    if (!fn) throw new Error('No handler for job kind: ' + job.kind);
    const payload = JSON.parse(job.payload || '{}');
    await fn(job, payload, (t) => progress(job.id, t));
    db.exec("UPDATE jobs SET status = 'done', error = '', updated_at = datetime('now') WHERE id = ?", [job.id]);
  } catch (e) {
    const attempts = (job.attempts || 0) + 1;
    const status = attempts >= 3 ? 'failed' : 'queued';
    // Retry later, not immediately: 5 minutes, then 30.
    const retryAt = status === 'queued' ? new Date(Date.now() + (attempts === 1 ? 5 : 30) * 60000).toISOString().slice(0, 19).replace('T', ' ') : '';
    db.exec("UPDATE jobs SET status = ?, error = ?, run_after = ?, updated_at = datetime('now') WHERE id = ?", [status, String(e.message || e).slice(0, 500), retryAt, job.id]);
  } finally {
    running = false;
  }
  return db.get('SELECT * FROM jobs WHERE id = ?', [job.id]);
}

// Jobs left "running" by a crash or restart go back in the queue.
function recoverStuck() {
  db.exec("UPDATE jobs SET status = 'queued' WHERE status = 'running'");
}

module.exports = { queue, queueOnce, register, runNext, list, progress, cancel, recoverStuck, handlers };
