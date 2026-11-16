// Provider layer for Marketing — one completeTask() call that works with
// any saved text provider, plus test-connection, research, image, audio,
// translation, email and list/campaign helpers, cost meter and budgets.
// Nothing here invents keys: if no key is saved, that provider reports
// "not connected" and the caller falls back to a clearly-labelled local
// draft (text) or a manual step (posting, sending).
const db = require('./db');
const { encrypt, decrypt } = require('./crypto');

const PROVIDERS = {
  anthropic: {
    group: 'Writing', name: 'Anthropic Claude',
    reasoning: 'Best marketing prose in the imprint voice — descriptions, emails, LinkedIn articles, press kits, localized metadata. First choice for all content tasks.',
    defaultModel: 'claude-sonnet-5-5',
    keyLabel: 'Anthropic API key (sk-ant-…)', keyUrl: 'https://console.anthropic.com/settings/keys',
  },
  openai: {
    group: 'Writing', name: 'OpenAI ChatGPT',
    reasoning: 'Strong all-rounder and fallback writer; also image generation for social banners (GPT Image).',
    defaultModel: 'gpt-5', keyLabel: 'OpenAI API key (sk-…)', keyUrl: 'https://platform.openai.com/api-keys',
  },
  gemini: {
    group: 'Writing', name: 'Google Gemini',
    reasoning: 'Cheapest bulk generation at volume. Good for first drafts of posts and keyword lists when cost matters most.',
    defaultModel: 'gemini-2.5-pro', keyLabel: 'Gemini API key (AI Studio)', keyUrl: 'https://aistudio.google.com/apikey',
  },
  meta: {
    group: 'Writing', name: 'Meta Muse Spark',
    reasoning: 'Meta’s Model API (OpenAI-compatible). A strong, fast writer. Pricing UNVERIFIED — the cost meter flags its estimates.',
    defaultModel: 'muse-spark', keyLabel: 'Meta Model API key', keyUrl: 'https://developers.meta.com/', baseUrl: 'https://api.meta.ai/v1',
  },
  openrouter: {
    group: 'Writing', name: 'OpenRouter',
    reasoning: 'One key, 100+ models. Use it to switch models without managing five keys. Set the model name on the card.',
    defaultModel: 'anthropic/claude-sonnet-4.5', keyLabel: 'OpenRouter API key (sk-or-…)', keyUrl: 'https://openrouter.ai/keys',
  },
  perplexity: {
    group: 'Research', name: 'Perplexity',
    reasoning: 'Grounded research with live web citations. Powers keyword, category and competitor research — never drafting.',
    defaultModel: 'sonar-pro', keyLabel: 'Perplexity API key (pplx-…)', keyUrl: 'https://www.perplexity.ai/settings/api',
  },
  googlebooks: {
    group: 'Research', name: 'Google Books',
    reasoning: 'Free metadata about published books (title, author, ratings, some prices). Powers competitor lookups and weekly re-checks.',
    defaultModel: null, keyLabel: 'Google Books API key (optional — works without one at low volume)', keyUrl: 'https://console.cloud.google.com/apis/library/books.googleapis.com',
  },
  ideogram: {
    group: 'Media', name: 'Ideogram',
    reasoning: 'Social images and banners with accurate text on the image — first choice for cover-derived graphics.',
    defaultModel: 'V_3', keyLabel: 'Ideogram API key', keyUrl: 'https://ideogram.ai/api',
  },
  elevenlabs: {
    group: 'Media', name: 'ElevenLabs',
    reasoning: 'AI narration for audio editions, chapter by chapter. Some stores do not accept AI narration — the Editions tab shows which do. Amazon’s own Virtual Voice (KDP beta) is a free alternative for Kindle ebooks.',
    defaultModel: 'eleven_multilingual_v2', keyLabel: 'ElevenLabs API key', keyUrl: 'https://elevenlabs.io/app/settings/api-keys',
  },
  deepl: {
    group: 'Media', name: 'DeepL',
    reasoning: 'Translated editions and localized metadata — strong machine translation with real glossaries. Always followed by the native-reviewer step.',
    defaultModel: null, keyLabel: 'DeepL API key (free keys end in :fx)', keyUrl: 'https://www.deepl.com/your-account/keys',
  },
  brevo: {
    group: 'Email', name: 'Brevo (email service)',
    reasoning: 'First choice for email: sends ARC and pitch emails, syncs confirmed readers to a list and sends launch campaigns. Set the sender email and list ID on the card.',
    defaultModel: null, keyLabel: 'Brevo API key (xkeysib-…)', keyUrl: 'https://app.brevo.com/settings/keys/api',
    extraFields: [['from', 'Sender email (verified in Brevo)'], ['fromName', 'Sender name'], ['listId', 'Reader list ID (number)']],
  },
  mailerlite: {
    group: 'Email', name: 'MailerLite (email service)',
    reasoning: 'Alternative email service — syncs confirmed readers to a MailerLite group. Use if the list already lives there.',
    defaultModel: null, keyLabel: 'MailerLite API token', keyUrl: 'https://dashboard.mailerlite.com/integrations/api',
    extraFields: [['from', 'Sender email'], ['groupId', 'Reader group ID']],
  },
  gmail: {
    group: 'Email', name: 'Gmail API',
    reasoning: 'Send one-to-one emails (pitches, ARC requests) from your own Gmail. Paste the OAuth refresh token plus client ID and secret — the app refreshes access tokens itself.',
    defaultModel: null, keyLabel: 'Gmail OAuth refresh token', keyUrl: 'https://console.cloud.google.com/apis/credentials',
    extraFields: [['clientId', 'OAuth client ID'], ['clientSecret', 'OAuth client secret'], ['from', 'From address (your Gmail)']],
  },
  linkedin: {
    group: 'Social', name: 'LinkedIn (posting)',
    reasoning: 'Posts approved content to your LinkedIn profile on schedule (Share on LinkedIn, w_member_social). Access tokens last about 60 days — the app warns before expiry.',
    defaultModel: null, keyLabel: 'LinkedIn member access token', keyUrl: 'https://www.linkedin.com/developers/apps',
    extraFields: [['authorUrn', 'Author URN (urn:li:person:…) — filled by Test'], ['version', 'LinkedIn-Version (YYYYMM)'], ['expires', 'Token expiry date (YYYY-MM-DD)']],
  },
  facebook: {
    group: 'Social', name: 'Facebook Page (posting)',
    reasoning: 'Posts approved content to the Lamp & Path Facebook Page on schedule via the Graph API (page access token).',
    defaultModel: null, keyLabel: 'Page access token', keyUrl: 'https://developers.facebook.com/tools/explorer/',
    extraFields: [['pageId', 'Page ID'], ['version', 'Graph API version (e.g. v21.0)']],
  },
  instagram: {
    group: 'Social', name: 'Instagram (posting)',
    reasoning: 'Posts approved content with an image to an Instagram professional account via the Graph API. Instagram needs a public image URL per post.',
    defaultModel: null, keyLabel: 'Access token (with instagram_content_publish)', keyUrl: 'https://developers.facebook.com/docs/instagram-platform/',
    extraFields: [['igUserId', 'Instagram user ID'], ['version', 'Graph API version (e.g. v21.0)']],
  },
  x: {
    group: 'Social', name: 'X (posting)',
    reasoning: 'Posts to X via API v2 with an OAuth 2.0 user token. Posting needs a paid X API tier — check current X pricing first.',
    defaultModel: null, keyLabel: 'OAuth 2.0 user access token (tweet.write)', keyUrl: 'https://developer.x.com/en/portal/dashboard',
  },
};

