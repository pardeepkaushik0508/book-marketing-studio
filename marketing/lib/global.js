// Worldwide reach: Amazon marketplaces, KDP royalty bands, exchange
// rates, local price ladders, royalty estimates, and smart-link routing.
//
// KDP 70% eBook bands below were checked on KDP's "eBook List Price
// Requirements" help page (G200634560) on 2026-11-16: since 7 July 2026
// the Amazon.com band is $2.99–$12.99, with equivalent changes elsewhere.
// Delivery costs per MB, VAT rates and the "70% needs KDP Select"
// markets are ESTIMATES from KDP's pricing pages — the UI marks them
// "verify" and they are editable in code. Prices change: verify at upload.
const db = require('./db');

const MARKETPLACES = [
  { code: 'US', name: 'Amazon.com', tld: 'com', currency: 'USD', band70: [2.99, 12.99], deliveryPerMb: 0.15, vat: 0, language: 'English', countries: ['US'] },
  { code: 'CA', name: 'Amazon.ca', tld: 'ca', currency: 'CAD', band70: [2.99, 12.99], deliveryPerMb: 0.15, vat: 0, language: 'English', countries: ['CA'] },
  { code: 'UK', name: 'Amazon.co.uk', tld: 'co.uk', currency: 'GBP', band70: [1.77, 12.99], deliveryPerMb: 0.10, vat: 0, language: 'English', countries: ['GB', 'UK', 'IE'] },
  { code: 'DE', name: 'Amazon.de', tld: 'de', currency: 'EUR', band70: [2.69, 12.99], deliveryPerMb: 0.12, vat: 7, language: 'German', countries: ['DE', 'AT', 'CH', 'LI'] },
  { code: 'FR', name: 'Amazon.fr', tld: 'fr', currency: 'EUR', band70: [2.69, 12.99], deliveryPerMb: 0.12, vat: 5.5, language: 'French', countries: ['FR', 'BE', 'LU', 'MC'] },
  { code: 'ES', name: 'Amazon.es', tld: 'es', currency: 'EUR', band70: [2.69, 12.99], deliveryPerMb: 0.12, vat: 4, language: 'Spanish', countries: ['ES', 'PT'] },
  { code: 'IT', name: 'Amazon.it', tld: 'it', currency: 'EUR', band70: [2.69, 12.99], deliveryPerMb: 0.12, vat: 4, language: 'Italian', countries: ['IT', 'SM', 'VA'] },
  { code: 'NL', name: 'Amazon.nl', tld: 'nl', currency: 'EUR', band70: [2.69, 12.99], deliveryPerMb: 0.12, vat: 9, language: 'Dutch', countries: ['NL'] },
  { code: 'JP', name: 'Amazon.co.jp', tld: 'co.jp', currency: 'JPY', band70: [250, 1650], deliveryPerMb: 1, vat: 10, language: 'Japanese', countries: ['JP'], selectFor70: true },
  { code: 'BR', name: 'Amazon.com.br', tld: 'com.br', currency: 'BRL', band70: [5.99, 31.99], deliveryPerMb: 0.30, vat: 0, language: 'Portuguese (Brazil)', countries: ['BR'], selectFor70: true },
  { code: 'MX', name: 'Amazon.com.mx', tld: 'com.mx', currency: 'MXN', band70: [34.99, 199.99], deliveryPerMb: 1, vat: 16, language: 'Spanish', countries: ['MX'], selectFor70: true },
  { code: 'AU', name: 'Amazon.com.au', tld: 'com.au', currency: 'AUD', band70: [3.99, 15.99], deliveryPerMb: 0.15, vat: 10, language: 'English', countries: ['AU', 'NZ'] },
  { code: 'IN', name: 'Amazon.in', tld: 'in', currency: 'INR', band70: [99, 599], deliveryPerMb: 7, vat: 18, language: 'English', countries: ['IN'], selectFor70: true },
];

// Print royalty on Amazon: 60% of list at or above the threshold, 50%
// below it, minus printing cost (KDP pricing pages, 2026). US threshold
// verified; other markets use the FX-equivalent — verify.
const PRINT_THRESHOLD_USD = 9.99;

