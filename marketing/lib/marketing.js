// Marketing pipeline logic: the 11 stages, the KDP weekly upload cap,
// launch calendars, refresh-cycle analysis, bestseller milestones,
// margin math (multi-currency), CSV parsing and small text helpers.
// No secrets here — only math and rules.
const db = require('./db');
const global = require('./global');

const STAGES = [
  [1, 'Final copy upload', 'human'],
  [2, 'Positioning', 'human'],
  [3, 'Formats & pricing', 'human'],
  [4, 'Compliance', 'human'],
  [5, 'Listings', 'human'],
  [6, 'Pre-launch', 'human'],
  [7, 'Launch', 'human'],
  [8, 'Promotion', 'auto'],
  [9, 'Bookstores & libraries', 'ongoing'],
  [10, 'Editions', 'ongoing'],
  [11, 'Measure & improve', 'ongoing'],
];

const platforms = require('./platforms');
const STORES = platforms.PLATFORMS.map((p) => p.name);
const FORMATS = ['ebook', 'paperback', 'hardcover', 'large print', 'audiobook', 'spiral workbook', 'translation'];
const LIBRARY_PLATFORMS = platforms.PLATFORMS.filter((p) => p.category === 'library').map((p) => p.name);

// ---- KDP weekly upload cap (verified on KDP's help page G202172740,
// 2026-11-16): max 2 NEW titles per book format per week (ebook,
// paperback, hardcover separately); drafts count; resets Sunday 00:00 UTC.
function weekStartSunday(d = new Date()) {
  const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  x.setUTCDate(x.getUTCDate() - x.getUTCDay());
  return x.toISOString().slice(0, 10);
}

function kdpSlotStatus(format) {
  const week = weekStartSunday();
  const row = db.get('SELECT used FROM kdp_slots WHERE week_start = ? AND format = ?', [week, format]);
  const used = row ? row.used : 0;
  return { week, format, used, limit: 2, remaining: Math.max(0, 2 - used), allowed: used < 2 };
}

function recordKdpUse(format) {
  const s = kdpSlotStatus(format);
  if (!s.allowed) {
    throw new Error(`KDP weekly cap reached for ${format}: 2 new titles per format per week (verified on KDP's help page). Next slot opens Sunday 00:00 UTC (Saturday 5pm Calgary).`);
  }
  db.exec('INSERT INTO kdp_slots (week_start, format, used) VALUES (?, ?, 1) ON CONFLICT(week_start, format) DO UPDATE SET used = used + 1', [s.week, format]);
  return kdpSlotStatus(format);
}

function kdpPlanner() {
  return ['ebook', 'paperback', 'hardcover'].map((f) => {
    const s = kdpSlotStatus(f);
    const end = new Date(s.week + 'T00:00:00Z');
    end.setUTCDate(end.getUTCDate() + 6);
    return { ...s, weekStart: s.week, weekEnd: end.toISOString().slice(0, 10) };
  });
}