const NOT_CONNECTABLE = [
  { name: 'Amazon sales / rank data', reason: 'No public API covers Amazon sales or category rank. Import the KDP report (CSV or XLSX) — the importer matches rows to books by ASIN/ISBN/title. Rank history is typed in or imported. Scraping Amazon violates its terms.' },
  { name: 'KDP upload / KDP sales API', reason: 'KDP has no upload API and no sales API. Publishing stays a manual step — the app prepares copy-ready fields per marketplace and you press Publish in KDP yourself.' },
  { name: 'Kindle Translate / Virtual Voice', reason: 'Amazon’s own AI translation and AI narration are KDP features (beta, invite or eligibility based) inside the KDP Bookshelf — no API. The Editions tab tracks them as options.' },
  { name: 'Grammarly', reason: 'No public API.' },
  { name: 'Goodreads / BookBub data', reason: 'Goodreads closed its public API to new keys in 2020; BookBub has no public API. Their profiles are tracked in the author platform checklist.' },
];

// Approximate USD costs — starting estimates only; check vendor pricing.
const COST_PER_1M = {
  anthropic: [3, 15], openai: [1.25, 10], gemini: [1.25, 10],
  meta: [0.5, 2], // UNVERIFIED
  openrouter: [2, 10], perplexity: [3, 15],
  deepl: [25, 0], // per 1M characters, approx (Pro)
  elevenlabs: [180, 0], // per 1M characters, approx — varies by plan
};
const TEXT_PROVIDERS = ['anthropic', 'openai', 'gemini', 'meta', 'openrouter', 'perplexity'];

function getConnection(provider) {
  const row = db.get('SELECT * FROM api_connections WHERE provider = ?', [provider]);
  if (!row) return null;
  let key = '';
  try { key = decrypt(row.enc_key); } catch { key = ''; }
  let extra = {};
  try { extra = JSON.parse(row.extra || '{}'); } catch { extra = {}; }
  return { ...row, apiKey: key, extra };
}

function isConnected(provider) {
  const c = getConnection(provider);
  return !!(c && c.apiKey);
}

function listProviders() {
  return Object.entries(PROVIDERS).map(([key, p]) => {
    const conn = getConnection(key);
    return {
      provider: key, group: p.group, name: p.name, reasoning: p.reasoning || '',
      keyLabel: p.keyLabel, keyUrl: p.keyUrl, defaultModel: p.defaultModel || '',
      model: conn?.extra?.model || '',
      extraFields: (p.extraFields || []).map(([k, label]) => ({ key: k, label, value: conn?.extra?.[k] || '' })),
      connected: !!conn && !!conn.apiKey,
      label: conn ? conn.label || '' : '',
      hint: conn && conn.apiKey ? '••••' + conn.apiKey.slice(-4) : '',
      lastUsed: conn ? conn.updated_at : '',
    };
  });
}

