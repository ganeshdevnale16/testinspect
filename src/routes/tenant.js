// Client (tenant) administration: company settings and branding, users and roles, sites, AI keys, usage, audit log.
import { db, newId, now, j, pj } from '../db/index.js';
import { HttpError, bad, notFound, forbidden, str, text, bool, emailOk } from '../http.js';
import { requirePerm, requireWrite, audit, monthStart } from '../auth.js';
import { hashPassword, randomPassword, passwordProblem } from '../security.js';
import { TENANT_ROLES } from '../rbac.js';
import { mergeSettings } from '../services.js';
import { listKeys, createKey, updateKey, deleteKey, testKey, providerCatalog } from './keys.js';
import { aiStatus, aiCallsThisMonth } from '../ai/resolve.js';

function publicUser(u) {
  return {
    id: u.id, email: u.email, name: u.name, role: u.role, roleLabel: TENANT_ROLES[u.role]?.label || u.role, status: u.status,
    phone: u.phone, empId: u.emp_id, title: u.title, siteIds: pj(u.site_ids, []), lastLoginAt: u.last_login_at, createdAt: u.created_at,
  };
}

export default function routes(r) {
  // ---------- settings ----------
  r.get('/api/settings', async (ctx) => {
    requirePerm(ctx, 'settings.manage');
    const s = mergeSettings(ctx.tenant.settings);
    if (s.webhook.secret) s.webhook.secret = '••••••';
    return { tenant: { id: ctx.tenant.id, name: ctx.tenant.name, slug: ctx.tenant.slug, contactName: ctx.tenant.contact_name, contactEmail: ctx.tenant.contact_email, contactPhone: ctx.tenant.contact_phone, address: ctx.tenant.address, gstin: ctx.tenant.gstin, industries: ctx.tenant.industries }, settings: s };
  });

  r.put('/api/settings', async (ctx) => {
    requirePerm(ctx, 'settings.manage'); requireWrite(ctx);
    const b = ctx.body;
    const cur = mergeSettings(ctx.tenant.settings);
    const next = mergeSettings(cur);
    if (b.branding) {
      const color = /^#[0-9a-f]{6}$/i.test(b.branding.color || '') ? b.branding.color : cur.branding.color;
      const logo = b.branding.logo === '' ? '' : (typeof b.branding.logo === 'string' && /^data:image\/(png|jpeg|svg\+xml|webp);base64,/.test(b.branding.logo) && b.branding.logo.length < 300000 ? b.branding.logo : cur.branding.logo);
      next.branding = { color, logo, report_footer: text(b.branding.report_footer ?? cur.branding.report_footer, 400), app_name: str(b.branding.app_name ?? cur.branding.app_name, 40) };
    }
    if (b.workflow) {
      const w = b.workflow;
      next.workflow = {
        require_review: bool(w.require_review), auto_actions: bool(w.auto_actions), auto_create_assets: bool(w.auto_create_assets),
        inspectors_see_all: bool(w.inspectors_see_all), action_due_days: Math.max(1, Math.min(90, Number(w.action_due_days) || 7)),
      };
    }
    if (b.ai) {
      const keys = await db.query('SELECT id FROM ai_keys WHERE tenant_id = $1', [ctx.tenant.id]);
      const okId = (id) => (id && keys.some((k) => k.id === id) ? id : '');
      const mc = Number(b.ai.min_confidence);
      next.ai = {
        main_key_id: okId(b.ai.main_key_id), verify_key_id: okId(b.ai.verify_key_id),
        min_confidence: mc >= 0.5 && mc <= 0.95 ? mc : cur.ai.min_confidence,
        strict_verify: bool(b.ai.strict_verify), language: str(b.ai.language, 30),
      };
    }
    if (b.webhook) {
      const url = str(b.webhook.url, 400);
      if (url && !/^https:\/\//i.test(url)) throw bad('Webhook URL must start with https://');
      next.webhook = {
        url,
        secret: b.webhook.secret && b.webhook.secret !== '••••••' ? str(b.webhook.secret, 120) : cur.webhook.secret,
        events: (Array.isArray(b.webhook.events) ? b.webhook.events : cur.webhook.events).map((e) => str(e, 40)).slice(0, 10),
      };
    }
    const t = b.tenant || {};
    await db.run(
      `UPDATE tenants SET settings = $1, name = $2, contact_name = $3, contact_email = $4, contact_phone = $5, address = $6, gstin = $7, updated_at = $8 WHERE id = $9`,
      [j(next), str(t.name ?? ctx.tenant.name, 120) || ctx.tenant.name, str(t.contactName ?? ctx.tenant.contact_name, 80), str(t.contactEmail ?? ctx.tenant.contact_email, 160),
        str(t.contactPhone ?? ctx.tenant.contact_phone, 30), text(t.address ?? ctx.tenant.address, 400), str(t.gstin ?? ctx.tenant.gstin, 20), now(), ctx.tenant.id],
    );
    await audit(ctx, 'settings.updated', 'tenant', ctx.tenant.id, { sections: Object.keys(b) });
    return { ok: true };
  });

  // ---------- users ----------
  r.get('/api/users', async (ctx) => {
    requirePerm(ctx, 'user.view');
    const rows = await db.query('SELECT * FROM users WHERE tenant_id = $1 ORDER BY name', [ctx.tenant.id]);
    return { users: rows.map(publicUser), roles: Object.entries(TENANT_ROLES).map(([id, v]) => ({ id, ...v })) };
  });

  // Lightweight list of people (for "assign to" pickers) - any tenant user may see names.
  r.get('/api/people', async (ctx) => {
    requirePerm(ctx, 'inspection.view');
    const rows = await db.query("SELECT id, name, role FROM users WHERE tenant_id = $1 AND status = 'active' ORDER BY name", [ctx.tenant.id]);
    return { people: rows };
  });

  r.post('/api/users', async (ctx) => {
    requirePerm(ctx, 'user.manage'); requireWrite(ctx);
    const b = ctx.body;
    const email = str(b.email, 160).toLowerCase();
    if (!emailOk(email)) throw bad('Enter a valid email address.');
    if (!TENANT_ROLES[b.role]) throw bad('Choose a role.');
    if (await db.one('SELECT id FROM users WHERE email = $1', [email])) throw new HttpError(409, 'A user with this email already exists.');
    const max = ctx.limits?.max_users;
    if (max !== null && max !== undefined) {
      const n = Number(await db.value("SELECT CAST(COUNT(*) AS INTEGER) AS n FROM users WHERE tenant_id = $1 AND status = 'active'", [ctx.tenant.id]));
      if (n >= max) throw new HttpError(402, `Your plan allows ${max} active users. Disable a user or upgrade your plan.`, 'limit_users');
    }
    let password = String(b.password || '');
    const generated = !password;
    if (generated) password = randomPassword();
    else { const p = passwordProblem(password); if (p) throw bad(p); }
    const id = newId(); const ts = now();
    await db.run(
      `INSERT INTO users (id, tenant_id, email, name, role, password_hash, status, phone, emp_id, title, site_ids, must_change_password, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,'active',$7,$8,$9,$10,1,$11,$11)`,
      [id, ctx.tenant.id, email, str(b.name, 80) || email.split('@')[0], b.role, await hashPassword(password), str(b.phone, 30), str(b.empId, 40), str(b.title, 80), j(await validSites(ctx, b.siteIds)), ts],
    );
    await audit(ctx, 'user.created', 'user', id, { email, role: b.role });
    return { user: publicUser(await db.one('SELECT * FROM users WHERE id = $1', [id])), tempPassword: password };
  });

  r.put('/api/users/:id', async (ctx) => {
    requirePerm(ctx, 'user.manage'); requireWrite(ctx);
    const u = await db.one('SELECT * FROM users WHERE id = $1 AND tenant_id = $2', [ctx.params.id, ctx.tenant.id]);
    if (!u) throw notFound('User');
    const b = ctx.body;
    const role = b.role && TENANT_ROLES[b.role] ? b.role : u.role;
    const status = ['active', 'disabled'].includes(b.status) ? b.status : u.status;
    if (u.id === ctx.user.id && (role !== 'tenant_admin' || status !== 'active')) throw bad('You cannot remove your own admin access.');
    if (u.role === 'tenant_admin' && (role !== 'tenant_admin' || status !== 'active')) {
      const admins = Number(await db.value("SELECT CAST(COUNT(*) AS INTEGER) AS n FROM users WHERE tenant_id = $1 AND role = 'tenant_admin' AND status = 'active'", [ctx.tenant.id]));
      if (admins <= 1) throw bad('Keep at least one active admin.');
    }
    // disabling or changing role signs the user out everywhere
    const tv = (Number(u.token_version) || 0) + (role !== u.role || status !== u.status ? 1 : 0);
    await db.run(
      'UPDATE users SET name = $1, role = $2, status = $3, phone = $4, emp_id = $5, title = $6, site_ids = $7, token_version = $8, updated_at = $9 WHERE id = $10',
      [str(b.name ?? u.name, 80), role, status, str(b.phone ?? u.phone, 30), str(b.empId ?? u.emp_id, 40), str(b.title ?? u.title, 80),
        j(b.siteIds !== undefined ? await validSites(ctx, b.siteIds) : pj(u.site_ids, [])), tv, now(), u.id],
    );
    await audit(ctx, 'user.updated', 'user', u.id, { role, status });
    return { user: publicUser(await db.one('SELECT * FROM users WHERE id = $1', [u.id])) };
  });

  r.post('/api/users/:id/reset-password', async (ctx) => {
    requirePerm(ctx, 'user.manage'); requireWrite(ctx);
    const u = await db.one('SELECT * FROM users WHERE id = $1 AND tenant_id = $2', [ctx.params.id, ctx.tenant.id]);
    if (!u) throw notFound('User');
    const password = randomPassword();
    await db.run('UPDATE users SET password_hash = $1, must_change_password = 1, token_version = token_version + 1, updated_at = $2 WHERE id = $3', [await hashPassword(password), now(), u.id]);
    await audit(ctx, 'user.password_reset', 'user', u.id);
    return { tempPassword: password };
  });

  // ---------- sites ----------
  r.get('/api/sites', async (ctx) => {
    requirePerm(ctx, 'site.view');
    const rows = await db.query(
      `SELECT s.*, (SELECT CAST(COUNT(*) AS INTEGER) FROM assets a WHERE a.site_id = s.id) AS asset_count
       FROM sites s WHERE s.tenant_id = $1 ORDER BY s.name`, [ctx.tenant.id]);
    const scope = ctx.siteScope || [];
    return { sites: rows.filter((s) => !scope.length || scope.includes(s.id)) };
  });
  r.post('/api/sites', async (ctx) => {
    requirePerm(ctx, 'site.manage'); requireWrite(ctx);
    const name = str(ctx.body.name, 120);
    if (!name) throw bad('Enter the site name.');
    const max = ctx.limits?.max_sites;
    if (max !== null && max !== undefined) {
      const n = Number(await db.value('SELECT CAST(COUNT(*) AS INTEGER) AS n FROM sites WHERE tenant_id = $1', [ctx.tenant.id]));
      if (n >= max) throw new HttpError(402, `Your plan allows ${max} sites. Upgrade to add more.`, 'limit_sites');
    }
    const id = newId(); const ts = now();
    await db.run('INSERT INTO sites (id, tenant_id, name, code, address, notes, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$7)',
      [id, ctx.tenant.id, name, str(ctx.body.code, 30), text(ctx.body.address, 400), text(ctx.body.notes, 1000), ts]);
    await audit(ctx, 'site.created', 'site', id, { name });
    return { id };
  });
  r.put('/api/sites/:id', async (ctx) => {
    requirePerm(ctx, 'site.manage'); requireWrite(ctx);
    const n = await db.run('UPDATE sites SET name = $1, code = $2, address = $3, notes = $4, updated_at = $5 WHERE id = $6 AND tenant_id = $7',
      [str(ctx.body.name, 120), str(ctx.body.code, 30), text(ctx.body.address, 400), text(ctx.body.notes, 1000), now(), ctx.params.id, ctx.tenant.id]);
    if (!n) throw notFound('Site');
    await audit(ctx, 'site.updated', 'site', ctx.params.id);
    return { ok: true };
  });
  r.delete('/api/sites/:id', async (ctx) => {
    requirePerm(ctx, 'site.manage'); requireWrite(ctx);
    const used = Number(await db.value('SELECT CAST(COUNT(*) AS INTEGER) AS n FROM assets WHERE site_id = $1 AND tenant_id = $2', [ctx.params.id, ctx.tenant.id]));
    if (used) throw bad(`This site has ${used} assets. Move or delete them first.`);
    const n = await db.run('DELETE FROM sites WHERE id = $1 AND tenant_id = $2', [ctx.params.id, ctx.tenant.id]);
    if (!n) throw notFound('Site');
    await audit(ctx, 'site.deleted', 'site', ctx.params.id);
    return { ok: true };
  });

  // ---------- AI keys (bring your own key) ----------
  r.get('/api/ai-keys', async (ctx) => {
    requirePerm(ctx, 'ai.manage');
    return { keys: await listKeys(ctx.tenant.id), providers: providerCatalog(), status: await aiStatus(ctx), platformAi: Boolean(ctx.limits?.platform_ai), settings: mergeSettings(ctx.tenant.settings).ai };
  });
  r.post('/api/ai-keys', async (ctx) => { requirePerm(ctx, 'ai.manage'); requireWrite(ctx); return createKey(ctx, ctx.tenant.id, ctx.body); });
  r.put('/api/ai-keys/:id', async (ctx) => { requirePerm(ctx, 'ai.manage'); requireWrite(ctx); return { key: await updateKey(ctx, ctx.tenant.id, ctx.params.id, ctx.body) }; });
  r.delete('/api/ai-keys/:id', async (ctx) => { requirePerm(ctx, 'ai.manage'); requireWrite(ctx); return deleteKey(ctx, ctx.tenant.id, ctx.params.id); });
  r.post('/api/ai-keys/:id/test', async (ctx) => { requirePerm(ctx, 'ai.manage'); return testKey(ctx, ctx.tenant.id, ctx.params.id); });

  // ---------- usage ----------
  r.get('/api/usage', async (ctx) => {
    requirePerm(ctx, 'settings.manage');
    const since = new Date(Date.now() - 180 * 864e5).toISOString();
    const rows = await db.query('SELECT kind, provider, model, key_source, ok, tokens_in, tokens_out, created_at FROM ai_usage WHERE tenant_id = $1 AND created_at >= $2', [ctx.tenant.id, since]);
    const byMonth = {}; const byProvider = {};
    rows.forEach((u) => {
      const m = u.created_at.slice(0, 7);
      byMonth[m] ||= { month: m, calls: 0, failed: 0, tokensIn: 0, tokensOut: 0 };
      byMonth[m].calls++; if (!u.ok) byMonth[m].failed++;
      byMonth[m].tokensIn += Number(u.tokens_in) || 0; byMonth[m].tokensOut += Number(u.tokens_out) || 0;
      if (u.created_at >= monthStart()) {
        const k = `${u.provider} · ${u.model}`;
        byProvider[k] ||= { provider: u.provider, model: u.model, source: u.key_source, calls: 0, tokensIn: 0, tokensOut: 0 };
        byProvider[k].calls++; byProvider[k].tokensIn += Number(u.tokens_in) || 0; byProvider[k].tokensOut += Number(u.tokens_out) || 0;
      }
    });
    const ms = monthStart();
    return {
      plan: ctx.plan ? { id: ctx.plan.id, name: ctx.plan.name } : null,
      limits: ctx.limits,
      thisMonth: {
        aiCalls: await aiCallsThisMonth(ctx.tenant.id),
        inspections: Number(await db.value('SELECT CAST(COUNT(*) AS INTEGER) AS n FROM inspections WHERE tenant_id = $1 AND created_at >= $2', [ctx.tenant.id, ms])),
        users: Number(await db.value("SELECT CAST(COUNT(*) AS INTEGER) AS n FROM users WHERE tenant_id = $1 AND status = 'active'", [ctx.tenant.id])),
        sites: Number(await db.value('SELECT CAST(COUNT(*) AS INTEGER) AS n FROM sites WHERE tenant_id = $1', [ctx.tenant.id])),
      },
      byMonth: Object.values(byMonth).sort((a, b) => a.month.localeCompare(b.month)),
      byProvider: Object.values(byProvider),
    };
  });

  // ---------- audit log ----------
  r.get('/api/audit', async (ctx) => {
    requirePerm(ctx, 'audit.view');
    const limit = Math.min(500, Number(ctx.query.limit) || 200);
    const rows = await db.query('SELECT * FROM audit_log WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT ' + limit, [ctx.tenant.id]);
    return { entries: rows.map((e) => ({ ...e, details: pj(e.details, null) })) };
  });
}

async function validSites(ctx, ids) {
  if (!Array.isArray(ids) || !ids.length) return [];
  const rows = await db.query('SELECT id FROM sites WHERE tenant_id = $1', [ctx.tenant.id]);
  const ok = new Set(rows.map((s) => s.id));
  return ids.filter((x) => ok.has(x)).slice(0, 100);
}

export { forbidden };
