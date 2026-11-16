// Book Marketing Studio — frontend (plain JS, no framework, no inline handlers).
const $ = (s, el) => (el || document).querySelector(s);
const $$ = (s, el) => Array.from((el || document).querySelectorAll(s));
let ME = null, CSRF = '', CURRENT_BOOK = null, CURRENT_TAB = 'overview', BOOK = null;

// ---------------- helpers ----------------
async function api(path, opts = {}) {
  const res = await fetch(path, { ...opts, headers: { 'content-type': 'application/json', 'x-csrf-token': CSRF, ...(opts.headers || {}) } });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !path.startsWith('/api/auth')) { showLogin(); throw new Error(data.error || 'Please sign in.'); }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}
const POST = (p, body) => api(p, { method: 'POST', body: JSON.stringify(body || {}) });
const PUT = (p, body) => api(p, { method: 'PUT', body: JSON.stringify(body || {}) });
const DEL = (p) => api(p, { method: 'DELETE' });
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
const money = (v, cur = 'USD') => { const n = Number(v || 0); try { return n.toLocaleString(undefined, { style: 'currency', currency: cur, maximumFractionDigits: cur === 'JPY' ? 0 : 2 }); } catch { return `${n.toFixed(2)} ${cur}`; } };
const num = (v) => Number(v || 0).toLocaleString();
const today = () => new Date().toISOString().slice(0, 10);
const localTime = (utc) => new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(String(utc)) ? String(utc) : String(utc).replace(' ', 'T') + 'Z').toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const parseJson = (s, d = []) => { try { return JSON.parse(s || ''); } catch { return d; } };

function toast(msg, err = false) {
  const t = document.createElement('div');
  t.className = 'toast' + (err ? ' err' : '');
  t.textContent = msg;
  $('#toasts').appendChild(t);
  setTimeout(() => t.remove(), err ? 7000 : 4000);
}
const fail = (ex) => toast(ex.message || String(ex), true);

function showModal(html, wide = false) {
  const card = $('#modal-card');
  card.className = 'modal-card' + (wide ? ' wide' : '');
  card.innerHTML = html;
  $('#modal').classList.remove('hidden');
  const first = card.querySelector('input, textarea, select');
  if (first) first.focus();
}
function closeModal() { $('#modal').classList.add('hidden'); $('#modal-card').innerHTML = ''; }
$('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal' || e.target.closest('[data-close]')) closeModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#modal').classList.contains('hidden')) closeModal(); });

// Form in a modal. fields: [{ name, label, type, value, options:[[v,l]], placeholder, required, help }]
// Resolves with the values (files as File objects) or null when cancelled.
function formModal(title, fields, { submit = 'Save', note = '', wide = false } = {}) {
  return new Promise((resolve) => {
    const f = (x) => {
      const id = `fm-${x.name}`;
      const req = x.required ? 'required' : '';
      const ph = x.placeholder ? `placeholder="${esc(x.placeholder)}"` : '';
      const help = x.help ? `<span class="muted small">${esc(x.help)}</span>` : '';
      if (x.type === 'textarea') return `<label>${esc(x.label)} ${help}<textarea id="${id}" ${req} ${ph} rows="${x.rows || 6}">${esc(x.value ?? '')}</textarea></label>`;
      if (x.type === 'select') return `<label>${esc(x.label)} ${help}<select id="${id}" ${req}>${(x.options || []).map(([v, l]) => `<option value="${esc(v)}" ${String(v) === String(x.value ?? '') ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>`;
      if (x.type === 'checkbox') return `<label class="inline"><input id="${id}" type="checkbox" ${x.value ? 'checked' : ''}> ${esc(x.label)}</label>${help}`;
      if (x.type === 'checkboxes') return `<div><div class="small">${esc(x.label)}</div>${(x.options || []).map(([v, l]) => `<label class="inline"><input type="checkbox" name="${id}" value="${esc(v)}" ${(x.value || []).includes(v) ? 'checked' : ''}> ${esc(l)}</label>`).join('')}</div>`;
      if (x.type === 'html') return x.html;
      return `<label>${esc(x.label)} ${help}<input id="${id}" type="${x.type || 'text'}" ${x.step ? `step="${x.step}"` : ''} ${x.accept ? `accept="${esc(x.accept)}"` : ''} ${req} ${ph} value="${x.type === 'file' ? '' : esc(x.value ?? '')}"></label>`;
    };
    showModal(`<h3>${esc(title)}</h3>${note ? `<p class="muted small">${note}</p>` : ''}<form id="fm">${fields.map(f).join('')}
      <div class="toolbar"><button class="btn primary" type="submit">${esc(submit)}</button><button class="btn" type="button" data-close>Cancel</button></div></form>`, wide);
    let done = false;
    $('#fm').addEventListener('submit', (e) => {
      e.preventDefault();
      const out = {};
      for (const x of fields) {
        if (x.type === 'html') continue;
        if (x.type === 'checkboxes') { out[x.name] = $$(`input[name="fm-${x.name}"]:checked`).map((i) => i.value); continue; }
        const el = $(`#fm-${x.name}`);
        out[x.name] = x.type === 'checkbox' ? el.checked : x.type === 'file' ? el.files[0] || null : x.type === 'number' ? (el.value === '' ? null : Number(el.value)) : el.value;
      }
      done = true; closeModal(); resolve(out);
    });
    const obs = new MutationObserver(() => { if ($('#modal').classList.contains('hidden')) { obs.disconnect(); if (!done) resolve(null); } });
    obs.observe($('#modal'), { attributes: true });
  });
}
async function confirmModal(text, yes = 'Yes') { const r = await formModal('Please confirm', [{ type: 'html', html: `<p>${esc(text)}</p>` }], { submit: yes }); return !!r; }

function readFile(file, as = 'text') {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(as === 'base64' ? String(r.result).split(',')[1] : r.result);
    r.onerror = rej;
    if (as === 'base64') r.readAsDataURL(file); else r.readAsText(file);
  });
}
async function fileBody(file) { return /\.xlsx$/i.test(file.name) ? { xlsxBase64: await readFile(file, 'base64') } : { csv: await readFile(file) }; }
function copyText(t) { navigator.clipboard.writeText(t).then(() => toast('Copied.'), () => toast('Copy failed — select and copy by hand.', true)); }
function busy(btn, on) { if (!btn) return; btn.disabled = on; if (on) { btn.dataset.label = btn.textContent; btn.textContent = 'Working…'; } else if (btn.dataset.label) btn.textContent = btn.dataset.label; }

// Delegate clicks on [data-act] inside a container to an action map.
function actions(container, map) {
  container.onclick = async (e) => {
    const b = e.target.closest('[data-act]');
    if (!b || !container.contains(b)) return;
    const fn = map[b.dataset.act];
    if (!fn) return;
    e.preventDefault();
    try { busy(b, true); await fn(b.dataset, b); } catch (ex) { fail(ex); } finally { if (document.body.contains(b)) busy(b, false); }
  };
}

const STAGE_NAMES = ['Final copy upload', 'Positioning', 'Formats & pricing', 'Compliance', 'Listings', 'Pre-launch', 'Launch', 'Promotion', 'Bookstores & libraries', 'Editions', 'Measure & improve'];
const STATUS_BADGE = { done: 'green', skipped: '', active: 'amber', todo: '', live: 'green', 'pre-order': 'blue', planned: '', posted: 'green', scheduled: 'blue', manual: 'amber', failed: 'red', approved: 'green', draft: '', proposed: 'amber', rejected: '', signed: 'green', sent: 'blue', 'follow-up due': 'amber', queued: 'blue', running: 'amber', not_started: '', uploaded: 'blue', in_review: 'amber', rejected: 'red', delisted: 'red', na: '', applied: 'blue', accepted: 'green', cancelled: '', due: 'amber', in_review: 'amber', confirmed: 'green', pending: 'amber', unsubscribed: 'red' };
const badge = (s) => `<span class="badge ${STATUS_BADGE[s] || ''}">${esc(String(s).replace(/_/g, ' '))}</span>`;
const CONTENT_LABELS = { description: 'Store description', social: 'Social posts', email: 'Launch email sequence', linkedin: 'LinkedIn article', presskit: 'Press kit', sellsheet: 'Sell sheet', talkingpoints: 'Podcast talking points', aplus: 'Amazon A+ content', author_bio: 'Author bios', quote_cards: 'Quote-card lines', trailer: 'Short-video scripts', back_matter: 'Back matter (also-by, signup)', bookbub_ad: 'BookBub/Meta ads', ads_keywords: 'Amazon Ads keywords', newsletter: 'Reader newsletter', rights_guide: 'Rights guide entry', media_pitch: 'Media pitch', podcast_pitch: 'Podcast pitch', library_pitch: 'Library pitch', bookstore_pitch: 'Bookstore pitch' , reader_profile: 'Reader profile', positioning: 'Positioning & title options', description_ab: 'Description A/B pair', kdp_keywords: 'KDP 7 keyword boxes', categories: 'KDP 3 categories', promo_sites: 'Promo-site submissions', reader_magnet: 'Reader magnet (free bonus)', repurpose_30: '30-day content plan', social_proof: 'Social proof from reviews', competitor_teardown: 'Competitor teardown', ads_analysis: 'Ad check (break-even)' };

// ---------------- navigation ----------------
function showView(name) {
  $$('.view').forEach((v) => v.classList.add('hidden'));
  $('#view-' + name).classList.remove('hidden');
  $$('.nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
  const loaders = { dashboard: loadDashboard, books: () => { CURRENT_BOOK = null; $('#book-detail').innerHTML = ''; $('#book-list-wrap').classList.remove('hidden'); loadBooks(); }, calendar: loadCalendar, readers: loadContacts, analytics: loadAnalytics, settings: () => loadSettings() };
  Promise.resolve().then(() => (loaders[name] || (() => {}))()).catch(fail);
  window.scrollTo(0, 0);
}
$$('.nav-btn').forEach((b) => b.addEventListener('click', () => showView(b.dataset.view)));

// ---------------- auth ----------------
function showLogin() {
  $('#app').classList.add('hidden');
  $('#login-screen').classList.remove('hidden');
  fetch('/api/auth/first-run').then((r) => r.json()).then((d) => {
    $('#register-form').classList.toggle('hidden', !d.firstRun);
    $('#first-run-note').classList.toggle('hidden', !d.firstRun);
    $('#login-form').classList.toggle('hidden', !!d.firstRun);
  }).catch(() => {});
}
function enterApp(account, csrfToken) {
  ME = account; CSRF = csrfToken;
  $('#login-screen').classList.add('hidden');
  $('#app').classList.remove('hidden');
  $('#user-name').textContent = account.name;
  $('#nav-settings').style.display = account.isAdmin ? '' : 'none';
  if (account.mustChangePassword) { toast('You signed in with a temporary password — please set your own now.'); changePassword(); }
  showView('dashboard');
  refreshBell();
}
async function checkMe() {
  try { const { account, csrfToken } = await api('/api/auth/me'); enterApp(account, csrfToken); } catch { showLogin(); }
}
$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('#login-error'); err.classList.add('hidden');
  try {
    const d = await POST('/api/auth/login', { email: $('#login-email').value, password: $('#login-password').value, totp: $('#login-totp').value || undefined });
    enterApp(d.account, d.csrfToken);
  } catch (ex) {
    if (/Two-step/.test(ex.message)) { $('#totp-wrap').classList.remove('hidden'); $('#login-totp').focus(); }
    err.textContent = ex.message; err.classList.remove('hidden');
  }
});
$('#register-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await POST('/api/auth/register', { name: $('#reg-name').value, email: $('#reg-email').value, password: $('#reg-password').value });
    toast('Admin account created — sign in.');
    $('#register-form').classList.add('hidden'); $('#first-run-note').classList.add('hidden'); $('#login-form').classList.remove('hidden');
    $('#login-email').value = $('#reg-email').value;
  } catch (ex) { $('#reg-error').textContent = ex.message; $('#reg-error').classList.remove('hidden'); }
});
$('#logout-btn').addEventListener('click', async () => { try { await POST('/api/auth/logout'); } catch { /* ignore */ } location.reload(); });
async function changePassword() {
  const v = await formModal('Change password', [
    { name: 'cur', label: 'Current password', type: 'password', required: true },
    { name: 'nw', label: 'New password (8+ characters)', type: 'password', required: true },
  ]);
  if (!v) return;
  try { await POST('/api/auth/change-password', { currentPassword: v.cur, newPassword: v.nw }); toast('Password changed.'); } catch (ex) { fail(ex); }
}
$('#change-pw-btn').addEventListener('click', changePassword);

// ---------------- notifications ----------------
async function refreshBell() {
  try {
    const d = await api('/api/notifications');
    $('#bell-count').textContent = d.unread;
    $('#bell-count').classList.toggle('hidden', !d.unread);
    return d;
  } catch { return null; }
}
setInterval(() => { if (ME) refreshBell(); }, 60000);
$('#bell-btn').addEventListener('click', async () => {
  const d = await refreshBell();
  if (!d) return;
  showModal(`<div class="row-between"><h3>Alerts</h3><div class="toolbar"><button class="btn small" id="read-all">Mark all read</button><button class="btn small" data-close>Close</button></div></div>
    ${d.notifications.map((n) => `<div class="notif ${n.read ? '' : 'unread'}"><div>${esc(n.title)} ${n.book_title ? `<span class="muted small">· ${esc(n.book_title)}</span>` : ''}</div>${n.body ? `<div class="small muted pre">${esc(n.body)}</div>` : ''}<div class="small muted">${esc(n.created_at)} UTC ${n.book_id ? `· <a href="#" data-open-book="${n.book_id}">open book</a>` : ''}</div></div>`).join('') || '<p class="muted">Nothing yet.</p>'}`, true);
  $('#read-all').addEventListener('click', async () => { await POST('/api/notifications/read-all'); closeModal(); refreshBell(); });
  $$('[data-open-book]', $('#modal-card')).forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); closeModal(); openBook(a.dataset.openBook); }));
});

// ---------------- dashboard ----------------
async function loadDashboard() {
  const d = await api('/api/dashboard');
  const k = d.kpis;
  $('#kpis').innerHTML = [
    ['Royalties this month', money(k.royaltyMonth)], ['Units this month', num(k.unitsMonth)], ['Ad spend this month', money(k.adSpendMonth)],
    ['Net margin, all time', money(k.netAllTime)], ['Confirmed readers', num(k.readers)], ['Link clicks, 30 days', num(k.clicks30d)], ['Books live', `${k.live} / ${k.books}`],
  ].map(([l, v]) => `<div class="kpi-tile"><div class="v">${esc(v)}</div><div class="l">${esc(l)}</div></div>`).join('');
  const t = d.today;
  const sec = (title, items, empty) => `<div class="card"><h4>${title}</h4>${items || `<p class="muted small">${empty}</p>`}</div>`;
  $('#today-panel').innerHTML = [
    sec(`Posts to do by hand (${t.manualPosts.length})`, t.manualPosts.map((p) => `<div class="post"><div class="meta">${badge(p.status)} <strong>${esc(p.channel)}</strong> · ${esc(p.title)} · ${esc(localTime(p.scheduled_at))}</div><div class="txt">${esc(p.text)}</div>${p.error ? `<div class="small muted">${esc(p.error)}</div>` : ''}<div class="toolbar"><button class="btn small" data-act="copy-post" data-id="${p.id}">Copy text</button><button class="btn small" data-act="posted" data-id="${p.id}">Mark posted</button><button class="btn small" data-act="retry-post" data-id="${p.id}">Try again</button></div></div>`).join(''), 'Nothing to post by hand.'),
    sec(`Tasks due this week (${t.tasksDue.length})`, t.tasksDue.map((x) => `<div class="small"><label class="inline"><input type="checkbox" data-task="${x.id}"> ${esc(x.title)}</label> <span class="muted">— ${esc(x.book_title)} · ${x.due_date < today() ? '<span class="badge red">overdue</span>' : esc(x.due_date)}${x.owner ? ' · ' + esc(x.owner) : ''}</span></div>`).join(''), 'Nothing due.'),
    sec('Backlist check-ins to review', t.refreshDue.map((c) => `<div class="small"><a href="#" data-open-book="${c.book_id}" data-tab="refresh">${esc(c.title)}</a> — ${esc(c.kind)} ${badge(c.status)} ${esc(c.due_date)}</div>`).join(''), 'None due.'),
    sec('Reviews to answer', t.reviewsToAnswer.map((r) => `<div class="small">${'★'.repeat(r.rating)}${'☆'.repeat(5 - r.rating)} <a href="#" data-open-book="${r.book_id}" data-tab="arc">${esc(r.title)}</a> — ${esc(r.store || '')}</div>`).join(''), 'Nothing waiting.'),
    sec('Coming up on the calendar', t.upcomingPosts.map((p) => `<div class="small">${esc(localTime(p.scheduled_at))} · ${esc(p.channel)} · ${esc(p.title)}</div>`).join(''), 'Nothing scheduled.'),
    sec('Active ARC campaigns', t.arcReminders.map((c) => `<div class="small">${esc(c.name)} — ${esc(c.title)}</div>`).join(''), 'No active ARC campaigns.'),
  ].join('');
  const pub = await api('/api/publishing/overview');
  const pubBooks = pub.books.filter((b) => b.hasChecklist);
  $('#today-panel').insertAdjacentHTML('afterbegin', `<div class="card"><h4>Publishing — what’s live and what’s missing</h4>${pubBooks.map((b) => `<div class="small" style="margin-bottom:.45rem"><a href="#" data-open-book="${b.id}" data-tab="publishing"><strong>${esc(b.title)}</strong></a> — ${b.done}/${b.total} live${b.pending ? ` · ${b.pending} pending` : ''}${b.rejected ? ` · <span style="color:var(--danger)">rejected: ${b.rejectedList.map((x) => esc(x.store)).join(', ')}</span>` : ''}${b.stuck.length ? ` · <span style="color:var(--danger)">stuck: ${b.stuck.map((x) => esc(x.store)).join(', ')}</span>` : ''}<div class="progress"><div style="width:${b.total ? Math.round((b.done / b.total) * 100) : 0}%"></div></div>${b.next.length ? `<span class="muted">Next: ${esc(b.next.join(', '))}</span>` : ''}</div>`).join('') || '<p class="muted small">No publishing checklists yet — open a book → Publishing → Build checklist.</p>'}${pub.books.filter((b) => !b.hasChecklist).length ? `<p class="muted small">${pub.books.filter((b) => !b.hasChecklist).length} book(s) without a checklist yet.</p>` : ''}</div>`);
  const brief = await api('/api/portfolio/briefing');
  $('#today-panel').insertAdjacentHTML('beforeend', `<div class="card"><div class="row-between"><h4 style="margin:0">Portfolio briefing</h4><button class="btn small" data-act="briefing">${brief.last ? 'Refresh' : 'Run'} briefing</button></div>${brief.last ? `<p class="small muted">${esc(localTime(brief.last.at))} · ${brief.last.books} books · ${esc(brief.last.provider || '')}</p><details><summary class="small">Read it</summary><div class="pre small">${esc(brief.last.text)}</div></details>` : '<p class="muted small">Whole-catalogue review from your own figures: what works, what loses money, gaps, and a 90-day action list.</p>'}</div>`);
  const panel = $('#today-panel');
  actions(panel, {
    briefing: async () => { toast('Working on the briefing…'); const r = await POST('/api/portfolio/briefing'); toast(r.local ? 'Local draft — connect an AI provider for the full briefing.' : 'Briefing ready.'); loadDashboard(); },
    'copy-post': async (ds) => { const p = t.manualPosts.find((x) => String(x.id) === ds.id); copyText(p.text); },
    posted: async (ds) => { await POST(`/api/posts/${ds.id}/posted`); toast('Marked as posted.'); loadDashboard(); },
    'retry-post': async (ds) => { const r = await POST(`/api/posts/${ds.id}/publish-now`); toast(r.status === 'posted' ? 'Posted.' : r.error, r.status !== 'posted'); loadDashboard(); },
  });
  $$('[data-task]', panel).forEach((el) => el.addEventListener('change', async () => { await POST(`/api/tasks/${el.dataset.task}/done`, { done: el.checked }); toast('Task done.'); }));
  $$('[data-open-book]', panel).forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); openBook(a.dataset.openBook, a.dataset.tab); }));
  Charts.columns($('#dash-chart'), d.monthly.months.slice(-12).map((m) => ({ label: m.month.slice(2).replace('-', '/'), value: m.royalty })), { format: (v) => money(v) });
  $('#kdp-planner').innerHTML = d.kdpPlanner.map((p) => `<div class="card"><h4>${esc(p.format)}</h4><div class="kpi">${p.used} / ${p.limit}</div><p class="muted small">Week ${esc(p.weekStart)} – ${esc(p.weekEnd)}<br>${p.allowed ? 'Slot available' : 'Cap reached this week'}</p></div>`).join('');
  $('#dash-jobs').innerHTML = d.jobs.length ? `<h2>Working in the background</h2><div class="card small">${d.jobs.map((j) => `<div>${esc(j.kind.replace(/_/g, ' '))} ${badge(j.status)} ${esc(j.progress || '')}</div>`).join('')}</div>` : '';
  const imps = await api('/api/imprints');
  const fi = $('#filter-imprint'), fs = $('#filter-stage');
  const keepI = fi.value, keepS = fs.value;
  fi.innerHTML = '<option value="">All imprints</option>' + imps.imprints.map((i) => `<option value="${i.id}">${esc(i.name)}</option>`).join('');
  fs.innerHTML = '<option value="">All stages</option>' + STAGE_NAMES.map((n, i) => `<option value="${i + 1}">${i + 1}. ${esc(n)}</option>`).join('');
  fi.value = keepI; fs.value = keepS;
  const renderBoard = () => {
    const books = d.books.filter((b) => (!fi.value || String(b.imprint_id) === fi.value) && (!fs.value || String(b.current_stage) === fs.value));
    const byStage = {};
    for (const b of books) (byStage[b.current_stage] = byStage[b.current_stage] || []).push(b);
    $('#board').innerHTML = STAGE_NAMES.map((name, i) => (fs.value && String(i + 1) !== fs.value) ? '' : `<div class="stage-col"><h4>${i + 1}. ${esc(name)}</h4>${(byStage[i + 1] || []).map((b) => `<button class="pill" data-book="${b.id}"><strong>${esc(b.title)}</strong><br><span class="muted small">${esc(b.imprintName || '')} · net ${money(b.margin?.net)}</span></button>`).join('') || '<p class="muted small">—</p>'}</div>`).join('');
    $$('#board [data-book]').forEach((el) => el.addEventListener('click', () => openBook(el.dataset.book)));
  };
  fi.onchange = renderBoard; fs.onchange = renderBoard;
  renderBoard();
}

