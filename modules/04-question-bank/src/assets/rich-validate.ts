// EXP-10 part 1: save-time check of maths in question content. Only runs when content.math === true.
// Every \( \) and \[ \] expression must parse in KaTeX with trust off and strict errors, so a bad or
// hostile expression is never stored. The candidate and admin pages draw it again with the same settings.
import katex from "katex";
import { ValidationError } from "@assessiq/core";
import { KATEX_OPTIONS, splitMath } from "@assessiq/question-types";

/** Commands that are never accepted (macro bombs, links, raw html, file access). KaTeX with trust:false refuses most of them already. */
const DENY = /\\(?:def|gdef|edef|xdef|let|futurelet|newcommand|renewcommand|providecommand|global|long|outer|char|href|url|includegraphics|html[A-Za-z]*|verb|input|include|write|read|csname|expandafter)\b/;

export { KATEX_OPTIONS };

function fieldsOf(content: Record<string, unknown>): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const k of ["question", "rationale", "unit"]) if (typeof content[k] === "string") out.push([k, content[k] as string]);
  if (Array.isArray(content["options"])) {
    (content["options"] as unknown[]).forEach((o, i) => { if (typeof o === "string") out.push([`options[${i}]`, o]); });
  }
  return out;
}

export function assertValidMath(content: unknown): void {
  if (content === null || typeof content !== "object" || Array.isArray(content)) return;
  const c = content as Record<string, unknown>;
  if (c["math"] !== true) return;
  const errors: Array<{ field: string; message: string }> = [];
  for (const [field, text] of fieldsOf(c)) {
    const s = splitMath(text);
    if (!s.ok) { errors.push({ field, message: s.reason }); continue; }
    for (const p of s.parts) {
      if (p.kind === "text") continue;
      if (DENY.test(p.value)) { errors.push({ field, message: "this LaTeX command is not allowed" }); continue; }
      try {
        katex.renderToString(p.value, { ...KATEX_OPTIONS, displayMode: p.kind === "display" });
      } catch (e) {
        errors.push({ field, message: `maths does not parse: ${(e as Error).message.slice(0, 120)}` });
      }
    }
  }
  if (errors.length > 0) {
    throw new ValidationError("The maths in this question is not valid", { details: { code: "INVALID_MATH", errors } });
  }
}
