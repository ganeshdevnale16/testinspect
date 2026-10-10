// Business operations used by several routes + first-start seeding.
import { db, newId, now, j, pj } from './db/index.js';
import { hashPassword, randomPassword } from './security.js';
import { config } from './config.js';
import { getLibraryTemplate, seedLibrary } from './library-db.js';
import { HttpError, slugify } from './http.js';

export const DEFAULT_SETTINGS = {
  branding: { color: '#F5B800', logo: '', report_footer: '', app_name: '' },
  workflow: { require_review: false, auto_actions: true, auto_create_assets: true, inspectors_see_all: false, action_due_days: 7 },
  ai: { main_key_id: '', verify_key_id: '', min_confidence: 0.7, strict_verify: true, language: '' },
  webhook: { url: '', secret: '', events: ['inspection.created', 'inspection.reviewed', 'action.created'] },
};
export function mergeSettings(s = {}) {
  const out = {};
  for (const [k, def] of Object.entries(DEFAULT_SETTINGS)) out[k] = { ...def, ...(s[k] || {}) };
  return out;
}

// Copies a library template (by its library id) into a client's account.
export async function importLibraryTemplate(q, tenantId, libraryId, userId = null) {
  const lt = await getLibraryTemplate(libraryId);
  const t = lt.data;
  const id = newId();
  const ts = now();
  await q.run(
    `INSERT INTO templates (id, tenant_id, library_key, name, description, industry, category, id_label, safety, ai_context,
      angles, general_parts, custom_fields, frequency_days, active, version, created_by, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,1,1,$15,$16,$16)`,
    [id, tenantId, `${lt.industry_key}/${lt.key}`, t.name, t.description || '', lt.industry_key, t.category || '', t.idLabel || '',
      t.safety ? 1 : 0, t.aiContext || '', j(t.angles || []), j(t.general_parts || []), j(t.customFields || []),
      t.frequencyDays ?? null, userId, ts],
  );
  return id;
}

export async function uniqueSlug(name) {
  const base = slugify(name) || 'client';
  let slug = base; let n = 1;
  while (await db.one('SELECT id FROM tenants WHERE slug = $1', [slug])) slug = `${base}-${++n}`;
  return slug;
}

// Creates a client company with its first admin user and the templates for its industries.
export async function createTenant(input, byUserId) {
  const email = String(input.adminEmail || '').trim().toLowerCase();
  if (await db.one('SELECT id FROM users WHERE email = $1', [email])) throw new HttpError(409, 'A user with this admin email already exists.');
  const tenantId = newId();
  const ts = now();
  const password = input.adminPassword || randomPassword();
  const hash = await hashPassword(password);
  const slug = await uniqueSlug(input.slug || input.name);
  const known = (await db.query('SELECT key FROM library_industries')).map((r) => r.key);
  const industries = (input.industries || []).filter((k) => known.includes(k));
  const libIds = industries.length
    ? (await db.query(`SELECT id FROM library_templates WHERE active = 1 AND industry_key IN (${industries.map((_, i) => '$' + (i + 1)).join(',')})`, industries)).map((r) => r.id)
    : [];
  await db.tx(async (q) => {
    await q.run(
      `INSERT INTO tenants (id, name, slug, industries, plan_id, status, trial_ends_at, contact_name, contact_email, contact_phone,
        gstin, address, notes, settings, limits, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$16)`,
      [tenantId, input.name, slug, j(industries), input.planId || null, input.status || 'active', input.trialEndsAt || null,
        input.contactName || '', input.contactEmail || email, input.contactPhone || '', input.gstin || '', input.address || '',
        input.notes || '', j(mergeSettings({})), j(input.limits || {}), ts],
    );
    await q.run(
      `INSERT INTO users (id, tenant_id, email, name, role, password_hash, status, must_change_password, created_at, updated_at)
       VALUES ($1,$2,$3,$4,'tenant_admin',$5,'active',1,$6,$6)`,
      [newId(), tenantId, email, input.adminName || input.contactName || 'Admin', hash, ts],
    );
    if (input.siteName) {
      await q.run('INSERT INTO sites (id, tenant_id, name, code, address, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$6)',
        [newId(), tenantId, input.siteName, '', input.address || '', ts]);
    }
    for (const libId of libIds) await importLibraryTemplate(q, tenantId, libId, byUserId);
  });
  return { tenantId, slug, adminEmail: email, adminPassword: input.adminPassword ? null : password };
}