// Languages offered for localized metadata and translated editions.
const LANGUAGES = [
  'German', 'French', 'Spanish', 'Italian', 'Portuguese (Brazil)', 'Dutch', 'Japanese', 'Polish', 'Swedish',
  'Hindi', 'Chinese (Simplified)', 'Korean', 'Arabic', 'Indonesian', 'Turkish', 'Ukrainian',
];

function marketplace(code) { return MARKETPLACES.find((m) => m.code === code) || null; }

function marketplaceForCountry(country) {
  const c = String(country || '').toUpperCase();
  return MARKETPLACES.find((m) => m.countries.includes(c)) || MARKETPLACES[0];
}

// ---- exchange rates ----
function fxRates() {
  const rows = db.query('SELECT * FROM fx_rates ORDER BY currency');
  const out = {};
  for (const r of rows) out[r.currency] = r.per_usd;
  return out;
}

function fxTable() { return db.query('SELECT * FROM fx_rates ORDER BY currency'); }

function toUsd(amount, currency) {
  if (!currency || currency === 'USD') return amount;
  const r = db.get('SELECT per_usd FROM fx_rates WHERE currency = ?', [String(currency).toUpperCase()]);
  if (!r || !r.per_usd) return null;
  return amount / r.per_usd;
}

function fromUsd(amountUsd, currency) {
  if (currency === 'USD') return amountUsd;
  const r = db.get('SELECT per_usd FROM fx_rates WHERE currency = ?', [currency]);
  return r ? amountUsd * r.per_usd : null;
}

function setFxRate(currency, perUsd, source = 'manual') {
  db.exec("INSERT INTO fx_rates (currency, per_usd, source, updated_at) VALUES (?, ?, ?, datetime('now')) ON CONFLICT(currency) DO UPDATE SET per_usd = excluded.per_usd, source = excluded.source, updated_at = excluded.updated_at", [currency.toUpperCase(), perUsd, source]);
}

// Refresh rates from the European Central Bank reference rates via
// Frankfurter (free, no key). Keeps stored rates if the call fails.
async function refreshFx() {
  const urls = ['https://api.frankfurter.dev/v1/latest?base=USD', 'https://api.frankfurter.app/latest?from=USD'];
  let lastErr = null;
  for (const url of urls) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`FX source error ${res.status}`);
      const data = await res.json();
      let n = 0;
      for (const [cur, rate] of Object.entries(data.rates || {})) {
        if (typeof rate === 'number' && rate > 0) { setFxRate(cur, rate, `ECB via Frankfurter ${data.date || ''}`.trim()); n++; }
      }
      setFxRate('USD', 1, 'base');
      return { ok: true, updated: n, date: data.date || '' };
    } catch (e) { lastErr = e; }
  }
  return { ok: false, error: lastErr ? lastErr.message : 'FX refresh failed' };
}

// ---- price ladder ----
// Local "charm" price for a currency (x.99 for most, whole tens for JPY,
// ...9 for INR and MXN).
function charm(amount, currency) {
  if (!(amount > 0)) return amount;
  if (currency === 'JPY') return Math.max(10, Math.round(amount / 10) * 10);
  if (currency === 'INR' || currency === 'MXN') return Math.max(9, Math.round(amount / 10) * 10 - 1);
  const whole = Math.max(0, Math.round(amount) - 1);
  return Math.round((whole + 0.99) * 100) / 100;
}

function clampBand(price, band) {
  if (!band) return price;
  return Math.min(Math.max(price, band[0]), band[1]);
}

// Royalty estimate for one eBook sale in one marketplace.
function ebookRoyalty({ price, mp, fileSizeMb = 1, kdpSelect = false, plan = 70 }) {
  const exVat = price / (1 + (mp.vat || 0) / 100);
  const inBand = price >= mp.band70[0] && price <= mp.band70[1];
  const can70 = plan === 70 && inBand && (!mp.selectFor70 || kdpSelect);
  if (can70) {
    const delivery = (fileSizeMb || 1) * mp.deliveryPerMb;
    return { rate: 0.7, royalty: Math.max(0, 0.7 * (exVat - delivery)), inBand, note: '' };
  }
  let note = '';
  if (plan === 70 && !inBand) note = `Outside the 70% band (${mp.band70[0]}–${mp.band70[1]} ${mp.currency}) — earns 35%.`;
  else if (plan === 70 && mp.selectFor70 && !kdpSelect) note = '70% here needs KDP Select (verify) — earns 35% while wide.';
  return { rate: 0.35, royalty: 0.35 * exVat, inBand, note };
}