function saveConnection(provider, apiKey, label, extra, { keepKey = false } = {}) {
  if (!PROVIDERS[provider]) throw new Error('Unknown provider: ' + provider);
  const existing = getConnection(provider);
  const key = keepKey && existing ? existing.apiKey : (apiKey || '');
  const mergedExtra = { ...(existing?.extra || {}), ...(extra || {}) };
  const enc = encrypt(key);
  const extraJson = JSON.stringify(mergedExtra);
  if (existing) {
    db.exec("UPDATE api_connections SET enc_key = ?, label = ?, extra = ?, updated_at = datetime('now') WHERE provider = ?", [enc, label || existing.label || '', extraJson, provider]);
  } else {
    db.exec('INSERT INTO api_connections (provider, label, enc_key, extra) VALUES (?, ?, ?, ?)', [provider, label || '', enc, extraJson]);
  }
}

function deleteConnection(provider) {
  db.exec('DELETE FROM api_connections WHERE provider = ?', [provider]);
}

// ---- cost meter + budgets ----
function estimateCost(provider, unitsIn, unitsOut) {
  const c = COST_PER_1M[provider];
  if (!c) return 0;
  return (unitsIn / 1e6) * c[0] + (unitsOut / 1e6) * c[1];
}

function logUsage(provider, model, bookId, task, tokensIn, tokensOut, cost) {
  db.exec(
    'INSERT INTO usage_log (provider, model, book_id, task, tokens_in, tokens_out, cost_usd) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [provider, model || '', bookId || null, task || '', tokensIn || 0, tokensOut || 0, cost || 0]
  );
}

function monthSpend(provider, month) {
  const m = month || new Date().toISOString().slice(0, 7);
  const row = provider
    ? db.get("SELECT COALESCE(SUM(cost_usd), 0) AS s FROM usage_log WHERE provider = ? AND strftime('%Y-%m', created_at) = ?", [provider, m])
    : db.get("SELECT COALESCE(SUM(cost_usd), 0) AS s FROM usage_log WHERE strftime('%Y-%m', created_at) = ?", [m]);
  return row ? row.s : 0;
}

function bookSpend(bookId) {
  const row = db.get('SELECT COALESCE(SUM(cost_usd), 0) AS s FROM usage_log WHERE book_id = ?', [bookId]);
  return row ? row.s : 0;
}

// Budget kinds: provider (monthly, per provider), book (lifetime, per
// book), monthly (all providers together for one month; ref = YYYY-MM,
// or "every" for every month).
function budgetStatus(kind, ref) {
  const b = db.get('SELECT * FROM budgets WHERE kind = ? AND ref = ?', [kind, ref]);
  if (!b) return { limit: null, spent: 0, pct: 0, percent: 0, blocked: false, warn: false };
  let spent = 0;
  if (kind === 'provider') spent = monthSpend(ref);
  else if (kind === 'book') spent = bookSpend(parseInt(ref, 10) || 0);
  else if (kind === 'monthly') spent = monthSpend(null, ref === 'every' ? undefined : ref);
  const pct = b.limit_usd > 0 ? spent / b.limit_usd : 0;
  return { limit: b.limit_usd, spent, pct, percent: Math.round(pct * 100), warn: pct >= 0.8 && pct < 1, blocked: pct >= 1 };
}

function checkBudgets(provider, bookId) {
  const p = budgetStatus('provider', provider);
  if (p.blocked) throw new Error(`Monthly budget for ${PROVIDERS[provider]?.name || provider} is used up ($${p.spent.toFixed(2)} of $${p.limit.toFixed(2)}). Raise it in Settings → Budgets.`);
  const month = new Date().toISOString().slice(0, 7);
  for (const ref of [month, 'every']) {
    const m = budgetStatus('monthly', ref);
    if (m.blocked) throw new Error(`The overall monthly AI budget is used up ($${m.spent.toFixed(2)} of $${m.limit.toFixed(2)}). Raise it in Settings → Budgets.`);
  }
  if (bookId) {
    const b = budgetStatus('book', String(bookId));
    if (b.blocked) throw new Error(`Budget for this book is used up ($${b.spent.toFixed(2)} of $${b.limit.toFixed(2)}). Raise it in Settings → Budgets.`);
  }
}

// ---- text completion ----
async function readError(res) { try { return (await res.text()).slice(0, 300); } catch { return ''; } }

async function callAnthropic(conn, model, system, prompt, maxTokens, temperature) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': conn.apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model, max_tokens: maxTokens || 4000, temperature, system: system || undefined, messages: [{ role: 'user', content: prompt }] }),
  });
  if (!res.ok) throw new Error(`Anthropic API error ${res.status}: ${await readError(res)}`);
  const data = await res.json();
  const text = (data.content || []).map((c) => c.text || '').join('');
  return { text, in: data.usage?.input_tokens || 0, out: data.usage?.output_tokens || 0, model: data.model || model };
}

