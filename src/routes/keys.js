// AI key management, shared by client admins (their own keys) and the platform (fallback keys).
// Keys are encrypted at rest and never sent back to the browser - only a short hint like "sk-a…9f2c".
import { db, newId, now } from '../db/index.js';
import { bad, notFound, str } from '../http.js';
import { encrypt, decrypt, keyHint } from '../security.js';
import { PROVIDERS, testConnection } from '../ai/providers.js';
import { audit } from '../auth.js';

const scopeSql = (tenantId) => (tenantId ? ['tenant_id = $1', [tenantId]] : ['tenant_id IS NULL', []]);

export function publicKey(k) {
  return {
    id: k.id, provider: k.provider, providerLabel: PROVIDERS[k.provider]?.label || k.provider, label: k.label, hint: k.key_hint,
    model: k.model, endpoint: k.endpoint, apiVersion: k.api_version, isDefault: Boolean(k.is_default), status: k.status,
    lastTestedAt: k.last_tested_at, lastError: k.last_error, createdAt: k.created_at,
  };
}

export async function listKeys(tenantId) {
  const [w, p] = scopeSql(tenantId);
  return (await db.query(`SELECT * FROM ai_keys WHERE ${w} ORDER BY is_default DESC, created_at ASC`, p)).map(publicKey);
}

function validate(body, existing) {
  const provider = existing?.provider || str(body.provider, 20);
  if (!PROVIDERS[provider]) throw bad('Choose a provider: Gemini, OpenAI, Anthropic or Azure OpenAI.');
  const key = String(body.apiKey || '').trim();
  if (!existing && key.length < 10) throw bad('Paste the API key.');
  const model = str(body.model, 80) || PROVIDERS[provider].defaultModel;
  const endpoint = str(body.endpoint, 300);
  if (provider === 'azure' && !endpoint && !existing?.endpoint) throw bad('Azure OpenAI needs the endpoint, e.g. https://your-resource.openai.azure.com');
  if (endpoint && !/^https:\/\//i.test(endpoint)) throw bad('Endpoint must start with https://');
  return { provider, key, model, endpoint, apiVersion: str(body.apiVersion, 30) || (provider === 'azure' ? '2024-10-21' : ''), label: str(body.label, 60) || PROVIDERS[provider].label };
}

async function runTest(row) {
  const cfg = { provider: row.provider, key: decrypt(row.enc_key), model: row.model, endpoint: row.endpoint, apiVersion: row.api_version };
  try {
    const r = await testConnection(cfg);
    await db.run("UPDATE ai_keys SET status = 'ok', last_error = '', last_tested_at = $1 WHERE id = $2", [now(), row.id]);
    return { ok: r.ok, ms: r.ms };
  } catch (e) {
    await db.run("UPDATE ai_keys SET status = 'error', last_error = $1, last_tested_at = $2 WHERE id = $3", [String(e.message).slice(0, 400), now(), row.id]);
    return { ok: false, error: e.message };
  }
}

export async function createKey(ctx, tenantId, body) {
  const v = validate(body);
  const [w, p] = scopeSql(tenantId);
  const count = Number(await db.value(`SELECT CAST(COUNT(*) AS INTEGER) AS n FROM ai_keys WHERE ${w}`, p));
  const id = newId();
  const ts = now();
  const makeDefault = body.isDefault || count === 0;
  if (makeDefault) await db.run(`UPDATE ai_keys SET is_default = 0 WHERE ${w}`, p);
  await db.run(
    `INSERT INTO ai_keys (id, tenant_id, provider, label, enc_key, key_hint, model, endpoint, api_version, is_default, status, created_by, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'untested',$11,$12,$12)`,
    [id, tenantId, v.provider, v.label, encrypt(v.key), keyHint(v.key), v.model, v.endpoint, v.apiVersion, makeDefault ? 1 : 0, ctx.user.id, ts],
  );
  await audit(ctx, 'ai_key.created', 'ai_key', id, { provider: v.provider, model: v.model, platform: !tenantId });
  const row = await db.one('SELECT * FROM ai_keys WHERE id = $1', [id]);
  const test = body.test === false ? null : await runTest(row);
  return { key: publicKey(await db.one('SELECT * FROM ai_keys WHERE id = $1', [id])), test };
}

async function own(tenantId, id) {
  const [w, p] = scopeSql(tenantId);
  const row = await db.one(`SELECT * FROM ai_keys WHERE id = $${p.length + 1} AND ${w}`, [...p, id]);
  if (!row) throw notFound('AI key');
  return row;
}

export async function updateKey(ctx, tenantId, id, body) {
  const row = await own(tenantId, id);
  const v = validate(body, row);
  const [w, p] = scopeSql(tenantId);
  if (body.isDefault) await db.run(`UPDATE ai_keys SET is_default = 0 WHERE ${w}`, p);
  await db.run(
    `UPDATE ai_keys SET label = $1, model = $2, endpoint = $3, api_version = $4, is_default = $5, status = $6,
       enc_key = $7, key_hint = $8, updated_at = $9 WHERE id = $10`,
    [v.label, v.model, v.endpoint || row.endpoint, v.apiVersion || row.api_version,
      body.isDefault ? 1 : row.is_default, body.disabled ? 'disabled' : (v.key ? 'untested' : (row.status === 'disabled' ? 'untested' : row.status)),
      v.key ? encrypt(v.key) : row.enc_key, v.key ? keyHint(v.key) : row.key_hint, now(), id],
  );
  await audit(ctx, 'ai_key.updated', 'ai_key', id, { model: v.model, keyReplaced: Boolean(v.key) });
  return publicKey(await db.one('SELECT * FROM ai_keys WHERE id = $1', [id]));
}

export async function deleteKey(ctx, tenantId, id) {
  const row = await own(tenantId, id);
  await db.run('DELETE FROM ai_keys WHERE id = $1', [id]);
  if (row.is_default) {
    const [w, p] = scopeSql(tenantId);
    const next = await db.one(`SELECT id FROM ai_keys WHERE ${w} ORDER BY created_at ASC LIMIT 1`, p);
    if (next) await db.run('UPDATE ai_keys SET is_default = 1 WHERE id = $1', [next.id]);
  }
  await audit(ctx, 'ai_key.deleted', 'ai_key', id, { provider: row.provider });
  return { ok: true };
}

export async function testKey(ctx, tenantId, id) {
  const row = await own(tenantId, id);
  const r = await runTest(row);
  await audit(ctx, 'ai_key.tested', 'ai_key', id, { ok: r.ok });
  return r;
}

export function providerCatalog() {
  return Object.entries(PROVIDERS).map(([id, p]) => ({ id, label: p.label, models: p.models, defaultModel: p.defaultModel, needsEndpoint: Boolean(p.needsEndpoint), keyUrl: p.keyUrl }));
}
