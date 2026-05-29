// AssessIQ — ConceptCoverageView component.
//
// Collapsible card: highlights matched rubric anchor concepts inside the
// candidate's plain-text answer. Hit concepts highlighted inline; missed
// concepts listed below. All rendering via React nodes — never dangerouslySetInnerHTML.

import React from "react";

export interface ConceptCoverageViewProps {
  /** Plain-text answer the candidate submitted. Caller serialises per question type. */
  answerText: string;
  anchors: Array<{
    id: string;
    concept: string;
    synonyms?: string[];
    weight: number;
    hit: boolean;
    evidence_quote?: string;
  }>;
  /** Max chars before "Show all" truncation. Default 800. */
  maxChars?: number;
  "data-test-id"?: string;
}

// --- Highlighting helpers ---------------------------------------------------

/** term (lowercase) → display concept, for hit anchors only. */
function buildHitTermMap(anchors: ConceptCoverageViewProps["anchors"]): Map<string, string> {
  const map = new Map<string, string>();
  for (const a of anchors) {
    if (!a.hit) continue;
    for (const t of [a.concept, ...(a.synonyms ?? [])]) {
      const n = t.toLowerCase().trim();
      if (!n) continue;
      // Phase 3 review UX adversarial revision (Sonnet V2, 2026-05-29):
      // match on the literal concept + synonym terms only — no naive
      // suffix stemming. The previous `endsWith("s")` strip false-positived
      // on every 3-letter "log" in a sysadmin-heavy answer (rubric concept
      // "logs" stemmed to "log"), and `endsWith("ing")` produced nonsense
      // roots ("running" → "runn") that matched nothing useful. Admins
      // author concepts and synonyms deliberately; alternate inflections
      // should be added as explicit synonyms when the rubric is authored.
      map.set(n, a.concept);
    }
  }
  return map;
}

function truncateWord(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.lastIndexOf(" ", max);
  return cut > 0 ? text.slice(0, cut) : text.slice(0, max);
}

function truncConcept(s: string): string { return s.length > 32 ? s.slice(0, 31) + "…" : s; }

// --- Sub-component: inline highlighted answer text --------------------------

function HighlightedAnswer({ text, hitTermMap }: { text: string; hitTermMap: Map<string, string> }): React.ReactElement {
  // Split on word-boundary keeping separators; tag each token
  const nodes: React.ReactNode[] = text.split(/(\b)/).map((token, i) => {
    if (!/^\w+$/.test(token)) return token;
    const concept = hitTermMap.get(token.toLowerCase());
    if (!concept) return token;
    return (
      <span key={`${i}-${token}`} title={concept} style={{
        display: "inline-flex", alignItems: "center", gap: 2, padding: "0 4px",
        borderRadius: "var(--aiq-radius-sm)", background: "var(--aiq-color-success-soft)",
        color: "var(--aiq-color-success)", fontWeight: 500, cursor: "help" }}>
        <span aria-hidden="true" style={{ fontSize: "0.7em" }}>✓</span>{token}
      </span>
    );
  });
  return <span>{nodes}</span>;
}

// --- Main component ---------------------------------------------------------

