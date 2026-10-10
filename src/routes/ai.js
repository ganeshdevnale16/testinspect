// AI endpoints used by the field app. Each checks permission, subscription, monthly AI quota and rate.
import { requirePerm, requireWrite, requireActiveSubscription } from '../auth.js';
import { checkAiQuota } from '../ai/resolve.js';
import { rateLimit } from '../security.js';
import { HttpError } from '../http.js';
import { evaluate, liveFrame, liveVerify, suggest } from '../inspection/engine.js';

async function guard(ctx, perm, perMinute) {
  requirePerm(ctx, perm);
  requireWrite(ctx);
  requireActiveSubscription(ctx);
  const rl = rateLimit(`ai:${ctx.user.id}`, perMinute, 60e3);
  if (!rl.ok) throw new HttpError(429, 'Too many AI requests. Wait a few seconds.');
  await checkAiQuota(ctx);
}

export default function routes(r) {
  r.post('/api/ai/evaluate', async (ctx) => { await guard(ctx, 'inspect.run', 20); return evaluate(ctx, ctx.body); });
  r.post('/api/ai/live', async (ctx) => { await guard(ctx, 'inspect.run', 90); return liveFrame(ctx, ctx.body); });
  r.post('/api/ai/verify', async (ctx) => { await guard(ctx, 'inspect.run', 20); return liveVerify(ctx, ctx.body); });
  r.post('/api/ai/suggest', async (ctx) => { await guard(ctx, 'template.manage', 10); return suggest(ctx, ctx.body); });
}
