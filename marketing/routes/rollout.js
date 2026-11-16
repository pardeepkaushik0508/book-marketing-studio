// Publishing tracker: every edition × platform from the Book Marketing
// doc, with a status (not started → uploaded → in review → live, or
// rejected / delisted / not applicable), the route used, dates, reasons,
// the per-imprint rollout checklist, "is it live?" checks for Apple and
// Google, and paid-service tracking.
const platforms = require('../lib/platforms');
const livecheck = require('../lib/livecheck');

module.exports = function rolloutRoutes(app, ctx) {
  const { db, ai, mk, scheduler, auth, bookOr404, logAct, imprintOf } = ctx;
  const today = () => mk.today();

  // ---- KDP Select guard ----
  function selectBlock(edition, store) {
    if (edition.format !== 'ebook') return null;
    const p = platforms.platform(store);
    if (!p || !p.selectBlocked) return null;
    const kdp = db.get("SELECT * FROM listings WHERE edition_id = ? AND store = 'KDP'", [edition.id]);
    if (kdp && kdp.kdp_select) {
      const end = kdp.kdp_select_end || '';
      if (!end || end >= today()) return `Blocked: this ebook is in KDP Select${end ? ` until ${end}` : ''}. ${store} (and every other wide ebook store, library, subscription service or direct ebook sale) must wait until the Select term ends.`;
    }
    return null;
  }

  function listingRow(id) {
    return db.get('SELECT l.*, e.format, e.book_id, e.isbn AS edition_isbn, e.language FROM listings l JOIN editions e ON e.id = l.edition_id WHERE l.id = ?', [id]);
  }

  // Move a listing to a new status. KDP's weekly cap is counted the first
  // time a title is created/submitted (uploaded, in review or live).
  function setStatus(listing, status, extra = {}, accountId = null) {
    if (!platforms.STATUSES.includes(status)) throw Object.assign(new Error('Unknown status.'), { code: 400 });
    if (status === 'rejected' && !extra.reason && !listing.reason) throw Object.assign(new Error('Record why it was rejected (it feeds the Kaizen lessons).'), { code: 400 });
    if (!['not_started', 'na', 'rejected', 'delisted'].includes(status)) {
      const blocked = selectBlock({ id: listing.edition_id, format: listing.format }, listing.store);
      if (blocked) throw Object.assign(new Error(blocked), { code: 400 });
    }
    let counted = listing.kdp_counted;
    if (listing.store === 'KDP' && ['ebook', 'paperback', 'hardcover'].includes(listing.format) && !counted && ['uploaded', 'in_review', 'live', 'pre-order'].includes(status)) {
      const slot = mk.kdpSlotStatus(listing.format);
      if (!slot.allowed) throw Object.assign(new Error(`KDP weekly cap reached for ${listing.format}: 2 new titles per format per week (drafts count). Next slot opens Sunday 00:00 UTC (Saturday 5pm Calgary).`), { code: 400 });
      mk.recordKdpUse(listing.format);
      counted = 1;
    }
    const date = extra.date || today();
    db.exec(`UPDATE listings SET status = ?, status_date = ?, reminded = 0, kdp_counted = ?,
      submitted_at = CASE WHEN ? IN ('uploaded','in_review') AND (submitted_at = '' OR submitted_at IS NULL) THEN ? ELSE submitted_at END,
      published_date = CASE WHEN ? IN ('live','pre-order') AND (published_date = '' OR published_date IS NULL) THEN ? ELSE published_date END,
      reason = CASE WHEN ? IN ('rejected','delisted','na') THEN COALESCE(NULLIF(?, ''), reason) ELSE reason END,
      asin = COALESCE(NULLIF(?, ''), asin), live_link = COALESCE(NULLIF(?, ''), live_link) WHERE id = ?`, [
      status, date, counted, status, date, status, date, status, extra.reason || '', extra.asin || '', extra.liveLink || '', listing.id,
    ]);
    if (['live', 'pre-order'].includes(status)) db.exec("UPDATE editions SET status = 'live' WHERE id = ?", [listing.edition_id]);
    if (status === 'rejected') {
      db.exec('INSERT INTO lessons (book_id, lesson_code, text) VALUES (?, ?, ?)', [listing.book_id, 'store_rejection', `${listing.store} rejected the ${listing.format}: ${extra.reason || listing.reason}`]);
      scheduler.notify('publishing', `${listing.store} rejected the ${listing.format}`, extra.reason || listing.reason || '', listing.book_id);
    }
    logAct(accountId, 'listing_status', listing.book_id, `${listing.store} ${listing.format}: ${listing.status} → ${status}${extra.reason ? ` (${extra.reason})` : ''}`);
    return listingRow(listing.id);
  }
  ctx.setListingStatus = setStatus;

  function decorate(l) {
    const p = platforms.platform(l.store) || {};
    return { ...l, category: p.category || 'other', routes: p.routes || ['Direct'], platformUrl: p.url || '', platformNote: p.note || '', checkable: !!p.check, check: p.check || '', daysInStatus: l.status_date ? Math.round((Date.parse(today()) - Date.parse(l.status_date)) / 86400000) : null };
  }

  function summary(rows) {
    const s = { total: 0, done: 0, pending: 0, rejected: 0, notStarted: 0, delisted: 0, na: 0, stuck: 0 };
    for (const r of rows) {
      if (r.status === 'na') { s.na++; continue; }
      s.total++;
      if (platforms.DONE.includes(r.status)) s.done++;
      else if (platforms.PENDING.includes(r.status)) { s.pending++; if (r.status_date && r.status_date <= mk.addDays(today(), -7)) s.stuck++; }
      else if (r.status === 'rejected') s.rejected++;
      else if (r.status === 'delisted') s.delisted++;
      else s.notStarted++;
    }
    return s;
  }

  // ---- catalog ----
  app.get('/api/platforms', auth, (req, res) => {
    res.json({ platforms: platforms.PLATFORMS, statuses: platforms.STATUSES, statusLabels: platforms.STATUS_LABELS, phases: platforms.PHASES, plans: platforms.PLANS, paidServices: platforms.PAID_SERVICES, paidStatuses: platforms.PAID_STATUSES, penNames: platforms.PEN_NAMES });
  });

  // ---- per-book publishing view ----
  app.get('/api/books/:id/rollout', auth, (req, res) => {
    const book = bookOr404(req, res);
    if (!book) return;
    const editions = db.query('SELECT * FROM editions WHERE book_id = ? ORDER BY id', [book.id]).map((e) => {
      const listings = db.query('SELECT * FROM listings WHERE edition_id = ? ORDER BY id', [e.id]).map((l) => decorate({ ...l, format: e.format }));
      const used = new Set(listings.map((l) => l.store));
      const kdp = listings.find((l) => l.store === 'KDP');
      return {
        ...e, listings, summary: summary(listings),
        inSelect: !!(kdp && kdp.kdp_select && (!kdp.kdp_select_end || kdp.kdp_select_end >= today())),
        available: platforms.forFormat(e.format).filter((p) => !used.has(p.name)).map((p) => ({ name: p.name, category: p.category, routes: p.routes, note: p.note })),
      };
    });
    const all = editions.flatMap((e) => e.listings);
    const imp = imprintOf(book);
    res.json({ editions, summary: summary(all), phases: platforms.PHASES, statuses: platforms.STATUSES, statusLabels: platforms.STATUS_LABELS, planName: imp ? imp.name : 'North American Manufacturing Press', penName: platforms.PEN_NAMES[imp?.name] || '' });
  });

  // Build the checklist from the imprint's plan for every edition.
  app.post('/api/books/:id/rollout/generate', auth, (req, res) => {
    const book = bookOr404(req, res);
    if (!book) return;
    const imp = imprintOf(book);
    const plan = platforms.planFor(imp?.name);
    const editions = db.query('SELECT * FROM editions WHERE book_id = ?', [book.id]);
    if (!editions.length) return res.status(400).json({ error: 'Add the editions first (ebook, paperback, hardcover, audiobook, spiral workbook).' });
    let created = 0;
    const skippedSelect = [];
    db.transaction(() => {
      for (const e of editions) {
        for (const [store, formats, phase, route] of plan) {
          if (!formats.includes(e.format)) continue;
          const have = db.get('SELECT id, phase FROM listings WHERE edition_id = ? AND store = ?', [e.id, store]);
          if (have) { if (!have.phase) db.exec('UPDATE listings SET phase = ? WHERE id = ?', [phase, have.id]); continue; }
          if (selectBlock(e, store)) { skippedSelect.push(`${store} (${e.format})`); continue; }
          db.exec("INSERT INTO listings (edition_id, store, route, phase, status, price, currency) VALUES (?, ?, ?, ?, 'not_started', ?, 'USD')", [e.id, store, route, phase, e.price ?? null]);
          created++;
        }
      }
    });
    logAct(req.account.id, 'rollout_generated', book.id, `${created} checklist items from the ${imp?.name || 'default'} plan`);
    res.json({ ok: true, created, skippedSelect, note: skippedSelect.length ? `${skippedSelect.length} wide ebook items skipped — the ebook is in KDP Select.` : '' });
  });

  // Store matrix (kept for older screens): only platforms that take the format.
  app.get('/api/books/:id/matrix', auth, (req, res) => {
    const book = bookOr404(req, res);
    if (!book) return;
    const rows = [];
    for (const e of db.query('SELECT * FROM editions WHERE book_id = ? ORDER BY id', [book.id])) {
      for (const p of platforms.forFormat(e.format)) rows.push({ edition: e, store: p.name, listing: db.get('SELECT * FROM listings WHERE edition_id = ? AND store = ?', [e.id, p.name]) || null });
    }
    res.json({ matrix: rows, stores: mk.STORES, formats: mk.FORMATS });
  });

  // Create (or update) one listing.
  app.post('/api/books/:id/listings', auth, (req, res) => {
    const book = bookOr404(req, res);
    if (!book) return;
    const { editionId, store, asin, price, currency, liveLink, kdpSelect, kdpSelectEnd, aiDisclosure, preorder, releaseDate, route, phase, notes } = req.body || {};
    if (!editionId || !store) return res.status(400).json({ error: 'Edition and platform are required.' });
    const edition = db.get('SELECT * FROM editions WHERE id = ? AND book_id = ?', [editionId, book.id]);
    if (!edition) return res.status(400).json({ error: 'Edition does not belong to this book.' });
    const p = platforms.platform(store);
    if (p && !p.formats.includes(edition.format)) return res.status(400).json({ error: `${store} does not take ${edition.format} editions.` });
    const blocked = selectBlock(edition, store);
    if (blocked) return res.status(400).json({ error: blocked });
    if (store === 'KDP' && kdpSelect && edition.format === 'ebook') {
      const wide = db.query("SELECT store FROM listings WHERE edition_id = ? AND store != 'KDP' AND status IN ('live','pre-order','uploaded','in_review')", [editionId])
        .filter((w) => platforms.platform(w.store)?.selectBlocked);
      if (wide.length) return res.status(400).json({ error: `Blocked: KDP Select needs ebook exclusivity, but this ebook is out on ${wide.map((w) => w.store).join(', ')}. Unpublish those first.` });
    }
    const existing = db.get('SELECT * FROM listings WHERE edition_id = ? AND store = ?', [editionId, store]);
    const r = route || existing?.route || (p ? p.routes[0] : 'Direct');
    const vals = [asin ?? existing?.asin ?? '', price ?? existing?.price ?? null, currency || existing?.currency || 'USD', liveLink ?? existing?.live_link ?? '', kdpSelect ? 1 : 0, kdpSelectEnd || '', aiDisclosure ?? existing?.ai_disclosure ?? '', preorder ? 1 : 0, releaseDate || '', r, phase ?? existing?.phase ?? '', notes ?? existing?.notes ?? ''];
    if (existing) {
      db.exec('UPDATE listings SET asin = ?, price = ?, currency = ?, live_link = ?, kdp_select = ?, kdp_select_end = ?, ai_disclosure = ?, preorder = ?, release_date = ?, route = ?, phase = ?, notes = ? WHERE id = ?', [...vals, existing.id]);
      return res.json({ ok: true, id: existing.id });
    }
    const id = db.exec("INSERT INTO listings (edition_id, store, asin, price, currency, live_link, kdp_select, kdp_select_end, ai_disclosure, preorder, release_date, route, phase, notes, status, status_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'not_started', ?)", [editionId, store, ...vals, today()]);
    res.json({ ok: true, id });
  });

  // KDP Select is changed through POST /api/books/:id/listings (it checks exclusivity).
  app.put('/api/listings/:id', auth, (req, res) => {
    const l = listingRow(req.params.id);
    if (!l) return res.status(404).json({ error: 'Listing not found.' });
    const b = req.body || {};
    try {
      db.exec('UPDATE listings SET asin = ?, price = ?, currency = ?, live_link = ?, kdp_select = ?, kdp_select_end = ?, ai_disclosure = ?, preorder = ?, release_date = ?, route = ?, phase = ?, notes = ?, reason = ? WHERE id = ?', [
        b.asin ?? l.asin, b.price !== undefined ? b.price : l.price, b.currency || l.currency, b.liveLink ?? l.live_link,
        l.kdp_select, l.kdp_select_end, b.aiDisclosure ?? l.ai_disclosure,
        b.preorder !== undefined ? (b.preorder ? 1 : 0) : l.preorder, b.releaseDate ?? l.release_date, b.route ?? l.route, b.phase ?? l.phase, b.notes ?? l.notes, b.reason ?? l.reason, l.id,
      ]);
      if (b.status && b.status !== l.status) setStatus(listingRow(l.id), b.status, { reason: b.reason, date: b.statusDate }, req.account.id);
      res.json({ ok: true });
    } catch (e) { res.status(e.code || 500).json({ error: e.message }); }
  });

  app.post('/api/listings/:id/status', auth, (req, res) => {
    const l = listingRow(req.params.id);
    if (!l) return res.status(404).json({ error: 'Listing not found.' });
    try {
      const out = setStatus(l, req.body?.status, { reason: req.body?.reason, liveLink: req.body?.liveLink, asin: req.body?.asin, date: req.body?.date }, req.account.id);
      res.json({ ok: true, listing: decorate(out), kdpPlanner: mk.kdpPlanner() });
    } catch (e) { res.status(e.code || 500).json({ error: e.message }); }
  });

  // "Pressing Publish on any store" is always a human step — this records it.
  app.post('/api/listings/:id/publish', auth, (req, res) => {
    const l = listingRow(req.params.id);
    if (!l) return res.status(404).json({ error: 'Listing not found.' });
    if (['live', 'pre-order'].includes(l.status)) return res.json({ ok: true, already: true, kdpPlanner: mk.kdpPlanner() });
    try {
      setStatus(l, l.preorder ? 'pre-order' : 'live', { asin: req.body?.asin, liveLink: req.body?.liveLink }, req.account.id);
      res.json({ ok: true, kdpPlanner: mk.kdpPlanner() });
    } catch (e) { res.status(e.code || 500).json({ error: e.message }); }
  });

  app.delete('/api/listings/:id', auth, (req, res) => {
    db.exec('DELETE FROM listings WHERE id = ?', [req.params.id]);
    res.json({ ok: true });
  });

  // ---- "is it live?" ----
  async function runCheck(l) {
    const p = platforms.platform(l.store);
    if (!p || !p.check) return { live: false, manual: true, detail: `${l.store} has no public lookup — update the status by hand.` };
    const book = db.get('SELECT * FROM books WHERE id = ?', [l.book_id]);
    const imp = imprintOf(book);
    const r = await livecheck.check(p.check, {
      book: { title: book.title, author: book.author || imp?.author_name || '' },
      edition: { format: l.format, isbn: l.edition_isbn },
      country: 'us', apiKey: ai.getConnection('googlebooks')?.apiKey || '',
    });
    db.exec("UPDATE listings SET last_checked = datetime('now'), check_result = ? WHERE id = ?", [r.detail, l.id]);
    if (r.live && !['live', 'pre-order'].includes(l.status)) {
      setStatus(listingRow(l.id), r.preorder ? 'pre-order' : 'live', { liveLink: r.url, asin: r.id }, null);
      scheduler.notify('publishing', `Now live on ${l.store}: ${book.title} (${l.format})`, r.detail, l.book_id);
      r.statusChanged = true;
    }
    return r;
  }
  ctx.runLiveCheck = runCheck;

  app.post('/api/listings/:id/check', auth, async (req, res) => {
    const l = listingRow(req.params.id);
    if (!l) return res.status(404).json({ error: 'Listing not found.' });
    try { res.json({ ok: true, ...(await runCheck(l)) }); } catch (e) { res.status(502).json({ error: `Lookup failed: ${e.message}` }); }
  });

  // ---- automation: stuck reminders + daily live checks ----
  async function publishingTick() {
    const out = { reminders: 0, checked: 0, nowLive: 0 };
    const stuck = db.query("SELECT l.*, e.format, e.book_id, b.title FROM listings l JOIN editions e ON e.id = l.edition_id JOIN books b ON b.id = e.book_id WHERE l.status IN ('uploaded','in_review') AND l.reminded = 0 AND l.status_date != '' AND l.status_date <= ?", [mk.addDays(today(), -7)]);
    for (const l of stuck) {
      db.exec('INSERT INTO tasks (book_id, title, owner, due_date, done) VALUES (?, ?, ?, ?, 0)', [l.book_id, `Check ${l.store} (${l.format}) — ${l.status === 'uploaded' ? 'uploaded' : 'in review'} since ${l.status_date}`, '', today()]);
      scheduler.notify('publishing', `Stuck on ${l.store}: ${l.title} (${l.format})`, `${l.status === 'uploaded' ? 'Uploaded' : 'In review'} since ${l.status_date} — over 7 days. Check the dashboard there; a task was added.`, l.book_id);
      db.exec('UPDATE listings SET reminded = 1 WHERE id = ?', [l.id]);
      out.reminders++;
    }
    if (scheduler.setting('auto_live_check', '1') === '1') {
      const stores = platforms.PLATFORMS.filter((p) => p.check).map((p) => p.name);
      const due = db.query(`SELECT l.id FROM listings l WHERE l.store IN (${stores.map(() => '?').join(',')}) AND l.status IN ('uploaded','in_review') AND (l.last_checked = '' OR l.last_checked <= datetime('now','-1 day')) LIMIT 10`, stores);
      for (const { id } of due) {
        try { const r = await runCheck(listingRow(id)); out.checked++; if (r.statusChanged) out.nowLive++; } catch { db.exec("UPDATE listings SET last_checked = datetime('now') WHERE id = ?", [id]); }
      }
    }
    return out;
  }
  Object.defineProperty(publishingTick, 'name', { value: 'publishing' });
  scheduler.hooks.push(publishingTick);

  // ---- all books: what's missing ----
  app.get('/api/publishing/overview', auth, (req, res) => {
    const books = db.query('SELECT id, title, imprint_id FROM books ORDER BY updated_at DESC');
    const out = books.map((b) => {
      const rows = db.query('SELECT l.*, e.format FROM listings l JOIN editions e ON e.id = l.edition_id WHERE e.book_id = ?', [b.id]);
      const s = summary(rows);
      const next = rows.filter((r) => r.status === 'not_started').sort((a, c) => platforms.PHASES.findIndex((p) => p[0] === a.phase) - platforms.PHASES.findIndex((p) => p[0] === c.phase)).slice(0, 5).map((r) => `${r.store} (${r.format})`);
      const stuck = rows.filter((r) => platforms.PENDING.includes(r.status) && r.status_date && r.status_date <= mk.addDays(today(), -7)).map((r) => ({ id: r.id, store: r.store, format: r.format, status: r.status, since: r.status_date }));
      const rejectedList = rows.filter((r) => r.status === 'rejected').map((r) => ({ id: r.id, store: r.store, format: r.format, reason: r.reason }));
      return { id: b.id, title: b.title, ...s, hasChecklist: rows.length > 0, next, stuck, rejectedList };
    });
    res.json({ books: out });
  });

  // ---- paid services ----
  app.get('/api/books/:id/paid-services', auth, (req, res) => {
    const book = bookOr404(req, res);
    if (!book) return;
    res.json({ services: db.query('SELECT * FROM paid_services WHERE book_id = ? ORDER BY id DESC', [book.id]), catalog: platforms.PAID_SERVICES, statuses: platforms.PAID_STATUSES });
  });
  app.post('/api/books/:id/paid-services', auth, (req, res) => {
    const book = bookOr404(req, res);
    if (!book) return;
    const b = req.body || {};
    if (!b.service) return res.status(400).json({ error: 'Pick a service.' });
    const id = db.exec('INSERT INTO paid_services (book_id, service, status, applied_at, run_date, cost, currency, result, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [
      book.id, b.service, platforms.PAID_STATUSES.includes(b.status) ? b.status : 'planned', b.appliedAt || '', b.runDate || '', b.cost || 0, (b.currency || 'USD').toUpperCase(), b.result || '', b.notes || '',
    ]);
    res.json({ ok: true, id });
  });
  app.put('/api/paid-services/:id', auth, (req, res) => {
    const s = db.get('SELECT * FROM paid_services WHERE id = ?', [req.params.id]);
    if (!s) return res.status(404).json({ error: 'Not found.' });
    const b = req.body || {};
    db.exec('UPDATE paid_services SET status = ?, applied_at = ?, run_date = ?, cost = ?, currency = ?, result = ?, notes = ? WHERE id = ?', [
      platforms.PAID_STATUSES.includes(b.status) ? b.status : s.status, b.appliedAt ?? s.applied_at, b.runDate ?? s.run_date, b.cost ?? s.cost, (b.currency || s.currency).toUpperCase(), b.result ?? s.result, b.notes ?? s.notes, s.id,
    ]);
    if (b.result && b.result !== s.result) db.exec('INSERT INTO lessons (book_id, lesson_code, text) VALUES (?, ?, ?)', [s.book_id, 'paid_service', `${s.service}: ${b.result}`]);
    res.json({ ok: true });
  });
  app.delete('/api/paid-services/:id', auth, (req, res) => { db.exec('DELETE FROM paid_services WHERE id = ?', [req.params.id]); res.json({ ok: true }); });
};
