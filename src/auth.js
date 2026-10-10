// Who is calling, which client (tenant) they act in, and what they may do.
import { db, pj, newId, now, j } from './db/index.js';
import { readToken } from './security.js';
import { HttpError, forbidden, clientIp } from './http.js';
import { can, isPlatformRole, permissionsOf } from './rbac.js';

export function bearer(req) {
  const h = req.headers.authorization || '';
  return /^Bearer\s+/i.test(h) ? h.replace(/^Bearer\s+/i, '').trim() : '';
}

export function parseTenant(t) {
  if (!t) return null;
  return { ...t, settings: pj(t.settings, {}), limits: pj(t.limits, {}), industries: pj(t.industries, []) };
}
export function parseUser(u) {
  if (!u) return null;
  const { password_hash, ...rest } = u;
  return { ...rest, site_ids: pj(u.site_ids, []), must_change_password: Boolean(u.must_change_password) };
}

export async function loadTenant(id) {
  return parseTenant(await db.one('SELECT * FROM tenants WHERE id = $1', [id]));
}
export async function loadPlan(id) {
  if (!id) return null;
  const p = await db.one('SELECT * FROM plans WHERE id = $1', [id]);
  return p ? { ...p, features: pj(p.features, {}), platform_ai: Boolean(p.platform_ai) } : null;
}

// Effective limits = plan limits, overridden by per-client limits set by the platform admin.
export function limitsOf(tenant, plan) {
  const o = tenant?.limits || {};
  const pick = (k) => (o[k] !== undefined && o[k] !== null && o[k] !== '' ? Number(o[k]) : plan?.[k] ?? null);
  return {
    max_users: pick('max_users'),
    max_sites: pick('max_sites'),
    max_inspections_month: pick('max_inspections_month'),
    max_ai_calls_month: pick('max_ai_calls_month'),
    platform_ai: o.platform_ai !== undefined && o.platform_ai !== null && o.platform_ai !== '' ? Boolean(o.platform_ai) : Boolean(plan?.platform_ai),
  };
}

// Fills ctx.user, ctx.tenant, ctx.role, ctx.support. Throws 401/403.
export async function authenticate(ctx) {
  const data = readToken(bearer(ctx.req));
  if (!data?.uid) throw new HttpError(401, 'Please sign in.', 'login_required');
  const raw = await db.one('SELECT * FROM users WHERE id = $1', [data.uid]);
  if (!raw || raw.status !== 'active' || Number(raw.token_version) !== Number(data.tv)) {
    throw new HttpError(401, 'Your sign-in has ended. Please sign in again.', 'login_required');
  }
  const user = parseUser(raw);
  ctx.user = user;
  ctx.support = false;

  if (isPlatformRole(user.role)) {
    ctx.platformRole = user.role;
    const tid = String(ctx.req.headers['x-tenant-id'] || '').trim();
    if (tid) {
      const t = await loadTenant(tid);
      if (!t) throw new HttpError(404, 'Client not found.');
      ctx.tenant = t;
      ctx.role = user.role === 'super_admin' ? 'tenant_admin' : 'viewer';
      ctx.support = true;
    } else {
      ctx.tenant = null;
      ctx.role = user.role;
    }
  } else {
    const t = await loadTenant(user.tenant_id);
    if (!t) throw new HttpError(401, 'Your company account no longer exists.', 'login_required');
    if (t.status === 'suspended' || t.status === 'cancelled') {
      throw new HttpError(403, 'Your company account is suspended. Contact your administrator.', 'account_suspended');
    }
    ctx.tenant = t;
    ctx.role = user.role;
  }
  if (ctx.tenant) {
    ctx.plan = await loadPlan(ctx.tenant.plan_id);
    ctx.limits = limitsOf(ctx.tenant, ctx.plan);
  }
  ctx.can = (perm) => Boolean(ctx.tenant) && can(ctx.role, perm);
  ctx.permissions = ctx.tenant ? permissionsOf(ctx.role) : [];
  // Sites this user is limited to (empty = all sites)
  ctx.siteScope = !isPlatformRole(user.role) && ['manager', 'inspector', 'viewer'].includes(user.role) ? user.site_ids : [];
}

export function requireTenant(ctx) {
  if (!ctx.tenant) throw new HttpError(400, 'Open a client account first.', 'tenant_required');
  return ctx.tenant.id;
}
export function requirePerm(ctx, perm) {
  requireTenant(ctx);
  if (!can(ctx.role, perm)) throw forbidden();
}
export function requirePlatform(ctx, superOnly = false) {
  if (!ctx.platformRole) throw forbidden();
  if (superOnly && ctx.platformRole !== 'super_admin') throw forbidden('Only a super admin can do this.');
}
// Support staff open client accounts read-only.
export function requireWrite(ctx) {
  if (ctx.support && ctx.platformRole !== 'super_admin') throw forbidden('Support access is read only.');
}
// Trial ended or account not active -> no new inspections / AI.
export function requireActiveSubscription(ctx) {
  const t = ctx.tenant;
  if (!t) return;
  if (t.status === 'trial' && t.trial_ends_at && new Date(t.trial_ends_at).getTime() < Date.now()) {
    throw new HttpError(402, 'Your free trial has ended. Contact us to activate your plan.', 'trial_ended');
  }
}

export async function audit(ctx, action, entity = '', entityId = '', details = null) {
  try {
    await db.run(
      'INSERT INTO audit_log (id, tenant_id, user_id, user_name, action, entity, entity_id, details, ip, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
      [newId(), ctx.tenant?.id || null, ctx.user?.id || null,
        (ctx.user?.name || ctx.user?.email || 'system') + (ctx.support ? ' (support)' : ''),
        action, entity, entityId, details ? j(details) : null, ctx.req ? clientIp(ctx.req) : '', now()],
    );
  } catch (e) { console.error('[audit]', e.message); }
}

export function monthStart() {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString();
}