async function callOpenAICompatible(url, conn, model, system, prompt, maxTokens, temperature, extraHeaders = {}, tokenField = 'max_tokens') {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${conn.apiKey}`, ...extraHeaders },
    body: JSON.stringify({
      model,
      messages: [...(system ? [{ role: 'system', content: system }] : []), { role: 'user', content: prompt }],
      [tokenField]: maxTokens || 4000,
      ...(temperature !== undefined ? { temperature } : {}),
    }),
  });
  if (!res.ok) throw new Error(`API error ${res.status}: ${await readError(res)}`);
  const data = await res.json();
  let text = data.choices?.[0]?.message?.content || '';
  if (Array.isArray(data.citations) && data.citations.length) {
    text += '\n\nSources:\n' + data.citations.map((c, i) => `[${i + 1}] ${typeof c === 'string' ? c : c.url || ''}`).join('\n');
  }
  return { text, in: data.usage?.prompt_tokens || 0, out: data.usage?.completion_tokens || 0, model: data.model || model };
}

async function callGemini(conn, model, system, prompt, maxTokens, temperature) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': conn.apiKey },
    body: JSON.stringify({
      ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: maxTokens || 4000, ...(temperature !== undefined ? { temperature } : {}) },
    }),
  });
  if (!res.ok) throw new Error(`Gemini API error ${res.status}: ${await readError(res)}`);
  const data = await res.json();
  const text = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
  return { text, in: data.usageMetadata?.promptTokenCount || 0, out: data.usageMetadata?.candidatesTokenCount || 0, model };
}

async function completeText({ provider, system, prompt, maxTokens = 4000, temperature, model: modelOverride }) {
  const conn = getConnection(provider);
  if (!conn || !conn.apiKey) throw new Error(`${PROVIDERS[provider]?.name || provider} is not connected — add a key in Settings.`);
  const model = modelOverride || conn.extra.model || PROVIDERS[provider].defaultModel;
  if (provider === 'anthropic') return callAnthropic(conn, model, system, prompt, maxTokens, temperature);
  if (provider === 'gemini') return callGemini(conn, model, system, prompt, maxTokens, temperature);
  if (provider === 'openai') return callOpenAICompatible('https://api.openai.com/v1/chat/completions', conn, model, system, prompt, maxTokens, temperature, {}, 'max_completion_tokens');
  if (provider === 'perplexity') return callOpenAICompatible('https://api.perplexity.ai/chat/completions', conn, model, system, prompt, maxTokens, temperature);
  if (provider === 'meta') {
    const base = (conn.extra.baseUrl || PROVIDERS.meta.baseUrl).replace(/\/$/, '');
    return callOpenAICompatible(`${base}/chat/completions`, conn, model, system, prompt, maxTokens, temperature);
  }
  if (provider === 'openrouter') {
    return callOpenAICompatible('https://openrouter.ai/api/v1/chat/completions', conn, model, system, prompt, maxTokens, temperature, {
      'HTTP-Referer': 'https://bookmarketing.amaldas.si', 'X-Title': 'Book Marketing Studio',
    });
  }
  throw new Error(`Provider ${provider} does not do text completion.`);
}

// Run one marketing task through its route (first choice, then fallback,
// then any other connected text provider), logging usage + cost. Falls
// back to a clearly-labelled local draft when no key works.
async function completeTask({ task, bookId, system, prompt, maxTokens, temperature }) {
  const route = db.get('SELECT * FROM task_routes WHERE task = ?', [task]);
  const promptRow = db.get('SELECT version FROM prompts WHERE task = ? ORDER BY id DESC LIMIT 1', [task]);
  const tries = [];
  const add = (provider, model) => {
    if (provider && TEXT_PROVIDERS.includes(provider) && !tries.some((t) => t.provider === provider)) tries.push({ provider, model: model || '' });
  };
  if (route) { add(route.provider, route.model); add(route.fallback_provider, route.fallback_model); }
  for (const p of TEXT_PROVIDERS) if (isConnected(p)) add(p, '');
  let lastErr = null;
  for (const t of tries) {
    if (!isConnected(t.provider)) continue;
    try {
      checkBudgets(t.provider, bookId);
      const out = await completeText({
        provider: t.provider, system, prompt,
        maxTokens: maxTokens || route?.max_tokens || 4000,
        temperature: temperature ?? route?.temperature ?? undefined,
        model: t.model || undefined,
      });
      const cost = estimateCost(t.provider, out.in, out.out);
      logUsage(t.provider, out.model, bookId, task, out.in, out.out, cost);
      return { text: out.text, provider: t.provider, model: out.model, cost, promptVersion: promptRow?.version || '', local: false };
    } catch (e) { lastErr = e; }
  }
  return {
    text: localDraft(task, prompt),
    provider: 'local', model: 'template', cost: 0, promptVersion: promptRow?.version || '', local: true,
    note: lastErr ? `No provider worked (${lastErr.message}). Local template draft — add a key in Settings for real AI output.` : 'No provider key saved — local template draft. Add a key in Settings for real AI output.',
  };
}

function localDraft(task, prompt) {
  const titleLine = String(prompt || '').split('\n').find((l) => /^Book:/.test(l)) || String(prompt || '').split('\n').find((l) => l.trim()) || 'this book';
  return `[LOCAL DRAFT — no AI provider key is connected. Add a key in Settings → API vault for a real draft.]\n\nTask: ${task}\n${titleLine}\n\nFill this in from the book metadata: what the reader gets, why it matters, and one concrete promise. Keep it in the imprint voice — plain, direct, practical.`;
}

// ---- research ----
async function research({ task = 'research', bookId, system, prompt, maxTokens = 3000 }) {
  // Prefer a grounded provider (Perplexity) for anything that should
  // reflect the live market; completeTask's route already puts it first.
  return completeTask({ task, bookId, system: system || 'You are a careful book-market researcher. Cite sources for any factual claim about the live market. Mark judgment calls as such.', prompt, maxTokens });
}

async function googleBooksLookup(q) {
  const conn = getConnection('googlebooks');
  const url = 'https://www.googleapis.com/books/v1/volumes?q=' + encodeURIComponent(q) + '&maxResults=10'
    + (conn && conn.apiKey ? `&key=${encodeURIComponent(conn.apiKey)}` : '');
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Google Books error ${res.status}`);
  const data = await res.json();
  return (data.items || []).map(volumeSummary);
}

