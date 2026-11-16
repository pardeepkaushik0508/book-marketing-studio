// Smoke tests for Book Marketing Studio v2.2.
// Usage: npm test   (throwaway DB in ./data/test.db, no network keys needed)
const fs = require('fs');
const path = require('path');
const assert = require('assert');

process.env.DB_PATH = path.join(__dirname, '..', 'data', 'test.db');
process.env.HANDOFF_TOKEN = 'test-handoff-token';
process.env.SESSION_SECRET = 'test-secret';
process.env.ENCRYPTION_KEY = 'a'.repeat(64);

const TEST_DB = process.env.DB_PATH;
for (const f of [TEST_DB, TEST_DB + '.tmp']) if (fs.existsSync(f)) fs.unlinkSync(f);
const BOOKS_DIR = path.join(path.dirname(TEST_DB), 'books');

const db = require('../lib/db');
const mk = require('../lib/marketing');
const ai = require('../lib/ai');
const jobs = require('../lib/jobs');
const scheduler = require('../lib/scheduler');
const global = require('../lib/global');
const JSZip = require('jszip');
const ExcelJS = require('exceljs');
let app;

let passed = 0;
function ok(name, cond) {
  assert.ok(cond, name);
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const PORT = 3311;
const BASE = `http://127.0.0.1:${PORT}`;
let adminCookie = '', memberCookie = '', csrf = '', memberCsrf = '';

async function req(p, opts = {}) {
  const res = await fetch(BASE + p, { redirect: 'manual', ...opts, headers: { 'content-type': 'application/json', 'x-csrf-token': csrf, ...(opts.headers || {}) } });
  const text = await res.text();
  let body = {};
  try { body = JSON.parse(text); } catch { body = { _text: text }; }
  return { status: res.status, body, headers: res.headers, text };
}
const asAdmin = (p, opts = {}) => req(p, { ...opts, headers: { cookie: adminCookie, ...(opts.headers || {}) } });
const asMember = (p, opts = {}) => req(p, { ...opts, headers: { cookie: memberCookie, 'x-csrf-token': memberCsrf, ...(opts.headers || {}) } });
const post = (p, body) => asAdmin(p, { method: 'POST', body: JSON.stringify(body || {}) });
const put = (p, body) => asAdmin(p, { method: 'PUT', body: JSON.stringify(body || {}) });

async function runJob(id) {
  for (let i = 0; i < 20; i++) {
    const j = db.get('SELECT * FROM jobs WHERE id = ?', [id]);
    if (['done', 'failed', 'cancelled'].includes(j.status) || (j.status === 'queued' && j.error)) return j;
    db.exec("UPDATE jobs SET run_after = '' WHERE id = ?", [id]);
    await jobs.runNext();
  }
  return db.get('SELECT * FROM jobs WHERE id = ?', [id]);
}

async function main() {
  await db.init(TEST_DB);
  app = require('../server');
  const server = await new Promise((resolve) => { const s = app.listen(PORT, '127.0.0.1', () => resolve(s)); });
  try {
    // ---- auth + roles ----
    console.log('auth roles');
    let r = await req('/api/auth/first-run');
    ok('first-run detected on an empty database', r.body.firstRun === true);
    r = await req('/api/auth/register', { method: 'POST', body: JSON.stringify({ name: 'Justin', email: 'justin@example.com', password: 'adminpass1' }) });
    ok('first account registers as admin', r.status === 200 && r.body.ok);
    r = await req('/api/auth/register', { method: 'POST', body: JSON.stringify({ name: 'X', email: 'x@example.com', password: 'adminpass1' }) });
    ok('second registration refused (admin creates accounts)', r.status === 403);
    r = await req('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: 'justin@example.com', password: 'wrongpass' }) });
    ok('wrong password rejected', r.status === 401);
    r = await req('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: 'Justin@Example.com', password: 'adminpass1' }) });
    ok('admin logs in (email is case-insensitive)', r.status === 200 && r.body.account.isAdmin);
    adminCookie = r.headers.get('set-cookie').split(';')[0];
    csrf = r.body.csrfToken;
    ok('session cookie is HttpOnly + SameSite', /HttpOnly/.test(r.headers.get('set-cookie')) && /SameSite=Lax/.test(r.headers.get('set-cookie')));
    r = await post('/api/admin/accounts', { name: 'Family', email: 'fam@example.com', tempPassword: 'memberpass1', role: 'member' });
    ok('admin creates a member account', r.status === 200 && r.body.ok);
    r = await req('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: 'fam@example.com', password: 'memberpass1' }) });
    ok('member logs in with temporary password', r.status === 200 && r.body.account.mustChangePassword);
    memberCookie = r.headers.get('set-cookie').split(';')[0];
    memberCsrf = r.body.csrfToken;
    r = await asMember('/api/settings/providers');
    ok('member cannot open the API vault', r.status === 403);
    r = await asMember('/api/admin/accounts');
    ok('member cannot list accounts', r.status === 403);
    r = await post('/api/admin/accounts/2/disable');
    ok('admin disables a member', r.status === 200 && r.body.ok);
    r = await req('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: 'fam@example.com', password: 'memberpass1' }) });
    ok('disabled member cannot sign in', r.status === 403);
    await post('/api/admin/accounts/2/enable');
    r = await req('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: 'fam@example.com', password: 'memberpass1' }) });
    memberCookie = r.headers.get('set-cookie').split(';')[0];
    memberCsrf = r.body.csrfToken;
    ok('re-enabled member signs in again', r.status === 200);

    console.log('security');
    r = await asAdmin('/api/health');
    ok('security headers: CSP, nosniff, frame deny', /default-src 'self'/.test(r.headers.get('content-security-policy')) && r.headers.get('x-content-type-options') === 'nosniff' && r.headers.get('x-frame-options') === 'DENY');
    ok('no X-Powered-By header', !r.headers.get('x-powered-by'));
    r = await post('/api/auth/totp/setup');
    const { totpCode } = require('../lib/crypto');
    await post('/api/auth/totp/enable', { code: totpCode(r.body.secret) });
    r = await post('/api/auth/totp/disable', {});
    ok('turning two-step off without a code is refused', r.status === 400);
    r = await post('/api/auth/totp/disable', { code: totpCode(db.get('SELECT totp_secret FROM accounts WHERE id = 1').totp_secret) });
    ok('turning two-step off with a current code works', r.status === 200);

    // ---- API vault (fixed field names) ----
    console.log('API vault');
    r = await post('/api/settings/providers', { provider: 'brevo', apiKey: 'xkeysib-test-1234', extra: { from: 'books@example.com', listId: '7' } });
    ok('provider key saved', r.status === 200);
    r = await asAdmin('/api/settings/providers');
    const brevo = r.body.providers.find((p) => p.provider === 'brevo');
    ok('provider list reports connected + masked hint + extra fields', brevo.connected && brevo.hint === '••••1234' && brevo.extraFields.find((f) => f.key === 'listId').value === '7');
    r = await post('/api/settings/providers', { provider: 'brevo', apiKey: '', extra: { fromName: 'Justin' } });
    ok('saving extra fields with a blank key keeps the key', ai.getConnection('brevo').apiKey === 'xkeysib-test-1234' && ai.getConnection('brevo').extra.fromName === 'Justin');
    r = await post('/api/settings/providers', { provider: 'brevo', clear: true });
    ok('key can be removed', !ai.getConnection('brevo'));

    // ---- imprints seeded ----
    console.log('imprints');
    r = await asAdmin('/api/imprints');
    ok('both imprints seeded', r.body.imprints.length === 2);
    ok('manufacturing imprint has LinkedIn channel rule', r.body.imprints.find((i) => i.name.includes('Manufacturing')).channels.some((c) => c.platform === 'LinkedIn'));
    ok('Lamp & Path has own-website/socials/email channels only — never LinkedIn', r.body.imprints.find((i) => i.name.includes('Lamp')).channels.every((c) => ['Own website', 'Facebook', 'Instagram', 'Email list'].includes(c.platform)));
    ok('author platform checklist seeded (Author Central, BookBub, Goodreads)', r.body.imprints[0].profiles.length >= 10 && r.body.imprints[0].profiles.some((p) => /BookBub/.test(p.platform)));

    // ---- handoff intake ----
    console.log('handoff intake');
    r = await req('/api/handoff', { method: 'POST', headers: { authorization: 'Bearer wrong-token' }, body: JSON.stringify({ bookId: 1, metadata: { title: 'X' } }) });
    ok('handoff with a bad token is refused', r.status === 401);
    r = await req('/api/handoff', {
      method: 'POST', headers: { authorization: 'Bearer test-handoff-token' },
      body: JSON.stringify({
        bookId: 42,
        metadata: {
          title: 'Ahead of the Curve', subtitle: 'Operational Excellence in Pictures', imprint: 'North American Manufacturing Press', author: 'Justin Amaldas',
          description: 'A shop-floor guide.', keywords: ['lean', 'manufacturing'], categories: ['Business'], backCover: 'Back cover copy.', authorBio: 'Machinist turned GM.',
          trim: '6x9', pageCount: 212, words: 48000, productionCostUsd: 12.5, aiUseNotes: 'AI-assisted drafting, author-reviewed', driveFolder: 'https://drive.example/08',
        },
        packageBase64: Buffer.from('fake-zip').toString('base64'),
      }),
    });
    ok('handoff accepted (a bad zip does not break it)', r.status === 200 && r.body.marketingBookId && r.body.unpacked.error);
    const bookId = r.body.marketingBookId;
    r = await asAdmin(`/api/books/${bookId}`);
    ok('handoff book has 11 named stages', r.body.stages.length === 11 && r.body.stages[1].name === 'Positioning');
    ok('stage 1 done from handoff', r.body.stages[0].status === 'done');
    ok('metadata pre-filled from handoff', r.body.metadata.description === 'A shop-floor guide.');
    ok('all handoff fields kept (author, back cover, bio, trim, pages)', r.body.book.author === 'Justin Amaldas' && r.body.book.back_cover === 'Back cover copy.' && r.body.book.page_count === 212 && r.body.book.trim === '6x9');
    ok('production cost recorded', r.body.book.production_cost_usd === 12.5);
    ok('book gets a link name (slug)', r.body.book.slug === 'ahead-of-the-curve');
    r = await req('/api/handoff', { method: 'POST', headers: { authorization: 'Bearer test-handoff-token' }, body: JSON.stringify({ bookId: 42, metadata: { title: 'Ahead of the Curve', productionCostUsd: 13 } }) });
    ok('repeat handoff is idempotent', r.status === 200 && r.body.marketingBookId === bookId);
    r = await asAdmin('/api/books');
    ok('no duplicate book from repeat handoff', r.body.books.filter((b) => b.publish_book_id === 42).length === 1);
    r = await asAdmin(`/api/books/${bookId}`);
    ok('repeat handoff without a field keeps the old value', r.body.metadata.description === 'A shop-floor guide.' && r.body.book.author === 'Justin Amaldas');

    // Real package: metadata.json + manuscript.txt + covers
    const zip = new JSZip();
    zip.file('metadata.json', JSON.stringify({ title: 'Lamp Book' }));
    zip.file('manuscript.txt', 'Title page\n\nChapter 1: Beginnings\n\nIt started on a Monday.\n\nChapter 2: Middle\n\nThen came Tuesday.\n\nChapter 3: End\n\nAnd so it ended.');
    zip.file('cover-ebook.svg', '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="16"><rect width="10" height="16" fill="navy"/></svg>');
    zip.file('cover-print-wrap.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>');
    const zipB64 = (await zip.generateAsync({ type: 'nodebuffer' })).toString('base64');
    r = await req('/api/handoff', { method: 'POST', headers: { authorization: 'Bearer test-handoff-token' }, body: JSON.stringify({ bookId: 43, metadata: { title: 'Lamp Book', imprint: 'Lamp & Path Press', description: 'Quiet faith.' }, packageBase64: zipB64 }) });
    ok('handoff zip unpacked: manuscript split into 3 chapters, cover saved', r.body.unpacked.manuscript && r.body.unpacked.chapters === 3 && r.body.unpacked.cover && r.body.unpacked.coverPrint);
    const lampId = r.body.marketingBookId;
    r = await asAdmin(`/api/books/${lampId}`);
    ok('chapters listed with titles', r.body.chapters.length === 3 && r.body.chapters[0].title === 'Chapter 1: Beginnings');
    ok('cover recorded on the book', r.body.book.hasCover);

    // ---- manual import ----
    r = await post('/api/books/import', { title: 'Leadership Book', imprintId: 1, files: [{ name: 'manuscript.txt', type: 'manuscript', base64: Buffer.from('chapter one text '.repeat(10)).toString('base64') }] });
    ok('manual import creates a book', r.status === 200 && r.body.id);
    const manualId = r.body.id;

    // ---- matrix + editions ----
    console.log('store & format matrix');
    r = await post(`/api/books/${bookId}/editions`, { format: 'ebook', isbn: '978-1-000000-00-0', price: 9.99, fileSizeMb: 2 });
    ok('ebook edition created', r.status === 200 && r.body.id);
    const editionId = r.body.id;
    r = await post(`/api/books/${bookId}/editions`, { format: 'paperback', isbn: '978-1-000000-00-1', price: 19.99, printCost: 3.5 });
    ok('paperback edition created', r.status === 200);
    const pbId = r.body.id;
    r = await asAdmin(`/api/books/${bookId}/matrix`);
    const platformsLib = require('../lib/platforms');
    ok('matrix shows only platforms that take each format', r.body.matrix.length === platformsLib.forFormat('ebook').length + platformsLib.forFormat('paperback').length);
    r = await post(`/api/books/${bookId}/listings`, { editionId, store: 'KDP', price: 9.99, kdpSelect: true, kdpSelectEnd: '2099-01-01', aiDisclosure: 'AI-assisted', asin: 'B0TESTASIN' });
    ok('KDP listing with Select created', r.status === 200 && r.body.id);
    const kdpListing = r.body.id;
    r = await post(`/api/books/${bookId}/listings`, { editionId, store: 'Apple Books', price: 9.99 });
    ok('wide listing blocked while in KDP Select', r.status === 400 && /KDP Select/.test(r.body.error));

    // ---- compliance cap: 2/format/week ----
    console.log('compliance cap');
    const cap1 = mk.kdpPlanner().find((p) => p.format === 'ebook');
    ok('ebook cap starts at 0/2', cap1.used === 0 && cap1.limit === 2);
    ok('first use allowed', mk.recordKdpUse('ebook'));
    ok('second use allowed', mk.recordKdpUse('ebook'));
    let thirdRefused = false;
    try { mk.recordKdpUse('ebook'); } catch (e) { thirdRefused = /cap/i.test(e.message); }
    ok('third use in the same week refused', thirdRefused);
    ok('paperback cap unaffected', mk.recordKdpUse('paperback'));
    r = await asAdmin(`/api/listings/${kdpListing}/publish`, { method: 'POST' });
    ok('third ebook publish in a week is refused by the route', r.status === 400 && /cap/.test(r.body.error));
    db.exec("UPDATE kdp_slots SET used = 0 WHERE format = 'ebook'");
    r = await asAdmin(`/api/listings/${kdpListing}/publish`, { method: 'POST' });
    ok('publish recorded when a slot is free', r.status === 200);
    r = await asAdmin(`/api/listings/${kdpListing}/publish`, { method: 'POST' });
    ok('recording the same publish twice does not use a second slot', r.body.already && mk.kdpPlanner().find((p) => p.format === 'ebook').used === 1);
    r = await asAdmin(`/api/books/${bookId}/compliance`);
    ok('compliance checklist runs (description, keywords, AI notes)', r.body.checks.length >= 3);

    // ---- publishing tracker ----
    console.log('publishing tracker');
    r = await asAdmin('/api/platforms');
    const names = r.body.platforms.map((p) => p.name);
    const fromDoc = ['Apple Books', 'Kobo Writing Life', 'Google Play Books', 'Barnes & Noble Press', 'Kotobee Books', 'IngramSpark', 'Lulu', 'OverDrive / Libby', 'Hoopla', 'BorrowBox', 'cloudLibrary / Bibliotheca', 'Vivlio Libraries', 'Odilo', 'Everand', 'Tolino', 'Vivlio', 'Smashwords Store', 'Fable', 'Bookshop.org', 'Spotify for Authors', 'Voices by INaudio', 'ACX / Audible', 'Kobo audiobooks', "Author's Republic", 'Gumroad', 'Payhip', 'Ko-fi', 'Own website store', 'Draft2Digital', 'PublishDrive', 'Books.by', 'Amazon seller account', 'KDP Virtual Voice', 'Kindle Translate'];
    ok('catalog has every store, library, audio and direct platform from the Book Marketing doc', fromDoc.every((n) => names.includes(n)));
    ok('paid services from the doc are listed', ['BookFunnel', 'NetGalley', 'Reedsy Discovery', 'BookBub Featured Deal', 'Kirkus Indie Reviews', 'Written Word Media'].every((n) => r.body.paidServices.some((p) => p.name === n)));
    r = await post(`/api/books/${bookId}/rollout/generate`);
    ok('checklist from the imprint plan; wide ebook items skipped while in KDP Select', r.body.created >= 3 && r.body.skippedSelect.length >= 10);
    await post(`/api/books/${bookId}/listings`, { editionId, store: 'KDP', kdpSelect: false });
    r = await post(`/api/books/${bookId}/rollout/generate`);
    ok('after leaving Select, the go-wide items are added (Apple, Kobo, Google, B&N, Draft2Digital, libraries)', r.body.created >= 15 && r.body.skippedSelect.length === 0);
    r = await post(`/api/books/${bookId}/rollout/generate`);
    ok('generating again adds nothing', r.body.created === 0);
    r = await asAdmin(`/api/books/${bookId}/rollout`);
    const ebookRows = r.body.editions.find((e) => e.id === editionId).listings;
    const row = (store, rows = ebookRows) => rows.find((l) => l.store === store);
    ok('library and small stores go through Draft2Digital; Apple direct', row('Tolino').route === 'Draft2Digital' && row('Hoopla').route === 'Draft2Digital' && row('Apple Books').route === 'Direct');
    ok('phases come from the plan (Amazon first, then wide) — also for rows added before the checklist', row('KDP').phase === 'launch' && row('Apple Books').phase === 'wide');
    ok('paperback rows include IngramSpark for the manufacturing line', r.body.editions.find((e) => e.id === pbId).listings.some((l) => l.store === 'IngramSpark' && l.phase === 'launch'));
    const apple = row('Apple Books');
    r = await post(`/api/listings/${apple.id}/status`, { status: 'uploaded' });
    ok('status moves to uploaded with a date', r.status === 200 && r.body.listing.status === 'uploaded' && r.body.listing.submitted_at === mk.today());
    r = await post(`/api/listings/${apple.id}/status`, { status: 'rejected' });
    ok('a rejection needs a reason', r.status === 400);
    r = await post(`/api/listings/${apple.id}/status`, { status: 'rejected', reason: 'Formatting: missing TOC' });
    ok('rejection recorded with reason, lesson and alert', r.status === 200 && db.get("SELECT COUNT(*) AS n FROM lessons WHERE lesson_code = 'store_rejection'").n === 1 && db.get("SELECT COUNT(*) AS n FROM notifications WHERE title LIKE 'Apple Books rejected%'").n === 1);
    r = await post(`/api/listings/${apple.id}/status`, { status: 'live', liveLink: 'https://books.apple.com/x' });
    ok('live with link and published date', r.body.listing.status === 'live' && r.body.listing.published_date === mk.today() && r.body.listing.live_link === 'https://books.apple.com/x');
    await post(`/api/listings/${row('Kotobee Books').id}/status`, { status: 'na', reason: 'Too small for this title' });
    const kobo = row('Kobo Writing Life');
    await post(`/api/listings/${kobo.id}/status`, { status: 'in_review', date: mk.addDays(mk.today(), -10) });
    await scheduler.tick();
    ok('in review for over 7 days → reminder task and alert (once)', db.get("SELECT COUNT(*) AS n FROM tasks WHERE title LIKE 'Check Kobo Writing Life%'").n === 1 && db.get('SELECT reminded FROM listings WHERE id = ?', [kobo.id]).reminded === 1);
    await scheduler.tick();
    ok('the reminder is not repeated', db.get("SELECT COUNT(*) AS n FROM tasks WHERE title LIKE 'Check Kobo Writing Life%'").n === 1);
    // KDP cap counted at upload (drafts count), not only at publish.
    const pbKdp = db.get("SELECT id FROM listings WHERE edition_id = ? AND store = 'KDP'", [pbId]);
    r = await post(`/api/listings/${pbKdp.id}/status`, { status: 'uploaded' });
    ok('KDP paperback upload counts toward the weekly cap', r.status === 200 && mk.kdpPlanner().find((p) => p.format === 'paperback').used === 2);
    r = await post(`/api/books/${bookId}/editions`, { format: 'paperback', isbn: '978-1-000000-00-9', price: 24.99 });
    const pb2 = r.body.id;
    r = await post(`/api/books/${bookId}/listings`, { editionId: pb2, store: 'KDP' });
    r = await post(`/api/listings/${r.body.id}/status`, { status: 'uploaded' });
    ok('a third new paperback upload in the week is refused', r.status === 400 && /cap/.test(r.body.error));
    r = await post(`/api/books/${bookId}/listings`, { editionId: pb2, store: 'Hoopla' });
    ok('a platform that does not take the format is refused', r.status === 400);
    // Live checks through public lookups (stubbed here — no network in tests).
    const realFetch = globalThis.fetch;
    globalThis.fetch = (url, opts) => (String(url).includes('googleapis.com/books') ? Promise.resolve(new Response(JSON.stringify({ items: [{ id: 'gv1', volumeInfo: { title: 'Ahead of the Curve', authors: ['Justin Amaldas'] }, saleInfo: { saleability: 'FOR_SALE', buyLink: 'https://play.google.com/store/books/details?id=gv1' } }] }), { headers: { 'content-type': 'application/json' } })) : realFetch(url, opts));
    const gp = row('Google Play Books');
    await post(`/api/listings/${gp.id}/status`, { status: 'uploaded' });
    r = await post(`/api/listings/${gp.id}/check`);
    globalThis.fetch = realFetch;
    ok('Google Play live check flips the listing to live with the Play link', r.body.live && db.get('SELECT status, live_link FROM listings WHERE id = ?', [gp.id]).status === 'live' && /play\.google/.test(db.get('SELECT live_link FROM listings WHERE id = ?', [gp.id]).live_link));
    r = await post(`/api/listings/${row('Hoopla').id}/check`);
    ok('stores without a public lookup say so', r.body.manual);
    r = await asAdmin('/api/publishing/overview');
    const ov = r.body.books.find((b) => b.id === bookId);
    ok('overview counts live, pending, rejected and lists what is next', ov.done >= 2 && ov.pending >= 1 && ov.na === 1 && ov.next.length > 0 && ov.stuck.length === 1 && Array.isArray(ov.rejectedList));
    r = await post(`/api/books/${bookId}/listings`, { editionId, store: 'KDP', kdpSelect: true });
    ok('cannot enrol in KDP Select while the ebook is out wide', r.status === 400 && /exclusivity/.test(r.body.error));

    // ---- pen names ----
    console.log('pen names');
    r = await asAdmin('/api/imprints');
    ok('Lamp & Path is published as J. A. Gauscal', r.body.imprints.find((i) => i.name === 'Lamp & Path Press').author_name === 'J. A. Gauscal');
    ok('LinkedIn profile only for the manufacturing line; pen-name email only for Lamp & Path', r.body.imprints.find((i) => i.name.includes('Manufacturing')).profiles.some((p) => /LinkedIn/.test(p.platform)) && !r.body.imprints.find((i) => i.name.includes('Lamp')).profiles.some((p) => /LinkedIn/.test(p.platform)) && r.body.imprints.find((i) => i.name.includes('Lamp')).profiles.some((p) => /Pen-name email/.test(p.platform)));
    ok('a Lamp & Path book with no author gets the pen name', db.get('SELECT author FROM books WHERE id = ?', [lampId]).author === 'J. A. Gauscal');
    r = await req('/api/handoff', { method: 'POST', headers: { authorization: 'Bearer test-handoff-token' }, body: JSON.stringify({ bookId: 44, metadata: { title: 'Crossed Names', imprint: 'Lamp & Path Press', author: 'Justin Amaldas' } }) });
    ok('a handoff with the wrong name for the imprint raises an alert', db.get("SELECT COUNT(*) AS n FROM notifications WHERE title LIKE 'Author name check%'").n === 1);
    r = await asAdmin(`/api/books/${r.body.marketingBookId}/compliance`);
    ok('compliance shows the pen-name check failing', r.body.checks.some((c) => /pen name/.test(c.label) && !c.ok));

    // ---- worldwide pricing ----
    console.log('worldwide pricing');
    r = await asAdmin(`/api/books/${bookId}/global`);
    const ebookLadder = r.body.editions.find((e) => e.id === editionId).ladder;
    ok('price ladder covers 13 Amazon marketplaces', ebookLadder.length === 13);
    const jp = ebookLadder.find((x) => x.marketplace === 'JP');
    ok('JPY price lands inside the ¥250–¥1,650 70% band', jp.price >= 250 && jp.price <= 1650);
    ok('JP 70% needs KDP Select — this ebook is wide now, so 35% with a note', jp.rate === 0.35 && jp.warnings.some((w) => /KDP Select/.test(w)));
    const uk = ebookLadder.find((x) => x.marketplace === 'UK');
    ok('UK price is a charm price (x.99)', /\.99$/.test(uk.price.toFixed(2)));
    const usPb = r.body.editions.find((e) => e.id === pbId).ladder.find((x) => x.marketplace === 'US');
    ok('paperback royalty = 60% × list − print cost', Math.abs(usPb.royalty - (0.6 * 19.99 - 3.5)) < 0.02);
    r = await post(`/api/editions/${editionId}/prices`, { prices: { US: 12.99, DE: 14.99 } });
    ok('marketplace prices saved; out-of-band EUR price is flagged 35%', r.body.ladder.find((x) => x.marketplace === 'DE').rate === 0.35 && r.body.ladder.find((x) => x.marketplace === 'US').rate === 0.7);
    ok('FX conversion works', Math.abs(global.toUsd(87, 'EUR') - 100) < 0.01);

    // ---- metadata limits ----
    r = await put(`/api/books/${bookId}/metadata`, { description: 'A shop-floor guide.', keywords: ['lean', 'manufacturing', 'a', 'b', 'c', 'd', 'e', 'f'], categories: ['Business'] });
    ok('metadata warns about KDP limits (8 keywords > 7)', r.body.warnings.length === 1);
    await put(`/api/books/${bookId}/metadata`, { description: 'A shop-floor guide.', keywords: ['lean', 'manufacturing'], categories: ['Business'] });

    // ---- launch calendar + automation ----
    console.log('launch calendar + automation');
    const tplLen = db.LAUNCH_TEMPLATES['North American Manufacturing Press'].length;
    const launchDate = mk.addDays(mk.today(), 30);
    r = await post(`/api/books/${bookId}/launch`, { launchDate });
    ok('launch calendar generated from the imprint template', r.status === 200 && r.body.made.length === tplLen);
    ok('launch tasks span pre-launch to +90 days', r.body.made.some((t) => t.due === mk.addDays(launchDate, -7)) && r.body.made.some((t) => t.due === mk.addDays(launchDate, 90)));
    ok('launch automation queued: content kit + post scheduling', r.body.automated.some((a) => a.kind === 'content_batch') && r.body.automated.some((a) => a.kind === 'launch_schedule_posts'));
    const kitJob = db.get('SELECT * FROM jobs WHERE id = ?', [r.body.automated.find((a) => a.kind === 'content_batch').id]);
    ok('launch content kit is scheduled for two weeks before launch', kitJob.run_after.startsWith(mk.addDays(launchDate, -14)));
    r = await post(`/api/books/${bookId}/launch`, { launchDate });
    ok('planning the launch twice does not duplicate tasks or jobs', r.body.made.length === 0 && db.get("SELECT COUNT(*) AS n FROM jobs WHERE book_id = ? AND kind = 'content_batch' AND status = 'queued'", [bookId]).n === 1);
    r = await asAdmin(`/api/books/${bookId}`);
    ok('refresh check-ins scheduled (30/60/90 days + quarterly)', r.body.refreshCycles.length >= 4);
    ok('launch tasks listed on the book', r.body.tasks.filter((t) => t.campaign_id).length === tplLen);

    // ---- stage gates ----
    console.log('stage gates');
    r = await post(`/api/books/${bookId}/stage/2/gate`, { decision: 'approve' });
    ok('stage gate approves when the stage before is done', r.status === 200 && r.body.ok);
    r = await post(`/api/books/${bookId}/stage/5/gate`, { decision: 'approve' });
    ok('stage gate refuses to approve stage 5 before stage 4', r.status === 400 && /stage 4/.test(r.body.error));
    r = await post(`/api/books/${bookId}/stage/3/gate`, { decision: 'send_back' });
    ok('send-back without a reason code is refused', r.status === 400);
    r = await post(`/api/books/${bookId}/stage/3/gate`, { decision: 'send_back', reasonCode: 'description', note: 'Too long.' });
    ok('send-back with a reason code works and records a Kaizen lesson', r.status === 200 && db.get("SELECT COUNT(*) AS n FROM lessons WHERE book_id = ? AND lesson_code = 'description'", [bookId]).n === 1);

    // ---- content approval flow ----
    console.log('content approval flow');
    r = await post(`/api/books/${bookId}/content/generate`, { types: ['description'] });
    ok('content generates (local draft without a key)', r.status === 200 && r.body.made.length === 1 && r.body.made[0].local);
    const contentId = r.body.made[0].id;
    r = await asAdmin(`/api/content/${contentId}/approve`, { method: 'POST' });
    ok('a local placeholder draft cannot be approved', r.status === 400);
    r = await put(`/api/content/${contentId}`, { text: 'Real description written by Justin.' });
    ok('editing creates a new version', r.status === 200 && r.body.id);
    r = await asAdmin(`/api/content/${r.body.id}/approve`, { method: 'POST' });
    ok('edited content approves', r.status === 200);
    r = await asAdmin(`/api/books/${bookId}/content`);
    ok('approved flag sticks on the new version (v2)', r.body.content[0].approved === 1 && r.body.content[0].version === 2);
    r = await post(`/api/books/${lampId}/content/generate`, { types: ['linkedin'] });
    ok('Lamp & Path cannot get a LinkedIn article (channel rule)', r.status === 400);
    r = await post(`/api/books/${lampId}/content/generate`, { types: ['social'], channel: 'LinkedIn' });
    ok('Lamp & Path content refused for a LinkedIn channel', r.status === 400);
    r = await post(`/api/books/${bookId}/content/generate`, { types: ['description', 'social', 'aplus', 'trailer'] });
    ok('large kits are queued as a background job', r.body.queued && r.body.jobId);

    // ---- content calendar ----
    console.log('content calendar');
    r = await post(`/api/books/${bookId}/content/generate`, { types: ['social'] });
    const socialId = r.body.made[0].id;
    r = await post(`/api/books/${bookId}/posts`, { contentId: socialId, channel: 'LinkedIn', scheduledAt: '2030-01-01T15:00' });
    ok('unapproved content cannot be scheduled', r.status === 400);
    r = await put(`/api/content/${socialId}`, { text: '1. First post about lean. [LINK]\n2. Second post about flow. [LINK]\n3. Third post about Monday practice. [LINK]' });
    const socialV2 = r.body.id;
    await post(`/api/content/${socialV2}/approve`);
    r = await post(`/api/books/${bookId}/posts`, { contentId: socialV2, channel: 'Facebook', scheduledAt: '2030-01-01T15:00' });
    ok('a channel of the other imprint is refused', r.status === 400);
    r = await post(`/api/books/${bookId}/posts`, { contentId: socialV2, channel: 'LinkedIn', scheduledAt: '2020-01-01T15:00', index: 1 });
    ok('approved post scheduled on an own channel', r.status === 200);
    const postRow = db.get('SELECT * FROM scheduled_posts WHERE id = ?', [r.body.id]);
    ok('post text is one numbered post with the tracked smart link filled in', postRow.text.startsWith('Second post') && /\/b\/ahead-of-the-curve\?ch=linkedin/.test(postRow.text));
    await scheduler.tick();
    ok('due post on an unconnected channel becomes "post by hand"', db.get('SELECT status FROM scheduled_posts WHERE id = ?', [postRow.id]).status === 'manual');
    r = await asAdmin('/api/dashboard');
    ok('Today shows posts to do by hand', r.body.today.manualPosts.length >= 1);
    r = await post(`/api/books/${bookId}/posts/auto`, { startDate: mk.addDays(mk.today(), 5) });
    ok('auto-schedule spreads approved posts across the imprint channels', r.body.scheduled >= 3);
    r = await post(`/api/books/${bookId}/posts/auto`, { startDate: mk.addDays(mk.today(), 5) });
    ok('auto-schedule never double-schedules', r.body.scheduled === 0);
    r = await asAdmin('/api/calendar');
    ok('calendar lists scheduled posts across books', r.body.posts.length >= 3);

    // ---- smart links + book page ----
    console.log('smart links + book page');
    r = await req('/b/ahead-of-the-curve?ch=linkedin', { headers: { 'accept-language': 'de-DE,de;q=0.9', 'user-agent': 'Mozilla/5.0' } });
    ok('smart link sends a German reader to amazon.de', r.status === 302 && r.headers.get('location') === 'https://www.amazon.de/dp/B0TESTASIN');
    r = await req('/b/ahead-of-the-curve?c=JP', { headers: { 'user-agent': 'Mozilla/5.0' } });
    ok('country override routes to amazon.co.jp', r.headers.get('location') === 'https://www.amazon.co.jp/dp/B0TESTASIN');
    await req('/b/ahead-of-the-curve', { headers: { 'user-agent': 'facebookexternalhit/1.1' } });
    r = await asAdmin(`/api/books/${bookId}/links`);
    ok('clicks counted by channel and country (bots ignored)', r.body.total === 2 && r.body.byCountry.some((x) => x.k === 'DE') && r.body.byChannel.some((x) => x.k === 'linkedin'));
    r = await req('/p/ahead-of-the-curve');
    ok('public book page renders with buy button and Book schema', r.status === 200 && /Ahead of the Curve/.test(r.text) && /application\/ld\+json/.test(r.text) && /href="\/b\/ahead-of-the-curve\?s=amazon/.test(r.text));
    ok('book page has no inline script that could run', !/<script(?![^>]*application\/ld\+json)/.test(r.text));
    r = await req(`/p/lamp-book`);
    ok('book page offers the free chapter when chapters exist', /Read the first chapter free/.test(r.text));
    r = await req('/p/lamp-book/cover');
    ok('cover served sandboxed', r.status === 200 && /sandbox/.test(r.headers.get('content-security-policy')));

    // ---- reader funnel: double opt-in ----
    console.log('reader funnel');
    r = await req('/api/funnel/signup', { method: 'POST', body: JSON.stringify({ name: 'New Reader', email: 'reader2@example.com', consent: true, bookId: lampId }) });
    ok('funnel signup records consent as pending (double opt-in)', r.status === 200 && r.body.ok && r.body.pending);
    const pending = db.get("SELECT * FROM contacts WHERE email = 'reader2@example.com'");
    ok('pending readers are not exported', !(await asAdmin('/api/contacts/export.csv')).text.includes('reader2@example.com'));
    r = await req(`/confirm/${pending.confirm_token}`);
    ok('confirmation link confirms and offers the free chapter', r.status === 200 && /free chapter/.test(r.text) && db.get('SELECT status FROM contacts WHERE id = ?', [pending.id]).status === 'confirmed');
    r = await req(`/p/lamp-book/free/${pending.unsub_token}`);
    ok('confirmed reader can read the first chapter', r.status === 200 && /It started on a Monday/.test(r.text));
    ok('confirmed readers are exported', (await asAdmin('/api/contacts/export.csv')).text.includes('reader2@example.com'));
    r = await req(`/u/${pending.unsub_token}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'List-Unsubscribe=One-Click' });
    ok('one-click unsubscribe works', r.status === 200 && db.get('SELECT status FROM contacts WHERE id = ?', [pending.id]).status === 'unsubscribed');
    r = await req('/api/funnel/signup', { method: 'POST', body: JSON.stringify({ email: 'no-consent@example.com', consent: false }) });
    ok('funnel signup without consent is refused', r.status === 400);
    r = await req('/api/funnel/signup', { method: 'POST', body: JSON.stringify({ email: 'bot@example.com', consent: true, website: 'http://spam' }) });
    ok('honeypot silently drops bots', r.status === 200 && !db.get("SELECT id FROM contacts WHERE email = 'bot@example.com'"));

    // ---- ARC campaign ----
    console.log('ARC campaign');
    r = await post(`/api/books/${bookId}/campaigns`, { type: 'arc', name: 'BookSirens ARC' });
    ok('ARC campaign without the review-policy confirmation is refused', r.status === 400);
    r = await post(`/api/books/${bookId}/campaigns`, { type: 'arc', name: 'BookSirens ARC', platform: 'BookSirens', reviewPolicyConfirmed: true });
    ok('ARC campaign created with the policy confirmed', r.status === 200 && r.body.id);
    r = await post('/api/contacts', { name: 'Reader One', email: 'r1@example.com', type: 'reader', consent: true });
    ok('reader contact with consent created', r.status === 200 && r.body.id);
    const contactId = r.body.id;
    r = await post(`/api/books/${bookId}/arc-email`, { contactId });
    ok('ARC email draft generated', r.status === 200 && r.body.draft);
    r = await post(`/api/books/${bookId}/arc-send`, { contactIds: [contactId], body: r.body.draft });
    ok('placeholder drafts are never sent', r.status === 400);
    r = await post('/api/contacts/import', { csv: 'name,email,type,consent,outlet\nHost A,host@example.com,podcast,yes,Lean Talk\nNo Consent,nc@example.com,reader,no,\n' });
    ok('contacts import from CSV', r.body.added === 2);

    // ---- pitches ----
    console.log('pitches');
    const host = db.get("SELECT id FROM contacts WHERE email = 'host@example.com'");
    r = await post(`/api/books/${bookId}/pitches`, { contactId: host.id, kind: 'podcast', angle: 'Monday practices' });
    ok('podcast pitch created', r.status === 200 && r.body.id);
    const pitchId = r.body.id;
    r = await post(`/api/pitches/${pitchId}/draft`);
    ok('pitch draft generated', r.status === 200 && r.body.draft);
    r = await post(`/api/pitches/${pitchId}/send`, { draft: 'Subject: Hello\n\nA real pitch.' });
    ok('pitch send reports a clear error without an email provider', r.status === 400 && /email provider|No email/i.test(r.body.error));
    r = await post(`/api/pitches/${pitchId}/mark-sent`);
    db.exec('UPDATE pitches SET followup_due = ? WHERE id = ?', [mk.today(), pitchId]);
    await scheduler.tick();
    ok('pitch follow-up becomes a task when due', db.get('SELECT status FROM pitches WHERE id = ?', [pitchId]).status === 'follow-up due' && db.get("SELECT COUNT(*) AS n FROM tasks WHERE title LIKE 'Follow up podcast pitch%'").n === 1);

    // ---- foreign rights ----
    r = await post(`/api/books/${bookId}/rights`, { territory: 'Germany', language: 'German', status: 'pitched', partner: 'Verlag X' });
    ok('rights deal tracked', r.status === 200);
    r = await put(`/api/rights/${r.body.id}`, { status: 'signed', advance: 2000, currency: 'EUR' });
    ok('signing a rights deal notifies', r.status === 200 && db.get("SELECT COUNT(*) AS n FROM notifications WHERE kind = 'rights'").n === 1);

    // ---- sales import + margin ----
    console.log('sales import + margin');
    const csv = 'period,store,format,units,royalty\n2026-11,KDP,ebook,100,300\n2026-11,KDP,paperback,20,80\n2026-12,KDP,ebook,150,450\n';
    r = await post(`/api/books/${bookId}/sales/import`, { csv });
    ok('sales CSV imported', r.status === 200 && r.body.imported === 3);
    r = await asAdmin(`/api/books/${bookId}/sales`);
    ok('sales sum correctly', r.body.sales.reduce((a, s) => a + s.units, 0) === 270 && r.body.sales.reduce((a, s) => a + s.royalty, 0) === 830);
    await post(`/api/books/${bookId}/sales/import`, { csv });
    ok('re-importing the same report does not double count', mk.bookSales(bookId).units === 270);
    let margin = mk.bookMargin(bookId);
    ok('margin = royalty − production − promo, with productionCost for the UI', Math.abs(margin.net - (830 - 13)) < 0.01 && margin.productionCost === 13);
    r = await post(`/api/books/${bookId}/promotions`, { type: 'price', detail: '99c promo', spend: 30, resultUnits: 50, resultRoyalty: 20 });
    ok('promotion recorded', r.status === 200);
    margin = mk.bookMargin(bookId);
    ok('margin drops by promo spend', Math.abs(margin.net - (830 - 13 - 30)) < 0.01);
    r = await post(`/api/books/${bookId}/ads`, { platform: 'Amazon Ads', campaignName: 'Launch', spend: 100, sales: 250, impressions: 10000, clicks: 200 });
    ok('ad row recorded', r.status === 200);
    r = await asAdmin(`/api/books/${bookId}/ads-roi`);
    ok('ACOS/ROAS/CTR/CPC computed', r.body.ads[0].acos === 40 && r.body.ads[0].roas === 2.5 && r.body.ads[0].ctr === 2 && r.body.ads[0].cpc === 0.5);
    ok('break-even ACOS from royalty per sale ÷ price', r.body.breakEven && r.body.breakEven.royaltyPerSale > 3 && r.body.breakEven.royaltyPerSale < 3.1 && (r.body.breakEven.breakEvenAcos === null || r.body.breakEven.breakEvenAcos > 0));
    ok('each campaign gets a verdict', typeof r.body.ads[0].verdict === 'string');
    await post(`/api/books/${bookId}/ads`, { platform: 'Amazon Ads', campaignName: 'Broad', spend: 40, sales: 0, impressions: 5000, clicks: 30 });
    r = await asAdmin(`/api/books/${bookId}/ads-roi`);
    ok('spend with clicks but no sales points at the listing', /listing/.test(r.body.ads.find((a) => a.campaign_name === 'Broad').verdict));

    // ---- prompt library v2 ----
    console.log('prompt library v2');
    const pv = db.get("SELECT version, text FROM prompts WHERE task = 'description' ORDER BY id DESC LIMIT 1");
    ok('v2 prompts are current (role, task, constraints, format)', pv.version === '2.0' && /ROLE:/.test(pv.text) && /FORMAT:/.test(pv.text));
    ok('categories prompt asks for 3 KDP categories', /3 KDP categories/.test(db.get("SELECT text FROM prompts WHERE task = 'categories' ORDER BY id DESC LIMIT 1").text));
    ok('keyword prompt forbids misspellings (KDP rule)', /no misspellings/.test(db.get("SELECT text FROM prompts WHERE task = 'kdp_keywords' ORDER BY id DESC LIMIT 1").text));
    ok('new tasks have AI routes', !!db.get("SELECT task FROM task_routes WHERE task = 'ads_analysis'"));
    let seen = '';
    const realComplete = ai.completeTask;
    ai.completeTask = async (o) => { seen = o.system + '\n' + o.prompt; return { text: 'ok', provider: 'stub' }; };
    try {
      await post(`/api/books/${bookId}/lessons`, { code: 'ads', note: 'Lean words beat generic words in ads.' });
      r = await post(`/api/books/${bookId}/content/generate`, { types: ['reader_profile'] });
      ok('reader profile generates', r.status === 200 && r.body.made.length === 1);
      r = await post(`/api/books/${bookId}/content/generate`, { types: ['description_ab'] });
      ok('copy prompts carry the reader profile and imprint lessons', /READER PROFILE:/.test(seen) && /Lean words beat generic/.test(seen));
      ok('copy prompts carry the avoided-phrase list', /tapestry/.test(seen));
      r = await post(`/api/books/${bookId}/content/generate`, { types: ['ads_analysis'] });
      ok('ad check carries break-even ACOS and campaigns', /BREAK-EVEN ACOS/.test(seen) && /Broad/.test(seen));
      await post(`/api/books/${bookId}/reviews`, { store: 'Amazon', rating: 5, text: 'Changed how I run Monday meetings.' });
      r = await post(`/api/books/${bookId}/content/generate`, { types: ['social_proof'] });
      ok('social proof uses real reviews only', /REAL REVIEWS \(\d+\)/.test(seen) && /Monday meetings/.test(seen));
      r = await post(`/api/books/${bookId}/content/generate`, { types: ['competitor_teardown'] });
      ok('competitor teardown carries recorded competitors', /COMPETITORS \(/.test(seen));
      r = await post('/api/portfolio/briefing');
      ok('portfolio briefing runs on catalogue figures', r.status === 200 && /CATALOGUE \(\d+ books/.test(seen) && r.body.text === 'ok');
      r = await asAdmin('/api/portfolio/briefing');
      ok('last briefing is kept', r.body.last && r.body.last.text === 'ok');
    } finally { ai.completeTask = realComplete; }

    // ---- ARC reminders day 7 and day 14 + disclosure ----
    console.log('ARC reminders');
    ok('ARC drafts always ask readers to mention a free copy', /free advance copy/.test(mk.ensureArcDisclosure('Hello')) && mk.ensureArcDisclosure('… received a free copy …') === '… received a free copy …');
    const arcId = db.exec('INSERT INTO arc_sends (book_id, contact_id, followup_due) VALUES (?, ?, ?)', [bookId, contactId, mk.today()]);
    await scheduler.tick();
    let as = db.get('SELECT * FROM arc_sends WHERE id = ?', [arcId]);
    ok('first reminder on day 7, second scheduled 7 days later', as.followups === 1 && as.followup_done === 0 && as.followup_due === mk.addDays(mk.today(), 7));
    db.exec('UPDATE arc_sends SET followup_due = ? WHERE id = ?', [mk.today(), arcId]);
    await scheduler.tick();
    as = db.get('SELECT * FROM arc_sends WHERE id = ?', [arcId]);
    ok('second (last) reminder closes the follow-ups', as.followups === 2 && as.followup_done === 1 && db.get("SELECT COUNT(*) AS n FROM tasks WHERE title LIKE '%reminder to ARC reader%'").n === 2);

    console.log('report importer (all books)');
    const kdpCsv = 'Royalty Date,Title,Author Name,ASIN/ISBN,Marketplace,Royalty Type,Transaction Type,Units Sold,Units Refunded,Net Units Sold,Royalty,Currency\n'
      + '2026-10,Ahead of the Curve,Justin Amaldas,B0TESTASIN,Amazon.de,70%,Standard,10,0,10,"52,50",EUR\n'
      + '2026-10,Ahead of the Curve,Justin Amaldas,B0TESTASIN,Amazon.de,70%,Kindle Countdown Deal,2,0,2,"5,00",EUR\n'
      + '2026-10,Unknown Book,Someone,B0NOPE,Amazon.com,70%,Standard,3,0,3,6.00,USD\n';
    r = await post('/api/import/report', { csv: kdpCsv });
    ok('KDP report matched by ASIN; rows for one market/month are combined', r.status === 200 && r.body.sales === 1 && r.body.books.includes(bookId));
    ok('unmatched titles are listed, not guessed', r.body.unmatched.includes('Unknown Book'));
    const de = db.get("SELECT * FROM sales WHERE book_id = ? AND marketplace = 'DE'", [bookId]);
    ok('EUR royalty kept and converted to USD (European decimal commas read)', de.currency === 'EUR' && Math.abs(de.royalty - 57.5) < 0.01 && Math.abs(de.royalty_usd - 57.5 / 0.87) < 0.01);
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Paperback Royalty');
    ws.addRow(['Sales report']);
    ws.addRow(['Royalty Date', 'Title', 'ASIN/ISBN', 'Marketplace', 'Net Units Sold', 'Royalty', 'Currency']);
    ws.addRow(['2026-10', 'Ahead of the Curve', '9781000000001', 'Amazon.co.uk', 4, 12.4, 'GBP']);
    const xb64 = Buffer.from(await wb.xlsx.writeBuffer()).toString('base64');
    r = await post('/api/import/report', { xlsxBase64: xb64 });
    ok('XLSX report: header row found, ISBN matched, format from sheet name', r.body.sales === 1 && db.get("SELECT format FROM sales WHERE book_id = ? AND marketplace = 'UK'", [bookId]).format === 'paperback');
    r = await asAdmin('/api/dashboard');
    ok('dashboard KPIs and monthly chart data', typeof r.body.kpis.royaltyMonth === 'number' && r.body.monthly.months.length >= 2 && r.body.monthly.markets.some((m) => m.market === 'DE'));

    // ---- bestseller milestones ----
    console.log('bestseller milestones');
    r = await post(`/api/books/${bookId}/rank`, { category: 'Business > Manufacturing', rank: 87, store: 'Amazon' });
    ok('Top 100 milestone fired', r.status === 200 && r.body.milestones.some((m) => m.kind === 'Top 100'));
    r = await post(`/api/books/${bookId}/rank`, { category: 'Business > Manufacturing', rank: 7 });
    ok('Top 10 milestone fired', r.body.milestones.some((m) => m.kind === 'Top 10'));
    r = await post(`/api/books/${bookId}/rank`, { category: 'Business > Manufacturing', rank: 1 });
    ok('#1 milestone fired', r.body.milestones.some((m) => m.kind === '#1'));
    r = await post(`/api/books/${bookId}/rank`, { category: 'Business > Quality Control', rank: 40 });
    ok('milestones are per category (Top 100 fires again in a new category)', r.body.milestones.length === 1 && r.body.milestones[0].kind === 'Top 100');
    r = await asAdmin(`/api/books/${bookId}/rank-trend`);
    ok('rank trend groups by category', r.body.trend.byCategory['Business > Manufacturing'].points.length === 3);
    ok('rank trend direction improves as rank falls', mk.rankTrend(bookId).byCategory['Business > Manufacturing'].direction === 'improving');

    // ---- review monitoring ----
    console.log('review monitoring');
    r = await post(`/api/books/${bookId}/reviews`, { store: 'Amazon', rating: 2, text: 'Not for me.' });
    ok('low rating recorded and flagged for reply', r.status === 200);
    r = await asAdmin(`/api/books/${bookId}`);
    ok('review needs a reply', r.body.reviews.some((x) => x.needs_reply === 1));
    r = await asAdmin('/api/dashboard');
    ok('dashboard surfaces the low rating', r.body.today.lowRatings.length === 1);

    // ---- competitor watch + price test ----
    console.log('competitor watch + price tests');
    r = await post(`/api/books/${bookId}/competitors`, { title: 'The Goal', author: 'Eliyahu Goldratt', price: 12.99, rank: 5, reviewCount: 1200 });
    ok('competitor added', r.status === 200 && r.body.id);
    r = await post(`/api/competitors/${r.body.id}/recheck`, { price: 9.99, rank: 3 });
    ok('competitor price-drop and overtake alerts fire', r.body.alerts.length === 2);
    r = await post(`/api/books/${bookId}/price-tests`, { format: 'ebook', oldPrice: 9.99, newPrice: 7.99 });
    ok('price test started', r.status === 200 && r.body.id);
    r = await post(`/api/price-tests/${r.body.id}/finish`, { units: 120, royalty: 240, verdict: 'keep' });
    ok('price test finished with a like-for-like comparison window', r.status === 200 && r.body.comparison.after.units === 120 && r.body.comparison.days >= 1);

    // ---- refresh cycles: automatic ----
    console.log('backlist refresh (automatic)');
    mk.scheduleRefreshCycles(manualId, mk.addDays(mk.today(), -40));
    ok('past check-ins are created as due', db.get("SELECT COUNT(*) AS n FROM refresh_cycles WHERE book_id = ? AND status = 'due'", [manualId]).n === 1);
    db.exec('INSERT INTO sales (book_id, store, period, units, royalty, currency) VALUES (?, ?, ?, ?, ?, ?)', [manualId, 'KDP', mk.today(), 5, 10, 'USD']);
    await scheduler.tick();
    ok('scheduler analyses due check-ins by itself', db.get("SELECT COUNT(*) AS n FROM refresh_cycles WHERE book_id = ? AND status = 'in_review'", [manualId]).n === 1 && db.get('SELECT COUNT(*) AS n FROM recommendations WHERE book_id = ?', [manualId]).n >= 1);
    r = await asAdmin('/api/dashboard');
    ok('dashboard shows check-ins to review', r.body.today.refreshDue.some((c) => c.book_id === manualId));
    r = await asAdmin(`/api/books/${bookId}`);
    const cycle = r.body.refreshCycles[0];
    r = await post(`/api/books/${bookId}/refresh/${cycle.id}/analyse`);
    ok('refresh analysis proposes recommendations with reasons', r.status === 200 && r.body.recommendations.length >= 1 && r.body.recommendations.every((x) => x.reason.length > 5));
    const recId = r.body.ids[0];
    r = await post(`/api/recommendations/${recId}/approve`);
    ok('approving a recommendation creates a task', r.status === 200);
    r = await asAdmin(`/api/books/${bookId}`);
    ok('refresh task + log exist', r.body.tasks.some((t) => /refresh/i.test(t.title)) && r.body.refreshLog.length >= 1);

    // ---- localize, audio, translation (no keys → clear failures) ----
    console.log('localization, audio, translation');
    r = await post(`/api/books/${bookId}/localize`, { languages: ['German', 'French'] });
    ok('localization queued', r.status === 200 && r.body.jobId);
    let j = await runJob(r.body.jobId);
    ok('localization without an AI key stops with a clear message', /No AI provider/.test(j.error));
    r = await post(`/api/books/${bookId}/translate-book`, { language: 'German' });
    ok('whole-book translation needs chapters', r.status === 400);
    r = await post(`/api/books/${lampId}/translate-book`, { language: 'German', glossary: 'grace = Gnade' });
    ok('whole-book translation queued as a new edition', r.status === 200 && r.body.editionId && r.body.chapters === 3);
    j = await runJob(r.body.jobId);
    ok('translation without DeepL or an AI key stops with a clear message', /No translation provider/.test(j.error));
    r = await post(`/api/books/${lampId}/audio-book`, { voiceId: 'v1' });
    ok('audiobook job queued with a cost estimate', r.status === 200 && r.body.chapters === 3 && typeof r.body.estCostUsd === 'number');
    r = await asAdmin(`/api/books/${bookId}/editions-matrix`);
    ok('editions matrix includes KDP Virtual Voice and Kindle Translate', r.body.matrix.some((m) => /Virtual Voice/.test(m.store)) && r.body.translation.some((t) => /Kindle Translate/.test(t.route)));
    ok('glossary parsed for DeepL', ai.parseGlossary('grace = Gnade\nbad line').length === 1);
    ok('DeepL language codes', ai.deeplLangCode('Portuguese (Brazil)') === 'PT-BR' && ai.deeplLangCode('German') === 'DE');
    ok('long text split for narration under 4,500 characters', ai.chunkText('word. '.repeat(3000), 4500).every((c) => c.length <= 4500));

    // ---- research ----
    r = await post(`/api/books/${bookId}/research`, { kind: 'keywords', market: 'DE' });
    ok('keyword research runs (local draft without a key) and is saved', r.status === 200 && r.body.id);

    // ---- consignments, library, sell sheet ----
    console.log('bookstores & libraries');
    r = await post(`/api/books/${bookId}/consignments`, { store: "Owl's Nest Books", copies: 10, sold: 3, paid: 20 });
    ok('consignment recorded', r.status === 200);
    r = await post(`/api/books/${bookId}/library`, { platform: 'OverDrive', status: 'live' });
    ok('library platform status set', r.status === 200);
    r = await asAdmin(`/api/books/${bookId}/sellsheet.pdf`);
    ok('sell sheet PDF downloads', r.status === 200 && /^%PDF/.test(r.text));

    // ---- exports ----
    console.log('exports');
    r = await asAdmin(`/api/books/${bookId}/export.csv`);
    ok('sales CSV export includes marketplace and currency', r.status === 200 && /marketplace/.test(r.text) && /EUR/.test(r.text));
    r = await asAdmin('/api/lessons/export.json');
    ok('lessons export works', r.status === 200 && Array.isArray(r.body.lessons));
    r = await asAdmin('/api/contacts/export.csv');
    ok('reader list CSV export works', r.status === 200);

    // ---- paid services ----
    console.log('paid services');
    const spendBefore = mk.bookPromoSpend(bookId);
    r = await post(`/api/books/${bookId}/paid-services`, { service: 'BookBub Featured Deal', status: 'applied', cost: 150, appliedAt: mk.today() });
    ok('paid service tracked', r.status === 200 && r.body.id);
    await put(`/api/paid-services/${r.body.id}`, { status: 'done', result: '1,200 downloads in 2 days' });
    ok('its cost counts in promotion spend and the result becomes a lesson', Math.abs(mk.bookPromoSpend(bookId) - spendBefore - 150) < 0.01 && db.get("SELECT COUNT(*) AS n FROM lessons WHERE lesson_code = 'paid_service'").n === 1);

    // ---- jobs queue ----
    console.log('jobs');
    const jobId = jobs.queue(bookId, 'content_batch', { types: ['description'] });
    ok('batch job queued', typeof jobId === 'number');
    j = await runJob(jobId);
    ok('batch job completed', j.status === 'done');
    const later = jobs.queue(bookId, 'content_batch', { types: ['description'] }, '2099-01-01 00:00:00');
    await jobs.runNext();
    ok('jobs scheduled for later do not run early', db.get('SELECT status FROM jobs WHERE id = ?', [later]).status === 'queued');

    // ---- budgets + usage ----
    console.log('budgets + usage');
    r = await post('/api/settings/budgets', { kind: 'monthly', ref: mk.today().slice(0, 7), limitUsd: 50 });
    ok('monthly budget saved', r.status === 200);
    ai.logUsage('anthropic', 'x', bookId, 'description', 0, 0, 60);
    let blocked = false;
    try { ai.checkBudgets('anthropic', bookId); } catch (e) { blocked = /monthly AI budget/.test(e.message); }
    ok('overall monthly budget stops AI calls at 100%', blocked);
    r = await asAdmin('/api/settings/budgets');
    ok('budget list reports spent and percent', r.body.budgets[0].percent >= 100 && r.body.budgets[0].spent >= 60);
    r = await post('/api/settings/budgets', { kind: 'nonsense', ref: 'x', limitUsd: 5 });
    ok('unknown budget kind refused', r.status === 400);

    // ---- automation + notifications ----
    console.log('automation + notifications');
    r = await asAdmin('/api/automation/digest-preview');
    ok('daily digest builds', /daily digest/.test(r.body.text) && typeof r.body.counts.tasks === 'number');
    r = await post('/api/automation/digest');
    ok('digest posted in-app (email skipped without a provider)', r.status === 200 && db.get("SELECT COUNT(*) AS n FROM notifications WHERE kind = 'digest'").n >= 1);
    r = await asAdmin('/api/notifications');
    ok('notifications listed with unread count', r.body.unread >= 1);
    await post('/api/notifications/read-all');
    ok('mark all read', (await asAdmin('/api/notifications')).body.unread === 0);
    r = await post('/api/admin/settings', { auto_post: '0', post_webhook_url: '' });
    ok('automation settings saved', r.status === 200 && db.get("SELECT value FROM settings WHERE key = 'auto_post'").value === '0');

    // ---- dashboard ----
    console.log('dashboard');
    r = await asAdmin('/api/dashboard');
    ok('dashboard loads with the books on the board', r.body.books.length >= 3 && r.body.stages.length === 11);
    ok('dashboard carries the KDP planner', Array.isArray(r.body.kdpPlanner) && r.body.kdpPlanner.length === 3);

    // ---- CSRF ----
    console.log('csrf');
    const bad = await fetch(BASE + '/api/books', { method: 'POST', headers: { 'content-type': 'application/json', cookie: adminCookie, 'x-csrf-token': 'wrong' }, body: JSON.stringify({ title: 'Nope' }) });
    ok('state-changing request with a bad CSRF token is refused', bad.status === 403);

    // ---- persistence ----
    db.flush();
    const SQL = await require('sql.js')();
    const copy = new SQL.Database(fs.readFileSync(TEST_DB));
    ok('database file on disk has the data (batched atomic writes)', copy.exec('SELECT COUNT(*) FROM books')[0].values[0][0] >= 3);

    // ---- main admin from .env on first start ----
    console.log('admin from .env');
    process.env.ADMIN_USERNAME = 'admin'; process.env.ADMIN_PASSWORD = 'Test@12345';
    ok('existing accounts are never overwritten by .env', app.seedAdminFromEnv() === false);
    const { spawn } = require('child_process');
    const envDb = path.join(path.dirname(TEST_DB), 'env-admin.db');
    for (const f of [envDb, envDb + '.tmp']) if (fs.existsSync(f)) fs.unlinkSync(f);
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, DB_PATH: envDb, PORT: '3312', HOST: '127.0.0.1' }, stdio: 'pipe' });
    try {
      let up = false;
      for (let i = 0; i < 50 && !up; i++) { await new Promise((res) => setTimeout(res, 100)); try { up = (await fetch('http://127.0.0.1:3312/api/health')).ok; } catch { /* starting */ } }
      const fr = await (await fetch('http://127.0.0.1:3312/api/auth/first-run')).json();
      ok('first start with ADMIN_USERNAME/PASSWORD creates the admin (no sign-up screen)', fr.firstRun === false);
      const lr = await fetch('http://127.0.0.1:3312/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'Admin', password: 'Test@12345' }) });
      const lb = await lr.json();
      ok('admin signs in with the username', lr.status === 200 && lb.account.isAdmin);
      const hb = await (await fetch('http://127.0.0.1:3312/api/health')).json();
      ok('health reports version 2.2.0', hb.version === '2.2.0');
    } finally {
      child.kill('SIGTERM');
      await new Promise((res) => setTimeout(res, 300));
      for (const f of [envDb, envDb + '.tmp']) if (fs.existsSync(f)) fs.unlinkSync(f);
    }

    console.log(`\n${passed} smoke-test checks passed.`);
  } finally {
    server.close();
    for (const f of [TEST_DB, TEST_DB + '.tmp']) if (fs.existsSync(f)) fs.unlinkSync(f);
    fs.rmSync(BOOKS_DIR, { recursive: true, force: true });
  }
}

main().then(() => process.exit(0)).catch((e) => {
  console.error('\nSMOKE TEST FAILED:', e.message);
  console.error(e.stack.split('\n').slice(1, 4).join('\n'));
  process.exit(1);
});
