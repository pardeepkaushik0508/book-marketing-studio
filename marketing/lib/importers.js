// Report importers: KDP, IngramSpark, Draft2Digital, Apple/Kobo/Google
// exports and Amazon Ads campaign reports, as CSV, TSV or XLSX. Columns
// are recognised by name (many aliases), rows are matched to books by
// ASIN, ISBN or title, money is kept in its own currency and converted to
// USD for margins. Re-importing the same report replaces, never doubles.
const ExcelJS = require('exceljs');
const db = require('./db');
const mk = require('./marketing');
const global = require('./global');

const ALIASES = {
  period: ['royaltydate', 'date', 'period', 'month', 'saledate', 'salesdate', 'orderdate', 'transactiondate', 'reportdate', 'startdate', 'salemonth', 'reportingperiod'],
  title: ['title', 'booktitle', 'producttitle', 'name'],
  asin: ['asinisbn', 'asin', 'isbn', 'isbn13', 'eisbn', 'productid', 'identifier', 'ean', 'advertisedasin'],
  marketplace: ['marketplace', 'market', 'country', 'salesmarket', 'territory', 'countryofsale', 'salecountry', 'storecountry'],
  store: ['store', 'retailer', 'vendor', 'channel', 'saleschannel', 'distributor'],
  units: ['netunitssold', 'unitssold', 'netunits', 'units', 'quantity', 'qty', 'netquantity', 'netqty', 'copiessold', 'quantitysold'],
  kenp: ['kenpread', 'kenp', 'kenpcpagesread', 'pagesread', 'kindleeditionnormalizedpagesread'],
  royalty: ['royalty', 'royalties', 'earnings', 'yourearnings', 'netearnings', 'compensation', 'publishercompensation', 'netcompensation', 'proceeds', 'netrevenue', 'revenue', 'amountearned', 'authorearnings', 'amount'],
  currency: ['currency', 'royaltycurrency', 'paymentcurrency', 'currencycode', 'salescurrency'],
  format: ['format', 'producttype', 'binding', 'booktype', 'edition'],
  // ads
  campaign: ['campaignname', 'campaign'],
  spend: ['spend', 'cost', 'totalcost', 'amountspent'],
  adSales: ['14daytotalsales', '7daytotalsales', 'sales', 'totalsales', 'attributedsales', 'salesusd'],
  orders: ['14daytotalorders', '7daytotalorders', 'orders', 'totalorders', 'purchases', 'unitsordered'],
  impressions: ['impressions'],
  clicks: ['clicks'],
};

function pick(row, key) {
  for (const a of ALIASES[key]) if (row[a] !== undefined && row[a] !== '') return row[a];
  return '';
}

function num(v) {
  if (typeof v === 'number') return v;
  const s = String(v || '').trim();
  if (!s) return 0;
  // 1.234,56 (European) vs 1,234.56
  const eu = /^-?[\d.]+,\d{1,2}$/.test(s.replace(/[^\d.,-]/g, ''));
  const clean = eu ? s.replace(/[^\d,-]/g, '').replace(',', '.') : s.replace(/[^\d.-]/g, '');
  const n = parseFloat(clean);
  return Number.isFinite(n) ? n : 0;
}

const MARKET_ALIASES = {
  'amazon.com': 'US', us: 'US', usa: 'US', 'united states': 'US', 'amazon.ca': 'CA', ca: 'CA', canada: 'CA',
  'amazon.co.uk': 'UK', uk: 'UK', gb: 'UK', 'united kingdom': 'UK', 'amazon.de': 'DE', de: 'DE', germany: 'DE',
  'amazon.fr': 'FR', fr: 'FR', france: 'FR', 'amazon.es': 'ES', es: 'ES', spain: 'ES', 'amazon.it': 'IT', it: 'IT', italy: 'IT',
  'amazon.nl': 'NL', nl: 'NL', netherlands: 'NL', 'amazon.co.jp': 'JP', jp: 'JP', japan: 'JP', 'amazon.com.br': 'BR', br: 'BR', brazil: 'BR',
  'amazon.com.mx': 'MX', mx: 'MX', mexico: 'MX', 'amazon.com.au': 'AU', au: 'AU', australia: 'AU', 'amazon.in': 'IN', in: 'IN', india: 'IN',
};
function normMarket(v) {
  const s = String(v || '').trim().toLowerCase();
  if (!s) return '';
  return MARKET_ALIASES[s] || MARKET_ALIASES[s.replace(/^www\./, '')] || s.toUpperCase().slice(0, 12);
}