async function googleBooksVolume(id) {
  const conn = getConnection('googlebooks');
  const res = await fetch(`https://www.googleapis.com/books/v1/volumes/${encodeURIComponent(id)}` + (conn && conn.apiKey ? `?key=${encodeURIComponent(conn.apiKey)}` : ''));
  if (!res.ok) throw new Error(`Google Books error ${res.status}`);
  return volumeSummary(await res.json());
}

function volumeSummary(it) {
  const v = it.volumeInfo || {};
  const sale = it.saleInfo || {};
  const isbn = (v.industryIdentifiers || []).find((x) => x.type === 'ISBN_13')?.identifier || '';
  return {
    id: it.id, title: v.title || '', author: (v.authors || []).join(', '), description: v.description || '',
    categories: v.categories || [], publishedDate: v.publishedDate || '', pageCount: v.pageCount || 0, isbn,
    ratingsCount: v.ratingsCount ?? null, averageRating: v.averageRating ?? null,
    price: sale.retailPrice?.amount ?? sale.listPrice?.amount ?? null, currency: sale.retailPrice?.currencyCode || sale.listPrice?.currencyCode || '',
  };
}

// ---- images ----
async function generateImage(prompt, { aspect = '1x1' } = {}) {
  const ideo = getConnection('ideogram');
  if (ideo && ideo.apiKey) {
    // Ideogram 3.0 takes multipart form data.
    const form = new FormData();
    form.append('prompt', prompt);
    form.append('aspect_ratio', aspect);
    form.append('rendering_speed', 'DEFAULT');
    form.append('magic_prompt', 'AUTO');
    const res = await fetch('https://api.ideogram.ai/v1/ideogram-v3/generate', {
      method: 'POST', headers: { 'Api-Key': ideo.apiKey }, body: form,
    });
    if (!res.ok) throw new Error(`Ideogram error ${res.status}: ${await readError(res)}`);
    const data = await res.json();
    const url = data.data?.[0]?.url;
    if (url) { logUsage('ideogram', 'v3', null, 'image', 0, 0, 0.08); return { url, provider: 'ideogram' }; }
  }
  const oai = getConnection('openai');
  if (oai && oai.apiKey) {
    const size = aspect === '16x9' ? '1536x1024' : aspect === '9x16' ? '1024x1536' : '1024x1024';
    const res = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${oai.apiKey}` },
      body: JSON.stringify({ model: 'gpt-image-1', prompt, size }),
    });
    if (!res.ok) throw new Error(`OpenAI image error ${res.status}: ${await readError(res)}`);
    const data = await res.json();
    logUsage('openai', 'gpt-image-1', null, 'image', 0, 0, 0.06);
    if (data.data?.[0]?.url) return { url: data.data[0].url, provider: 'openai' };
    if (data.data?.[0]?.b64_json) return { b64: data.data[0].b64_json, provider: 'openai' };
  }
  return { url: '', provider: 'none', note: 'No image key saved (Ideogram or OpenAI). Use the typographic template instead.' };
}

// ---- audio (ElevenLabs) ----
async function elevenLabsVoices() {
  const conn = getConnection('elevenlabs');
  if (!conn || !conn.apiKey) throw new Error('ElevenLabs is not connected — add a key in Settings.');
  const res = await fetch('https://api.elevenlabs.io/v1/voices', { headers: { 'xi-api-key': conn.apiKey } });
  if (!res.ok) throw new Error(`ElevenLabs error ${res.status}`);
  const data = await res.json();
  return (data.voices || []).map((v) => ({ id: v.voice_id, name: v.name }));
}

async function elevenLabsSpeak(text, voiceId, { bookId } = {}) {
  const conn = getConnection('elevenlabs');
  if (!conn || !conn.apiKey) throw new Error('ElevenLabs is not connected — add a key in Settings.');
  checkBudgets('elevenlabs', bookId);
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'xi-api-key': conn.apiKey },
    body: JSON.stringify({ text, model_id: conn.extra.model || PROVIDERS.elevenlabs.defaultModel, voice_settings: { stability: 0.5, similarity_boost: 0.75 } }),
  });
  if (!res.ok) throw new Error(`ElevenLabs error ${res.status}: ${await readError(res)}`);
  logUsage('elevenlabs', conn.extra.model || PROVIDERS.elevenlabs.defaultModel, bookId, 'audio', text.length, 0, estimateCost('elevenlabs', text.length, 0));
  return Buffer.from(await res.arrayBuffer());
}

// Split long text at sentence/paragraph boundaries into pieces <= max chars.
function chunkText(text, max = 4500) {
  const out = [];
  let rest = String(text || '').trim();
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n\n', max);
    if (cut < max * 0.5) cut = rest.lastIndexOf('. ', max);
    if (cut < max * 0.5) cut = rest.lastIndexOf(' ', max);
    if (cut <= 0) cut = max;
    out.push(rest.slice(0, cut + 1).trim());
    rest = rest.slice(cut + 1).trim();
  }
  if (rest) out.push(rest);
  return out;
}

// ---- translation (DeepL with real glossaries, LLM fallback) ----
function deeplBase(key) { return /:fx$/.test(key) ? 'https://api-free.deepl.com' : 'https://api.deepl.com'; }

// Glossary text format: one "source term = target term" per line.
function parseGlossary(text) {
  return String(text || '').split('\n').map((l) => l.split('=').map((s) => s.trim())).filter((p) => p.length === 2 && p[0] && p[1]);
}

async function deeplGlossaryId(conn, sourceLang, targetLang, glossaryText) {
  const pairs = parseGlossary(glossaryText);
  if (!pairs.length) return null;
  const res = await fetch(`${deeplBase(conn.apiKey)}/v2/glossaries`, {
    method: 'POST',
    headers: { authorization: `DeepL-Auth-Key ${conn.apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      name: `bms-${Date.now()}`, source_lang: sourceLang.slice(0, 2).toLowerCase(), target_lang: targetLang.slice(0, 2).toLowerCase(),
      entries: pairs.map(([a, b]) => `${a.replace(/\t/g, ' ')}\t${b.replace(/\t/g, ' ')}`).join('\n'), entries_format: 'tsv',
    }),
  });
  if (!res.ok) throw new Error(`DeepL glossary error ${res.status}: ${await readError(res)}`);
  return (await res.json()).glossary_id || null;
}

