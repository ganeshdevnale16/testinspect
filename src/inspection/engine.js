// The inspection brain (ported from v4 and extended):
//  evaluate  photo mode: photos + checklist -> AI first pass -> skeptical second check -> PASS / FAIL / REVIEW
//  live      one camera frame -> verdicts for the checks still open
//  verify    live scan: second check of every OK before the final result
//  suggest   inspection name -> suggested views and checks
// New in v5: works with any provider, client "AI instructions" per template, reference photos
// ("what good looks like"), optional second check by a different AI provider, answer language.
import { db, pj } from '../db/index.js';
import { HttpError, str } from '../http.js';
import { callAI } from '../ai/resolve.js';
import { statement, parseCheck, contextBlock, languageLine, STRICT_RULES, VERDICT_TO_STATUS, aiSettings } from './rules.js';

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const clamp01 = (n) => Math.max(0, Math.min(1, Number(n) || 0));
const isImg = (v) => typeof v === 'string' && /^data:image\/[a-z+.-]+;base64,/i.test(v);
const cleanList = (arr, max = 20, len = 300) => (Array.isArray(arr) ? arr : []).map((p) => str(p, len)).filter(Boolean).slice(0, max);

async function templateFor(ctx, id) {
  if (!id) return null;
  const t = await db.one('SELECT id, ai_context, angles, name FROM templates WHERE id = $1 AND tenant_id = $2', [String(id), ctx.tenant.id]);
  return t ? { ...t, angles: pj(t.angles, []) } : null;
}

const checkSchema = {
  type: 'object', additionalProperties: false, required: ['id', 'evidence', 'verdict', 'confidence'],
  properties: { id: { type: 'string' }, evidence: { type: 'string' }, verdict: { type: 'string', enum: ['true', 'false', 'unclear'] }, confidence: { type: 'number' } },
};

// ======================= SECOND CHECK =======================
const auditSchema = {
  type: 'object', additionalProperties: false, required: ['results'],
  properties: { results: { type: 'array', items: checkSchema } },
};
const AUDIT_SYSTEM = `You are a strict SECOND inspector doing a final audit.
Another inspector claims every statement below is TRUE. Many of these claims are wrong.
For each claim, look again very carefully at the photo it refers to and actively try to find evidence that it is FALSE
(e.g. the port is empty, the plug is not fully inserted, the part is a different part, the part is hidden).
Answer "true" only if the photo clearly proves the statement.
${STRICT_RULES}
Return one result for EVERY claim id. Ignore the small timestamp strip at the bottom of photos.`;

export async function verifyClaims(ctx, { item, description, frames, claims, aiContext }) {
  const out = new Map();
  if (!claims.length || !frames.length) return out;
  const { minConfidence, language } = aiSettings(ctx);
  const content = [{
    type: 'text',
    text: `Item: ${item}${description ? '\nDetails: ' + description : ''}\n\nClaims to audit:\n`
      + JSON.stringify(claims.map((c) => ({ id: c.id, statement: c.statement, look_in: c.frame || 'any photo' })), null, 1),
  }];
  frames.forEach((f) => { content.push({ type: 'text', text: `Photo: "${f.label}"` }); content.push({ type: 'image_url', image_url: { url: f.url, detail: 'high' } }); });
  const { data: ai } = await callAI(ctx, 'verify', 'verify', {
    name: 'audit', schema: auditSchema, maxTokens: 2500,
    messages: [{ role: 'system', content: AUDIT_SYSTEM + contextBlock(aiContext) + languageLine(language) }, { role: 'user', content }],
  });
  (Array.isArray(ai.results) ? ai.results : []).forEach((r) => {
    const id = String(r.id || '');
    if (!claims.some((c) => c.id === id) || out.has(id)) return;
    const confidence = clamp01(r.confidence);
    let status = VERDICT_TO_STATUS[r.verdict] || 'unclear';
    if (status === 'present' && confidence < minConfidence) status = 'unclear';
    if (status === 'missing' && confidence < 0.5) status = 'unclear';
    out.set(id, { status, confidence, evidence: str(r.evidence, 200) });
  });
  claims.forEach((c) => { if (!out.has(c.id)) out.set(c.id, { status: 'unclear', confidence: 0, evidence: 'Not confirmed in second check' }); });
  return out;
}

