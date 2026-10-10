// Request entry point: security headers, API routing with auth, static files.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Router, HttpError, sendJson, readBody, serveStatic, securityHeaders, clientIp } from './http.js';
import { authenticate } from './auth.js';
import { initDb } from './db/index.js';
import { migrate } from './db/schema.js';
import { seed } from './services.js';
import { initSecrets } from './security.js';
import authRoutes from './routes/auth.js';
import platformRoutes from './routes/platform.js';
import tenantRoutes from './routes/tenant.js';
import templateRoutes from './routes/templates.js';
import assetRoutes from './routes/assets.js';
import inspectionRoutes from './routes/inspections.js';
import aiRoutes from './routes/ai.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const router = new Router();
[authRoutes, platformRoutes, tenantRoutes, templateRoutes, assetRoutes, inspectionRoutes, aiRoutes].forEach((r) => r(router));

let readyPromise = null;
export function ready() {
  readyPromise ||= (async () => { await initDb(); await migrate(); await initSecrets(); await seed(); })();
  return readyPromise;
}

export async function handle(req, res) {
  securityHeaders(res);
  const url = new URL(req.url, 'http://local');
  const pathname = url.pathname;
  if (!pathname.startsWith('/api/')) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'Method not allowed' });
    return serveStatic(ROOT, req, res, pathname);
  }
  const ctx = { req, res, query: Object.fromEntries(url.searchParams), ip: clientIp(req), params: {} };
  try {
    await ready();
    const m = router.match(req.method, pathname);
    if (!m) throw new HttpError(404, 'Unknown API route.');
    if (m.methodNotAllowed) throw new HttpError(405, 'Method not allowed for this route.');
    ctx.params = m.params;
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) ctx.body = await readBody(req);
    else ctx.body = {};
    if (!m.route.opts.public) await authenticate(ctx);
    const out = await m.route.handler(ctx);
    if (!res.headersSent) sendJson(res, 200, out ?? { ok: true });
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) console.error(`[api] ${req.method} ${pathname}`, err);
    sendJson(res, status, { error: status >= 500 && !err.status ? 'Unexpected server error.' : err.message, code: err.code });
  }
}