async function deeplTranslate(text, targetLang, { glossary, sourceLang = 'EN', bookId, context } = {}) {
  const conn = getConnection('deepl');
  if (!conn || !conn.apiKey) throw new Error('DeepL is not connected — add a key in Settings.');
  checkBudgets('deepl', bookId);
  const glossaryId = glossary ? await deeplGlossaryId(conn, sourceLang, targetLang, glossary) : null;
  const parts = chunkText(text, 25000);
  const res = await fetch(`${deeplBase(conn.apiKey)}/v2/translate`, {
    method: 'POST',
    headers: { authorization: `DeepL-Auth-Key ${conn.apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      text: parts, target_lang: targetLang, ...(glossaryId || sourceLang ? { source_lang: sourceLang.slice(0, 2).toUpperCase() } : {}),
      ...(glossaryId ? { glossary_id: glossaryId } : {}), ...(context ? { context } : {}), preserve_formatting: true,
    }),
  });
  if (!res.ok) throw new Error(`DeepL error ${res.status}: ${await readError(res)}`);
  const data = await res.json();
  logUsage('deepl', 'deepl', bookId, 'translation', text.length, 0, estimateCost('deepl', text.length, 0));
  return (data.translations || []).map((t) => t.text).join('\n\n');
}

// Translate following the "translation" route: DeepL first when it is the
// route's choice and connected, otherwise an LLM with the glossary.
async function translateText(text, targetLang, { glossary, bookId, faith } = {}) {
  const route = db.get("SELECT * FROM task_routes WHERE task = 'translation'");
  const order = [route?.provider || 'deepl', route?.fallback_provider || 'anthropic'];
  let lastErr = null;
  for (const p of order) {
    if (p === 'deepl' && isConnected('deepl')) {
      try { return { text: await deeplTranslate(text, deeplLangCode(targetLang), { glossary, bookId }), provider: 'deepl' }; } catch (e) { lastErr = e; }
    }
  }
  const out = await completeTask({
    task: 'translation', bookId,
    system: `You are a professional literary translator into ${targetLang}. Translate accurately and naturally; keep names, headings and paragraph breaks.${faith ? ' Scripture: use an established Bible translation in the target language and mark each verse [VERIFY SCRIPTURE].' : ''}`,
    prompt: `Translate into ${targetLang}. Glossary (use these exact terms): ${glossary || 'none'}.\n\n${text}`,
    maxTokens: Math.min(16000, Math.ceil(text.length / 2) + 500),
  });
  if (out.local && lastErr) out.note = `DeepL failed (${lastErr.message}). ${out.note || ''}`;
  return { text: out.text, provider: out.provider, local: out.local, note: out.note };
}

const DEEPL_CODES = {
  german: 'DE', french: 'FR', spanish: 'ES', italian: 'IT', portuguese: 'PT-BR', 'portuguese (brazil)': 'PT-BR', 'portuguese (portugal)': 'PT-PT',
  dutch: 'NL', polish: 'PL', japanese: 'JA', chinese: 'ZH-HANS', korean: 'KO', swedish: 'SV', danish: 'DA', finnish: 'FI', norwegian: 'NB',
  czech: 'CS', greek: 'EL', hungarian: 'HU', romanian: 'RO', turkish: 'TR', ukrainian: 'UK', russian: 'RU', indonesian: 'ID', english: 'EN-US', arabic: 'AR',
};
function deeplLangCode(lang) {
  const l = String(lang || '').trim();
  if (/^[A-Z]{2}(-[A-Z]{2,4})?$/.test(l)) return l;
  return DEEPL_CODES[l.toLowerCase()] || l.toUpperCase().slice(0, 2);
}

// ---- email ----
let gmailToken = { token: '', exp: 0 };
async function gmailAccessToken(conn) {
  if (gmailToken.token && Date.now() < gmailToken.exp - 60000) return gmailToken.token;
  if (!conn.extra.clientId || !conn.extra.clientSecret) {
    // Older setup: an access token was pasted directly.
    return conn.apiKey;
  }
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: conn.extra.clientId, client_secret: conn.extra.clientSecret, refresh_token: conn.apiKey, grant_type: 'refresh_token' }).toString(),
  });
  if (!res.ok) throw new Error(`Gmail token refresh failed ${res.status}: ${await readError(res)}`);
  const d = await res.json();
  gmailToken = { token: d.access_token, exp: Date.now() + (d.expires_in || 3600) * 1000 };
  return gmailToken.token;
}

function encodeHeader(s) { return /[^\x20-\x7e]/.test(s) ? `=?UTF-8?B?${Buffer.from(s).toString('base64')}?=` : s; }

// Send one email. `prefer` picks a provider ("gmail" for one-to-one
// pitches); otherwise Brevo → MailerLite → Gmail. `unsubscribeUrl` adds the
// List-Unsubscribe header (required for marketing mail to readers).
async function sendEmail({ to, subject, html, text, prefer, unsubscribeUrl }) {
  const order = prefer ? [prefer, 'brevo', 'mailerlite', 'gmail'] : ['brevo', 'mailerlite', 'gmail'];
  const tried = new Set();
  let lastErr = null;
  for (const p of order) {
    if (tried.has(p)) continue; tried.add(p);
    const conn = getConnection(p);
    if (!conn || !conn.apiKey) continue;
    try {
      if (p === 'brevo') {
        const from = conn.extra.from || '';
        if (!from) throw new Error('Brevo needs a verified sender email on its Settings card.');
        const res = await fetch('https://api.brevo.com/v3/smtp/email', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'api-key': conn.apiKey },
          body: JSON.stringify({
            sender: { email: from, name: conn.extra.fromName || undefined }, to: [{ email: to }], subject,
            htmlContent: html || `<p>${String(text || '').replace(/\n/g, '<br>')}</p>`, textContent: text || undefined,
            ...(unsubscribeUrl ? { headers: { 'List-Unsubscribe': `<${unsubscribeUrl}>` } } : {}),
          }),
        });
        if (!res.ok) throw new Error(`Brevo error ${res.status}: ${await readError(res)}`);
        return { provider: 'brevo', messageId: (await res.json()).messageId || '' };
      }
      if (p === 'mailerlite') {
        // MailerLite has no single-message send API — it is used for list sync only.
        continue;
      }
      if (p === 'gmail') {
        const token = await gmailAccessToken(conn);
        const headers = [`To: ${to}`, `Subject: ${encodeHeader(subject)}`, 'MIME-Version: 1.0', 'Content-Type: text/html; charset=utf-8'];
        if (conn.extra.from) headers.unshift(`From: ${conn.extra.from}`);
        if (unsubscribeUrl) headers.push(`List-Unsubscribe: <${unsubscribeUrl}>`);
        const body = html || `<p>${String(text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\n/g, '<br>')}</p>`;
        const raw = Buffer.from(headers.join('\r\n') + '\r\n\r\n' + body).toString('base64url');
        const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
          method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ raw }),
        });
        if (!res.ok) throw new Error(`Gmail error ${res.status}: ${await readError(res)}`);
        return { provider: 'gmail', messageId: (await res.json()).id || '' };
      }
    } catch (e) { lastErr = e; }
  }
  throw new Error(lastErr ? lastErr.message : 'No email provider is connected. Add Brevo (or a Gmail OAuth token) in Settings → API vault.');
}

// Sync one confirmed reader to the email service list (Brevo list and/or
// MailerLite group). Silent no-op when nothing is configured.
async function syncSubscriber({ email, name, unsubscribe = false }) {
  const done = [];
  const brevo = getConnection('brevo');
  if (brevo && brevo.apiKey && brevo.extra.listId) {
    const listId = parseInt(brevo.extra.listId, 10);
    const body = unsubscribe
      ? { email, unlinkListIds: [listId], updateEnabled: true }
      : { email, attributes: name ? { FIRSTNAME: name } : undefined, listIds: [listId], updateEnabled: true };
    const res = await fetch('https://api.brevo.com/v3/contacts', { method: 'POST', headers: { 'content-type': 'application/json', 'api-key': brevo.apiKey }, body: JSON.stringify(body) });
    if (res.ok || res.status === 204) done.push('brevo');
  }
  const ml = getConnection('mailerlite');
  if (ml && ml.apiKey && ml.extra.groupId && !unsubscribe) {
    const res = await fetch('https://connect.mailerlite.com/api/subscribers', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${ml.apiKey}` },
      body: JSON.stringify({ email, fields: name ? { name } : undefined, groups: [String(ml.extra.groupId)] }),
    });
    if (res.ok) done.push('mailerlite');
  }
  return done;
}