// ======================= PHOTO MODE =======================
const evalSchema = {
  type: 'object', additionalProperties: false,
  required: ['item_identified', 'item_matches', 'angles', 'general_checks', 'defects', 'summary', 'recommendations'],
  properties: {
    item_identified: { type: 'string' },
    item_matches: { type: 'boolean' },
    angles: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['angle', 'correct_view', 'image_quality', 'quality_issues', 'checks', 'observations'],
        properties: {
          angle: { type: 'string' }, correct_view: { type: 'boolean' },
          image_quality: { type: 'string', enum: ['good', 'acceptable', 'poor'] },
          quality_issues: { type: 'array', items: { type: 'string' } },
          checks: { type: 'array', items: checkSchema },
          observations: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    general_checks: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['id', 'evidence', 'verdict', 'confidence', 'found_in'],
        properties: { ...checkSchema.properties, found_in: { type: 'string' } },
      },
    },
    defects: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['angle', 'description', 'severity'],
        properties: { angle: { type: 'string' }, description: { type: 'string' }, severity: { type: 'string', enum: ['low', 'medium', 'high'] } },
      },
    },
    summary: { type: 'string' },
    recommendations: { type: 'array', items: { type: 'string' } },
  },
};
const EVAL_SYSTEM = `You are a strict visual quality and safety inspector. You check photos of one physical item against a checklist.
${STRICT_RULES}
Other rules:
- Use the exact check ids given. Report EVERY check id of a view in that view's "checks".
- For each view, say whether the photo really shows the requested view (correct_view) and rate image quality.
- Record visible damage: cracks, dents, rust, burns, leaks, loose or cut wires, missing screws, broken seals.
- If a REFERENCE photo is given for a view, it shows what a correct item looks like. Compare against it: parts present in the
  reference but absent in the inspection photo are FALSE. Never copy evidence from the reference photo.
- Ignore the small timestamp strip at the bottom of each photo.
- item_matches is false if the photos show a different kind of item than the one named.
Write evidence and notes in short, simple English.`;

function validateEval(body) {
  const item = str(body.item, 120);
  if (!item) throw new HttpError(400, 'Item name is required.');
  const angles = (Array.isArray(body.angles) ? body.angles : []).slice(0, 12).map((a) => ({
    name: str(a?.name, 60), guidance: str(a?.guidance, 200), parts: cleanList(a?.parts), image: isImg(a?.image) ? a.image : null,
  })).filter((a) => a.name);
  if (!angles.some((a) => a.image)) throw new HttpError(400, 'Capture at least one photo before evaluating.');
  return { item, templateId: str(body.templateId, 60), description: str(body.description, 1200), angles, general_parts: cleanList(body.general_parts, 10) };
}

