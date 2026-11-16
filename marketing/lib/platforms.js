// Platform catalog and per-imprint rollout plans, taken from the
// "Book Marketing" document (Free platforms, Paid platforms, Amazon
// formats, Spiral-bound workbooks, Recommended setup per imprint).
//
// Every edition × platform pair is one listing row with a status:
//   not_started → uploaded → in_review → live (or pre-order)
//   rejected (with reason) · delisted · na (not applicable to this book)
// The catalog says which formats a platform takes, how it is reached
// (direct or through an aggregator), whether KDP Select blocks it, and
// whether the app can check "is it live?" through a free public lookup.

const EBOOK = ['ebook', 'translation'];
const PRINT = ['paperback', 'hardcover', 'large print'];
const AUDIO = ['audiobook'];
const SPIRAL = ['spiral workbook'];

// category: amazon | ebook | print | library | subscription | audio | direct | distributor
const PLATFORMS = [
  // ---- Amazon ----
  { name: 'KDP', category: 'amazon', formats: [...EBOOK, ...PRINT], routes: ['Direct'], url: 'https://kdp.amazon.com', note: 'Kindle ebook, paperback and hardcover. Ebook not in KDP Select when going wide. Editions link onto one product page (can take up to a week).' },
  { name: 'Kindle Translate', category: 'amazon', formats: EBOOK, routes: ['Direct'], url: 'https://kdp.amazon.com', note: 'KDP AI translation beta (invite-only) — for other language markets.' },
  { name: 'KDP Virtual Voice', category: 'amazon', formats: EBOOK, routes: ['Direct'], url: 'https://kdp.amazon.com', note: 'KDP AI-narrated audiobook beta (invite-only), made from the Kindle ebook.' },
  { name: 'ACX / Audible', category: 'audio', formats: AUDIO, routes: ['Direct'], url: 'https://www.acx.com', note: 'Per the Book Marketing doc: from May 2026, 50% royalty if exclusive to Audible, 30% if non-exclusive.' },
  { name: 'Amazon seller account', category: 'direct', formats: SPIRAL, routes: ['Direct'], url: 'https://sell.amazon.com', note: 'For spiral workbooks — KDP, Amazon print and Ingram will not distribute spiral books. Copies printed by Lulu, shipped by you or a fulfilment service.' },

  // ---- Ebook stores ----
  { name: 'Apple Books', category: 'ebook', formats: [...EBOOK, ...AUDIO], routes: ['Direct', 'Draft2Digital', 'PublishDrive'], url: 'https://authors.apple.com', check: 'apple', selectBlocked: true, note: '70% flat at any price. Direct upload needs a Mac; on a PC use an aggregator. 250 free promo codes per title for reviewers.' },
  { name: 'Kobo Writing Life', category: 'ebook', formats: EBOOK, routes: ['Direct', 'Draft2Digital', 'PublishDrive'], url: 'https://www.kobo.com/writinglife', selectBlocked: true, note: 'Strong in Canada; 190+ countries. Turns away a large share of AI-heavy submissions — record the reason if rejected.' },
  { name: 'Google Play Books', category: 'ebook', formats: [...EBOOK, ...AUDIO], routes: ['Direct', 'PublishDrive'], url: 'https://play.google.com/books/publish', check: 'google', selectBlocked: true, note: 'Underused by most authors; Draft2Digital does not reach it.' },
  { name: 'Barnes & Noble Press', category: 'ebook', formats: [...EBOOK, ...PRINT], routes: ['Direct', 'Draft2Digital', 'PublishDrive'], url: 'https://press.barnesandnoble.com', selectBlocked: true, note: 'Website plus in-store ordering for print. Asks about AI use.' },
  { name: 'Kotobee Books', category: 'ebook', formats: EBOOK, routes: ['Direct'], url: 'https://www.kotobee.com', selectBlocked: true, note: 'Highest rate of the five direct stores; small store.' },
  { name: 'Tolino', category: 'ebook', formats: EBOOK, routes: ['Draft2Digital', 'PublishDrive'], selectBlocked: true, note: 'Germany. No direct indie account.' },
  { name: 'Vivlio', category: 'ebook', formats: EBOOK, routes: ['Draft2Digital', 'PublishDrive'], selectBlocked: true, note: 'France.' },
  { name: 'Smashwords Store', category: 'ebook', formats: EBOOK, routes: ['Draft2Digital'], selectBlocked: true, note: '' },
  { name: 'Fable', category: 'ebook', formats: EBOOK, routes: ['Draft2Digital'], selectBlocked: true, note: '' },
  { name: 'Bookshop.org', category: 'ebook', formats: [...EBOOK, ...PRINT], routes: ['Draft2Digital', 'IngramSpark'], selectBlocked: true, note: 'Ebooks via Draft2Digital; print via IngramSpark.' },

  // ---- Print ----
  { name: 'IngramSpark', category: 'print', formats: PRINT, routes: ['Direct'], url: 'https://www.ingramspark.com', note: '40,000+ bookstores and libraries; dust jacket and cloth hardcovers. Free setup and revisions since Feb 2026; 1.875% fee per sale (per the Book Marketing doc).' },
  { name: 'Lulu', category: 'print', formats: [...PRINT, ...SPIRAL], routes: ['Direct'], url: 'https://www.lulu.com', note: 'Workbooks, spiral binding, bulk author copies, Lulu store.' },

  // ---- Libraries & subscription ----
  { name: 'OverDrive / Libby', category: 'library', formats: [...EBOOK, ...AUDIO], routes: ['Draft2Digital', 'IngramSpark', 'PublishDrive', 'Voices by INaudio'], selectBlocked: true, note: '38,000+ libraries and schools in 70+ countries.' },
  { name: 'Hoopla', category: 'library', formats: [...EBOOK, ...AUDIO], routes: ['Draft2Digital', 'Voices by INaudio'], selectBlocked: true, note: 'Pay per checkout.' },
  { name: 'BorrowBox', category: 'library', formats: [...EBOOK, ...AUDIO], routes: ['Draft2Digital', 'Voices by INaudio'], selectBlocked: true, note: 'UK, Ireland, Australia, NZ.' },
  { name: 'cloudLibrary / Bibliotheca', category: 'library', formats: EBOOK, routes: ['Draft2Digital'], selectBlocked: true, note: '' },
  { name: 'Vivlio Libraries', category: 'library', formats: EBOOK, routes: ['Draft2Digital'], selectBlocked: true, note: '' },
  { name: 'Odilo', category: 'library', formats: EBOOK, routes: ['Draft2Digital'], selectBlocked: true, note: '' },
  { name: 'Everand', category: 'subscription', formats: [...EBOOK, ...AUDIO], routes: ['Draft2Digital', 'Voices by INaudio'], selectBlocked: true, note: 'Formerly Scribd.' },

  // ---- Audio ----
  { name: 'Spotify for Authors', category: 'audio', formats: AUDIO, routes: ['Direct'], url: 'https://authors.spotify.com', note: 'Open to self-published authors since Aug 2025.' },
  { name: 'Voices by INaudio', category: 'audio', formats: AUDIO, routes: ['Direct'], url: 'https://www.inaudio.com', note: 'Formerly Findaway Voices. No upfront fees; reaches Chirp, Libro.fm, library apps and dozens more.' },
  { name: 'Kobo audiobooks', category: 'audio', formats: AUDIO, routes: ['Direct'], url: 'https://www.kobo.com/writinglife', note: 'Same Kobo Writing Life account.' },
  { name: "Author's Republic", category: 'audio', formats: AUDIO, routes: ['Direct'], url: 'https://www.authorsrepublic.com', note: 'Commission-based, no subscription.' },

  // ---- Direct sales ----
  { name: 'Own website store', category: 'direct', formats: [...EBOOK, ...PRINT, ...SPIRAL, ...AUDIO], routes: ['Direct'], selectBlocked: true, note: 'Ebook only if not in KDP Select.' },
  { name: 'Gumroad', category: 'direct', formats: [...EBOOK, ...AUDIO], routes: ['Direct'], url: 'https://gumroad.com', selectBlocked: true, note: 'Free to list; a cut per sale.' },
  { name: 'Payhip', category: 'direct', formats: [...EBOOK, ...AUDIO], routes: ['Direct'], url: 'https://payhip.com', selectBlocked: true, note: 'Free to list; a cut per sale.' },
  { name: 'Ko-fi', category: 'direct', formats: [...EBOOK, ...AUDIO], routes: ['Direct'], url: 'https://ko-fi.com', selectBlocked: true, note: 'Free to list; a cut per sale.' },
  { name: 'Books.by', category: 'direct', formats: [...EBOOK, ...PRINT], routes: ['Direct'], url: 'https://books.by', selectBlocked: true, note: 'Your own direct ebook and print store — $99/year.' },

  // ---- Aggregators (the account itself) ----
  { name: 'Draft2Digital', category: 'distributor', formats: EBOOK, routes: ['Direct'], url: 'https://www.draft2digital.com', selectBlocked: true, note: 'One upload to most stores and libraries. $20 activation for new accounts (since April 2026), plus about 10% of retail.' },
  { name: 'PublishDrive', category: 'distributor', formats: EBOOK, routes: ['Direct'], url: 'https://publishdrive.com', selectBlocked: true, note: '50+ retailers including Google Play. From $13.99/month billed yearly; 0% commission.' },
];

