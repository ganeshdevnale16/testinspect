// Inspection templates (what to inspect: views, checks, custom fields, AI instructions, reference photos)
// and the industry template library.
import { db, newId, now, j, pj } from '../db/index.js';
import { bad, notFound, str, text, intOrNull } from '../http.js';
import { requirePerm, requireWrite, audit } from '../auth.js';
import { getLibrary } from '../library-db.js';
import { importLibraryTemplate } from '../services.js';

const isImg = (v) => typeof v === 'string' && /^data:image\/(png|jpeg|webp);base64,/.test(v);
const FIELD_TYPES = ['text', 'number', 'date', 'select', 'checkbox'];

export function publicTemplate(t, withRefs = false) {
  const angles = pj(t.angles, []).map((a) => {
    const out = { name: a.name, guidance: a.guidance || '', parts: a.parts || [], hasReference: isImg(a.reference) };
    if (withRefs && out.hasReference) out.reference = a.reference;
    return out;
  });
  return {
    id: t.id, name: t.name, description: t.description || '', industry: t.industry || '', category: t.category || '',
    idLabel: t.id_label || '', safety: Boolean(t.safety), aiContext: t.ai_context || '', angles,
    general_parts: pj(t.general_parts, []), customFields: pj(t.custom_fields, []), frequencyDays: t.frequency_days ?? null,
    active: Boolean(t.active), version: t.version, libraryKey: t.library_key || '', updatedAt: t.updated_at,
  };
}

function cleanLines(arr, max = 30) {
  return (Array.isArray(arr) ? arr : String(arr || '').split('\n')).map((x) => str(x, 300)).filter(Boolean).slice(0, max);
}

function validate(b, old = null) {
  const name = str(b.name, 80);
  if (!name) throw bad('Enter a name for this inspection type.');
  const oldAngles = old ? pj(old.angles, []) : [];
  const angles = (Array.isArray(b.angles) ? b.angles : []).slice(0, 12).map((a) => {
    const n = str(a?.name, 60);
    const prev = oldAngles.find((x) => x.name === n);
    let reference = prev?.reference || '';
    if (a?.reference === '' || a?.reference === null) reference = '';
    else if (isImg(a?.reference) && a.reference.length < 700000) reference = a.reference;
    return { name: n, guidance: str(a?.guidance, 200), parts: cleanLines(a?.parts), ...(reference ? { reference } : {}) };
  }).filter((a) => a.name);
  if (!angles.length) throw bad('Add at least one view.');
  const names = angles.map((a) => a.name.toLowerCase());
  if (new Set(names).size !== names.length) throw bad('Each view needs a different name.');
  const general = cleanLines(b.general_parts, 10);
  if (!angles.some((a) => a.parts.length) && !general.length) throw bad('Add at least one check.');
  const customFields = (Array.isArray(b.customFields) ? b.customFields : (old ? pj(old.custom_fields, []) : [])).slice(0, 15).map((f, i) => ({
    key: str(f?.key, 30).replace(/[^a-z0-9_]/gi, '_').toLowerCase() || `field_${i + 1}`,
    label: str(f?.label, 60),
    type: FIELD_TYPES.includes(f?.type) ? f.type : 'text',
    options: f?.type === 'select' ? cleanLines(f.options, 20).map((o) => str(o, 60)) : undefined,
    required: Boolean(f?.required),
  })).filter((f) => f.label);
  return {
    name, description: text(b.description ?? old?.description, 400), industry: str(b.industry ?? old?.industry, 40), category: str(b.category ?? old?.category, 60),
    idLabel: str(b.idLabel ?? old?.id_label, 40), safety: b.safety === undefined ? Boolean(old?.safety) : Boolean(b.safety),
    aiContext: text(b.aiContext ?? old?.ai_context, 4000), angles, general, customFields,
    frequencyDays: b.frequencyDays === undefined ? (old?.frequency_days ?? null) : intOrNull(b.frequencyDays),
    active: b.active === undefined ? (old ? Boolean(old.active) : true) : Boolean(b.active),
  };
}