// ---- dates ----
function addDays(dateStr, days) {
  const d = new Date(dateStr + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
function today() { return new Date().toISOString().slice(0, 10); }

// ---- stage gates ----
// A stage can be approved only when the stage before it is done or
// skipped. Stage 1 has no predecessor.
function stageGateCheck(bookId, stageNo) {
  if (stageNo <= 1) return null;
  const prev = db.get('SELECT status FROM stages WHERE book_id = ? AND stage_no = ?', [bookId, stageNo - 1]);
  if (!prev || !['done', 'skipped'].includes(prev.status)) {
    const name = (STAGES.find((s) => s[0] === stageNo - 1) || [])[1] || `stage ${stageNo - 1}`;
    return `Finish stage ${stageNo - 1} (${name}) first — approve or skip its gate before approving stage ${stageNo}.`;
  }
  return null;
}

// ---- launch calendar ----
function generateLaunchTasks(bookId, launchDate, imprintName) {
  const template = db.LAUNCH_TEMPLATES[imprintName] || db.LAUNCH_TEMPLATES['North American Manufacturing Press'];
  let campaign = db.get('SELECT id FROM campaigns WHERE book_id = ? AND type = ? AND name = ?', [bookId, 'launch', `Launch — ${launchDate}`]);
  const campaignId = campaign ? campaign.id : db.exec(
    'INSERT INTO campaigns (book_id, type, name, start_date, end_date, status) VALUES (?, ?, ?, ?, ?, ?)',
    [bookId, 'launch', `Launch — ${launchDate}`, addDays(launchDate, -60), addDays(launchDate, 90), 'active']
  );
  const made = [];
  for (const [offset, title, owner] of template) {
    if (db.get('SELECT id FROM tasks WHERE campaign_id = ? AND title = ?', [campaignId, title])) continue;
    const due = addDays(launchDate, offset);
    const id = db.exec('INSERT INTO tasks (campaign_id, book_id, title, owner, due_date, done) VALUES (?, ?, ?, ?, ?, 0)', [campaignId, bookId, title, owner, due]);
    made.push({ id, title, due, owner });
  }
  return { campaignId, made };
}

// ---- sales / margin (all money in USD; foreign royalties converted) ----
function royaltyUsd(row) {
  if (row.royalty_usd != null) return row.royalty_usd;
  const v = global.toUsd(row.royalty || 0, row.currency || 'USD');
  return v == null ? 0 : v;
}

function bookSales(bookId) {
  const rows = db.query('SELECT units, royalty, currency, royalty_usd FROM sales WHERE book_id = ?', [bookId]);
  let units = 0, royalty = 0;
  for (const r of rows) { units += r.units || 0; royalty += royaltyUsd(r); }
  return { units, royalty: Math.round(royalty * 100) / 100 };
}
function bookPromoSpend(bookId) {
  const p = db.get('SELECT COALESCE(SUM(spend),0) AS s FROM promotions WHERE book_id = ?', [bookId]).s;
  const adsRows = db.query('SELECT spend, currency FROM ads WHERE book_id = ?', [bookId]);
  const a = adsRows.reduce((sum, r) => sum + (global.toUsd(r.spend || 0, r.currency || 'USD') || 0), 0);
  const paid = db.query("SELECT cost, currency FROM paid_services WHERE book_id = ? AND status != 'cancelled'", [bookId])
    .reduce((sum, r) => sum + (global.toUsd(r.cost || 0, r.currency || 'USD') || 0), 0);
  return Math.round((p + a + paid) * 100) / 100;
}
function bookMargin(bookId) {
  const book = db.get('SELECT production_cost_usd FROM books WHERE id = ?', [bookId]);
  const sales = bookSales(bookId);
  const spend = bookPromoSpend(bookId);
  const production = book ? book.production_cost_usd || 0 : 0;
  const net = Math.round((sales.royalty - spend - production) * 100) / 100;
  return { production, productionCost: production, royalty: sales.royalty, units: sales.units, spend, margin: net, net };
}
// Break-even ACOS: the most an ad can cost per sale before it loses money
// = royalty per sale ÷ list price. From real sales when there are any,
// otherwise from the ebook's US royalty estimate.
function breakEvenAcos(bookId) {
  const s = bookSales(bookId);
  const eds = db.query('SELECT * FROM editions WHERE book_id = ? AND price > 0', [bookId]);
  const avgPrice = eds.length ? eds.reduce((a, e) => a + e.price, 0) / eds.length : 0;
  let royaltyPerSale = s.units > 0 ? s.royalty / s.units : 0;
  let basis = 'actual sales';
  if (!royaltyPerSale) {
    const eb = eds.find((e) => e.format === 'ebook') || eds[0];
    if (eb) { const us = global.priceLadder(eb).find((r) => r.marketplace === 'US'); royaltyPerSale = us?.royaltyUsd || 0; basis = `estimated from the ${eb.format} US price`; }
  }
  const price = s.units > 0 && avgPrice ? avgPrice : (eds.find((e) => e.format === 'ebook') || eds[0])?.price || 0;
  const pct = price > 0 && royaltyPerSale > 0 ? Math.round((royaltyPerSale / price) * 1000) / 10 : null;
  return { royaltyPerSale: Math.round(royaltyPerSale * 100) / 100, avgPrice: Math.round(price * 100) / 100, breakEvenAcos: pct, basis };
}

// Amazon and the FTC expect reviewers who got a free copy to say so.
// Every ARC email carries the line, even a local draft.
const ARC_DISCLOSURE = 'If you post a review, please mention that you received a free advance copy.';
function ensureArcDisclosure(text) {
  return /free (advance |review )?copy/i.test(text || '') ? text : `${(text || '').trim()}\n\n${ARC_DISCLOSURE}`;
}

function imprintMargin(imprintId) {
  const books = db.query('SELECT id FROM books WHERE imprint_id = ?', [imprintId]);
  let royalty = 0, spend = 0, production = 0, units = 0;
  for (const b of books) {
    const m = bookMargin(b.id);
    royalty += m.royalty; spend += m.spend; production += m.production; units += m.units;
  }
  const net = Math.round((royalty - spend - production) * 100) / 100;
  return { books: books.length, royalty, spend, production, units, margin: net, net };
}

function periodDate(p) {
  const s = String(p || '');
  if (/^\d{4}-\d{2}$/.test(s)) return Date.parse(s + '-01');
  return Date.parse(s.slice(0, 10));
}

// Units/royalty in the last N days vs the N days before.
function salesTrend(bookId, days = 30) {
  const rows = db.query('SELECT period, units, royalty, currency, royalty_usd FROM sales WHERE book_id = ?', [bookId]);
  const now = Date.now();
  const recent = { units: 0, royalty: 0 }, prior = { units: 0, royalty: 0 };
  for (const r of rows) {
    const t = periodDate(r.period);
    if (Number.isNaN(t)) continue;
    const ageDays = (now - t) / 86400000;
    const bucket = ageDays <= days ? recent : ageDays <= days * 2 ? prior : null;
    if (bucket) { bucket.units += r.units || 0; bucket.royalty += royaltyUsd(r); }
  }
  const pct = prior.units > 0 ? Math.round(((recent.units - prior.units) / prior.units) * 100) : (recent.units > 0 ? 100 : 0);
  return { recent, prior, pct };
}

// Monthly totals (USD) for charts: [{ month, units, royalty }]
function monthlySales(bookId) {
  const rows = bookId
    ? db.query('SELECT period, units, royalty, currency, royalty_usd, marketplace, store FROM sales WHERE book_id = ?', [bookId])
    : db.query('SELECT period, units, royalty, currency, royalty_usd, marketplace, store FROM sales');
  const by = {};
  const byMarket = {};
  for (const r of rows) {
    const m = String(r.period || '').slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(m)) continue;
    const b = (by[m] = by[m] || { month: m, units: 0, royalty: 0 });
    b.units += r.units || 0; b.royalty += royaltyUsd(r);
    const mk = r.marketplace || r.store || 'Other';
    byMarket[mk] = (byMarket[mk] || 0) + royaltyUsd(r);
  }
  const months = Object.values(by).sort((a, b) => a.month.localeCompare(b.month)).map((x) => ({ ...x, royalty: Math.round(x.royalty * 100) / 100 }));
  const markets = Object.entries(byMarket).map(([market, royalty]) => ({ market, royalty: Math.round(royalty * 100) / 100 })).sort((a, b) => b.royalty - a.royalty);
  return { months, markets };
}

function reviewTrend(bookId) {
  const rows = db.query("SELECT rating, date FROM reviews WHERE book_id = ? AND type = 'customer'", [bookId]);
  const now = Date.now();
  const recent = [], older = [];
  for (const r of rows) {
    const t = Date.parse(r.date || '');
    (Number.isNaN(t) ? older : ((now - t) / 86400000 <= 30 ? recent : older)).push(r.rating);
  }
  const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  return { count: rows.length, avg: avg(rows.map((r) => r.rating)), recentCount: recent.length, recentAvg: avg(recent) };
}

function rankTrend(bookId) {
  const rows = db.query('SELECT category, rank, recorded_at FROM rank_history WHERE book_id = ? ORDER BY recorded_at, id', [bookId]);
  if (!rows.length) return { latest: null, best: null, trend: null, byCategory: {} };
  const latest = rows[rows.length - 1];
  const best = Math.min(...rows.map((r) => r.rank));
  const byCategory = {};
  for (const r of rows) {
    const c = (byCategory[r.category] = byCategory[r.category] || { points: [], best: null, latest: null, direction: 'flat' });
    c.points.push({ date: r.recorded_at, rank: r.rank });
  }
  for (const c of Object.values(byCategory)) {
    c.best = Math.min(...c.points.map((p) => p.rank));
    c.latest = c.points[c.points.length - 1];
    const f = c.points[0].rank, l = c.latest.rank;
    c.direction = l < f ? 'improving' : l > f ? 'falling' : 'flat';
  }
  return { latest, best, trend: rows[0].rank - latest.rank, byCategory };
}

// ---- bestseller milestones: one of each kind per category ----
function checkMilestones(bookId, category, rank, date) {
  const made = [];
  if (!category || !(rank >= 1)) return made;
  const best = db.get('SELECT MIN(rank) AS r FROM rank_history WHERE book_id = ? AND category = ?', [bookId, category])?.r ?? rank;
  const existing = new Set(db.query('SELECT kind FROM milestones WHERE book_id = ? AND category = ?', [bookId, category]).map((m) => m.kind));
  const add = (kind) => {
    if (existing.has(kind)) return;
    db.exec('INSERT INTO milestones (book_id, kind, category, rank, date) VALUES (?, ?, ?, ?, ?)', [bookId, kind, category, best, date || today()]);
    made.push({ kind, rank: best, category });
  };
  if (best === 1) add('#1');
  if (best <= 10) add('Top 10');
  if (best <= 100) add('Top 100');
  return made;
}

// ---- backlist refresh analysis ----
function analyseRefresh(bookId) {
  const sales = salesTrend(bookId, 30);
  const rev = reviewTrend(bookId);
  const rank = rankTrend(bookId);
  const book = db.get('SELECT * FROM books WHERE id = ?', [bookId]);
  const clicks = db.get("SELECT COUNT(*) AS n FROM link_clicks WHERE book_id = ? AND created_at >= datetime('now', '-30 days')", [bookId]).n;
  const locales = db.get("SELECT COUNT(*) AS n FROM localized_metadata WHERE book_id = ? AND status = 'approved'", [bookId]).n;
  const recs = [];
  const nums = {
    salesUnits30d: sales.recent.units, salesUnitsPrior30d: sales.prior.units, salesPct: sales.pct,
    royalty30dUsd: Math.round(sales.recent.royalty * 100) / 100,
    reviewCount: rev.count, reviewAvg: rev.avg ? Math.round(rev.avg * 10) / 10 : null, recentReviews30d: rev.recentCount,
    bestRank: rank.best, latestRank: rank.latest ? rank.latest.rank : null, rankTrend: rank.trend,
    linkClicks30d: clicks, approvedLocales: locales, launchDate: book?.launch_date || '',
  };
  if (sales.recent.units === 0 && sales.prior.units === 0) {
    recs.push({ kind: 'leave_as_is', reason: 'No sales data yet — nothing to judge. Import a KDP report first (Analytics → Import report).', numbers: nums });
    return { numbers: nums, recommendations: recs };
  }
  if (sales.pct <= -30) {
    recs.push({ kind: 'promotion', reason: `Sales fell ${Math.abs(sales.pct)}% in the last 30 days (${sales.recent.units} units vs ${sales.prior.units} before). A price promotion or deal newsletter can restart the flow.`, numbers: nums });
    recs.push({ kind: 'rewrite_description', reason: 'Sales are sliding while the book is live — the description is the first thing a browser reads. A rewrite is the cheapest fix to try.', numbers: nums });
  }
  if (clicks >= 50 && sales.recent.units < clicks * 0.02) {
    recs.push({ kind: 'rewrite_description', reason: `${clicks} smart-link clicks in 30 days but only ${sales.recent.units} sales — people arrive and leave. The store page (description, cover, price, A+ content) is not converting.`, numbers: nums });
  }
  if (rev.avg !== null && rev.avg < 4.0 && rev.count >= 5) {
    recs.push({ kind: 'rewrite_description', reason: `Average rating is ${rev.avg.toFixed(1)} from ${rev.count} reviews. The description may promise something the book does not deliver — align it with what readers praise.`, numbers: nums });
  }
  if (rev.count < 10) {
    recs.push({ kind: 'promotion', reason: `Only ${rev.count} reviews so far. More reviews lift conversion; run an ARC round or a promotion to gather them.`, numbers: nums });
  }
  if (rank.latest && rank.latest.rank > 100 && rank.best && rank.best <= 100) {
    recs.push({ kind: 'refresh_keywords', reason: `Best rank was #${rank.best} but the latest is #${rank.latest.rank} — out of the top 100. Fresh keywords and categories can pull it back into view.`, numbers: nums });
    recs.push({ kind: 'change_categories', reason: `The book peaked at #${rank.best} in "${rank.latest.category}" and has slipped. A less crowded category may fit better now.`, numbers: nums });
  }
  if (sales.recent.units > 0 && sales.pct >= 0 && sales.pct < 20) {
    recs.push({ kind: 'price_test', reason: `Sales are flat but steady (${sales.recent.units} units in 30 days). A small price test can show whether a higher price earns more royalty without losing volume.`, numbers: nums });
  }
  if (sales.recent.units > 0 && sales.pct >= 20) {
    recs.push({ kind: 'new_edition', reason: `Sales are growing (+${sales.pct}% in 30 days). Demand is there — a paperback, audiobook or translated edition can catch readers the ebook misses.`, numbers: nums });
    if (locales === 0) recs.push({ kind: 'localize', reason: 'Growing sales and no localized store pages yet. Localized descriptions and keywords for Germany, France, Spain and Italy reach readers who search in their own language.', numbers: nums });
  }
  if (!recs.length) {
    recs.push({ kind: 'leave_as_is', reason: `Sales are steady (${sales.recent.units} units in 30 days, ${sales.pct >= 0 ? '+' : ''}${sales.pct}%), reviews average ${rev.avg ? rev.avg.toFixed(1) : '—'} from ${rev.count}. Nothing is broken — check again next quarter.`, numbers: nums });
  }
  return { numbers: nums, recommendations: recs };
}

function scheduleRefreshCycles(bookId, launchDate) {
  const kinds = [[30, '30-day'], [60, '60-day'], [90, '90-day'], [180, 'quarterly'], [270, 'quarterly'], [360, 'quarterly'], [450, 'quarterly'], [540, 'quarterly'], [630, 'quarterly'], [720, 'quarterly']];
  const made = [];
  for (const [days, kind] of kinds) {
    const due = addDays(launchDate, days);
    if (db.get('SELECT id FROM refresh_cycles WHERE book_id = ? AND due_date = ?', [bookId, due])) continue;
    const id = db.exec('INSERT INTO refresh_cycles (book_id, due_date, kind, status) VALUES (?, ?, ?, ?)', [bookId, due, kind, due <= today() ? 'due' : 'scheduled']);
    made.push({ id, due, kind });
  }
  return made;
}

// Flip scheduled check-ins to "due" once their date arrives.
function markDueCycles() {
  const rows = db.query("SELECT id FROM refresh_cycles WHERE status = 'scheduled' AND due_date <= ?", [today()]);
  for (const r of rows) db.exec("UPDATE refresh_cycles SET status = 'due' WHERE id = ?", [r.id]);
  return rows.length;
}

// ---- competitor watch ----
function competitorAlerts(old, updated) {
  const alerts = [];
  if (updated.price != null && old.price != null && updated.price < old.price) alerts.push(`Price drop: "${old.title}" went $${old.price} → $${updated.price}.`);
  if (updated.rank != null && old.rank != null && updated.rank < old.rank) alerts.push(`Overtaken: "${old.title}" moved to #${updated.rank} (was #${old.rank}).`);
  if (updated.reviewCount != null && updated.reviewCount > (old.review_count || 0)) alerts.push(`"${old.title}" gained reviews: ${old.review_count || 0} → ${updated.reviewCount}.`);
  return alerts;
}

// ---- CSV parsing ----
function parseCsv(text) {
  const src = String(text || '').replace(/^﻿/, '');
  const rows = [];
  let row = [], cur = '', inQ = false;
  const delim = (src.split('\n')[0].match(/\t/g) || []).length > (src.split('\n')[0].match(/,/g) || []).length ? '\t' : ',';
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQ) {
      if (ch === '"' && src[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') inQ = false;
      else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === delim) { row.push(cur.trim()); cur = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(cur.trim()); cur = '';
      if (row.some((c) => c !== '')) rows.push(row);
      row = [];
    } else cur += ch;
  }
  row.push(cur.trim());
  if (row.some((c) => c !== '')) rows.push(row);
  if (!rows.length) return [];
  const headers = rows[0].map((h) => normHeader(h));
  return rows.slice(1).map((vals) => {
    const o = {};
    headers.forEach((h, i) => { o[h] = vals[i] ?? ''; });
    return o;
  });
}
function normHeader(h) { return String(h || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }

// ---- text helpers ----
function fillPrompt(text, vars) {
  return String(text || '').replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined && vars[k] !== null ? String(vars[k]) : m));
}