// Statuses in order. "done" statuses count as published.
const STATUSES = ['not_started', 'uploaded', 'in_review', 'live', 'pre-order', 'rejected', 'delisted', 'na'];
const STATUS_LABELS = { not_started: 'Not started', uploaded: 'Uploaded', in_review: 'In review', live: 'Live', 'pre-order': 'Pre-order', rejected: 'Rejected', delisted: 'Delisted', na: 'Not applicable' };
const DONE = ['live', 'pre-order'];
const PENDING = ['uploaded', 'in_review'];
const OPEN = ['not_started', 'uploaded', 'in_review', 'rejected'];

// Phases for the rollout checklist.
const PHASES = [
  ['launch', 'Launch — Amazon first'],
  ['wide', 'Go wide — first two weeks'],
  ['after-proof', 'Once the book proves it sells'],
  ['optional', 'Optional'],
];

// Rollout plan per imprint — "Recommended setup per imprint".
// [platform, formats, phase, route]
const LIBS_AND_SMALL = ['OverDrive / Libby', 'Hoopla', 'BorrowBox', 'cloudLibrary / Bibliotheca', 'Vivlio Libraries', 'Odilo', 'Everand', 'Tolino', 'Vivlio', 'Smashwords Store', 'Fable', 'Bookshop.org'];
const COMMON_EBOOK = [
  ['KDP', EBOOK, 'launch', 'Direct'],
  ['Apple Books', EBOOK, 'wide', 'Direct'],
  ['Kobo Writing Life', EBOOK, 'wide', 'Direct'],
  ['Google Play Books', EBOOK, 'wide', 'Direct'],
  ['Barnes & Noble Press', EBOOK, 'wide', 'Direct'],
  ['Draft2Digital', EBOOK, 'wide', 'Direct'],
  ...LIBS_AND_SMALL.map((p) => [p, EBOOK, 'wide', 'Draft2Digital']),
  ['Kotobee Books', EBOOK, 'optional', 'Direct'],
  ['Own website store', EBOOK, 'optional', 'Direct'],
  ['Kindle Translate', EBOOK, 'optional', 'Direct'],
];

