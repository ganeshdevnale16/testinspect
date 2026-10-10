// Asset register (each physical thing with an ID / QR label), recurring schedules and the "due" list.
import { db, newId, now, j, pj } from '../db/index.js';
import { HttpError, bad, notFound, str, text, intOrNull, bool } from '../http.js';
import { requirePerm, requireWrite, audit } from '../auth.js';

const addDays = (iso, d) => new Date(new Date(iso).getTime() + d * 864e5).toISOString();

function scopeFilter(ctx, alias = 'a') {
  const s = ctx.siteScope || [];
  if (!s.length) return { sql: '', params: [] };
  return { sql: ` AND ${alias}.site_id IN (${s.map((_, i) => `$__${i}`).join(',')})`, params: s };
}
// replaces $__0.. placeholders with real numbered params after `offset`
function bindScope(sql, offset) { return sql.replace(/\$__(\d+)/g, (_, i) => `$${offset + Number(i) + 1}`); }

function publicAsset(a) {
  return {
    id: a.id, code: a.code, name: a.name || '', location: a.location || '', siteId: a.site_id, siteName: a.site_name || '',
    templateId: a.template_id, templateName: a.template_name || '', details: pj(a.details, {}), status: a.status,
    lastInspectionId: a.last_inspection_id, lastInspectedAt: a.last_inspected_at, lastTag: a.last_tag, nextDueAt: a.next_due_at,
    overdue: Boolean(a.next_due_at && a.next_due_at < now()), createdAt: a.created_at,
  };
}

async function checkRefs(ctx, siteId, templateId) {
  if (siteId && !(await db.one('SELECT id FROM sites WHERE id = $1 AND tenant_id = $2', [siteId, ctx.tenant.id]))) throw bad('Unknown site.');
  if (templateId && !(await db.one('SELECT id FROM templates WHERE id = $1 AND tenant_id = $2', [templateId, ctx.tenant.id]))) throw bad('Unknown inspection type.');
}

