// "Is it live?" checks through free, public lookups — no scraping.
//   Apple Books  → Apple's iTunes Search/Lookup API (ebooks and audiobooks)
//   Google Play  → Google Books API (saleInfo shows whether it is for sale)
// Every other store has no public lookup, so its status stays manual.

function norm(s) { return String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, ''); }
function titleMatch(a, b) { const x = norm(a).split(':')[0], y = norm(b).split(':')[0]; return !!x && !!y && (x === y || x.startsWith(y) || y.startsWith(x)); }
function authorMatch(a, b) {
  if (!a || !b) return true;
  const x = norm(a);
  const parts = String(b).toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 3);
  return parts.length ? parts.some((t) => x.includes(t)) : x.includes(norm(b));
}

async function getJson(url) {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`lookup error ${res.status}`);
  return res.json();
}

// book: { title, author }, edition: { format, isbn }, country: two letters
async function checkApple({ book, edition, country = 'us' }) {
  const audio = edition.format === 'audiobook';
  const isbn = String(edition.isbn || '').replace(/[^0-9X]/gi, '');
  let results = [];
  if (isbn && !audio) {
    const d = await getJson(`https://itunes.apple.com/lookup?isbn=${isbn}&country=${country}`);
    results = d.results || [];
  }
  if (!results.length) {
    const term = encodeURIComponent(`${book.title} ${book.author || ''}`.trim());
    const d = await getJson(`https://itunes.apple.com/search?term=${term}&media=${audio ? 'audiobook' : 'ebook'}&entity=${audio ? 'audiobook' : 'ebook'}&country=${country}&limit=25`);
    results = (d.results || []).filter((r) => titleMatch(r.trackName || r.collectionName, book.title) && authorMatch(r.artistName, book.author));
  }
  const hit = results[0];
  if (!hit) return { live: false, found: false, url: '', detail: `Not found in the Apple Books ${country.toUpperCase()} store yet.` };
  return { live: true, found: true, url: hit.trackViewUrl || hit.collectionViewUrl || '', id: String(hit.trackId || hit.collectionId || ''), detail: `Found on Apple Books (${country.toUpperCase()}): "${hit.trackName || hit.collectionName}" by ${hit.artistName}.` };
}

async function checkGoogle({ book, edition, apiKey = '' }) {
  if (edition.format === 'audiobook') return { live: false, found: false, url: '', detail: 'Google Play audiobooks have no public lookup — check by hand.', manual: true };
  const isbn = String(edition.isbn || '').replace(/[^0-9X]/gi, '');
  const q = isbn ? `isbn:${isbn}` : `intitle:"${book.title}"${book.author ? `+inauthor:"${book.author}"` : ''}`;
  const d = await getJson(`https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(q)}&maxResults=20${apiKey ? `&key=${encodeURIComponent(apiKey)}` : ''}`);
  const items = (d.items || []).filter((it) => isbn || (titleMatch(it.volumeInfo?.title, book.title) && authorMatch((it.volumeInfo?.authors || []).join(' '), book.author)));
  if (!items.length) return { live: false, found: false, url: '', detail: 'Not found in Google Books / Play yet.' };
  const forSale = items.find((it) => ['FOR_SALE', 'FREE', 'FOR_PREORDER'].includes(it.saleInfo?.saleability));
  if (forSale) {
    const pre = forSale.saleInfo.saleability === 'FOR_PREORDER';
    return { live: true, preorder: pre, found: true, url: forSale.saleInfo.buyLink || forSale.volumeInfo?.infoLink || '', id: forSale.id, detail: `Google Play Books: ${pre ? 'on pre-order' : 'for sale'} ("${forSale.volumeInfo?.title}").` };
  }
  return { live: false, found: true, url: items[0].volumeInfo?.infoLink || '', detail: 'In the Google Books catalog but not for sale on Play yet (still processing, or not offered for sale in this country).' };
}

async function check(kind, args) {
  if (kind === 'apple') return checkApple(args);
  if (kind === 'google') return checkGoogle(args);
  return { live: false, found: false, manual: true, detail: 'This store has no public lookup — update the status by hand.' };
}

module.exports = { check, checkApple, checkGoogle, titleMatch, authorMatch };
