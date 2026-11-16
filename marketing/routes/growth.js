// Growth routes (v2): worldwide pricing and localized metadata, research,
// foreign rights, media/podcast/library/bookstore pitches, the content
// calendar with auto-posting, smart-link analytics, report imports,
// notifications and automation controls, whole-book audio and translation
// — plus the background job handlers that do the heavy lifting.
const fs = require('fs');
const path = require('path');
const global = require('../lib/global');

module.exports = function growthRoutes(app, ctx) {
  const { db, ai, mk, jobs, scheduler, importers, manuscript, auth, requireAdmin, bookOr404, logAct, getSetting, imprintOf, imprintChannels, promptText, publicBase, generateContentFor, saveContent, kitTypesFor, channelAllowed } = ctx;

  const isFaith = (book) => /lamp|faith|christian/i.test(imprintOf(book)?.name || '');
  const smartLink = (book, channel) => (book.slug ? `${publicBase()}/b/${book.slug}${channel ? `?ch=${encodeURIComponent(mk.slugify(channel))}` : ''}` : '');

  // ================================================ WORLDWIDE PRICING =====
  app.get('/api/books/:id/global', auth, (req, res) => {
    const book = bookOr404(req, res);
    if (!book) return;
    const editions = db.query('SELECT * FROM editions WHERE book_id = ? ORDER BY id', [book.id]).map((e) => {
      const saved = db.query('SELECT * FROM marketplace_prices WHERE edition_id = ?', [e.id]);
      const overrides = Object.fromEntries(saved.map((s) => [s.marketplace, s.price]));
      const kdp = db.get("SELECT kdp_select FROM listings WHERE edition_id = ? AND store = 'KDP'", [e.id]);
      return { ...e, kdpSelect: !!kdp?.kdp_select, saved: saved.length, ladder: global.priceLadder(e, { kdpSelect: !!kdp?.kdp_select, overrides }) };
    });
    res.json({
      editions, marketplaces: global.MARKETPLACES, languages: global.LANGUAGES, fx: global.fxTable(),
      localized: db.query('SELECT * FROM localized_metadata WHERE book_id = ? ORDER BY lang', [book.id]),
      research: db.query('SELECT * FROM research WHERE book_id = ? ORDER BY id DESC LIMIT 20', [book.id]),
      note: 'KDP 70% bands checked on KDP’s eBook List Price Requirements page (2026-11-16): US/CA $2.99–$12.99, UK £1.77–£12.99, EUR €2.69–€12.99, JP ¥250–¥1,650, BR R$5.99–R$31.99, MX $34.99–$199.99, AU $3.99–$15.99, IN ₹99–₹599. Delivery costs, VAT and “70% needs KDP Select” markets are estimates — verify in KDP before publishing.',
    });
  });

  // Save local prices for an edition: { prices: { US: 9.99, UK: 7.99, … } }
  // or { auto: true } to save the computed ladder as-is.
  app.post('/api/editions/:id/prices', auth, (req, res) => {
    const e = db.get('SELECT * FROM editions WHERE id = ?', [req.params.id]);
    if (!e) return res.status(404).json({ error: 'Edition not found.' });
    const kdp = db.get("SELECT kdp_select FROM listings WHERE edition_id = ? AND store = 'KDP'", [e.id]);
    const overrides = {};
    if (!req.body?.auto) for (const [k, v] of Object.entries(req.body?.prices || {})) if (v !== '' && v != null && !Number.isNaN(Number(v))) overrides[k] = Number(v);
    const ladder = global.priceLadder(e, { kdpSelect: !!kdp?.kdp_select, overrides });
    db.transaction(() => {
      for (const r of ladder) {
        db.exec("INSERT INTO marketplace_prices (edition_id, marketplace, currency, price, royalty_rate, est_royalty, note, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now')) ON CONFLICT(edition_id, marketplace) DO UPDATE SET price = excluded.price, royalty_rate = excluded.royalty_rate, est_royalty = excluded.est_royalty, note = excluded.note, updated_at = excluded.updated_at",
          [e.id, r.marketplace, r.currency, r.price, r.rate, r.royalty, r.warnings.join(' ')]);
      }
    });
    res.json({ ok: true, ladder });
  });

  app.get('/api/fx', auth, (req, res) => res.json({ fx: global.fxTable() }));
  app.post('/api/fx', auth, requireAdmin, (req, res) => {
    const { currency, perUsd } = req.body || {};
    if (!/^[A-Z]{3}$/.test(String(currency || '').toUpperCase()) || !(perUsd > 0)) return res.status(400).json({ error: 'Currency code (e.g. EUR) and a positive rate per 1 USD are required.' });
    global.setFxRate(String(currency).toUpperCase(), Number(perUsd), 'manual');
    res.json({ ok: true });
  });
  app.post('/api/fx/refresh', auth, requireAdmin, async (req, res) => res.json(await global.refreshFx()));

  // ================================================ LOCALIZED METADATA ====
  app.post('/api/books/:id/localize', auth, (req, res) => {
    const book = bookOr404(req, res);
    if (!book) return;
    const languages = (req.body?.languages || []).filter((l) => global.LANGUAGES.includes(l) || /^[A-Za-z ()-]{3,40}$/.test(l));
    if (!languages.length) return res.status(400).json({ error: 'Pick at least one language.' });
    const jobId = jobs.queue(book.id, 'localize_metadata', { languages });
    res.json({ ok: true, jobId, note: `Localizing for ${languages.join(', ')} — drafts appear in the Worldwide tab. Each needs a native reviewer before you paste it into KDP.` });
  });

  app.put('/api/localized/:id', auth, (req, res) => {
    const l = db.get('SELECT * FROM localized_metadata WHERE id = ?', [req.params.id]);
    if (!l) return res.status(404).json({ error: 'Not found.' });
    const b = req.body || {};
    if (b.status === 'approved' && !(b.reviewer || l.reviewer)) return res.status(400).json({ error: 'Name the native reviewer before approving localized copy.' });
    db.exec("UPDATE localized_metadata SET title = ?, subtitle = ?, description = ?, keywords = ?, categories = ?, status = ?, reviewer = ?, updated_at = datetime('now') WHERE id = ?", [
      b.title ?? l.title, b.subtitle ?? l.subtitle, b.description ?? l.description, b.keywords ? JSON.stringify(b.keywords) : l.keywords,
      b.categories ? JSON.stringify(b.categories) : l.categories, b.status ?? l.status, b.reviewer ?? l.reviewer, l.id,
    ]);
    res.json({ ok: true });
  });

  app.delete('/api/localized/:id', auth, (req, res) => { db.exec('DELETE FROM localized_metadata WHERE id = ?', [req.params.id]); res.json({ ok: true }); });

  // ================================================ RESEARCH ==============
  // kind: keywords (KDP keywords + categories + comps) | ads_keywords
  app.post('/api/books/:id/research', auth, async (req, res) => {
    const book = bookOr404(req, res);
    if (!book) return;
    const kind = req.body?.kind === 'ads_keywords' ? 'ads_keywords' : 'keywords';
    const market = req.body?.market || 'US';
    try {
      const r = await runResearch(book, kind, market);
      res.json({ ok: true, ...r });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  async function runResearch(book, kind, market) {
    const imp = imprintOf(book);
    const meta = db.get('SELECT * FROM metadata WHERE book_id = ?', [book.id]) || {};
    const task = kind === 'ads_keywords' ? 'ads_keywords' : 'keyword_research';
    const mp = global.marketplace(market) || global.MARKETPLACES[0];
    const p = mk.fillPrompt(promptText(task).text, { imprint: imp?.name || '', title: book.title, market: `${mp.name} (${mp.language})`, author: book.author || imp?.author_name || '' });
    const out = await ai.research({ task, bookId: book.id, prompt: `${p}\n\nBook: "${book.title}"${book.subtitle ? ` — ${book.subtitle}` : ''}\nDescription: ${meta.description || book.back_cover || ''}\nCurrent keywords: ${meta.keywords || '[]'}\nCurrent categories: ${meta.categories || '[]'}\nAudience: ${meta.audience || ''}` });
    const id = db.exec('INSERT INTO research (book_id, kind, market, result, provider) VALUES (?, ?, ?, ?, ?)', [book.id, kind, market, out.text, out.provider]);
    return { id, result: out.text, provider: out.provider, local: out.local, note: out.note || (out.provider !== 'perplexity' && !out.local ? 'Not grounded in live search — connect Perplexity for research with sources.' : '') };
  }

  app.delete('/api/research/:id', auth, (req, res) => { db.exec('DELETE FROM research WHERE id = ?', [req.params.id]); res.json({ ok: true }); });

  // ================================================ FOREIGN RIGHTS ========
  app.get('/api/books/:id/rights', auth, (req, res) => {
    const book = bookOr404(req, res);
    if (!book) return;
    res.json({ rights: db.query('SELECT * FROM rights_deals WHERE book_id = ? ORDER BY territory', [book.id]) });
  });
  app.post('/api/books/:id/rights', auth, (req, res) => {
    const book = bookOr404(req, res);
    if (!book) return;
    const b = req.body || {};
    if (!b.territory) return res.status(400).json({ error: 'Territory is required (e.g. Germany, or "World Spanish").' });
    const id = db.exec('INSERT INTO rights_deals (book_id, territory, language, rights_type, partner, agent, status, advance, currency, royalty_pct, term_years, signed_date, reversion_date, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [
      book.id, b.territory, b.language || '', b.rightsType || 'translation', b.partner || '', b.agent || '', b.status || 'available',
      b.advance || 0, b.currency || 'USD', b.royaltyPct || 0, b.termYears || 0, b.signedDate || '', b.reversionDate || '', b.notes || '',
    ]);
    res.json({ ok: true, id });
  });
  app.put('/api/rights/:id', auth, (req, res) => {
    const r = db.get('SELECT * FROM rights_deals WHERE id = ?', [req.params.id]);
    if (!r) return res.status(404).json({ error: 'Not found.' });
    const b = req.body || {};
    db.exec('UPDATE rights_deals SET territory = ?, language = ?, rights_type = ?, partner = ?, agent = ?, status = ?, advance = ?, currency = ?, royalty_pct = ?, term_years = ?, signed_date = ?, reversion_date = ?, notes = ? WHERE id = ?', [
      b.territory ?? r.territory, b.language ?? r.language, b.rightsType ?? r.rights_type, b.partner ?? r.partner, b.agent ?? r.agent, b.status ?? r.status,
      b.advance ?? r.advance, b.currency ?? r.currency, b.royaltyPct ?? r.royalty_pct, b.termYears ?? r.term_years, b.signedDate ?? r.signed_date, b.reversionDate ?? r.reversion_date, b.notes ?? r.notes, r.id,
    ]);
    if (b.status === 'signed' && r.status !== 'signed') scheduler.notify('rights', `Rights signed: ${r.territory}`, b.partner || r.partner || '', r.book_id);
    res.json({ ok: true });
  });
  app.delete('/api/rights/:id', auth, (req, res) => { db.exec('DELETE FROM rights_deals WHERE id = ?', [req.params.id]); res.json({ ok: true }); });

  // ================================================ PITCHES ===============
  const PITCH_TASK = { podcast: 'podcast_pitch', media: 'media_pitch', library: 'library_pitch', bookstore: 'bookstore_pitch', blog: 'media_pitch' };

  app.get('/api/books/:id/pitches', auth, (req, res) => {
    const book = bookOr404(req, res);
    if (!book) return;
    res.json({ pitches: db.query('SELECT p.*, c.name AS contact_name, c.email AS contact_email FROM pitches p LEFT JOIN contacts c ON c.id = p.contact_id WHERE p.book_id = ? ORDER BY p.id DESC', [book.id]) });
  });
  app.post('/api/books/:id/pitches', auth, (req, res) => {
    const book = bookOr404(req, res);
    if (!book) return;
    const { contactId, kind, outlet, angle } = req.body || {};
    const contact = contactId ? db.get('SELECT * FROM contacts WHERE id = ?', [contactId]) : null;
    if (!outlet && !contact) return res.status(400).json({ error: 'Pick a contact or name the outlet/show.' });
    const id = db.exec('INSERT INTO pitches (book_id, contact_id, kind, outlet, angle, status) VALUES (?, ?, ?, ?, ?, ?)', [book.id, contactId || null, PITCH_TASK[kind] ? kind : 'podcast', outlet || contact?.outlet || contact?.name || '', angle || '', 'idea']);
    res.json({ ok: true, id });
  });
  app.post('/api/pitches/:id/draft', auth, async (req, res) => {
    const p = db.get('SELECT p.*, c.name AS contact_name FROM pitches p LEFT JOIN contacts c ON c.id = p.contact_id WHERE p.id = ?', [req.params.id]);
    if (!p) return res.status(404).json({ error: 'Pitch not found.' });
    const book = db.get('SELECT * FROM books WHERE id = ?', [p.book_id]);
    const out = await generateContentFor(book, PITCH_TASK[p.kind] || 'media_pitch', `${p.outlet}${p.contact_name ? ` (${p.contact_name})` : ''}`, { extra: p.angle ? `Angle to use: ${p.angle}` : '' });
    db.exec("UPDATE pitches SET draft = ?, status = CASE WHEN status = 'idea' THEN 'drafted' ELSE status END WHERE id = ?", [out.text, p.id]);
    res.json({ ok: true, draft: out.text, provider: out.provider, local: out.local, note: out.note || '' });
  });
  app.put('/api/pitches/:id', auth, (req, res) => {
    const p = db.get('SELECT * FROM pitches WHERE id = ?', [req.params.id]);
    if (!p) return res.status(404).json({ error: 'Pitch not found.' });
    const b = req.body || {};
    db.exec('UPDATE pitches SET outlet = ?, angle = ?, draft = ?, status = ?, result = ?, followup_due = ? WHERE id = ?', [b.outlet ?? p.outlet, b.angle ?? p.angle, b.draft ?? p.draft, b.status ?? p.status, b.result ?? p.result, b.followupDue ?? p.followup_due, p.id]);
    res.json({ ok: true });
  });
  // Send a pitch one-to-one (Gmail first — it comes from you, not a list tool).
  app.post('/api/pitches/:id/send', auth, async (req, res) => {
    const p = db.get('SELECT p.*, c.email, c.name AS contact_name FROM pitches p LEFT JOIN contacts c ON c.id = p.contact_id WHERE p.id = ?', [req.params.id]);
    if (!p) return res.status(404).json({ error: 'Pitch not found.' });
    if (!p.email) return res.status(400).json({ error: 'This pitch has no contact email. Add the contact (Readers & contacts) and link it, or send it by hand and press "Mark sent".' });
    const text = req.body?.draft || p.draft;
    if (!text || /^\[LOCAL DRAFT/.test(text)) return res.status(400).json({ error: 'Write (or generate) the pitch first.' });
    const m = text.match(/^\s*subject:\s*(.+)\n/i);
    const book = db.get('SELECT title FROM books WHERE id = ?', [p.book_id]);
    try {
      const r = await ai.sendEmail({ to: p.email, subject: m ? m[1].trim() : `${book.title} — for ${p.outlet}`, text: m ? text.slice(m[0].length).trim() : text, prefer: 'gmail' });
      db.exec("UPDATE pitches SET draft = ?, status = 'sent', sent_at = date('now'), followup_due = ? WHERE id = ?", [text, mk.addDays(mk.today(), 10), p.id]);
      logAct(req.account.id, 'pitch_sent', p.book_id, `${p.kind} → ${p.outlet} (${r.provider})`);
      res.json({ ok: true, provider: r.provider });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });
  app.post('/api/pitches/:id/mark-sent', auth, (req, res) => {
    db.exec("UPDATE pitches SET status = 'sent', sent_at = date('now'), followup_due = ? WHERE id = ?", [mk.addDays(mk.today(), 10), req.params.id]);
    res.json({ ok: true });
  });
  app.delete('/api/pitches/:id', auth, (req, res) => { db.exec('DELETE FROM pitches WHERE id = ?', [req.params.id]); res.json({ ok: true }); });

  // ================================================ CONTENT CALENDAR ======
  function postText(content, idx) {
    if (content.type === 'social') { const posts = mk.splitPosts(content.text); return posts[Math.min(idx || 0, posts.length - 1)] || content.text; }
    if (content.type === 'email') { const parts = content.text.split(/\n\s*---\s*\n/); return (parts[Math.min(idx || 0, parts.length - 1)] || content.text).trim(); }
    return content.text;
  }
  const withLink = (text, link) => (link ? String(text).replace(/\[LINK\]/g, link) : String(text));

  app.get('/api/calendar', auth, (req, res) => {
    const from = req.query.from || mk.addDays(mk.today(), -7);
    const to = req.query.to || mk.addDays(mk.today(), 60);
    res.json({ posts: db.query("SELECT p.*, b.title FROM scheduled_posts p JOIN books b ON b.id = p.book_id WHERE substr(p.scheduled_at, 1, 10) BETWEEN ? AND ? AND p.status != 'cancelled' ORDER BY p.scheduled_at", [from, to]) });
  });

  app.get('/api/books/:id/posts', auth, (req, res) => {
    const book = bookOr404(req, res);
    if (!book) return;
    res.json({ posts: db.query("SELECT * FROM scheduled_posts WHERE book_id = ? AND status != 'cancelled' ORDER BY scheduled_at", [book.id]) });
  });

  app.post('/api/books/:id/posts', auth, (req, res) => {
    const book = bookOr404(req, res);
    if (!book) return;
    const { contentId, channel, scheduledAt, index, imageUrl, text } = req.body || {};
    const content = db.get('SELECT * FROM content WHERE id = ? AND book_id = ?', [contentId, book.id]);
    if (!content) return res.status(400).json({ error: 'Pick an approved content piece.' });
    if (!content.approved) return res.status(400).json({ error: 'Only approved content can be scheduled — approve it in the Content tab first.' });
    if (!channel || !channelAllowed(imprintOf(book), channel)) return res.status(400).json({ error: `"${channel || '(none)'}" is not one of this imprint's channels.` });
    if (!/^\d{4}-\d{2}-\d{2}/.test(scheduledAt || '')) return res.status(400).json({ error: 'Choose a date and time.' });
    const link = smartLink(book, channel);
    const id = db.exec('INSERT INTO scheduled_posts (book_id, content_id, channel, text, image_url, link, scheduled_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [
      book.id, content.id, channel, withLink(text || postText(content, index), link), imageUrl || '', link, String(scheduledAt).replace('T', ' ').slice(0, 16) + ':00',
    ]);
    res.json({ ok: true, id });
  });

  // Spread approved social posts, emails and the LinkedIn article across
  // the imprint's channels around a launch (or from a start date).
  function autoSchedule(book, startDate) {
    const imp = imprintOf(book);
    const chans = imprintChannels(imp).map((c) => c.platform);
    const approved = (type) => db.get("SELECT * FROM content WHERE book_id = ? AND type = ? AND approved = 1 AND lang = 'English' ORDER BY version DESC LIMIT 1", [book.id, type]);
    const at = (offset, hour = 15) => `${mk.addDays(startDate, offset)} ${String(hour).padStart(2, '0')}:00:00`;
    const nowSql = new Date().toISOString().slice(0, 19).replace('T', ' ');
    const made = [];
    const add = (content, channel, text, when) => {
      if (when < nowSql) return;
      const link = smartLink(book, channel);
      const full = withLink(text, link);
      if (db.get("SELECT id FROM scheduled_posts WHERE content_id = ? AND channel = ? AND text = ? AND status != 'cancelled'", [content.id, channel, full])) return;
      made.push(db.exec('INSERT INTO scheduled_posts (book_id, content_id, channel, text, link, scheduled_at) VALUES (?, ?, ?, ?, ?, ?)', [book.id, content.id, channel, withLink(text, link), link, when]));
    };
    const social = approved('social');
    if (social) {
      const posts = mk.splitPosts(social.text);
      const socialChans = chans.filter((c) => !/email|website/i.test(c));
      const offsets = [-3, 0, 2, 5, 9, 14, 21, 28];
      posts.forEach((p, i) => {
        for (const ch of socialChans) {
          if (/^x$|twitter/i.test(ch) && [...withLink(p, smartLink(book, ch))].length > 280) continue;
          add(social, ch, p, at(offsets[i % offsets.length] + Math.floor(i / offsets.length) * 30, /linkedin/i.test(ch) ? 14 : 16));
        }
      });
    }
    const email = approved('email');
    if (email && chans.some((c) => /email/i.test(c))) {
      const parts = email.text.split(/\n\s*---\s*\n/).map((s) => s.trim()).filter(Boolean);
      parts.forEach((p, i) => add(email, chans.find((c) => /email/i.test(c)), p, at([0, 3, 7][i] ?? i * 4, 13)));
    }
    const article = approved('linkedin');
    if (article && chans.some((c) => /linkedin/i.test(c))) add(article, 'LinkedIn', article.text, at(1, 14));
    return made;
  }

  app.post('/api/books/:id/posts/auto', auth, (req, res) => {
    const book = bookOr404(req, res);
    if (!book) return;
    const start = req.body?.startDate || book.launch_date || mk.today();
    const made = autoSchedule(book, start);
    res.json({ ok: true, scheduled: made.length, note: made.length ? '' : 'Nothing new to schedule — approve social posts, the email sequence or the LinkedIn article first (already-scheduled pieces are skipped).' });
  });

  app.put('/api/posts/:id', auth, (req, res) => {
    const p = db.get('SELECT * FROM scheduled_posts WHERE id = ?', [req.params.id]);
    if (!p) return res.status(404).json({ error: 'Post not found.' });
    const b = req.body || {};
    db.exec('UPDATE scheduled_posts SET text = ?, scheduled_at = ?, image_url = ?, status = CASE WHEN status IN (\'failed\',\'manual\') AND ? THEN \'scheduled\' ELSE status END WHERE id = ?', [
      b.text ?? p.text, b.scheduledAt ? String(b.scheduledAt).replace('T', ' ').slice(0, 16) + ':00' : p.scheduled_at, b.imageUrl ?? p.image_url, b.reschedule ? 1 : 0, p.id,
    ]);
    res.json({ ok: true });
  });
  app.post('/api/posts/:id/posted', auth, (req, res) => {
    db.exec("UPDATE scheduled_posts SET status = 'posted', posted_at = datetime('now'), error = '' WHERE id = ?", [req.params.id]);
    res.json({ ok: true });
  });
  app.post('/api/posts/:id/publish-now', auth, async (req, res) => {
    const p = db.get('SELECT * FROM scheduled_posts WHERE id = ?', [req.params.id]);
    if (!p) return res.status(404).json({ error: 'Post not found.' });
    const r = await require('../lib/social').publish(p);
    db.exec("UPDATE scheduled_posts SET status = ?, external_id = ?, error = ?, posted_at = CASE WHEN ? = 'posted' THEN datetime('now') ELSE posted_at END WHERE id = ?", [r.status, r.externalId, r.error, r.status, p.id]);
    res.json({ ok: r.status === 'posted', ...r });
  });
  app.delete('/api/posts/:id', auth, (req, res) => {
    db.exec("UPDATE scheduled_posts SET status = 'cancelled' WHERE id = ?", [req.params.id]);
    res.json({ ok: true });
  });

  // ================================================ SMART LINKS ===========
  app.get('/api/books/:id/links', auth, (req, res) => {
    const book = bookOr404(req, res);
    if (!book) return;
    const since = req.query.days ? `-${parseInt(req.query.days, 10)} days` : '-90 days';
    const q = (col) => db.query(`SELECT ${col} AS k, COUNT(*) AS n FROM link_clicks WHERE book_id = ? AND created_at >= datetime('now', ?) GROUP BY ${col} ORDER BY n DESC`, [book.id, since]);
    const daily = db.query("SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS n FROM link_clicks WHERE book_id = ? AND created_at >= datetime('now', '-30 days') GROUP BY day ORDER BY day", [book.id]);
    const chans = imprintChannels(imprintOf(book)).map((c) => c.platform);
    res.json({
      smartLink: smartLink(book), bookPage: book.slug ? `${publicBase(req)}/p/${book.slug}` : '',
      channelLinks: [...chans, 'Newsletter', 'Podcast', 'Ads', 'Back matter'].map((c) => ({ channel: c, url: smartLink(book, c) })),
      byChannel: q('channel'), byCountry: q('country'), byStore: q('store'), daily, total: db.get('SELECT COUNT(*) AS n FROM link_clicks WHERE book_id = ?', [book.id]).n,
    });
  });

  // ================================================ REPORT IMPORT (all books)
  app.post('/api/import/report', auth, async (req, res) => {
    try {
      const r = await importers.importReport({ csv: req.body?.csv, xlsxBase64: req.body?.xlsxBase64, store: req.body?.store || undefined, kind: req.body?.kind || undefined });
      logAct(req.account.id, 'report_imported', null, `${r.sales} sales rows, ${r.ads} ad rows, ${r.books.length} books, ${r.unmatched.length} unmatched`);
      res.json({ ok: true, ...r });
    } catch (e) { res.status(400).json({ error: `Could not read that file: ${e.message}` }); }
  });

  // ================================================ NOTIFICATIONS =========
  app.get('/api/notifications', auth, (req, res) => {
    res.json({ notifications: db.query('SELECT n.*, b.title AS book_title FROM notifications n LEFT JOIN books b ON b.id = n.book_id ORDER BY n.id DESC LIMIT 100'), unread: db.get('SELECT COUNT(*) AS n FROM notifications WHERE read = 0').n });
  });
  app.post('/api/notifications/read-all', auth, (req, res) => { db.exec('UPDATE notifications SET read = 1 WHERE read = 0'); res.json({ ok: true }); });
  app.post('/api/notifications/:id/read', auth, (req, res) => { db.exec('UPDATE notifications SET read = 1 WHERE id = ?', [req.params.id]); res.json({ ok: true }); });

  // ================================================ AUTOMATION ============
  app.post('/api/automation/run-now', auth, requireAdmin, async (req, res) => res.json({ ok: true, result: await scheduler.tick() }));
  app.get('/api/automation/digest-preview', auth, (req, res) => res.json(scheduler.buildDigest()));
  app.post('/api/automation/digest', auth, requireAdmin, async (req, res) => res.json({ ok: true, ...(await scheduler.dailyDigest(true)) }));

  // ================================================ MANUSCRIPT & CHAPTERS ==
  app.post('/api/books/:id/manuscript', auth, (req, res) => {
    const book = bookOr404(req, res);
    if (!book) return;
    const text = req.body?.text || (req.body?.base64 ? Buffer.from(req.body.base64, 'base64').toString('utf8') : '');
    if (!text.trim()) return res.status(400).json({ error: 'Upload a .txt or .md manuscript (or paste the text).' });
    manuscript.saveFile(book.id, 'manuscript', req.body?.name || 'manuscript.txt', Buffer.from(text, 'utf8'), 'Uploaded in Marketing');
    const n = manuscript.storeChapters(book.id, text);
    res.json({ ok: true, chapters: n });
  });

  app.get('/api/books/:id/chapters/:no', auth, (req, res) => {
    const c = db.get('SELECT * FROM chapters WHERE book_id = ? AND no = ?', [req.params.id, req.params.no]);
    if (!c) return res.status(404).json({ error: 'Chapter not found.' });
    res.json({ chapter: c });
  });

  // ================================================ EDITIONS: AUDIO & TRANSLATION
  app.get('/api/books/:id/editions-matrix', auth, (req, res) => {
    const book = bookOr404(req, res);
    if (!book) return;
    res.json({
      note: 'Which routes accept AI narration and AI translation — rules change, verify at upload. Checked 2026-11-16 where marked.',
      matrix: [
        { store: 'KDP Virtual Voice (Audible, beta)', aiNarration: 'Yes — Amazon generates it from your Kindle ebook (eligibility-based beta, no file needed)', humanNarration: '—' },
        { store: 'ACX / Audible', aiNarration: 'No for uploaded AI files — human narration only (verify). From May 2026: 50% royalty exclusive, 30% non-exclusive (Book Marketing doc).', humanNarration: 'Yes' },
        { store: 'Spotify for Authors', aiNarration: 'Check the current rules at upload', humanNarration: 'Yes' },
        { store: 'Voices by INaudio (formerly Findaway)', aiNarration: 'Yes — with AI disclosure (verify)', humanNarration: 'Yes' },
        { store: 'Google Play Books', aiNarration: 'Yes — with AI disclosure (Google also offers auto-narration)', humanNarration: 'Yes' },
        { store: 'Kobo audiobooks', aiNarration: 'Yes — with AI disclosure (verify)', humanNarration: 'Yes' },
        { store: "Author's Republic", aiNarration: 'Check the current rules at upload', humanNarration: 'Yes' },
        { store: 'Apple Books', aiNarration: 'Via distributor — check at upload', humanNarration: 'Yes' },
      ],
      translation: [
        { route: 'Kindle Translate (KDP, invite-only beta)', note: 'Free AI translation of eligible KDP ebooks from English, French, German, Italian, Portuguese or Spanish; translations can be in KDP Select. No API — set up in the KDP Bookshelf. Checked on KDP help 2026-11-16.' },
        { route: 'This app (DeepL or Claude) + native reviewer', note: 'Any language, any store, ebook and print. Chapter by chapter with your glossary; a native reviewer approves before publishing.' },
        { route: 'Foreign-rights licence', note: 'A local publisher translates, prints and sells; you earn an advance and royalties. Track it in the Worldwide tab.' },
      ],
    });
  });

  app.get('/api/audio/voices', auth, async (req, res) => {
    try { res.json({ ok: true, voices: await ai.elevenLabsVoices() }); } catch (e) { res.status(400).json({ error: e.message }); }
  });

  async function speakLong(text, voiceId, bookId) {
    const parts = ai.chunkText(text, 4500);
    const bufs = [];
    for (const p of parts) bufs.push(await ai.elevenLabsSpeak(p, voiceId, { bookId }));
    return Buffer.concat(bufs);
  }

  // One passage or chapter (any length — split and joined).
  app.post('/api/books/:id/audio', auth, async (req, res) => {
    const book = bookOr404(req, res);
    if (!book) return;
    const { text, voiceId, chapter } = req.body || {};
    if (!text || !voiceId) return res.status(400).json({ error: 'Text and a voice are required.' });
    try {
      const audio = await speakLong(text, voiceId, book.id);
      const saved = manuscript.saveFile(book.id, 'audio', `sample-${chapter || 1}-${Date.now()}.mp3`, audio, `Sample, voice ${voiceId}`);
      res.json({ ok: true, fileId: saved.id, bytes: audio.length });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  // Whole book, chapter by chapter, in the background.
  app.post('/api/books/:id/audio-book', auth, (req, res) => {
    const book = bookOr404(req, res);
    if (!book) return;
    const { voiceId } = req.body || {};
    if (!voiceId) return res.status(400).json({ error: 'Pick a voice.' });
    const n = db.get('SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(text)),0) AS chars FROM chapters WHERE book_id = ?', [book.id]);
    if (!n.n) return res.status(400).json({ error: 'No chapters yet — the manuscript arrives with the book handoff, or upload it on the Editions tab.' });
    const jobId = jobs.queue(book.id, 'audio_book', { voiceId });
    const est = ai.estimateCost('elevenlabs', n.chars, 0);
    res.json({ ok: true, jobId, chapters: n.n, characters: n.chars, estCostUsd: Math.round(est * 100) / 100, note: `Narrating ${n.n} chapters (${n.chars.toLocaleString()} characters, roughly $${est.toFixed(2)} at the estimated rate). Budgets apply.` });
  });

  // A short passage (old behaviour, glossary fixed).
  app.post('/api/books/:id/translate', auth, async (req, res) => {
    const book = bookOr404(req, res);
    if (!book) return;
    const { text, targetLang, glossary } = req.body || {};
    if (!text || !targetLang) return res.status(400).json({ error: 'Text and a target language are required.' });
    const out = await ai.translateText(text, targetLang, { glossary, bookId: book.id, faith: isFaith(book) });
    res.json({ ok: true, translated: out.text, provider: out.provider, local: !!out.local, note: `${out.note ? out.note + ' ' : ''}A native-speaker review is required before publishing this translation.` });
  });

  // Whole book into a new translated edition, in the background.
  app.post('/api/books/:id/translate-book', auth, (req, res) => {
    const book = bookOr404(req, res);
    if (!book) return;
    const { language, glossary, nativeReviewer, format } = req.body || {};
    if (!language) return res.status(400).json({ error: 'Pick a language.' });
    const n = db.get('SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(text)),0) AS chars FROM chapters WHERE book_id = ?', [book.id]);
    if (!n.n) return res.status(400).json({ error: 'No chapters yet — upload the manuscript on the Editions tab first.' });
    let ed = db.get("SELECT * FROM editions WHERE book_id = ? AND language = ? AND format IN ('ebook','translation')", [book.id, language]);
    if (!ed) {
      const id = db.exec("INSERT INTO editions (book_id, format, language, status) VALUES (?, ?, ?, 'translating')", [book.id, format || 'ebook', language]);
      ed = db.get('SELECT * FROM editions WHERE id = ?', [id]);
    }
    const jobId = jobs.queue(book.id, 'translate_book', { editionId: ed.id, language, glossary: glossary || '', nativeReviewer: nativeReviewer || '' });
    res.json({ ok: true, jobId, editionId: ed.id, chapters: n.n, note: `Translating ${n.n} chapters into ${language}. A native reviewer must approve before publishing${isFaith(book) ? '; scripture is marked [VERIFY SCRIPTURE]' : ''}.` });
  });

  app.get('/api/editions/:id/translation', auth, (req, res) => {
    const ed = db.get('SELECT * FROM editions WHERE id = ?', [req.params.id]);
    if (!ed) return res.status(404).json({ error: 'Edition not found.' });
    const total = db.get('SELECT COUNT(*) AS n FROM chapters WHERE book_id = ?', [ed.book_id]).n;
    res.json({ edition: ed, total, chapters: db.query('SELECT id, chapter_no, status, provider, LENGTH(text) AS chars FROM translations WHERE edition_id = ? ORDER BY chapter_no', [ed.id]) });
  });

  app.get('/api/editions/:id/translation.txt', auth, (req, res) => {
    const ed = db.get('SELECT * FROM editions WHERE id = ?', [req.params.id]);
    if (!ed) return res.status(404).json({ error: 'Edition not found.' });
    const rows = db.query('SELECT t.text, c.title FROM translations t LEFT JOIN chapters c ON c.book_id = t.book_id AND c.no = t.chapter_no WHERE t.edition_id = ? ORDER BY t.chapter_no', [ed.id]);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="translation-${mk.slugify(ed.language)}-${ed.book_id}.txt"`);
    res.send(rows.map((r) => r.text).join('\n\n\n'));
  });

  app.put('/api/translations/:id', auth, (req, res) => {
    const t = db.get('SELECT * FROM translations WHERE id = ?', [req.params.id]);
    if (!t) return res.status(404).json({ error: 'Not found.' });
    db.exec('UPDATE translations SET text = ?, status = ? WHERE id = ?', [req.body?.text ?? t.text, req.body?.status ?? t.status, t.id]);
    res.json({ ok: true });
  });

  // ================================================ JOB HANDLERS ==========
  jobs.register('content_batch', async (job, payload, progress) => {
    const book = db.get('SELECT * FROM books WHERE id = ?', [job.book_id]);
    if (!book) return;
    const types = (payload.types && payload.types.length ? payload.types : kitTypesFor(imprintOf(book))).filter((t) => ctx.ALL_CONTENT_TYPES.includes(t));
    // Resume: skip types already made by this job.
    const doneKey = `job:${job.id}`;
    let i = 0;
    for (const type of types) {
      i++;
      if (db.get('SELECT id FROM content WHERE book_id = ? AND type = ? AND provider LIKE ?', [book.id, type, `%${doneKey}`])) continue;
      progress(`${i}/${types.length}: ${type}`);
      const out = await generateContentFor(book, type, payload.channel || '', { lang: payload.lang || 'English' });
      saveContent(book.id, type, payload.channel || '', { ...out, provider: `${out.provider} ${doneKey}` }, payload.lang || 'English');
    }
    if (payload.reason === 'launch') scheduler.notify('content', `Launch content drafted: ${book.title}`, `${types.length} pieces are waiting for approval in the Content tab. Approved posts are scheduled automatically one week before launch.`, book.id);
  });

  jobs.register('launch_schedule_posts', async (job, payload) => {
    const book = db.get('SELECT * FROM books WHERE id = ?', [job.book_id]);
    if (!book) return;
    const made = autoSchedule(book, payload.launchDate || book.launch_date || mk.today());
    scheduler.notify('calendar', made.length ? `${made.length} launch posts scheduled: ${book.title}` : `No approved posts to schedule yet: ${book.title}`,
      made.length ? 'See the Calendar tab. Connected channels post automatically; others appear in Today to post by hand.' : 'Approve the social posts, email sequence and LinkedIn article in the Content tab, then press "Auto-schedule" on the Calendar tab.', book.id);
  });

  jobs.register('localize_metadata', async (job, payload, progress) => {
    const book = db.get('SELECT * FROM books WHERE id = ?', [job.book_id]);
    if (!book) return;
    const imp = imprintOf(book);
    const meta = db.get('SELECT * FROM metadata WHERE book_id = ?', [book.id]) || {};
    let i = 0;
    for (const lang of payload.languages || []) {
      i++;
      if (db.get("SELECT id FROM localized_metadata WHERE book_id = ? AND lang = ? AND description != ''", [book.id, lang])) continue;
      progress(`${i}/${payload.languages.length}: ${lang}`);
      const markets = global.MARKETPLACES.filter((m) => m.language === lang || (lang.startsWith(m.language))).map((m) => m.name).join(', ') || lang;
      const p = mk.fillPrompt(promptText('localize_metadata').text, { language: lang, market: markets, imprint: imp?.name || '', title: book.title });
      const out = await ai.completeTask({ task: 'localize_metadata', bookId: book.id, system: `Voice: ${imp?.voice_profile || ''}`, prompt: `${p}\n\nTitle: ${book.title}\nSubtitle: ${book.subtitle || ''}\nAuthor: ${book.author || imp?.author_name || ''}\nDescription: ${meta.description || book.back_cover || ''}\nKeywords: ${meta.keywords || '[]'}\nCategories: ${meta.categories || '[]'}` });
      if (out.local) throw new Error('No AI provider is connected — add a key in Settings, then retry this job.');
      let data = {};
      try { data = JSON.parse(String(out.text).replace(/^```(json)?/m, '').replace(/```\s*$/m, '').trim().replace(/^[^{]*/, '').replace(/[^}]*$/, '')); } catch { data = { description: out.text }; }
      db.exec("INSERT INTO localized_metadata (book_id, lang, markets, title, subtitle, description, keywords, categories, status, provider) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?) ON CONFLICT(book_id, lang) DO UPDATE SET title = excluded.title, subtitle = excluded.subtitle, description = excluded.description, keywords = excluded.keywords, categories = excluded.categories, markets = excluded.markets, status = 'draft', provider = excluded.provider, updated_at = datetime('now')", [
        book.id, lang, markets, data.title || '', data.subtitle || '', data.description || '', JSON.stringify(data.keywords || []), JSON.stringify(data.categories || []), out.provider,
      ]);
    }
    scheduler.notify('localize', `Localized metadata drafted: ${book.title}`, `${(payload.languages || []).join(', ')} — needs a native reviewer before use.`, book.id);
  });

  jobs.register('keyword_research', async (job, payload) => {
    const book = db.get('SELECT * FROM books WHERE id = ?', [job.book_id]);
    if (!book) return;
    await runResearch(book, payload.kind || 'keywords', payload.market || 'US');
    scheduler.notify('research', `Keyword research ready: ${book.title}`, 'See the Worldwide tab → Research.', book.id);
  });

  jobs.register('audio_book', async (job, payload, progress) => {
    const book = db.get('SELECT * FROM books WHERE id = ?', [job.book_id]);
    if (!book) return;
    const chapters = db.query('SELECT * FROM chapters WHERE book_id = ? ORDER BY no', [book.id]);
    let i = 0;
    for (const c of chapters) {
      i++;
      const note = `Audiobook chapter ${c.no} (job ${job.id}, voice ${payload.voiceId})`;
      if (db.get('SELECT id FROM files WHERE book_id = ? AND type = ? AND licence_note = ?', [book.id, 'audio', note])) continue;
      progress(`Chapter ${i}/${chapters.length}`);
      const audio = await speakLong(`${c.title}.\n\n${c.text}`, payload.voiceId, book.id);
      manuscript.saveFile(book.id, 'audio', `audiobook-${String(c.no).padStart(2, '0')}.mp3`, audio, note);
    }
    scheduler.notify('audio', `Audiobook narrated: ${book.title}`, `${chapters.length} chapter files are on the Editions tab. Check the store rules for AI narration before uploading.`, book.id);
  });

  jobs.register('translate_book', async (job, payload, progress) => {
    const book = db.get('SELECT * FROM books WHERE id = ?', [job.book_id]);
    if (!book) return;
    const chapters = db.query('SELECT * FROM chapters WHERE book_id = ? ORDER BY no', [book.id]);
    let i = 0;
    for (const c of chapters) {
      i++;
      if (db.get('SELECT id FROM translations WHERE edition_id = ? AND chapter_no = ?', [payload.editionId, c.no])) continue;
      progress(`Chapter ${i}/${chapters.length}`);
      const pieces = ai.chunkText(`${c.title}\n\n${c.text}`, 12000);
      const outParts = [];
      let provider = '';
      for (const piece of pieces) {
        const out = await ai.translateText(piece, payload.language, { glossary: payload.glossary, bookId: book.id, faith: isFaith(book) });
        if (out.local) throw new Error('No translation provider is connected (DeepL or an AI key) — add one in Settings, then retry this job.');
        outParts.push(out.text); provider = out.provider;
      }
      db.exec('INSERT INTO translations (book_id, edition_id, lang, chapter_no, text, provider, status) VALUES (?, ?, ?, ?, ?, ?, ?)', [book.id, payload.editionId, payload.language, c.no, outParts.join('\n\n'), provider, 'machine']);
    }
    db.exec("UPDATE editions SET status = 'needs native review' WHERE id = ?", [payload.editionId]);
    db.exec('INSERT INTO files (book_id, type, path, licence_note) VALUES (?, ?, ?, ?)', [book.id, 'translation', `edition-${payload.editionId}`, `Native reviewer: ${payload.nativeReviewer || 'not yet assigned — required before publishing'}`]);
    scheduler.notify('translation', `Translation drafted (${payload.language}): ${book.title}`, 'Download it from the Editions tab and send it to the native reviewer.', book.id);
  });
};