export default function routes(r) {
  r.get('/api/assets', async (ctx) => {
    requirePerm(ctx, 'asset.view');
    const q = ctx.query;
    const params = [ctx.tenant.id];
    let where = 'a.tenant_id = $1';
    if (q.site) { params.push(q.site); where += ` AND a.site_id = $${params.length}`; }
    if (q.template) { params.push(q.template); where += ` AND a.template_id = $${params.length}`; }
    if (q.status) { params.push(q.status); where += ` AND a.status = $${params.length}`; }
    if (q.q) { params.push(`%${String(q.q).toLowerCase()}%`); where += ` AND (LOWER(a.code) LIKE $${params.length} OR LOWER(COALESCE(a.name,'')) LIKE $${params.length} OR LOWER(COALESCE(a.location,'')) LIKE $${params.length})`; }
    if (q.due === 'overdue') { params.push(now()); where += ` AND a.next_due_at IS NOT NULL AND a.next_due_at < $${params.length}`; }
    const sc = scopeFilter(ctx);
    const rows = await db.query(
      `SELECT a.*, s.name AS site_name, t.name AS template_name FROM assets a
       LEFT JOIN sites s ON s.id = a.site_id LEFT JOIN templates t ON t.id = a.template_id
       WHERE ${where}${bindScope(sc.sql, params.length)} ORDER BY a.code LIMIT 2000`, [...params, ...sc.params]);
    return { assets: rows.map(publicAsset) };
  });

  // Field app: find an asset by its code (typed or scanned from a QR label)
  r.get('/api/assets/lookup', async (ctx) => {
    requirePerm(ctx, 'asset.view');
    const code = str(ctx.query.code, 80);
    if (!code) return { asset: null };
    const a = await db.one(
      `SELECT a.*, s.name AS site_name, t.name AS template_name FROM assets a LEFT JOIN sites s ON s.id = a.site_id LEFT JOIN templates t ON t.id = a.template_id
       WHERE a.tenant_id = $1 AND LOWER(a.code) = LOWER($2)`, [ctx.tenant.id, code]);
    return { asset: a ? publicAsset(a) : null };
  });

  r.get('/api/assets/:id', async (ctx) => {
    requirePerm(ctx, 'asset.view');
    const a = await db.one(
      `SELECT a.*, s.name AS site_name, t.name AS template_name FROM assets a LEFT JOIN sites s ON s.id = a.site_id LEFT JOIN templates t ON t.id = a.template_id
       WHERE a.id = $1 AND a.tenant_id = $2`, [ctx.params.id, ctx.tenant.id]);
    if (!a) throw notFound('Asset');
    const history = await db.query(
      `SELECT id, template_name, final_tag, ai_status, completion, inspector_name, review_status, created_at FROM inspections
       WHERE tenant_id = $1 AND asset_id = $2 ORDER BY created_at DESC LIMIT 50`, [ctx.tenant.id, a.id]);
    const actions = await db.query(
      "SELECT id, title, severity, status, due_at FROM corrective_actions WHERE tenant_id = $1 AND asset_id = $2 AND status IN ('open','in_progress') ORDER BY created_at DESC", [ctx.tenant.id, a.id]);
    return { asset: publicAsset(a), history, actions };
  });

  r.post('/api/assets', async (ctx) => {
    requirePerm(ctx, 'asset.manage'); requireWrite(ctx);
    const b = ctx.body;
    const code = str(b.code, 80);
    if (!code) throw bad('Enter the asset ID / code.');
    await checkRefs(ctx, b.siteId, b.templateId);
    if (await db.one('SELECT id FROM assets WHERE tenant_id = $1 AND LOWER(code) = LOWER($2)', [ctx.tenant.id, code])) throw new HttpError(409, `Asset ${code} already exists.`);
    const id = newId(); const ts = now();
    await db.run(
      `INSERT INTO assets (id, tenant_id, site_id, template_id, code, name, location, details, status, next_due_at, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'active',$9,$10,$10)`,
      [id, ctx.tenant.id, b.siteId || null, b.templateId || null, code, str(b.name, 120), str(b.location, 160), j(b.details || {}), b.nextDueAt || null, ts],
    );
    await audit(ctx, 'asset.created', 'asset', id, { code });
    return { id };
  });

  r.put('/api/assets/:id', async (ctx) => {
    requirePerm(ctx, 'asset.manage'); requireWrite(ctx);
    const b = ctx.body;
    const a = await db.one('SELECT * FROM assets WHERE id = $1 AND tenant_id = $2', [ctx.params.id, ctx.tenant.id]);
    if (!a) throw notFound('Asset');
    await checkRefs(ctx, b.siteId, b.templateId);
    const code = str(b.code ?? a.code, 80);
    if (code.toLowerCase() !== a.code.toLowerCase() && await db.one('SELECT id FROM assets WHERE tenant_id = $1 AND LOWER(code) = LOWER($2)', [ctx.tenant.id, code])) throw new HttpError(409, `Asset ${code} already exists.`);
    await db.run(
      'UPDATE assets SET code=$1, name=$2, location=$3, site_id=$4, template_id=$5, details=$6, status=$7, next_due_at=$8, updated_at=$9 WHERE id=$10',
      [code, str(b.name ?? a.name, 120), str(b.location ?? a.location, 160), b.siteId === undefined ? a.site_id : (b.siteId || null),
        b.templateId === undefined ? a.template_id : (b.templateId || null), j(b.details ?? pj(a.details, {})),
        ['active', 'retired', 'out_of_service'].includes(b.status) ? b.status : a.status, b.nextDueAt === undefined ? a.next_due_at : (b.nextDueAt || null), now(), a.id],
    );
    await audit(ctx, 'asset.updated', 'asset', a.id, { code });
    return { ok: true };
  });

  r.delete('/api/assets/:id', async (ctx) => {
    requirePerm(ctx, 'asset.manage'); requireWrite(ctx);
    const n = await db.run('DELETE FROM assets WHERE id = $1 AND tenant_id = $2', [ctx.params.id, ctx.tenant.id]);
    if (!n) throw notFound('Asset');
    await db.run('DELETE FROM schedules WHERE asset_id = $1 AND tenant_id = $2', [ctx.params.id, ctx.tenant.id]);
    await audit(ctx, 'asset.deleted', 'asset', ctx.params.id);
    return { ok: true };
  });

  // CSV import (parsed in the browser): rows of { code, name, location, site, type }
  r.post('/api/assets/import', async (ctx) => {
    requirePerm(ctx, 'asset.manage'); requireWrite(ctx);
    const rows = (Array.isArray(ctx.body.rows) ? ctx.body.rows : []).slice(0, 5000);
    if (!rows.length) throw bad('No rows to import.');
    const sites = await db.query('SELECT id, name, code FROM sites WHERE tenant_id = $1', [ctx.tenant.id]);
    const tpls = await db.query('SELECT id, name FROM templates WHERE tenant_id = $1', [ctx.tenant.id]);
    const low = (s) => String(s || '').trim().toLowerCase();
    let created = 0; let updated = 0; const errors = [];
    const ts = now();
    await db.tx(async (q) => {
      for (const [i, row] of rows.entries()) {
        const code = str(row.code, 80);
        if (!code) { errors.push(`Row ${i + 2}: missing code`); continue; }
        const site = sites.find((s) => low(s.name) === low(row.site) || (s.code && low(s.code) === low(row.site)));
        const tpl = tpls.find((t) => low(t.name) === low(row.type));
        const existing = await q.one('SELECT id FROM assets WHERE tenant_id = $1 AND LOWER(code) = LOWER($2)', [ctx.tenant.id, code]);
        if (existing) {
          await q.run('UPDATE assets SET name = $1, location = $2, site_id = COALESCE($3, site_id), template_id = COALESCE($4, template_id), updated_at = $5 WHERE id = $6',
            [str(row.name, 120), str(row.location, 160), site?.id || null, tpl?.id || null, ts, existing.id]);
          updated++;
        } else {
          await q.run(`INSERT INTO assets (id, tenant_id, site_id, template_id, code, name, location, details, status, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,'{}','active',$8,$8)`,
            [newId(), ctx.tenant.id, site?.id || null, tpl?.id || null, code, str(row.name, 120), str(row.location, 160), ts]);
          created++;
        }
      }
    });
    await audit(ctx, 'asset.imported', 'asset', '', { created, updated });
    return { created, updated, errors: errors.slice(0, 50) };
  });

  // ---------- schedules ----------
  r.get('/api/schedules', async (ctx) => {
    requirePerm(ctx, 'asset.view');
    const rows = await db.query(
      `SELECT sc.*, t.name AS template_name, a.code AS asset_code, s.name AS site_name, u.name AS assignee_name FROM schedules sc
       LEFT JOIN templates t ON t.id = sc.template_id LEFT JOIN assets a ON a.id = sc.asset_id LEFT JOIN sites s ON s.id = sc.site_id
       LEFT JOIN users u ON u.id = sc.assignee_id WHERE sc.tenant_id = $1 ORDER BY sc.next_due_at`, [ctx.tenant.id]);
    return { schedules: rows.map((s) => ({ ...s, active: Boolean(s.active), overdue: Boolean(s.active && s.next_due_at && s.next_due_at < now()) })) };
  });
  const saveSchedule = async (ctx, id) => {
    requirePerm(ctx, 'schedule.manage'); requireWrite(ctx);
    const b = ctx.body;
    const freq = intOrNull(b.frequencyDays);
    if (!freq || freq < 1 || freq > 3650) throw bad('Enter how often (in days), e.g. 7 for weekly.');
    if (!b.templateId) throw bad('Choose the inspection type.');
    await checkRefs(ctx, b.siteId, b.templateId);
    if (b.assetId && !(await db.one('SELECT id FROM assets WHERE id = $1 AND tenant_id = $2', [b.assetId, ctx.tenant.id]))) throw bad('Unknown asset.');
    if (b.assigneeId && !(await db.one('SELECT id FROM users WHERE id = $1 AND tenant_id = $2', [b.assigneeId, ctx.tenant.id]))) throw bad('Unknown user.');
    const next = b.nextDueAt ? new Date(b.nextDueAt).toISOString() : addDays(now(), 0);
    const vals = [str(b.title, 120), b.templateId, b.assetId || null, b.siteId || null, b.assigneeId || null, freq, next, bool(b.active ?? true) ? 1 : 0, now()];
    if (id) {
      const n = await db.run('UPDATE schedules SET title=$1, template_id=$2, asset_id=$3, site_id=$4, assignee_id=$5, frequency_days=$6, next_due_at=$7, active=$8, updated_at=$9 WHERE id=$10 AND tenant_id=$11', [...vals, id, ctx.tenant.id]);
      if (!n) throw notFound('Schedule');
    } else {
      id = newId();
      await db.run('INSERT INTO schedules (title, template_id, asset_id, site_id, assignee_id, frequency_days, next_due_at, active, created_at, updated_at, id, tenant_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9,$10,$11)', [...vals, id, ctx.tenant.id]);
    }
    await audit(ctx, 'schedule.saved', 'schedule', id);
    return { id };
  };
  r.post('/api/schedules', (ctx) => saveSchedule(ctx));
  r.put('/api/schedules/:id', (ctx) => saveSchedule(ctx, ctx.params.id));
  r.delete('/api/schedules/:id', async (ctx) => {
    requirePerm(ctx, 'schedule.manage'); requireWrite(ctx);
    const n = await db.run('DELETE FROM schedules WHERE id = $1 AND tenant_id = $2', [ctx.params.id, ctx.tenant.id]);
    if (!n) throw notFound('Schedule');
    await audit(ctx, 'schedule.deleted', 'schedule', ctx.params.id);
    return { ok: true };
  });

  // ---------- due list (home screen of the field app + console) ----------
  r.get('/api/due', async (ctx) => {
    requirePerm(ctx, 'asset.view');
    const days = Math.min(60, Math.max(0, Number(ctx.query.days) || 7));
    const until = addDays(now(), days);
    const scope = ctx.siteScope || [];
    const inScope = (siteId) => !scope.length || !siteId || scope.includes(siteId);
    const mineOnly = ctx.role === 'inspector';
    const sch = await db.query(
      `SELECT sc.id, sc.title, sc.template_id, sc.asset_id, sc.site_id, sc.assignee_id, sc.next_due_at, t.name AS template_name, a.code AS asset_code,
              a.location AS asset_location, s.name AS site_name FROM schedules sc
       LEFT JOIN templates t ON t.id = sc.template_id LEFT JOIN assets a ON a.id = sc.asset_id LEFT JOIN sites s ON s.id = sc.site_id
       WHERE sc.tenant_id = $1 AND sc.active = 1 AND sc.next_due_at <= $2 ORDER BY sc.next_due_at`, [ctx.tenant.id, until]);
    const assets = await db.query(
      `SELECT a.id, a.code, a.name, a.location, a.site_id, a.template_id, a.next_due_at, t.name AS template_name, s.name AS site_name FROM assets a
       LEFT JOIN templates t ON t.id = a.template_id LEFT JOIN sites s ON s.id = a.site_id
       WHERE a.tenant_id = $1 AND a.status = 'active' AND a.next_due_at IS NOT NULL AND a.next_due_at <= $2 ORDER BY a.next_due_at`, [ctx.tenant.id, until]);
    const scheduledAssetIds = new Set(sch.map((s) => s.asset_id).filter(Boolean));
    const t = now();
    const items = [
      ...sch.filter((s) => inScope(s.site_id) && (!mineOnly || !s.assignee_id || s.assignee_id === ctx.user.id)).map((s) => ({
        kind: 'schedule', id: s.id, title: s.title || `${s.template_name}${s.asset_code ? ' ' + s.asset_code : ''}`, templateId: s.template_id,
        templateName: s.template_name, assetId: s.asset_id, assetCode: s.asset_code || '', location: s.asset_location || '', siteId: s.site_id, siteName: s.site_name || '', dueAt: s.next_due_at, overdue: s.next_due_at < t,
      })),
      ...assets.filter((a) => inScope(a.site_id) && !scheduledAssetIds.has(a.id)).map((a) => ({
        kind: 'asset', id: a.id, title: `${a.template_name || 'Inspection'} ${a.code}`, templateId: a.template_id, templateName: a.template_name || '',
        assetId: a.id, assetCode: a.code, location: a.location || '', siteId: a.site_id, siteName: a.site_name || '', dueAt: a.next_due_at, overdue: a.next_due_at < t,
      })),
    ].sort((x, y) => x.dueAt.localeCompare(y.dueAt));
    return { items: items.slice(0, 200) };
  });
}

export { addDays, text };
