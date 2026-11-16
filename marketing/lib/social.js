// Publishing scheduled posts to their channels. Only APPROVED content is
// ever scheduled (enforced by the routes); this module only delivers it.
// Connected channels post automatically; anything else is sent to the
// optional post webhook (e.g. n8n → WordPress), or marked "manual" so it
// shows up in Today with a copy button.
const db = require('./db');
const ai = require('./ai');

// Imprint channel name → provider that can post to it.
const CHANNEL_PROVIDER = {
  linkedin: 'linkedin', x: 'x', twitter: 'x', facebook: 'facebook', instagram: 'instagram', 'email list': 'email',
};
function providerFor(channel) {
  const c = String(channel || '').toLowerCase();
  return Object.entries(CHANNEL_PROVIDER).find(([k]) => c.includes(k))?.[1] || null;
}

// LinkedIn versions are monthly and expire after about a year; default to
// two months back so a fresh deploy never asks for an unreleased version.
function linkedinVersion(saved) {
  if (/^\d{6}$/.test(saved || '')) return saved;
  const d = new Date();
  d.setUTCMonth(d.getUTCMonth() - 2);
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

// LinkedIn "little text" needs these characters escaped.
function escapeLittleText(s) { return String(s).replace(/([\\|{}@[\]()<>#*_~])/g, '\\$1'); }

async function readErr(res) { try { return (await res.text()).slice(0, 300); } catch { return ''; } }

async function postLinkedIn(text) {
  const c = ai.getConnection('linkedin');
  if (!c || !c.apiKey) return null;
  if (!c.extra.authorUrn) throw new Error('LinkedIn author URN missing — press Test on the LinkedIn card in Settings.');
  const res = await fetch('https://api.linkedin.com/rest/posts', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${c.apiKey}`, 'content-type': 'application/json',
      'LinkedIn-Version': linkedinVersion(c.extra.version), 'X-Restli-Protocol-Version': '2.0.0',
    },
    body: JSON.stringify({
      author: c.extra.authorUrn, commentary: escapeLittleText(text), visibility: 'PUBLIC',
      distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
      lifecycleState: 'PUBLISHED', isReshareDisabledByAuthor: false,
    }),
  });
  if (!res.ok) throw new Error(`LinkedIn error ${res.status}: ${await readErr(res)}`);
  return res.headers.get('x-restli-id') || 'posted';
}

async function postFacebook(text, link) {
  const c = ai.getConnection('facebook');
  if (!c || !c.apiKey || !c.extra.pageId) return null;
  const body = new URLSearchParams({ message: text, access_token: c.apiKey });
  if (link) body.append('link', link);
  const res = await fetch(`https://graph.facebook.com/${c.extra.version || 'v21.0'}/${encodeURIComponent(c.extra.pageId)}/feed`, { method: 'POST', body });
  if (!res.ok) throw new Error(`Facebook error ${res.status}: ${await readErr(res)}`);
  return (await res.json()).id || 'posted';
}

async function postInstagram(text, imageUrl) {
  const c = ai.getConnection('instagram');
  if (!c || !c.apiKey || !c.extra.igUserId) return null;
  if (!imageUrl || !/^https:\/\//.test(imageUrl)) throw new Error('Instagram needs a public https image URL (JPEG) on the post.');
  const v = c.extra.version || 'v21.0';
  const base = `https://graph.facebook.com/${v}/${encodeURIComponent(c.extra.igUserId)}`;
  const create = await fetch(`${base}/media`, { method: 'POST', body: new URLSearchParams({ image_url: imageUrl, caption: text, access_token: c.apiKey }) });
  if (!create.ok) throw new Error(`Instagram error ${create.status}: ${await readErr(create)}`);
  const { id } = await create.json();
  const pub = await fetch(`${base}/media_publish`, { method: 'POST', body: new URLSearchParams({ creation_id: id, access_token: c.apiKey }) });
  if (!pub.ok) throw new Error(`Instagram publish error ${pub.status}: ${await readErr(pub)}`);
  return (await pub.json()).id || 'posted';
}

async function postX(text) {
  const c = ai.getConnection('x');
  if (!c || !c.apiKey) return null;
  if ([...text].length > 280) throw new Error(`Post is ${[...text].length} characters — X allows 280. Edit it or post by hand.`);
  const res = await fetch('https://api.x.com/2/tweets', {
    method: 'POST', headers: { authorization: `Bearer ${c.apiKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ text }),
  });
  if (!res.ok) throw new Error(`X error ${res.status}: ${await readErr(res)}`);
  return (await res.json()).data?.id || 'posted';
}

async function postEmailList(text) {
  if (!ai.isConnected('brevo')) return null;
  const m = String(text).match(/^\s*subject:\s*(.+)\n/i);
  const subject = m ? m[1].trim() : String(text).split('\n')[0].slice(0, 90);
  const body = m ? text.slice(m[0].length) : text;
  const html = body.split(/\n\s*\n/).map((p) => `<p>${p.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\n/g, '<br>').replace(/(https?:\/\/\S+)/g, '<a href="$1">$1</a>')}</p>`).join('');
  const r = await ai.sendListCampaign({ subject, html });
  return r.id;
}

async function postWebhook(post) {
  const row = db.get("SELECT value FROM settings WHERE key = 'post_webhook_url'");
  if (!row || !row.value) return null;
  const res = await fetch(row.value, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ event: 'scheduled_post', channel: post.channel, text: post.text, link: post.link, imageUrl: post.image_url, bookId: post.book_id, postId: post.id }),
  });
  if (!res.ok) throw new Error(`Post webhook error ${res.status}`);
  return 'webhook';
}

// Deliver one post. Returns { status: 'posted'|'manual'|'failed', externalId, error }.
async function publish(post) {
  const provider = providerFor(post.channel);
  try {
    let id = null;
    if (provider === 'linkedin') id = await postLinkedIn(post.text);
    else if (provider === 'facebook') id = await postFacebook(post.text, post.link);
    else if (provider === 'instagram') id = await postInstagram(post.text, post.image_url);
    else if (provider === 'x') id = await postX(post.text);
    else if (provider === 'email') id = await postEmailList(post.text);
    if (!id) id = await postWebhook(post);
    if (!id) return { status: 'manual', externalId: '', error: `${post.channel} is not connected — post it by hand (copy from Today), or connect it in Settings.` };
    return { status: 'posted', externalId: String(id), error: '' };
  } catch (e) {
    return { status: 'failed', externalId: '', error: e.message };
  }
}

module.exports = { publish, providerFor, linkedinVersion, escapeLittleText };
