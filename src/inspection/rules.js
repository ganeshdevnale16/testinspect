// Every checklist line is a CHECK = a statement that must be TRUE.
//   "USB port"                                   -> the USB port must really be there
//   "USB cable :: plugged into a USB port"       -> the cable must be visibly inserted (state check)
//   "! Earthing wire :: connected and tightened" -> "!" marks a CRITICAL check
import { str } from '../http.js';
import { config } from '../config.js';

export function parseCheck(s) {
  let txt = String(s ?? '').trim();
  const critical = txt.startsWith('!');
  if (critical) txt = txt.slice(1);
  const [name, ...rest] = txt.split('::');
  return { name: str(name, 80), rule: str(rest.join('::'), 200), critical };
}

export function statement(s) {
  const { name, rule } = parseCheck(s);
  return rule
    ? `${name}: ${rule}`
    : `"${name}" is physically there on the item and clearly visible (an empty place or socket where it should be does NOT count).`;
}

export const STRICT_RULES = `How to judge each check:
- Each check is a STATEMENT that must be TRUE. Judge the WHOLE statement, not just whether an object exists.
- State words (connected, plugged in, inserted, attached, fitted, closed, locked, tightened, switched on, lit, turned on):
  TRUE only if you can SEE that state. Example: "USB cable plugged into laptop" is TRUE only if you see the cable's plug
  physically inside the laptop's USB port. An empty port = FALSE. A cable lying near the laptop but not inserted = FALSE.
  If the port area is hidden, cropped, blurry or too far to tell = UNCLEAR.
- A socket, port, slot or mounting point being visible does NOT mean something is connected or fitted in it.
- Negative checks ("no cracks", "not damaged", "without leaks"): TRUE only if the area is clearly visible and the problem is absent.
- Readings (gauge in green zone, level above mark, date not expired): TRUE only if you can actually read it.
- If the area is not in the photo, blocked, blurry, too dark or too far: UNCLEAR. Never guess.
- Never assume something because this kind of item normally has it.
- Write "evidence" FIRST: one short sentence describing exactly what you see at that spot. Then give the verdict.
- confidence (0 to 1) = how sure you are of the verdict. Use below 0.7 when the detail is small or partly hidden.`;

// Extra domain knowledge written by the client on the inspection template ("AI instructions").
export function contextBlock(aiContext) {
  const t = String(aiContext || '').trim().slice(0, 4000);
  return t ? `\n\nDOMAIN KNOWLEDGE FOR THIS INSPECTION (from the client - follow it):\n${t}` : '';
}

export function languageLine(lang) {
  const l = str(lang, 30);
  return l && !/^english$/i.test(l) ? `\nWrite evidence, summary and recommendations in ${l}.` : '';
}

export const VERDICT_TO_STATUS = { true: 'present', false: 'missing', unclear: 'unclear' };

export function aiSettings(ctx) {
  const a = ctx.tenant?.settings?.ai || {};
  const mc = Number(a.min_confidence);
  return {
    minConfidence: mc >= 0.3 && mc <= 0.99 ? mc : config.minConfidence,
    strictVerify: a.strict_verify === undefined ? config.strictVerify : Boolean(a.strict_verify),
    language: a.language || '',
  };
}