export async function evaluate(ctx, body) {
  const input = validateEval(body);
  const tpl = await templateFor(ctx, input.templateId);
  const settings = aiSettings(ctx);
  input.angles.forEach((a, vi) => { a.checks = a.parts.map((p, ci) => ({ id: `v${vi + 1}c${ci + 1}`, part: p, statement: statement(p) })); });
  input.general = input.general_parts.map((p, i) => ({ id: `g${i + 1}`, part: p, statement: statement(p) }));
  const refs = new Map((tpl?.angles || []).filter((a) => isImg(a.reference)).map((a) => [norm(a.name), a.reference]));

  // ---- first pass
  const shot = input.angles.filter((a) => a.image);
  const checklist = {
    item: input.item,
    details: input.description || undefined,
    views: shot.map((a) => ({ view: a.name, how_it_should_look: a.guidance || undefined, checks: a.checks.map((c) => ({ id: c.id, must_be_true: c.statement })) })),
    checks_for_any_view: input.general.map((c) => ({ id: c.id, must_be_true: c.statement })),
  };
  const content = [{ type: 'text', text: 'Inspection checklist:\n' + JSON.stringify(checklist, null, 1) + '\n\nPhotos follow, one per view.' }];
  shot.forEach((a) => {
    const ref = refs.get(norm(a.name));
    if (ref) { content.push({ type: 'text', text: `REFERENCE photo (correct example) for view: "${a.name}"` }); content.push({ type: 'image_url', image_url: { url: ref, detail: 'low' } }); }
    content.push({ type: 'text', text: `Photo for view: "${a.name}"` });
    content.push({ type: 'image_url', image_url: { url: a.image, detail: 'high' } });
  });
  const first = await callAI(ctx, 'evaluate', 'main', {
    name: 'inspection', schema: evalSchema, maxTokens: 4000,
    messages: [{ role: 'system', content: EVAL_SYSTEM + contextBlock(tpl?.ai_context) + languageLine(settings.language) }, { role: 'user', content }],
  });
  const ai = first.data || {};

  // ---- rows from first pass
  const aiAngles = Array.isArray(ai.angles) ? ai.angles : [];
  const byId = new Map();
  [...aiAngles.flatMap((a) => (Array.isArray(a.checks) ? a.checks : [])), ...(Array.isArray(ai.general_checks) ? ai.general_checks : [])]
    .forEach((c) => { if (c?.id && !byId.has(String(c.id))) byId.set(String(c.id), c); });
  const rows = [];
  const fromAI = (c, group) => {
    const r = byId.get(c.id);
    if (!r) return { id: c.id, group, part: c.part, status: 'unclear', confidence: 0, note: 'Not reported by AI' };
    const confidence = clamp01(r.confidence);
    let status = VERDICT_TO_STATUS[r.verdict] || 'unclear';
    let note = str(r.evidence, 200);
    if (status === 'present' && confidence < settings.minConfidence) { status = 'unclear'; note += ` (low confidence ${Math.round(confidence * 100)}%)`; }
    return { id: c.id, group, part: c.part, status, confidence, note, foundIn: str(r.found_in, 60) };
  };
  input.angles.forEach((a) => a.checks.forEach((c) => rows.push(a.image ? fromAI(c, a.name) : { id: c.id, group: a.name, part: c.part, status: 'missing', confidence: 1, note: 'This view was not photographed' })));
  input.general.forEach((c) => rows.push(fromAI(c, 'Any view')));
  rows.forEach((r) => { r.critical = parseCheck(r.part).critical; });

  // ---- second check of every OK
  const verify = { ran: false, changed: 0, provider: '', model: '' };
  const claims = rows.filter((r) => r.status === 'present');
  if (settings.strictVerify && claims.length) {
    const frames = shot.map((a) => ({ label: a.name, url: a.image }));
    const stmt = new Map([...input.angles.flatMap((a) => a.checks), ...input.general].map((c) => [c.id, c.statement]));
    const res = await verifyClaims(ctx, {
      item: input.item, description: input.description, frames, aiContext: tpl?.ai_context,
      claims: claims.map((r) => ({ id: r.id, statement: stmt.get(r.id), frame: r.group === 'Any view' ? (r.foundIn || '') : r.group })),
    });
    verify.ran = true;
    claims.forEach((r) => {
      const v = res.get(r.id);
      if (!v || v.status === 'present') { if (v) r.confidence = Math.min(r.confidence, v.confidence); r.note += ' · confirmed by second check'; return; }
      verify.changed++;
      r.status = v.status; r.confidence = v.confidence;
      r.note = `Second check: ${v.evidence || (v.status === 'missing' ? 'not true' : 'could not confirm')}`;
    });
  }

  // ---- decision
  const total = rows.length;
  const present = rows.filter((c) => c.status === 'present').length;
  const missing = rows.filter((c) => c.status === 'missing').length;
  const unclear = total - present - missing;
  const completion = total ? Math.round((present / total) * 100) : 100;
  const defects = Array.isArray(ai.defects) ? ai.defects : [];
  const highDefects = defects.filter((d) => d.severity === 'high');
  const badViews = aiAngles.filter((a) => a.correct_view === false).map((a) => a.angle);
  const poorViews = aiAngles.filter((a) => a.image_quality === 'poor').map((a) => a.angle);
  const reasons = [];
  const critFail = rows.filter((c) => c.critical && c.status === 'missing').length;
  const critUnclear = rows.filter((c) => c.critical && c.status === 'unclear').length;
  const pl = (n, w) => `${n} ${w}${n > 1 ? 's' : ''}`;
  if (critFail) reasons.push(`${pl(critFail, 'critical safety check')} failed`);
  if (missing) reasons.push(`${pl(missing, 'check')} failed`);
  if (critUnclear) reasons.push(`${pl(critUnclear, 'critical check')} not confirmed`);
  if (highDefects.length) reasons.push(`${pl(highDefects.length, 'serious defect')} found`);
  if (unclear) reasons.push(`${pl(unclear, 'check')} could not be confirmed`);
  if (poorViews.length) reasons.push(`Poor photo quality: ${poorViews.join(', ')}`);
  if (badViews.length) reasons.push(`Wrong view captured: ${badViews.join(', ')}`);
  if (ai.item_matches === false) reasons.push(`Photos look like "${str(ai.item_identified, 80)}", not the selected item`);
  if (verify.changed) reasons.push(`Second check overturned ${pl(verify.changed, 'first-pass OK result')}`);
  let status = 'PASS';
  if (missing || highDefects.length) status = 'FAIL';
  else if (unclear || poorViews.length || badViews.length || ai.item_matches === false) status = 'REVIEW';
  if (status === 'PASS') reasons.push(verify.ran ? 'All checks confirmed twice' : 'All checks confirmed');
  aiAngles.forEach((a) => { const m = input.angles.find((x) => norm(x.name) === norm(a.angle)); if (m) a.angle = m.name; });

  return {
    status, completion, counts: { total, present, missing, unclear }, reasons,
    checklist: rows, ai,
    minConfidence: settings.minConfidence, secondCheck: verify.ran,
    provider: first.provider, model: first.model,
    evaluatedAt: new Date().toISOString(),
  };
}