// ---------------- books ----------------
async function loadBooks() {
  const { books } = await api('/api/books');
  $('#book-list').innerHTML = books.map((b) => `<div class="card">
    <h3>${esc(b.title)}</h3><p class="muted small">${esc(b.subtitle || '')}</p>
    <p class="small">${esc(b.imprintName || '—')} · Stage ${b.current_stage}/11 · ${b.stagesDone} done<br>Production ${money(b.production_cost_usd)} · Net ${money(b.margin?.net)}${b.launch_date ? ` · Launch ${esc(b.launch_date)}` : ''}</p>
    <button class="btn" data-open="${b.id}">Open</button></div>`).join('') || '<p class="muted">No books yet — they arrive by handoff, or add one here.</p>';
  $$('#book-list [data-open]').forEach((el) => el.addEventListener('click', () => openBook(el.dataset.open)));
}

async function imprintOptions() { const { imprints } = await api('/api/imprints'); return imprints.map((i) => [i.id, i.name]); }

$('#new-book-btn').addEventListener('click', async () => {
  const v = await formModal('New book', [
    { name: 'title', label: 'Title', required: true }, { name: 'subtitle', label: 'Subtitle' }, { name: 'author', label: 'Author name' },
    { name: 'series', label: 'Series' }, { name: 'seriesNo', label: 'Number in series', type: 'number' },
    { name: 'imprintId', label: 'Imprint', type: 'select', options: await imprintOptions() },
    { name: 'productionCostUsd', label: 'Production cost (USD)', type: 'number', step: '0.01', value: 0 },
    { name: 'aiUseNotes', label: 'AI-use notes (for KDP’s AI questions)' }, { name: 'driveFolder', label: 'Drive folder (08-Marketing)' },
  ], { submit: 'Create book' });
  if (!v) return;
  try { const { id } = await POST('/api/books', v); openBook(id); } catch (ex) { fail(ex); }
});

$('#import-book-btn').addEventListener('click', async () => {
  const v = await formModal('Import a book made elsewhere', [
    { name: 'title', label: 'Title', required: true }, { name: 'subtitle', label: 'Subtitle' }, { name: 'author', label: 'Author name' },
    { name: 'imprintId', label: 'Imprint', type: 'select', options: await imprintOptions() },
    { name: 'ms', label: 'Manuscript (.txt or .md splits into chapters; .zip handoff package is unpacked)', type: 'file', accept: '.txt,.md,.markdown,.zip,.docx,.pdf,.epub' },
    { name: 'cover', label: 'Cover (JPG, PNG or SVG)', type: 'file', accept: 'image/*,.svg' },
  ], { submit: 'Import book', note: 'The book starts at stage 1 (final copy received).' });
  if (!v) return;
  const files = [];
  if (v.ms) files.push({ name: v.ms.name, type: 'manuscript', base64: await readFile(v.ms, 'base64') });
  if (v.cover) files.push({ name: v.cover.name, type: 'cover', base64: await readFile(v.cover, 'base64') });
  try { const r = await POST('/api/books/import', { title: v.title, subtitle: v.subtitle, author: v.author, imprintId: v.imprintId, files }); toast(r.chapters ? `Imported — ${r.chapters} chapters found.` : 'Imported.'); openBook(r.id); } catch (ex) { fail(ex); }
});

const TABS = [['overview', 'Overview'], ['metadata', 'Metadata'], ['worldwide', 'Worldwide'], ['publishing', 'Publishing'], ['launch', 'Launch'], ['content', 'Content'], ['calendar', 'Calendar'], ['links', 'Links & page'], ['arc', 'ARC & reviews'], ['outreach', 'Outreach'], ['promo', 'Promotions & ads'], ['bookstores', 'Bookstores & libraries'], ['editions', 'Editions'], ['sales', 'Sales & ranks'], ['refresh', 'Refresh']];

