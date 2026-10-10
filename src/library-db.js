// The template library lives in the database so the platform owner can add industries and templates
// from the console (no code change). Built-in content from library.js is loaded once on first start.
import { db, newId, now, j, pj } from './db/index.js';
import { INDUSTRIES } from './library.js';
import { HttpError, slugify } from './http.js';

export async function seedLibrary() {
  const has = Number(await db.value('SELECT CAST(COUNT(*) AS INTEGER) AS n FROM library_industries'));
  if (has) return;
  const ts = now();
  for (const [i, ind] of INDUSTRIES.entries()) {
    await db.run('INSERT INTO library_industries (key, name, description, sort, active, builtin, created_at, updated_at) VALUES ($1,$2,$3,$4,1,1,$5,$5)', [ind.key, ind.name, '', i, ts]);
    for (const [k, t] of ind.templates.entries()) {
      await db.run(
        'INSERT INTO library_templates (id, industry_key, key, name, description, data, active, builtin, sort, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,1,1,$7,$8,$8)',
        [newId(), ind.key, t.key, t.name, t.description || '', j(toData(t)), k, ts]);
    }
  }
  console.log('[seed] template library loaded');
}

// Normalised template body stored in library_templates.data
export function toData(t) {
  return {
    name: t.name, description: t.description || '', idLabel: t.idLabel || '', safety: Boolean(t.safety),
    frequencyDays: t.frequencyDays ?? null, aiContext: t.aiContext || '', category: t.category || '',
    customFields: t.customFields || [], angles: (t.angles || []).map((a) => ({ name: a.name, guidance: a.guidance || '', parts: a.parts || [] })),
    general_parts: t.general_parts || [],
  };
}

export async function getLibrary({ includeInactive = false } = {}) {
  const inds = await db.query(`SELECT * FROM library_industries ${includeInactive ? '' : 'WHERE active = 1'} ORDER BY sort, name`);
  const tpls = await db.query(`SELECT * FROM library_templates ${includeInactive ? '' : 'WHERE active = 1'} ORDER BY sort, name`);
  return inds.map((i) => ({
    key: i.key, name: i.name, description: i.description || '', active: Boolean(i.active), builtin: Boolean(i.builtin), sort: i.sort,
    templates: tpls.filter((t) => t.industry_key === i.key).map((t) => {
      const d = pj(t.data, {});
      return {
        id: t.id, key: t.key, name: t.name, description: t.description || '', active: Boolean(t.active), builtin: Boolean(t.builtin),
        safety: Boolean(d.safety), views: (d.angles || []).length,
        checks: (d.angles || []).reduce((n, a) => n + (a.parts || []).length, 0) + (d.general_parts || []).length,
      };
    }),
  }));
}

export async function getLibraryTemplate(id) {
  const t = await db.one('SELECT * FROM library_templates WHERE id = $1', [id]);
  if (!t) throw new HttpError(404, 'Library template not found.');
  return { ...t, data: pj(t.data, {}) };
}

export async function industryKeys() {
  return (await db.query('SELECT key FROM library_industries')).map((r) => r.key);
}

export async function uniqueTemplateKey(industryKey, name) {
  const base = slugify(name) || 'template';
  let key = base; let n = 1;
  while (await db.one('SELECT id FROM library_templates WHERE industry_key = $1 AND key = $2', [industryKey, key])) key = `${base}-${++n}`;
  return key;
}
