// Tiny HTTP toolkit on top of node:http (no framework needed).
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

export class HttpError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code; }
}
export const bad = (msg) => new HttpError(400, msg);
export const notFound = (what = 'Item') => new HttpError(404, `${what} not found.`);
export const forbidden = (msg = 'You do not have permission to do this.') => new HttpError(403, msg, 'forbidden');

export function sendJson(res, status, data, headers = {}) {
  if (res.headersSent) return;
  const body = JSON.stringify(data ?? {});
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}
export function sendText(res, status, text, type = 'text/plain; charset=utf-8', headers = {}) {
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', ...headers });
  res.end(text);
}

export async function readBody(req) {
  // Vercel and some hosts parse the body before us
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === 'string') { try { return JSON.parse(req.body || '{}'); } catch { throw bad('Body is not valid JSON.'); } }
    if (Buffer.isBuffer(req.body)) { try { return JSON.parse(req.body.toString('utf8') || '{}'); } catch { throw bad('Body is not valid JSON.'); } }
    return req.body;
  }
  const limit = config.maxBodyMb * 1048576;
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new HttpError(413, 'Upload is too large. Use fewer or smaller photos.');
    chunks.push(c);
  }
  if (!size) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw bad('Body is not valid JSON.'); }
}

export function clientIp(req) {
  return String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress || '';
}

// ---------- router ----------
export class Router {
  constructor() { this.routes = []; }
  add(method, pattern, opts, handler) {
    if (typeof opts === 'function') { handler = opts; opts = {}; }
    const keys = [];
    const rx = new RegExp('^' + pattern.replace(/\/:([a-zA-Z_]+)/g, (_, k) => { keys.push(k); return '/([^/]+)'; }) + '/?$');
    this.routes.push({ method, rx, keys, opts, handler });
    return this;
  }
  get(p, o, h) { return this.add('GET', p, o, h); }
  post(p, o, h) { return this.add('POST', p, o, h); }
  put(p, o, h) { return this.add('PUT', p, o, h); }
  delete(p, o, h) { return this.add('DELETE', p, o, h); }
  match(method, pathname) {
    let pathOnly = false;
    for (const r of this.routes) {
      const m = r.rx.exec(pathname);
      if (!m) continue;
      if (r.method !== method) { pathOnly = true; continue; }
      const params = {};
      r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      return { route: r, params };
    }
    return pathOnly ? { methodNotAllowed: true } : null;
  }
}

// ---------- static files ----------
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
};
export function serveStatic(root, req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  const pages = { '/': '/index.html', '/console': '/console.html', '/report': '/report.html' };
  if (pages[rel]) rel = pages[rel];
  const file = path.join(root, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(root)) return sendText(res, 403, 'Forbidden');
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      // unknown paths without a file extension fall back to the field app
      if (!path.extname(rel)) return serveStatic(root, req, res, '/');
      return sendText(res, 404, 'Not found');
    }
    const ext = path.extname(file);
    const cache = ['.png', '.svg', '.ico'].includes(ext) ? 'public, max-age=86400' : 'no-cache, must-revalidate';
    res.writeHead(200, { 'Content-Type': TYPES[ext] || 'application/octet-stream', 'Cache-Control': cache, 'Content-Length': st.size });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

export function securityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=(self), geolocation=(self), microphone=()');
  if (config.production) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
}

// ---------- small value helpers used by routes ----------
export const str = (v, max = 200) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
export const text = (v, max = 2000) => String(v ?? '').trim().slice(0, max);
export const intOrNull = (v) => (v === '' || v === null || v === undefined || Number.isNaN(Number(v)) ? null : Math.round(Number(v)));
export const bool = (v) => v === true || v === 1 || v === '1' || v === 'true' || v === 'on';
export const emailOk = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e || ''));
export const slugify = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
