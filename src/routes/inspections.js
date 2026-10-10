// Saved inspections (server-side history with photos), review / approval, corrective actions (CAPA),
// dashboard analytics, CSV export and outgoing webhooks.
import { db, newId, now, j, pj } from '../db/index.js';
import { HttpError, bad, notFound, forbidden, str, text, sendText } from '../http.js';
import { requirePerm, requireWrite, requireActiveSubscription, audit, monthStart } from '../auth.js';
import { mergeSettings } from '../services.js';
import { hmacHex } from '../security.js';
import { parseCheck } from '../inspection/rules.js';
import { addDays } from './assets.js';

const isImg = (v) => typeof v === 'string' && /^data:image\/(png|jpeg|webp);base64,/.test(v);

export function finalTag(result, override) {
  const ov = override?.status;
  if (ov === 'PASS') return 'GREEN';
  if (ov === 'REVIEW') return 'YELLOW';
  if (ov === 'FAIL') return 'RED';
  if (!result?.status) return 'NONE';
  const critBad = (result.checklist || []).some((c) => (c.critical ?? parseCheck(c.part).critical) && c.status !== 'present');
  if (result.status === 'FAIL' || (result.status === 'REVIEW' && critBad)) return 'RED';
  if (result.status === 'REVIEW') return 'YELLOW';
  return 'GREEN';
}

// ---------- webhooks ----------
export function fireWebhook(tenant, event, payload) {
  const w = mergeSettings(tenant?.settings).webhook;
  if (!w.url || !(w.events || []).includes(event)) return;
  const body = JSON.stringify({ event, tenant: { id: tenant.id, name: tenant.name }, sentAt: now(), data: payload });
  const headers = { 'Content-Type': 'application/json', 'User-Agent': 'InspectionAI-Webhook/1', 'X-Event': event };
  if (w.secret) headers['X-Signature'] = 'sha256=' + hmacHex(w.secret, body);
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 6000);
  fetch(w.url, { method: 'POST', headers, body, signal: ctl.signal })
    .catch((e) => console.warn(`[webhook] ${tenant.id} ${event}: ${e.message}`))
    .finally(() => clearTimeout(t));
}

function canSeeAll(ctx) {
  return ctx.can('inspection.view_all') || mergeSettings(ctx.tenant.settings).workflow.inspectors_see_all;
}

