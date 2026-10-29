// EXP-10 part 1: question text that may hold LaTeX between the marks (backslash-paren ... backslash-paren for inline,
// backslash-bracket ... backslash-bracket for display).
//
// THE ONLY PLACE KaTeX IS USED (owner 2026-10-29). Rules, all checked by tests:
//   - Only when `math` is true. Old questions (no flag) are drawn as plain text, byte for byte.
//   - KaTeX loads on first use (dynamic import), so pages without maths never download it.
//   - KaTeX settings come from KATEX_OPTIONS (trust off, strict errors, size and macro limits), the same object the
//     save-time check uses. If a piece fails, the page shows that piece as raw text. Nothing else is ever drawn as html.
//   - No dangerouslySetInnerHTML anywhere. katex.render writes into one span that React does not manage.
// A test (no-raw-html.test.ts) fails if any other file uses innerHTML or imports katex.
import React, { useEffect, useRef, useState } from "react";
import { KATEX_OPTIONS, splitMath } from "@assessiq/question-types";

export interface MathTextProps {
  text: string;
  /** From content.math. Anything other than true draws the text unchanged. */
  math?: boolean | undefined;
}

const OPEN = { inline: "\\(", display: "\\[" } as const;
const CLOSE = { inline: "\\)", display: "\\]" } as const;

function MathPiece({ tex, display }: { tex: string; display: boolean }): React.ReactElement {
  const target = useRef<HTMLSpanElement>(null);
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");
  const raw = `${display ? OPEN.display : OPEN.inline}${tex}${display ? CLOSE.display : CLOSE.inline}`;

  useEffect(() => {
    let live = true;
    setState("loading");
    void (async () => {
      try {
        const [mod] = await Promise.all([import("katex"), import("./katex-styles.js")]);
        if (!live || target.current === null) return;
        mod.default.render(tex, target.current, { ...KATEX_OPTIONS, displayMode: display });
        setState("ready");
      } catch {
        if (live) setState("failed");
      }
    })();
    return () => { live = false; };
  }, [tex, display]);

  return (
    // The accessible name is the formula source (role math + aria-label); the drawn copy is hidden from assistive
    // technology so it is not read twice. Without a name, a radio label that holds only a formula has no name (axe: label).
    <span role="math" aria-label={tex} data-testid="math-piece" data-math-state={state} style={display ? { display: "block", textAlign: "center", margin: "0.5em 0" } : undefined}>
      {state !== "ready" && <span aria-hidden="true">{raw}</span>}
      <span ref={target} hidden={state !== "ready"} aria-hidden="true" />
    </span>
  );
}

export function MathText({ text, math }: MathTextProps): React.ReactElement {
  if (math !== true) return <>{text}</>;
  const s = splitMath(text);
  if (!s.ok || s.parts.every((p) => p.kind === "text")) return <>{text}</>;
  return (
    <>
      {s.parts.map((p, i) =>
        p.kind === "text"
          ? <React.Fragment key={i}>{p.value}</React.Fragment>
          : <MathPiece key={i} tex={p.value} display={p.kind === "display"} />,
      )}
    </>
  );
}
