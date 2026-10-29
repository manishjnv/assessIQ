// EXP-10 part 1: split question text into plain text and LaTeX parts. Pure, no katex here.
// Inline maths is \( ... \), display maths is \[ ... \]. Everything else is text. An open delimiter
// with no close, a nested open, or an over-long expression makes the whole field "broken": the caller
// shows the raw text and the save-time check refuses it.
export const MATH_MAX_EXPR_CHARS = 500;
export const MATH_MAX_EXPRS_PER_FIELD = 30;

export type MathPart =
  | { kind: "text"; value: string }
  | { kind: "inline" | "display"; value: string };

export type MathSplit = { ok: true; parts: MathPart[] } | { ok: false; reason: string };

const OPEN_INLINE = "\\(";
const OPEN_DISPLAY = "\\[";
const CLOSE_INLINE = "\\)";
const CLOSE_DISPLAY = "\\]";

export function splitMath(text: string): MathSplit {
  const parts: MathPart[] = [];
  let i = 0;
  let n = 0;
  let buf = "";
  while (i < text.length) {
    const two = text.slice(i, i + 2);
    if (two === OPEN_INLINE || two === OPEN_DISPLAY) {
      const closer = two === OPEN_INLINE ? CLOSE_INLINE : CLOSE_DISPLAY;
      const end = text.indexOf(closer, i + 2);
      if (end < 0) return { ok: false, reason: "a maths expression is not closed" };
      const expr = text.slice(i + 2, end);
      if (expr.includes(OPEN_INLINE) || expr.includes(OPEN_DISPLAY)) return { ok: false, reason: "maths expressions cannot be nested" };
      if (expr.trim() === "") return { ok: false, reason: "a maths expression is empty" };
      if (expr.length > MATH_MAX_EXPR_CHARS) return { ok: false, reason: `a maths expression is longer than ${MATH_MAX_EXPR_CHARS} characters` };
      if (++n > MATH_MAX_EXPRS_PER_FIELD) return { ok: false, reason: `more than ${MATH_MAX_EXPRS_PER_FIELD} maths expressions in one field` };
      if (buf !== "") { parts.push({ kind: "text", value: buf }); buf = ""; }
      parts.push({ kind: two === OPEN_INLINE ? "inline" : "display", value: expr });
      i = end + 2;
      continue;
    }
    if (two === CLOSE_INLINE || two === CLOSE_DISPLAY) return { ok: false, reason: "a maths close mark has no open mark" };
    buf += text[i];
    i++;
  }
  if (buf !== "") parts.push({ kind: "text", value: buf });
  return { ok: true, parts };
}