function printRoyalty({ price, mp, printCost = 0 }) {
  const threshold = fromUsd(PRINT_THRESHOLD_USD, mp.currency) || PRINT_THRESHOLD_USD;
  const rate = price >= threshold ? 0.6 : 0.5;
  const exVat = price / (1 + (mp.vat || 0) / 100);
  return { rate, royalty: Math.max(0, rate * exVat - (printCost || 0)), note: printCost ? '' : 'Add the printing cost (in this currency) for a real figure.' };
}

// Build a full price ladder for one edition from its USD base price.
// Returns one row per marketplace with the local price, royalty rate,
// estimated royalty (local + USD) and any warnings.
function priceLadder(edition, { kdpSelect = false, overrides = {} } = {}) {
  const base = Number(edition.price) || 0;
  const isEbook = edition.format === 'ebook';
  const isPrint = ['paperback', 'hardcover', 'large print', 'spiral workbook'].includes(edition.format);
  return MARKETPLACES.map((mp) => {
    const converted = fromUsd(base, mp.currency);
    let price = overrides[mp.code] != null ? Number(overrides[mp.code]) : charm(converted, mp.currency);
    const warnings = [];
    if (isEbook && overrides[mp.code] == null && base >= 2.99 && base <= 12.99) {
      const clamped = clampBand(price, mp.band70);
      if (clamped !== price) { price = clamped; warnings.push('Adjusted into the 70% band.'); }
    }
    let r = { rate: null, royalty: null, note: '' };
    if (isEbook) r = ebookRoyalty({ price, mp, fileSizeMb: edition.file_size_mb || 1, kdpSelect });
    else if (isPrint) r = printRoyalty({ price, mp, printCost: fromUsd(edition.print_cost || 0, mp.currency) });
    if (r.note) warnings.push(r.note);
    const royaltyUsd = r.royalty != null ? toUsd(r.royalty, mp.currency) : null;
    return {
      marketplace: mp.code, name: mp.name, currency: mp.currency, price: Math.round(price * 100) / 100,
      rate: r.rate, royalty: r.royalty != null ? Math.round(r.royalty * 100) / 100 : null,
      royaltyUsd: royaltyUsd != null ? Math.round(royaltyUsd * 100) / 100 : null,
      warnings,
    };
  });
}

// Amazon product URL for an ASIN in one marketplace.
function amazonUrl(asin, mp) { return `https://www.amazon.${mp.tld}/dp/${encodeURIComponent(asin)}`; }

// Pick the visitor's country: CDN header if present, else the region
// part of Accept-Language (en-GB → GB), else US. ?c=XX overrides.
function visitorCountry(req) {
  const q = String(req.query?.c || '').toUpperCase();
  if (/^[A-Z]{2}$/.test(q)) return q;
  const h = req.headers || {};
  const cdn = h['cf-ipcountry'] || h['x-vercel-ip-country'] || h['x-country-code'] || '';
  if (/^[A-Z]{2}$/i.test(cdn) && cdn.toUpperCase() !== 'XX') return cdn.toUpperCase();
  const al = String(h['accept-language'] || '');
  const m = al.match(/[a-z]{2,3}-([A-Z]{2})/i);
  if (m) return m[1].toUpperCase();
  const lang = al.slice(0, 2).toLowerCase();
  return { de: 'DE', fr: 'FR', es: 'ES', it: 'IT', nl: 'NL', ja: 'JP', pt: 'BR', hi: 'IN' }[lang] || 'US';
}

module.exports = {
  MARKETPLACES, LANGUAGES, PRINT_THRESHOLD_USD, marketplace, marketplaceForCountry,
  fxRates, fxTable, toUsd, fromUsd, setFxRate, refreshFx,
  charm, clampBand, ebookRoyalty, printRoyalty, priceLadder, amazonUrl, visitorCountry,
};
