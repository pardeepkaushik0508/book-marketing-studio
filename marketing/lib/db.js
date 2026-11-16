// SQLite persistence via sql.js (pure JS — no native build tools needed
// on the VPS). One database file, loaded into memory on start.
//
// v2: writes are batched — the file is written at most every 300 ms
// (and on shutdown), atomically (temp file + rename), instead of after
// every single statement. Reads never write. This keeps the app fast
// with many books while staying a single-file, no-server database.
const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');
const platforms = require('./platforms');
const { PROMPTS_V2, ROUTES_V2 } = require('./prompts2');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  status TEXT NOT NULL DEFAULT 'active',
  must_change_password INTEGER NOT NULL DEFAULT 0,
  totp_secret TEXT DEFAULT '',
  totp_enabled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS imprints (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  author_name TEXT DEFAULT '',
  publisher_name TEXT DEFAULT '',
  isbn_block TEXT DEFAULT '',
  voice_profile TEXT DEFAULT '',
  website TEXT DEFAULT '',
  socials TEXT DEFAULT '{}',
  email_list TEXT DEFAULT '',
  brand_assets TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS channels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  imprint_id INTEGER NOT NULL REFERENCES imprints(id),
  platform TEXT NOT NULL,
  account TEXT DEFAULT '',
  rules TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS books (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  publish_book_id INTEGER,
  title TEXT NOT NULL,
  subtitle TEXT DEFAULT '',
  series TEXT DEFAULT '',
  series_no INTEGER,
  imprint_id INTEGER REFERENCES imprints(id),
  author TEXT DEFAULT '',
  back_cover TEXT DEFAULT '',
  author_bio TEXT DEFAULT '',
  trim TEXT DEFAULT '',
  page_count INTEGER DEFAULT 0,
  words INTEGER DEFAULT 0,
  language TEXT DEFAULT 'English',
  slug TEXT DEFAULT '',
  landing_enabled INTEGER NOT NULL DEFAULT 1,
  cover_path TEXT DEFAULT '',
  production_cost_usd REAL DEFAULT 0,
  ai_use_notes TEXT DEFAULT '',
  drive_folder TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  current_stage INTEGER NOT NULL DEFAULT 1,
  launch_date TEXT DEFAULT '',
  source TEXT NOT NULL DEFAULT 'manual',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS chapters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  no INTEGER NOT NULL,
  title TEXT DEFAULT '',
  text TEXT NOT NULL,
  words INTEGER DEFAULT 0,
  UNIQUE(book_id, no)
);
CREATE TABLE IF NOT EXISTS stages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  stage_no INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'todo',
  payload TEXT DEFAULT '{}',
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(book_id, stage_no)
);
CREATE TABLE IF NOT EXISTS metadata (
  book_id INTEGER PRIMARY KEY REFERENCES books(id) ON DELETE CASCADE,
  description TEXT DEFAULT '',
  keywords TEXT DEFAULT '[]',
  categories TEXT DEFAULT '[]',
  comparable_titles TEXT DEFAULT '[]',
  audience TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS localized_metadata (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  lang TEXT NOT NULL,
  markets TEXT DEFAULT '',
  title TEXT DEFAULT '',
  subtitle TEXT DEFAULT '',
  description TEXT DEFAULT '',
  keywords TEXT DEFAULT '[]',
  categories TEXT DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'draft',
  reviewer TEXT DEFAULT '',
  provider TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(book_id, lang)
);
CREATE TABLE IF NOT EXISTS editions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  format TEXT NOT NULL,
  language TEXT DEFAULT 'English',
  isbn TEXT DEFAULT '',
  trim TEXT DEFAULT '',
  price REAL,
  print_cost REAL,
  file_size_mb REAL,
  status TEXT DEFAULT 'planned',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS listings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  edition_id INTEGER NOT NULL REFERENCES editions(id) ON DELETE CASCADE,
  store TEXT NOT NULL,
  asin TEXT DEFAULT '',
  price REAL,
  currency TEXT DEFAULT 'USD',
  status TEXT NOT NULL DEFAULT 'not_started',
  route TEXT DEFAULT 'Direct',
  phase TEXT DEFAULT '',
  status_date TEXT DEFAULT '',
  submitted_at TEXT DEFAULT '',
  reason TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  kdp_counted INTEGER NOT NULL DEFAULT 0,
  reminded INTEGER NOT NULL DEFAULT 0,
  last_checked TEXT DEFAULT '',
  check_result TEXT DEFAULT '',
  live_link TEXT DEFAULT '',
  published_date TEXT DEFAULT '',
  preorder INTEGER NOT NULL DEFAULT 0,
  release_date TEXT DEFAULT '',
  kdp_select INTEGER NOT NULL DEFAULT 0,
  kdp_select_end TEXT DEFAULT '',
  ai_disclosure TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS marketplace_prices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  edition_id INTEGER NOT NULL REFERENCES editions(id) ON DELETE CASCADE,
  marketplace TEXT NOT NULL,
  currency TEXT NOT NULL,
  price REAL NOT NULL,
  royalty_rate REAL,
  est_royalty REAL,
  note TEXT DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(edition_id, marketplace)
);
CREATE TABLE IF NOT EXISTS paid_services (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  service TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'planned',
  applied_at TEXT DEFAULT '',
  run_date TEXT DEFAULT '',
  cost REAL DEFAULT 0,
  currency TEXT DEFAULT 'USD',
  result TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS fx_rates (
  currency TEXT PRIMARY KEY,
  per_usd REAL NOT NULL,
  source TEXT DEFAULT 'seed (approximate)',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS campaigns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  platform TEXT DEFAULT '',
  start_date TEXT DEFAULT '',
  end_date TEXT DEFAULT '',
  budget REAL DEFAULT 0,
  spend REAL DEFAULT 0,
  result TEXT DEFAULT '',
  lesson TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id INTEGER REFERENCES campaigns(id) ON DELETE CASCADE,
  book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  owner TEXT DEFAULT '',
  due_date TEXT DEFAULT '',
  reminder TEXT DEFAULT '',
  done INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS content (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  campaign_id INTEGER REFERENCES campaigns(id) ON DELETE SET NULL,
  type TEXT NOT NULL,
  channel TEXT DEFAULT '',
  lang TEXT DEFAULT 'English',
  text TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  approved INTEGER NOT NULL DEFAULT 0,
  provider TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS scheduled_posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  content_id INTEGER REFERENCES content(id) ON DELETE SET NULL,
  channel TEXT NOT NULL,
  text TEXT NOT NULL,
  image_url TEXT DEFAULT '',
  link TEXT DEFAULT '',
  scheduled_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled',
  external_id TEXT DEFAULT '',
  error TEXT DEFAULT '',
  posted_at TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT DEFAULT '',
  type TEXT NOT NULL,
  consent INTEGER NOT NULL DEFAULT 0,
  consent_date TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'confirmed',
  confirm_token TEXT DEFAULT '',
  unsub_token TEXT DEFAULT '',
  imprint_id INTEGER,
  outlet TEXT DEFAULT '',
  country TEXT DEFAULT '',
  language TEXT DEFAULT '',
  tags TEXT DEFAULT '',
  source TEXT DEFAULT '',
  history TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS arc_sends (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  sent_at TEXT NOT NULL DEFAULT (datetime('now')),
  followup_due TEXT DEFAULT '',
  followup_done INTEGER NOT NULL DEFAULT 0,
  followups INTEGER NOT NULL DEFAULT 0,
  reviewed INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  store TEXT DEFAULT '',
  contact_id INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
  rating INTEGER,
  text TEXT DEFAULT '',
  link TEXT DEFAULT '',
  date TEXT DEFAULT '',
  type TEXT DEFAULT 'customer',
  needs_reply INTEGER NOT NULL DEFAULT 0,
  reply_draft TEXT DEFAULT '',
  replied INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS endorsements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  contact_id INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
  quote TEXT DEFAULT '',
  permission INTEGER NOT NULL DEFAULT 0,
  where_used TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'requested',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS pitches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  contact_id INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
  kind TEXT NOT NULL DEFAULT 'podcast',
  outlet TEXT DEFAULT '',
  angle TEXT DEFAULT '',
  draft TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'idea',
  sent_at TEXT DEFAULT '',
  followup_due TEXT DEFAULT '',
  result TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS rights_deals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  territory TEXT NOT NULL,
  language TEXT DEFAULT '',
  rights_type TEXT DEFAULT 'translation',
  partner TEXT DEFAULT '',
  agent TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'available',
  advance REAL DEFAULT 0,
  currency TEXT DEFAULT 'USD',
  royalty_pct REAL DEFAULT 0,
  term_years INTEGER DEFAULT 0,
  signed_date TEXT DEFAULT '',
  reversion_date TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS research (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  market TEXT DEFAULT '',
  result TEXT NOT NULL,
  provider TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  imprint_id INTEGER NOT NULL REFERENCES imprints(id) ON DELETE CASCADE,
  platform TEXT NOT NULL,
  url TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'todo',
  notes TEXT DEFAULT '',
  UNIQUE(imprint_id, platform)
);
CREATE TABLE IF NOT EXISTS link_clicks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  channel TEXT DEFAULT '',
  country TEXT DEFAULT '',
  store TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS translations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  edition_id INTEGER REFERENCES editions(id) ON DELETE CASCADE,
  lang TEXT NOT NULL,
  chapter_no INTEGER NOT NULL,
  text TEXT NOT NULL,
  provider TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'machine',
  UNIQUE(edition_id, chapter_no)
);
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT DEFAULT '',
  book_id INTEGER,
  read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS promotions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  detail TEXT DEFAULT '',
  start_date TEXT DEFAULT '',
  end_date TEXT DEFAULT '',
  spend REAL DEFAULT 0,
  result_units INTEGER DEFAULT 0,
  result_royalty REAL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS ads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  platform TEXT NOT NULL,
  campaign_name TEXT DEFAULT '',
  spend REAL DEFAULT 0,
  sales REAL DEFAULT 0,
  orders INTEGER DEFAULT 0,
  impressions INTEGER DEFAULT 0,
  clicks INTEGER DEFAULT 0,
  currency TEXT DEFAULT 'USD',
  period TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS consignments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  store TEXT NOT NULL,
  copies INTEGER DEFAULT 0,
  sold INTEGER DEFAULT 0,
  paid REAL DEFAULT 0,
  notes TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS library_status (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  platform TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'not submitted',
  notes TEXT DEFAULT '',
  UNIQUE(book_id, platform)
);
CREATE TABLE IF NOT EXISTS sales (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  listing_id INTEGER REFERENCES listings(id) ON DELETE SET NULL,
  store TEXT DEFAULT '',
  marketplace TEXT DEFAULT '',
  format TEXT DEFAULT '',
  period TEXT NOT NULL,
  units INTEGER DEFAULT 0,
  kenp INTEGER DEFAULT 0,
  royalty REAL DEFAULT 0,
  currency TEXT DEFAULT 'USD',
  royalty_usd REAL,
  source TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS rank_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  store TEXT DEFAULT 'Amazon',
  category TEXT NOT NULL,
  rank INTEGER NOT NULL,
  recorded_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS milestones (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  category TEXT DEFAULT '',
  rank INTEGER,
  date TEXT NOT NULL DEFAULT (datetime('now')),
  alerted INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS competitors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  author TEXT DEFAULT '',
  isbn TEXT DEFAULT '',
  google_volume_id TEXT DEFAULT '',
  price REAL,
  rank INTEGER,
  review_count INTEGER,
  rating REAL,
  category TEXT DEFAULT '',
  source TEXT DEFAULT 'manual',
  last_checked TEXT DEFAULT '',
  alert TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS price_tests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  format TEXT DEFAULT 'ebook',
  old_price REAL NOT NULL,
  new_price REAL NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT DEFAULT '',
  units_before INTEGER DEFAULT 0,
  units_after INTEGER DEFAULT 0,
  royalty_before REAL DEFAULT 0,
  royalty_after REAL DEFAULT 0,
  verdict TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS refresh_cycles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  due_date TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled',
  analysis_json TEXT DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS recommendations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  refresh_id INTEGER REFERENCES refresh_cycles(id) ON DELETE CASCADE,
  book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  reason TEXT DEFAULT '',
  numbers_json TEXT DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending',
  created_task_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS refresh_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  detail TEXT DEFAULT '',
  result TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS lessons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  campaign_id INTEGER,
  lesson_code TEXT NOT NULL,
  text TEXT NOT NULL,
  sent_to_publish INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS api_connections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL UNIQUE,
  label TEXT DEFAULT '',
  enc_key TEXT NOT NULL,
  extra TEXT DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS task_routes (
  task TEXT PRIMARY KEY,
  provider TEXT NOT NULL DEFAULT 'builtin',
  fallback_provider TEXT DEFAULT '',
  model TEXT DEFAULT '',
  fallback_model TEXT DEFAULT '',
  temperature REAL,
  max_tokens INTEGER
);
CREATE TABLE IF NOT EXISTS prompts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task TEXT NOT NULL,
  version TEXT NOT NULL,
  text TEXT NOT NULL,
  notes TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(task, version)
);
CREATE TABLE IF NOT EXISTS usage_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,
  model TEXT DEFAULT '',
  book_id INTEGER,
  task TEXT DEFAULT '',
  tokens_in INTEGER DEFAULT 0,
  tokens_out INTEGER DEFAULT 0,
  cost_usd REAL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS budgets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  ref TEXT NOT NULL,
  limit_usd REAL NOT NULL,
  UNIQUE(kind, ref)
);
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id INTEGER,
  kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  payload TEXT DEFAULT '{}',
  run_after TEXT DEFAULT '',
  progress TEXT DEFAULT '',
  attempts INTEGER DEFAULT 0,
  error TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS activity_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER,
  action TEXT NOT NULL,
  book_id INTEGER,
  detail TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS kdp_slots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  week_start TEXT NOT NULL,
  format TEXT NOT NULL,
  used INTEGER NOT NULL DEFAULT 0,
  UNIQUE(week_start, format)
);
CREATE TABLE IF NOT EXISTS handoffs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  publish_book_id INTEGER,
  book_id INTEGER REFERENCES books(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'received',
  package_path TEXT DEFAULT '',
  note TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS gates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  stage_no INTEGER NOT NULL,
  decision TEXT NOT NULL,
  reason_code TEXT DEFAULT '',
  note TEXT DEFAULT '',
  decided_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  path TEXT DEFAULT '',
  licence_note TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sales_book ON sales(book_id, period);
CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks(done, due_date);
CREATE INDEX IF NOT EXISTS idx_content_book ON content(book_id, type);
CREATE INDEX IF NOT EXISTS idx_posts_due ON scheduled_posts(status, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status, run_after);
CREATE INDEX IF NOT EXISTS idx_clicks_book ON link_clicks(book_id, created_at);
CREATE INDEX IF NOT EXISTS idx_rank_book ON rank_history(book_id, recorded_at);
CREATE INDEX IF NOT EXISTS idx_contacts_email ON contacts(email);
CREATE INDEX IF NOT EXISTS idx_listings_status ON listings(status, status_date);
`;

// Columns added after v1. A v1 database is upgraded in place on start.
const MIGRATIONS = [
  ['books', 'series_no', 'INTEGER'],
  ['books', 'author', "TEXT DEFAULT ''"],
  ['books', 'back_cover', "TEXT DEFAULT ''"],
  ['books', 'author_bio', "TEXT DEFAULT ''"],
  ['books', 'trim', "TEXT DEFAULT ''"],
  ['books', 'page_count', 'INTEGER DEFAULT 0'],
  ['books', 'words', 'INTEGER DEFAULT 0'],
  ['books', 'language', "TEXT DEFAULT 'English'"],
  ['books', 'slug', "TEXT DEFAULT ''"],
  ['books', 'landing_enabled', 'INTEGER NOT NULL DEFAULT 1'],
  ['books', 'cover_path', "TEXT DEFAULT ''"],
  ['editions', 'print_cost', 'REAL'],
  ['editions', 'file_size_mb', 'REAL'],
  ['editions', 'status', "TEXT DEFAULT 'planned'"],
  ['listings', 'preorder', 'INTEGER NOT NULL DEFAULT 0'],
  ['arc_sends', 'followups', 'INTEGER NOT NULL DEFAULT 0'],
  ['listings', 'route', "TEXT DEFAULT 'Direct'"],
  ['listings', 'phase', "TEXT DEFAULT ''"],
  ['listings', 'status_date', "TEXT DEFAULT ''"],
  ['listings', 'submitted_at', "TEXT DEFAULT ''"],
  ['listings', 'reason', "TEXT DEFAULT ''"],
  ['listings', 'notes', "TEXT DEFAULT ''"],
  ['listings', 'kdp_counted', 'INTEGER NOT NULL DEFAULT 0'],
  ['listings', 'reminded', 'INTEGER NOT NULL DEFAULT 0'],
  ['listings', 'last_checked', "TEXT DEFAULT ''"],
  ['listings', 'check_result', "TEXT DEFAULT ''"],
  ['listings', 'release_date', "TEXT DEFAULT ''"],
  ['content', 'lang', "TEXT DEFAULT 'English'"],
  ['content', 'provider', "TEXT DEFAULT ''"],
  ['contacts', 'status', "TEXT NOT NULL DEFAULT 'confirmed'"],
  ['contacts', 'confirm_token', "TEXT DEFAULT ''"],
  ['contacts', 'unsub_token', "TEXT DEFAULT ''"],
  ['contacts', 'imprint_id', 'INTEGER'],
  ['contacts', 'outlet', "TEXT DEFAULT ''"],
  ['contacts', 'country', "TEXT DEFAULT ''"],
  ['contacts', 'language', "TEXT DEFAULT ''"],
  ['contacts', 'tags', "TEXT DEFAULT ''"],
  ['ads', 'orders', 'INTEGER DEFAULT 0'],
  ['ads', 'currency', "TEXT DEFAULT 'USD'"],
  ['sales', 'marketplace', "TEXT DEFAULT ''"],
  ['sales', 'kenp', 'INTEGER DEFAULT 0'],
  ['sales', 'royalty_usd', 'REAL'],
  ['sales', 'source', "TEXT DEFAULT ''"],
  ['competitors', 'isbn', "TEXT DEFAULT ''"],
  ['competitors', 'google_volume_id', "TEXT DEFAULT ''"],
  ['competitors', 'rating', 'REAL'],
  ['jobs', 'run_after', "TEXT DEFAULT ''"],
  ['jobs', 'progress', "TEXT DEFAULT ''"],
];

// Launch templates: [offsetDays, title, ownerHint] — one per imprint.
// Negative = before launch day, 0 = launch day, positive = after.
const COMMON_PRE = [
  [-60, 'Set up pre-order (ebook) and check every store page', 'Justin'],
  [-45, 'Author platform check: Amazon Author Central (US, UK, DE, FR, JP…), BookBub, Goodreads', 'Anil'],
  [-35, 'Generate localized metadata for priority markets; send to native reviewers', 'Anil'],
];
const LAUNCH_TEMPLATES = {
  'North American Manufacturing Press': [
    ...COMMON_PRE,
    [-30, 'Confirm launch date and formats/prices in every marketplace', 'Justin'],
    [-28, 'Send ARC copies to reader list', 'Anil'],
    [-21, 'Request endorsements from industry contacts', 'Justin'],
    [-21, 'Pitch 10 manufacturing podcasts and trade media', 'Anil'],
    [-14, 'Draft launch content kit (posts, emails, LinkedIn article, A+ content)', 'Anil'],
    [-7, 'Approve all launch content and schedule it on the calendar', 'Justin'],
    [-3, 'Check the calendar: posts and email sequence are scheduled', 'Anil'],
    [-1, 'Final check: all listings live, smart link and book page work', 'Justin'],
    [0, 'Launch day: posts go out, launch email, LinkedIn article', 'Justin'],
    [1, 'Thank early reviewers; ask ARC readers to post reviews', 'Anil'],
    [7, 'Launch week review: sales, reviews, rank, clicks per channel — adjust ads', 'Justin'],
    [14, 'Pitch libraries and bookstores (sell sheet + trade terms)', 'Anil'],
    [30, '30-day check-in: sales + reviews vs plan', 'Justin'],
    [60, 'Offer translation/foreign rights for top markets', 'Justin'],
    [90, '90-day check-in: refresh recommendations', 'Justin'],
  ],
  'Lamp & Path Press': [
    ...COMMON_PRE,
    [-30, 'Confirm launch date and formats/prices in every marketplace', 'Justin'],
    [-28, 'Send ARC copies to reader list', 'Anil'],
    [-21, 'Request endorsements from faith/community contacts', 'Justin'],
    [-21, 'Pitch faith podcasts, church libraries and Christian media', 'Anil'],
    [-14, 'Draft launch content kit (posts, emails, devotional tie-in)', 'Anil'],
    [-7, 'Approve all launch content and schedule it (own website/socials only)', 'Justin'],
    [-3, 'Check the calendar: posts and email sequence are scheduled', 'Anil'],
    [-1, 'Final check: all listings live, smart link and book page work', 'Justin'],
    [0, 'Launch day: posts go out, launch email', 'Justin'],
    [1, 'Thank early reviewers; ask ARC readers to post reviews', 'Anil'],
    [7, 'Launch week review: sales, reviews, rank, clicks per channel — adjust ads', 'Justin'],
    [14, 'Pitch Christian bookstores and church libraries (sell sheet)', 'Anil'],
    [30, '30-day check-in: sales + reviews vs plan', 'Justin'],
    [60, 'Offer translation/foreign rights for top markets', 'Justin'],
    [90, '90-day check-in: refresh recommendations', 'Justin'],
  ],
};

// Prompts use placeholders: {imprint} {author} {title} {channel} {language} {market}.
const DEFAULT_PROMPTS = {
  description: { v: '1.0', text: 'You are a book marketer for {imprint}. Write a store book description (150-250 words) for "{title}" by {author}, in the imprint voice, plain and benefit-led. Open with a one-line hook, use short paragraphs, end with a clear reason to buy now. Plain text, no markdown. Reply with the description only.' },
  social: { v: '1.0', text: 'You are a book marketer for {imprint}. Write 5 social posts for {channel} about "{title}", in the imprint voice. Each post stands alone, under 280 characters for X, up to 1,200 for LinkedIn/Facebook. Each ends with one clear call to action and the placeholder [LINK]. Reply as a numbered list, one post per number.' },
  email: { v: '1.0', text: 'You are a book marketer for {imprint}. Write a 3-email launch sequence for the reader list about "{title}" (subject line + body each), in the imprint voice. Email 1: launch announcement. Email 2: the story behind the book. Email 3: last call + ask for an honest review. Use [LINK] for the book link. Separate the emails with a line containing only ---.' },
  linkedin: { v: '1.0', text: 'You are a book marketer for {imprint}. Write a LinkedIn article (400-600 words) about the problem "{title}" solves, in the imprint voice, story first, then the lesson, ending with the book as the next step and [LINK]. Reply with the article only.' },
  presskit: { v: '1.0', text: 'You are a book marketer for {imprint}. Write a one-page press kit for "{title}" by {author}: headline, 3-sentence book summary, author bio (60-80 words), 5 interview questions, 3 talking points, and where to buy ([LINK]). Reply with the press kit only.' },
  sellsheet: { v: '1.0', text: 'You are a book marketer for {imprint}. Write a one-page sell sheet for bookstores and libraries for "{title}": 3 selling points, who it is for, comparable titles, trade terms (55% discount, returnable via IngramSpark), and ordering info (ISBN, distributor). Reply with the sell sheet only.' },
  talkingpoints: { v: '1.0', text: 'You are a book marketer for {imprint}. Write 8 podcast talking points for {author} about "{title}", each one line, in the imprint voice, each with a short story hook. Reply as a numbered list.' },
  aplus: { v: '1.0', text: 'You are a book marketer for {imprint}. Write Amazon A+ Content for "{title}": 5 modules. For each module give: module type (e.g. Standard Image & Text, Comparison Chart, Image Header with Text), headline (max 160 characters), body text (max 500 characters), and an image brief for the designer. No reviews, prices, or time-sensitive claims (A+ rules). Reply with the modules only.' },
  trailer: { v: '1.0', text: 'You are a book marketer for {imprint}. Write 3 short vertical-video scripts (30-45 seconds each) for "{title}" for Reels/Shorts{channel}: a hook in the first 2 seconds, on-screen text lines, voiceover lines, shot list, and the call to action [LINK]. Reply with the 3 scripts only.' },
  bookbub_ad: { v: '1.0', text: 'You are a book marketer for {imprint}. Write 5 BookBub/Meta ad variations for "{title}": headline (max 40 characters), primary text (max 125 characters), and an image brief using the cover. Target readers of comparable titles. Reply as a numbered list.' },
  ads_keywords: { v: '1.0', text: 'You are an Amazon Ads specialist for {imprint}. For "{title}" in the {market} market, list 60 Amazon Ads targeting keywords (search phrases real buyers type, mixed broad and long-tail, no trademarked author names unless they are comparable titles) and 15 comparable ASIN/title targets to research. Reply as two plain lists, one item per line.' },
  media_pitch: { v: '1.0', text: 'You are a publicist for {imprint}. Write a short media pitch email (under 180 words) from {author} to {channel} about "{title}": a timely angle, why their audience cares, 3 story ideas, and an offer of a review copy. Subject line first. Reply with the email only.' },
  podcast_pitch: { v: '1.0', text: 'You are a publicist for {imprint}. Write a short podcast guest pitch (under 180 words) from {author} to the host of {channel} about "{title}": a specific episode idea fitted to the show, 3 talking points, and a one-line author credential. Subject line first. Reply with the email only.' },
  library_pitch: { v: '1.0', text: 'You are a publisher at {imprint}. Write a short email to a library acquisitions librarian about "{title}": who it serves, why patrons will borrow it, formats, ISBNs placeholder [ISBN], availability via OverDrive/Hoopla/BorrowBox/IngramSpark, and an offer of a review copy. Subject line first. Reply with the email only.' },
  bookstore_pitch: { v: '1.0', text: 'You are a publisher at {imprint}. Write a short email to an independent bookstore buyer about "{title}": local/author angle, audience, trade terms (55% discount, returnable, via IngramSpark), event offer (signing or talk). Subject line first. Reply with the email only.' },
  rights_guide: { v: '1.0', text: 'You are a foreign-rights agent for {imprint}. Write a one-page rights guide entry for "{title}" by {author}: logline, 150-word synopsis, target readers, sales and review highlights placeholder [NUMBERS], why it travels to other markets, rights available (translation, audio, territories), and contact. Reply with the entry only.' },
  author_bio: { v: '1.0', text: 'You are a book marketer for {imprint}. Write three author bios for {author}: 25 words, 60 words, 150 words — third person, in the imprint voice, credentials that matter for "{title}". Reply with the three bios only.' },
  back_matter: { v: '1.0', text: 'You are a book marketer for {imprint}. Write the back matter for "{title}": a thank-you note from {author}, a request for an honest review, an invitation to the reader list with [SIGNUP LINK], and an "Also by {author}" section listing the other books given below with one-line hooks. Reply with the back matter only.' },
  newsletter: { v: '1.0', text: 'You are a book marketer for {imprint}. Write a reader newsletter (250-400 words) for {author}: a short personal story, a useful takeaway, and a soft mention of "{title}" with [LINK]. Subject line first. Reply with the newsletter only.' },
  quote_cards: { v: '1.0', text: 'You are a book marketer for {imprint}. Pull 10 short, quotable lines (under 20 words each) that capture the promise of "{title}" — written fresh from the description, suitable for quote-card images. Reply as a numbered list.' },
  arc_request: { v: '1.0', text: 'You are a book marketer for {imprint}. Write a short, warm email asking a reader to read an advance copy of "{title}" and leave an honest review. Include what the book is, when it launches, and the review link placeholder [REVIEW LINK]. Make clear the review must be honest and is not paid. Reply with the email only.' },
  arc_followup: { v: '1.0', text: 'You are a book marketer for {imprint}. Write a short, friendly follow-up to an ARC reader of "{title}" who has not posted a review yet: thank them, a gentle reminder, the link [REVIEW LINK], and no pressure. Reply with the email only.' },
  endorsement_request: { v: '1.0', text: 'You are a book marketer for {imprint}. Write a short endorsement request email for "{title}" to an industry contact: what the book is, why their words matter, and what is asked (2-3 sentences, permission to print). Reply with the email only.' },
  review_reply: { v: '1.0', text: 'You are a book marketer for {imprint}. Draft a short, gracious public reply to this reader review, in the imprint voice. Thank them, answer their point, never argue. Reply with the reply only.' },
  keyword_research: { v: '1.0', text: 'You are a KDP metadata researcher. For the book below, in the {market} Amazon store, give: (1) the 7 best KDP keyword boxes (each up to 50 characters, phrases real buyers type, no repeated words across boxes, no author names or trademarks), (2) 3 BISAC subject codes with names, (3) 3 Amazon browse categories that fit and are less crowded, with your reasoning, (4) 5 comparable recent titles. Say clearly which items you verified against live search results and which are your judgment.' },
  localize_metadata: { v: '1.0', text: 'You are a native {language} book marketer. Localize (do not just translate) this book\'s store metadata for readers in {market}. Return JSON only with keys: title, subtitle, description (150-250 words, natural {language}, local reading culture), keywords (array of 7 phrases {language} readers actually search), categories (array of 2 suggested categories). Keep the author name unchanged. Faith books: quote scripture only from an established {language} Bible translation and mark it [VERIFY SCRIPTURE].' },
};

const DEFAULT_ROUTES = {
  description: { provider: 'anthropic', fallback: 'openai' },
  social: { provider: 'anthropic', fallback: 'openai' },
  email: { provider: 'anthropic', fallback: 'openai' },
  linkedin: { provider: 'anthropic', fallback: 'openai' },
  presskit: { provider: 'anthropic', fallback: 'openai' },
  sellsheet: { provider: 'anthropic', fallback: 'openai' },
  talkingpoints: { provider: 'anthropic', fallback: 'openai' },
  aplus: { provider: 'anthropic', fallback: 'openai' },
  trailer: { provider: 'anthropic', fallback: 'openai' },
  bookbub_ad: { provider: 'anthropic', fallback: 'openai' },
  ads_keywords: { provider: 'anthropic', fallback: 'gemini' },
  media_pitch: { provider: 'anthropic', fallback: 'openai' },
  podcast_pitch: { provider: 'anthropic', fallback: 'openai' },
  library_pitch: { provider: 'anthropic', fallback: 'openai' },
  bookstore_pitch: { provider: 'anthropic', fallback: 'openai' },
  rights_guide: { provider: 'anthropic', fallback: 'openai' },
  author_bio: { provider: 'anthropic', fallback: 'openai' },
  back_matter: { provider: 'anthropic', fallback: 'openai' },
  newsletter: { provider: 'anthropic', fallback: 'openai' },
  quote_cards: { provider: 'anthropic', fallback: 'gemini' },
  arc_request: { provider: 'anthropic', fallback: 'openai' },
  arc_followup: { provider: 'anthropic', fallback: 'openai' },
  endorsement_request: { provider: 'anthropic', fallback: 'openai' },
  review_reply: { provider: 'anthropic', fallback: 'openai' },
  keyword_research: { provider: 'perplexity', fallback: 'anthropic' },
  research: { provider: 'perplexity', fallback: 'gemini' },
  localize_metadata: { provider: 'anthropic', fallback: 'openai' },
  translation: { provider: 'deepl', fallback: 'anthropic' },
  ...Object.fromEntries(Object.entries(ROUTES_V2).map(([k, [a, b]]) => [k, { provider: a, fallback: b }])),
};

// Platforms every imprint should claim (author platform checklist).
const PROFILE_PLATFORMS = [
  'Amazon Author Central — US', 'Amazon Author Central — UK', 'Amazon Author Central — DE',
  'Amazon Author Central — FR', 'Amazon Author Central — JP', 'BookBub author profile',
  'Goodreads Author Program', 'Google Play Books partner page', 'Apple Books for Authors',
  'Kobo Writing Life', 'IngramSpark catalog page', 'OverDrive / Libby listing', 'Author website',
];

// Approximate exchange rates (units per 1 USD) — a starting point only.
// Settings → Exchange rates can refresh them from the ECB (Frankfurter).
const SEED_FX = { USD: 1, CAD: 1.38, GBP: 0.76, EUR: 0.87, JPY: 152, BRL: 5.4, MXN: 18.4, AUD: 1.52, INR: 87, PLN: 3.7, SEK: 9.6 };

let db = null;
let dbPath = null;
let persistTimer = null;
let dirty = false;

function seed() {
  const n = get('SELECT COUNT(*) AS n FROM imprints').n;
  if (n === 0) {
    exec(
      'INSERT INTO imprints (name, author_name, publisher_name, isbn_block, voice_profile, website, socials, email_list, brand_assets) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        'North American Manufacturing Press', 'Justin Amaldas', 'North American Manufacturing Press', '',
        'Plain shop-floor language. Short sentences. No jargon. Stories first, then the lesson, then one practice to try on Monday. Direct, honest, practical.',
        '', JSON.stringify({ linkedin: '', x: '', facebook: '', instagram: '' }), '',
        'NAMP brand: dark green, gold accent, bold industrial, large serif title.',
      ]
    );
    exec(
      'INSERT INTO imprints (name, author_name, publisher_name, isbn_block, voice_profile, website, socials, email_list, brand_assets) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        'Lamp & Path Press', 'J. A. Gauscal', 'Lamp & Path Press', '',
        'Warm, reflective, story-led. Faith is present where it belongs in the story, never forced. Same plain language, slower pace, room to think.',
        '', JSON.stringify({ website: '', facebook: '', instagram: '', x: '' }), '',
        'LPP brand: warm, calm, lamp motif, cream and deep blue.',
      ]
    );
    const imps = query('SELECT id, name FROM imprints');
    for (const imp of imps) {
      if (imp.name.includes('Manufacturing')) {
        exec('INSERT INTO channels (imprint_id, platform, account, rules) VALUES (?, ?, ?, ?)', [imp.id, 'LinkedIn', '', 'Manufacturing books go to Justin’s LinkedIn and professional channels.']);
        exec('INSERT INTO channels (imprint_id, platform, account, rules) VALUES (?, ?, ?, ?)', [imp.id, 'X', '', 'Professional audience only.']);
        exec('INSERT INTO channels (imprint_id, platform, account, rules) VALUES (?, ?, ?, ?)', [imp.id, 'Email list', '', 'Reader list and ARC readers.']);
      } else {
        exec('INSERT INTO channels (imprint_id, platform, account, rules) VALUES (?, ?, ?, ?)', [imp.id, 'Own website', '', 'Lamp & Path books go ONLY to their own website and socials — never cross over to the manufacturing channels.']);
        exec('INSERT INTO channels (imprint_id, platform, account, rules) VALUES (?, ?, ?, ?)', [imp.id, 'Facebook', '', 'Lamp & Path audience only.']);
        exec('INSERT INTO channels (imprint_id, platform, account, rules) VALUES (?, ?, ?, ?)', [imp.id, 'Instagram', '', 'Lamp & Path audience only.']);
        exec('INSERT INTO channels (imprint_id, platform, account, rules) VALUES (?, ?, ?, ?)', [imp.id, 'Email list', '', 'Lamp & Path reader list only.']);
      }
    }
  }
  for (const imp of query('SELECT id, name FROM imprints')) {
    for (const p of platforms.PROFILES_BY_IMPRINT[imp.name] || platforms.PROFILE_COMMON) exec('INSERT OR IGNORE INTO profiles (imprint_id, platform) VALUES (?, ?)', [imp.id, p]);
  }
  // Store names from earlier versions → the platform catalog.
  for (const [from, to] of Object.entries(platforms.RENAMES)) {
    exec('UPDATE listings SET store = ? WHERE store = ? AND NOT EXISTS (SELECT 1 FROM listings l2 WHERE l2.edition_id = listings.edition_id AND l2.store = ?)', [to, from, to]);
    exec('UPDATE library_status SET platform = ? WHERE platform = ?', [to, from]);
  }
  exec("UPDATE listings SET status = 'not_started' WHERE status = 'planned'");
  exec("UPDATE listings SET kdp_counted = 1 WHERE store = 'KDP' AND status IN ('live','pre-order') AND kdp_counted = 0");
  // Pen names: Lamp & Path books are by J. A. Gauscal (Book Marketing doc).
  // Applied once; the admin can change it later in Settings → Imprints.
  if (!get("SELECT value FROM settings WHERE key = 'migrated_pen_names'")) {
    for (const [imprint, pen] of Object.entries(platforms.PEN_NAMES)) {
      const imp = get('SELECT * FROM imprints WHERE name = ?', [imprint]);
      if (!imp) continue;
      if (imprint === 'Lamp & Path Press' && imp.author_name === 'Justin Amaldas') exec('UPDATE imprints SET author_name = ? WHERE id = ?', [pen, imp.id]);
      exec("UPDATE books SET author = ? WHERE imprint_id = ? AND (author = '' OR author IS NULL OR (? = 'J. A. Gauscal' AND author = 'Justin Amaldas'))", [pen, imp.id, pen]);
    }
    exec("INSERT OR REPLACE INTO settings (key, value) VALUES ('migrated_pen_names', '1')");
  }
  for (const [task, p] of Object.entries(DEFAULT_PROMPTS)) {
    exec('INSERT OR IGNORE INTO prompts (task, version, text) VALUES (?, ?, ?)', [task, p.v, p.text]);
  }
  // v2 prompts become current unless you already saved your own version.
  for (const [task, text] of Object.entries(PROMPTS_V2)) {
    const latest = get('SELECT version FROM prompts WHERE task = ? ORDER BY id DESC LIMIT 1', [task]);
    if (latest && latest.version !== '1.0') continue;
    exec('INSERT OR IGNORE INTO prompts (task, version, text, notes) VALUES (?, ?, ?, ?)', [task, '2.0', text, 'v2: role, context, task, constraints, output format']);
  }
  for (const [task, r] of Object.entries(DEFAULT_ROUTES)) {
    exec('INSERT OR IGNORE INTO task_routes (task, provider, fallback_provider) VALUES (?, ?, ?)', [task, r.provider, r.fallback]);
  }
  for (const [cur, rate] of Object.entries(SEED_FX)) {
    exec('INSERT OR IGNORE INTO fx_rates (currency, per_usd) VALUES (?, ?)', [cur, rate]);
  }
  const defaults = {
    handoff_token: '',
    automation_enabled: '1',
    auto_refresh_analysis: '1',
    auto_launch_content: '1',
    auto_post: '1',
    auto_arc_followup: 'draft',
    auto_competitor_recheck: '1',
    auto_fx_refresh: '0',
    auto_live_check: '1',
    digest_hour_utc: '14',
    double_opt_in: '1',
    public_base_url: '',
  };
  for (const [k, v] of Object.entries(defaults)) exec('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)', [k, v]);
  // Books from v1 have no link name yet — give them one.
  for (const b of query("SELECT id, title FROM books WHERE slug IS NULL OR slug = ''")) {
    let base = String(b.title || 'book').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'book';
    if (get('SELECT id FROM books WHERE slug = ?', [base])) base = `${base}-${b.id}`;
    exec('UPDATE books SET slug = ? WHERE id = ?', [base, b.id]);
  }
  // v1 readers were added by hand with consent — give them unsubscribe links.
  for (const c of query("SELECT id FROM contacts WHERE unsub_token IS NULL OR unsub_token = ''")) {
    exec('UPDATE contacts SET unsub_token = ? WHERE id = ?', [require('crypto').randomBytes(16).toString('hex'), c.id]);
  }
}

function migrate() {
  for (const [table, col, type] of MIGRATIONS) {
    const cols = query(`PRAGMA table_info(${table})`).map((c) => c.name);
    if (!cols.includes(col)) db.run(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
  }
}

async function init(dbFile) {
  dbPath = path.resolve(dbFile);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const SQL = await initSqlJs();
  db = fs.existsSync(dbPath) ? new SQL.Database(fs.readFileSync(dbPath)) : new SQL.Database();
  db.exec('PRAGMA foreign_keys = ON;');
  // Tables first (CREATE IF NOT EXISTS keeps v1 tables), then the new
  // columns, then indexes (which may reference the new columns).
  const [tablesSql, indexSql] = splitSchema(SCHEMA);
  db.exec(tablesSql);
  migrate();
  db.exec(indexSql);
  seed();
  flush();
  return db;
}

function splitSchema(sql) {
  const stmts = sql.split(';').map((s) => s.trim()).filter(Boolean);
  const idx = stmts.filter((s) => /^CREATE INDEX/i.test(s));
  const rest = stmts.filter((s) => !/^CREATE INDEX/i.test(s));
  return [rest.join(';\n') + ';', idx.join(';\n') + ';'];
}

// Write the database file atomically: temp file, then rename.
function flush() {
  if (!db || !dbPath) return;
  if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; }
  const tmp = dbPath + '.tmp';
  fs.writeFileSync(tmp, Buffer.from(db.export()));
  fs.renameSync(tmp, dbPath);
  dirty = false;
}

function persistSoon() {
  dirty = true;
  if (persistTimer) return;
  persistTimer = setTimeout(() => { persistTimer = null; try { flush(); } catch (e) { console.error('DB write failed:', e.message); } }, 300);
  if (persistTimer.unref) persistTimer.unref();
}

function query(sql, params = []) {
  const stmt = db.prepare(sql);
  try {
    stmt.bind(params.map((p) => (p === undefined ? null : p)));
    const out = [];
    while (stmt.step()) out.push(stmt.getAsObject());
    return out;
  } finally {
    stmt.free();
  }
}

function get(sql, params = []) {
  const rows = query(sql, params);
  return rows[0] || null;
}

function exec(sql, params = []) {
  db.run(sql, params.map((p) => (p === undefined ? null : p)));
  const info = query('SELECT last_insert_rowid() AS id')[0];
  persistSoon();
  return info ? info.id : null;
}

// Run several writes as one transaction (all or nothing).
function transaction(fn) {
  db.run('BEGIN');
  try { const out = fn(); db.run('COMMIT'); persistSoon(); return out; } catch (e) { db.run('ROLLBACK'); throw e; }
}

function isDirty() { return dirty; }

// Make sure nothing is lost on shutdown.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { try { flush(); } catch { /* ignore */ } process.exit(0); });
}
process.on('exit', () => { try { if (dirty) flush(); } catch { /* ignore */ } });

module.exports = {
  init, query, get, exec, transaction, flush, persist: flush, isDirty,
  LAUNCH_TEMPLATES, DEFAULT_PROMPTS, DEFAULT_ROUTES, PROFILE_PLATFORMS, SEED_FX,
};
