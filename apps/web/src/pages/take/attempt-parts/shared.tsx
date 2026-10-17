import { type CSSProperties } from "react";
import { Card } from "@assessiq/ui-system";
import type { CandidateAttemptViewWire } from "@assessiq/candidate-ui";
import { type QuestionType } from "@assessiq/question-types";

/** Content field that holds the on-screen stem: title for the multi-part types, question for the rest. */
export const STEM_FIELD = {
  mcq: 'question',
  subjective: 'question',
  kql: 'question',
  scenario: 'title',
  log_analysis: 'question',
  numeric: 'question',
  multi_select: 'question',
  ordering: 'question',
  structured_case: 'title',
} satisfies Record<QuestionType, 'title' | 'question'>;

// ─── Types ───────────────────────────────────────────────────────────────────

export type PageState =
  | { tag: 'loading' }
  | { tag: 'auth_error' }           // 401 / 403 / 404 → redirect
  | { tag: 'network_error' }        // 5xx / fetch failure → IntegrityBanner
  | { tag: 'ready'; view: CandidateAttemptViewWire };

// ─── Canonical content types (Stage 1.5d shape lock) ──────────────────────────
//
// Field names are locked to the sharded-generation output.
// Any question whose content contains a FORBIDDEN SYNONYM key must render
// <MalformedQuestion> — no partial render of legacy DB rows.
const FORBIDDEN_SYNONYM_KEYS: ReadonlySet<string> = new Set([
  'stem', 'explanation', 'log_snippet', 'answer_key', 'task', 'correct_answer',
]);

export function hasForbiddenSynonym(content: unknown): boolean {
  if (typeof content !== 'object' || content === null) return false;
  return Object.keys(content as object).some((k) => FORBIDDEN_SYNONYM_KEYS.has(k));
}


// ─── Style constants ─────────────────────────────────────────────────────────

export const TOP_BAR: CSSProperties = {
  position: 'sticky',
  top: 0,
  zIndex: 5,
  display: 'flex',
  alignItems: 'center',
  gap: 'var(--aiq-space-md)',
  // height + padding moved to .aiq-attempt-top class — viewport-aware (M2a).
  borderBottom: '1px solid var(--aiq-color-border)',
  background: 'var(--aiq-color-bg-base)',
  flexShrink: 0,
};

export const BOTTOM_BAR: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  // height + padding moved to .aiq-attempt-bottom class — viewport-aware (M2a).
  borderTop: '1px solid var(--aiq-color-border)',
  background: 'var(--aiq-color-bg-base)',
  flexShrink: 0,
  gap: 'var(--aiq-space-sm)',
};

export const QUESTION_TEXT: CSSProperties = {
  fontFamily: 'var(--aiq-font-serif)',
  // font-size moved to .aiq-attempt-q-text class — viewport-aware (M2a).
  // Desktop 30px (var(--aiq-text-2xl)) / mobile 22px via the scoped
  // --aiq-attempt-q-size CSS var defined on .aiq-attempt-shell.
  fontWeight: 400,
  lineHeight: 1.5,
  color: 'var(--aiq-color-fg-primary)',
  margin: '0 0 var(--aiq-space-xl)',
};

export const COUNTER_LABEL: CSSProperties = {
  fontFamily: 'var(--aiq-font-mono)',
  fontSize: 12,
  color: 'var(--aiq-color-fg-muted)',
  whiteSpace: 'nowrap',
};


/** Shown when question content contains a forbidden synonym key (Stage 1.5d shape lock). */
export function MalformedQuestion(): React.JSX.Element {
  return (
    <Card padding="md">
      <p
        style={{
          fontFamily: 'var(--aiq-font-sans)',
          fontSize: 'var(--aiq-text-lg)',
          color: 'var(--aiq-color-fg-secondary)',
          margin: 0,
          lineHeight: 1.5,
        }}
      >
        This question content is malformed — contact your administrator.
      </p>
    </Card>
  );
}

/** Shown for any type string not in the known set (future-proofing). */
export function UnknownTypeArea({ type }: { type: string }): React.JSX.Element {
  return (
    <Card padding="md">
      <p
        style={{
          fontFamily: 'var(--aiq-font-sans)',
          fontSize: 'var(--aiq-text-lg)',
          color: 'var(--aiq-color-fg-secondary)',
          margin: 0,
          lineHeight: 1.5,
        }}
      >
        Unsupported question type: {type}
      </p>
    </Card>
  );
}


// ─── Main component ───────────────────────────────────────────────────────────

/**
 * Single "is this question answered?" predicate, shared by the navigator status
 * and the submit-confirmation count. null / undefined / '' / [] / {selected:null}
 * (an object whose every value is empty) are unanswered; 0 and false are answers.
 */
export function isAnsweredValue(ans: unknown): boolean {
  const empty = (v: unknown): boolean =>
    v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0);
  if (empty(ans)) return false;
  if (typeof ans === 'object' && !Array.isArray(ans)) {
    // structured_case: { steps: { [stepId]: number[] } } is answered iff some step has a pick.
    const st = (ans as { steps?: unknown }).steps;
    if (st !== null && typeof st === 'object' && !Array.isArray(st)) return Object.values(st as object).some((v) => !empty(v));
    const vals = Object.values(ans as Record<string, unknown>);
    return vals.some((v) => !empty(v));
  }
  return true;
}


/** Visually hidden but readable by screen readers (axe page-has-heading-one). */
export const SR_ONLY: React.CSSProperties = {
  position: 'absolute', width: 1, height: 1, margin: -1, padding: 0,
  overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap', border: 0,
};