export function ConceptCoverageView({ answerText, anchors, maxChars = 800, "data-test-id": testId }: ConceptCoverageViewProps): React.ReactElement {
  const [expanded, setExpanded] = React.useState(false);
  const [showAll,  setShowAll]  = React.useState(false);

  const hitTermMap     = React.useMemo(() => buildHitTermMap(anchors), [anchors]);
  const hitCount       = anchors.filter((a) => a.hit).length;
  const hitWeightSum   = anchors.filter((a) => a.hit).reduce((s, a) => s + a.weight, 0);
  const totalWeightSum = anchors.reduce((s, a) => s + a.weight, 0);
  const missedAnchors  = anchors.filter((a) => !a.hit);
  const isTruncated    = !showAll && answerText.length > maxChars;
  const displayText    = isTruncated ? truncateWord(answerText, maxChars) : answerText;

  const monoLabel: React.CSSProperties = { fontFamily: "var(--aiq-font-mono)", fontSize: "var(--aiq-text-xs)", textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--aiq-color-fg-muted)" };

  return (
    <div className="aiq-card" data-test-id={testId} style={{ display: "flex", flexDirection: "column", padding: 0, overflow: "hidden" }}>

      {/* Header — always visible */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "var(--aiq-space-sm) var(--aiq-space-md)", gap: "var(--aiq-space-sm)" }}>
        <span style={monoLabel}>Concept coverage in answer</span>
        <div style={{ display: "flex", alignItems: "center", gap: "var(--aiq-space-sm)" }}>
          <span style={{ fontFamily: "var(--aiq-font-mono)", fontSize: "var(--aiq-text-xs)", color: "var(--aiq-color-fg-secondary)", whiteSpace: "nowrap" }}>
            {hitCount}/{anchors.length} concepts found · {hitWeightSum}/{totalWeightSum} weight
          </span>
          <button aria-label={expanded ? "Collapse" : "Expand"} aria-expanded={expanded}
            onClick={() => setExpanded((v) => !v)}
            style={{ background: "none", border: "none", cursor: "pointer", padding: "2px 4px", color: "var(--aiq-color-fg-muted)", lineHeight: 1 }}>
            {expanded ? "▲" : "▼"}
          </button>
        </div>
      </div>

      {/* Body — shown when expanded */}
      {expanded && (
        <div style={{ borderTop: "1px solid var(--aiq-color-border)", padding: "var(--aiq-space-sm) var(--aiq-space-md)", display: "flex", flexDirection: "column", gap: "var(--aiq-space-sm)" }}>

          <p style={{ margin: 0, fontSize: "var(--aiq-text-xs)", color: "var(--aiq-color-fg-muted)", fontFamily: "var(--aiq-font-sans)", lineHeight: 1.4 }}>
            Highlights show where each rubric anchor was matched in the answer. Hit anchors are highlighted green; missed anchors are listed below.
          </p>

          {/* Answer with inline highlights */}
          <p style={{ margin: 0, fontSize: "var(--aiq-text-sm)", fontFamily: "var(--aiq-font-sans)", color: "var(--aiq-color-fg-primary)", lineHeight: 1.6, whiteSpace: "pre-wrap" }}>
            <HighlightedAnswer text={displayText} hitTermMap={hitTermMap} />
            {isTruncated && (<>{"… "}
              <button onClick={() => setShowAll(true)} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--aiq-color-fg-secondary)", fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-xs)", textDecoration: "underline", padding: 0 }}>
                Show all
              </button>
            </>)}
          </p>

          {/* Missed concepts */}
          {missedAnchors.length > 0 && (
            <div style={{ borderTop: "1px solid var(--aiq-color-border)", paddingTop: "var(--aiq-space-sm)", display: "flex", flexDirection: "column", gap: "var(--aiq-space-xs)" }}>
              <span style={monoLabel}>Missed concepts</span>
              <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--aiq-space-xs)" }}>
                {missedAnchors.map((a) => (
                  <span key={a.id} title={`${a.concept} · ${a.weight}pts`} style={{
                    display: "inline-flex", alignItems: "center", gap: 4, padding: "2px 8px",
                    borderRadius: "var(--aiq-radius-pill)", background: "var(--aiq-color-bg-sunken)",
                    color: "var(--aiq-color-fg-muted)", fontFamily: "var(--aiq-font-mono)",
                    fontSize: "var(--aiq-text-xs)", textTransform: "uppercase", letterSpacing: "0.04em" }}>
                    <span aria-hidden="true">✗</span>
                    <span>{truncConcept(a.concept)}</span>
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

ConceptCoverageView.displayName = "ConceptCoverageView";