// ======================= LIVE SCAN (one frame) =======================
const liveSchema = {
  type: 'object', additionalProperties: false, required: ['item_visible', 'view', 'frame_quality', 'hint', 'detections', 'defects'],
  properties: {
    item_visible: { type: 'boolean' }, view: { type: 'string' },
    frame_quality: { type: 'string', enum: ['good', 'acceptable', 'poor'] }, hint: { type: 'string' },
    detections: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['id', 'evidence', 'verdict', 'confidence', 'box'],
        properties: { id: { type: 'string' }, evidence: { type: 'string' }, verdict: { type: 'string', enum: ['true', 'false'] }, confidence: { type: 'number' }, box: { type: 'array', items: { type: 'number' } } },
      },
    },
    defects: {
      type: 'array',
      items: { type: 'object', additionalProperties: false, required: ['description', 'severity'], properties: { description: { type: 'string' }, severity: { type: 'string', enum: ['low', 'medium', 'high'] } } },
    },
  },
};
const LIVE_SYSTEM = `You are a strict live visual inspector looking at ONE frame from a phone camera moving around an item.
For each open check, decide if THIS frame proves it TRUE or proves it FALSE.
${STRICT_RULES}
Live-scan rules:
- If a check cannot be judged from this frame (area not in view, too small, blurry), DO NOT include it at all.
- Include a check as "false" only if the exact spot is clearly in view and the statement is clearly not true.
- box = location of the spot you judged as [x, y, width, height], fractions 0-1 of the frame. [0,0,0,0] if unsure.
- view = which listed view the camera shows now (exact name), or "unknown".
- item_visible = false if the frame does not show the item at all.
- hint = ONE short instruction (max 8 words) for the user, e.g. "Move closer to the USB port". Empty if nothing to say.
- defects: only clearly visible damage. Empty if none.`;