// Split a numbered list ("1. … 2. …") into separate posts.
function splitPosts(text) {
  const t = String(text || '').replace(/^\[LOCAL DRAFT[^\]]*\]\s*/, '');
  const parts = t.split(/\n\s*(?=\d{1,2}[.)]\s)/).map((p) => p.replace(/^\s*\d{1,2}[.)]\s*/, '').trim()).filter(Boolean);
  return parts.length > 1 ? parts : [t.trim()].filter(Boolean);
}

function slugify(s) {
  return String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'book';
}

// ---- typographic social image (SVG) ----
function socialImageSvg({ title, author, imprint, size = '1200x628', bg = '#1d4d2b', accent = '#d4a017' }) {
  const [w, h] = size.split('x').map(Number);
  const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const fs = Math.round(Math.min(w, h * 1.9) / 14);
  const words = String(title || '').split(/\s+/);
  const lines = [];
  let line = '';
  const maxChars = Math.max(10, Math.floor(w / (fs * 0.55)));
  for (const wd of words) { if ((line + ' ' + wd).trim().length > maxChars) { lines.push(line.trim()); line = wd; } else line += ' ' + wd; }
  if (line.trim()) lines.push(line.trim());
  const startY = h * 0.42 - ((lines.length - 1) * fs * 1.15) / 2;
  const titleTspans = lines.map((l, i) => `<tspan x="${w / 2}" y="${Math.round(startY + i * fs * 1.15)}">${esc(l)}</tspan>`).join('');
  const afterY = Math.round(startY + (lines.length - 1) * fs * 1.15 + fs + 14);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <rect width="${w}" height="${h}" fill="${bg}"/>
  <rect x="0" y="0" width="${w}" height="10" fill="${accent}"/>
  <text font-family="Georgia, serif" font-size="${fs}" font-weight="bold" fill="#ffffff" text-anchor="middle">${titleTspans}</text>
  <text x="${w / 2}" y="${afterY}" font-family="Georgia, serif" font-size="${Math.round(fs * 0.5)}" fill="${accent}" text-anchor="middle">${esc(author)}</text>
  <text x="${w / 2}" y="${h - 40}" font-family="Arial, sans-serif" font-size="${Math.round(fs * 0.32)}" fill="#ffffff" opacity="0.8" text-anchor="middle">${esc(imprint)}</text>
</svg>`;
}

module.exports = {
  STAGES, STORES, FORMATS, LIBRARY_PLATFORMS,
  weekStartSunday, kdpSlotStatus, recordKdpUse, kdpPlanner,
  addDays, today, stageGateCheck, generateLaunchTasks,
  royaltyUsd, bookSales, bookPromoSpend, bookMargin, breakEvenAcos, ensureArcDisclosure, ARC_DISCLOSURE, imprintMargin, salesTrend, monthlySales,
  reviewTrend, rankTrend, checkMilestones, analyseRefresh, scheduleRefreshCycles, markDueCycles,
  competitorAlerts, parseCsv, normHeader, fillPrompt, splitPosts, slugify, socialImageSvg,
};
