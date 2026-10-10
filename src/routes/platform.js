// Platform owner console (your team): clients, plans, platform AI keys, staff, usage and audit across all clients.
import { db, newId, now, j, pj } from '../db/index.js';
import { HttpError, bad, notFound, str, text, intOrNull, bool, emailOk } from '../http.js';
import { requirePlatform, audit, monthStart, limitsOf, loadTenant } from '../auth.js';
import { hashPassword, randomPassword, passwordProblem } from '../security.js';
import { PLATFORM_ROLES } from '../rbac.js';
import { createTenant, createDemoTenant } from '../services.js';
import { getLibrary, getLibraryTemplate, toData, uniqueTemplateKey, industryKeys } from '../library-db.js';
import { publicTemplate } from './templates.js';
import { listKeys, createKey, updateKey, deleteKey, testKey, providerCatalog } from './keys.js';
import { envKeys } from '../ai/resolve.js';
import { config } from '../config.js';

const n = (v) => Number(v) || 0;
const STATUSES = ['trial', 'active', 'suspended', 'cancelled'];

function planRow(p) {
  return { ...p, platform_ai: Boolean(p.platform_ai), active: Boolean(p.active), features: pj(p.features, {}) };
}

export default function routes(r) {
  r.get('/api/platform/overview', async (ctx) => {
    requirePlatform(ctx);
    const ms = monthStart();
    const tenants = await db.query('SELECT id, name, status, plan_id, created_at FROM tenants');
    const plans = await db.query('SELECT id, name, price_month FROM plans');
    const priceOf = (id) => n(plans.find((p) => p.id === id)?.price_month);
    const usage = await db.query('SELECT provider, key_source, ok FROM ai_usage WHERE created_at >= $1', [ms]);
    const byProvider = {};
    usage.forEach((u) => { const k = `${u.provider} (${u.key_source})`; byProvider[k] = (byProvider[k] || 0) + 1; });
    const months = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - i);
      months.push(d.toISOString().slice(0, 7));
    }
    const since = months[0] + '-01T00:00:00.000Z';
    const insp = await db.query('SELECT created_at FROM inspections WHERE created_at >= $1', [since]);
    const calls = await db.query('SELECT created_at FROM ai_usage WHERE created_at >= $1', [since]);
    return {
      tenants: {
        total: tenants.length,
        byStatus: Object.fromEntries(STATUSES.map((s) => [s, tenants.filter((t) => t.status === s).length])),
        newThisMonth: tenants.filter((t) => t.created_at >= ms).length,
      },
      mrr: tenants.filter((t) => t.status === 'active').reduce((sum, t) => sum + priceOf(t.plan_id), 0),
      users: n(await db.value("SELECT CAST(COUNT(*) AS INTEGER) AS n FROM users WHERE tenant_id IS NOT NULL AND status = 'active'")),
      inspectionsThisMonth: n(await db.value('SELECT CAST(COUNT(*) AS INTEGER) AS n FROM inspections WHERE created_at >= $1', [ms])),
      aiCallsThisMonth: usage.length,
      aiFailuresThisMonth: usage.filter((u) => !u.ok).length,
      aiByProvider: byProvider,
      monthly: months.map((m) => ({ month: m, inspections: insp.filter((x) => x.created_at.startsWith(m)).length, aiCalls: calls.filter((x) => x.created_at.startsWith(m)).length })),
      envKeys: envKeys().map((k) => ({ provider: k.provider, model: k.model })),
      demoAi: config.aiMock,
    };
  });

  // ---------- clients ----------
  r.get('/api/platform/tenants', async (ctx) => {
    requirePlatform(ctx);
    const ms = monthStart();
    const rows = await db.query(`
      SELECT t.*, p.name AS plan_name,
        (SELECT CAST(COUNT(*) AS INTEGER) FROM users u WHERE u.tenant_id = t.id AND u.status = 'active') AS users,
        (SELECT CAST(COUNT(*) AS INTEGER) FROM inspections i WHERE i.tenant_id = t.id AND i.created_at >= $1) AS inspections_month,
        (SELECT CAST(COUNT(*) AS INTEGER) FROM ai_usage a WHERE a.tenant_id = t.id AND a.created_at >= $1) AS ai_calls_month,
        (SELECT CAST(COUNT(*) AS INTEGER) FROM ai_keys k WHERE k.tenant_id = t.id) AS own_keys,
        (SELECT MAX(i.created_at) FROM inspections i WHERE i.tenant_id = t.id) AS last_inspection_at
      FROM tenants t LEFT JOIN plans p ON p.id = t.plan_id ORDER BY t.created_at DESC`, [ms]);
    return {
      tenants: rows.map((t) => ({
        id: t.id, name: t.name, slug: t.slug, status: t.status, planId: t.plan_id, planName: t.plan_name || '', industries: pj(t.industries, []),
        trialEndsAt: t.trial_ends_at, contactName: t.contact_name, contactEmail: t.contact_email, contactPhone: t.contact_phone,
        users: n(t.users), inspectionsMonth: n(t.inspections_month), aiCallsMonth: n(t.ai_calls_month), ownKeys: n(t.own_keys),
        lastInspectionAt: t.last_inspection_at, createdAt: t.created_at,
      })),
      industries: (await getLibrary({ includeInactive: true })).map((i) => ({ key: i.key, name: i.name, templates: i.templates.length, active: i.active })),
    };
  });

  r.post('/api/platform/tenants', async (ctx) => {
    requirePlatform(ctx, true);
    const b = ctx.body;
    const name = str(b.name, 120);
    if (!name) throw bad('Enter the company name.');
    const adminEmail = str(b.adminEmail, 160).toLowerCase();
    if (!emailOk(adminEmail)) throw bad('Enter a valid email for the client admin.');
    if (b.adminPassword) { const p = passwordProblem(b.adminPassword); if (p) throw bad(p); }
    if (b.planId && !(await db.one('SELECT id FROM plans WHERE id = $1', [b.planId]))) throw bad('Unknown plan.');
    const status = STATUSES.includes(b.status) ? b.status : 'trial';
    const trialDays = intOrNull(b.trialDays) ?? 14;
    const out = await createTenant({
      name, slug: str(b.slug, 40), industries: Array.isArray(b.industries) ? b.industries : [], planId: b.planId || (status === 'trial' ? 'trial' : null),
      status, trialEndsAt: status === 'trial' ? new Date(Date.now() + trialDays * 864e5).toISOString() : null,
      contactName: str(b.contactName, 80), contactEmail: str(b.contactEmail, 160) || adminEmail, contactPhone: str(b.contactPhone, 30),
      gstin: str(b.gstin, 20), address: text(b.address, 400), notes: text(b.notes, 2000), siteName: str(b.siteName, 120),
      adminEmail, adminName: str(b.adminName, 80), adminPassword: b.adminPassword || '',
    }, ctx.user.id);
    await audit(ctx, 'platform.tenant_created', 'tenant', out.tenantId, { name, plan: b.planId, industries: b.industries });
    return out;
  });

  r.post('/api/platform/demo', async (ctx) => {
    requirePlatform(ctx, true);
    const out = await createDemoTenant(ctx.user.id);
    await audit(ctx, 'platform.demo_created', 'tenant', out.tenantId);
    return out;
  });

  r.get('/api/platform/tenants/:id', async (ctx) => {
    requirePlatform(ctx);
    const t = await loadTenant(ctx.params.id);
    if (!t) throw notFound('Client');
    const plan = t.plan_id ? planRow(await db.one('SELECT * FROM plans WHERE id = $1', [t.plan_id]) || {}) : null;
    const users = await db.query('SELECT id, email, name, role, status, last_login_at, created_at FROM users WHERE tenant_id = $1 ORDER BY role, name', [t.id]);
    const since = new Date(Date.now() - 180 * 864e5).toISOString();
    const usage = await db.query('SELECT created_at, provider, key_source, ok FROM ai_usage WHERE tenant_id = $1 AND created_at >= $2', [t.id, since]);
    const insp = await db.query('SELECT created_at, final_tag FROM inspections WHERE tenant_id = $1 AND created_at >= $2', [t.id, since]);
    const months = {};
    usage.forEach((u) => { const m = u.created_at.slice(0, 7); months[m] ||= { month: m, aiCalls: 0, inspections: 0 }; months[m].aiCalls++; });
    insp.forEach((i) => { const m = i.created_at.slice(0, 7); months[m] ||= { month: m, aiCalls: 0, inspections: 0 }; months[m].inspections++; });
    return {
      tenant: {
        id: t.id, name: t.name, slug: t.slug, status: t.status, planId: t.plan_id, industries: t.industries, trialEndsAt: t.trial_ends_at,
        contactName: t.contact_name, contactEmail: t.contact_email, contactPhone: t.contact_phone, gstin: t.gstin, address: t.address, notes: t.notes,
        limits: t.limits, createdAt: t.created_at,
      },
      plan, effectiveLimits: limitsOf(t, plan),
      users,
      keys: await listKeys(t.id),
      counts: {
        templates: n(await db.value('SELECT CAST(COUNT(*) AS INTEGER) AS n FROM templates WHERE tenant_id = $1', [t.id])),
        assets: n(await db.value('SELECT CAST(COUNT(*) AS INTEGER) AS n FROM assets WHERE tenant_id = $1', [t.id])),
        sites: n(await db.value('SELECT CAST(COUNT(*) AS INTEGER) AS n FROM sites WHERE tenant_id = $1', [t.id])),
        inspections: n(await db.value('SELECT CAST(COUNT(*) AS INTEGER) AS n FROM inspections WHERE tenant_id = $1', [t.id])),
      },
      monthly: Object.values(months).sort((a, b) => a.month.localeCompare(b.month)),
    };
  });

  r.put('/api/platform/tenants/:id', async (ctx) => {
    requirePlatform(ctx, true);
    const t = await loadTenant(ctx.params.id);
    if (!t) throw notFound('Client');
    const b = ctx.body;
    if (b.planId && !(await db.one('SELECT id FROM plans WHERE id = $1', [b.planId]))) throw bad('Unknown plan.');
    const knownInd = await industryKeys();
    const lim = b.limits || t.limits || {};
    const limits = {};
    ['max_users', 'max_sites', 'max_inspections_month', 'max_ai_calls_month'].forEach((k) => { const v = intOrNull(lim[k]); if (v !== null) limits[k] = v; });
    if (lim.platform_ai !== undefined && lim.platform_ai !== '' && lim.platform_ai !== null) limits.platform_ai = bool(lim.platform_ai);
    const status = STATUSES.includes(b.status) ? b.status : t.status;
    await db.run(
      `UPDATE tenants SET name=$1, status=$2, plan_id=$3, trial_ends_at=$4, contact_name=$5, contact_email=$6, contact_phone=$7, gstin=$8, address=$9, notes=$10,
         limits=$11, industries=$12, updated_at=$13 WHERE id=$14`,
      [str(b.name ?? t.name, 120) || t.name, status, b.planId === undefined ? t.plan_id : (b.planId || null),
        b.trialEndsAt === undefined ? t.trial_ends_at : (b.trialEndsAt ? new Date(b.trialEndsAt).toISOString() : null),
        str(b.contactName ?? t.contact_name, 80), str(b.contactEmail ?? t.contact_email, 160), str(b.contactPhone ?? t.contact_phone, 30),
        str(b.gstin ?? t.gstin, 20), text(b.address ?? t.address, 400), text(b.notes ?? t.notes, 2000), j(limits),
        j(Array.isArray(b.industries) ? b.industries.filter((k) => knownInd.includes(k)) : t.industries), now(), t.id],
    );
    if (status !== t.status && ['suspended', 'cancelled'].includes(status)) {
      await db.run('UPDATE users SET token_version = token_version + 1 WHERE tenant_id = $1', [t.id]); // sign everyone out
    }
    await audit({ ...ctx, tenant: t }, 'platform.tenant_updated', 'tenant', t.id, { status, plan: b.planId, limits });
    return { ok: true };
  });

  r.post('/api/platform/tenants/:id/reset-admin', async (ctx) => {
    requirePlatform(ctx, true);
    const t = await loadTenant(ctx.params.id);
    if (!t) throw notFound('Client');
    const u = ctx.body.userId
      ? await db.one('SELECT id, email FROM users WHERE id = $1 AND tenant_id = $2', [ctx.body.userId, t.id])
      : await db.one("SELECT id, email FROM users WHERE tenant_id = $1 AND role = 'tenant_admin' ORDER BY created_at LIMIT 1", [t.id]);
    if (!u) throw notFound('Admin user');
    const password = randomPassword();
    await db.run("UPDATE users SET password_hash = $1, must_change_password = 1, status = 'active', token_version = token_version + 1, updated_at = $2 WHERE id = $3", [await hashPassword(password), now(), u.id]);
    await audit({ ...ctx, tenant: t }, 'platform.admin_password_reset', 'user', u.id);
    return { email: u.email, tempPassword: password };
  });

  r.delete('/api/platform/tenants/:id', async (ctx) => {
    requirePlatform(ctx, true);
    const t = await loadTenant(ctx.params.id);
    if (!t) throw notFound('Client');
    if (str(ctx.body.confirm, 60) !== t.slug) throw bad(`Type the client code "${t.slug}" to confirm deletion.`);
    await db.tx(async (q) => {
      for (const table of ['inspection_photos', 'inspections', 'corrective_actions', 'schedules', 'assets', 'templates', 'sites', 'ai_keys', 'ai_usage', 'users']) {
        await q.run(`DELETE FROM ${table} WHERE tenant_id = $1`, [t.id]);
      }
      await q.run('DELETE FROM tenants WHERE id = $1', [t.id]);
    });
    await audit(ctx, 'platform.tenant_deleted', 'tenant', t.id, { name: t.name, slug: t.slug });
    return { ok: true };
  });

  // ---------- plans ----------
  r.get('/api/platform/plans', async (ctx) => {
    requirePlatform(ctx);
    const rows = await db.query(`SELECT p.*, (SELECT CAST(COUNT(*) AS INTEGER) FROM tenants t WHERE t.plan_id = p.id) AS tenants FROM plans p ORDER BY p.sort, p.name`);
    return { plans: rows.map(planRow) };
  });
  const savePlan = async (ctx, id) => {
    requirePlatform(ctx, true);
    const b = ctx.body;
    const name = str(b.name, 60);
    if (!name) throw bad('Enter the plan name.');
    const vals = [name, text(b.description, 300), intOrNull(b.price_month) ?? 0, str(b.currency, 5) || 'INR', intOrNull(b.max_users), intOrNull(b.max_sites),
      intOrNull(b.max_inspections_month), intOrNull(b.max_ai_calls_month), bool(b.platform_ai) ? 1 : 0, intOrNull(b.sort) ?? 0, b.active === undefined ? 1 : (bool(b.active) ? 1 : 0), now()];
    if (id) {
      const c = await db.run('UPDATE plans SET name=$1, description=$2, price_month=$3, currency=$4, max_users=$5, max_sites=$6, max_inspections_month=$7, max_ai_calls_month=$8, platform_ai=$9, sort=$10, active=$11, updated_at=$12 WHERE id=$13', [...vals, id]);
      if (!c) throw notFound('Plan');
    } else {
      id = str(b.id, 30).toLowerCase().replace(/[^a-z0-9-]/g, '') || newId().slice(0, 8);
      if (await db.one('SELECT id FROM plans WHERE id = $1', [id])) throw new HttpError(409, 'A plan with this code already exists.');
      await db.run(`INSERT INTO plans (name, description, price_month, currency, max_users, max_sites, max_inspections_month, max_ai_calls_month, platform_ai, sort, active, updated_at, id, features, created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'{}',$12)`, [...vals, id]);
    }
    await audit(ctx, 'platform.plan_saved', 'plan', id, { name });
    return { id };
  };
  r.post('/api/platform/plans', (ctx) => savePlan(ctx));
  r.put('/api/platform/plans/:id', (ctx) => savePlan(ctx, ctx.params.id));
  r.delete('/api/platform/plans/:id', async (ctx) => {
    requirePlatform(ctx, true);
    const used = n(await db.value('SELECT CAST(COUNT(*) AS INTEGER) AS n FROM tenants WHERE plan_id = $1', [ctx.params.id]));
    if (used) throw bad(`${used} clients use this plan. Move them first, or mark the plan inactive.`);
    await db.run('DELETE FROM plans WHERE id = $1', [ctx.params.id]);
    await audit(ctx, 'platform.plan_deleted', 'plan', ctx.params.id);
    return { ok: true };
  });

  // ---------- platform AI keys (used by clients whose plan includes platform AI) ----------
  r.get('/api/platform/ai-keys', async (ctx) => {
    requirePlatform(ctx, true);
    return { keys: await listKeys(null), providers: providerCatalog(), envKeys: envKeys().map((k) => ({ provider: k.provider, model: k.model, label: k.label })), demoAi: config.aiMock };
  });
  r.post('/api/platform/ai-keys', async (ctx) => { requirePlatform(ctx, true); return createKey(ctx, null, ctx.body); });
  r.put('/api/platform/ai-keys/:id', async (ctx) => { requirePlatform(ctx, true); return { key: await updateKey(ctx, null, ctx.params.id, ctx.body) }; });
  r.delete('/api/platform/ai-keys/:id', async (ctx) => { requirePlatform(ctx, true); return deleteKey(ctx, null, ctx.params.id); });
  r.post('/api/platform/ai-keys/:id/test', async (ctx) => { requirePlatform(ctx, true); return testKey(ctx, null, ctx.params.id); });

  // ---------- platform staff ----------
  r.get('/api/platform/users', async (ctx) => {
    requirePlatform(ctx);
    const rows = await db.query('SELECT id, email, name, role, status, last_login_at, created_at FROM users WHERE tenant_id IS NULL ORDER BY name');
    return { users: rows, roles: Object.entries(PLATFORM_ROLES).map(([id, v]) => ({ id, ...v })) };
  });
  r.post('/api/platform/users', async (ctx) => {
    requirePlatform(ctx, true);
    const b = ctx.body;
    const email = str(b.email, 160).toLowerCase();
    if (!emailOk(email)) throw bad('Enter a valid email.');
    if (!PLATFORM_ROLES[b.role]) throw bad('Choose a role.');
    if (await db.one('SELECT id FROM users WHERE email = $1', [email])) throw new HttpError(409, 'A user with this email already exists.');
    const password = randomPassword();
    const id = newId(); const ts = now();
    await db.run("INSERT INTO users (id, tenant_id, email, name, role, password_hash, status, must_change_password, created_at, updated_at) VALUES ($1,NULL,$2,$3,$4,$5,'active',1,$6,$6)",
      [id, email, str(b.name, 80) || email, b.role, await hashPassword(password), ts]);
    await audit(ctx, 'platform.staff_created', 'user', id, { email, role: b.role });
    return { id, tempPassword: password };
  });
  r.put('/api/platform/users/:id', async (ctx) => {
    requirePlatform(ctx, true);
    const u = await db.one('SELECT * FROM users WHERE id = $1 AND tenant_id IS NULL', [ctx.params.id]);
    if (!u) throw notFound('User');
    const b = ctx.body;
    const role = PLATFORM_ROLES[b.role] ? b.role : u.role;
    const status = ['active', 'disabled'].includes(b.status) ? b.status : u.status;
    if (u.id === ctx.user.id && (role !== 'super_admin' || status !== 'active')) throw bad('You cannot remove your own super admin access.');
    let tempPassword = null;
    let hash = u.password_hash;
    if (b.resetPassword) { tempPassword = randomPassword(); hash = await hashPassword(tempPassword); }
    await db.run('UPDATE users SET name = $1, role = $2, status = $3, password_hash = $4, token_version = token_version + $5, must_change_password = $6, updated_at = $7 WHERE id = $8',
      [str(b.name ?? u.name, 80), role, status, hash, role !== u.role || status !== u.status || tempPassword ? 1 : 0, tempPassword ? 1 : u.must_change_password, now(), u.id]);
    await audit(ctx, 'platform.staff_updated', 'user', u.id, { role, status, passwordReset: Boolean(tempPassword) });
    return { ok: true, tempPassword };
  });

  // ---------- audit + library ----------
  r.get('/api/platform/audit', async (ctx) => {
    requirePlatform(ctx);
    const params = [];
    let w = '1=1';
    if (ctx.query.tenant) { params.push(ctx.query.tenant); w += ` AND l.tenant_id = $${params.length}`; }
    if (ctx.query.platformOnly === '1') w += ' AND l.tenant_id IS NULL';
    const rows = await db.query(`SELECT l.*, t.name AS tenant_name FROM audit_log l LEFT JOIN tenants t ON t.id = l.tenant_id WHERE ${w} ORDER BY l.created_at DESC LIMIT 300`, params);
    return { entries: rows.map((e) => ({ ...e, details: pj(e.details, null) })) };
  });
  // ---------- template library: industries + templates (add / edit without code changes) ----------
  r.get('/api/platform/library', async (ctx) => { requirePlatform(ctx); return { industries: await getLibrary({ includeInactive: true }) }; });

  r.post('/api/platform/library/industries', async (ctx) => {
    requirePlatform(ctx, true);
    const name = str(ctx.body.name, 80);
    if (!name) throw bad('Enter the industry name.');
    const key = (str(ctx.body.key, 40) || name).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40);
    if (await db.one('SELECT key FROM library_industries WHERE key = $1', [key])) throw new HttpError(409, 'An industry with this code already exists.');
    const sort = n(await db.value('SELECT CAST(COALESCE(MAX(sort), 0) AS INTEGER) AS n FROM library_industries')) + 1;
    await db.run('INSERT INTO library_industries (key, name, description, sort, active, builtin, created_at, updated_at) VALUES ($1,$2,$3,$4,1,0,$5,$5)', [key, name, text(ctx.body.description, 300), sort, now()]);
    await audit(ctx, 'library.industry_created', 'industry', key, { name });
    return { key };
  });
  r.put('/api/platform/library/industries/:key', async (ctx) => {
    requirePlatform(ctx, true);
    const c = await db.run('UPDATE library_industries SET name = $1, description = $2, active = $3, sort = COALESCE($4, sort), updated_at = $5 WHERE key = $6',
      [str(ctx.body.name, 80), text(ctx.body.description, 300), ctx.body.active === false ? 0 : 1, intOrNull(ctx.body.sort), now(), ctx.params.key]);
    if (!c) throw notFound('Industry');
    await audit(ctx, 'library.industry_updated', 'industry', ctx.params.key);
    return { ok: true };
  });
  r.delete('/api/platform/library/industries/:key', async (ctx) => {
    requirePlatform(ctx, true);
    const cnt = n(await db.value('SELECT CAST(COUNT(*) AS INTEGER) AS n FROM library_templates WHERE industry_key = $1', [ctx.params.key]));
    if (cnt) throw bad(`This industry has ${cnt} templates. Delete or move them first, or switch the industry off.`);
    await db.run('DELETE FROM library_industries WHERE key = $1', [ctx.params.key]);
    await audit(ctx, 'library.industry_deleted', 'industry', ctx.params.key);
    return { ok: true };
  });

  r.get('/api/platform/library/templates/:id', async (ctx) => {
    requirePlatform(ctx);
    const t = await getLibraryTemplate(ctx.params.id);
    return { template: { id: t.id, industry: t.industry_key, key: t.key, active: Boolean(t.active), builtin: Boolean(t.builtin), ...t.data } };
  });
  const saveLib = async (ctx, id) => {
    requirePlatform(ctx, true);
    const b = ctx.body;
    if (!(await db.one('SELECT key FROM library_industries WHERE key = $1', [b.industry]))) throw bad('Choose an industry.');
    const name = str(b.name, 80);
    if (!name) throw bad('Enter the template name.');
    const angles = (Array.isArray(b.angles) ? b.angles : []).map((a) => ({ name: str(a?.name, 60), guidance: str(a?.guidance, 200), parts: (Array.isArray(a?.parts) ? a.parts : String(a?.parts || '').split('\n')).map((x) => str(x, 300)).filter(Boolean) })).filter((a) => a.name);
    if (!angles.length || !angles.some((a) => a.parts.length)) throw bad('Add at least one view with checks.');
    const data = toData({ ...b, name, angles, general_parts: (Array.isArray(b.general_parts) ? b.general_parts : []).map((x) => str(x, 300)).filter(Boolean) });
    const ts = now();
    if (id) {
      const c = await db.run('UPDATE library_templates SET industry_key = $1, name = $2, description = $3, data = $4, active = $5, updated_at = $6 WHERE id = $7',
        [b.industry, name, text(b.description, 400), j(data), b.active === false ? 0 : 1, ts, id]);
      if (!c) throw notFound('Library template');
    } else {
      id = newId();
      await db.run('INSERT INTO library_templates (id, industry_key, key, name, description, data, active, builtin, sort, source_tenant_id, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,1,0,999,$7,$8,$8)',
        [id, b.industry, await uniqueTemplateKey(b.industry, name), name, text(b.description, 400), j(data), b.sourceTenantId || null, ts]);
    }
    await audit(ctx, 'library.template_saved', 'library_template', id, { name, industry: b.industry });
    return { id };
  };
  r.post('/api/platform/library/templates', (ctx) => saveLib(ctx));
  r.put('/api/platform/library/templates/:id', (ctx) => saveLib(ctx, ctx.params.id));
  r.delete('/api/platform/library/templates/:id', async (ctx) => {
    requirePlatform(ctx, true);
    await db.run('DELETE FROM library_templates WHERE id = $1', [ctx.params.id]);
    await audit(ctx, 'library.template_deleted', 'library_template', ctx.params.id);
    return { ok: true };
  });
  // Copy a good template from a client account into the shared library
  r.post('/api/platform/library/promote', async (ctx) => {
    requirePlatform(ctx, true);
    const t = await db.one('SELECT * FROM templates WHERE id = $1', [str(ctx.body.templateId, 60)]);
    if (!t) throw notFound('Template');
    const p = publicTemplate(t);
    ctx.body = { ...p, industry: ctx.body.industry, sourceTenantId: t.tenant_id };
    return saveLib(ctx);
  });
  r.get('/api/platform/library-suggestions', async (ctx) => {
    requirePlatform(ctx);
    const rows = await db.query("SELECT l.*, t.name AS tenant_name FROM audit_log l LEFT JOIN tenants t ON t.id = l.tenant_id WHERE l.action = 'template.library_suggested' ORDER BY l.created_at DESC LIMIT 100");
    return { suggestions: rows.map((e) => ({ id: e.id, tenantId: e.tenant_id, tenantName: e.tenant_name, templateId: e.entity_id, by: e.user_name, at: e.created_at, details: pj(e.details, {}) })) };
  });
}