export async function liveFrame(ctx, body) {
  const item = str(body.item, 120);
  if (!item) throw new HttpError(400, 'Item name is required.');
  if (!isImg(body.frame)) throw new HttpError(400, 'A camera frame is required.');
  if (body.frame.length > 1_500_000) throw new HttpError(413, 'Frame is too large.');
  const settings = aiSettings(ctx);
  const tpl = await templateFor(ctx, str(body.templateId, 60));
  const pending = (Array.isArray(body.pending) ? body.pending : []).slice(0, 80)
    .map((p, i) => ({ id: 'c' + (i + 1), view: str(p?.view, 60), part: str(p?.part, 300) })).filter((p) => p.view && p.part);
  const views = cleanList(body.views, 12, 60);
  const viewHint = views.includes(str(body.viewHint, 60)) ? str(body.viewHint, 60) : '';
  const byView = {};
  pending.forEach((p) => { (byView[p.view] ||= []).push({ id: p.id, must_be_true: statement(p.part) }); });
  const task = {
    item, details: str(body.description, 1200) || undefined, all_views: views,
    open_checks: Object.entries(byView).map(([view, checks]) => ({ view, checks })),
    note: 'Checks under "Any view" can be judged from any view.',
    user_says_this_photo_shows_view: viewHint || undefined,
  };
  const { data: ai } = await callAI(ctx, 'live', 'main', {
    name: 'live_frame', schema: liveSchema, maxTokens: 1200,
    messages: [
      { role: 'system', content: LIVE_SYSTEM + contextBlock(tpl?.ai_context) },
      { role: 'user', content: [{ type: 'text', text: 'Checklist:\n' + JSON.stringify(task) }, { type: 'image_url', image_url: { url: body.frame, detail: 'high' } }] },
    ],
  });
  const byId = new Map(pending.map((p) => [p.id, p]));
  const seen = new Set();
  const detections = [];
  (Array.isArray(ai.detections) ? ai.detections : []).forEach((d) => {
    const p = byId.get(String(d.id || ''));
    if (!p || seen.has(p.id)) return;
    const confidence = clamp01(d.confidence);
    if (confidence < settings.minConfidence) return;
    seen.add(p.id);
    const b = Array.isArray(d.box) ? d.box.slice(0, 4).map(clamp01) : [0, 0, 0, 0];
    while (b.length < 4) b.push(0);
    detections.push({ key: p.view + '|' + p.part, view: p.view, part: p.part, status: d.verdict === 'true' ? 'present' : 'missing', confidence, evidence: str(d.evidence, 160), box: b[2] > 0.01 && b[3] > 0.01 ? b : null });
  });
  return {
    itemVisible: ai.item_visible !== false,
    view: views.find((v) => norm(v) === norm(ai.view)) || null,
    frameQuality: ['good', 'acceptable', 'poor'].includes(ai.frame_quality) ? ai.frame_quality : 'acceptable',
    hint: str(ai.hint, 80),
    detections,
    defects: (Array.isArray(ai.defects) ? ai.defects : []).slice(0, 5)
      .map((d) => ({ description: str(d.description, 160), severity: ['low', 'medium', 'high'].includes(d.severity) ? d.severity : 'low' })).filter((d) => d.description),
    minConfidence: settings.minConfidence,
  };
}