function listRow(r) {
  return {
    id: r.id, templateId: r.template_id, templateName: r.template_name, assetId: r.asset_id, assetCode: r.asset_code, siteId: r.site_id,
    siteName: r.site_name || '', location: r.location, inspectorId: r.inspector_id, inspectorName: r.inspector_name, mode: r.mode,
    aiStatus: r.ai_status, finalTag: r.final_tag, completion: r.completion, counts: pj(r.counts, {}), reviewStatus: r.review_status,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

// Builds WHERE for list / export / dashboard with visibility rules
function filterSql(ctx, q, alias = 'i') {
  const params = [ctx.tenant.id];
  let w = `${alias}.tenant_id = $1`;
  const add = (sql, v) => { params.push(v); w += sql.replace('?', `$${params.length}`); };
  if (!canSeeAll(ctx) || q.mine === '1') add(` AND ${alias}.inspector_id = ?`, ctx.user.id);
  const scope = ctx.siteScope || [];
  if (scope.length) { const ph = scope.map((s) => { params.push(s); return `$${params.length}`; }); w += ` AND (${alias}.site_id IN (${ph.join(',')}) OR ${alias}.site_id IS NULL)`; }
  if (q.tag && ['GREEN', 'YELLOW', 'RED'].includes(q.tag)) add(` AND ${alias}.final_tag = ?`, q.tag);
  if (q.template) add(` AND ${alias}.template_id = ?`, q.template);
  if (q.site) add(` AND ${alias}.site_id = ?`, q.site);
  if (q.inspector) add(` AND ${alias}.inspector_id = ?`, q.inspector);
  if (q.asset) add(` AND ${alias}.asset_id = ?`, q.asset);
  if (q.review) add(` AND ${alias}.review_status = ?`, q.review);
  if (q.from) add(` AND ${alias}.created_at >= ?`, new Date(q.from).toISOString());
  if (q.to) add(` AND ${alias}.created_at <= ?`, new Date(new Date(q.to).getTime() + 864e5 - 1).toISOString());
  if (q.q) {
    params.push(`%${String(q.q).toLowerCase()}%`);
    const p = `$${params.length}`;
    w += ` AND (LOWER(COALESCE(${alias}.asset_code,'')) LIKE ${p} OR LOWER(COALESCE(${alias}.template_name,'')) LIKE ${p} OR LOWER(COALESCE(${alias}.location,'')) LIKE ${p} OR LOWER(COALESCE(${alias}.inspector_name,'')) LIKE ${p})`;
  }
  return { where: w, params };
}

async function loadInspection(ctx, id) {
  const r = await db.one('SELECT i.*, s.name AS site_name FROM inspections i LEFT JOIN sites s ON s.id = i.site_id WHERE i.id = $1 AND i.tenant_id = $2', [id, ctx.tenant.id]);
  if (!r) throw notFound('Inspection');
  if (!canSeeAll(ctx) && r.inspector_id !== ctx.user.id) throw forbidden('You can only open your own inspections.');
  const scope = ctx.siteScope || [];
  if (scope.length && r.site_id && !scope.includes(r.site_id)) throw forbidden('This inspection belongs to a site you do not have access to.');
  return r;
}

function fullRow(r, photos = [], actions = []) {
  return {
    ...listRow(r),
    result: pj(r.result, null), meta: pj(r.meta, {}), override: pj(r.override, { status: '', remarks: '' }),
    signoff: pj(r.signoff, { done: false }), review: pj(r.review, null), provider: r.provider, model: r.model,
    photos: photos.map((p) => ({ id: p.id, view: p.view_name, dataUrl: p.data, quality: pj(p.quality, null) })),
    actions: actions.map((a) => ({ id: a.id, title: a.title, severity: a.severity, status: a.status, dueAt: a.due_at, assigneeName: a.assignee_name || '' })),
  };
}

async function createActionsFor(q, ctx, ins, result, settings) {
  const created = [];
  const due = (d) => addDays(now(), d);
  const items = [];
  (result.checklist || []).forEach((c) => {
    const pc = parseCheck(c.part);
    const crit = c.critical ?? pc.critical;
    if (c.status === 'missing') items.push({ title: `Fix: ${pc.name}`, desc: `${pc.rule ? 'Must be: ' + pc.rule + '. ' : ''}Found: ${c.note || 'not OK'} (view: ${c.group})`, sev: crit ? 'critical' : 'medium', days: crit ? 1 : settings.workflow.action_due_days });
    else if (c.status === 'unclear' && crit) items.push({ title: `Verify on site: ${pc.name}`, desc: `AI could not confirm this critical check. ${c.note || ''}`, sev: 'high', days: 1 });
  });
  (result.ai?.defects || []).filter((d) => d.severity === 'high').forEach((d) => items.push({ title: `Defect: ${str(d.description, 100)}`, desc: d.description + (d.angle ? ` (view: ${d.angle})` : ''), sev: 'high', days: 2 }));
  for (const it of items.slice(0, 25)) {
    const id = newId();
    await q.run(
      `INSERT INTO corrective_actions (id, tenant_id, inspection_id, asset_id, site_id, title, description, severity, status, assignee_id, due_at, created_by, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'open',NULL,$9,$10,$11,$11)`,
      [id, ctx.tenant.id, ins.id, ins.assetId, ins.siteId, str(`${it.title} - ${ins.templateName} ${ins.assetCode}`, 200), text(it.desc, 1000), it.sev, due(it.days), ctx.user.id, now()],
    );
    created.push({ id, title: it.title, severity: it.sev });
  }
  return created;
}

const csvq = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;

export default function routes(r) {
  // ---------- create (save from the field app) ----------
  r.post('/api/inspections', async (ctx) => {
    requirePerm(ctx, 'inspect.run'); requireWrite(ctx); requireActiveSubscription(ctx);
    const b = ctx.body;
    const result = b.result;
    if (!result?.status || !Array.isArray(result.checklist)) throw bad('Run the AI check before saving.');
    const max = ctx.limits?.max_inspections_month;
    if (max !== null && max !== undefined) {
      const n = Number(await db.value('SELECT CAST(COUNT(*) AS INTEGER) AS n FROM inspections WHERE tenant_id = $1 AND created_at >= $2', [ctx.tenant.id, monthStart()]));
      if (n >= max) throw new HttpError(402, `Your plan allows ${max} saved inspections per month. Contact us to upgrade.`, 'limit_inspections');
    }
    const settings = mergeSettings(ctx.tenant.settings);
    const tpl = b.templateId ? await db.one('SELECT id, name, frequency_days FROM templates WHERE id = $1 AND tenant_id = $2', [b.templateId, ctx.tenant.id]) : null;
    const siteId = b.siteId && (await db.one('SELECT id FROM sites WHERE id = $1 AND tenant_id = $2', [b.siteId, ctx.tenant.id])) ? b.siteId : null;
    const photos = (Array.isArray(b.photos) ? b.photos : []).filter((p) => isImg(p?.dataUrl) && p.dataUrl.length < 1_600_000).slice(0, 16);
    const assetCode = str(b.assetCode, 80);
    const override = { status: ['PASS', 'REVIEW', 'FAIL'].includes(b.override?.status) ? b.override.status : '', remarks: text(b.override?.remarks, 1000) };
    const signoff = b.signoff?.done ? { done: true, by: str(b.signoff.by || ctx.user.name, 80), at: b.signoff.at || now(), userId: ctx.user.id } : { done: false };
    const tag = finalTag(result, override);
    const id = newId(); const ts = now();
    const meta = {
      ...(b.meta && typeof b.meta === 'object' ? b.meta : {}),
      angles: Array.isArray(b.angles) ? b.angles : [], general_parts: Array.isArray(b.general_parts) ? b.general_parts : [],
      safety: Boolean(b.safety), idLabel: str(b.idLabel, 40), description: text(b.description, 1500), clientId: str(b.clientId, 40),
    };
    let actions = [];
    let assetId = null;
    await db.tx(async (q) => {
      // asset register: find or create, then update last result and next due date
      if (assetCode) {
        let asset = await q.one('SELECT id, site_id, template_id FROM assets WHERE tenant_id = $1 AND LOWER(code) = LOWER($2)', [ctx.tenant.id, assetCode]);
        if (!asset && settings.workflow.auto_create_assets) {
          const aid = newId();
          await q.run(`INSERT INTO assets (id, tenant_id, site_id, template_id, code, name, location, details, status, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,'{}','active',$8,$8)`,
            [aid, ctx.tenant.id, siteId, tpl?.id || null, assetCode, tpl?.name || str(b.templateName, 80), str(b.location, 160), ts]);
          asset = { id: aid };
        }
        if (asset) {
          assetId = asset.id;
          const nextDue = tpl?.frequency_days ? addDays(ts, Number(tpl.frequency_days)) : null;
          await q.run('UPDATE assets SET last_inspection_id = $1, last_inspected_at = $2, last_tag = $3, next_due_at = COALESCE($4, next_due_at), template_id = COALESCE(template_id, $5), site_id = COALESCE(site_id, $6), updated_at = $2 WHERE id = $7',
            [id, ts, tag, nextDue, tpl?.id || null, siteId, asset.id]);
        }
      }
      await q.run(
        `INSERT INTO inspections (id, tenant_id, template_id, template_name, asset_id, asset_code, site_id, location, inspector_id, inspector_name, mode,
          ai_status, final_tag, completion, counts, result, meta, override, signoff, review_status, review, provider, model, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,NULL,$21,$22,$23,$23)`,
        [id, ctx.tenant.id, tpl?.id || null, str(b.templateName || tpl?.name, 120), assetId, assetCode, siteId, str(b.location, 160), ctx.user.id,
          str(b.inspectorName || ctx.user.name, 80), b.mode === 'live' ? 'live' : 'photo', result.status, tag, Math.round(Number(result.completion) || 0),
          j(result.counts || {}), j(result), j(meta), j(override), j(signoff), settings.workflow.require_review ? 'pending' : 'not_required',
          str(result.provider, 30), str(result.model, 80), ts],
      );
      for (const p of photos) {
        await q.run('INSERT INTO inspection_photos (id, inspection_id, tenant_id, view_name, data, quality, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)',
          [newId(), id, ctx.tenant.id, str(p.view, 60), p.dataUrl, j(p.quality || null), ts]);
      }
      // recurring schedules for this asset (or this type at this site) move to the next due date
      if (tpl) {
        const sch = await q.query('SELECT id, frequency_days, asset_id, site_id FROM schedules WHERE tenant_id = $1 AND template_id = $2 AND active = 1', [ctx.tenant.id, tpl.id]);
        for (const s of sch.filter((s) => (s.asset_id && s.asset_id === assetId) || (!s.asset_id && (!s.site_id || s.site_id === siteId)))) {
          await q.run('UPDATE schedules SET next_due_at = $1, updated_at = $2 WHERE id = $3', [addDays(ts, Number(s.frequency_days)), ts, s.id]);
        }
      }
      if (settings.workflow.auto_actions && tag !== 'GREEN') {
        actions = await createActionsFor(q, ctx, { id, assetId, siteId, templateName: str(b.templateName || tpl?.name, 80), assetCode }, result, settings);
      }
    });
    await audit(ctx, 'inspection.created', 'inspection', id, { tag, asset: assetCode, template: b.templateName });
    const summary = { id, template: b.templateName, asset: assetCode, location: b.location, tag, aiStatus: result.status, completion: result.completion, inspector: ctx.user.name, createdAt: ts };
    fireWebhook(ctx.tenant, 'inspection.created', summary);
    if (actions.length) fireWebhook(ctx.tenant, 'action.created', { inspectionId: id, actions });
    return { id, finalTag: tag, reviewStatus: settings.workflow.require_review ? 'pending' : 'not_required', actionsCreated: actions.length, assetId };
  });

  // ---------- list ----------
  r.get('/api/inspections', async (ctx) => {
    requirePerm(ctx, 'inspection.view');
    const { where, params } = filterSql(ctx, ctx.query);
    const limit = Math.min(500, Number(ctx.query.limit) || 50);
    const offset = Math.max(0, Number(ctx.query.offset) || 0);
    const total = Number(await db.value(`SELECT CAST(COUNT(*) AS INTEGER) AS n FROM inspections i WHERE ${where}`, params));
    const rows = await db.query(
      `SELECT i.id, i.template_id, i.template_name, i.asset_id, i.asset_code, i.site_id, s.name AS site_name, i.location, i.inspector_id, i.inspector_name,
              i.mode, i.ai_status, i.final_tag, i.completion, i.counts, i.review_status, i.created_at, i.updated_at
       FROM inspections i LEFT JOIN sites s ON s.id = i.site_id WHERE ${where} ORDER BY i.created_at DESC LIMIT ${limit} OFFSET ${offset}`, params);
    return { total, inspections: rows.map(listRow) };
  });

  r.get('/api/inspections/:id', async (ctx) => {
    requirePerm(ctx, 'inspection.view');
    const row = await loadInspection(ctx, ctx.params.id);
    const photos = await db.query('SELECT * FROM inspection_photos WHERE inspection_id = $1 AND tenant_id = $2 ORDER BY created_at', [row.id, ctx.tenant.id]);
    const actions = await db.query('SELECT a.*, u.name AS assignee_name FROM corrective_actions a LEFT JOIN users u ON u.id = a.assignee_id WHERE a.inspection_id = $1 AND a.tenant_id = $2', [row.id, ctx.tenant.id]);
    return { inspection: fullRow(row, photos, actions) };
  });

  // inspector decision / remarks / sign-off changed after saving
  r.put('/api/inspections/:id', async (ctx) => {
    requirePerm(ctx, 'inspection.view'); requireWrite(ctx);
    const row = await loadInspection(ctx, ctx.params.id);
    const reviewer = ctx.can('inspection.review');
    if (!reviewer && (row.inspector_id !== ctx.user.id || row.review_status === 'approved')) throw forbidden('This inspection can no longer be changed.');
    const b = ctx.body;
    const override = { status: ['PASS', 'REVIEW', 'FAIL'].includes(b.override?.status) ? b.override.status : '', remarks: text(b.override?.remarks, 1000) };
    const old = pj(row.signoff, { done: false });
    const signoff = b.signoff?.done ? (old.done ? old : { done: true, by: str(b.signoff.by || ctx.user.name, 80), at: now(), userId: ctx.user.id }) : { done: false };
    const tag = finalTag(pj(row.result, {}), override);
    await db.run('UPDATE inspections SET override = $1, signoff = $2, final_tag = $3, updated_at = $4 WHERE id = $5', [j(override), j(signoff), tag, now(), row.id]);
    if (row.asset_id) await db.run('UPDATE assets SET last_tag = $1 WHERE id = $2 AND last_inspection_id = $3', [tag, row.asset_id, row.id]);
    await audit(ctx, 'inspection.updated', 'inspection', row.id, { tag, override: override.status });
    return { finalTag: tag };
  });

  r.post('/api/inspections/:id/review', async (ctx) => {
    requirePerm(ctx, 'inspection.review'); requireWrite(ctx);
    const row = await loadInspection(ctx, ctx.params.id);
    const decision = ctx.body.decision;
    if (!['approved', 'rejected'].includes(decision)) throw bad('Choose approve or reject.');
    if (decision === 'rejected' && !str(ctx.body.comment, 10)) throw bad('Add a comment saying why it is rejected.');
    const review = { decision, comment: text(ctx.body.comment, 1000), by: ctx.user.name, userId: ctx.user.id, at: now() };
    await db.run('UPDATE inspections SET review_status = $1, review = $2, updated_at = $3 WHERE id = $4', [decision, j(review), now(), row.id]);
    await audit(ctx, `inspection.${decision}`, 'inspection', row.id, { comment: review.comment });
    fireWebhook(ctx.tenant, 'inspection.reviewed', { id: row.id, decision, comment: review.comment, by: ctx.user.name });
    return { ok: true, review };
  });

  r.delete('/api/inspections/:id', async (ctx) => {
    requirePerm(ctx, 'inspection.delete'); requireWrite(ctx);
    const row = await loadInspection(ctx, ctx.params.id);
    await db.tx(async (q) => {
      await q.run('DELETE FROM inspection_photos WHERE inspection_id = $1 AND tenant_id = $2', [row.id, ctx.tenant.id]);
      await q.run('UPDATE corrective_actions SET inspection_id = NULL WHERE inspection_id = $1 AND tenant_id = $2', [row.id, ctx.tenant.id]);
      await q.run('DELETE FROM inspections WHERE id = $1 AND tenant_id = $2', [row.id, ctx.tenant.id]);
    });
    await audit(ctx, 'inspection.deleted', 'inspection', row.id, { asset: row.asset_code, template: row.template_name });
    return { ok: true };
  });

  // ---------- CSV export (one row per check) ----------
  r.get('/api/export/inspections.csv', async (ctx) => {
    requirePerm(ctx, 'report.view');
    const { where, params } = filterSql(ctx, ctx.query);
    const rows = await db.query(`SELECT i.*, s.name AS site_name FROM inspections i LEFT JOIN sites s ON s.id = i.site_id WHERE ${where} ORDER BY i.created_at DESC LIMIT 5000`, params);
    const head = ['Inspection ID', 'Date', 'Type', 'Asset', 'Site', 'Location', 'Inspector', 'AI status', 'Final tag', 'Completion %', 'Review', 'View', 'Check', 'Critical', 'Check status', 'Confidence %', 'AI evidence', 'Remarks'];
    const lines = [head.map(csvq).join(',')];
    rows.forEach((r2) => {
      const res = pj(r2.result, {}); const ov = pj(r2.override, {});
      const base = [r2.id, r2.created_at, r2.template_name, r2.asset_code, r2.site_name, r2.location, r2.inspector_name, r2.ai_status, r2.final_tag, r2.completion, r2.review_status];
      const checks = res.checklist || [];
      if (!checks.length) lines.push([...base, '', '', '', '', '', '', ov.remarks].map(csvq).join(','));
      checks.forEach((c) => {
        const pc = parseCheck(c.part);
        lines.push([...base, c.group, pc.name, (c.critical ?? pc.critical) ? 'yes' : '', c.status, Math.round((c.confidence || 0) * 100), c.note, ov.remarks].map(csvq).join(','));
      });
    });
    await audit(ctx, 'inspection.exported', 'inspection', '', { rows: rows.length });
    sendText(ctx.res, 200, '\uFEFF' + lines.join('\r\n'), 'text/csv; charset=utf-8', { 'Content-Disposition': `attachment; filename="inspections-${now().slice(0, 10)}.csv"` });
  });

  // ---------- corrective actions ----------
  r.get('/api/actions', async (ctx) => {
    requirePerm(ctx, 'action.view');
    const q = ctx.query;
    const params = [ctx.tenant.id];
    let w = 'a.tenant_id = $1';
    const add = (sql, v) => { params.push(v); w += sql.replace('?', `$${params.length}`); };
    if (q.status === 'open') w += " AND a.status IN ('open','in_progress')";
    else if (q.status) add(' AND a.status = ?', q.status);
    if (q.severity) add(' AND a.severity = ?', q.severity);
    if (q.site) add(' AND a.site_id = ?', q.site);
    if (q.inspection) add(' AND a.inspection_id = ?', q.inspection);
    if (q.mine === '1' || !ctx.can('action.manage') && ctx.role === 'inspector') add(' AND a.assignee_id = ?', ctx.user.id);
    const scope = ctx.siteScope || [];
    if (scope.length) { const ph = scope.map((s) => { params.push(s); return `$${params.length}`; }); w += ` AND (a.site_id IN (${ph.join(',')}) OR a.site_id IS NULL)`; }
    const rows = await db.query(
      `SELECT a.*, u.name AS assignee_name, s.name AS site_name, x.code AS asset_code FROM corrective_actions a
       LEFT JOIN users u ON u.id = a.assignee_id LEFT JOIN sites s ON s.id = a.site_id LEFT JOIN assets x ON x.id = a.asset_id
       WHERE ${w} ORDER BY CASE a.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, a.due_at LIMIT 1000`, params);
    const t = now();
    return {
      actions: rows.map((a) => ({
        id: a.id, title: a.title, description: a.description, severity: a.severity, status: a.status, assigneeId: a.assignee_id, assigneeName: a.assignee_name || '',
        dueAt: a.due_at, overdue: Boolean(a.due_at && a.due_at < t && ['open', 'in_progress'].includes(a.status)), inspectionId: a.inspection_id, assetId: a.asset_id,
        assetCode: a.asset_code || '', siteName: a.site_name || '', closureNote: a.closure_note, hasClosurePhoto: Boolean(a.closure_photo), closedAt: a.closed_at, createdAt: a.created_at,
      })),
    };
  });

  r.get('/api/actions/:id/photo', async (ctx) => {
    requirePerm(ctx, 'action.view');
    const a = await db.one('SELECT closure_photo FROM corrective_actions WHERE id = $1 AND tenant_id = $2', [ctx.params.id, ctx.tenant.id]);
    if (!a) throw notFound('Action');
    return { dataUrl: a.closure_photo || '' };
  });

  r.post('/api/actions', async (ctx) => {
    requirePerm(ctx, 'action.manage'); requireWrite(ctx);
    const b = ctx.body;
    const title = str(b.title, 200);
    if (!title) throw bad('Enter what needs to be done.');
    const id = newId(); const ts = now();
    let siteId = b.siteId || null; let assetId = b.assetId || null;
    if (b.inspectionId) {
      const ins = await db.one('SELECT site_id, asset_id FROM inspections WHERE id = $1 AND tenant_id = $2', [b.inspectionId, ctx.tenant.id]);
      if (!ins) throw bad('Unknown inspection.');
      siteId ||= ins.site_id; assetId ||= ins.asset_id;
    }
    if (b.assigneeId && !(await db.one('SELECT id FROM users WHERE id = $1 AND tenant_id = $2', [b.assigneeId, ctx.tenant.id]))) throw bad('Unknown user.');
    await db.run(
      `INSERT INTO corrective_actions (id, tenant_id, inspection_id, asset_id, site_id, title, description, severity, status, assignee_id, due_at, created_by, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'open',$9,$10,$11,$12,$12)`,
      [id, ctx.tenant.id, b.inspectionId || null, assetId, siteId, title, text(b.description, 1000), ['low', 'medium', 'high', 'critical'].includes(b.severity) ? b.severity : 'medium',
        b.assigneeId || null, b.dueAt ? new Date(b.dueAt).toISOString() : addDays(ts, 7), ctx.user.id, ts],
    );
    await audit(ctx, 'action.created', 'action', id, { title });
    fireWebhook(ctx.tenant, 'action.created', { actions: [{ id, title }] });
    return { id };
  });

  r.put('/api/actions/:id', async (ctx) => {
    requirePerm(ctx, 'action.view'); requireWrite(ctx);
    const a = await db.one('SELECT * FROM corrective_actions WHERE id = $1 AND tenant_id = $2', [ctx.params.id, ctx.tenant.id]);
    if (!a) throw notFound('Action');
    const manager = ctx.can('action.manage');
    const assignee = a.assignee_id === ctx.user.id && ctx.can('action.update_own');
    if (!manager && !assignee) throw forbidden('Only the assigned person or a manager can update this action.');
    const b = ctx.body;
    const allowed = manager ? ['open', 'in_progress', 'done', 'verified', 'cancelled'] : ['open', 'in_progress', 'done'];
    const status = allowed.includes(b.status) ? b.status : a.status;
    const closing = ['done', 'verified'].includes(status) && !['done', 'verified'].includes(a.status);
    const photo = isImg(b.closurePhoto) && b.closurePhoto.length < 1_600_000 ? b.closurePhoto : a.closure_photo;
    if (b.assigneeId && manager && !(await db.one('SELECT id FROM users WHERE id = $1 AND tenant_id = $2', [b.assigneeId, ctx.tenant.id]))) throw bad('Unknown user.');
    await db.run(
      `UPDATE corrective_actions SET title=$1, description=$2, severity=$3, status=$4, assignee_id=$5, due_at=$6, closure_note=$7, closure_photo=$8,
         closed_by=$9, closed_at=$10, updated_at=$11 WHERE id=$12`,
      [manager ? str(b.title ?? a.title, 200) : a.title, manager ? text(b.description ?? a.description, 1000) : a.description,
        manager && ['low', 'medium', 'high', 'critical'].includes(b.severity) ? b.severity : a.severity, status,
        manager && b.assigneeId !== undefined ? (b.assigneeId || null) : a.assignee_id,
        manager && b.dueAt ? new Date(b.dueAt).toISOString() : a.due_at,
        text(b.closureNote ?? a.closure_note, 1000), photo,
        closing ? ctx.user.id : (['done', 'verified'].includes(status) ? a.closed_by : null), closing ? now() : (['done', 'verified'].includes(status) ? a.closed_at : null), now(), a.id],
    );
    await audit(ctx, 'action.updated', 'action', a.id, { status });
    return { ok: true };
  });

  // ---------- dashboard ----------
  r.get('/api/dashboard', async (ctx) => {
    requirePerm(ctx, 'inspection.view');
    const days = Math.min(365, Math.max(7, Number(ctx.query.days) || 30));
    const from = new Date(Date.now() - days * 864e5).toISOString();
    const { where, params } = filterSql(ctx, { ...ctx.query, from });
    const rows = await db.query(
      `SELECT i.id, i.template_name, i.site_id, s.name AS site_name, i.inspector_name, i.final_tag, i.review_status, i.asset_code, i.created_at, i.result
       FROM inspections i LEFT JOIN sites s ON s.id = i.site_id WHERE ${where} ORDER BY i.created_at DESC LIMIT 5000`, params);
    const count = (tag) => rows.filter((x) => x.final_tag === tag).length;
    const trend = {};
    for (let d = days - 1; d >= 0; d--) { const k = new Date(Date.now() - d * 864e5).toISOString().slice(0, 10); trend[k] = { date: k, GREEN: 0, YELLOW: 0, RED: 0 }; }
    const group = (key) => {
      const m = {};
      rows.forEach((x) => { const k = x[key] || '-'; m[k] ||= { name: k, total: 0, GREEN: 0, YELLOW: 0, RED: 0 }; m[k].total++; if (m[k][x.final_tag] !== undefined) m[k][x.final_tag]++; });
      return Object.values(m).map((g) => ({ ...g, passRate: g.total ? Math.round((g.GREEN / g.total) * 100) : 0 })).sort((a, b) => b.total - a.total).slice(0, 12);
    };
    const failing = {};
    rows.forEach((x) => {
      const k = x.created_at.slice(0, 10);
      if (trend[k] && trend[k][x.final_tag] !== undefined) trend[k][x.final_tag]++;
      (pj(x.result, {}).checklist || []).filter((c) => c.status === 'missing').forEach((c) => {
        const key = `${x.template_name}|${parseCheck(c.part).name}`;
        failing[key] ||= { template: x.template_name, check: parseCheck(c.part).name, count: 0 };
        failing[key].count++;
      });
    });
    const t = now();
    const openActions = await db.query("SELECT severity, due_at FROM corrective_actions WHERE tenant_id = $1 AND status IN ('open','in_progress')", [ctx.tenant.id]);
    const overdueAssets = Number(await db.value("SELECT CAST(COUNT(*) AS INTEGER) AS n FROM assets WHERE tenant_id = $1 AND status = 'active' AND next_due_at IS NOT NULL AND next_due_at < $2", [ctx.tenant.id, t]));
    const overdueSchedules = Number(await db.value('SELECT CAST(COUNT(*) AS INTEGER) AS n FROM schedules WHERE tenant_id = $1 AND active = 1 AND asset_id IS NULL AND next_due_at < $2', [ctx.tenant.id, t]));
    return {
      days,
      totals: {
        inspections: rows.length, GREEN: count('GREEN'), YELLOW: count('YELLOW'), RED: count('RED'),
        passRate: rows.length ? Math.round((count('GREEN') / rows.length) * 100) : 0,
        pendingReview: rows.filter((x) => x.review_status === 'pending').length,
        openActions: openActions.length, overdueActions: openActions.filter((a) => a.due_at && a.due_at < t).length,
        criticalActions: openActions.filter((a) => a.severity === 'critical').length,
        overdueInspections: overdueAssets + overdueSchedules,
      },
      trend: Object.values(trend),
      byTemplate: group('template_name'),
      bySite: group('site_name'),
      byInspector: group('inspector_name'),
      topFailing: Object.values(failing).sort((a, b) => b.count - a.count).slice(0, 10),
      recentRed: rows.filter((x) => x.final_tag === 'RED').slice(0, 8).map((x) => ({ id: x.id, template: x.template_name, asset: x.asset_code, site: x.site_name, inspector: x.inspector_name, createdAt: x.created_at })),
    };
  });
}
