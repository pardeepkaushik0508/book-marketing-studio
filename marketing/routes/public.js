// Public, no-login routes:
//   /b/:slug          smart link — sends each reader to their own Amazon
//                     store (or a chosen store) and counts the click
//   /p/:slug          book page — cover, localized description, buy
//                     buttons for every live store, endorsements, and the
//                     free-chapter signup (double opt-in)
//   /confirm/:token   confirms a signup (double opt-in)
//   /u/:token         unsubscribe (GET shows a button; POST = one-click)
//   /api/funnel/signup  JSON signup used by imprint websites
// No scripts on these pages; strict headers come from server.js.
const fs = require('fs');
const path = require('path');
const express = require('express');
const global = require('../lib/global');
const { randomToken } = require('../lib/crypto');

const BOT = /bot|crawler|spider|preview|facebookexternalhit|slackbot|discordbot|whatsapp|linkedinbot|embedly|monitor|curl|wget/i;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,253}\.[a-z]{2,}$/i;

module.exports = function publicRoutes(app, ctx) {
  const { db, ai, mk, scheduler, rateLimit, imprintOf, publicBase, getSetting } = ctx;
  const signupLimit = rateLimit(5, 60 * 60 * 1000, 'Too many signups from this address — try again later.');
  const form = express.urlencoded({ extended: false, limit: '20kb' });

  const bookBySlug = (slug) => db.get('SELECT * FROM books WHERE slug = ?', [String(slug || '').toLowerCase()]);

  function liveListings(book) {
    return db.query("SELECT l.*, e.format, e.language FROM listings l JOIN editions e ON e.id = l.edition_id WHERE e.book_id = ? AND l.status IN ('live','pre-order') ORDER BY CASE e.format WHEN 'ebook' THEN 0 WHEN 'paperback' THEN 1 WHEN 'hardcover' THEN 2 ELSE 3 END", [book.id]);
  }

  function amazonAsin(book) {
    const l = db.get("SELECT l.asin FROM listings l JOIN editions e ON e.id = l.edition_id WHERE e.book_id = ? AND l.store = 'KDP' AND l.asin != '' ORDER BY CASE e.format WHEN 'ebook' THEN 0 WHEN 'paperback' THEN 1 ELSE 2 END LIMIT 1", [book.id]);
    return l ? l.asin : '';
  }

  // ---- smart link ----
  app.get('/b/:slug', (req, res) => {
    const book = bookBySlug(req.params.slug);
    if (!book) return res.status(404).send('Book not found.');
    const country = global.visitorCountry(req);
    const channel = String(req.query.ch || '').slice(0, 40);
    const want = String(req.query.s || '').toLowerCase();
    let url = '', store = '';
    if (want && want !== 'amazon') {
      const l = liveListings(book).find((x) => mk.slugify(x.store).startsWith(want) && x.live_link);
      if (l) { url = l.live_link; store = l.store; }
    }
    if (!url && (!want || want === 'amazon')) {
      const asin = amazonAsin(book);
      if (asin) { const mp = global.marketplaceForCountry(country); url = global.amazonUrl(asin, mp); store = `Amazon ${mp.code}`; }
    }
    if (!url) { url = `/p/${book.slug}`; store = 'book page'; }
    if (!BOT.test(req.get('user-agent') || '')) {
      try { db.exec('INSERT INTO link_clicks (book_id, channel, country, store) VALUES (?, ?, ?, ?)', [book.id, channel, country, store]); } catch { /* never block the redirect */ }
    }
    res.redirect(302, url);
  });

  // ---- book page ----
  function pageShell({ title, body, meta = '', lang = 'en' }) {
    return `<!DOCTYPE html><html lang="${esc(lang)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title>${meta}
<style>
:root{--ink:#1d1a16;--muted:#6b645a;--line:#e3dccf;--accent:#1d4d2b;--bg:#faf8f3}
*{box-sizing:border-box}body{margin:0;font-family:Georgia,'Times New Roman',serif;background:var(--bg);color:var(--ink);line-height:1.55}
.wrap{max-width:880px;margin:0 auto;padding:2rem 1.25rem 3rem}
.hero{display:grid;grid-template-columns:minmax(160px,260px) 1fr;gap:2rem;align-items:start}
@media(max-width:640px){.hero{grid-template-columns:1fr}.cover{max-width:220px;margin:0 auto}}
.cover img{width:100%;border-radius:4px;box-shadow:0 10px 30px rgba(0,0,0,.18)}
h1{font-size:2rem;line-height:1.15;margin:0 0 .25rem}h2{font-size:1.15rem;margin:2rem 0 .5rem}
.sub{font-size:1.15rem;color:var(--muted);margin:0 0 .75rem}.by{font-family:system-ui,sans-serif;font-size:.95rem;color:var(--muted)}
.buy{display:flex;flex-wrap:wrap;gap:.5rem;margin:1.25rem 0}
.buy a{font-family:system-ui,sans-serif;text-decoration:none;padding:.6rem 1rem;border-radius:6px;border:1px solid var(--accent);color:var(--accent);font-size:.95rem}
.buy a.primary{background:var(--accent);color:#fff}
blockquote{margin:1rem 0;padding:.25rem 1rem;border-left:3px solid var(--line);color:#3b362f}
.desc p{margin:.6rem 0}
form{font-family:system-ui,sans-serif;background:#fff;border:1px solid var(--line);border-radius:10px;padding:1.25rem;margin-top:2rem}
label{display:block;margin:.5rem 0;font-size:.92rem}input[type=email],input[type=text]{width:100%;padding:.55rem;border:1px solid var(--line);border-radius:6px;font:inherit}
button{background:var(--accent);color:#fff;border:0;border-radius:6px;padding:.6rem 1.1rem;font:inherit;cursor:pointer}
.hp{position:absolute;left:-9999px}.small{font-size:.8rem;color:var(--muted)}
footer{margin-top:3rem;font-family:system-ui,sans-serif;font-size:.8rem;color:var(--muted)}
.msg{font-family:system-ui,sans-serif;background:#fff;border:1px solid var(--line);border-radius:10px;padding:1.5rem;max-width:520px;margin:15vh auto}
</style></head><body>${body}</body></html>`;
  }

  function pickLocale(book, req) {
    const want = String(req.query.lang || '').toLowerCase();
    const langs = db.query("SELECT * FROM localized_metadata WHERE book_id = ? AND status = 'approved'", [book.id]);
    if (!langs.length) return null;
    const codes = { german: 'de', french: 'fr', spanish: 'es', italian: 'it', 'portuguese (brazil)': 'pt', dutch: 'nl', japanese: 'ja', polish: 'pl', swedish: 'sv', hindi: 'hi' };
    const al = String(req.get('accept-language') || '').toLowerCase();
    return langs.find((l) => want && (l.lang.toLowerCase().startsWith(want) || codes[l.lang.toLowerCase()] === want))
      || langs.find((l) => !want && codes[l.lang.toLowerCase()] && al.startsWith(codes[l.lang.toLowerCase()])) || null;
  }

  app.get('/p/:slug', (req, res) => {
    const book = bookBySlug(req.params.slug);
    if (!book || !book.landing_enabled) return res.status(404).send(pageShell({ title: 'Not found', body: '<div class="msg">This book page is not available.</div>' }));
    const imp = imprintOf(book);
    const meta = db.get('SELECT * FROM metadata WHERE book_id = ?', [book.id]) || {};
    const loc = pickLocale(book, req);
    const title = loc?.title || book.title;
    const subtitle = loc?.subtitle || book.subtitle;
    const description = loc?.description || meta.description || book.back_cover || '';
    const author = book.author || imp?.author_name || '';
    const listings = liveListings(book);
    const stores = [];
    if (amazonAsin(book)) stores.push({ label: 'Amazon', href: `/b/${book.slug}?s=amazon&ch=book-page`, primary: true });
    const seen = new Set(['KDP']);
    for (const l of listings) if (!seen.has(l.store) && l.live_link) { seen.add(l.store); stores.push({ label: l.store.replace(' / ACX', '').replace(' / Findaway Voices', ''), href: `/b/${book.slug}?s=${mk.slugify(l.store)}&ch=book-page` }); }
    const quotes = db.query("SELECT e.quote, c.name, c.outlet FROM endorsements e LEFT JOIN contacts c ON c.id = e.contact_id WHERE e.book_id = ? AND e.permission = 1 AND e.quote != '' LIMIT 4", [book.id]);
    const hasChapters = db.get('SELECT COUNT(*) AS n FROM chapters WHERE book_id = ?', [book.id]).n > 0;
    const base = publicBase(req);
    const url = `${base}/p/${book.slug}`;
    const coverUrl = book.cover_path ? `${base}/p/${book.slug}/cover` : '';
    const jsonLd = { '@context': 'https://schema.org', '@type': 'Book', name: book.title, author: { '@type': 'Person', name: author }, publisher: imp ? { '@type': 'Organization', name: imp.publisher_name || imp.name } : undefined, description: description.slice(0, 500), url, image: coverUrl || undefined, inLanguage: book.language || 'en', workExample: db.query("SELECT isbn, format FROM editions WHERE book_id = ? AND isbn != ''", [book.id]).map((e) => ({ '@type': 'Book', isbn: e.isbn, bookFormat: e.format === 'ebook' ? 'https://schema.org/EBook' : e.format === 'audiobook' ? 'https://schema.org/AudiobookFormat' : 'https://schema.org/Paperback' })) };
    const metaTags = `<meta name="description" content="${esc(description.slice(0, 160))}"><link rel="canonical" href="${esc(url)}">
<meta property="og:type" content="book"><meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(description.slice(0, 200))}"><meta property="og:url" content="${esc(url)}">${coverUrl ? `<meta property="og:image" content="${esc(coverUrl)}">` : ''}<meta name="twitter:card" content="summary_large_image">
<script type="application/ld+json">${JSON.stringify(jsonLd).replace(/</g, '\\u003c')}</script>`;
    const paras = description.split(/\n\s*\n|\n/).filter((p) => p.trim()).map((p) => `<p>${esc(p)}</p>`).join('');
    const body = `<div class="wrap">
<div class="hero">
  <div class="cover">${book.cover_path ? `<img src="/p/${esc(book.slug)}/cover" alt="Cover of ${esc(title)}">` : ''}</div>
  <div>
    <h1>${esc(title)}</h1>${subtitle ? `<p class="sub">${esc(subtitle)}</p>` : ''}
    <p class="by">by ${esc(author)}${imp ? ` · ${esc(imp.name)}` : ''}</p>
    ${stores.length ? `<div class="buy">${stores.map((s) => `<a class="${s.primary ? 'primary' : ''}" href="${esc(s.href)}" rel="nofollow">${esc(s.label)}</a>`).join('')}</div>` : '<p class="by">Coming soon.</p>'}
    <div class="desc">${paras}</div>
  </div>
</div>
${quotes.length ? `<h2>What readers are saying</h2>${quotes.map((q) => `<blockquote>“${esc(q.quote)}”<br><span class="small">— ${esc(q.name || '')}${q.outlet ? `, ${esc(q.outlet)}` : ''}</span></blockquote>`).join('')}` : ''}
${hasChapters ? `<form method="post" action="/p/${esc(book.slug)}/signup">
  <strong>Read the first chapter free</strong>
  <p class="small">Join ${esc(author)}'s reader list and get the first chapter by email. Unsubscribe any time.</p>
  <label>First name <input type="text" name="name" maxlength="80" autocomplete="given-name"></label>
  <label>Email <input type="email" name="email" required maxlength="200" autocomplete="email"></label>
  <label class="hp">Leave this empty <input type="text" name="website" tabindex="-1" autocomplete="off"></label>
  <label><input type="checkbox" name="consent" value="1" required> Yes, email me the free chapter and occasional news about ${esc(author)}'s books.</label>
  <button type="submit">Send me the chapter</button>
</form>` : ''}
<footer>© ${new Date().getFullYear()} ${esc(imp?.publisher_name || imp?.name || author)}. Your email is used only for the reader list; we never sell it.</footer>
</div>`;
    res.send(pageShell({ title: `${title} — ${author}`, body, meta: metaTags, lang: loc ? (loc.lang.slice(0, 2).toLowerCase()) : 'en' }));
  });

  app.get('/p/:slug/cover', (req, res) => {
    const book = bookBySlug(req.params.slug);
    if (!book || !book.cover_path || !fs.existsSync(book.cover_path)) return res.status(404).end();
    // Covers may be SVG: serve sandboxed so no script can ever run.
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox");
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.sendFile(path.resolve(book.cover_path));
  });

  // ---- signup (double opt-in) ----
  async function signup({ name, email, bookId, consent, website, req }) {
    if (website) return { ok: true, message: 'Thank you.' }; // honeypot: silently ignore bots
    const em = String(email || '').toLowerCase().trim();
    if (!EMAIL_RE.test(em)) return { status: 400, error: 'Please enter a valid email address.' };
    if (!consent) return { status: 400, error: 'Email and consent are required.' };
    const doubleOptIn = getSetting('double_opt_in', '1') === '1';
    const existing = db.get("SELECT * FROM contacts WHERE email = ? AND type = 'reader'", [em]);
    if (existing && existing.status === 'confirmed') return { ok: true, id: existing.id, message: 'Already on the list — thank you.' };
    const confirmToken = doubleOptIn ? randomToken(16) : '';
    const unsub = existing?.unsub_token || randomToken(16);
    const book = bookId ? db.get('SELECT * FROM books WHERE id = ?', [bookId]) : null;
    let id = existing?.id;
    if (existing) {
      db.exec("UPDATE contacts SET name = COALESCE(NULLIF(?, ''), name), consent = 1, consent_date = date('now'), status = ?, confirm_token = ?, unsub_token = ? WHERE id = ?", [String(name || '').slice(0, 80), doubleOptIn ? 'pending' : 'confirmed', confirmToken, unsub, existing.id]);
    } else {
      id = db.exec("INSERT INTO contacts (name, email, type, consent, consent_date, status, confirm_token, unsub_token, imprint_id, source, history) VALUES (?, ?, 'reader', 1, date('now'), ?, ?, ?, ?, 'free chapter funnel', ?)", [
        String(name || '').slice(0, 80), em, doubleOptIn ? 'pending' : 'confirmed', confirmToken, unsub, book?.imprint_id || null, book ? `Signed up on the page for "${book.title}" (book ${book.id}).` : '',
      ]);
    }
    const base = publicBase(req);
    if (doubleOptIn) {
      try {
        await ai.sendEmail({
          to: em, subject: book ? `Confirm to get your free chapter of ${book.title}` : 'Please confirm your email',
          text: `Hi${name ? ' ' + name : ''},\n\nPlease confirm you want to join the reader list${book ? ` and get the first chapter of "${book.title}"` : ''}:\n${base}/confirm/${confirmToken}\n\nIf you did not sign up, ignore this email — nothing else will be sent.`,
        });
      } catch (e) {
        scheduler.notify('signup', `New signup waiting: confirmation email not sent`, `${em} — ${e.message}. Connect Brevo or Gmail so double opt-in emails go out.`, book?.id || null);
      }
      return { ok: true, id, pending: true, message: 'Almost there — check your email and click the confirmation link.' };
    }
    ai.syncSubscriber({ email: em, name }).catch(() => {});
    return { ok: true, id, message: 'Thank you — you are on the list.' };
  }

  app.post('/api/funnel/signup', signupLimit, async (req, res) => {
    const r = await signup({ ...(req.body || {}), req });
    if (r.error) return res.status(r.status || 400).json({ error: r.error });
    res.json(r);
  });

  app.post('/p/:slug/signup', signupLimit, form, async (req, res) => {
    const book = bookBySlug(req.params.slug);
    if (!book) return res.status(404).send('Not found.');
    const r = await signup({ name: req.body.name, email: req.body.email, consent: req.body.consent === '1', website: req.body.website, bookId: book.id, req });
    res.status(r.error ? 400 : 200).send(pageShell({ title: book.title, body: `<div class="msg"><h1 style="font-size:1.4rem">${r.error ? 'Something is missing' : 'Thank you'}</h1><p>${esc(r.error || r.message)}</p><p><a href="/p/${esc(book.slug)}">Back to the book</a></p></div>` }));
  });

  app.get('/confirm/:token', (req, res) => {
    const c = req.params.token && db.get("SELECT * FROM contacts WHERE confirm_token = ? AND confirm_token != ''", [req.params.token]);
    if (!c) return res.status(404).send(pageShell({ title: 'Link expired', body: '<div class="msg"><h1 style="font-size:1.4rem">This link has expired or was already used.</h1></div>' }));
    db.exec("UPDATE contacts SET status = 'confirmed', confirm_token = '', consent_date = date('now'), history = COALESCE(history,'') || ? WHERE id = ?", [`\nConfirmed email ${mk.today()}.`, c.id]);
    ai.syncSubscriber({ email: c.email, name: c.name }).catch(() => {});
    const m = String(c.history || '').match(/\(book (\d+)\)/);
    const book = m ? db.get('SELECT * FROM books WHERE id = ?', [m[1]]) : null;
    const chapterLink = book && db.get('SELECT 1 FROM chapters WHERE book_id = ?', [book.id]) ? `/p/${book.slug}/free/${c.unsub_token}` : '';
    if (chapterLink) {
      ai.sendEmail({ to: c.email, subject: `Your free chapter of ${book.title}`, text: `Here is your free chapter:\n${publicBase(req)}${chapterLink}\n\nEnjoy it!\n\nUnsubscribe any time: ${publicBase(req)}/u/${c.unsub_token}`, unsubscribeUrl: `${publicBase(req)}/u/${c.unsub_token}` }).catch(() => {});
    }
    res.send(pageShell({ title: 'Confirmed', body: `<div class="msg"><h1 style="font-size:1.4rem">You're in — thank you!</h1>${chapterLink ? `<p><a href="${esc(chapterLink)}">Read your free chapter now</a> (we've emailed the link too).</p>` : '<p>Watch your inbox.</p>'}</div>` }));
  });

  app.get('/p/:slug/free/:token', (req, res) => {
    const book = bookBySlug(req.params.slug);
    const c = book && db.get("SELECT * FROM contacts WHERE unsub_token = ? AND status = 'confirmed'", [req.params.token]);
    if (!book || !c) return res.status(404).send(pageShell({ title: 'Not found', body: '<div class="msg">This link is not valid.</div>' }));
    const ch = db.get('SELECT * FROM chapters WHERE book_id = ? ORDER BY no LIMIT 1', [book.id]);
    if (!ch) return res.status(404).send(pageShell({ title: book.title, body: '<div class="msg">The free chapter is not available yet.</div>' }));
    res.send(pageShell({ title: `${ch.title} — ${book.title}`, body: `<div class="wrap" style="max-width:680px"><p class="by">${esc(book.title)}</p><h1>${esc(ch.title)}</h1>${ch.text.split(/\n\s*\n/).map((p) => `<p>${esc(p)}</p>`).join('')}<p style="margin-top:2rem"><a href="/p/${esc(book.slug)}">Get the whole book</a></p></div>` }));
  });

  // ---- unsubscribe ----
  function unsubscribe(token) {
    const c = token && db.get("SELECT * FROM contacts WHERE unsub_token = ? AND unsub_token != ''", [token]);
    if (!c) return null;
    db.exec("UPDATE contacts SET status = 'unsubscribed', consent = 0, history = COALESCE(history,'') || ? WHERE id = ?", [`\nUnsubscribed ${mk.today()}.`, c.id]);
    ai.syncSubscriber({ email: c.email, unsubscribe: true }).catch(() => {});
    return c;
  }
  app.get('/u/:token', (req, res) => {
    const c = db.get("SELECT id FROM contacts WHERE unsub_token = ? AND unsub_token != ''", [req.params.token]);
    if (!c) return res.status(404).send(pageShell({ title: 'Unsubscribe', body: '<div class="msg">This link is not valid.</div>' }));
    res.send(pageShell({ title: 'Unsubscribe', body: `<div class="msg"><h1 style="font-size:1.4rem">Unsubscribe?</h1><form method="post" action="/u/${esc(req.params.token)}" style="border:0;padding:0;margin:0"><button type="submit">Yes, unsubscribe me</button></form></div>` }));
  });
  // One-click (RFC 8058) and the button above both POST here.
  app.post('/u/:token', form, (req, res) => {
    const c = unsubscribe(req.params.token);
    if (!c) return res.status(404).send('Not found.');
    res.send(pageShell({ title: 'Unsubscribed', body: '<div class="msg"><h1 style="font-size:1.4rem">You have been unsubscribed.</h1><p>No more emails will be sent.</p></div>' }));
  });
};
