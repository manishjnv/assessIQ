// AssessIQ — ExpectedAnswerView
//
// Renders the ANSWER KEY + RUBRIC for a question — "what a correct answer
// looks like / what we grade against" — as a distinct audit zone, separate
// from the candidate-facing prompt (<QuestionPromptView>) and from the AI's
// scoring (<ScoreDetail>).
//
// Per question type:
//  - mcq         → correct option (letter + text) + rationale
//  - subjective  → rubric anchors only (concept + weight). No authored model
//                  answer exists for subjective, so the rubric IS the expected
//                  answer; if there is no rubric the question grades holistically.
//  - kql         → expected keywords (+ rubric anchors if present)
//  - scenario    → per-step expected (+ rubric anchors if present)
//  - log_analysis→ expected findings + sample solution (+ rubric anchors)
//
// The rubric anchors are the literal grading ground-truth (each AI anchor_hit
// in ScoreDetail pairs back to one of these by id), so showing them here lets
// the admin audit the AI's hit/miss decisions against the actual rubric.
//
// INVARIANTS:
//  - Read-only. Audience is admin/reviewer ONLY — this view is mounted on an
//    adminOnly route and must never be rendered in a candidate-facing path.
//  - Never crashes on malformed content (per-section fallbacks).

import React from "react";
import { cleanText, safeStr, safeArr, obj, JsonFallback, SUBLABEL_STYLE, OPTION_LABELS } from "./question-format.js";

export interface RubricAnchorForReview {
  id: string;
  concept: string;
  weight: number;
  synonyms?: string[];
  /** A3 self-certifying fields: KB source backing the concept + one-line why. */
  citation?: string;
  rationale?: string;
}

export interface ExpectedAnswerViewProps {
  type: string;
  content: unknown;
  rubric?: { anchors?: RubricAnchorForReview[] } | null;
}

const KEY_TEXT_STYLE: React.CSSProperties = {
  margin: 0,
  fontFamily: "var(--aiq-font-sans)",
  fontSize: "var(--aiq-text-sm)",
  lineHeight: 1.6,
  whiteSpace: "pre-wrap",
  color: "var(--aiq-color-fg-primary)",
};

const MUTED_NOTE_STYLE: React.CSSProperties = {
  margin: 0,
  fontFamily: "var(--aiq-font-sans)",
  fontSize: "var(--aiq-text-sm)",
  fontStyle: "italic",
  color: "var(--aiq-color-fg-muted)",
  lineHeight: 1.5,
};

// ── rubric anchors (the grading ground-truth) ─────────────────────────────────