// Send a campaign to the whole reader list through Brevo (the list lives
// there, unsubscribes are handled by Brevo).
async function sendListCampaign({ subject, html, name }) {
  const brevo = getConnection('brevo');
  if (!brevo || !brevo.apiKey || !brevo.extra.listId || !brevo.extra.from) {
    throw new Error('List campaigns need Brevo with a sender email and reader list ID on its Settings card.');
  }
  const headers = { 'content-type': 'application/json', 'api-key': brevo.apiKey };
  const res = await fetch('https://api.brevo.com/v3/emailCampaigns', {
    method: 'POST', headers,
    body: JSON.stringify({
      name: name || subject, subject, sender: { email: brevo.extra.from, name: brevo.extra.fromName || undefined },
      htmlContent: html + '<p style="font-size:12px;color:#888">You are receiving this because you joined the reader list. <a href="{{ unsubscribe }}">Unsubscribe</a></p>',
      recipients: { listIds: [parseInt(brevo.extra.listId, 10)] },
    }),
  });
  if (!res.ok) throw new Error(`Brevo campaign error ${res.status}: ${await readError(res)}`);
  const { id } = await res.json();
  const send = await fetch(`https://api.brevo.com/v3/emailCampaigns/${id}/sendNow`, { method: 'POST', headers });
  if (!send.ok && send.status !== 204) throw new Error(`Brevo send error ${send.status}: ${await readError(send)}`);
  return { provider: 'brevo', id: String(id) };
}

