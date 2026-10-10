// One function, chatJSON(), that works with every supported AI provider and always returns parsed JSON.
// Messages use the OpenAI shape internally:
//   [{ role: 'system', content: '...' }, { role: 'user', content: [{ type: 'text', text }, { type: 'image_url', image_url: { url: dataUrl } }] }]
// Each adapter converts that into its own API format and asks for JSON matching `schema`.
import { HttpError } from '../http.js';
import { config } from '../config.js';
import { mockAnswer } from './mock.js';

export const PROVIDERS = {
  gemini: {
    label: 'Google Gemini',
    models: ['gemini-flash-latest', 'gemini-3.8-flash', 'gemini-2.5-flash', 'gemini-2.5-pro'],
    defaultModel: 'gemini-flash-latest',
    keyUrl: 'https://aistudio.google.com/apikey',
  },
  openai: {
    label: 'OpenAI',
    models: ['gpt-4o', 'gpt-4.1', 'gpt-4o-mini'],
    defaultModel: 'gpt-4o',
    keyUrl: 'https://platform.openai.com/api-keys',
  },
  anthropic: {
    label: 'Anthropic Claude',
    models: ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5'],
    defaultModel: 'claude-sonnet-5-5',
    keyUrl: 'https://console.anthropic.com/settings/keys',
  },
  azure: {
    label: 'Azure OpenAI',
    models: ['gpt-4o'],
    defaultModel: 'gpt-4o',
    needsEndpoint: true,
    keyUrl: 'https://portal.azure.com',
  },
};
export const providerLabel = (p) => PROVIDERS[p]?.label || (p === 'mock' ? 'Demo AI (mock)' : p);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseDataUrl(url) {
  const m = /^data:(image\/[a-z+.-]+);base64,(.+)$/i.exec(String(url || ''));
  if (!m) throw new HttpError(400, 'Images must be sent as base64 data URLs.');
  return { mime: m[1].toLowerCase() === 'image/jpg' ? 'image/jpeg' : m[1].toLowerCase(), data: m[2] };
}
const systemText = (messages) => messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
const nonSystem = (messages) => messages.filter((m) => m.role !== 'system');
const parts = (content) => (typeof content === 'string' ? [{ type: 'text', text: content }] : content);

async function http(url, { headers, body }, provider) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), config.aiTimeoutMs);
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), signal: ctl.signal });
    const data = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, data };
  } catch (e) {
    if (e.name === 'AbortError') throw new HttpError(504, `${providerLabel(provider)} took too long to answer. Try again.`);
    throw new HttpError(502, `Could not reach ${providerLabel(provider)}: ${e.message}`);
  } finally { clearTimeout(timer); }
}

function upstreamError(provider, status, data) {
  const name = providerLabel(provider);
  const msg = data?.error?.message || data?.error?.status || (typeof data?.error === 'string' ? data.error : '') || `status ${status}`;
  if (status === 401 || status === 403) return new HttpError(502, `${name} rejected the API key. Check the key in Console > AI models. (${msg})`, 'ai_key_rejected');
  if (status === 404) return new HttpError(502, `${name}: model or deployment not found. Check the model name. (${msg})`, 'ai_model_not_found');
  if (status === 429) return new HttpError(429, `${name}: rate limit or quota reached. Wait a minute and try again. (${msg})`, 'ai_rate_limited');
  if (status === 400) return new HttpError(400, `${name} could not process the request: ${msg}`);
  return new HttpError(502, `${name} error: ${msg}`);
}

// Retry once on overload / temporary errors.
async function withRetry(fn) {
  const r = await fn();
  if ([429, 500, 502, 503, 529].includes(r.status)) { await sleep(1500); return fn(); }
  return r;
}

