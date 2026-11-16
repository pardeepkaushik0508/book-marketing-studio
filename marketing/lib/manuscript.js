// Manuscript handling: open the book handoff package (zip with
// metadata.json, manuscript.txt, cover-ebook.svg, cover-print-wrap.svg),
// store the files, and split the manuscript into chapters so audio and
// translation can run chapter by chapter.
const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');
const db = require('./db');

const DATA_DIR = () => path.join(path.dirname(path.resolve(process.env.DB_PATH || './data/marketing-studio.db')));

function bookDir(bookId) {
  const dir = path.join(DATA_DIR(), 'books', String(bookId));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function safeName(name) { return String(name || 'file').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120); }

function saveFile(bookId, type, name, buffer, note = '') {
  const p = path.join(bookDir(bookId), safeName(name));
  fs.writeFileSync(p, buffer);
  const prev = db.get('SELECT MAX(version) AS v FROM files WHERE book_id = ? AND type = ?', [bookId, type]);
  const id = db.exec('INSERT INTO files (book_id, type, version, path, licence_note) VALUES (?, ?, ?, ?, ?)', [bookId, type, (prev?.v || 0) + 1, p, note]);
  return { id, path: p };
}

// Split plain text into chapters on lines like "Chapter 3", "CHAPTER THREE",
// "Chapter 3: Title", "# Title" or "Part 1". Falls back to ~4,000-word
// sections when no headings are found.
function splitChapters(text) {
  const src = String(text || '').replace(/\r\n/g, '\n');
  const lines = src.split('\n');
  const heading = /^\s*(#{1,2}\s+\S.*|(chapter|chapitre|kapitel|cap[ií]tulo|part)\s+([0-9]+|[ivxlc]+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)\b.*)\s*$/i;
  const chapters = [];
  let cur = null;
  const preface = [];
  for (const line of lines) {
    if (heading.test(line) && line.trim().length < 120) {
      if (cur) chapters.push(cur);
      cur = { title: line.replace(/^#+\s*/, '').trim(), body: [] };
    } else if (cur) cur.body.push(line);
    else preface.push(line);
  }
  if (cur) chapters.push(cur);
  if (chapters.length >= 2) {
    const pre = preface.join('\n').trim();
    const out = chapters.map((c) => ({ title: c.title, text: c.body.join('\n').trim() })).filter((c) => c.text);
    if (pre.split(/\s+/).length > 150) out.unshift({ title: 'Front matter', text: pre });
    return out;
  }
  // No headings: fixed-size sections at paragraph breaks.
  const paras = src.split(/\n\s*\n/);
  const out = [];
  let buf = [], words = 0;
  for (const p of paras) {
    const n = p.split(/\s+/).filter(Boolean).length;
    if (words + n > 4000 && buf.length) { out.push({ title: `Section ${out.length + 1}`, text: buf.join('\n\n').trim() }); buf = []; words = 0; }
    buf.push(p); words += n;
  }
  if (buf.join('').trim()) out.push({ title: `Section ${out.length + 1}`, text: buf.join('\n\n').trim() });
  return out;
}

function storeChapters(bookId, text) {
  const chapters = splitChapters(text);
  db.transaction(() => {
    db.exec('DELETE FROM chapters WHERE book_id = ?', [bookId]);
    chapters.forEach((c, i) => {
      db.exec('INSERT INTO chapters (book_id, no, title, text, words) VALUES (?, ?, ?, ?, ?)', [bookId, i + 1, c.title, c.text, c.text.split(/\s+/).filter(Boolean).length]);
    });
  });
  const words = chapters.reduce((a, c) => a + c.text.split(/\s+/).filter(Boolean).length, 0);
  db.exec('UPDATE books SET words = CASE WHEN words > 0 THEN words ELSE ? END WHERE id = ?', [words, bookId]);
  return chapters.length;
}

// Open a handoff zip. Returns what was found; never throws on a bad zip.
async function unpackHandoff(bookId, buffer) {
  const found = { manuscript: false, cover: false, coverPrint: false, metadata: null, chapters: 0, error: '' };
  let zip;
  try { zip = await JSZip.loadAsync(buffer); } catch (e) { found.error = 'Package is not a readable zip — saved as-is.'; return found; }
  const entry = (name) => zip.file(name) || zip.file(new RegExp(`(^|/)${name.replace('.', '\\.')}$`, 'i'))[0] || null;
  const meta = entry('metadata.json');
  if (meta) { try { found.metadata = JSON.parse(await meta.async('string')); } catch { /* ignore */ } }
  const ms = entry('manuscript.txt') || entry('manuscript.md');
  if (ms) {
    const text = await ms.async('string');
    saveFile(bookId, 'manuscript', 'manuscript.txt', Buffer.from(text, 'utf8'), 'From handoff');
    found.chapters = storeChapters(bookId, text);
    found.manuscript = true;
  }
  const cover = entry('cover-ebook.svg') || entry('cover-ebook.png') || entry('cover-ebook.jpg');
  if (cover) {
    const name = cover.name.split('/').pop();
    const saved = saveFile(bookId, 'cover', name, await cover.async('nodebuffer'), 'From handoff');
    db.exec('UPDATE books SET cover_path = ? WHERE id = ?', [saved.path, bookId]);
    found.cover = true;
  }
  const wrap = entry('cover-print-wrap.svg') || entry('cover-print-wrap.pdf');
  if (wrap) { saveFile(bookId, 'cover-print', wrap.name.split('/').pop(), await wrap.async('nodebuffer'), 'From handoff'); found.coverPrint = true; }
  return found;
}

function manuscriptText(bookId) {
  const rows = db.query('SELECT title, text FROM chapters WHERE book_id = ? ORDER BY no', [bookId]);
  return rows.map((r) => `${r.title}\n\n${r.text}`).join('\n\n');
}

module.exports = { bookDir, saveFile, splitChapters, storeChapters, unpackHandoff, manuscriptText, safeName, DATA_DIR };