// ======================= LIVE SCAN final verify =======================
export async function liveVerify(ctx, body) {
  const item = str(body.item, 120);
  if (!item) throw new HttpError(400, 'Item name is required.');
  const settings = aiSettings(ctx);
  const frames = (Array.isArray(body.frames) ? body.frames : []).slice(0, 8).filter((f) => isImg(f?.url))
    .map((f, i) => ({ label: str(f.label, 40) || `Frame ${i + 1}`, url: f.url }));
  const labels = new Set(frames.map((f) => f.label));
  const claims = (Array.isArray(body.claims) ? body.claims : []).slice(0, 60).map((c, i) => ({
    key: str(c?.key, 400), id: 'k' + (i + 1), statement: statement(str(c?.part, 300)), frame: labels.has(c?.frame) ? c.frame : '',
  })).filter((c) => c.key);
  if (!frames.length || !claims.length) throw new HttpError(400, 'Nothing to verify.');
  if (!settings.strictVerify) return { skipped: true, results: claims.map((c) => ({ key: c.key, status: 'present', confidence: 1, evidence: '' })) };
  const tpl = await templateFor(ctx, str(body.templateId, 60));
  const out = await verifyClaims(ctx, { item, description: str(body.description, 1200), frames, claims, aiContext: tpl?.ai_context });
  return { skipped: false, minConfidence: settings.minConfidence, results: claims.map((c) => ({ key: c.key, ...out.get(c.id) })) };
}

// ======================= SUGGEST CHECKLIST =======================
const suggestSchema = {
  type: 'object', additionalProperties: false, required: ['angles', 'general_parts'],
  properties: {
    angles: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['name', 'guidance', 'parts'], properties: { name: { type: 'string' }, guidance: { type: 'string' }, parts: { type: 'array', items: { type: 'string' } } } } },
    general_parts: { type: 'array', items: { type: 'string' } },
  },
};
export async function suggest(ctx, body) {
  const item = str(body.item, 120);
  const description = str(body.description, 600);
  const industry = str(body.industry, 60);
  if (!item) throw new HttpError(400, 'Enter an item name first.');
  const { data: out } = await callAI(ctx, 'suggest', 'main', {
    name: 'checklist', schema: suggestSchema, maxTokens: 2500,
    messages: [
      {
        role: 'system',
        content:
          'You design photo-inspection checklists for field technicians. Return 3 to 6 camera views (angles) that together show the whole item. '
          + 'For each view give a short name (e.g. "Front", "Left side", "Inside - door open"), one sentence of guidance on how to frame the photo, '
          + 'and 2 to 6 visually checkable CHECKS. Write each check as "Short name" for a simple presence check, or "Short name :: what must be visibly true" '
          + 'when a state or condition matters, e.g. "USB cable :: plugged fully into a USB port of the laptop", "Earthing wire :: connected and tightened at the earth terminal". '
          + 'Start a check with "! " if a failure would make the item unsafe or unusable (critical). '
          + 'Always use the "::" form for connected / plugged / fitted / closed / switched-on / no-damage / reading checks. '
          + 'Put checks that could be seen from several views in general_parts (0 to 4 items). Use short, plain wording. Do not invent brand names. '
          + 'Follow common industry safety and quality practice for this kind of item.',
      },
      { role: 'user', content: `Item: ${item}\n${industry ? 'Industry: ' + industry + '\n' : ''}${description ? 'Details: ' + description : ''}` },
    ],
  });
  const angles = (out.angles || []).slice(0, 8).map((a) => ({ name: str(a.name, 60), guidance: str(a.guidance, 200), parts: (a.parts || []).map((p) => str(p, 200)).filter(Boolean).slice(0, 10) })).filter((a) => a.name);
  const general_parts = (out.general_parts || []).map((p) => str(p, 200)).filter(Boolean).slice(0, 8);
  return { angles, general_parts };
}