function normPeriod(v) {
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v.toISOString().slice(0, 10);
  const s = String(v || '').trim();
  if (/^\d{4}-\d{2}(-\d{2})?/.test(s)) return s.slice(0, s.length >= 10 && /^\d{4}-\d{2}-\d{2}/.test(s) ? 10 : 7);
  if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(s)) { const [m, d, y] = s.split('/'); return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`; }
  const t = Date.parse(s);
  if (!Number.isNaN(t)) {
    const d = new Date(t);
    // "Oct 2026" style → month
    return /^\D+\s+\d{4}$/.test(s) ? d.toISOString().slice(0, 7) : d.toISOString().slice(0, 10);
  }
  return s.slice(0, 20);
}

function formatFrom(v, sheetName) {
  const s = `${v || ''} ${sheetName || ''}`.toLowerCase();
  if (/kenp|pages read/.test(s)) return 'ebook';
  if (/hardcover|hardback/.test(s)) return 'hardcover';
  if (/paperback|print|pod|softcover/.test(s)) return 'paperback';
  if (/audio/.test(s)) return 'audiobook';
  if (/e-?book|kindle|digital|epub/.test(s)) return 'ebook';
  return '';
}

// ---- reading files ----
async function readTable({ csv, xlsxBase64 }) {
  if (xlsxBase64) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(xlsxBase64, 'base64'));
    const sheets = [];
    wb.eachSheet((ws) => {
      const rows = [];
      ws.eachRow({ includeEmpty: false }, (row) => {
        rows.push(row.values.slice(1).map((c) => (c && typeof c === 'object' && !(c instanceof Date) ? (c.result ?? c.text ?? c.richText?.map((r) => r.text).join('') ?? '') : c)));
      });
      // Header = first row that has 3+ cells and a recognised column.
      const known = new Set(Object.values(ALIASES).flat());
      const hi = rows.findIndex((r) => r.filter((c) => c !== null && c !== undefined && c !== '').length >= 3 && r.some((c) => known.has(mk.normHeader(c))));
      if (hi < 0) return;
      const headers = rows[hi].map((h) => mk.normHeader(h));
      const objs = rows.slice(hi + 1).map((vals) => {
        const o = {};
        headers.forEach((h, i) => { if (h) o[h] = vals[i] ?? ''; });
        return o;
      });
      sheets.push({ name: ws.name, rows: objs });
    });
    return sheets;
  }
  return [{ name: '', rows: mk.parseCsv(csv || '') }];
}

function detectKind(rows) {
  const keys = new Set(rows.slice(0, 5).flatMap((r) => Object.keys(r)));
  if (keys.has('impressions') && keys.has('clicks') && ALIASES.spend.some((a) => keys.has(a))) return 'ads';
  if (ALIASES.kenp.some((a) => keys.has(a)) && !ALIASES.royalty.some((a) => keys.has(a))) return 'kenp';
  return 'sales';
}

function detectStore(rows, fallback) {
  const keys = new Set(rows.slice(0, 5).flatMap((r) => Object.keys(r)));
  if (keys.has('royaltydate') || keys.has('asinisbn') || keys.has('kenpread')) return 'KDP';
  if (keys.has('publishercompensation') || keys.has('compensation')) return 'IngramSpark';
  return fallback || '';
}

// ---- matching rows to books ----
function bookIndex() {
  const byId = new Map();
  for (const l of db.query('SELECT l.asin, e.book_id, e.format FROM listings l JOIN editions e ON e.id = l.edition_id WHERE l.asin != \'\'')) byId.set(String(l.asin).toUpperCase().replace(/[^A-Z0-9]/g, ''), { bookId: l.book_id, format: l.format });
  for (const e of db.query("SELECT isbn, book_id, format FROM editions WHERE isbn != ''")) byId.set(String(e.isbn).replace(/[^0-9X]/gi, '').toUpperCase(), { bookId: e.book_id, format: e.format });
  const titles = db.query('SELECT id, title FROM books').map((b) => ({ id: b.id, key: titleKey(b.title) }));
  return { byId, titles };
}
function titleKey(t) { return String(t || '').toLowerCase().split(':')[0].replace(/[^a-z0-9]/g, ''); }

function matchBook(idx, row) {
  const ident = String(pick(row, 'asin') || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (ident && idx.byId.has(ident)) return idx.byId.get(ident);
  const tk = titleKey(pick(row, 'title'));
  if (tk.length >= 4) {
    const hit = idx.titles.find((t) => t.key === tk) || idx.titles.find((t) => t.key.length >= 6 && (tk.startsWith(t.key) || t.key.startsWith(tk)));
    if (hit) return { bookId: hit.id, format: '' };
  }
  return null;
}

// ---- import ----
// opts.bookId forces every row to one book (per-book import).
async function importReport({ csv, xlsxBase64, bookId, store: storeHint, kind: kindHint }) {
  const sheets = await readTable({ csv, xlsxBase64 });
  const idx = bookIndex();
  const summary = { sales: 0, ads: 0, kenp: 0, rows: 0, unmatched: [], skipped: 0, books: new Set(), kinds: new Set() };
  const salesAgg = new Map();
  for (const sheet of sheets) {
    if (!sheet.rows.length) continue;
    const kind = kindHint || (/kenp/i.test(sheet.name) ? 'kenp' : detectKind(sheet.rows));
    summary.kinds.add(kind);
    const store = storeHint || detectStore(sheet.rows, '') || 'KDP';
    for (const r of sheet.rows) {
      summary.rows++;
      const match = bookId ? { bookId: Number(bookId), format: '' } : matchBook(idx, r);
      if (!match) {
        const label = pick(r, 'title') || pick(r, 'asin') || pick(r, 'campaign');
        if (label && !summary.unmatched.includes(String(label)) && summary.unmatched.length < 50) summary.unmatched.push(String(label));
        summary.skipped++;
        continue;
      }
      if (kind === 'ads') {
        const spend = num(pick(r, 'spend'));
        const sales = num(pick(r, 'adSales'));
        if (!spend && !sales) { summary.skipped++; continue; }
        db.exec('INSERT INTO ads (book_id, platform, campaign_name, spend, sales, orders, impressions, clicks, currency, period) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [
          match.bookId, storeHint || r.platform || 'Amazon Ads', String(pick(r, 'campaign') || ''), spend, sales,
          Math.round(num(pick(r, 'orders'))), Math.round(num(pick(r, 'impressions'))), Math.round(num(pick(r, 'clicks'))),
          String(pick(r, 'currency') || 'USD').toUpperCase().slice(0, 3), normPeriod(pick(r, 'period')),
        ]);
        summary.ads++; summary.books.add(match.bookId);
        continue;
      }
      const period = normPeriod(pick(r, 'period'));
      const units = Math.round(num(pick(r, 'units')));
      const kenp = Math.round(num(pick(r, 'kenp')));
      const royalty = num(pick(r, 'royalty'));
      if (!period || (!units && !royalty && !kenp)) { summary.skipped++; continue; }
      const marketplace = normMarket(pick(r, 'marketplace'));
      const mp = global.marketplace(marketplace);
      const currency = String(pick(r, 'currency') || mp?.currency || 'USD').toUpperCase().slice(0, 3);
      const rowStore = String(pick(r, 'store') || store);
      const format = formatFrom(pick(r, 'format'), sheet.name) || match.format || (kind === 'kenp' ? 'ebook' : '');
      const key = [match.bookId, rowStore, marketplace, format, period, currency].join('|');
      const a = salesAgg.get(key) || { bookId: match.bookId, store: rowStore, marketplace, format, period, currency, units: 0, kenp: 0, royalty: 0 };
      a.units += units; a.kenp += kenp; a.royalty += royalty;
      salesAgg.set(key, a);
      summary.books.add(match.bookId);
      if (kind === 'kenp') summary.kenp++;
    }
  }
  for (const a of salesAgg.values()) {
    const usd = global.toUsd(a.royalty, a.currency);
    const existing = db.get('SELECT id, units, kenp, royalty FROM sales WHERE book_id = ? AND store = ? AND marketplace = ? AND format = ? AND period = ? AND currency = ?', [a.bookId, a.store, a.marketplace, a.format, a.period, a.currency]);
    if (existing) {
      // A KENP-only sheet adds pages to the same row; a sales sheet replaces.
      const units = a.units || (a.kenp ? existing.units : 0);
      const royalty = a.units || a.royalty ? a.royalty : existing.royalty;
      const kenp = a.kenp || existing.kenp;
      db.exec('UPDATE sales SET units = ?, kenp = ?, royalty = ?, royalty_usd = ?, source = ? WHERE id = ?', [units, kenp, royalty, global.toUsd(royalty, a.currency), 'import', existing.id]);
    } else {
      db.exec('INSERT INTO sales (book_id, store, marketplace, format, period, units, kenp, royalty, currency, royalty_usd, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [a.bookId, a.store, a.marketplace, a.format, a.period, a.units, a.kenp, a.royalty, a.currency, usd, 'import']);
    }
    summary.sales++;
  }
  return { ...summary, books: [...summary.books], kinds: [...summary.kinds] };
}

module.exports = { importReport, readTable, normMarket, normPeriod, num, ALIASES };