const PLANS = {
  'North American Manufacturing Press': [
    ...COMMON_EBOOK,
    ['KDP', ['paperback', 'hardcover', 'large print'], 'launch', 'Direct'],
    ['IngramSpark', ['paperback', 'hardcover', 'large print'], 'launch', 'Direct'],
    ['Bookshop.org', ['paperback', 'hardcover'], 'wide', 'IngramSpark'],
    ['Barnes & Noble Press', ['paperback', 'hardcover'], 'optional', 'Direct'],
    ['ACX / Audible', AUDIO, 'after-proof', 'Direct'],
    ['Spotify for Authors', AUDIO, 'after-proof', 'Direct'],
    ['Voices by INaudio', AUDIO, 'after-proof', 'Direct'],
    ['Kobo audiobooks', AUDIO, 'optional', 'Direct'],
    ["Author's Republic", AUDIO, 'optional', 'Direct'],
    ['Lulu', SPIRAL, 'launch', 'Direct'],
    ['Amazon seller account', SPIRAL, 'wide', 'Direct'],
    ['Own website store', SPIRAL, 'optional', 'Direct'],
  ],
  'Lamp & Path Press': [
    ...COMMON_EBOOK,
    ['KDP', ['paperback', 'hardcover', 'large print'], 'launch', 'Direct'],
    ['IngramSpark', ['paperback', 'hardcover'], 'optional', 'Direct'],
    ['ACX / Audible', AUDIO, 'wide', 'Direct'],
    ['Spotify for Authors', AUDIO, 'wide', 'Direct'],
    ['Voices by INaudio', AUDIO, 'wide', 'Direct'],
    ['Kobo audiobooks', AUDIO, 'optional', 'Direct'],
    ['Lulu', SPIRAL, 'optional', 'Direct'],
  ],
};