async function openBook(id, tab) {
  if (tab) CURRENT_TAB = tab;
  else if (String(CURRENT_BOOK) !== String(id)) CURRENT_TAB = 'overview';
  CURRENT_BOOK = id;
  if ($('#view-books').classList.contains('hidden')) {
    $$('.view').forEach((v) => v.classList.add('hidden'));
    $('#view-books').classList.remove('hidden');
    $$('.nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.view === 'books'));
  }
  $('#book-list-wrap').classList.add('hidden');
  let d;
  try { d = await api('/api/books/' + id); } catch (ex) { return fail(ex); }
  BOOK = d;
  const b = d.book;
  $('#book-detail').innerHTML = `
    <div class="toolbar" style="margin-top:1rem"><button class="btn small" id="back-books">← All books</button></div>
    <div class="card">
      <div class="book-head">${b.hasCover ? `<img src="/p/${esc(b.slug)}/cover" alt="">` : ''}<div>
        <h2 style="margin:0">${esc(b.title)}</h2>
        <p class="muted" style="margin:.2rem 0">${esc(b.subtitle || '')}${b.subtitle ? ' · ' : ''}${esc(b.author || '')} · ${esc(b.imprintName || 'no imprint')} · Stage ${b.current_stage}/11 · Launch ${esc(b.launch_date || 'not set')}</p>
        <p class="small" style="margin:.2rem 0">Net ${money(b.margin?.net)} = royalties ${money(b.margin?.royalty)} − promotion ${money(b.margin?.spend)} − production ${money(b.margin?.productionCost)}${d.smartLink ? ` · Smart link <code>${esc(d.smartLink)}</code>` : ''}</p>
      </div></div>
      <div class="tabs">${TABS.map(([k, label]) => `<button class="tab-btn ${k === CURRENT_TAB ? 'active' : ''}" data-tab="${k}">${label}</button>`).join('')}</div>
      <div id="tab-body"></div>
    </div>`;
  $('#back-books').addEventListener('click', () => showView('books'));
  $$('#book-detail [data-tab]').forEach((el) => el.addEventListener('click', () => { CURRENT_TAB = el.dataset.tab; openBook(id); }));
  try { await (TAB_RENDER[CURRENT_TAB] || TAB_RENDER.overview)(d, $('#tab-body')); } catch (ex) { fail(ex); }
}
const reload = () => openBook(CURRENT_BOOK);

const TAB_RENDER = {};

// ---- Overview: pipeline, details, files ----
TAB_RENDER.overview = async (d, body) => {
  const b = d.book;
  body.innerHTML = `<h3>Pipeline</h3><div class="stage-grid">${d.stages.map((s) => `<div class="stage ${s.status}"><div class="small muted">Stage ${s.stage_no} · ${esc(s.kind)}</div><strong>${esc(s.name)}</strong><div>${badge(s.status)}</div>${s.payload?.gate?.reasonCode ? `<div class="small muted">Sent back: ${esc(s.payload.gate.reasonCode)}</div>` : ''}
    <div class="toolbar">${s.status !== 'done' ? `<button class="btn small" data-act="approve" data-n="${s.stage_no}">Approve</button>` : ''}<button class="btn small" data-act="sendback" data-n="${s.stage_no}">Send back</button>${!['done', 'skipped'].includes(s.status) ? `<button class="btn small" data-act="skip" data-n="${s.stage_no}">Skip</button>` : ''}</div></div>`).join('')}</div>
    <div class="two-col"><div>
      <h3>Book details</h3>
      <div class="card small">
        <div>Series: ${esc(b.series || '—')}${b.series_no ? ` #${b.series_no}` : ''} · Language: ${esc(b.language || 'English')} · Trim ${esc(b.trim || '—')} · ${b.page_count || '—'} pages · ${num(b.words)} words</div>
        <div style="margin-top:.4rem">Back cover: ${esc((b.back_cover || '—').slice(0, 400))}</div>
        <div style="margin-top:.4rem">Author bio: ${esc(b.author_bio || '—')}</div>
        <div style="margin-top:.4rem">AI-use notes: ${esc(b.ai_use_notes || '—')}</div>
        <div style="margin-top:.4rem">Drive: ${b.drive_folder ? `<a href="${esc(b.drive_folder)}" target="_blank" rel="noopener">08-Marketing folder</a>` : '—'}</div>
        <div class="toolbar"><button class="btn small" data-act="edit-book">Edit details</button>${ME.isAdmin ? '<button class="btn small danger" data-act="delete-book">Delete book</button>' : ''}</div>
      </div>
      <h3>Gate history</h3>${d.gates.map((g) => `<p class="small">Stage ${g.stage_no}: ${esc(g.decision)} by ${esc(g.decided_by_name || '—')} ${esc(g.reason_code || '')} ${esc(g.note || '')} <span class="muted">${esc(g.created_at)}</span></p>`).join('') || '<p class="muted small">No gates yet.</p>'}
    </div><div>
      <h3>Manuscript</h3>
      <div class="card small">${d.chapters.length ? `${d.chapters.length} chapters · ${num(d.chapters.reduce((a, c) => a + c.words, 0))} words<div class="pre">${d.chapters.map((c) => `${c.no}. ${esc(c.title)} (${num(c.words)} words)`).join('\n')}</div>` : 'No chapters yet — the manuscript arrives with the book handoff, or upload it.'}
        <div class="toolbar"><button class="btn small" data-act="upload-ms">Upload manuscript (.txt / .md)</button></div></div>
      <h3>Files</h3>
      <div class="card small">${d.files.map((f) => `<div><a href="/api/files/${f.id}/download">${esc(f.name)}</a> <span class="muted">· ${esc(f.type)} v${f.version} · ${esc(f.licence_note || '')}</span></div>`).join('') || '<span class="muted">No files.</span>'}</div>
    </div></div>`;
  actions(body, {
    approve: async (ds) => { await POST(`/api/books/${b.id}/stage/${ds.n}/gate`, { decision: 'approve' }); toast(`Stage ${ds.n} approved.`); reload(); },
    skip: async (ds) => { await POST(`/api/books/${b.id}/stage/${ds.n}/skip`); reload(); },
    sendback: async (ds) => {
      const v = await formModal(`Send back stage ${ds.n}`, [
        { name: 'reasonCode', label: 'Reason code (feeds the Kaizen lessons)', type: 'select', options: ['description', 'keywords', 'categories', 'price', 'cover', 'timing', 'compliance', 'content', 'other'].map((x) => [x, x]) },
        { name: 'note', label: 'Note', type: 'textarea', rows: 3 },
      ], { submit: 'Send back' });
      if (v) { await POST(`/api/books/${b.id}/stage/${ds.n}/gate`, { decision: 'send_back', ...v }); reload(); }
    },
    'edit-book': async () => {
      const v = await formModal('Edit book details', [
        { name: 'title', label: 'Title', value: b.title, required: true }, { name: 'subtitle', label: 'Subtitle', value: b.subtitle }, { name: 'author', label: 'Author', value: b.author },
        { name: 'series', label: 'Series', value: b.series }, { name: 'seriesNo', label: 'Number in series', type: 'number', value: b.series_no },
        { name: 'imprintId', label: 'Imprint', type: 'select', options: await imprintOptions(), value: b.imprint_id },
        { name: 'language', label: 'Primary language', value: b.language }, { name: 'trim', label: 'Trim size', value: b.trim }, { name: 'pageCount', label: 'Pages', type: 'number', value: b.page_count },
        { name: 'backCover', label: 'Back-cover copy', type: 'textarea', value: b.back_cover }, { name: 'authorBio', label: 'Author bio', type: 'textarea', rows: 3, value: b.author_bio },
        { name: 'productionCostUsd', label: 'Production cost (USD)', type: 'number', step: '0.01', value: b.production_cost_usd },
        { name: 'aiUseNotes', label: 'AI-use notes', value: b.ai_use_notes }, { name: 'driveFolder', label: 'Drive folder link', value: b.drive_folder },
        { name: 'slug', label: 'Link name (for /b/… and /p/…)', value: b.slug }, { name: 'landingEnabled', label: 'Public book page on', type: 'checkbox', value: !!b.landing_enabled },
      ], { wide: true });
      if (v) { await PUT(`/api/books/${b.id}`, v); toast('Saved.'); reload(); }
    },
    'delete-book': async () => { if (await confirmModal(`Delete "${b.title}" and everything recorded for it? This cannot be undone.`, 'Delete')) { await DEL(`/api/books/${b.id}`); showView('books'); } },
    'upload-ms': async () => {
      const v = await formModal('Upload manuscript', [{ name: 'file', label: 'Plain text or Markdown — chapters are found from “Chapter 1”, “# Title” headings', type: 'file', accept: '.txt,.md,.markdown', required: true }], { submit: 'Upload' });
      if (!v || !v.file) return;
      const r = await POST(`/api/books/${b.id}/manuscript`, { text: await readFile(v.file), name: v.file.name });
      toast(`${r.chapters} chapters found.`); reload();
    },
  });
};

// ---- Metadata ----
TAB_RENDER.metadata = async (d, body) => {
  const m = d.metadata || {};
  const kw = parseJson(m.keywords), cats = parseJson(m.categories), comps = parseJson(m.comparable_titles);
  body.innerHTML = `<div class="two-col"><div>
    <label>Description <span class="muted small" id="desc-count"></span><textarea id="md-desc" rows="12">${esc(m.description || '')}</textarea></label>
    <label>Audience <input id="md-aud" value="${esc(m.audience || '')}"></label>
    <label>Comparable titles (comma-separated) <input id="md-comp" value="${esc(comps.join(', '))}"></label>
  </div><div>
    <div class="small">KDP keyword boxes (7 × 50 characters)</div>
    ${[0, 1, 2, 3, 4, 5, 6].map((i) => `<input class="kw" maxlength="50" value="${esc(kw[i] || '')}" placeholder="Keyword box ${i + 1}">`).join('')}
    <label>Categories (comma-separated) <input id="md-cat" value="${esc(cats.join(', '))}"></label>
    <div class="toolbar"><button class="btn primary" data-act="save">Save metadata</button><button class="btn" data-act="research">Research keywords & categories</button><button class="btn" data-act="copy">Copy for KDP</button></div>
    <p class="muted small">Localized versions for other markets are on the Worldwide tab.</p>
  </div></div>`;
  const count = () => { const n = $('#md-desc').value.length; $('#desc-count').textContent = `${n.toLocaleString()} / 4,000`; $('#desc-count').style.color = n > 4000 ? 'var(--danger)' : ''; };
  $('#md-desc').addEventListener('input', count); count();
  const values = () => ({ description: $('#md-desc').value, keywords: $$('.kw', body).map((i) => i.value.trim()).filter(Boolean), categories: $('#md-cat').value.split(',').map((s) => s.trim()).filter(Boolean), comparableTitles: $('#md-comp').value.split(',').map((s) => s.trim()).filter(Boolean), audience: $('#md-aud').value });
  actions(body, {
    save: async () => { const r = await PUT(`/api/books/${d.book.id}/metadata`, values()); toast(r.warnings?.length ? r.warnings.join('\n') : 'Metadata saved.', !!r.warnings?.length); },
    research: async () => { const r = await POST(`/api/books/${d.book.id}/research`, { kind: 'keywords', market: 'US' }); showResearch(r); },
    copy: async () => { const v = values(); copyText(`TITLE: ${d.book.title}\nSUBTITLE: ${d.book.subtitle || ''}\n\nDESCRIPTION:\n${v.description}\n\nKEYWORDS:\n${v.keywords.join('\n')}\n\nCATEGORIES:\n${v.categories.join('\n')}`); },
  });
};
function showResearch(r) {
  showModal(`<h3>Research result</h3>${r.note ? `<p class="note">${esc(r.note)}</p>` : ''}<p class="muted small">Source: ${esc(r.provider)}${r.local ? ' (local placeholder — connect Perplexity or another AI key)' : ''}</p><div class="pre">${esc(r.result)}</div><div class="toolbar"><button class="btn" id="copy-res">Copy</button><button class="btn" data-close>Close</button></div>`, true);
  $('#copy-res').addEventListener('click', () => copyText(r.result));
}

// ---- Worldwide: pricing ladder, localized metadata, research, rights ----
TAB_RENDER.worldwide = async (d, body) => {
  const g = await api(`/api/books/${d.book.id}/global`);
  const rights = (await api(`/api/books/${d.book.id}/rights`)).rights;
  body.innerHTML = `<p class="note small">${esc(g.note)}</p>
    <h3>Prices in every Amazon marketplace</h3>
    ${g.editions.length ? g.editions.map((e) => `<div class="card" style="margin-bottom:.75rem"><div class="row-between"><strong>${esc(e.format)} · ${esc(e.language)} · base ${money(e.price)}${e.kdpSelect ? ' · KDP Select' : ''}</strong>
      <div class="toolbar"><button class="btn small" data-act="save-prices" data-id="${e.id}">Save prices</button><button class="btn small" data-act="copy-prices" data-id="${e.id}">Copy for KDP</button></div></div>
      <div class="table-wrap"><table><tr><th>Market</th><th class="num">List price</th><th class="num">Royalty rate</th><th class="num">Est. royalty</th><th class="num">≈ USD</th><th>Notes</th></tr>
      ${e.ladder.map((r) => `<tr><td>${esc(r.name)}</td><td class="num"><input class="px" data-ed="${e.id}" data-mp="${r.marketplace}" type="number" step="0.01" value="${r.price}" style="width:7rem;text-align:right"> ${esc(r.currency)}</td><td class="num">${r.rate ? Math.round(r.rate * 100) + '%' : '—'}</td><td class="num">${r.royalty != null ? money(r.royalty, r.currency) : '—'}</td><td class="num">${r.royaltyUsd != null ? money(r.royaltyUsd) : '—'}</td><td class="small muted">${esc(r.warnings.join(' '))}</td></tr>`).join('')}</table></div></div>`).join('') : '<p class="muted">Add an edition with a USD price on the Stores tab first.</p>'}
    <p class="muted small">Exchange rates: ${g.fx.slice(0, 11).map((f) => `${f.currency} ${f.per_usd}`).join(' · ')} — ${esc(g.fx[0]?.source || '')}. Admins can refresh them in Settings → Worldwide.</p>

    <h3>Localized store pages</h3>
    <p class="muted small">Localized (not word-for-word) title, description, keywords and categories per language, for the KDP marketplace pages, Apple, Kobo and Google in that language. Each needs a native reviewer before you paste it into a store; approved languages also show on the public book page.</p>
    <div class="toolbar"><button class="btn primary" data-act="localize">Localize for more languages</button></div>
    ${g.localized.map((l) => `<div class="card" style="margin-bottom:.6rem"><div class="row-between"><strong>${esc(l.lang)}</strong> <span>${badge(l.status)} ${l.reviewer ? `<span class="small muted">reviewer: ${esc(l.reviewer)}</span>` : ''}</span></div>
      <div class="small"><strong>${esc(l.title)}</strong>${l.subtitle ? ' — ' + esc(l.subtitle) : ''}</div><div class="pre">${esc(l.description)}</div>
      <div class="small">Keywords: ${esc(parseJson(l.keywords).join(' · '))}</div><div class="small">Categories: ${esc(parseJson(l.categories).join(' · '))}</div>
      <div class="toolbar"><button class="btn small" data-act="edit-loc" data-id="${l.id}">Edit / approve</button><button class="btn small" data-act="copy-loc" data-id="${l.id}">Copy</button><button class="btn small danger" data-act="del-loc" data-id="${l.id}">Delete</button></div></div>`).join('') || '<p class="muted small">None yet.</p>'}

    <h3>Research</h3>
    <div class="toolbar"><select id="rs-market">${g.marketplaces.map((m) => `<option value="${m.code}">${esc(m.name)}</option>`).join('')}</select>
      <button class="btn" data-act="research" data-kind="keywords">KDP keywords, categories & comps</button><button class="btn" data-act="research" data-kind="ads_keywords">Amazon Ads keywords</button></div>
    ${g.research.map((r) => `<div class="card" style="margin-bottom:.5rem"><div class="row-between"><span class="small"><strong>${esc(r.kind === 'ads_keywords' ? 'Ads keywords' : 'Keywords & categories')}</strong> · ${esc(r.market)} · ${esc(r.provider)} · ${esc(r.created_at)}</span><span><button class="btn small" data-act="view-research" data-id="${r.id}">Open</button> <button class="btn small danger" data-act="del-research" data-id="${r.id}">Delete</button></span></div></div>`).join('') || '<p class="muted small">No research yet.</p>'}

    <h3>Foreign rights</h3>
    <p class="muted small">License translation, audio or territory rights to local publishers — the route into markets you can’t self-publish into well. Generate a rights-guide entry on the Content tab.</p>
    <div class="table-wrap"><table><tr><th>Territory</th><th>Language</th><th>Rights</th><th>Partner / agent</th><th>Status</th><th class="num">Advance</th><th class="num">Royalty</th><th>Signed / reverts</th><th></th></tr>
    ${rights.map((r) => `<tr><td>${esc(r.territory)}</td><td>${esc(r.language)}</td><td>${esc(r.rights_type)}</td><td>${esc(r.partner)}${r.agent ? ` / ${esc(r.agent)}` : ''}</td><td>${badge(r.status)}</td><td class="num">${r.advance ? money(r.advance, r.currency) : '—'}</td><td class="num">${r.royalty_pct ? r.royalty_pct + '%' : '—'}</td><td class="small">${esc(r.signed_date || '')}${r.reversion_date ? ' → ' + esc(r.reversion_date) : ''}</td><td><button class="btn small" data-act="edit-right" data-id="${r.id}">Edit</button></td></tr>`).join('') || '<tr><td colspan="9" class="muted">No rights tracked yet.</td></tr>'}</table></div>
    <div class="toolbar"><button class="btn" data-act="add-right">+ Rights opportunity</button></div>`;
  const rightForm = (r = {}) => formModal(r.id ? 'Edit rights deal' : 'Rights opportunity', [
    { name: 'territory', label: 'Territory', value: r.territory, required: true, placeholder: 'Germany, or World Spanish' }, { name: 'language', label: 'Language', value: r.language },
    { name: 'rightsType', label: 'Rights', type: 'select', value: r.rights_type || 'translation', options: [['translation', 'Translation'], ['audio', 'Audio'], ['print', 'Print (territory)'], ['all', 'All formats']] },
    { name: 'partner', label: 'Publisher / partner', value: r.partner }, { name: 'agent', label: 'Agent / co-agent', value: r.agent },
    { name: 'status', label: 'Status', type: 'select', value: r.status || 'available', options: ['available', 'pitched', 'offer', 'negotiating', 'signed', 'published', 'reverted', 'declined'].map((x) => [x, x]) },
    { name: 'advance', label: 'Advance', type: 'number', step: '0.01', value: r.advance }, { name: 'currency', label: 'Currency', value: r.currency || 'USD' },
    { name: 'royaltyPct', label: 'Royalty %', type: 'number', step: '0.1', value: r.royalty_pct }, { name: 'termYears', label: 'Term (years)', type: 'number', value: r.term_years },
    { name: 'signedDate', label: 'Signed', type: 'date', value: r.signed_date }, { name: 'reversionDate', label: 'Rights revert', type: 'date', value: r.reversion_date },
    { name: 'notes', label: 'Notes', type: 'textarea', rows: 3, value: r.notes },
  ], { wide: true });
  actions(body, {
    'save-prices': async (ds) => { const prices = {}; $$(`.px[data-ed="${ds.id}"]`, body).forEach((i) => { prices[i.dataset.mp] = i.value; }); await POST(`/api/editions/${ds.id}/prices`, { prices }); toast('Prices saved — royalties recalculated.'); reload(); },
    'copy-prices': async (ds) => { const e = g.editions.find((x) => String(x.id) === ds.id); copyText(e.ladder.map((r) => `${r.name}: ${r.price} ${r.currency}`).join('\n')); },
    localize: async () => {
      const done = g.localized.map((l) => l.lang);
      const v = await formModal('Localize store pages', [{ name: 'languages', label: 'Languages', type: 'checkboxes', options: g.languages.filter((l) => !done.includes(l)).map((l) => [l, l]), value: ['German', 'French', 'Spanish', 'Italian'].filter((l) => !done.includes(l)) }], { submit: 'Start', note: 'Runs in the background — a few minutes per language. Uses the “localize_metadata” route (Claude first).' });
      if (v && v.languages.length) { const r = await POST(`/api/books/${d.book.id}/localize`, { languages: v.languages }); toast(r.note); }
    },
    'edit-loc': async (ds) => {
      const l = g.localized.find((x) => String(x.id) === ds.id);
      const v = await formModal(`${l.lang} store page`, [
        { name: 'title', label: 'Title', value: l.title }, { name: 'subtitle', label: 'Subtitle', value: l.subtitle },
        { name: 'description', label: 'Description', type: 'textarea', rows: 10, value: l.description },
        { name: 'keywords', label: 'Keywords (one per line)', type: 'textarea', rows: 7, value: parseJson(l.keywords).join('\n') },
        { name: 'categories', label: 'Categories (one per line)', type: 'textarea', rows: 3, value: parseJson(l.categories).join('\n') },
        { name: 'reviewer', label: 'Native reviewer', value: l.reviewer },
        { name: 'status', label: 'Status', type: 'select', value: l.status, options: [['draft', 'Draft'], ['in review', 'With reviewer'], ['approved', 'Approved by native reviewer']] },
      ], { wide: true });
      if (v) { await PUT(`/api/localized/${l.id}`, { ...v, keywords: v.keywords.split('\n').map((s) => s.trim()).filter(Boolean), categories: v.categories.split('\n').map((s) => s.trim()).filter(Boolean) }); toast('Saved.'); reload(); }
    },
    'copy-loc': async (ds) => { const l = g.localized.find((x) => String(x.id) === ds.id); copyText(`${l.title}\n${l.subtitle}\n\n${l.description}\n\n${parseJson(l.keywords).join('\n')}`); },
    'del-loc': async (ds) => { if (await confirmModal('Delete this localized version?', 'Delete')) { await DEL(`/api/localized/${ds.id}`); reload(); } },
    research: async (ds) => { const r = await POST(`/api/books/${d.book.id}/research`, { kind: ds.kind, market: $('#rs-market').value }); showResearch(r); reload(); },
    'view-research': async (ds) => { const r = g.research.find((x) => String(x.id) === ds.id); showResearch({ result: r.result, provider: r.provider }); },
    'del-research': async (ds) => { await DEL(`/api/research/${ds.id}`); reload(); },
    'add-right': async () => { const v = await rightForm(); if (v) { await POST(`/api/books/${d.book.id}/rights`, v); reload(); } },
    'edit-right': async (ds) => { const r = rights.find((x) => String(x.id) === ds.id); const v = await rightForm(r); if (v) { await PUT(`/api/rights/${r.id}`, v); reload(); } },
  });
};

// ---- Publishing: editions × every platform, statuses, checklist ----
const PUB_STATUS_BADGE = { not_started: '', uploaded: 'blue', in_review: 'amber', live: 'green', 'pre-order': 'blue', rejected: 'red', delisted: 'red', na: '' };
TAB_RENDER.publishing = async (d, body) => {
  const [r, comp] = await Promise.all([api(`/api/books/${d.book.id}/rollout`), api(`/api/books/${d.book.id}/compliance`)]);
  const L = r.statusLabels;
  const pbadge = (s) => `<span class="badge ${PUB_STATUS_BADGE[s] || ''}">${esc(L[s] || s)}</span>`;
  const phaseName = Object.fromEntries(r.phases);
  const sm = r.summary;
  const pct = sm.total ? Math.round((sm.done / sm.total) * 100) : 0;
  body.innerHTML = `<div class="two-col"><div>
      <h3 style="margin-top:0">Publishing progress</h3>
      <div class="card"><div class="row-between"><strong>${sm.done} of ${sm.total} live</strong><span class="small muted">${sm.pending} uploaded/in review${sm.stuck ? ` (<span style="color:var(--danger)">${sm.stuck} stuck over 7 days</span>)` : ''} · ${sm.rejected} rejected · ${sm.notStarted} not started · ${sm.na} not applicable</span></div>
        <div class="progress"><div style="width:${pct}%"></div></div>
        <div class="toolbar"><button class="btn primary" data-act="generate">Build checklist from the ${esc(r.planName)} plan</button><button class="btn" data-act="add-ed">+ Edition</button></div>
        <p class="muted small">Amazon first, then wide in the first two weeks, audio once the book proves it sells (manufacturing line) — from “Recommended setup per imprint”. Apple Books and Google Play are checked automatically once a day while uploaded or in review; every other store has no public lookup, so update it here.</p></div>
    </div><div>
      <h3 style="margin-top:0">Checks</h3><div class="card small">${comp.checks.map((c) => `<div>${c.ok ? '✓' : '✗'} ${esc(c.label)}</div>`).join('')}
        <div class="muted" style="margin-top:.4rem">KDP weekly cap: ${comp.kdpPlanner.map((p) => `${esc(p.format)} ${p.used}/${p.limit}`).join(' · ')} — counted when a title is first uploaded (drafts count).</div></div>
    </div></div>
    ${r.editions.map((e) => {
      const groups = {};
      for (const l of e.listings) (groups[l.phase || 'other'] = groups[l.phase || 'other'] || []).push(l);
      const order = [...r.phases.map((p) => p[0]), 'other'];
      const esm = e.summary;
      return `<div class="card" style="margin-top:.9rem">
        <div class="row-between"><div><strong>${esc(e.format)} · ${esc(e.language)}</strong> <span class="small muted">${e.price != null ? money(e.price) : 'no price'} · ISBN ${esc(e.isbn || '—')}</span> ${e.inSelect ? '<span class="badge amber">KDP Select — wide ebook stores blocked</span>' : ''}</div>
          <div class="small">${esm.done}/${esm.total} live <button class="btn small" data-act="edit-ed" data-id="${e.id}">Edit edition</button> <button class="btn small danger" data-act="del-ed" data-id="${e.id}">Delete</button></div></div>
        ${e.listings.length ? order.filter((ph) => groups[ph]).map((ph) => `<h4 style="margin:.8rem 0 .3rem">${esc(phaseName[ph] || 'Added by hand')}</h4>
          <div class="table-wrap"><table><tr><th>Platform</th><th>Route</th><th>Status</th><th>Since</th><th>Link / ID</th><th></th></tr>
          ${groups[ph].map((l) => `<tr${l.status === 'na' ? ' class="muted"' : ''}><td><strong>${l.platformUrl ? `<a href="${esc(l.platformUrl)}" target="_blank" rel="noopener">${esc(l.store)}</a>` : esc(l.store)}</strong>${l.platformNote ? `<div class="small muted">${esc(l.platformNote)}</div>` : ''}</td>
            <td class="small">${l.routes.length > 1 ? `<select data-route="${l.id}" style="width:auto;margin:0">${l.routes.map((rt) => `<option ${rt === l.route ? 'selected' : ''}>${esc(rt)}</option>`).join('')}</select>` : esc(l.route || 'Direct')}</td>
            <td>${pbadge(l.status)}${l.reason && ['rejected', 'delisted', 'na'].includes(l.status) ? `<div class="small muted">${esc(l.reason)}</div>` : ''}${l.check_result ? `<div class="small muted" title="${esc(l.last_checked)}">Check: ${esc(l.check_result)}</div>` : ''}</td>
            <td class="small">${esc(l.status_date || '')}${l.daysInStatus != null && ['uploaded', 'in_review'].includes(l.status) ? ` <span class="badge ${l.daysInStatus > 7 ? 'red' : ''}">${l.daysInStatus}d</span>` : ''}</td>
            <td class="small">${l.live_link ? `<a href="${esc(l.live_link)}" target="_blank" rel="noopener">open</a> ` : ''}${esc(l.asin || '')}</td>
            <td style="white-space:nowrap">${nextButtons(l)}<button class="btn small" data-act="status" data-id="${l.id}">Update…</button>${l.checkable ? ` <button class="btn small" data-act="check" data-id="${l.id}">Check live</button>` : ''}</td></tr>`).join('')}</table></div>`).join('') : '<p class="muted small">No platforms yet — press “Build checklist”, or add one below.</p>'}
        ${e.available.length ? `<div class="toolbar"><select data-add="${e.id}" style="max-width:340px">${e.available.map((p) => `<option value="${esc(p.name)}">${esc(p.name)} — ${esc(p.category)}</option>`).join('')}</select><button class="btn small" data-act="add-platform" data-ed="${e.id}">+ Add platform</button></div>` : ''}
      </div>`;
    }).join('') || '<p class="muted" style="margin-top:1rem">No editions yet — add the ebook, paperback, hardcover, audiobook or spiral workbook first.</p>'}`;

  function nextButtons(l) {
    const next = { not_started: ['uploaded', 'Mark uploaded'], uploaded: ['in_review', 'In review'], in_review: ['live', 'Mark live'], rejected: ['uploaded', 'Re-uploaded'], delisted: ['uploaded', 'Re-uploaded'] }[l.status];
    return next ? `<button class="btn small primary" data-act="quick" data-id="${l.id}" data-s="${next[0]}">${next[1]}</button> ` : '';
  }
  const all = r.editions.flatMap((e) => e.listings);
  const byId = (id) => all.find((l) => String(l.id) === String(id));
  $$('[data-route]', body).forEach((sel) => sel.addEventListener('change', async () => { try { await PUT(`/api/listings/${sel.dataset.route}`, { route: sel.value }); toast('Route saved.'); } catch (ex) { fail(ex); } }));
  const edForm = (e = {}) => formModal(e.id ? 'Edit edition' : 'New edition', [
    { name: 'format', label: 'Format', type: 'select', value: e.format || 'ebook', options: ['ebook', 'paperback', 'hardcover', 'large print', 'audiobook', 'spiral workbook', 'translation'].map((x) => [x, x]) },
    { name: 'language', label: 'Language', value: e.language || d.book.language || 'English' }, { name: 'isbn', label: 'ISBN (own ISBN from ISBN Canada puts the imprint on the listing)', value: e.isbn },
    { name: 'price', label: 'Base list price (USD)', type: 'number', step: '0.01', value: e.price }, { name: 'trim', label: 'Trim', value: e.trim },
    { name: 'printCost', label: 'Printing cost per copy (USD, print only)', type: 'number', step: '0.01', value: e.print_cost },
    { name: 'fileSizeMb', label: 'Ebook file size (MB, for delivery cost)', type: 'number', step: '0.1', value: e.file_size_mb },
  ]);
  actions(body, {
    generate: async () => { const x = await POST(`/api/books/${d.book.id}/rollout/generate`); toast(`${x.created} platforms added to the checklist.${x.note ? '\n' + x.note : ''}`); reload(); },
    'add-ed': async () => { const v = await edForm(); if (v) { await POST(`/api/books/${d.book.id}/editions`, v); reload(); } },
    'edit-ed': async (ds) => { const e = r.editions.find((x) => String(x.id) === ds.id); const v = await edForm(e); if (v) { await PUT(`/api/editions/${e.id}`, v); reload(); } },
    'del-ed': async (ds) => { if (await confirmModal('Delete this edition and all its platform rows?', 'Delete')) { await DEL(`/api/editions/${ds.id}`); reload(); } },
    'add-platform': async (ds) => { const store = $(`[data-add="${ds.ed}"]`, body).value; await POST(`/api/books/${d.book.id}/listings`, { editionId: ds.ed, store }); reload(); },
    quick: async (ds) => {
      const l = byId(ds.id);
      if (ds.s === 'live') {
        const v = await formModal(`${l.store} is live`, [{ name: 'liveLink', label: 'Store link', value: l.live_link }, { name: 'asin', label: l.store === 'KDP' ? 'ASIN' : 'Store ID (optional)', value: l.asin }, { name: 'date', label: 'Live since', type: 'date', value: today() }], { submit: 'Mark live' });
        if (!v) return;
        await POST(`/api/listings/${l.id}/status`, { status: l.preorder ? 'pre-order' : 'live', ...v });
      } else {
        await POST(`/api/listings/${l.id}/status`, { status: ds.s });
      }
      reload();
    },
    status: async (ds) => {
      const l = byId(ds.id);
      const v = await formModal(`${l.store} — ${l.format}`, [
        { name: 'status', label: 'Status', type: 'select', value: l.status, options: r.statuses.map((s) => [s, L[s]]) },
        { name: 'date', label: 'Date', type: 'date', value: today() },
        { name: 'reason', label: 'Reason (needed for rejected; useful for delisted / not applicable)', value: l.reason },
        { name: 'liveLink', label: 'Store link', value: l.live_link }, { name: 'asin', label: 'ASIN / store ID', value: l.asin },
        { name: 'price', label: 'Price', type: 'number', step: '0.01', value: l.price }, { name: 'currency', label: 'Currency', value: l.currency || 'USD' },
        { name: 'preorder', label: 'Pre-order', type: 'checkbox', value: !!l.preorder }, { name: 'releaseDate', label: 'Release date', type: 'date', value: l.release_date },
        ...(l.store === 'KDP' && l.format === 'ebook' ? [{ name: 'kdpSelect', label: 'Enrolled in KDP Select (90-day exclusivity)', type: 'checkbox', value: !!l.kdp_select }, { name: 'kdpSelectEnd', label: 'Select term ends', type: 'date', value: l.kdp_select_end }] : []),
        { name: 'aiDisclosure', label: 'AI disclosure given at upload', value: l.ai_disclosure }, { name: 'notes', label: 'Notes', type: 'textarea', rows: 3, value: l.notes },
      ], { wide: true });
      if (!v) return;
      const { status, date, reason, liveLink, asin, kdpSelect, kdpSelectEnd, ...rest } = v;
      if (l.store === 'KDP' && kdpSelect !== undefined) await POST(`/api/books/${d.book.id}/listings`, { editionId: l.edition_id, store: 'KDP', kdpSelect, kdpSelectEnd });
      await PUT(`/api/listings/${l.id}`, { ...rest, liveLink, asin, reason });
      if (status !== l.status) await POST(`/api/listings/${l.id}/status`, { status, date, reason, liveLink, asin });
      toast('Saved.'); reload();
    },
    check: async (ds) => { const x = await POST(`/api/listings/${ds.id}/check`); toast(x.detail, !x.live); reload(); },
  });
};

// ---- Launch ----
TAB_RENDER.launch = async (d, body) => {
  const open = d.tasks.filter((t) => !t.done), done = d.tasks.filter((t) => t.done);
  body.innerHTML = `<div class="card"><div class="toolbar"><label style="margin:0">Launch date <input id="ln-date" type="date" value="${esc(d.book.launch_date || '')}"></label><button class="btn primary" data-act="plan">Plan launch</button><button class="btn" data-act="add-task">+ Task</button></div>
    <p class="muted small">Creates the imprint’s launch calendar (pre-order and platform setup, ARCs, endorsements, pitches, content, launch week, 30/60/90 days), schedules backlist check-ins and — with automation on — drafts the content kit two weeks out and schedules approved posts one week out.</p></div>
    <h3>Open tasks (${open.length})</h3>${taskList(open)}
    ${done.length ? `<h3>Done (${done.length})</h3>${taskList(done)}` : ''}`;
  $$('[data-task]', body).forEach((el) => el.addEventListener('change', async () => { await POST(`/api/tasks/${el.dataset.task}/done`, { done: el.checked }); reload(); }));
  actions(body, {
    plan: async () => { const r = await POST(`/api/books/${d.book.id}/launch`, { launchDate: $('#ln-date').value }); toast(`Launch planned: ${r.made.length} new tasks${r.automated?.length ? `, ${r.automated.length} automated steps queued` : ''}.`); reload(); },
    'add-task': async () => { const v = await formModal('New task', [{ name: 'title', label: 'Task', required: true }, { name: 'owner', label: 'Owner' }, { name: 'dueDate', label: 'Due', type: 'date' }]); if (v) { await POST('/api/tasks', { bookId: d.book.id, ...v }); reload(); } },
    'del-task': async (ds) => { await DEL(`/api/tasks/${ds.id}`); reload(); },
    'edit-task': async (ds) => { const t = d.tasks.find((x) => String(x.id) === ds.id); const v = await formModal('Edit task', [{ name: 'title', label: 'Task', value: t.title }, { name: 'owner', label: 'Owner', value: t.owner }, { name: 'dueDate', label: 'Due', type: 'date', value: t.due_date }]); if (v) { await PUT(`/api/tasks/${t.id}`, v); reload(); } },
  });
};
function taskList(tasks) {
  return `<div class="table-wrap"><table><tr><th></th><th>Task</th><th>Due</th><th>Owner</th><th></th></tr>${tasks.map((t) => `<tr><td><input type="checkbox" data-task="${t.id}" ${t.done ? 'checked' : ''}></td><td>${esc(t.title)}</td><td class="small">${esc(t.due_date || '')} ${!t.done && t.due_date && t.due_date < today() ? '<span class="badge red">overdue</span>' : ''}</td><td class="small">${esc(t.owner || '')}</td><td><button class="btn small" data-act="edit-task" data-id="${t.id}">Edit</button> <button class="btn small danger" data-act="del-task" data-id="${t.id}">×</button></td></tr>`).join('') || '<tr><td colspan="5" class="muted">None.</td></tr>'}</table></div>`;
}

// ---- Content studio ----
TAB_RENDER.content = async (d, body) => {
  const types = d.contentTypes;
  const latest = {};
  for (const c of d.content) { const k = `${c.type}|${c.lang}`; if (!latest[k]) latest[k] = c; }
  body.innerHTML = `<div class="card"><div class="toolbar">
      <button class="btn primary" data-act="kit">Generate launch kit (${d.kitTypes.length} pieces)</button>
      <button class="btn" data-act="pick">Generate selected…</button>
      <button class="btn" data-act="image">Social image</button></div>
    <div class="toolbar"><span class="small muted">Quick:</span>
      <button class="btn small" data-act="quick" data-types="reader_profile,positioning" title="Do this first — every other piece uses it">1. Reader profile + positioning</button>
      <button class="btn small" data-act="quick" data-types="description_ab,kdp_keywords,categories">2. Listing: description A/B, keywords, categories</button>
      <button class="btn small" data-act="quick" data-types="repurpose_30,reader_magnet">3. 30-day plan + reader magnet</button>
      <button class="btn small" data-act="quick" data-types="social_proof,promo_sites">4. Social proof + promo sites</button>
      <button class="btn small" data-act="quick" data-types="competitor_teardown,ads_analysis">5. Competitor teardown + ad check</button></div>
    <p class="muted small">Every piece is a draft until approved; versions are kept. Only approved pieces can be scheduled or posted. Channels follow the imprint rules (${esc(d.channels.map((c) => c.platform).join(', '))}).</p></div>
    ${Object.values(latest).map((c) => `<div class="card" style="margin-top:.6rem"><div class="row-between"><strong>${esc(CONTENT_LABELS[c.type] || c.type)} ${c.lang !== 'English' ? `· ${esc(c.lang)}` : ''} · v${c.version}</strong>
      <span>${c.approved ? badge('approved') : badge('draft')} <span class="small muted">${esc(String(c.provider || '').replace(/\s*job:\d+/, ''))}</span></span></div>
      <div class="pre">${esc(c.text)}</div>
      <div class="toolbar">${c.approved ? `<button class="btn small" data-act="unapprove" data-id="${c.id}">Unapprove</button>` : `<button class="btn small primary" data-act="approve" data-id="${c.id}">Approve</button>`}<button class="btn small" data-act="edit" data-id="${c.id}">Edit</button><button class="btn small" data-act="copy" data-id="${c.id}">Copy</button><button class="btn small" data-act="regen" data-type="${c.type}" data-lang="${esc(c.lang)}">Regenerate</button>
      ${['social', 'email', 'linkedin', 'newsletter', 'repurpose_30'].includes(c.type) && c.approved ? `<button class="btn small" data-act="schedule" data-id="${c.id}">Schedule…</button>` : ''}
      ${d.content.filter((x) => x.type === c.type && x.lang === c.lang).length > 1 ? `<button class="btn small" data-act="versions" data-type="${c.type}" data-lang="${esc(c.lang)}">Versions</button>` : ''}</div></div>`).join('') || '<p class="muted">No content yet — generate the launch kit.</p>'}`;
  const byId = (id) => d.content.find((x) => String(x.id) === String(id));
  actions(body, {
    kit: async () => { const r = await POST(`/api/books/${d.book.id}/content/generate`, { types: d.kitTypes }); toast(r.note || 'Generated.'); reload(); },
    pick: async () => {
      const v = await formModal('Generate content', [
        { name: 'types', label: 'Pieces', type: 'checkboxes', options: types.map((t) => [t, CONTENT_LABELS[t] || t]) },
        { name: 'lang', label: 'Language', value: 'English', help: 'Write in another language for that market' },
        { name: 'channel', label: 'Channel (optional)', type: 'select', options: [['', '—'], ...d.channels.map((c) => [c.platform, c.platform])] },
        { name: 'extra', label: 'Extra instructions (optional)', type: 'textarea', rows: 3 },
      ], { submit: 'Generate', wide: true });
      if (v && v.types.length) { const r = await POST(`/api/books/${d.book.id}/content/generate`, v); toast(r.note || `Generated ${r.made.length}.`); reload(); }
    },
    quick: async (ds) => { const r = await POST(`/api/books/${d.book.id}/content/generate`, { types: ds.types.split(',') }); toast(r.note || `Generated ${r.made.length}.`); reload(); },
    regen: async (ds) => { await POST(`/api/books/${d.book.id}/content/generate`, { types: [ds.type], lang: ds.lang }); toast('New version added.'); reload(); },
    approve: async (ds) => { await POST(`/api/content/${ds.id}/approve`); reload(); },
    unapprove: async (ds) => { await POST(`/api/content/${ds.id}/unapprove`); reload(); },
    copy: async (ds) => copyText(byId(ds.id).text),
    edit: async (ds) => { const c = byId(ds.id); const v = await formModal(`Edit ${CONTENT_LABELS[c.type] || c.type}`, [{ name: 'text', label: 'Text (saved as a new version)', type: 'textarea', rows: 18, value: c.text }], { wide: true }); if (v) { await PUT(`/api/content/${c.id}`, { text: v.text }); reload(); } },
    versions: async (ds) => { const vs = d.content.filter((x) => x.type === ds.type && x.lang === ds.lang); showModal(`<h3>Versions</h3>${vs.map((c) => `<h4>v${c.version} ${c.approved ? badge('approved') : ''} <span class="muted small">${esc(c.created_at)}</span></h4><div class="pre">${esc(c.text)}</div>`).join('')}<button class="btn" data-close>Close</button>`, true); },
    schedule: async (ds) => scheduleContent(d, byId(ds.id)),
    image: async () => {
      const v = await formModal('Social image', [{ name: 'size', label: 'Size', type: 'select', options: [['1200x628', 'Link post 1200×628'], ['1080x1080', 'Square 1080×1080'], ['1080x1920', 'Story/Reel 1080×1920']] }, { name: 'useAi', label: 'Use Ideogram/OpenAI if connected', type: 'checkbox', value: true }, { name: 'prompt', label: 'Image prompt (optional)', type: 'textarea', rows: 3 }], { submit: 'Make image' });
      if (!v) return;
      const r = await POST(`/api/books/${d.book.id}/social-image`, v);
      if (r.svg) {
        const url = URL.createObjectURL(new Blob([r.svg], { type: 'image/svg+xml' }));
        showModal(`<h3>Social image (typographic template)</h3><img src="${url}" style="max-width:100%;border:1px solid var(--line)"><p class="muted small">${esc(r.note || '')}</p><div class="toolbar"><a class="btn" href="${url}" download="social-${esc(d.book.slug)}.svg">Download SVG</a><button class="btn" data-close>Close</button></div>`, true);
      } else {
        const src = r.url || `data:image/png;base64,${r.b64}`;
        showModal(`<h3>Social image (${esc(r.provider)})</h3><img src="${esc(src)}" style="max-width:100%"><div class="toolbar"><a class="btn" href="${esc(src)}" download="social-${esc(d.book.slug)}.png" target="_blank" rel="noopener">Open / download</a><button class="btn" data-close>Close</button></div>`, true);
      }
    },
  });
};

async function scheduleContent(d, c) {
  const pieces = c.type === 'social' ? splitPosts(c.text) : c.type === 'repurpose_30' ? c.text.split(/\n(?=\s*\**Day \d+)/).map((x) => x.trim()).filter((x) => /^\**Day \d+/.test(x)) : c.type === 'email' ? c.text.split(/\n\s*---\s*\n/) : [c.text];
  const v = await formModal(`Schedule ${CONTENT_LABELS[c.type] || c.type}`, [
    { name: 'index', label: 'Which piece', type: 'select', options: pieces.map((p, i) => [i, `${i + 1}. ${p.slice(0, 70)}…`]) },
    { name: 'channel', label: 'Channel', type: 'select', options: d.channels.map((ch) => [ch.platform, ch.platform]) },
    { name: 'scheduledAt', label: 'When (your local time)', type: 'datetime-local', required: true },
    { name: 'imageUrl', label: 'Image URL (needed for Instagram)', placeholder: 'https://…' },
  ], { submit: 'Schedule' });
  if (!v) return;
  const utc = new Date(v.scheduledAt).toISOString().slice(0, 16);
  try { await POST(`/api/books/${d.book.id}/posts`, { contentId: c.id, channel: v.channel, scheduledAt: utc, index: Number(v.index), imageUrl: v.imageUrl }); toast('Scheduled.'); } catch (ex) { fail(ex); }
}
function splitPosts(t) { const parts = String(t).split(/\n\s*(?=\d{1,2}[.)]\s)/).map((p) => p.replace(/^\s*\d{1,2}[.)]\s*/, '').trim()).filter(Boolean); return parts.length > 1 ? parts : [t]; }

// ---- Book calendar ----
TAB_RENDER.calendar = async (d, body) => {
  const { posts } = await api(`/api/books/${d.book.id}/posts`);
  body.innerHTML = `<div class="card"><div class="toolbar"><label style="margin:0">Start <input type="date" id="auto-start" value="${esc(d.book.launch_date || today())}"></label><button class="btn primary" data-act="auto">Auto-schedule approved content</button></div>
    <p class="muted small">Spreads the approved social posts across ${esc(d.channels.filter((c) => !/email|website/i.test(c.platform)).map((c) => c.platform).join(', ') || 'the imprint channels')} from 3 days before to 4 weeks after the start, the email sequence on days 0/3/7, and the LinkedIn article on day 1 — each with a tracked smart link. Never double-schedules.</p></div>
    ${postList(posts)}`;
  actions(body, { auto: async () => { const r = await POST(`/api/books/${d.book.id}/posts/auto`, { startDate: $('#auto-start').value }); toast(r.scheduled ? `${r.scheduled} posts scheduled.` : r.note); reload(); }, ...postActions(posts, reload) });
};
function postList(posts, withTitle = false) {
  if (!posts.length) return '<p class="muted">Nothing scheduled.</p>';
  const byDay = {};
  for (const p of posts) (byDay[p.scheduled_at.slice(0, 10)] = byDay[p.scheduled_at.slice(0, 10)] || []).push(p);
  return Object.entries(byDay).map(([day, ps]) => `<div class="cal-day"><div class="d">${esc(new Date(day + 'T12:00:00Z').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }))}</div><div>${ps.map((p) => `<div class="post"><div class="meta">${badge(p.status)} <strong>${esc(p.channel)}</strong> · ${esc(new Date(p.scheduled_at.replace(' ', 'T') + 'Z').toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }))}${withTitle ? ` · ${esc(p.title)}` : ''}${p.error ? ` <span class="muted">${esc(p.error)}</span>` : ''}</div><div class="txt">${esc(p.text)}</div>
    <div class="toolbar">${['scheduled', 'manual', 'failed'].includes(p.status) ? `<button class="btn small" data-act="post-edit" data-id="${p.id}">Edit</button><button class="btn small" data-act="post-now" data-id="${p.id}">Post now</button><button class="btn small" data-act="post-done" data-id="${p.id}">Mark posted</button><button class="btn small danger" data-act="post-cancel" data-id="${p.id}">Cancel</button>` : ''}<button class="btn small" data-act="post-copy" data-id="${p.id}">Copy</button></div></div>`).join('')}</div></div>`).join('');
}
function postActions(posts, after) {
  const byId = (id) => posts.find((p) => String(p.id) === String(id));
  return {
    'post-edit': async (ds) => { const p = byId(ds.id); const local = new Date(p.scheduled_at.replace(' ', 'T') + 'Z'); const v = await formModal('Edit post', [{ name: 'text', label: 'Text', type: 'textarea', rows: 8, value: p.text }, { name: 'when', label: 'When (your local time)', type: 'datetime-local', value: new Date(local.getTime() - local.getTimezoneOffset() * 60000).toISOString().slice(0, 16) }, { name: 'imageUrl', label: 'Image URL', value: p.image_url }]); if (v) { await PUT(`/api/posts/${p.id}`, { text: v.text, scheduledAt: new Date(v.when).toISOString().slice(0, 16), imageUrl: v.imageUrl, reschedule: true }); after(); } },
    'post-now': async (ds) => { const r = await POST(`/api/posts/${ds.id}/publish-now`); toast(r.status === 'posted' ? 'Posted.' : r.error, r.status !== 'posted'); after(); },
    'post-done': async (ds) => { await POST(`/api/posts/${ds.id}/posted`); after(); },
    'post-cancel': async (ds) => { await DEL(`/api/posts/${ds.id}`); after(); },
    'post-copy': async (ds) => copyText(byId(ds.id).text),
  };
}

// ---- Links & book page ----
TAB_RENDER.links = async (d, body) => {
  const l = await api(`/api/books/${d.book.id}/links`);
  body.innerHTML = `<div class="two-col"><div>
      <h3>Smart link</h3><div class="card small"><p>One link for every channel. Each reader goes to their own Amazon store (amazon.de for Germany, amazon.co.jp for Japan …) once the KDP listing has an ASIN; <code>?s=kobo</code>, <code>?s=apple-books</code> … send to a specific store. Every click is counted by channel and country.</p>
        <div class="toolbar"><code>${esc(l.smartLink)}</code><button class="btn small" data-act="copy" data-v="${esc(l.smartLink)}">Copy</button></div></div>
      <h3>Tracked links per channel</h3><div class="table-wrap"><table>${l.channelLinks.map((c) => `<tr><td>${esc(c.channel)}</td><td class="small"><code>${esc(c.url)}</code></td><td><button class="btn small" data-act="copy" data-v="${esc(c.url)}">Copy</button></td></tr>`).join('')}</table></div>
      <h3>Book page</h3><div class="card small"><p>A public page with the cover, description (in the reader’s language when an approved localized version exists), buy buttons for every live store, endorsements and the free-chapter signup (double opt-in). Includes Book schema for search engines.</p>
        <div class="toolbar"><a class="btn" href="${esc(l.bookPage)}" target="_blank" rel="noopener">Open page</a><button class="btn small" data-act="copy" data-v="${esc(l.bookPage)}">Copy</button>${d.book.landing_enabled ? '' : '<span class="badge red">turned off</span>'}</div></div>
    </div><div>
      <h3>Clicks, last 30 days <span class="muted small">(${num(l.total)} all time)</span></h3><div id="clicks-daily" class="card chart-card"></div>
      <h3>By channel</h3><div id="clicks-channel" class="card chart-card"></div>
      <h3>By country</h3><div id="clicks-country" class="card chart-card"></div>
    </div></div>`;
  const dayMap = Object.fromEntries(l.daily.map((x) => [x.day, x.n]));
  const days = Array.from({ length: 30 }, (_, i) => new Date(Date.now() - (29 - i) * 864e5).toISOString().slice(0, 10));
  Charts.columns($('#clicks-daily'), days.map((d0) => ({ label: d0.slice(5), value: dayMap[d0] || 0 })), { height: 160, integer: true });
  Charts.bars($('#clicks-channel'), l.byChannel.map((x) => ({ label: x.k || '(direct)', value: x.n })));
  Charts.bars($('#clicks-country'), l.byCountry.map((x) => ({ label: x.k || '?', value: x.n })));
  actions(body, { copy: async (ds) => copyText(ds.v) });
};

// ---- ARC & reviews ----
TAB_RENDER.arc = async (d, body) => {
  const { contacts } = await api('/api/contacts');
  const arcReaders = contacts.filter((c) => ['reader', 'arc'].includes(c.type) && c.consent && c.status === 'confirmed' && c.email);
  body.innerHTML = `<div class="two-col"><div>
    <h3>ARC campaigns</h3><div class="toolbar"><button class="btn primary" data-act="new-arc">+ ARC campaign</button><button class="btn" data-act="send-arc">Email ARC readers…</button></div>
    ${d.campaigns.filter((c) => c.type !== 'launch').map((c) => `<div class="card small" style="margin-bottom:.5rem"><strong>${esc(c.name)}</strong> (${esc(c.type)} · ${esc(c.platform || '')}) ${badge(c.status)}<br><span class="muted">${esc(c.start_date || '')} → ${esc(c.end_date || '')} · spend ${money(c.spend)} / budget ${money(c.budget)} ${esc(c.result || '')}</span><div class="toolbar"><button class="btn small" data-act="edit-camp" data-id="${c.id}">Update / lesson</button></div></div>`).join('') || '<p class="muted small">No campaigns yet.</p>'}
    <p class="muted small">ARC readers who got an email but haven’t reviewed get a gentle reminder on day 7 and a last one on day 14 (Settings → Automation decides: off, task, or send). Every ARC email asks readers to mention they got a free copy.</p>
  </div><div>
    <h3>Reviews</h3><div class="toolbar"><button class="btn" data-act="add-review">+ Add review</button></div>
    ${d.reviews.map((r) => `<div class="card small" style="margin-bottom:.5rem">${'★'.repeat(r.rating)}${'☆'.repeat(5 - r.rating)} ${esc(r.store || '')} · ${esc(r.date)} ${r.type !== 'customer' ? badge(r.type) : ''} ${r.needs_reply ? '<span class="badge red">reply needed</span>' : ''}<div>${esc(r.text || '')}</div>${r.reply_draft ? `<div class="pre">${esc(r.reply_draft)}</div>` : ''}
      <div class="toolbar"><button class="btn small" data-act="reply" data-id="${r.id}">Draft reply</button>${r.needs_reply ? `<button class="btn small" data-act="replied" data-id="${r.id}">Mark replied</button>` : ''}</div></div>`).join('') || '<p class="muted small">No reviews recorded.</p>'}
  </div></div>`;
  actions(body, {
    'new-arc': async () => {
      const v = await formModal('ARC campaign', [{ name: 'name', label: 'Name', required: true, placeholder: 'BookSirens ARC — launch' }, { name: 'platform', label: 'Platform', type: 'select', options: ['Own list', 'BookSirens', 'BookSprout', 'StoryOrigin', 'NetGalley', 'Other'].map((x) => [x, x]) }, { name: 'startDate', label: 'Start', type: 'date' }, { name: 'endDate', label: 'End', type: 'date' }, { name: 'budget', label: 'Budget (USD)', type: 'number', step: '0.01' }, { name: 'ok', label: 'I confirm: no paid customer reviews and no review swaps — reviews are honest and unpaid.', type: 'checkbox' }]);
      if (!v) return;
      await POST(`/api/books/${d.book.id}/campaigns`, { ...v, type: 'arc', reviewPolicyConfirmed: v.ok }); reload();
    },
    'send-arc': async () => {
      if (!arcReaders.length) return toast('No confirmed, consenting readers with an email yet — add them in Contacts.', true);
      const draft = await POST(`/api/books/${d.book.id}/arc-email`, {});
      const v = await formModal('Email ARC readers', [
        { name: 'ids', label: 'Readers (consent recorded)', type: 'checkboxes', options: arcReaders.map((c) => [String(c.id), `${c.name} <${c.email}>`]) },
        { name: 'subject', label: 'Subject', value: `Advance copy: ${d.book.title}` },
        { name: 'body', label: 'Email ([NAME] is replaced per reader)', type: 'textarea', rows: 12, value: draft.draft },
      ], { submit: 'Send', wide: true, note: draft.local ? 'This is a placeholder draft — write the email (or connect an AI key) before sending.' : '' });
      if (!v) return;
      const r = await POST(`/api/books/${d.book.id}/arc-send`, { contactIds: v.ids.map(Number), subject: v.subject, body: v.body });
      toast(`Sent ${r.sent.length}${r.failed.length ? `, failed ${r.failed.length}: ${r.failed.map((f) => f.error).join('; ')}` : ''}.`, !!r.failed.length);
    },
    'edit-camp': async (ds) => { const c = d.campaigns.find((x) => String(x.id) === ds.id); const v = await formModal('Update campaign', [{ name: 'status', label: 'Status', type: 'select', value: c.status, options: [['active', 'active'], ['done', 'done']] }, { name: 'spend', label: 'Spend', type: 'number', step: '0.01', value: c.spend }, { name: 'result', label: 'Result', value: c.result }, { name: 'lesson', label: 'Lesson learned (goes to Kaizen)', type: 'textarea', rows: 3 }]); if (v) { await PUT(`/api/campaigns/${c.id}`, v); reload(); } },
    'add-review': async () => { const v = await formModal('Add review', [{ name: 'store', label: 'Store', value: 'Amazon' }, { name: 'rating', label: 'Rating (1–5)', type: 'number', required: true }, { name: 'type', label: 'Type', type: 'select', options: [['customer', 'Customer'], ['arc', 'ARC reader'], ['editorial', 'Editorial (Kirkus etc.)']] }, { name: 'contactId', label: 'From contact (marks the ARC as reviewed)', type: 'select', options: [['', '—'], ...arcReaders.map((c) => [c.id, c.name])] }, { name: 'text', label: 'Text', type: 'textarea', rows: 4 }, { name: 'link', label: 'Link' }, { name: 'date', label: 'Date', type: 'date', value: today() }]); if (v) { await POST(`/api/books/${d.book.id}/reviews`, { ...v, contactId: v.contactId || null }); reload(); } },
    reply: async (ds) => { await POST(`/api/reviews/${ds.id}/reply-draft`); reload(); },
    replied: async (ds) => { await POST(`/api/reviews/${ds.id}/replied`); reload(); },
  });
};

// ---- Outreach: endorsements + pitches ----
TAB_RENDER.outreach = async (d, body) => {
  const [{ pitches }, { contacts }] = await Promise.all([api(`/api/books/${d.book.id}/pitches`), api('/api/contacts')]);
  body.innerHTML = `<h3>Media, podcast, library and bookstore pitches</h3>
    <div class="toolbar"><button class="btn primary" data-act="new-pitch">+ Pitch</button></div>
    <div class="table-wrap"><table><tr><th>Type</th><th>Outlet / contact</th><th>Angle</th><th>Status</th><th>Sent / follow-up</th><th></th></tr>
    ${pitches.map((p) => `<tr><td>${esc(p.kind)}</td><td>${esc(p.outlet)}${p.contact_name ? `<br><span class="small muted">${esc(p.contact_name)} ${esc(p.contact_email || '')}</span>` : ''}</td><td class="small">${esc(p.angle || '')}</td><td>${badge(p.status)}</td><td class="small">${esc(p.sent_at || '')}${p.followup_due ? ` → ${esc(p.followup_due)}` : ''}</td>
      <td><button class="btn small" data-act="draft" data-id="${p.id}">${p.draft ? 'Redraft' : 'Draft'}</button> ${p.draft ? `<button class="btn small" data-act="send" data-id="${p.id}">Review & send</button>` : ''} <button class="btn small" data-act="result" data-id="${p.id}">Result</button> <button class="btn small danger" data-act="del-pitch" data-id="${p.id}">×</button></td></tr>`).join('') || '<tr><td colspan="6" class="muted">No pitches yet. Add podcasts, media, libraries and bookstores in Contacts, then pitch them here.</td></tr>'}</table></div>
    <h3>Endorsements</h3><div class="toolbar"><button class="btn" data-act="add-end">+ Endorsement</button><button class="btn" data-act="end-email">Draft a request</button></div>
    ${d.endorsements.map((e) => `<div class="card small" style="margin-bottom:.5rem">${badge(e.status)} <strong>${esc(e.contact_name || '')}</strong> ${e.permission ? '<span class="badge green">permission to use</span>' : ''} ${esc(e.where_used || '')}<div>${esc(e.quote || '(no quote yet)')}</div><div class="toolbar"><button class="btn small" data-act="edit-end" data-id="${e.id}">Edit</button></div></div>`).join('') || '<p class="muted small">No endorsements yet.</p>'}`;
  const contactOpts = (types) => [['', '—'], ...contacts.filter((c) => !types || types.includes(c.type)).map((c) => [c.id, `${c.name}${c.outlet ? ` (${c.outlet})` : ''} · ${c.type}`])];
  const endForm = (e = {}) => formModal('Endorsement', [{ name: 'contactId', label: 'From', type: 'select', value: e.contact_id, options: contactOpts(['endorser', 'media', 'podcast']) }, { name: 'status', label: 'Status', type: 'select', value: e.status || 'requested', options: ['requested', 'follow-up', 'received', 'declined'].map((x) => [x, x]) }, { name: 'quote', label: 'Quote', type: 'textarea', rows: 4, value: e.quote }, { name: 'permission', label: 'Permission to print (cover, page, ads)', type: 'checkbox', value: !!e.permission }, { name: 'whereUsed', label: 'Where used', value: e.where_used }]);
  actions(body, {
    'new-pitch': async () => { const v = await formModal('New pitch', [{ name: 'kind', label: 'Type', type: 'select', options: [['podcast', 'Podcast'], ['media', 'Media / press'], ['blog', 'Blog / newsletter'], ['library', 'Library'], ['bookstore', 'Bookstore']] }, { name: 'contactId', label: 'Contact', type: 'select', options: contactOpts() }, { name: 'outlet', label: 'Outlet / show (if no contact)' }, { name: 'angle', label: 'Angle', type: 'textarea', rows: 3 }]); if (v) { await POST(`/api/books/${d.book.id}/pitches`, { ...v, contactId: v.contactId || null }); reload(); } },
    draft: async (ds) => { const r = await POST(`/api/pitches/${ds.id}/draft`); if (r.local) toast('Placeholder draft — connect an AI key for a real pitch.', true); reload(); },
    send: async (ds) => {
      const p = pitches.find((x) => String(x.id) === ds.id);
      const v = await formModal(`Pitch to ${p.outlet}`, [{ name: 'draft', label: 'Email (first line “Subject: …”)', type: 'textarea', rows: 14, value: p.draft }, { name: 'how', label: 'How', type: 'select', options: [['send', p.contact_email ? `Send from the app to ${p.contact_email} (Gmail first)` : 'Send from the app (needs a contact email)'], ['manual', 'I sent it myself — just mark sent']] }], { submit: 'Go', wide: true });
      if (!v) return;
      if (v.how === 'manual') { await PUT(`/api/pitches/${p.id}`, { draft: v.draft }); await POST(`/api/pitches/${p.id}/mark-sent`); } else { const r = await POST(`/api/pitches/${p.id}/send`, { draft: v.draft }); toast(`Sent via ${r.provider}. Follow-up in 10 days.`); }
      reload();
    },
    result: async (ds) => { const p = pitches.find((x) => String(x.id) === ds.id); const v = await formModal('Pitch result', [{ name: 'status', label: 'Status', type: 'select', value: p.status, options: ['idea', 'drafted', 'sent', 'follow-up due', 'booked', 'published', 'declined', 'no answer'].map((x) => [x, x]) }, { name: 'result', label: 'Result / notes', type: 'textarea', rows: 3, value: p.result }]); if (v) { await PUT(`/api/pitches/${p.id}`, v); reload(); } },
    'del-pitch': async (ds) => { await DEL(`/api/pitches/${ds.id}`); reload(); },
    'add-end': async () => { const v = await endForm(); if (v) { await POST(`/api/books/${d.book.id}/endorsements`, { ...v, contactId: v.contactId || null }); reload(); } },
    'edit-end': async (ds) => { const e = d.endorsements.find((x) => String(x.id) === ds.id); const v = await endForm(e); if (v) { await PUT(`/api/endorsements/${e.id}`, { ...v, contactId: v.contactId || null }); reload(); } },
    'end-email': async () => { const v = await formModal('Endorsement request', [{ name: 'contactId', label: 'To', type: 'select', options: contactOpts() }], { submit: 'Draft' }); if (!v) return; const r = await POST(`/api/books/${d.book.id}/endorsement-email`, { contactId: v.contactId || null }); showModal(`<h3>Endorsement request</h3><div class="pre">${esc(r.draft)}</div><div class="toolbar"><button class="btn" id="cp">Copy</button><button class="btn" data-close>Close</button></div>`, true); $('#cp').addEventListener('click', () => copyText(r.draft)); },
  });
};

// ---- Promotions & ads ----
TAB_RENDER.promo = async (d, body) => {
  const [roi, ps] = await Promise.all([api(`/api/books/${d.book.id}/ads-roi`), api(`/api/books/${d.book.id}/paid-services`)]);
  body.innerHTML = `<h3>Paid services</h3><p class="muted small">Use these once a book shows demand; prices change often, so check each before buying. Costs count in the book’s margin; results become Kaizen lessons.</p>
    <div class="toolbar"><button class="btn" data-act="add-paid">+ Paid service</button></div>
    <div class="table-wrap"><table><tr><th>Service</th><th>Status</th><th>Applied</th><th>Runs</th><th class="num">Cost</th><th>Result</th><th></th></tr>${ps.services.map((x) => `<tr><td>${esc(x.service)}<div class="small muted">${esc(x.notes || '')}</div></td><td>${badge(x.status)}</td><td class="small">${esc(x.applied_at)}</td><td class="small">${esc(x.run_date)}</td><td class="num">${money(x.cost, x.currency)}</td><td class="small">${esc(x.result)}</td><td><button class="btn small" data-act="edit-paid" data-id="${x.id}">Update</button> <button class="btn small danger" data-act="del-paid" data-id="${x.id}">×</button></td></tr>`).join('') || '<tr><td colspan="7" class="muted">None yet.</td></tr>'}</table></div>
    <h3>Promotions</h3><div class="toolbar"><button class="btn" data-act="add-promo">+ Promotion</button></div>
    <div class="table-wrap"><table><tr><th>Type</th><th>Detail</th><th>Dates</th><th class="num">Spend</th><th class="num">Units</th><th class="num">Royalty</th></tr>${d.promotions.map((p) => `<tr><td>${esc(p.type)}</td><td>${esc(p.detail)}</td><td class="small">${esc(p.start_date)} → ${esc(p.end_date)}</td><td class="num">${money(p.spend)}</td><td class="num">${num(p.result_units)}</td><td class="num">${money(p.result_royalty)}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">None yet.</td></tr>'}</table></div>
    <h3>Ads</h3><div class="toolbar"><button class="btn" data-act="add-ad">+ Ad row</button><label class="btn" style="margin:0">Import Amazon/Meta ads report (CSV/XLSX)<input type="file" id="ads-file" accept=".csv,.xlsx,.tsv" class="hidden"></label></div>
    <div class="table-wrap"><table><tr><th>Platform</th><th>Campaign</th><th>Period</th><th class="num">Spend</th><th class="num">Sales</th><th class="num">ACOS</th><th class="num">ROAS</th><th class="num">CTR</th><th class="num">CPC</th><th>Verdict</th></tr>${roi.ads.map((a) => `<tr><td>${esc(a.platform)}</td><td>${esc(a.campaign_name)}</td><td class="small">${esc(a.period)}</td><td class="num">${money(a.spend, a.currency)}</td><td class="num">${money(a.sales, a.currency)}</td><td class="num">${a.acos ?? '—'}${a.acos != null ? '%' : ''}</td><td class="num">${a.roas ?? '—'}</td><td class="num">${a.ctr ?? '—'}${a.ctr != null ? '%' : ''}</td><td class="num">${a.cpc != null ? money(a.cpc, a.currency) : '—'}</td><td class="small">${esc(a.verdict || '')}</td></tr>`).join('') || '<tr><td colspan="10" class="muted">No ads yet.</td></tr>'}</table></div>
    <p class="small"><strong>Break-even ACOS: ${roi.breakEven.breakEvenAcos != null ? roi.breakEven.breakEvenAcos + '%' : '— (add a price on Editions)'}</strong> <span class="muted">— royalty per sale $${roi.breakEven.royaltyPerSale} ÷ price $${roi.breakEven.avgPrice} (${esc(roi.breakEven.basis)}). Below it an ad makes money; above it, it costs money. Launch weeks may run above on purpose.</span></p>
    <div class="toolbar"><button class="btn" data-act="ad-check">Ad check with AI</button></div>
    <p class="muted small">Ad keyword lists, BookBub/Meta ad copy and short-video scripts are on the Content tab.</p>`;
  $('#ads-file').addEventListener('change', async (e) => { const f = e.target.files[0]; if (!f) return; try { const r = await POST(`/api/books/${d.book.id}/ads/import`, await fileBody(f)); toast(`Imported ${r.imported} ad rows.`); reload(); } catch (ex) { fail(ex); } });
  const paidForm = (x = {}) => formModal(x.id ? `Update ${x.service}` : 'Paid service', [
    ...(x.id ? [] : [{ name: 'service', label: 'Service', type: 'select', options: ps.catalog.map((c) => [c.name, `${c.name} — ${c.what}`]) }]),
    { name: 'status', label: 'Status', type: 'select', value: x.status || 'planned', options: ps.statuses.map((s0) => [s0, s0]) },
    { name: 'appliedAt', label: 'Applied / booked', type: 'date', value: x.applied_at }, { name: 'runDate', label: 'Runs on', type: 'date', value: x.run_date },
    { name: 'cost', label: 'Cost', type: 'number', step: '0.01', value: x.cost }, { name: 'currency', label: 'Currency', value: x.currency || 'USD' },
    { name: 'result', label: 'Result (downloads, sales, reviews, quote)', type: 'textarea', rows: 3, value: x.result }, { name: 'notes', label: 'Notes', value: x.notes },
  ]);
  actions(body, {
    'add-paid': async () => { const v = await paidForm(); if (v) { await POST(`/api/books/${d.book.id}/paid-services`, v); reload(); } },
    'edit-paid': async (ds) => { const x = ps.services.find((y) => String(y.id) === ds.id); const v = await paidForm(x); if (v) { await PUT(`/api/paid-services/${x.id}`, v); reload(); } },
    'del-paid': async (ds) => { await DEL(`/api/paid-services/${ds.id}`); reload(); },
    'add-promo': async () => { const v = await formModal('Promotion', [{ name: 'type', label: 'Type', type: 'select', options: [['price', 'Price promotion'], ['countdown', 'Kindle Countdown Deal'], ['free', 'Free days (KDP Select)'], ['newsletter', 'Deal newsletter (BookBub etc.)'], ['other', 'Other']] }, { name: 'detail', label: 'Detail' }, { name: 'startDate', label: 'Start', type: 'date' }, { name: 'endDate', label: 'End', type: 'date' }, { name: 'spend', label: 'Spend (USD)', type: 'number', step: '0.01' }, { name: 'resultUnits', label: 'Units', type: 'number' }, { name: 'resultRoyalty', label: 'Royalty (USD)', type: 'number', step: '0.01' }]); if (v) { await POST(`/api/books/${d.book.id}/promotions`, v); reload(); } },
    'ad-check': async () => { const r = await POST(`/api/books/${d.book.id}/content/generate`, { types: ['ads_analysis'] }); const m = r.made[0]; toast(m.local ? 'Local draft — connect an AI provider for the full analysis.' : 'Ad check saved on the Content tab.'); const all = await api(`/api/books/${d.book.id}/content`); const c = (all.content || all).find((x) => x.id === m.id); if (c) showModal(`<h3>Ad check</h3><div class="pre">${esc(c.text)}</div><button class="btn" data-close>Close</button>`, true); },
    'add-ad': async () => { const v = await formModal('Ad results', [{ name: 'platform', label: 'Platform', type: 'select', options: ['Amazon Ads', 'Meta Ads', 'BookBub Ads', 'Google Ads', 'Other'].map((x) => [x, x]) }, { name: 'campaignName', label: 'Campaign' }, { name: 'period', label: 'Period (YYYY-MM)', value: today().slice(0, 7) }, { name: 'spend', label: 'Spend', type: 'number', step: '0.01' }, { name: 'sales', label: 'Sales', type: 'number', step: '0.01' }, { name: 'impressions', label: 'Impressions', type: 'number' }, { name: 'clicks', label: 'Clicks', type: 'number' }, { name: 'currency', label: 'Currency', value: 'USD' }]); if (v) { await POST(`/api/books/${d.book.id}/ads`, v); reload(); } },
  });
};

// ---- Bookstores & libraries ----
TAB_RENDER.bookstores = async (d, body) => {
  body.innerHTML = `<div class="two-col"><div>
    <h3>Consignments</h3><div class="toolbar"><button class="btn" data-act="add-cons">+ Consignment</button></div>
    <div class="table-wrap"><table><tr><th>Store</th><th class="num">Copies</th><th class="num">Sold</th><th class="num">Paid</th><th></th></tr>${d.consignments.map((c) => `<tr><td>${esc(c.store)}<div class="small muted">${esc(c.notes || '')}</div></td><td class="num">${c.copies}</td><td class="num">${c.sold}</td><td class="num">${money(c.paid)}</td><td><button class="btn small" data-act="edit-cons" data-id="${c.id}">Update</button></td></tr>`).join('') || '<tr><td colspan="5" class="muted">None.</td></tr>'}</table></div>
    <p class="small"><a class="btn" href="/api/books/${d.book.id}/sellsheet.pdf">Download sell sheet (PDF)</a></p>
    <p class="muted small">Trade terms via IngramSpark: 55% discount, returnable. Pitch libraries and bookstores from the Outreach tab.</p>
  </div><div>
    <h3>Library platforms</h3>
    <div class="card small">${(() => { const libs = d.editions.flatMap((e) => (e.listings || []).filter((l) => ['OverDrive / Libby', 'Hoopla', 'BorrowBox', 'cloudLibrary / Bibliotheca', 'Vivlio Libraries', 'Odilo', 'Everand'].includes(l.store)).map((l) => ({ ...l, format: e.format }))); return libs.length ? libs.map((l) => `<div>${esc(l.store)} (${esc(l.format)}, via ${esc(l.route || 'Direct')}) — ${badge(l.status)}</div>`).join('') : 'No library platforms on the checklist yet.'; })()}
      <p class="muted">Library status is tracked with every other platform on the <a href="#" data-act="go-publishing">Publishing</a> tab.</p></div>
  </div></div>`;
  actions(body, {
    'add-cons': async () => { const v = await formModal('Consignment', [{ name: 'store', label: 'Store', required: true }, { name: 'copies', label: 'Copies', type: 'number' }, { name: 'notes', label: 'Notes' }]); if (v) { await POST(`/api/books/${d.book.id}/consignments`, v); reload(); } },
    'edit-cons': async (ds) => { const c = d.consignments.find((x) => String(x.id) === ds.id); const v = await formModal('Update consignment', [{ name: 'copies', label: 'Copies', type: 'number', value: c.copies }, { name: 'sold', label: 'Sold', type: 'number', value: c.sold }, { name: 'paid', label: 'Paid (USD)', type: 'number', step: '0.01', value: c.paid }, { name: 'notes', label: 'Notes', value: c.notes }]); if (v) { await PUT(`/api/consignments/${c.id}`, v); reload(); } },
    'go-publishing': async () => openBook(d.book.id, 'publishing'),
    lib: async (ds) => { const v = await formModal(ds.p, [{ name: 'status', label: 'Status', type: 'select', options: ['not submitted', 'submitted', 'live', 'rejected'].map((x) => [x, x]) }, { name: 'notes', label: 'Notes' }]); if (v) { await POST(`/api/books/${d.book.id}/library`, { platform: ds.p, ...v }); reload(); } },
  });
};

// ---- Editions: audio + translation ----
TAB_RENDER.editions = async (d, body) => {
  const m = await api(`/api/books/${d.book.id}/editions-matrix`);
  const translations = d.editions.filter((e) => e.language && e.language !== (d.book.language || 'English'));
  const audioFiles = d.files.filter((f) => f.type === 'audio');
  body.innerHTML = `<p class="muted small">${esc(m.note)}</p>
    <div class="two-col"><div>
      <h3>Audio</h3><div class="table-wrap"><table><tr><th>Route</th><th>AI narration</th><th>Human</th></tr>${m.matrix.map((x) => `<tr><td>${esc(x.store)}</td><td class="small">${esc(x.aiNarration)}</td><td class="small">${esc(x.humanNarration)}</td></tr>`).join('')}</table></div>
      <div class="card" style="margin-top:.6rem"><div class="toolbar"><button class="btn primary" data-act="audiobook">Narrate the whole book (ElevenLabs)…</button><button class="btn" data-act="sample">Sample passage…</button></div>
        <p class="muted small">${d.chapters.length ? `${d.chapters.length} chapters ready.` : 'Upload the manuscript on the Overview tab first.'} Runs chapter by chapter in the background; budgets apply.</p>
        ${audioFiles.length ? `<div class="small">${audioFiles.map((f) => `<div><a href="/api/files/${f.id}/download">${esc(f.name)}</a> <span class="muted">${esc(f.licence_note)}</span></div>`).join('')}</div>` : ''}</div>
    </div><div>
      <h3>Translation</h3>${m.translation.map((t) => `<div class="card small" style="margin-bottom:.5rem"><strong>${esc(t.route)}</strong><div class="muted">${esc(t.note)}</div></div>`).join('')}
      <div class="toolbar"><button class="btn primary" data-act="translate-book">Translate the whole book…</button><button class="btn" data-act="translate-snippet">Translate a passage…</button></div>
      ${translations.map((e) => `<div class="card small" style="margin-bottom:.5rem"><strong>${esc(e.language)} ${esc(e.format)}</strong> ${badge(e.status || 'planned')} <span data-tr="${e.id}" class="muted"></span><div class="toolbar"><a class="btn small" href="/api/editions/${e.id}/translation.txt">Download text</a></div></div>`).join('')}
      ${d.book.imprintName.includes('Lamp') ? '<p class="note small">Faith books: scripture is never machine-translated — each verse is marked [VERIFY SCRIPTURE] for the established Bible translation in that language.</p>' : ''}
    </div></div>`;
  for (const e of translations) api(`/api/editions/${e.id}/translation`).then((t) => { const el = $(`[data-tr="${e.id}"]`); if (el) el.textContent = `${t.chapters.length}/${t.total} chapters translated`; }).catch(() => {});
  actions(body, {
    audiobook: async () => {
      let voices = [];
      try { voices = (await api('/api/audio/voices')).voices; } catch (ex) { return fail(ex); }
      const v = await formModal('Narrate the whole book', [{ name: 'voiceId', label: 'Voice', type: 'select', options: voices.map((x) => [x.id, x.name]) }], { submit: 'Start', note: 'Check each store’s AI-narration rules (table on the left) before uploading the files.' });
      if (v) { const r = await POST(`/api/books/${d.book.id}/audio-book`, v); toast(r.note); }
    },
    sample: async () => {
      let voices = [];
      try { voices = (await api('/api/audio/voices')).voices; } catch (ex) { return fail(ex); }
      const v = await formModal('Sample passage', [{ name: 'voiceId', label: 'Voice', type: 'select', options: voices.map((x) => [x.id, x.name]) }, { name: 'text', label: 'Text', type: 'textarea', rows: 8 }]);
      if (v) { await POST(`/api/books/${d.book.id}/audio`, v); toast('Audio saved — see the file list.'); reload(); }
    },
    'translate-book': async () => {
      const g = await api(`/api/books/${d.book.id}/global`);
      const v = await formModal('Translate the whole book', [
        { name: 'language', label: 'Language', type: 'select', options: g.languages.map((l) => [l, l]) },
        { name: 'format', label: 'Edition', type: 'select', options: [['ebook', 'ebook'], ['paperback', 'paperback']] },
        { name: 'glossary', label: 'Glossary — one “term = translation” per line (DeepL glossary; also given to Claude)', type: 'textarea', rows: 5 },
        { name: 'nativeReviewer', label: 'Native reviewer (required before publishing)' },
      ], { submit: 'Start', note: 'Uses the “translation” route: DeepL first, Claude as fallback. Runs chapter by chapter in the background.' });
      if (v) { const r = await POST(`/api/books/${d.book.id}/translate-book`, v); toast(r.note); reload(); }
    },
    'translate-snippet': async () => {
      const v = await formModal('Translate a passage', [{ name: 'targetLang', label: 'Language', value: 'German' }, { name: 'glossary', label: 'Glossary (term = translation per line)', type: 'textarea', rows: 3 }, { name: 'text', label: 'Text', type: 'textarea', rows: 10, required: true }], { wide: true });
      if (!v) return;
      const r = await POST(`/api/books/${d.book.id}/translate`, v);
      showModal(`<h3>Translation — ${esc(v.targetLang)} (${esc(r.provider)})</h3><div class="pre">${esc(r.translated)}</div><p class="muted small">${esc(r.note || '')}</p><div class="toolbar"><button class="btn" id="cp">Copy</button><button class="btn" data-close>Close</button></div>`, true);
      $('#cp').addEventListener('click', () => copyText(r.translated));
    },
  });
};

// ---- Sales & ranks ----
TAB_RENDER.sales = async (d, body) => {
  const s = await api(`/api/books/${d.book.id}/sales`);
  const trend = await api(`/api/books/${d.book.id}/rank-trend`);
  const cats = Object.entries(trend.trend.byCategory || {});
  body.innerHTML = `<p class="muted small">KDP has <strong>no sales API</strong> and Amazon has <strong>no rank API</strong> — import reports (Analytics → Import, or here) or type figures in. Royalties in other currencies are converted to USD for margins.</p>
    <div class="kpis" style="margin-top:0">${[['Net margin', money(s.margin.net)], ['Royalties', money(s.margin.royalty)], ['Units', num(s.margin.units)], ['Promotion spend', money(s.margin.spend)], ['Last 30 days', `${num(s.trend.recent.units)} units (${s.trend.pct >= 0 ? '+' : ''}${s.trend.pct}%)`]].map(([l, v]) => `<div class="kpi-tile"><div class="v">${esc(v)}</div><div class="l">${esc(l)}</div></div>`).join('')}</div>
    <div class="two-col"><div><h3>Royalties by month (USD)</h3><div id="sales-chart" class="card chart-card"></div></div><div><h3>By marketplace (USD)</h3><div id="sales-markets" class="card chart-card"></div></div></div>
    <div class="toolbar"><label class="btn" style="margin:0">Import report (CSV/XLSX)<input type="file" id="sales-file" class="hidden" accept=".csv,.xlsx,.tsv"></label><button class="btn" data-act="add-sale">+ Add figures</button><a class="btn" href="/api/books/${d.book.id}/export.csv">Export sales CSV</a></div>
    <details><summary class="small">Sales rows (${s.sales.length})</summary><div class="table-wrap"><table><tr><th>Period</th><th>Store</th><th>Market</th><th>Format</th><th class="num">Units</th><th class="num">KENP</th><th class="num">Royalty</th><th class="num">USD</th></tr>${s.sales.map((x) => `<tr><td>${esc(x.period)}</td><td>${esc(x.store)}</td><td>${esc(x.marketplace)}</td><td>${esc(x.format)}</td><td class="num">${num(x.units)}</td><td class="num">${num(x.kenp)}</td><td class="num">${money(x.royalty, x.currency || 'USD')}</td><td class="num">${x.royalty_usd != null ? money(x.royalty_usd) : ''}</td></tr>`).join('')}</table></div></details>
    <h3>Category ranks</h3><div class="toolbar"><button class="btn" data-act="add-rank">+ Rank</button><label class="btn" style="margin:0">Import ranks CSV (date, category, rank)<input type="file" id="rank-file" class="hidden" accept=".csv"></label></div>
    <div class="grid">${cats.map(([c, v], i) => `<div class="card"><h4>${esc(c)} <span class="muted small">best #${v.best} · ${esc(v.direction)}</span></h4><div id="rank-${i}"></div></div>`).join('') || '<p class="muted small">No ranks yet.</p>'}</div>
    <h3>Milestones</h3>${d.milestones.map((m) => `<span class="badge gold">${esc(m.kind)}</span> <span class="small">${esc(m.category)} — ${esc(String(m.date).slice(0, 10))}</span><br>`).join('') || '<p class="muted small">No milestones yet.</p>'}
    <h3>Competitors</h3><div class="toolbar"><button class="btn" data-act="find-comp">Find on Google Books…</button><button class="btn" data-act="add-comp">+ Add by hand</button></div>
    <div class="table-wrap"><table><tr><th>Title</th><th class="num">Price</th><th class="num">Rank</th><th class="num">Reviews</th><th>Checked</th><th>Alert</th><th></th></tr>${d.competitors.map((c) => `<tr><td>${esc(c.title)}<div class="small muted">${esc(c.author || '')} ${c.google_volume_id ? '· auto re-check weekly' : ''}</div></td><td class="num">${c.price != null ? money(c.price) : '—'}</td><td class="num">${c.rank ? '#' + c.rank : '—'}</td><td class="num">${num(c.review_count)}</td><td class="small">${esc(c.last_checked || '')}</td><td class="small">${esc(c.alert || '')}</td><td><button class="btn small" data-act="recheck" data-id="${c.id}">Update</button> <button class="btn small danger" data-act="del-comp" data-id="${c.id}">×</button></td></tr>`).join('') || '<tr><td colspan="7" class="muted">No competitors watched.</td></tr>'}</table></div>
    <h3>Price tests</h3><div class="toolbar"><button class="btn" data-act="add-test">+ Price test</button></div>
    ${d.priceTests.map((p) => `<div class="card small" style="margin-bottom:.4rem">${esc(p.format)}: ${money(p.old_price)} → ${money(p.new_price)} from ${esc(p.start_date)} — ${p.end_date ? `finished ${esc(p.end_date)} · after ${p.units_after} units / ${money(p.royalty_after)} vs before ${p.units_before} / ${money(p.royalty_before)}${p.verdict ? ' · verdict: ' + esc(p.verdict) : ''}` : `running <button class="btn small" data-act="finish-test" data-id="${p.id}">Finish</button>`}</div>`).join('') || '<p class="muted small">No price tests.</p>'}`;
  Charts.columns($('#sales-chart'), s.monthly.months.slice(-12).map((m) => ({ label: m.month.slice(2).replace('-', '/'), value: m.royalty })), { format: (v) => money(v) });
  Charts.bars($('#sales-markets'), s.monthly.markets.map((m) => ({ label: m.market, value: m.royalty })), { format: (v) => money(v) });
  cats.forEach(([, v], i) => Charts.rankLine($(`#rank-${i}`), v.points.map((p) => ({ date: String(p.date).slice(0, 10), rank: p.rank }))));
  $('#sales-file').addEventListener('change', async (e) => { const f = e.target.files[0]; if (!f) return; try { const r = await POST(`/api/books/${d.book.id}/sales/import`, await fileBody(f)); toast(`Imported ${r.imported} rows (${r.skipped} skipped).`); reload(); } catch (ex) { fail(ex); } });
  $('#rank-file').addEventListener('change', async (e) => { const f = e.target.files[0]; if (!f) return; try { const r = await POST(`/api/books/${d.book.id}/rank/import`, { csv: await readFile(f) }); toast(`Imported ${r.imported} ranks${r.milestones.length ? ` — ${r.milestones.map((m) => m.kind).join(', ')}!` : ''}.`); reload(); } catch (ex) { fail(ex); } });
  actions(body, {
    'add-sale': async () => { const v = await formModal('Add sales figures', [{ name: 'period', label: 'Period (YYYY-MM or date)', value: today().slice(0, 7), required: true }, { name: 'store', label: 'Store', value: 'KDP' }, { name: 'marketplace', label: 'Marketplace (US, UK, DE …)', value: 'US' }, { name: 'format', label: 'Format', type: 'select', options: ['ebook', 'paperback', 'hardcover', 'audiobook'].map((x) => [x, x]) }, { name: 'units', label: 'Units', type: 'number' }, { name: 'royalty', label: 'Royalty', type: 'number', step: '0.01' }, { name: 'currency', label: 'Currency', value: 'USD' }]); if (v) { await POST(`/api/books/${d.book.id}/sales`, v); reload(); } },
    'add-rank': async () => { const v = await formModal('Category rank', [{ name: 'category', label: 'Category', required: true, value: cats[0]?.[0] || '' }, { name: 'rank', label: 'Rank', type: 'number', required: true }, { name: 'store', label: 'Store', value: 'Amazon' }, { name: 'recordedAt', label: 'Date', type: 'date', value: today() }]); if (!v) return; const r = await POST(`/api/books/${d.book.id}/rank`, v); if (r.milestones.length) toast(`Milestone: ${r.milestones.map((m) => m.kind).join(', ')}!`); reload(); },
    'find-comp': async () => {
      const q = await formModal('Find competitor', [{ name: 'q', label: 'Title, author or ISBN', required: true }], { submit: 'Search' });
      if (!q) return;
      const r = await api(`/api/books/${d.book.id}/competitors/books-lookup?q=${encodeURIComponent(q.q)}`);
      const v = await formModal('Pick books to watch', [{ name: 'ids', label: 'Results', type: 'checkboxes', options: r.books.map((b) => [b.id, `${b.title} — ${b.author} (${b.publishedDate || '?'})${b.ratingsCount != null ? ` · ${b.ratingsCount} ratings` : ''}`]) }], { submit: 'Watch', wide: true });
      if (!v) return;
      for (const id of v.ids) { const b = r.books.find((x) => x.id === id); await POST(`/api/books/${d.book.id}/competitors`, { title: b.title, author: b.author, googleVolumeId: b.id, isbn: b.isbn, price: b.price, reviewCount: b.ratingsCount || 0, rating: b.averageRating }); }
      reload();
    },
    'add-comp': async () => { const v = await formModal('Competitor', [{ name: 'title', label: 'Title', required: true }, { name: 'author', label: 'Author' }, { name: 'price', label: 'Price', type: 'number', step: '0.01' }, { name: 'rank', label: 'Rank', type: 'number' }, { name: 'reviewCount', label: 'Reviews', type: 'number' }, { name: 'category', label: 'Category' }]); if (v) { await POST(`/api/books/${d.book.id}/competitors`, v); reload(); } },
    recheck: async (ds) => { const v = await formModal('Update competitor', [{ name: 'price', label: 'Price now', type: 'number', step: '0.01' }, { name: 'rank', label: 'Rank now', type: 'number' }, { name: 'reviewCount', label: 'Reviews now', type: 'number' }]); if (!v) return; const clean = Object.fromEntries(Object.entries(v).filter(([, x]) => x != null)); const r = await POST(`/api/competitors/${ds.id}/recheck`, clean); toast(r.alerts.length ? r.alerts.join('\n') : 'No changes.'); reload(); },
    'del-comp': async (ds) => { await DEL(`/api/competitors/${ds.id}`); reload(); },
    'add-test': async () => { const v = await formModal('Price test', [{ name: 'format', label: 'Format', type: 'select', options: ['ebook', 'paperback', 'hardcover'].map((x) => [x, x]) }, { name: 'oldPrice', label: 'Old price', type: 'number', step: '0.01', required: true }, { name: 'newPrice', label: 'New price', type: 'number', step: '0.01', required: true }, { name: 'startDate', label: 'Start', type: 'date', value: today() }]); if (v) { await POST(`/api/books/${d.book.id}/price-tests`, v); reload(); } },
    'finish-test': async (ds) => { const v = await formModal('Finish price test', [{ name: 'units', label: 'Units during the test', type: 'number' }, { name: 'royalty', label: 'Royalty during the test (USD)', type: 'number', step: '0.01' }, { name: 'verdict', label: 'Verdict', type: 'select', options: [['keep', 'Keep the new price'], ['revert', 'Go back'], ['inconclusive', 'Inconclusive']] }]); if (!v) return; const r = await POST(`/api/price-tests/${ds.id}/finish`, v); toast(`Over ${r.comparison.days} days: ${r.comparison.after.units} units after vs ${r.comparison.before.units} before.`); reload(); },
  });
};

// ---- Refresh ----
TAB_RENDER.refresh = async (d, body) => {
  body.innerHTML = `<p class="muted small">Check-ins at 30, 60 and 90 days after launch, then quarterly. With automation on, the app analyses each check-in on its due date (sales, reviews, rank, link clicks) and puts the options here; approving one creates the task and — for descriptions, keywords and localization — drafts the first version for you.</p>
    <h3>Check-ins</h3>${d.refreshCycles.map((c) => `<div class="card small" style="margin-bottom:.4rem"><div class="row-between"><span>${esc(c.kind)} — due ${esc(c.due_date)} ${badge(c.status)}</span><span>${c.status !== 'done' ? `<button class="btn small" data-act="analyse" data-id="${c.id}">Analyse now</button> <button class="btn small" data-act="cycle-done" data-id="${c.id}">Mark done</button>` : ''}</span></div></div>`).join('') || '<p class="muted small">No check-ins yet — they are created when the launch is planned.</p>'}
    <h3>Recommendations</h3>${d.recommendations.map((r) => `<div class="card small" style="margin-bottom:.4rem"><strong>${esc(r.kind.replace(/_/g, ' '))}</strong> ${badge(r.status)}<div>${esc(r.reason)}</div><details><summary class="muted">The numbers</summary><div class="pre">${esc(Object.entries(parseJson(r.numbers_json, {})).map(([k, v]) => `${k}: ${v}`).join('\n'))}</div></details>${r.status === 'proposed' ? `<div class="toolbar"><button class="btn small primary" data-act="approve" data-id="${r.id}">Approve</button><button class="btn small" data-act="reject" data-id="${r.id}">Reject</button></div>` : ''}</div>`).join('') || '<p class="muted small">No recommendations yet.</p>'}
    <div class="two-col"><div><h3>Refresh log</h3>${d.refreshLog.map((l) => `<p class="small">${esc(l.created_at.slice(0, 10))} · ${esc(l.action)}: ${esc(l.detail)} <span class="muted">${esc(l.result || '')}</span></p>`).join('') || '<p class="muted small">Nothing changed yet.</p>'}</div>
    <div><h3>Lessons (Kaizen)</h3>${d.lessons.map((l) => `<p class="small"><strong>${esc(l.lesson_code)}</strong> — ${esc(l.text || '')}</p>`).join('') || '<p class="muted small">No lessons yet.</p>'}<div class="toolbar"><button class="btn small" data-act="lesson">+ Lesson</button><a class="btn small" href="/api/lessons/export.json" target="_blank">Export lessons (JSON)</a></div></div></div>`;
  actions(body, {
    analyse: async (ds) => { const r = await POST(`/api/books/${d.book.id}/refresh/${ds.id}/analyse`); toast(`${r.recommendations.length} recommendations.`); reload(); },
    'cycle-done': async (ds) => { const v = await formModal('Check-in done', [{ name: 'outcome', label: 'What changed / what it did', type: 'textarea', rows: 3 }]); if (v) { await POST(`/api/books/${d.book.id}/refresh/${ds.id}/done`, v); reload(); } },
    approve: async (ds) => { const r = await POST(`/api/recommendations/${ds.id}/approve`); toast(`Approved — task created. ${r.automated || ''}`); reload(); },
    reject: async (ds) => { await POST(`/api/recommendations/${ds.id}/reject`); reload(); },
    lesson: async () => { const v = await formModal('Lesson', [{ name: 'code', label: 'Code', type: 'select', options: ['description', 'keywords', 'categories', 'price', 'cover', 'timing', 'channel', 'ads', 'other'].map((x) => [x, x]) }, { name: 'note', label: 'Lesson', type: 'textarea', rows: 3 }]); if (v) { await POST(`/api/books/${d.book.id}/lessons`, v); reload(); } },
  });
};

// ---------------- calendar (all books) ----------------
async function loadCalendar() {
  const { posts } = await api('/api/calendar');
  const el = $('#calendar');
  el.innerHTML = postList(posts, true);
  actions(el, postActions(posts, loadCalendar));
}

// ---------------- contacts ----------------
let CONTACT_TYPES = [];
async function loadContacts() {
  const type = $('#contact-type').value, q = $('#contact-q').value;
  const d = await api(`/api/contacts?type=${encodeURIComponent(type)}&q=${encodeURIComponent(q)}`);
  CONTACT_TYPES = d.types;
  if ($('#contact-type').options.length <= 1) $('#contact-type').innerHTML = '<option value="">All types</option>' + d.types.map((t) => `<option>${t}</option>`).join('');
  $('#contact-type').value = type;
  const el = $('#contact-list');
  el.innerHTML = `<div class="table-wrap"><table><tr><th>Name</th><th>Type</th><th>Email</th><th>Outlet / tags</th><th>Consent</th><th>Status</th><th></th></tr>${d.contacts.map((c) => `<tr><td>${esc(c.name)}<div class="small muted">${esc(c.country || '')} ${esc(c.language || '')}</div></td><td>${esc(c.type)}</td><td class="small">${esc(c.email)}</td><td class="small">${esc(c.outlet || '')} ${esc(c.tags || '')}</td><td class="small">${c.consent ? `yes ${esc(c.consent_date || '')}` : 'no'}</td><td>${badge(c.status)}</td><td><button class="btn small" data-act="edit" data-id="${c.id}">Edit</button> <button class="btn small" data-act="history" data-id="${c.id}">History</button> <button class="btn small danger" data-act="del" data-id="${c.id}">×</button></td></tr>`).join('') || '<tr><td colspan="7" class="muted">No contacts.</td></tr>'}</table></div>`;
  actions(el, {
    edit: async (ds) => { const c = d.contacts.find((x) => String(x.id) === ds.id); const v = await contactForm(c); if (v) { await PUT(`/api/contacts/${c.id}`, v); loadContacts(); } },
    history: async (ds) => { const c = d.contacts.find((x) => String(x.id) === ds.id); showModal(`<h3>${esc(c.name)}</h3><p class="small muted">Source: ${esc(c.source)} · added ${esc(c.created_at)}</p><div class="pre">${esc(c.history || 'No history.')}</div><button class="btn" data-close>Close</button>`); },
    del: async (ds) => { if (await confirmModal('Delete this contact (and remove them from the email list)?', 'Delete')) { await DEL(`/api/contacts/${ds.id}`); loadContacts(); } },
  });
}
function contactForm(c = {}) {
  return formModal(c.id ? 'Edit contact' : 'Add contact', [
    { name: 'name', label: 'Name', value: c.name, required: true }, { name: 'email', label: 'Email', type: 'email', value: c.email },
    { name: 'type', label: 'Type', type: 'select', value: c.type || 'reader', options: CONTACT_TYPES.map((t) => [t, t]) },
    { name: 'outlet', label: 'Outlet / show / store / library', value: c.outlet }, { name: 'country', label: 'Country', value: c.country }, { name: 'language', label: 'Language', value: c.language },
    { name: 'tags', label: 'Tags', value: c.tags }, { name: 'consent', label: 'They agreed to receive email from us (record of consent)', type: 'checkbox', value: !!c.consent },
  ]);
}
$('#add-contact-btn').addEventListener('click', async () => { if (!CONTACT_TYPES.length) CONTACT_TYPES = (await api('/api/contacts')).types; const v = await contactForm(); if (v) { try { await POST('/api/contacts', v); loadContacts(); } catch (ex) { fail(ex); } } });
$('#import-contacts-btn').addEventListener('click', async () => {
  const v = await formModal('Import contacts', [{ name: 'file', label: 'CSV with columns name, email, type, consent (yes/no), outlet, country, language, tags', type: 'file', accept: '.csv', required: true }], { submit: 'Import', note: 'Rows without consent are imported but never emailed.' });
  if (!v || !v.file) return;
  try { const r = await POST('/api/contacts/import', { csv: await readFile(v.file) }); toast(`Added ${r.added}, skipped ${r.skipped}.`); loadContacts(); } catch (ex) { fail(ex); }
});
$('#contact-type').addEventListener('change', () => loadContacts().catch(fail));
let cq;
$('#contact-q').addEventListener('input', () => { clearTimeout(cq); cq = setTimeout(() => loadContacts().catch(fail), 300); });

// ---------------- analytics ----------------
async function loadAnalytics() {
  const dash = await api('/api/dashboard');
  Charts.bars($('#market-chart'), dash.monthly.markets.map((m) => ({ label: m.market, value: m.royalty })), { format: (v) => money(v) });
  const { imprints } = await api('/api/analytics/imprints');
  $('#imprint-margins').innerHTML = `<div class="table-wrap"><table><tr><th>Imprint</th><th class="num">Books</th><th class="num">Units</th><th class="num">Royalties</th><th class="num">Promotion</th><th class="num">Production</th><th class="num">Net</th></tr>${imprints.map((i) => `<tr><td>${esc(i.name)}</td><td class="num">${i.margin.books}</td><td class="num">${num(i.margin.units)}</td><td class="num">${money(i.margin.royalty)}</td><td class="num">${money(i.margin.spend)}</td><td class="num">${money(i.margin.production)}</td><td class="num"><strong>${money(i.margin.net)}</strong></td></tr>`).join('')}</table></div>`;
}
$('#report-import').addEventListener('click', async (e) => {
  const f = $('#report-file').files[0];
  if (!f) return toast('Choose a report file first.', true);
  busy(e.target, true);
  try {
    const r = await POST('/api/import/report', { ...(await fileBody(f)), kind: $('#report-kind').value || undefined });
    $('#report-result').innerHTML = `<p class="small">Read ${num(r.rows)} rows: <strong>${r.sales}</strong> sales rows and <strong>${r.ads}</strong> ad rows saved for ${r.books.length} book(s); ${r.skipped} skipped.</p>${r.unmatched.length ? `<p class="small note">Not matched to a book (add the ASIN/ISBN to the book’s Stores tab, then import again): ${esc(r.unmatched.join(', '))}</p>` : ''}`;
    loadAnalytics();
  } catch (ex) { fail(ex); } finally { busy(e.target, false); }
});

// ---------------- settings ----------------
const SETTINGS_SECTIONS = [['vault', 'API vault'], ['automation', 'Automation'], ['integrations', 'Integrations'], ['routing', 'AI routing & prompts'], ['budgets', 'Budgets & usage'], ['worldwide', 'Worldwide'], ['imprints', 'Imprints & platforms'], ['accounts', 'Accounts & security'], ['jobs', 'Jobs & activity']];
let SETTINGS_SECTION = 'vault';
async function loadSettings(section) {
  if (section) SETTINGS_SECTION = section;
  if (!ME.isAdmin) { $('#settings-body').innerHTML = '<div class="note">Only the admin sees Settings.</div>'; return; }
  $('#settings-nav').innerHTML = SETTINGS_SECTIONS.map(([k, l]) => `<button class="tab-btn ${k === SETTINGS_SECTION ? 'active' : ''}" data-s="${k}">${l}</button>`).join('');
  $$('#settings-nav [data-s]').forEach((b) => b.addEventListener('click', () => loadSettings(b.dataset.s)));
  const body = $('#settings-body');
  body.innerHTML = '<p class="muted">Loading…</p>';
  try { await SETTINGS[SETTINGS_SECTION](body); } catch (ex) { fail(ex); }
}
const SETTINGS = {};

SETTINGS.vault = async (body) => {
  const { providers, notConnectable } = await api('/api/settings/providers');
  const groups = [...new Set(providers.map((p) => p.group))];
  body.innerHTML = `<p class="muted small">Keys are encrypted at rest (AES-256-GCM) and never shown in full. Leave the key blank to change only the other fields.</p>
    ${groups.map((g) => `<h3>${esc(g)}</h3><div class="grid">${providers.filter((p) => p.group === g).map((p) => `<div class="card provider-card"><div class="row-between"><h4>${esc(p.name)}</h4>${p.connected ? `<span class="badge green">connected ${esc(p.hint)}</span>` : '<span class="badge">not connected</span>'}</div>
      <p class="muted small">${esc(p.reasoning)}</p>
      <label>${esc(p.keyLabel)} <input type="password" data-key="${p.provider}" placeholder="${p.connected ? 'saved — paste to replace' : 'paste key'}" autocomplete="off"></label>
      <div class="extra">${p.defaultModel ? `<label>Model <input data-extra="${p.provider}" data-field="model" value="${esc(p.model)}" placeholder="${esc(p.defaultModel)}"></label>` : ''}${p.extraFields.map((f) => `<label>${esc(f.label)} <input data-extra="${p.provider}" data-field="${f.key}" value="${esc(f.value)}"></label>`).join('')}</div>
      <div class="toolbar"><button class="btn small primary" data-act="save" data-p="${p.provider}">Save</button><button class="btn small" data-act="test" data-p="${p.provider}">Test</button>${p.connected ? `<button class="btn small danger" data-act="clear" data-p="${p.provider}">Remove</button>` : ''}<a class="small" href="${esc(p.keyUrl)}" target="_blank" rel="noopener">get a key</a></div>
      <div class="small" data-out="${p.provider}"></div></div>`).join('')}</div>`).join('')}
    <h3>What cannot be connected</h3>${notConnectable.map((n) => `<div class="card small" style="margin-bottom:.4rem"><strong>${esc(n.name)}</strong> — ${esc(n.reason)}</div>`).join('')}`;
  const extraOf = (p) => Object.fromEntries($$(`[data-extra="${p}"]`, body).map((i) => [i.dataset.field, i.value.trim()]));
  actions(body, {
    save: async (ds) => { const r = await POST('/api/settings/providers', { provider: ds.p, apiKey: $(`[data-key="${ds.p}"]`, body).value.trim(), extra: extraOf(ds.p) }); toast(r.message); loadSettings(); },
    test: async (ds) => { const out = $(`[data-out="${ds.p}"]`, body); out.textContent = 'Testing…'; const r = await POST(`/api/settings/providers/${ds.p}/test`, { apiKey: $(`[data-key="${ds.p}"]`, body).value.trim() || undefined, extra: extraOf(ds.p) }); out.textContent = `${r.ok ? '✓' : '✗'} ${r.detail}`; out.style.color = r.ok ? '' : 'var(--danger)'; },
    clear: async (ds) => { if (await confirmModal(`Remove the saved key for ${ds.p}?`, 'Remove')) { await POST('/api/settings/providers', { provider: ds.p, clear: true }); loadSettings(); } },
  });
};

SETTINGS.automation = async (body) => {
  const { automation: a } = await api('/api/admin/settings');
  const preview = await api('/api/automation/digest-preview');
  const sel = (k, opts) => `<select data-k="${k}">${opts.map(([v, l]) => `<option value="${v}" ${String(a[k]) === v ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
  const onoff = (k) => sel(k, [['1', 'On'], ['0', 'Off']]);
  body.innerHTML = `<div class="card"><div class="table-wrap"><table>
    <tr><td><strong>Automation</strong><div class="small muted">Master switch for the rules below (queued jobs still run).</div></td><td>${onoff('automation_enabled')}</td></tr>
    <tr><td>Analyse backlist check-ins on their due date</td><td>${onoff('auto_refresh_analysis')}</td></tr>
    <tr><td>Launch: draft the content kit 2 weeks out and schedule approved posts 1 week out</td><td>${onoff('auto_launch_content')}</td></tr>
    <tr><td>Localize store pages 5 weeks before launch for these languages <div class="small muted">comma-separated, e.g. German, French, Spanish, Italian — blank = off</div></td><td><input data-k="auto_locales" value="${esc(a.auto_locales || '')}"></td></tr>
    <tr><td>Post scheduled content to connected channels automatically</td><td>${onoff('auto_post')}</td></tr>
    <tr><td>ARC reminders on day 7 and day 14 without a review</td><td>${sel('auto_arc_followup', [['off', 'Off'], ['draft', 'Add a task'], ['send', 'Send a polite follow-up email']])}</td></tr>
    <tr><td>Check Apple Books and Google Play daily for listings that are uploaded or in review, and mark them live when found</td><td>${onoff('auto_live_check')}</td></tr>
    <tr><td>Re-check Google Books competitors weekly</td><td>${onoff('auto_competitor_recheck')}</td></tr>
    <tr><td>Refresh exchange rates daily (ECB)</td><td>${onoff('auto_fx_refresh')}</td></tr>
    <tr><td>Daily digest hour (UTC) <div class="small muted">14 = 7am Calgary in summer, 8am in winter. Emailed to the notification address.</div></td><td><input data-k="digest_hour_utc" type="number" min="0" max="23" value="${esc(a.digest_hour_utc)}"></td></tr>
    <tr><td>Double opt-in for public signups <div class="small muted">Recommended for CASL/GDPR — readers confirm by email before they are on the list.</div></td><td>${onoff('double_opt_in')}</td></tr>
  </table></div><div class="toolbar"><button class="btn primary" data-act="save">Save automation</button><button class="btn" data-act="run">Run automation now</button><button class="btn" data-act="digest">Send today’s digest now</button></div></div>
  <h3>Today’s digest (preview)</h3><div class="pre">${esc(preview.text)}</div>`;
  actions(body, {
    save: async () => { const v = Object.fromEntries($$('[data-k]', body).map((i) => [i.dataset.k, i.value])); await POST('/api/admin/settings', v); toast('Automation saved.'); },
    run: async () => { const r = await POST('/api/automation/run-now'); toast(`Done: ${Object.entries(r.result).filter(([, x]) => x && typeof x !== 'object').map(([k, x]) => `${k} ${x}`).join(', ') || 'nothing due'}.`); },
    digest: async () => { const r = await POST('/api/automation/digest'); toast(r.emailed ? 'Digest emailed.' : 'Digest posted in Alerts (set a notification email and email provider to get it by email).'); },
  });
};

SETTINGS.integrations = async (body) => {
  const { settings: s } = await api('/api/admin/settings');
  const f = (k, label, help = '', type = 'text', ph = '') => `<label>${label} ${help ? `<span class="muted small">${help}</span>` : ''}<input data-k="${k}" type="${type}" value="${esc(s[k] || '')}" placeholder="${esc(ph)}"></label>`;
  body.innerHTML = `<div class="card">
    <p class="small">Finished books are sent to <code>${esc(s.handoff_url)}</code></p>
    ${f('handoff_token', 'Handoff token', s.handoff_token_set ? '(saved — paste to replace)' : 'shared secret for incoming handoffs', 'password')}
    ${f('publish_url', 'Source app URL')}
    ${f('publish_token', 'Source app token', s.publish_token_set ? '(saved)' : '', 'password')}
    ${f('public_base_url', 'Public base URL', 'used in smart links, book pages and emails', 'text', 'https://bookmarketing.amaldas.si')}
    ${f('notify_email', 'Notification email', 'daily digest and alerts', 'email')}
    ${f('drive_folder_link', 'Drive folder (marketing books)')}
    ${f('post_webhook_url', 'Post webhook', 'posts for channels with no direct connection (e.g. Own website) go here — e.g. an n8n flow that publishes to WordPress')}
    ${f('n8n_webhook_gate', 'n8n webhook — stage gates')}${f('n8n_webhook_handoff', 'n8n webhook — handoff')}${f('n8n_webhook_launch', 'n8n webhook — launch')}
    <button class="btn primary" data-act="save">Save integrations</button></div>
    <h3>Embed the signup on your websites</h3><div class="card small"><p>Imprint websites can post signups straight to <code>POST /api/funnel/signup</code> with JSON <code>{ "name", "email", "consent": true, "bookId" }</code> — or simply link to a book page (<code>/p/&lt;book&gt;</code>), which has the signup form built in.</p></div>`;
  actions(body, { save: async () => { const v = Object.fromEntries($$('[data-k]', body).map((i) => [i.dataset.k, i.value])); await POST('/api/admin/settings', v); toast('Integrations saved.'); loadSettings(); } });
};

SETTINGS.routing = async (body) => {
  const [{ routes, tasks, providers }, { prompts }] = await Promise.all([api('/api/settings/routes'), api('/api/settings/prompts')]);
  const latest = {};
  for (const p of prompts) latest[p.task] = p;
  body.innerHTML = `<p class="muted small">Each task tries its first choice, then the fallback, then any other connected writer. Prompts are versioned — editing saves a new version; placeholders: {imprint} {author} {title} {channel} {language} {market}.</p>
    <div class="table-wrap"><table><tr><th>Task</th><th>First choice</th><th>Fallback</th><th>Model override</th><th></th></tr>
    ${tasks.map((t) => { const r = routes[t] || {}; const opt = (cur) => ['<option value="">—</option>', ...providers.map((p) => `<option ${cur === p ? 'selected' : ''}>${p}</option>`)].join(''); return `<tr><td>${esc(t)}</td><td><select data-rt="${t}" data-f="provider">${opt(r.provider)}</select></td><td><select data-rt="${t}" data-f="fallbackProvider">${opt(r.fallback_provider)}</select></td><td><input data-rt="${t}" data-f="model" value="${esc(r.model || '')}" placeholder="default"></td><td><button class="btn small" data-act="save-route" data-t="${t}">Save</button> ${latest[t] ? `<button class="btn small" data-act="prompt" data-t="${t}">Prompt v${esc(latest[t].version)}</button>` : ''}</td></tr>`; }).join('')}</table></div>`;
  actions(body, {
    'save-route': async (ds) => { const v = Object.fromEntries($$(`[data-rt="${ds.t}"]`, body).map((i) => [i.dataset.f, i.value])); await POST('/api/settings/routes', { task: ds.t, ...v }); toast('Route saved.'); },
    prompt: async (ds) => { const p = latest[ds.t]; const v = await formModal(`Prompt — ${ds.t}`, [{ name: 'text', label: `Current v${p.version}`, type: 'textarea', rows: 12, value: p.text }, { name: 'notes', label: 'What changed' }], { submit: 'Save new version', wide: true }); if (v) { const r = await POST('/api/settings/prompts', { task: ds.t, ...v }); toast(`Saved v${r.version}.`); loadSettings(); } },
  });
};

SETTINGS.budgets = async (body) => {
  const [{ budgets }, usage, { providers }] = await Promise.all([api('/api/settings/budgets'), api('/api/settings/usage'), api('/api/settings/providers')]);
  body.innerHTML = `<h3>Budgets</h3><p class="muted small">Warning at 80%, AI calls stop at 100%. Kinds: <strong>monthly</strong> (all providers together; reference = YYYY-MM or "every"), <strong>provider</strong> (one provider per month), <strong>book</strong> (lifetime, by book id).</p>
    <div class="table-wrap"><table><tr><th>Kind</th><th>Reference</th><th class="num">Limit</th><th class="num">Spent</th><th>Used</th><th></th></tr>${budgets.map((b) => `<tr><td>${esc(b.kind)}</td><td>${esc(b.ref)}</td><td class="num">${money(b.limit_usd)}</td><td class="num">${money(b.spent)}</td><td style="min-width:120px"><div class="progress"><div style="width:${Math.min(100, b.percent)}%;${b.percent >= 100 ? 'background:var(--danger)' : b.percent >= 80 ? 'background:var(--accent2)' : ''}"></div></div><span class="small">${b.percent}%</span></td><td><button class="btn small danger" data-act="del" data-id="${b.id}">×</button></td></tr>`).join('') || '<tr><td colspan="6" class="muted">No budgets.</td></tr>'}</table></div>
    <div class="toolbar"><button class="btn" data-act="add">+ Budget</button></div>
    <h3>Usage — ${esc(usage.month)}</h3><div class="grid">
      <div class="card"><h4>By provider</h4>${usage.byProvider.map((u) => `<div class="small">${esc(u.provider)}: ${u.calls} calls · ${money(u.cost)}</div>`).join('') || '<span class="muted small">None.</span>'}</div>
      <div class="card"><h4>By task</h4>${usage.byTask.map((u) => `<div class="small">${esc(u.task)}: ${u.calls} calls · ${money(u.cost)}</div>`).join('') || '<span class="muted small">None.</span>'}</div>
      <div class="card"><h4>By book (all time)</h4>${usage.byBook.map((u) => `<div class="small">${esc(u.title || 'Book ' + u.book_id)}: ${u.calls} calls · ${money(u.cost)}</div>`).join('') || '<span class="muted small">None.</span>'}</div></div>
    <p class="muted small">Costs are estimates from list prices; Meta Muse Spark pricing is unverified.</p>`;
  actions(body, {
    add: async () => { const v = await formModal('Budget', [{ name: 'kind', label: 'Kind', type: 'select', options: [['monthly', 'Monthly — all providers'], ['provider', 'Provider — monthly'], ['book', 'Book — lifetime']] }, { name: 'ref', label: 'Reference (YYYY-MM or "every" · provider name · book id)', value: 'every', help: `providers: ${providers.map((p) => p.provider).join(', ')}` }, { name: 'limitUsd', label: 'Limit (USD)', type: 'number', step: '1', required: true }]); if (v) { await POST('/api/settings/budgets', v); loadSettings(); } },
    del: async (ds) => { await DEL(`/api/settings/budgets/${ds.id}`); loadSettings(); },
  });
};

SETTINGS.worldwide = async (body) => {
  const { fx } = await api('/api/fx');
  body.innerHTML = `<h3>Exchange rates <span class="muted small">(units per 1 USD)</span></h3>
    <div class="toolbar"><button class="btn primary" data-act="refresh">Refresh from the ECB now</button><button class="btn" data-act="set">Set a rate by hand</button></div>
    <div class="table-wrap"><table><tr><th>Currency</th><th class="num">Per USD</th><th>Source</th><th>Updated (UTC)</th></tr>${fx.map((f) => `<tr><td>${esc(f.currency)}</td><td class="num">${f.per_usd}</td><td class="small">${esc(f.source)}</td><td class="small">${esc(f.updated_at)}</td></tr>`).join('')}</table></div>`;
  actions(body, {
    refresh: async () => { const r = await POST('/api/fx/refresh'); toast(r.ok ? `Updated ${r.updated} rates (${r.date}).` : r.error, !r.ok); loadSettings(); },
    set: async () => { const v = await formModal('Exchange rate', [{ name: 'currency', label: 'Currency code', required: true }, { name: 'perUsd', label: 'Units per 1 USD', type: 'number', step: '0.0001', required: true }]); if (v) { await POST('/api/fx', v); loadSettings(); } },
  });
};

SETTINGS.imprints = async (body) => {
  const { imprints } = await api('/api/imprints');
  body.innerHTML = imprints.map((i) => `<div class="card" style="margin-bottom:.75rem"><div class="row-between"><h3 style="margin:0">${esc(i.name)}</h3><button class="btn small" data-act="edit" data-id="${i.id}">Edit</button></div>
    <p class="small muted">Author: ${esc(i.author_name)} · Publisher: ${esc(i.publisher_name)} · ${esc(i.website || 'no website')} · ISBN block ${esc(i.isbn_block || '—')}</p>
    <p class="small">${esc(i.voice_profile)}</p><p class="small">Channels: ${i.channels.map((c) => `<strong>${esc(c.platform)}</strong> (${esc(c.rules)})`).join('; ')}</p>
    <h4>Author platform checklist</h4><div class="table-wrap"><table>${i.profiles.map((p) => `<tr><td>${esc(p.platform)}</td><td>${badge(p.status)}</td><td class="small">${p.url ? `<a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.url)}</a>` : ''}</td><td><button class="btn small" data-act="profile" data-id="${p.id}" data-imp="${i.id}">Update</button></td></tr>`).join('')}</table></div></div>`).join('');
  actions(body, {
    edit: async (ds) => { const i = imprints.find((x) => String(x.id) === ds.id); const v = await formModal(`Edit ${i.name}`, [{ name: 'authorName', label: 'Author name', value: i.author_name }, { name: 'publisherName', label: 'Publisher name', value: i.publisher_name }, { name: 'isbnBlock', label: 'ISBN block', value: i.isbn_block }, { name: 'website', label: 'Website', value: i.website }, { name: 'voiceProfile', label: 'Voice profile', type: 'textarea', rows: 4, value: i.voice_profile }, { name: 'brandAssets', label: 'Brand assets', type: 'textarea', rows: 3, value: i.brand_assets }], { wide: true }); if (v) { await PUT(`/api/imprints/${i.id}`, v); loadSettings(); } },
    profile: async (ds) => { const p = imprints.find((x) => String(x.id) === ds.imp).profiles.find((x) => String(x.id) === ds.id); const v = await formModal(p.platform, [{ name: 'status', label: 'Status', type: 'select', value: p.status, options: [['todo', 'To do'], ['in progress', 'In progress'], ['done', 'Done']] }, { name: 'url', label: 'Profile URL', value: p.url }, { name: 'notes', label: 'Notes', value: p.notes }]); if (v) { await PUT(`/api/profiles/${p.id}`, v); loadSettings(); } },
  });
};

SETTINGS.accounts = async (body) => {
  const { accounts } = await api('/api/admin/accounts');
  body.innerHTML = `<div class="toolbar"><button class="btn primary" data-act="add">+ Family member account</button></div>
    <div class="table-wrap"><table><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th></th></tr>${accounts.map((a) => `<tr><td>${esc(a.name)}</td><td>${esc(a.email)}</td><td>${esc(a.role)}</td><td><span class="badge ${a.status === 'active' ? 'green' : 'red'}">${esc(a.status)}</span> ${a.must_change_password ? '<span class="badge">temp password</span>' : ''} ${a.totp_enabled ? '<span class="badge green">2-step</span>' : ''}</td><td>${a.id !== ME.id ? (a.status === 'active' ? `<button class="btn small" data-act="disable" data-id="${a.id}">Disable</button>` : `<button class="btn small" data-act="enable" data-id="${a.id}">Enable</button>`) : ''} <button class="btn small" data-act="reset" data-id="${a.id}">Reset password</button></td></tr>`).join('')}</table></div>
    <h3>Two-step sign-in for your account</h3><div class="card">${ME.totpEnabled ? '<p class="small">Two-step sign-in is <strong>on</strong>.</p><button class="btn" data-act="totp-off">Turn off…</button>' : '<p class="small">Use an authenticator app (Google Authenticator, 1Password, Authy …).</p><button class="btn primary" data-act="totp-on">Set up two-step sign-in</button>'}</div>`;
  actions(body, {
    add: async () => { const v = await formModal('Family member account', [{ name: 'name', label: 'Name', required: true }, { name: 'email', label: 'Username or email', required: true }, { name: 'tempPassword', label: 'Temporary password (8+)', type: 'password', required: true }, { name: 'role', label: 'Role', type: 'select', options: [['member', 'Member'], ['admin', 'Admin']] }], { note: 'They must change the temporary password on first sign-in.' }); if (v) { await POST('/api/admin/accounts', v); loadSettings(); } },
    disable: async (ds) => { await POST(`/api/admin/accounts/${ds.id}/disable`); loadSettings(); },
    enable: async (ds) => { await POST(`/api/admin/accounts/${ds.id}/enable`); loadSettings(); },
    reset: async (ds) => { const v = await formModal('Reset password', [{ name: 'tempPassword', label: 'Temporary password (8+)', type: 'password', required: true }]); if (v) { await POST(`/api/admin/accounts/${ds.id}/reset-password`, v); toast('Reset — they must change it on next sign-in.'); } },
    'totp-on': async () => {
      const r = await POST('/api/auth/totp/setup');
      const v = await formModal('Set up two-step sign-in', [{ type: 'html', html: `<p class="small">Add this secret in your authenticator app (manual entry, time-based):</p><p><code>${esc(r.secret)}</code></p><p class="small muted">Or open on your phone: <code>${esc(r.url)}</code></p>` }, { name: 'code', label: 'Current 6-digit code', required: true }], { submit: 'Turn on' });
      if (v) { await POST('/api/auth/totp/enable', v); ME.totpEnabled = true; toast('Two-step sign-in is on.'); loadSettings(); }
    },
    'totp-off': async () => { const v = await formModal('Turn off two-step sign-in', [{ name: 'code', label: 'Current 6-digit code' }, { name: 'password', label: 'or your password', type: 'password' }]); if (v) { await POST('/api/auth/totp/disable', v); ME.totpEnabled = false; toast('Two-step sign-in is off.'); loadSettings(); } },
  });
};

SETTINGS.jobs = async (body) => {
  const [{ jobs }, { activity }, { handoffs }] = await Promise.all([api('/api/jobs'), api('/api/activity'), api('/api/handoffs')]);
  body.innerHTML = `<h3>Background jobs</h3><div class="table-wrap"><table><tr><th>#</th><th>Job</th><th>Book</th><th>Status</th><th>Runs after (UTC)</th><th>Progress / error</th><th></th></tr>${jobs.map((j) => `<tr><td>${j.id}</td><td>${esc(j.kind.replace(/_/g, ' '))}</td><td>${j.book_id || ''}</td><td>${badge(j.status)}</td><td class="small">${esc(j.run_after || '')}</td><td class="small">${esc(j.progress || '')} <span style="color:var(--danger)">${esc(j.error || '')}</span></td><td>${j.status === 'queued' ? `<button class="btn small" data-act="cancel" data-id="${j.id}">Cancel</button>` : ''}${['failed', 'cancelled'].includes(j.status) ? `<button class="btn small" data-act="retry" data-id="${j.id}">Retry</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="7" class="muted">No jobs.</td></tr>'}</table></div>
    <h3>Handoffs received</h3><div class="card small">${handoffs.map((h) => `<div>${esc(h.created_at)} — ${esc(h.title || '')} (source #${h.publish_book_id || '?'}) · ${esc(h.note)}</div>`).join('') || '<span class="muted">None yet.</span>'}</div>
    <h3>Activity</h3><div class="card small">${activity.slice(0, 80).map((a) => `<div>${esc(a.created_at)} — ${esc(a.account_name || 'system')}: ${esc(a.action)} ${esc(a.detail || '')}</div>`).join('') || '<span class="muted">No activity.</span>'}</div>`;
  actions(body, {
    cancel: async (ds) => { await POST(`/api/jobs/${ds.id}/cancel`); loadSettings(); },
    retry: async (ds) => { await POST(`/api/jobs/${ds.id}/retry`); toast('Queued again.'); loadSettings(); },
  });
};

checkMe();
