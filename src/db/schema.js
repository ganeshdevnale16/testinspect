// Database tables. Every client-owned row carries tenant_id, and every query filters on it.
// Migrations are numbered; each runs once and is recorded in the kv table.
import { db, kvGet, kvSet } from './index.js';

const T = 'TEXT';
const MIGRATIONS = [
  // 1: base schema
  `
CREATE TABLE IF NOT EXISTS plans (
  id ${T} PRIMARY KEY, name ${T} NOT NULL, description ${T}, price_month INTEGER DEFAULT 0, currency ${T} DEFAULT 'INR',
  max_users INTEGER, max_sites INTEGER, max_inspections_month INTEGER, max_ai_calls_month INTEGER,
  platform_ai INTEGER DEFAULT 0, features ${T} DEFAULT '{}', sort INTEGER DEFAULT 0, active INTEGER DEFAULT 1,
  created_at ${T}, updated_at ${T}
);
CREATE TABLE IF NOT EXISTS tenants (
  id ${T} PRIMARY KEY, name ${T} NOT NULL, slug ${T} NOT NULL UNIQUE, industries ${T} DEFAULT '[]', plan_id ${T},
  status ${T} DEFAULT 'active', trial_ends_at ${T}, contact_name ${T}, contact_email ${T}, contact_phone ${T},
  gstin ${T}, address ${T}, notes ${T}, settings ${T} DEFAULT '{}', limits ${T} DEFAULT '{}',
  created_at ${T}, updated_at ${T}
);
CREATE TABLE IF NOT EXISTS users (
  id ${T} PRIMARY KEY, tenant_id ${T}, email ${T} NOT NULL UNIQUE, name ${T}, role ${T} NOT NULL, password_hash ${T},
  status ${T} DEFAULT 'active', phone ${T}, emp_id ${T}, title ${T}, site_ids ${T} DEFAULT '[]',
  token_version INTEGER DEFAULT 0, must_change_password INTEGER DEFAULT 0, last_login_at ${T},
  created_at ${T}, updated_at ${T}
);
CREATE INDEX IF NOT EXISTS ix_users_tenant ON users (tenant_id);
CREATE TABLE IF NOT EXISTS ai_keys (
  id ${T} PRIMARY KEY, tenant_id ${T}, provider ${T} NOT NULL, label ${T}, enc_key ${T} NOT NULL, key_hint ${T},
  model ${T}, endpoint ${T}, api_version ${T}, is_default INTEGER DEFAULT 0, status ${T} DEFAULT 'untested',
  last_tested_at ${T}, last_error ${T}, created_by ${T}, created_at ${T}, updated_at ${T}
);
CREATE INDEX IF NOT EXISTS ix_ai_keys_tenant ON ai_keys (tenant_id);
CREATE TABLE IF NOT EXISTS sites (
  id ${T} PRIMARY KEY, tenant_id ${T} NOT NULL, name ${T} NOT NULL, code ${T}, address ${T}, notes ${T},
  created_at ${T}, updated_at ${T}
);
CREATE INDEX IF NOT EXISTS ix_sites_tenant ON sites (tenant_id);
CREATE TABLE IF NOT EXISTS templates (
  id ${T} PRIMARY KEY, tenant_id ${T} NOT NULL, library_key ${T}, name ${T} NOT NULL, description ${T},
  industry ${T}, category ${T}, id_label ${T}, safety INTEGER DEFAULT 0, ai_context ${T},
  angles ${T} DEFAULT '[]', general_parts ${T} DEFAULT '[]', custom_fields ${T} DEFAULT '[]',
  frequency_days INTEGER, active INTEGER DEFAULT 1, version INTEGER DEFAULT 1,
  created_by ${T}, created_at ${T}, updated_at ${T}
);
CREATE INDEX IF NOT EXISTS ix_templates_tenant ON templates (tenant_id);
CREATE TABLE IF NOT EXISTS assets (
  id ${T} PRIMARY KEY, tenant_id ${T} NOT NULL, site_id ${T}, template_id ${T}, code ${T} NOT NULL, name ${T},
  location ${T}, details ${T} DEFAULT '{}', status ${T} DEFAULT 'active', last_inspection_id ${T},
  last_inspected_at ${T}, last_tag ${T}, next_due_at ${T}, created_at ${T}, updated_at ${T},
  UNIQUE (tenant_id, code)
);
CREATE INDEX IF NOT EXISTS ix_assets_tenant ON assets (tenant_id);
CREATE TABLE IF NOT EXISTS schedules (
  id ${T} PRIMARY KEY, tenant_id ${T} NOT NULL, title ${T}, template_id ${T} NOT NULL, asset_id ${T}, site_id ${T},
  assignee_id ${T}, frequency_days INTEGER NOT NULL, next_due_at ${T}, active INTEGER DEFAULT 1,
  created_at ${T}, updated_at ${T}
);
CREATE INDEX IF NOT EXISTS ix_schedules_tenant ON schedules (tenant_id);
CREATE TABLE IF NOT EXISTS inspections (
  id ${T} PRIMARY KEY, tenant_id ${T} NOT NULL, template_id ${T}, template_name ${T}, asset_id ${T}, asset_code ${T},
  site_id ${T}, location ${T}, inspector_id ${T}, inspector_name ${T}, mode ${T}, ai_status ${T}, final_tag ${T},
  completion INTEGER, counts ${T}, result ${T}, meta ${T}, override ${T}, signoff ${T},
  review_status ${T} DEFAULT 'not_required', review ${T}, provider ${T}, model ${T},
  created_at ${T}, updated_at ${T}
);
CREATE INDEX IF NOT EXISTS ix_insp_tenant_date ON inspections (tenant_id, created_at);
CREATE INDEX IF NOT EXISTS ix_insp_asset ON inspections (tenant_id, asset_id);
CREATE TABLE IF NOT EXISTS inspection_photos (
  id ${T} PRIMARY KEY, inspection_id ${T} NOT NULL, tenant_id ${T} NOT NULL, view_name ${T}, data ${T},
  quality ${T}, created_at ${T}
);
CREATE INDEX IF NOT EXISTS ix_photos_insp ON inspection_photos (inspection_id);
CREATE TABLE IF NOT EXISTS corrective_actions (
  id ${T} PRIMARY KEY, tenant_id ${T} NOT NULL, inspection_id ${T}, asset_id ${T}, site_id ${T}, title ${T} NOT NULL,
  description ${T}, severity ${T} DEFAULT 'medium', status ${T} DEFAULT 'open', assignee_id ${T}, due_at ${T},
  closure_note ${T}, closure_photo ${T}, closed_by ${T}, closed_at ${T}, created_by ${T}, created_at ${T}, updated_at ${T}
);
CREATE INDEX IF NOT EXISTS ix_actions_tenant ON corrective_actions (tenant_id, status);
CREATE TABLE IF NOT EXISTS ai_usage (
  id ${T} PRIMARY KEY, tenant_id ${T}, user_id ${T}, kind ${T}, provider ${T}, model ${T}, key_source ${T},
  tokens_in INTEGER DEFAULT 0, tokens_out INTEGER DEFAULT 0, ok INTEGER DEFAULT 1, ms INTEGER, created_at ${T}
);
CREATE INDEX IF NOT EXISTS ix_usage_tenant_date ON ai_usage (tenant_id, created_at);
CREATE TABLE IF NOT EXISTS audit_log (
  id ${T} PRIMARY KEY, tenant_id ${T}, user_id ${T}, user_name ${T}, action ${T}, entity ${T}, entity_id ${T},
  details ${T}, ip ${T}, created_at ${T}
);
CREATE INDEX IF NOT EXISTS ix_audit_tenant_date ON audit_log (tenant_id, created_at);
`,
  // 2: editable industry + template library (managed by the platform owner)
  `
CREATE TABLE IF NOT EXISTS library_industries (
  key ${T} PRIMARY KEY, name ${T} NOT NULL, description ${T}, sort INTEGER DEFAULT 0, active INTEGER DEFAULT 1,
  builtin INTEGER DEFAULT 0, created_at ${T}, updated_at ${T}
);
CREATE TABLE IF NOT EXISTS library_templates (
  id ${T} PRIMARY KEY, industry_key ${T} NOT NULL, key ${T} NOT NULL, name ${T} NOT NULL, description ${T},
  data ${T} NOT NULL, active INTEGER DEFAULT 1, builtin INTEGER DEFAULT 0, sort INTEGER DEFAULT 0,
  source_tenant_id ${T}, created_at ${T}, updated_at ${T}, UNIQUE (industry_key, key)
);
`,
];

export async function migrate() {
  await db.exec('CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT)');
  const done = Number(await kvGet('schema_version')) || 0;
  for (let i = done; i < MIGRATIONS.length; i++) {
    // run statement by statement (pg accepts a script too, but this gives clearer errors)
    for (const stmt of MIGRATIONS[i].split(';').map((s) => s.trim()).filter(Boolean)) await db.exec(stmt);
    await kvSet('schema_version', String(i + 1));
    console.log(`[db] migration ${i + 1} applied`);
  }
}
