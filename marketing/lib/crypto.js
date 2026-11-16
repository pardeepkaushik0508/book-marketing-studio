// AES-256-GCM encryption for API keys, scrypt password hashing, and a
// small self-contained TOTP implementation (RFC 6238) for optional
// two-step verification. No extra dependencies.
const crypto = require('crypto');

let _key = null;

function getKey() {
  if (_key) return _key;
  const hex = (process.env.ENCRYPTION_KEY || '').trim();
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(
      'ENCRYPTION_KEY must be 64 hex characters (32 bytes). ' +
      'Generate one with: openssl rand -hex 32'
    );
  }
  _key = Buffer.from(hex, 'hex');
  return _key;
}

// Returns "iv:tag:ciphertext" (all base64) — safe to store in one column.
function encrypt(plainText) {
  const key = getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(String(plainText), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString('base64'), tag.toString('base64'), enc.toString('base64')].join(':');
}

function decrypt(blob) {
  const key = getKey();
  const [ivB64, tagB64, dataB64] = String(blob).split(':');
  if (!ivB64 || !tagB64 || dataB64 === undefined) throw new Error('Bad encrypted value');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

// Password hashing (scrypt, per-account salt). Stored as "salt:hash" (hex).
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(pw), salt, 64);
  return salt.toString('hex') + ':' + hash.toString('hex');
}

function verifyPassword(pw, stored) {
  try {
    const [saltHex, hashHex] = String(stored).split(':');
    const hash = crypto.scryptSync(String(pw), Buffer.from(saltHex, 'hex'), 64);
    return crypto.timingSafeEqual(hash, Buffer.from(hashHex, 'hex'));
  } catch {
    return false;
  }
}

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}

function sha256(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex');
}

function timingSafeEqualStr(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

// ---- TOTP (RFC 6238, SHA-1, 30s step, 6 digits) ----
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32Encode(buf) {
  let bits = 0, val = 0, out = '';
  for (const b of buf) {
    val = (val << 8) | b; bits += 8;
    while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(val << (5 - bits)) & 31];
  return out;
}
function base32Decode(str) {
  const clean = String(str).replace(/=+$/, '').toUpperCase();
  let bits = 0, val = 0; const bytes = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new Error('Bad base32 secret');
    val = (val << 5) | idx; bits += 5;
    if (bits >= 8) { bytes.push((val >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(bytes);
}
function totpCode(secret, timeMs = Date.now(), step = 30, digits = 6) {
  const counter = Math.floor(timeMs / 1000 / step);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', base32Decode(secret)).update(buf).digest();
  const off = hmac[hmac.length - 1] & 0xf;
  const code = ((hmac[off] & 0x7f) << 24) | ((hmac[off + 1] & 0xff) << 16) | ((hmac[off + 2] & 0xff) << 8) | (hmac[off + 3] & 0xff);
  return String(code % (10 ** digits)).padStart(digits, '0');
}
function verifyTotp(secret, code, windowSteps = 1) {
  if (!secret) return false;
  const clean = String(code || '').replace(/\D/g, '');
  if (clean.length !== 6) return false;
  for (let w = -windowSteps; w <= windowSteps; w++) {
    if (totpCode(secret, Date.now() + w * 30000) === clean) return true;
  }
  return false;
}
function newTotpSecret() {
  return base32Encode(crypto.randomBytes(20));
}
function totpSetupUrl(secret, accountName, issuer = 'Book Marketing Studio') {
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(accountName)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

module.exports = {
  encrypt, decrypt, hashPassword, verifyPassword, randomToken, sha256, timingSafeEqualStr,
  totpCode, verifyTotp, newTotpSecret, totpSetupUrl,
};