const DEFAULT_PLANS = [
  { id: 'trial', name: 'Free trial', description: '14-day trial on platform AI', price_month: 0, max_users: 5, max_sites: 2, max_inspections_month: 100, max_ai_calls_month: 600, platform_ai: 1, sort: 0 },
  { id: 'starter', name: 'Starter', description: 'Small teams, own AI key', price_month: 4999, max_users: 10, max_sites: 3, max_inspections_month: 500, max_ai_calls_month: 4000, platform_ai: 0, sort: 1 },
  { id: 'pro', name: 'Professional', description: 'Multi-site teams, approvals, webhooks', price_month: 14999, max_users: 50, max_sites: 25, max_inspections_month: 3000, max_ai_calls_month: 25000, platform_ai: 0, sort: 2 },
  { id: 'enterprise', name: 'Enterprise', description: 'Unlimited, custom terms', price_month: 0, max_users: null, max_sites: null, max_inspections_month: null, max_ai_calls_month: null, platform_ai: 1, sort: 3 },
];

export async function seed() {
  const ts = now();
  await seedLibrary();
  const planCount = Number(await db.value('SELECT CAST(COUNT(*) AS INTEGER) AS n FROM plans'));
  if (!planCount) {
    for (const p of DEFAULT_PLANS) {
      await db.run(
        `INSERT INTO plans (id, name, description, price_month, currency, max_users, max_sites, max_inspections_month, max_ai_calls_month, platform_ai, features, sort, active, created_at, updated_at)
         VALUES ($1,$2,$3,$4,'INR',$5,$6,$7,$8,$9,'{}',$10,1,$11,$11)`,
        [p.id, p.name, p.description, p.price_month, p.max_users, p.max_sites, p.max_inspections_month, p.max_ai_calls_month, p.platform_ai, p.sort, ts],
      );
    }
    console.log('[seed] default plans created');
  }
  const hasOwner = await db.one("SELECT id FROM users WHERE role = 'super_admin' LIMIT 1");
  if (!hasOwner) {
    const email = (config.superAdminEmail || 'owner@example.com').toLowerCase();
    const password = config.superAdminPassword || randomPassword();
    await db.run(
      `INSERT INTO users (id, tenant_id, email, name, role, password_hash, status, must_change_password, created_at, updated_at)
       VALUES ($1, NULL, $2, $3, 'super_admin', $4, 'active', $5, $6, $6)`,
      [newId(), email, config.superAdminName, await hashPassword(password), config.superAdminPassword ? 0 : 1, ts],
    );
    console.log('\n==================== PLATFORM OWNER ACCOUNT ====================');
    console.log(` Email:    ${email}`);
    console.log(` Password: ${config.superAdminPassword ? '(from SUPERADMIN_PASSWORD)' : password}`);
    console.log(' Sign in at /console and change the password.');
    console.log('================================================================\n');
  }
}

// Demo client with sample data - handy for sales demos.
export async function createDemoTenant(byUserId) {
  const stamp = Date.now().toString(36).slice(-4);
  const out = await createTenant({
    name: `Demo Industries ${stamp}`, industries: ['construction', 'fire_safety', 'electrical', 'warehouse'], planId: 'trial', status: 'trial',
    trialEndsAt: new Date(Date.now() + 14 * 864e5).toISOString(), adminEmail: `demo-admin-${stamp}@demo.local`, adminName: 'Demo Admin',
    siteName: 'Plant 1 - Pune', contactName: 'Demo contact',
  }, byUserId);
  const ts = now();
  const site = await db.one('SELECT id FROM sites WHERE tenant_id = $1', [out.tenantId]);
  await db.run('INSERT INTO sites (id, tenant_id, name, code, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$5)', [newId(), out.tenantId, 'Warehouse - Chakan', 'WH1', ts]);
  const inspectorPw = randomPassword();
  await db.run(
    `INSERT INTO users (id, tenant_id, email, name, role, password_hash, status, created_at, updated_at) VALUES ($1,$2,$3,'Ramesh (inspector)','inspector',$4,'active',$5,$5)`,
    [newId(), out.tenantId, `demo-inspector-${stamp}@demo.local`, await hashPassword(inspectorPw), ts],
  );
  const tpls = await db.query('SELECT id, name, frequency_days FROM templates WHERE tenant_id = $1', [out.tenantId]);
  const ext = tpls.find((t) => /extinguisher/i.test(t.name));
  if (ext) {
    for (const [code, days] of [['FE-001', -3], ['FE-002', 2], ['FE-003', 20]]) {
      await db.run(
        `INSERT INTO assets (id, tenant_id, site_id, template_id, code, name, location, details, status, next_due_at, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'{}','active',$8,$9,$9)`,
        [newId(), out.tenantId, site?.id || null, ext.id, code, 'Fire extinguisher', 'Production hall', new Date(Date.now() + days * 864e5).toISOString(), ts],
      );
    }
  }
  return { ...out, inspectorEmail: `demo-inspector-${stamp}@demo.local`, inspectorPassword: inspectorPw };
}

export { pj };
