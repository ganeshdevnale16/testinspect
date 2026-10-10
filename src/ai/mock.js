// DEMO AI: plausible fake answers so the whole product can be shown and tested without any API key.
// Only used when AI_MOCK=1 on the server. Never use for real inspections.
const textOf = (messages) => messages.filter((m) => m.role !== 'system')
  .flatMap((m) => (typeof m.content === 'string' ? [m.content] : m.content.filter((p) => p.type === 'text').map((p) => p.text))).join('\n');
const jsonAfter = (txt, marker) => {
  const i = txt.indexOf(marker);
  if (i < 0) return null;
  const s = txt.slice(i + marker.length);
  const end = s.lastIndexOf('}');
  // the JSON block ends before the next "Photo" line
  const cut = s.split('\n\nPhotos follow')[0].split('\nPhoto:')[0];
  try { return JSON.parse(cut.trim()); } catch { try { return JSON.parse(s.slice(0, end + 1)); } catch { return null; } }
};
// deterministic "random" per id so the same demo gives the same result
const roll = (id) => { let h = 7; for (const c of String(id)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return (h % 100) / 100; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function mockAnswer({ messages, name }) {
  await sleep(500);
  const txt = textOf(messages);
  if (name === 'connection_test') return { ok: true, model_says: 'ready' };

  if (name === 'checklist') {
    const item = (/Item: (.*)/.exec(txt) || [])[1] || 'item';
    return {
      angles: [
        { name: 'Front', guidance: `Whole front of the ${item} in frame`, parts: ['Nameplate :: nameplate or ID label present and readable', 'Body condition :: no cracks, dents or rust'] },
        { name: 'Controls', guidance: 'Close-up of switches, gauges or controls', parts: ['! Controls :: all controls fitted, none broken or missing'] },
        { name: 'Back / connections', guidance: 'Rear side with cables or pipes visible', parts: ['Connections :: cables or pipes connected and secured', 'No leaks :: no visible leaks or stains'] },
      ],
      general_parts: ['Cleanliness :: area around the item is clean and free of debris'],
    };
  }

  if (name === 'inspection') {
    const c = jsonAfter(txt, 'Inspection checklist:\n') || { views: [], checks_for_any_view: [] };
    const verdict = (id) => { const r = roll(id); return r < 0.12 ? ['false', 0.86] : r < 0.2 ? ['unclear', 0.5] : ['true', 0.92]; };
    return {
      item_identified: c.item || 'item',
      item_matches: true,
      angles: (c.views || []).map((v) => ({
        angle: v.view, correct_view: true, image_quality: 'good', quality_issues: [], observations: ['Demo AI result'],
        checks: (v.checks || []).map((k) => { const [vd, cf] = verdict(k.id); return { id: k.id, evidence: vd === 'true' ? 'Clearly visible in the photo (demo).' : vd === 'false' ? 'Not present where expected (demo).' : 'Area is partly hidden (demo).', verdict: vd, confidence: cf }; }),
      })),
      general_checks: (c.checks_for_any_view || []).map((k) => { const [vd, cf] = verdict(k.id); return { id: k.id, evidence: 'Seen in the first photo (demo).', verdict: vd, confidence: cf, found_in: c.views?.[0]?.view || '' }; }),
      defects: roll(c.item) < 0.4 ? [{ angle: c.views?.[0]?.view || '', description: 'Light surface rust near the base (demo)', severity: 'low' }] : [],
      summary: 'Demo AI result: most checks are visible and OK.',
      recommendations: ['This is a demo answer. Add a real AI key in Console > AI models.'],
    };
  }

  if (name === 'audit') {
    const claims = jsonAfter(txt, 'Claims to audit:\n') || [];
    return { results: (Array.isArray(claims) ? claims : []).map((k) => ({ id: k.id, evidence: 'Confirmed on second look (demo).', verdict: roll('v' + k.id) < 0.05 ? 'unclear' : 'true', confidence: 0.88 })) };
  }

  if (name === 'live_frame') {
    const task = jsonAfter(txt, 'Checklist:\n') || { open_checks: [] };
    const open = (task.open_checks || []).flatMap((g) => g.checks || []);
    const pick = open.filter((_, i) => i < 2);
    return {
      item_visible: true, view: task.all_views?.[0] || 'unknown', frame_quality: 'good', hint: open.length ? 'Move slowly around the item' : '',
      detections: pick.map((k) => ({ id: k.id, evidence: 'Visible in this frame (demo).', verdict: 'true', confidence: 0.9, box: [0.3, 0.3, 0.3, 0.3] })),
      defects: [],
    };
  }
  return {};
}