function RubricBlock({ anchors, heading }: { anchors: RubricAnchorForReview[]; heading: string }): React.ReactElement {
  const total = anchors.reduce((s, a) => s + (Number.isFinite(a.weight) ? a.weight : 0), 0);
  return (
    <div>
      <div style={SUBLABEL_STYLE}>{heading}{total > 0 ? ` · ${total} pts total` : ""}</div>
      <ul style={{ margin: 0, paddingLeft: "var(--aiq-space-lg)", display: "flex", flexDirection: "column", gap: "var(--aiq-space-2xs)" }}>
        {anchors.map((a) => (
          <li key={a.id} style={{ fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-sm)", lineHeight: 1.5, color: "var(--aiq-color-fg-primary)" }}>
            <span>{cleanText(a.concept)}</span>
            <span style={{ fontFamily: "var(--aiq-font-mono)", fontSize: "var(--aiq-text-xs)", color: "var(--aiq-color-fg-muted)", marginLeft: "var(--aiq-space-xs)" }}>
              ({a.weight} pts)
            </span>
            {a.synonyms && a.synonyms.length > 0 && (
              <span style={{ fontSize: "var(--aiq-text-xs)", color: "var(--aiq-color-fg-muted)", marginLeft: "var(--aiq-space-xs)" }}>
                — also: {a.synonyms.join(", ")}
              </span>
            )}
            {/* A3: self-certifying review aids — give a non-expert reviewer a
                concrete source + reason to LOOK UP, not a guarantee. The model
                that wrote the anchor also wrote these, so they are NOT
                independent verification (adversarial review vector 4): labelled
                "AI-suggested · unverified" so they read as a starting point for
                checking, never as authority. Honest-claim boundary per the
                no-expert accuracy model. Rendered only when present. */}
            {(a.citation || a.rationale) && (
              <div style={{ marginTop: "var(--aiq-space-2xs)", paddingLeft: "var(--aiq-space-sm)", borderLeft: "2px solid var(--aiq-color-border)", display: "flex", flexDirection: "column", gap: "2px" }}>
                <span style={{ fontFamily: "var(--aiq-font-mono)", fontSize: "var(--aiq-text-xs)", textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--aiq-color-fg-muted)", opacity: 0.8 }}>
                  AI-suggested · unverified
                </span>
                {a.rationale && (
                  <span style={{ fontSize: "var(--aiq-text-xs)", color: "var(--aiq-color-fg-secondary)", lineHeight: 1.4 }}>
                    {cleanText(a.rationale)}
                  </span>
                )}
                {a.citation && (
                  <span style={{ fontFamily: "var(--aiq-font-mono)", fontSize: "var(--aiq-text-xs)", color: "var(--aiq-color-fg-muted)" }}>
                    Source: {cleanText(a.citation)}
                  </span>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function anchorsOf(rubric: ExpectedAnswerViewProps["rubric"]): RubricAnchorForReview[] {
  return Array.isArray(rubric?.anchors) ? rubric!.anchors! : [];
}

// ── per-type expected renderers ───────────────────────────────────────────────

function McqExpected({ c }: { c: Record<string, unknown> }): React.ReactElement {
  const options = safeArr<unknown>(c.options);
  const correct = typeof c.correct === "number" ? c.correct : null;
  const rationale = safeStr(c.rationale);
  const optText = correct != null && options && typeof options[correct] === "string" ? (options[correct] as string) : null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-md)" }}>
      <div>
        <div style={SUBLABEL_STYLE}>Correct answer</div>
        {correct != null ? (
          <p style={KEY_TEXT_STYLE}>
            <span style={{ fontFamily: "var(--aiq-font-mono)", fontWeight: 700, marginRight: "var(--aiq-space-sm)", color: "var(--aiq-color-success, #065f46)" }}>
              {OPTION_LABELS[correct] ?? correct} ✓
            </span>
            {optText != null ? cleanText(optText) : ""}
          </p>
        ) : (
          <p style={MUTED_NOTE_STYLE}>No correct option recorded.</p>
        )}
      </div>
      {rationale != null && (
        <div>
          <div style={SUBLABEL_STYLE}>Rationale</div>
          <p style={KEY_TEXT_STYLE}>{cleanText(rationale)}</p>
        </div>
      )}
    </div>
  );
}

function KqlExpected({ c, anchors }: { c: Record<string, unknown>; anchors: RubricAnchorForReview[] }): React.ReactElement {
  const keywords = safeArr<unknown>(c.expected_keywords);
  const hasKeywords = keywords != null && keywords.length > 0;
  if (!hasKeywords && anchors.length === 0) return <EmptyExpected />;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-md)" }}>
      {hasKeywords && (
        <div>
          <div style={SUBLABEL_STYLE}>Expected keywords</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--aiq-space-xs)" }}>
            {keywords!.map((k, i) => (
              <span
                key={i}
                style={{
                  display: "inline-block",
                  padding: "2px 8px",
                  borderRadius: 4,
                  background: "var(--aiq-color-bg-secondary, #f0f0f0)",
                  fontFamily: "var(--aiq-font-mono)",
                  fontSize: "var(--aiq-text-xs)",
                  color: "var(--aiq-color-fg-primary)",
                  border: "1px solid var(--aiq-color-border, #e5e7eb)",
                }}
              >
                {typeof k === "string" ? k : JSON.stringify(k)}
              </span>
            ))}
          </div>
        </div>
      )}
      {anchors.length > 0 && <RubricBlock anchors={anchors} heading="Rubric (grading basis)" />}
    </div>
  );
}

function ScenarioExpected({ c, anchors }: { c: Record<string, unknown>; anchors: RubricAnchorForReview[] }): React.ReactElement {
  const steps = safeArr<unknown>(c.steps);
  const expectedRows = (steps ?? [])
    .map((step, i) => {
      const s = obj(step);
      return { idx: i, expected: s ? safeStr(s.expected) : null };
    })
    .filter((r) => r.expected != null);
  if (expectedRows.length === 0 && anchors.length === 0) return <EmptyExpected />;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-md)" }}>
      {expectedRows.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-sm)" }}>
          {expectedRows.map((r) => (
            <div key={r.idx}>
              <div style={SUBLABEL_STYLE}>Step {r.idx + 1} — expected</div>
              <p style={KEY_TEXT_STYLE}>{cleanText(r.expected!)}</p>
            </div>
          ))}
        </div>
      )}
      {anchors.length > 0 && <RubricBlock anchors={anchors} heading="Rubric (grading basis)" />}
    </div>
  );
}

function LogAnalysisExpected({ c, anchors }: { c: Record<string, unknown>; anchors: RubricAnchorForReview[] }): React.ReactElement {
  const findings = safeArr<unknown>(c.expected_findings);
  const sampleSolution = safeStr(c.sample_solution);
  const hasFindings = findings != null && findings.length > 0;
  if (!hasFindings && sampleSolution == null && anchors.length === 0) return <EmptyExpected />;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-md)" }}>
      {hasFindings && (
        <div>
          <div style={SUBLABEL_STYLE}>Expected findings</div>
          <ol style={{ margin: 0, paddingLeft: "var(--aiq-space-xl)", display: "flex", flexDirection: "column", gap: "var(--aiq-space-2xs)" }}>
            {findings!.map((f, i) => (
              <li key={i} style={{ fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-sm)", lineHeight: 1.5, whiteSpace: "pre-wrap" }}>
                {typeof f === "string" ? cleanText(f) : JSON.stringify(f)}
              </li>
            ))}
          </ol>
        </div>
      )}
      {sampleSolution != null && (
        <div>
          <div style={SUBLABEL_STYLE}>Sample solution</div>
          <p style={KEY_TEXT_STYLE}>{cleanText(sampleSolution)}</p>
        </div>
      )}
      {anchors.length > 0 && <RubricBlock anchors={anchors} heading="Rubric (grading basis)" />}
    </div>
  );
}

function EmptyExpected(): React.ReactElement {
  return (
    <p style={MUTED_NOTE_STYLE}>
      No authored answer key or rubric anchors for this question — it was graded holistically on the reasoning band.
    </p>
  );
}

export function ExpectedAnswerView({ type, content, rubric }: ExpectedAnswerViewProps): React.ReactElement {
  const anchors = anchorsOf(rubric);
  const c = obj(content);

  switch (type) {
    case "mcq":
      return c ? <McqExpected c={c} /> : <JsonFallback value={content} />;
    case "subjective":
      // Subjective has no answer-key fields in content — the rubric IS the
      // expected answer.
      return anchors.length > 0 ? <RubricBlock anchors={anchors} heading="Key points we grade for" /> : <EmptyExpected />;
    case "kql":
      return c ? <KqlExpected c={c} anchors={anchors} /> : (anchors.length > 0 ? <RubricBlock anchors={anchors} heading="Rubric (grading basis)" /> : <EmptyExpected />);
    case "scenario":
      return c ? <ScenarioExpected c={c} anchors={anchors} /> : (anchors.length > 0 ? <RubricBlock anchors={anchors} heading="Rubric (grading basis)" /> : <EmptyExpected />);
    case "log_analysis":
      return c ? <LogAnalysisExpected c={c} anchors={anchors} /> : (anchors.length > 0 ? <RubricBlock anchors={anchors} heading="Rubric (grading basis)" /> : <EmptyExpected />);
    default:
      return anchors.length > 0 ? <RubricBlock anchors={anchors} heading="Rubric (grading basis)" /> : <EmptyExpected />;
  }
}

ExpectedAnswerView.displayName = "ExpectedAnswerView";
