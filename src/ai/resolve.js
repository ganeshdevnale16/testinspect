// Picks which AI provider + key a client uses, enforces the monthly AI limit and records usage.
//
// Order:
//   1. The client's own key chosen in Console > AI models (main key, or the separate second-check key)
//   2. The client's default key
//   3. Platform keys (yours) - only if the client's plan includes "platform AI"
//   4. Platform keys from environment variables (AZURE_OPENAI_*, OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY)
//   5. Demo AI when AI_MOCK=1
import { db, newId, now } from '../db/index.js';
import { decrypt } from '../security.js';
import { HttpError } from '../http.js';
import { config } from '../config.js';
import { chatJSON, PROVIDERS } from './providers.js';
import { monthStart } from '../auth.js';

function rowToCfg(row, source) {
  return {
    provider: row.provider,
    key: decrypt(row.enc_key),
    model: row.model || PROVIDERS[row.provider]?.defaultModel,
    endpoint: row.endpoint || '',
    apiVersion: row.api_version || '',
    keyId: row.id,
    label: row.label,
    source,
  };
}

export function envKeys() {
  const e = config.env;
  const out = [];
  if (e.azure.endpoint && e.azure.key) out.push({ provider: 'azure', key: e.azure.key, model: e.azure.deployment, endpoint: e.azure.endpoint, apiVersion: e.azure.apiVersion, source: 'platform-env', label: 'Azure OpenAI (server env)' });
  if (e.openai.key) out.push({ provider: 'openai', key: e.openai.key, model: e.openai.model, source: 'platform-env', label: 'OpenAI (server env)' });
  if (e.anthropic.key) out.push({ provider: 'anthropic', key: e.anthropic.key, model: e.anthropic.model, source: 'platform-env', label: 'Anthropic (server env)' });
  if (e.gemini.key) out.push({ provider: 'gemini', key: e.gemini.key, model: e.gemini.model, source: 'platform-env', label: 'Gemini (server env)' });
  return out;
}

async function platformCfg(preferProvider) {
  const rows = await db.query("SELECT * FROM ai_keys WHERE tenant_id IS NULL AND status <> 'disabled' ORDER BY is_default DESC, created_at ASC");
  const row = rows.find((r) => r.provider === preferProvider) || rows[0];
  if (row) return rowToCfg(row, 'platform');
  const env = envKeys();
  return env.find((k) => k.provider === preferProvider) || env[0] || null;
}

/** purpose: 'main' | 'verify' */
export async function resolveAI(ctx, purpose = 'main') {
  const t = ctx.tenant;
  const ai = t?.settings?.ai || {};
  const rows = t ? await db.query("SELECT * FROM ai_keys WHERE tenant_id = $1 AND status <> 'disabled' ORDER BY is_default DESC, created_at ASC", [t.id]) : [];
  const wantId = purpose === 'verify' ? (ai.verify_key_id || ai.main_key_id) : ai.main_key_id;
  const own = rows.find((r) => r.id === wantId) || rows.find((r) => r.is_default) || rows[0];
  if (own) return rowToCfg(own, 'own');
  if (ctx.limits?.platform_ai || !t) {
    const p = await platformCfg(ai.platform_provider);
    if (p) return p;
  }
  if (config.aiMock) return { provider: 'mock', key: '', model: 'demo', source: 'mock', label: 'Demo AI' };
  throw new HttpError(412, ctx.can?.('ai.manage')
    ? 'No AI model is set up yet. Add your Gemini, OpenAI or Anthropic API key in Console > AI models.'
    : 'AI is not set up for your company yet. Ask your admin to add an AI key in the Console.', 'ai_not_configured');
}

// Describes the current AI setup without revealing keys.
export async function aiStatus(ctx) {
  try {
    const main = await resolveAI(ctx, 'main');
    const verify = await resolveAI(ctx, 'verify');
    return { ready: true, provider: main.provider, model: main.model, source: main.source, verifyProvider: verify.provider, verifyModel: verify.model };
  } catch (e) { return { ready: false, message: e.message }; }
}

export async function aiCallsThisMonth(tenantId) {
  return Number(await db.value('SELECT CAST(COUNT(*) AS INTEGER) AS n FROM ai_usage WHERE tenant_id = $1 AND created_at >= $2', [tenantId, monthStart()])) || 0;
}

export async function checkAiQuota(ctx) {
  const max = ctx.limits?.max_ai_calls_month;
  if (!ctx.tenant || max === null || max === undefined) return;
  const used = await aiCallsThisMonth(ctx.tenant.id);
  if (used >= max) throw new HttpError(429, `Your plan's monthly AI limit (${max} AI checks) is used up. Contact us to upgrade.`, 'ai_quota');
}

async function record(ctx, kind, cfg, ok, usage, ms) {
  try {
    await db.run(
      'INSERT INTO ai_usage (id, tenant_id, user_id, kind, provider, model, key_source, tokens_in, tokens_out, ok, ms, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',
      [newId(), ctx.tenant?.id || null, ctx.user?.id || null, kind, cfg.provider, cfg.model, cfg.source, usage?.in || 0, usage?.out || 0, ok ? 1 : 0, ms || 0, now()],
    );
  } catch (e) { console.error('[usage]', e.message); }
}

// The one way the inspection code calls AI: picks the key, calls, meters.
export async function callAI(ctx, kind, purpose, req) {
  const cfg = await resolveAI(ctx, purpose);
  const t0 = Date.now();
  try {
    const r = await chatJSON(cfg, req);
    await record(ctx, kind, cfg, true, r.usage, r.ms);
    return { data: r.data, provider: cfg.provider, model: cfg.model };
  } catch (e) {
    await record(ctx, kind, cfg, false, null, Date.now() - t0);
    throw e;
  }
}