export default function routes(r) {
  r.get('/api/templates', async (ctx) => {
    requirePerm(ctx, 'template.view');
    const all = ctx.query.all === '1' && ctx.can('template.manage');
    const rows = await db.query(`SELECT * FROM templates WHERE tenant_id = $1 ${all ? '' : 'AND active = 1'} ORDER BY name`, [ctx.tenant.id]);
    return { templates: rows.map((t) => publicTemplate(t)) };
  });

  r.get('/api/templates/:id', async (ctx) => {
    requirePerm(ctx, 'template.view');
    const t = await db.one('SELECT * FROM templates WHERE id = $1 AND tenant_id = $2', [ctx.params.id, ctx.tenant.id]);
    if (!t) throw notFound('Template');
    return { template: publicTemplate(t, true) };
  });

  r.post('/api/templates', async (ctx) => {
    requirePerm(ctx, 'template.manage'); requireWrite(ctx);
    const v = validate(ctx.body);
    const id = newId(); const ts = now();
    await db.run(
      `INSERT INTO templates (id, tenant_id, name, description, industry, category, id_label, safety, ai_context, angles, general_parts, custom_fields, frequency_days, active, version, created_by, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,1,$15,$16,$16)`,
      [id, ctx.tenant.id, v.name, v.description, v.industry, v.category, v.idLabel, v.safety ? 1 : 0, v.aiContext, j(v.angles), j(v.general), j(v.customFields), v.frequencyDays, v.active ? 1 : 0, ctx.user.id, ts],
    );
    await audit(ctx, 'template.created', 'template', id, { name: v.name });
    return { template: publicTemplate(await db.one('SELECT * FROM templates WHERE id = $1', [id])) };
  });

  r.put('/api/templates/:id', async (ctx) => {
    requirePerm(ctx, 'template.manage'); requireWrite(ctx);
    const old = await db.one('SELECT * FROM templates WHERE id = $1 AND tenant_id = $2', [ctx.params.id, ctx.tenant.id]);
    if (!old) throw notFound('Template');
    const v = validate(ctx.body, old);
    await db.run(
      `UPDATE templates SET name=$1, description=$2, industry=$3, category=$4, id_label=$5, safety=$6, ai_context=$7, angles=$8, general_parts=$9,
        custom_fields=$10, frequency_days=$11, active=$12, version = version + 1, updated_at=$13 WHERE id=$14 AND tenant_id=$15`,
      [v.name, v.description, v.industry, v.category, v.idLabel, v.safety ? 1 : 0, v.aiContext, j(v.angles), j(v.general), j(v.customFields), v.frequencyDays, v.active ? 1 : 0, now(), old.id, ctx.tenant.id],
    );
    await audit(ctx, 'template.updated', 'template', old.id, { name: v.name, version: Number(old.version) + 1 });
    return { template: publicTemplate(await db.one('SELECT * FROM templates WHERE id = $1', [old.id])) };
  });

  r.post('/api/templates/:id/duplicate', async (ctx) => {
    requirePerm(ctx, 'template.manage'); requireWrite(ctx);
    const t = await db.one('SELECT * FROM templates WHERE id = $1 AND tenant_id = $2', [ctx.params.id, ctx.tenant.id]);
    if (!t) throw notFound('Template');
    const id = newId(); const ts = now();
    await db.run(
      `INSERT INTO templates (id, tenant_id, library_key, name, description, industry, category, id_label, safety, ai_context, angles, general_parts, custom_fields, frequency_days, active, version, created_by, created_at, updated_at)
       VALUES ($1,$2,'',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,1,1,$14,$15,$15)`,
      [id, ctx.tenant.id, `${t.name} (copy)`, t.description, t.industry, t.category, t.id_label, t.safety, t.ai_context, t.angles, t.general_parts, t.custom_fields, t.frequency_days, ctx.user.id, ts],
    );
    await audit(ctx, 'template.duplicated', 'template', id, { from: t.id });
    return { id };
  });

  r.delete('/api/templates/:id', async (ctx) => {
    requirePerm(ctx, 'template.manage'); requireWrite(ctx);
    const t = await db.one('SELECT id, name FROM templates WHERE id = $1 AND tenant_id = $2', [ctx.params.id, ctx.tenant.id]);
    if (!t) throw notFound('Template');
    const used = Number(await db.value('SELECT CAST(COUNT(*) AS INTEGER) AS n FROM inspections WHERE template_id = $1 AND tenant_id = $2', [t.id, ctx.tenant.id]));
    if (used) {
      await db.run('UPDATE templates SET active = 0, updated_at = $1 WHERE id = $2', [now(), t.id]);
      await audit(ctx, 'template.archived', 'template', t.id, { name: t.name });
      return { archived: true, message: `Used by ${used} inspections, so it was archived instead of deleted.` };
    }
    await db.run('DELETE FROM schedules WHERE template_id = $1 AND tenant_id = $2', [t.id, ctx.tenant.id]);
    await db.run('UPDATE assets SET template_id = NULL WHERE template_id = $1 AND tenant_id = $2', [t.id, ctx.tenant.id]);
    await db.run('DELETE FROM templates WHERE id = $1 AND tenant_id = $2', [t.id, ctx.tenant.id]);
    await audit(ctx, 'template.deleted', 'template', t.id, { name: t.name });
    return { deleted: true };
  });

  // ---------- export / import a template as a JSON file (move between accounts, backups) ----------
  r.get('/api/templates/:id/export', async (ctx) => {
    requirePerm(ctx, 'template.manage');
    const t = await db.one('SELECT * FROM templates WHERE id = $1 AND tenant_id = $2', [ctx.params.id, ctx.tenant.id]);
    if (!t) throw notFound('Template');
    const p = publicTemplate(t, true);
    return { format: 'inspection-ai-template', version: 1, template: { name: p.name, description: p.description, industry: p.industry, category: p.category, idLabel: p.idLabel, safety: p.safety, aiContext: p.aiContext, frequencyDays: p.frequencyDays, customFields: p.customFields, angles: p.angles.map(({ hasReference, ...a }) => a), general_parts: p.general_parts } };
  });

  r.post('/api/templates/import-json', async (ctx) => {
    requirePerm(ctx, 'template.manage'); requireWrite(ctx);
    const src = ctx.body?.template || ctx.body;
    if (ctx.body?.format && ctx.body.format !== 'inspection-ai-template') throw bad('This file is not an Inspection AI template.');
    const v = validate({ ...src, name: src?.name });
    const id = newId(); const ts = now();
    await db.run(
      `INSERT INTO templates (id, tenant_id, name, description, industry, category, id_label, safety, ai_context, angles, general_parts, custom_fields, frequency_days, active, version, created_by, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,1,1,$14,$15,$15)`,
      [id, ctx.tenant.id, v.name, v.description, v.industry, v.category, v.idLabel, v.safety ? 1 : 0, v.aiContext, j(v.angles), j(v.general), j(v.customFields), v.frequencyDays, ctx.user.id, ts],
    );
    await audit(ctx, 'template.imported_json', 'template', id, { name: v.name });
    return { id };
  });

  // ---------- industry library (managed by the platform owner) ----------
  r.get('/api/library', async (ctx) => {
    requirePerm(ctx, 'template.view');
    const have = new Set((await db.query("SELECT library_key FROM templates WHERE tenant_id = $1 AND library_key <> ''", [ctx.tenant.id])).map((x) => x.library_key));
    const lib = await getLibrary();
    return { industries: lib.map((i) => ({ ...i, templates: i.templates.map((t) => ({ ...t, imported: have.has(`${i.key}/${t.key}`) })) })) };
  });

  r.post('/api/library/import', async (ctx) => {
    requirePerm(ctx, 'template.manage'); requireWrite(ctx);
    const ids = (Array.isArray(ctx.body.ids) ? ctx.body.ids : []).map((x) => str(x, 60)).slice(0, 80);
    if (!ids.length) throw bad('Choose at least one template.');
    let count = 0;
    await db.tx(async (q) => { for (const id of ids) { await importLibraryTemplate(q, ctx.tenant.id, id, ctx.user.id); count++; } });
    await audit(ctx, 'template.imported', 'template', '', { count });
    return { imported: count };
  });

  // Client asks the platform owner to add their template to the shared library (owner reviews it)
  r.post('/api/templates/:id/suggest-library', async (ctx) => {
    requirePerm(ctx, 'template.manage'); requireWrite(ctx);
    const t = await db.one('SELECT id, name FROM templates WHERE id = $1 AND tenant_id = $2', [ctx.params.id, ctx.tenant.id]);
    if (!t) throw notFound('Template');
    await audit(ctx, 'template.library_suggested', 'template', t.id, { name: t.name, note: text(ctx.body.note, 300) });
    return { ok: true };
  });
}