// ---------- OpenAI and Azure OpenAI ----------
async function openaiLike(cfg, { messages, schema, name, maxTokens }) {
  let url; let headers; let model;
  if (cfg.provider === 'azure') {
    let origin;
    try { origin = new URL(cfg.endpoint).origin; } catch { throw new HttpError(400, 'Azure endpoint is not a valid URL.'); }
    url = `${origin}/openai/deployments/${encodeURIComponent(cfg.model)}/chat/completions?api-version=${encodeURIComponent(cfg.apiVersion || '2024-10-21')}`;
    headers = { 'api-key': cfg.key };
  } else {
    url = `${(cfg.endpoint || 'https://api.openai.com').replace(/\/+$/, '')}/v1/chat/completions`;
    headers = { Authorization: `Bearer ${cfg.key}` };
    model = cfg.model;
  }
  const tokenField = cfg.provider === 'azure' ? 'max_tokens' : 'max_completion_tokens';
  const body = {
    ...(model ? { model } : {}),
    messages,
    temperature: 0,
    [tokenField]: maxTokens,
    response_format: { type: 'json_schema', json_schema: { name, strict: true, schema } },
  };
  let res = await withRetry(() => http(url, { headers, body }, cfg.provider));
  const err = () => String(res.data?.error?.message || '');
  // Some models do not accept temperature 0 -> retry without it
  if (!res.ok && res.status === 400 && /temperature/i.test(err())) {
    delete body.temperature;
    res = await http(url, { headers, body }, cfg.provider);
  }
  // Older API versions / models without structured outputs -> plain JSON mode with the schema in the prompt
  if (!res.ok && res.status === 400 && /response_format|json_schema/i.test(err())) {
    body.messages = [messages[0], { role: 'system', content: 'Reply ONLY with a JSON object that follows this JSON Schema exactly:\n' + JSON.stringify(schema) }, ...messages.slice(1)];
    body.response_format = { type: 'json_object' };
    res = await http(url, { headers, body }, cfg.provider);
  }
  if (!res.ok) throw upstreamError(cfg.provider, res.status, res.data);
  const choice = res.data.choices?.[0];
  if (choice?.finish_reason === 'content_filter') throw new HttpError(422, 'The AI content filter blocked this request. Try different photos.');
  if (choice?.message?.refusal) throw new HttpError(422, 'The AI declined to analyse these images: ' + choice.message.refusal);
  return {
    text: choice?.message?.content || '',
    usage: { in: res.data.usage?.prompt_tokens || 0, out: res.data.usage?.completion_tokens || 0 },
    truncated: choice?.finish_reason === 'length',
  };
}

// ---------- Anthropic Claude (structured output through a forced tool call) ----------
async function anthropic(cfg, { messages, schema, name, maxTokens }) {
  const msgs = nonSystem(messages).map((m) => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: parts(m.content).map((p) => {
      if (p.type === 'text') return { type: 'text', text: p.text };
      const { mime, data } = parseDataUrl(p.image_url?.url);
      return { type: 'image', source: { type: 'base64', media_type: mime, data } };
    }),
  }));
  const body = {
    model: cfg.model,
    max_tokens: maxTokens,
    temperature: 0,
    system: systemText(messages),
    messages: msgs,
    tools: [{ name, description: 'Return the complete result in this exact structure.', input_schema: schema }],
    tool_choice: { type: 'tool', name },
  };
  const url = `${(cfg.endpoint || 'https://api.anthropic.com').replace(/\/+$/, '')}/v1/messages`;
  const headers = { 'x-api-key': cfg.key, 'anthropic-version': '2023-06-01' };
  let res = await withRetry(() => http(url, { headers, body }, 'anthropic'));
  if (!res.ok && res.status === 400 && /temperature/i.test(String(res.data?.error?.message || ''))) {
    delete body.temperature;
    res = await http(url, { headers, body }, 'anthropic');
  }
  if (!res.ok) throw upstreamError('anthropic', res.status, res.data);
  const tool = (res.data.content || []).find((c) => c.type === 'tool_use');
  const usage = { in: res.data.usage?.input_tokens || 0, out: res.data.usage?.output_tokens || 0 };
  if (tool?.input) return { json: tool.input, usage, truncated: res.data.stop_reason === 'max_tokens' };
  const txt = (res.data.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
  return { text: txt, usage, truncated: res.data.stop_reason === 'max_tokens' };
}