// Paid and fee-based services (tracked per book; cost counts in the margin).
const PAID_SERVICES = [
  { name: 'BookFunnel', what: 'Sends ebook copies to reviewers and your email list' },
  { name: 'NetGalley', what: 'Advance copies to reviewers, librarians and booksellers' },
  { name: 'Reedsy Discovery', what: 'Reader reviews and a featured launch listing' },
  { name: 'BookBub Featured Deal', what: 'Strong discount promotion — the book must be selected' },
  { name: 'Kirkus Indie Reviews', what: 'Professional review to quote on the cover and Amazon page' },
  { name: 'Written Word Media', what: 'Paid email blast announcing a discount' },
  { name: 'Other newsletter promo', what: 'Paid email blast (Fussy Librarian, Freebooksy, etc.)' },
];
const PAID_STATUSES = ['planned', 'applied', 'accepted', 'rejected', 'scheduled', 'running', 'done', 'cancelled'];

// Reputation profiles per imprint / pen name.
const PROFILE_COMMON = [
  'Amazon Author Central — US', 'Amazon Author Central — UK', 'Amazon Author Central — DE', 'Amazon Author Central — FR', 'Amazon Author Central — JP',
  'Goodreads Author Program', 'BookBub author profile', 'The StoryGraph', 'LibraryThing', 'Google Play Books partner page', 'Apple Books for Authors',
  'Kobo Writing Life', 'IngramSpark catalog page', 'OverDrive / Libby listing', 'Author website', 'Substack', 'Medium',
];
const PROFILES_BY_IMPRINT = {
  'North American Manufacturing Press': [...PROFILE_COMMON, 'LinkedIn (Justin Amaldas)'],
  'Lamp & Path Press': [...PROFILE_COMMON, 'Pen-name email address', 'Facebook page', 'Instagram account', 'Logo'],
};

// Pen names — nothing crosses between the lines.
const PEN_NAMES = { 'North American Manufacturing Press': 'Justin Amaldas', 'Lamp & Path Press': 'J. A. Gauscal' };

function platform(name) { return PLATFORMS.find((p) => p.name === name) || null; }
function forFormat(format) { return PLATFORMS.filter((p) => p.formats.includes(format)); }
function planFor(imprintName) { return PLANS[imprintName] || PLANS['North American Manufacturing Press']; }

// Old v1/v2.0 store names → catalog names.
const RENAMES = {
  Kobo: 'Kobo Writing Life', 'Google Play': 'Google Play Books', 'Barnes & Noble': 'Barnes & Noble Press', OverDrive: 'OverDrive / Libby',
  'Audible / ACX': 'ACX / Audible', 'Spotify / Findaway Voices': 'Voices by INaudio',
};

module.exports = {
  PLATFORMS, STATUSES, STATUS_LABELS, DONE, PENDING, OPEN, PHASES, PLANS, PAID_SERVICES, PAID_STATUSES,
  PROFILES_BY_IMPRINT, PROFILE_COMMON, PEN_NAMES, RENAMES, platform, forFormat, planFor,
};
