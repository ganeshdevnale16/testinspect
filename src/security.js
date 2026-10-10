// Passwords (scrypt), signed session tokens (HMAC-SHA256), encryption of customer API keys (AES-256-GCM),
// and a small in-memory rate limiter. No external packages.
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { config } from './config.js';
import { kvGet, kvSet } from './db/index.js';

const scrypt = promisify(crypto.scrypt);
let SESSION_KEY = null;
let ENC_KEY = null;

// Secrets: use env vars in production. If missing, a random secret is generated once and kept in the database
// so that sign-ins survive restarts (fine for development; set the env vars for real customers).
export async function initSecrets() {
  let s = config.sessionSecret;
  if (!s) {
    s = await kvGet('generated_session_secret');
    if (!s) { s = crypto.randomBytes(48).toString('base64url'); await kvSet('generated_session_secret', s); }
    console.warn('[security] SESSION_SECRET not set - using a generated one stored in the database.');
  }
  SESSION_KEY = crypto.createHash('sha256').update('session|' + s).digest();

  let e = config.encryptionKey;
  if (!e) {
    if (config.production) throw new Error('ENCRYPTION_KEY must be set in production (it protects customer AI keys).');
    e = await kvGet('generated_encryption_key');
    if (!e) { e = crypto.randomBytes(32).toString('base64url'); await kvSet('generated_encryption_key', e); }
    console.warn('[security] ENCRYPTION_KEY not set - using a generated development key.');
  }
  ENC_KEY = crypto.createHash('sha256').update('enc|' + e).digest();
}

// ---------- passwords ----------
const N = 16384, R = 8, P = 1, LEN = 64;
export async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(String(pw), salt, LEN, { N, r: R, p: P });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}
export async function verifyPassword(pw, stored) {
  try {
    const [algo, n, r, p, salt, hash] = String(stored || '').split('$');
    if (algo !== 'scrypt') return false;
    const expected = Buffer.from(hash, 'base64url');
    const got = await scrypt(String(pw), Buffer.from(salt, 'base64url'), expected.length, { N: +n, r: +r, p: +p });
    return crypto.timingSafeEqual(got, expected);
  } catch { return false; }
}
export function passwordProblem(pw) {
  const s = String(pw || '');
  if (s.length < 8) return 'Password must be at least 8 characters.';
  if (!/[A-Za-z]/.test(s) || !/[0-9]/.test(s)) return 'Password must contain letters and numbers.';
  return '';
}
export function randomPassword() {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const b = crypto.randomBytes(12);
  let out = '';
  for (let i = 0; i < 10; i++) out += abc[b[i] % abc.length];
  return out + '#' + (b[10] % 10) + (b[11] % 10);
}

// ---------- session tokens ----------
const b64 = (s) => Buffer.from(s).toString('base64url');
const mac = (data) => crypto.createHmac('sha256', SESSION_KEY).update(data).digest('base64url');
export function signToken(payload, days = config.sessionDays) {
  const exp = Date.now() + days * 864e5;
  const body = b64(JSON.stringify({ ...payload, exp }));
  return { token: `${body}.${mac(body)}`, expiresAt: new Date(exp).toISOString() };
}
export function readToken(token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  const expected = mac(body || '');
  if (!sig || sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const data = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!data.exp || Date.now() > data.exp) return null;
    return data;
  } catch { return null; }
}

// ---------- encryption for stored API keys ----------
export function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', ENC_KEY, iv);
  const enc = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return `v1.${iv.toString('base64url')}.${c.getAuthTag().toString('base64url')}.${enc.toString('base64url')}`;
}
export function decrypt(blob) {
  const [v, iv, tag, data] = String(blob || '').split('.');
  if (v !== 'v1') throw new Error('Unknown key format');
  const d = crypto.createDecipheriv('aes-256-gcm', ENC_KEY, Buffer.from(iv, 'base64url'));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(data, 'base64url')), d.final()]).toString('utf8');
}
export const keyHint = (k) => { const s = String(k || ''); return s.length > 8 ? `${s.slice(0, 4)}…${s.slice(-4)}` : '••••'; };

export function hmacHex(secret, body) {
  return crypto.createHmac('sha256', String(secret)).update(body).digest('hex');
}

// ---------- rate limiting (per server instance) ----------
const buckets = new Map();
export function rateLimit(key, max, windowMs) {
  const t = Date.now();
  let b = buckets.get(key);
  if (!b || t > b.reset) { b = { n: 0, reset: t + windowMs }; buckets.set(key, b); }
  b.n++;
  if (buckets.size > 50000) for (const [k, v] of buckets) if (t > v.reset) buckets.delete(k);
  return { ok: b.n <= max, retryAfter: Math.ceil((b.reset - t) / 1000) };
}
export function rateReset(key) { buckets.delete(key); }
