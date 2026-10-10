import { db, now } from '../db/index.js';
import { HttpError, bad, str, emailOk } from '../http.js';
import { verifyPassword, hashPassword, signToken, rateLimit, rateReset, passwordProblem } from '../security.js';
import { audit, loadTenant, monthStart } from '../auth.js';
import { isPlatformRole, PLATFORM_ROLES, TENANT_ROLES } from '../rbac.js';
import { aiStatus, aiCallsThisMonth } from '../ai/resolve.js';
import { mergeSettings } from '../services.js';
import { config, VERSION } from '../config.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function tenantPublic(t) {
  if (!t) return null;
  const s = mergeSettings(t.settings);
  return {
    id: t.id, name: t.name, slug: t.slug, status: t.status, trialEndsAt: t.trial_ends_at, industries: t.industries,
    branding: s.branding, workflow: { require_review: s.workflow.require_review, inspectors_see_all: s.workflow.inspectors_see_all },
  };
}

export default function routes(r) {
  r.get('/api/health', { public: true }, async () => {
    let dbOk = true;
    try { await db.value('SELECT 1 AS ok'); } catch { dbOk = false; }
    return { ok: dbOk, version: VERSION, app: config.appName, demoAi: config.aiMock };
  });

  r.post('/api/auth/login', { public: true }, async (ctx) => {
    const email = str(ctx.body.email, 160).toLowerCase();
    const password = String(ctx.body.password || '');
    if (!emailOk(email) || !password) throw bad('Enter your email and password.');
    const key = `login:${ctx.ip}:${email}`;
    const rl = rateLimit(key, config.maxLoginAttempts, 15 * 60e3);
    if (!rl.ok) throw new HttpError(429, `Too many attempts. Try again in ${Math.ceil(rl.retryAfter / 60)} minutes.`);
    if (!rateLimit(`login-ip:${ctx.ip}`, 60, 15 * 60e3).ok) throw new HttpError(429, 'Too many sign-in attempts from this network.');

    const u = await db.one('SELECT * FROM users WHERE email = $1', [email]);
    if (!u || !(await verifyPassword(password, u.password_hash))) { await sleep(700); throw new HttpError(401, 'Wrong email or password.'); }
    if (u.status !== 'active') throw new HttpError(403, 'Your user account is disabled. Contact your administrator.');
    let tenant = null;
    if (!isPlatformRole(u.role)) {
      tenant = await loadTenant(u.tenant_id);
      if (!tenant) throw new HttpError(403, 'Your company account no longer exists.');
      if (['suspended', 'cancelled'].includes(tenant.status)) throw new HttpError(403, 'Your company account is suspended. Contact your administrator.');
    }
    rateReset(key);
    await db.run('UPDATE users SET last_login_at = $1 WHERE id = $2', [now(), u.id]);
    const { token, expiresAt } = signToken({ uid: u.id, tv: Number(u.token_version) || 0 });
    await audit({ req: ctx.req, user: u, tenant }, 'auth.login', 'user', u.id);
    return {
      token, expiresAt,
      user: { id: u.id, name: u.name, email: u.email, role: u.role, mustChangePassword: Boolean(u.must_change_password) },
      tenant: tenantPublic(tenant),
      platform: isPlatformRole(u.role),
    };
  });

  r.get('/api/me', async (ctx) => {
    const u = ctx.user;
    const out = {
      user: { id: u.id, name: u.name, email: u.email, role: u.role, phone: u.phone, empId: u.emp_id, title: u.title, siteIds: u.site_ids, mustChangePassword: u.must_change_password },
      roleLabel: (PLATFORM_ROLES[ctx.role] || TENANT_ROLES[ctx.role])?.label || ctx.role,
      role: ctx.role,
      platformRole: ctx.platformRole || null,
      support: ctx.support,
      tenant: tenantPublic(ctx.tenant),
      permissions: ctx.permissions,
      version: VERSION,
    };
    if (ctx.tenant) {
      out.ai = await aiStatus(ctx);
      out.plan = ctx.plan ? { id: ctx.plan.id, name: ctx.plan.name } : null;
      out.limits = ctx.limits;
      out.usage = {
        aiCalls: await aiCallsThisMonth(ctx.tenant.id),
        inspections: Number(await db.value('SELECT CAST(COUNT(*) AS INTEGER) AS n FROM inspections WHERE tenant_id = $1 AND created_at >= $2', [ctx.tenant.id, monthStart()])),
      };
    }
    return out;
  });

  r.put('/api/me', async (ctx) => {
    const b = ctx.body;
    const name = str(b.name, 80);
    if (!name) throw bad('Enter your name.');
    await db.run('UPDATE users SET name = $1, phone = $2, emp_id = $3, title = $4, updated_at = $5 WHERE id = $6',
      [name, str(b.phone, 30), str(b.empId, 40), str(b.title, 80), now(), ctx.user.id]);
    return { ok: true };
  });

  r.post('/api/me/password', async (ctx) => {
    const raw = await db.one('SELECT password_hash, token_version FROM users WHERE id = $1', [ctx.user.id]);
    if (!(await verifyPassword(String(ctx.body.current || ''), raw.password_hash))) throw new HttpError(400, 'Current password is wrong.');
    const next = String(ctx.body.next || '');
    const problem = passwordProblem(next);
    if (problem) throw bad(problem);
    const tv = (Number(raw.token_version) || 0) + 1;
    await db.run('UPDATE users SET password_hash = $1, must_change_password = 0, token_version = $2, updated_at = $3 WHERE id = $4',
      [await hashPassword(next), tv, now(), ctx.user.id]);
    await audit(ctx, 'auth.password_changed', 'user', ctx.user.id);
    return signToken({ uid: ctx.user.id, tv }); // new token; other devices are signed out
  });

  r.post('/api/auth/logout-all', async (ctx) => {
    await db.run('UPDATE users SET token_version = token_version + 1 WHERE id = $1', [ctx.user.id]);
    await audit(ctx, 'auth.logout_all', 'user', ctx.user.id);
    return { ok: true };
  });
}