// ---------- Google Gemini ----------
function toGeminiSchema(s) {
  if (Array.isArray(s)) return s.map(toGeminiSchema);
  if (!s || typeof s !== 'object') return s;
  const out = {};
  for (const [k, v] of Object.entries(s)) {
    if (k === 'additionalProperties') continue;
    if (k === 'type') out.type = String(v).toUpperCase();
    else if (k === 'properties') {
      out.properties = Object.fromEntries(Object.entries(v).map(([pk, pv]) => [pk, toGeminiSchema(pv)]));
      out.propertyOrdering = Object.keys(v); // keeps "evidence" before "verdict"
    } else if (k === 'items') out.items = toGeminiSchema(v);
    else out[k] = v;
  }
  return out;
}
async function gemini(cfg, { messages, schema, maxTokens }) {
  const contents = nonSystem(messages).map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: parts(m.content).map((p) => {
      if (p.type === 'text') return { text: p.text };
      const { mime, data } = parseDataUrl(p.image_url?.url);
      return { inline_data: { mime_type: mime, data } };
    }),
  }));
  const base = (cfg.endpoint || 'https://generativelanguage.googleapis.com').replace(/\/+$/, '');
  const url = `${base}/v1beta/models/${encodeURIComponent(cfg.model)}:generateContent`;
  const headers = { 'x-goog-api-key': cfg.key };
  const body = {
    systemInstruction: { parts: [{ text: systemText(messages) }] },
    contents,
    // thinking models spend part of the budget on reasoning, so give them room
    generationConfig: { temperature: 0, maxOutputTokens: Math.max(8192, maxTokens * 2), responseMimeType: 'application/json', responseSchema: toGeminiSchema(schema) },
  };
  let res = await withRetry(() => http(url, { headers, body }, 'gemini'));
  if (!res.ok && res.status === 400 && /schema|responseSchema|property/i.test(JSON.stringify(res.data?.error || ''))) {
    delete body.generationConfig.responseSchema;
    body.systemInstruction.parts.push({ text: 'Reply ONLY with a JSON object that follows this JSON Schema exactly:\n' + JSON.stringify(schema) });
    res = await http(url, { headers, body }, 'gemini');
  }
  if (!res.ok) throw upstreamError('gemini', res.status, res.data);
  if (res.data.promptFeedback?.blockReason) throw new HttpError(422, `Gemini blocked this request (${res.data.promptFeedback.blockReason}). Try different photos.`);
  const cand = res.data.candidates?.[0];
  if (['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII'].includes(cand?.finishReason)) throw new HttpError(422, 'Gemini safety filter blocked this request. Try different photos.');
  const txt = (cand?.content?.parts || []).filter((p) => !p.thought && typeof p.text === 'string').map((p) => p.text).join('');
  return {
    text: txt,
    usage: { in: res.data.usageMetadata?.promptTokenCount || 0, out: (res.data.usageMetadata?.candidatesTokenCount || 0) + (res.data.usageMetadata?.thoughtsTokenCount || 0) },
    truncated: cand?.finishReason === 'MAX_TOKENS',
  };
}

function parseJsonText(text, truncated) {
  const clean = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try { return JSON.parse(clean); } catch {
    const a = clean.indexOf('{'); const b = clean.lastIndexOf('}');
    if (a >= 0 && b > a) { try { return JSON.parse(clean.slice(a, b + 1)); } catch { /* fall through */ } }
    throw new HttpError(502, truncated ? 'The AI answer was cut off (too long). Try fewer photos or checks.' : 'The AI reply was not valid JSON. Try again.');
  }
}

/**
 * cfg: { provider, key, model, endpoint?, apiVersion? }
 * returns { data, usage: { in, out }, ms }
 */
export async function chatJSON(cfg, { messages, schema, name, maxTokens = 4000 }) {
  const t0 = Date.now();
  let out;
  switch (cfg.provider) {
    case 'openai': case 'azure': out = await openaiLike(cfg, { messages, schema, name, maxTokens }); break;
    case 'anthropic': out = await anthropic(cfg, { messages, schema, name, maxTokens }); break;
    case 'gemini': out = await gemini(cfg, { messages, schema, name, maxTokens }); break;
    case 'mock': out = { json: await mockAnswer({ messages, schema, name }), usage: { in: 0, out: 0 } }; break;
    default: throw new HttpError(400, `Unknown AI provider "${cfg.provider}".`);
  }
  const data = out.json ?? parseJsonText(out.text, out.truncated);
  return { data, usage: out.usage, ms: Date.now() - t0 };
}

// Small text-only call to check that a key and model work.
export async function testConnection(cfg) {
  const schema = { type: 'object', additionalProperties: false, required: ['ok', 'model_says'], properties: { ok: { type: 'boolean' }, model_says: { type: 'string' } } };
  const r = await chatJSON(cfg, {
    name: 'connection_test', schema, maxTokens: 300,
    messages: [{ role: 'system', content: 'You are a connection test. Answer with ok=true and model_says="ready".' }, { role: 'user', content: 'Test' }],
  });
  return { ok: r.data?.ok === true || r.data?.ok === 'true', ms: r.ms };
}