// ---- test connection ----
async function testConnection(provider, apiKey, extra = {}) {
  const saved = getConnection(provider);
  const key = apiKey || saved?.apiKey || '';
  const ex = { ...(saved?.extra || {}), ...(extra || {}) };
  if (!key && provider !== 'googlebooks') return { ok: false, detail: 'No key saved yet — paste one and press Save first.' };
  const j = async (res, label) => { if (!res.ok) throw new Error(`${label} error ${res.status}: ${await readError(res)}`); return res.json(); };
  switch (provider) {
    case 'googlebooks': {
      await j(await fetch('https://www.googleapis.com/books/v1/volumes?q=isbn:9780134685991' + (key ? `&key=${encodeURIComponent(key)}` : '')), 'Google Books');
      return { ok: true, detail: 'Google Books answered.' };
    }
    case 'brevo': {
      const d = await j(await fetch('https://api.brevo.com/v3/account', { headers: { 'api-key': key } }), 'Brevo');
      return { ok: true, detail: `Brevo account: ${d.email || d.companyName || 'connected'}.${ex.listId ? '' : ' Add the reader list ID to sync readers and send campaigns.'}` };
    }
    case 'mailerlite': {
      const d = await j(await fetch('https://connect.mailerlite.com/api/me', { headers: { authorization: `Bearer ${key}` } }), 'MailerLite');
      return { ok: true, detail: `MailerLite account: ${d.data?.name || d.data?.email || 'connected'}.` };
    }
    case 'elevenlabs': {
      await j(await fetch('https://api.elevenlabs.io/v1/user', { headers: { 'xi-api-key': key } }), 'ElevenLabs');
      return { ok: true, detail: 'ElevenLabs account connected.' };
    }
    case 'deepl': {
      const d = await j(await fetch(`${deeplBase(key)}/v2/usage`, { headers: { authorization: `DeepL-Auth-Key ${key}` } }), 'DeepL');
      return { ok: true, detail: `DeepL connected — ${d.character_count ?? 0} of ${d.character_limit ?? '?'} characters used this period.` };
    }
    case 'ideogram':
      return { ok: true, detail: 'Ideogram key saved. (Not tested — every Ideogram call generates a paid image.)' };
    case 'gmail': {
      gmailToken = { token: '', exp: 0 };
      const conn = { apiKey: key, extra: ex };
      const token = await gmailAccessToken(conn);
      const d = await j(await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', { headers: { authorization: `Bearer ${token}` } }), 'Gmail');
      return { ok: true, detail: `Gmail connected as ${d.emailAddress}.` };
    }
    case 'linkedin': {
      const d = await j(await fetch('https://api.linkedin.com/v2/userinfo', { headers: { authorization: `Bearer ${key}` } }), 'LinkedIn');
      if (d.sub && saved) saveConnection('linkedin', '', saved.label, { authorUrn: `urn:li:person:${d.sub}` }, { keepKey: true });
      return { ok: true, detail: `LinkedIn connected as ${d.name || d.email || d.sub}. Author URN saved.` };
    }
    case 'facebook': {
      if (!ex.pageId) return { ok: false, detail: 'Add the Page ID on the card.' };
      const d = await j(await fetch(`https://graph.facebook.com/${ex.version || 'v21.0'}/${encodeURIComponent(ex.pageId)}?fields=name&access_token=${encodeURIComponent(key)}`), 'Facebook');
      return { ok: true, detail: `Facebook Page: ${d.name}.` };
    }
    case 'instagram': {
      if (!ex.igUserId) return { ok: false, detail: 'Add the Instagram user ID on the card.' };
      const d = await j(await fetch(`https://graph.facebook.com/${ex.version || 'v21.0'}/${encodeURIComponent(ex.igUserId)}?fields=username&access_token=${encodeURIComponent(key)}`), 'Instagram');
      return { ok: true, detail: `Instagram account: @${d.username}.` };
    }
    case 'x': {
      const d = await j(await fetch('https://api.x.com/2/users/me', { headers: { authorization: `Bearer ${key}` } }), 'X');
      return { ok: true, detail: `X account: @${d.data?.username}.` };
    }
    default: {
      const probe = { provider, system: 'Reply with the single word OK.', prompt: 'OK', maxTokens: 16 };
      if (apiKey) {
        const prev = saved;
        saveConnection(provider, apiKey, prev?.label || '', prev?.extra || {});
        try {
          const out = await completeText(probe);
          return { ok: true, detail: `${PROVIDERS[provider].name} answered (${out.model}).` };
        } finally {
          if (prev) saveConnection(provider, prev.apiKey, prev.label, prev.extra);
          else deleteConnection(provider);
        }
      }
      const out = await completeText(probe);
      return { ok: true, detail: `${PROVIDERS[provider].name} answered (${out.model}).` };
    }
  }
}

module.exports = {
  PROVIDERS, NOT_CONNECTABLE, TEXT_PROVIDERS, getConnection, isConnected, listProviders, saveConnection, deleteConnection,
  completeText, completeTask, testConnection, research, googleBooksLookup, googleBooksVolume,
  generateImage, elevenLabsVoices, elevenLabsSpeak, chunkText, deeplTranslate, translateText, deeplLangCode, parseGlossary,
  sendEmail, syncSubscriber, sendListCampaign,
  estimateCost, logUsage, monthSpend, bookSpend, budgetStatus, checkBudgets,
};
