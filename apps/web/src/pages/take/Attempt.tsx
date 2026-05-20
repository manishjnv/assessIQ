// Candidate attempt-taking page — Phase 1 G1.D
//
// Route: /take/attempt/:id  (registered in App.tsx by Opus)
//
// What this page does:
//   1. Fetch the attempt view on mount; render a loading screen while in flight.
//   2. On 401/403/404 → <Navigate to="/take/error" replace />.
//      On 5xx/network → IntegrityBanner stale_connection + Reload action.
//   3. On success → full attempt-taking surface (top bar, main pane, side panel,
//      bottom bar per the CSS-Grid layout in CONTRACT §LAYOUT).
//   4. Wire useAutosave: every answer change calls queueSave; blur calls flushSave.
//   5. Submit → submitAttempt → clearBackup → navigate to /take/attempt/:id/submitted.
//
// Anti-patterns explicitly refused (see contract):
//   - No dangerouslySetInnerHTML on question content.
//   - No localStorage for candidate session.
//   - No attempt_events rendered to the candidate.
//   - No --aiq-color-bg-elevated (renamed --aiq-color-bg-raised).
//   - No import from **/AssessIQ_UI_Template/** (ESLint forbids).
//   - No Monaco / KQL editor (Phase 2 deferred, decision #11).

import {
  useState,
  useEffect,
  useCallback,
  useRef,
  type CSSProperties,
} from 'react';
import { useParams, useNavigate, Navigate } from 'react-router-dom';
import { Button, Card, Chip, Drawer, Icon, Logo, Spinner } from '@assessiq/ui-system';
import {
  AttemptTimer,
  AutosaveIndicator,
  IntegrityBanner,
  QuestionNavigator,
  useAutosave,
  useIntegrityHooks,
  useMultiTabWarning,
  getAttempt,
  submitAttempt,
  toggleFlag,
  clearBackup,
  readBackup,
  CandidateApiError,
} from '@assessiq/candidate-ui';
import type {
  CandidateAttemptViewWire,
  FrozenQuestionWire,
  AttemptAnswerWire,
} from '@assessiq/candidate-ui';
import { CandidateHelp } from '@assessiq/candidate-ui';

// ─── Types ───────────────────────────────────────────────────────────────────

type PageState =
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

function hasForbiddenSynonym(content: unknown): boolean {
  if (typeof content !== 'object' || content === null) return false;
  return Object.keys(content as object).some((k) => FORBIDDEN_SYNONYM_KEYS.has(k));
}

// mcq: { question, options: string[], correct: number, rationale? }
interface McqContent {
  question: string;
  options: string[];   // 4 option texts, indexed 0–3
  correct: number;     // not rendered to candidate
  rationale?: string;  // not rendered to candidate
}

// log_analysis: { question, log_format?, log_excerpt, expected_findings?, sample_solution?, hint? }
interface LogAnalysisContent {
  question: string;
  log_format?: string;
  log_excerpt: string;
  expected_findings?: string[];
  sample_solution?: string;
  hint?: string;
}

// scenario: { title, intro, step_dependency?, steps[{ prompt, expected? }] }
interface ScenarioStep {
  prompt: string;
  expected?: string; // not rendered to candidate
}
interface ScenarioContent {
  title: string;
  intro: string;
  step_dependency?: 'linear' | 'dag';
  steps: ScenarioStep[];
}

// kql: { question, tables?, expected_keywords?, sample_solution? }
interface KqlContent {
  question: string;
  tables?: string[];
  expected_keywords?: string[];
  sample_solution?: string; // not rendered to candidate
}

// subjective: { question }
interface SubjectiveContent {
  question: string;
}

// ─── Style constants ─────────────────────────────────────────────────────────

const TOP_BAR: CSSProperties = {
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

const BOTTOM_BAR: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  // height + padding moved to .aiq-attempt-bottom class — viewport-aware (M2a).
  borderTop: '1px solid var(--aiq-color-border)',
  background: 'var(--aiq-color-bg-base)',
  flexShrink: 0,
  gap: 'var(--aiq-space-sm)',
};

const QUESTION_TEXT: CSSProperties = {
  fontFamily: 'var(--aiq-font-serif)',
  // font-size moved to .aiq-attempt-q-text class — viewport-aware (M2a).
  // Desktop 30px (var(--aiq-text-2xl)) / mobile 22px via the scoped
  // --aiq-attempt-q-size CSS var defined on .aiq-attempt-shell.
  fontWeight: 400,
  lineHeight: 1.5,
  color: 'var(--aiq-color-fg-primary)',
  margin: '0 0 var(--aiq-space-xl)',
};

const COUNTER_LABEL: CSSProperties = {
  fontFamily: 'var(--aiq-font-mono)',
  fontSize: 12,
  color: 'var(--aiq-color-fg-muted)',
  whiteSpace: 'nowrap',
};

// ─── Answer area sub-components ───────────────────────────────────────────────

function McqAnswerArea({
  question,
  answer,
  disabled,
  onAnswerChange,
}: {
  question: FrozenQuestionWire;
  answer: unknown;
  disabled: boolean;
  onAnswerChange: (value: unknown) => void;
}): JSX.Element {
  const content = question.content as McqContent;
  const options: string[] = Array.isArray(content?.options) ? (content.options as string[]) : [];
  // Canonical answer shape: { selected: number } — index into options[].
  const answerObj =
    answer !== null && typeof answer === 'object'
      ? (answer as { selected?: unknown })
      : null;
  const selected: number | null =
    typeof answerObj?.selected === 'number' ? answerObj.selected : null;

  return (
    <div role="radiogroup" aria-label="Answer options" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--aiq-space-sm)' }}>
      {options.map((text, idx) => {
        const isSelected = selected === idx;
        const letter = String.fromCharCode(65 + idx); // A, B, C, D
        return (
          <label
            key={idx}
            style={{ display: 'block', cursor: disabled ? 'not-allowed' : 'pointer' }}
          >
            <input
              type="radio"
              name={question.question_id}
              value={String(idx)}
              checked={isSelected}
              disabled={disabled}
              onChange={() => onAnswerChange({ selected: idx })}
              style={{ position: 'absolute', opacity: 0, width: 0, height: 0 }}
            />
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 'var(--aiq-space-md)',
                padding: 'var(--aiq-space-md) var(--aiq-space-lg)',
                background: isSelected ? 'var(--aiq-color-accent-soft)' : 'var(--aiq-color-bg-base)',
                border: isSelected
                  ? '1px solid var(--aiq-color-accent)'
                  : '1px solid var(--aiq-color-border)',
                borderRadius: 'var(--aiq-radius-md)',
                cursor: disabled ? 'not-allowed' : 'pointer',
                transition: 'border-color 150ms ease, background 150ms ease',
                userSelect: 'none',
              }}
            >
              {/* Radio circle */}
              <span
                style={{
                  width: 22,
                  height: 22,
                  borderRadius: '50%',
                  border: `1.5px solid ${isSelected ? 'var(--aiq-color-accent)' : 'var(--aiq-color-border-strong)'}`,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0,
                  transition: 'border-color 150ms ease',
                }}
              >
                {isSelected && (
                  <span
                    style={{
                      width: 10,
                      height: 10,
                      borderRadius: '50%',
                      background: 'var(--aiq-color-accent)',
                    }}
                  />
                )}
              </span>
              {/* Letter label */}
              <span
                style={{
                  fontFamily: 'var(--aiq-font-mono)',
                  fontSize: 11,
                  color: 'var(--aiq-color-fg-muted)',
                  width: 14,
                  flexShrink: 0,
                }}
              >
                {letter}
              </span>
              {/* Option text */}
              <span
                style={{
                  fontFamily: 'var(--aiq-font-sans)',
                  fontSize: 15,
                  color: 'var(--aiq-color-fg-primary)',
                  lineHeight: 1.5,
                  flex: 1,
                }}
              >
                {text}
              </span>
            </div>
          </label>
        );
      })}
    </div>
  );
}

function countWords(text: string): number {
  const trimmed = text.trim();
  if (trimmed === '') return 0;
  return trimmed.split(/\s+/).length;
}

function SubjectiveAnswerArea({
  answer,
  disabled,
  onAnswerChange,
  onBlur,
}: {
  answer: unknown;
  disabled: boolean;
  onAnswerChange: (value: unknown) => void;
  onBlur: () => void;
}): JSX.Element {
  // Canonical answer shape: { response: string }
  const answerObj =
    answer !== null && typeof answer === 'object'
      ? (answer as { response?: unknown })
      : null;
  const text = typeof answerObj?.response === 'string' ? answerObj.response : '';
  const wordCount = countWords(text);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--aiq-space-xs)' }}>
      <textarea
        value={text}
        disabled={disabled}
        onChange={(e) => onAnswerChange({ response: e.target.value })}
        onBlur={onBlur}
        aria-label="Your answer"
        style={{
          width: '100%',
          minHeight: 200,
          padding: 'var(--aiq-space-md)',
          fontFamily: 'var(--aiq-font-sans)',
          // M2b: 15px desktop / 16px mobile via .aiq-attempt-shell CSS var.
          // 16px on mobile defeats iOS Safari's auto-zoom-on-focus.
          fontSize: 'var(--aiq-answer-input-size)',
          lineHeight: 1.6,
          color: 'var(--aiq-color-fg-primary)',
          background: disabled ? 'var(--aiq-color-bg-raised)' : 'var(--aiq-color-bg-base)',
          border: '1px solid var(--aiq-color-border)',
          borderRadius: 'var(--aiq-radius-md)',
          resize: 'vertical',
          boxSizing: 'border-box',
          outline: 'none',
        }}
      />
      <div
        data-help-id="candidate.attempt.subjective.length"
        style={{
          fontFamily: 'var(--aiq-font-mono)',
          fontSize: 11,
          color: 'var(--aiq-color-fg-muted)',
          textAlign: 'right',
        }}
      >
        {wordCount} words
      </div>
    </div>
  );
}

function KqlAnswerArea({
  question,
  answer,
  disabled,
  onAnswerChange,
  onBlur,
}: {
  question: FrozenQuestionWire;
  answer: unknown;
  disabled: boolean;
  onAnswerChange: (value: unknown) => void;
  onBlur: () => void;
}): JSX.Element {
  // TODO(phase-2): Monaco-based <KqlEditor> with KQL grammar — Phase 2 deferred
  // (decision #11 in PHASE_1_KICKOFF.md). Phase 1 uses a textarea.
  const content = question.content as KqlContent;
  const tables: string[] = Array.isArray(content?.tables) ? (content.tables as string[]) : [];
  // Canonical answer shape: { query: string }
  const answerObj =
    answer !== null && typeof answer === 'object'
      ? (answer as { query?: unknown })
      : null;
  const text = typeof answerObj?.query === 'string' ? answerObj.query : '';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--aiq-space-sm)' }}>
      {/* M2b — KQL caveat tip. Mobile-only via .aiq-attempt-kql-mobile-tip
          CSS rule (display:none desktop, display:block mobile). Same DOM
          both viewports; CSS toggles visibility. Content + help_id are
          surface-only — no grading or autosave semantics affected. */}
      <p
        className="aiq-attempt-kql-mobile-tip"
        data-help-id="candidate.attempt.kql.mobile_tip"
        style={{
          margin: 0,
          padding: 'var(--aiq-space-sm) var(--aiq-space-md)',
          fontFamily: 'var(--aiq-font-sans)',
          fontSize: 13,
          lineHeight: 1.5,
          color: 'var(--aiq-color-fg-secondary)',
          background: 'var(--aiq-color-bg-raised)',
          border: '1px solid var(--aiq-color-border)',
          borderRadius: 'var(--aiq-radius-sm)',
        }}
      >
        Tip: KQL is easier on a desktop browser. You can answer here, but consider switching for syntax-heavy queries.
      </p>
      {tables.length > 0 && (
        <div
          style={{
            fontFamily: 'var(--aiq-font-mono)',
            fontSize: 12,
            color: 'var(--aiq-color-fg-muted)',
            padding: 'var(--aiq-space-xs) var(--aiq-space-sm)',
            background: 'var(--aiq-color-bg-raised)',
            borderRadius: 'var(--aiq-radius-sm)',
          }}
        >
          Tables: {tables.join(', ')}
        </div>
      )}
      <textarea
        value={text}
        disabled={disabled}
        onChange={(e) => onAnswerChange({ query: e.target.value })}
        onBlur={onBlur}
        aria-label="KQL query"
        data-help-id="candidate.attempt.kql.editor"
        style={{
          width: '100%',
          minHeight: 200,
          padding: 'var(--aiq-space-md)',
          fontFamily: 'var(--aiq-font-mono)',
          // M2b: 13px mono desktop / 16px mono mobile via .aiq-attempt-shell CSS var.
          fontSize: 'var(--aiq-answer-mono-size)',
          lineHeight: 1.6,
          color: 'var(--aiq-color-fg-primary)',
          background: disabled ? 'var(--aiq-color-bg-raised)' : 'var(--aiq-color-bg-base)',
          border: '1px solid var(--aiq-color-border)',
          borderRadius: 'var(--aiq-radius-md)',
          resize: 'vertical',
          boxSizing: 'border-box',
          outline: 'none',
        }}
      />
    </div>
  );
}

/** Shown when question content contains a forbidden synonym key (Stage 1.5d shape lock). */
function MalformedQuestion(): JSX.Element {
  return (
    <Card padding="md">
      <p
        style={{
          fontFamily: 'var(--aiq-font-sans)',
          fontSize: 15,
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
function UnknownTypeArea({ type }: { type: string }): JSX.Element {
  return (
    <Card padding="md">
      <p
        style={{
          fontFamily: 'var(--aiq-font-sans)',
          fontSize: 15,
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

function LogAnalysisAnswerArea({
  question,
  answer,
  disabled,
  onAnswerChange,
  onBlur,
}: {
  question: FrozenQuestionWire;
  answer: unknown;
  disabled: boolean;
  onAnswerChange: (value: unknown) => void;
  onBlur: () => void;
}): JSX.Element {
  const content = question.content as LogAnalysisContent;
  const logExcerpt = typeof content?.log_excerpt === 'string' ? content.log_excerpt : '';
  const logFormat = typeof content?.log_format === 'string' ? content.log_format : '';
  const hint = typeof content?.hint === 'string' ? content.hint : '';

  // Canonical answer shape: { findings: string[], explanation: string }
  const answerObj =
    answer !== null && typeof answer === 'object'
      ? (answer as { findings?: unknown; explanation?: unknown })
      : null;
  const findingsRaw = Array.isArray(answerObj?.findings)
    ? (answerObj.findings as unknown[])
    : [];
  const findings: string[] = findingsRaw.map((f) =>
    typeof f === 'string' ? f : '',
  );
  const displayFindings = findings.length > 0 ? findings : [''];
  const explanation =
    typeof answerObj?.explanation === 'string' ? answerObj.explanation : '';

  function emitAnswer(nextFindings: string[], nextExplanation: string): void {
    onAnswerChange({ findings: nextFindings, explanation: nextExplanation });
  }
  function updateFinding(idx: number, val: string): void {
    const next = [...displayFindings];
    next[idx] = val;
    emitAnswer(next, explanation);
  }
  function addFinding(): void {
    emitAnswer([...displayFindings, ''], explanation);
  }
  function removeFinding(idx: number): void {
    const next = displayFindings.filter((_, i) => i !== idx);
    emitAnswer(next.length > 0 ? next : [''], explanation);
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--aiq-space-lg)' }}>
      {logExcerpt && (
        <div>
          {logFormat && (
            <div
              style={{
                fontFamily: 'var(--aiq-font-mono)',
                fontSize: 11,
                color: 'var(--aiq-color-fg-muted)',
                marginBottom: 'var(--aiq-space-2xs)',
                textTransform: 'uppercase',
                letterSpacing: '0.06em',
              }}
            >
              {logFormat}
            </div>
          )}
          <pre
            style={{
              fontFamily: 'var(--aiq-font-mono)',
              fontSize: 12,
              lineHeight: 1.6,
              color: 'var(--aiq-color-fg-primary)',
              background: 'var(--aiq-color-bg-raised)',
              border: '1px solid var(--aiq-color-border)',
              borderRadius: 'var(--aiq-radius-md)',
              padding: 'var(--aiq-space-md)',
              overflowX: 'auto',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-all',
              margin: 0,
            }}
          >
            {logExcerpt}
          </pre>
        </div>
      )}
      {hint && (
        <p
          style={{
            fontFamily: 'var(--aiq-font-sans)',
            fontSize: 14,
            color: 'var(--aiq-color-fg-secondary)',
            margin: 0,
            fontStyle: 'italic',
          }}
        >
          Hint: {hint}
        </p>
      )}
      {/* Findings list */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--aiq-space-xs)' }}>
        <div
          style={{
            fontFamily: 'var(--aiq-font-sans)',
            fontSize: 13,
            fontWeight: 600,
            color: 'var(--aiq-color-fg-primary)',
          }}
        >
          Suspicious findings
        </div>
        <div
          style={{
            fontFamily: 'var(--aiq-font-sans)',
            fontSize: 12,
            color: 'var(--aiq-color-fg-muted)',
            marginBottom: 'var(--aiq-space-2xs)',
          }}
        >
          List each suspicious finding. Cite the specific log field or value.
        </div>
        {displayFindings.map((finding, idx) => (
          <div
            key={idx}
            style={{ display: 'flex', gap: 'var(--aiq-space-xs)', alignItems: 'center' }}
          >
            <input
              type="text"
              value={finding}
              disabled={disabled}
              onChange={(e) => updateFinding(idx, e.target.value)}
              onBlur={onBlur}
              aria-label={`Finding ${idx + 1}`}
              placeholder={`Finding ${idx + 1}`}
              style={{
                flex: 1,
                padding: 'var(--aiq-space-sm) var(--aiq-space-md)',
                fontFamily: 'var(--aiq-font-sans)',
                // M2b: 14px desktop bumps to 15px desktop / 16px mobile via the
                // .aiq-attempt-shell CSS var. Mobile 16px defeats iOS auto-zoom.
                fontSize: 'var(--aiq-answer-input-size)',
                color: 'var(--aiq-color-fg-primary)',
                background: disabled ? 'var(--aiq-color-bg-raised)' : 'var(--aiq-color-bg-base)',
                border: '1px solid var(--aiq-color-border)',
                borderRadius: 'var(--aiq-radius-md)',
                boxSizing: 'border-box',
                outline: 'none',
              }}
            />
            {!disabled && displayFindings.length > 1 && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => removeFinding(idx)}
                aria-label={`Remove finding ${idx + 1}`}
              >
                ×
              </Button>
            )}
          </div>
        ))}
        {!disabled && (
          <Button
            variant="ghost"
            size="sm"
            onClick={addFinding}
            style={{ alignSelf: 'flex-start' }}
          >
            + Add finding
          </Button>
        )}
      </div>
      {/* Explanation */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--aiq-space-xs)' }}>
        <div
          style={{
            fontFamily: 'var(--aiq-font-sans)',
            fontSize: 13,
            fontWeight: 600,
            color: 'var(--aiq-color-fg-primary)',
          }}
        >
          Explanation
        </div>
        <div
          style={{
            fontFamily: 'var(--aiq-font-sans)',
            fontSize: 12,
            color: 'var(--aiq-color-fg-muted)',
            marginBottom: 'var(--aiq-space-2xs)',
          }}
        >
          Explain your reasoning. Describe what the findings indicate.
        </div>
        <textarea
          value={explanation}
          disabled={disabled}
          onChange={(e) => emitAnswer(displayFindings, e.target.value)}
          onBlur={onBlur}
          aria-label="Explanation"
          style={{
            width: '100%',
            minHeight: 120,
            padding: 'var(--aiq-space-md)',
            fontFamily: 'var(--aiq-font-sans)',
            // M2b: 15px desktop / 16px mobile via the .aiq-attempt-shell CSS var.
            fontSize: 'var(--aiq-answer-input-size)',
            lineHeight: 1.6,
            color: 'var(--aiq-color-fg-primary)',
            background: disabled ? 'var(--aiq-color-bg-raised)' : 'var(--aiq-color-bg-base)',
            border: '1px solid var(--aiq-color-border)',
            borderRadius: 'var(--aiq-radius-md)',
            resize: 'vertical',
            boxSizing: 'border-box',
            outline: 'none',
          }}
        />
      </div>
    </div>
  );
}

function ScenarioAnswerArea({
  question,
  answer,
  disabled,
  onAnswerChange,
  onBlur,
}: {
  question: FrozenQuestionWire;
  answer: unknown;
  disabled: boolean;
  onAnswerChange: (value: unknown) => void;
  onBlur: () => void;
}): JSX.Element {
  const content = question.content as ScenarioContent;
  const intro = typeof content?.intro === 'string' ? content.intro : '';
  const steps: ScenarioStep[] = Array.isArray(content?.steps)
    ? (content.steps as ScenarioStep[])
    : [];

  // Canonical answer shape: { steps: Array<{ stepIndex: number; response: string }> }
  const answerObj =
    answer !== null && typeof answer === 'object'
      ? (answer as { steps?: unknown })
      : null;
  const savedSteps = Array.isArray(answerObj?.steps)
    ? (answerObj.steps as Array<{ stepIndex?: unknown; response?: unknown }>)
    : [];

  function getResponse(stepIndex: number): string {
    const saved = savedSteps.find((s) => s.stepIndex === stepIndex);
    return typeof saved?.response === 'string' ? saved.response : '';
  }

  function updateStep(stepIndex: number, val: string): void {
    const nextSteps = steps.map((_, i) => ({
      stepIndex: i,
      response: i === stepIndex ? val : getResponse(i),
    }));
    onAnswerChange({ steps: nextSteps });
  }

  if (steps.length === 0) {
    return (
      <Card padding="md">
        <p
          style={{
            fontFamily: 'var(--aiq-font-sans)',
            fontSize: 15,
            color: 'var(--aiq-color-fg-secondary)',
            margin: 0,
          }}
        >
          This scenario has no steps — contact your administrator.
        </p>
      </Card>
    );
  }

  return (
    <div data-help-id="candidate.attempt.scenario.steps" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--aiq-space-xl)' }}>
      {intro && (
        <p
          style={{
            fontFamily: 'var(--aiq-font-sans)',
            fontSize: 16,
            lineHeight: 1.6,
            color: 'var(--aiq-color-fg-secondary)',
            margin: 0,
          }}
        >
          {intro}
        </p>
      )}
      {steps.map((step, idx) => (
        <div
          key={idx}
          style={{ display: 'flex', flexDirection: 'column', gap: 'var(--aiq-space-sm)' }}
        >
          <div
            style={{
              fontFamily: 'var(--aiq-font-mono)',
              fontSize: 11,
              fontWeight: 600,
              color: 'var(--aiq-color-fg-muted)',
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
            }}
          >
            Step {idx + 1}
          </div>
          <p
            style={{
              fontFamily: 'var(--aiq-font-serif)',
              fontSize: 17,
              lineHeight: 1.55,
              color: 'var(--aiq-color-fg-primary)',
              margin: 0,
            }}
          >
            {step.prompt}
          </p>
          <textarea
            value={getResponse(idx)}
            disabled={disabled}
            onChange={(e) => updateStep(idx, e.target.value)}
            onBlur={onBlur}
            aria-label={`Step ${idx + 1} response`}
            style={{
              width: '100%',
              minHeight: 100,
              padding: 'var(--aiq-space-md)',
              fontFamily: 'var(--aiq-font-sans)',
              // M2b: 15px desktop / 16px mobile via the .aiq-attempt-shell CSS var.
              fontSize: 'var(--aiq-answer-input-size)',
              lineHeight: 1.6,
              color: 'var(--aiq-color-fg-primary)',
              background: disabled ? 'var(--aiq-color-bg-raised)' : 'var(--aiq-color-bg-base)',
              border: '1px solid var(--aiq-color-border)',
              borderRadius: 'var(--aiq-radius-md)',
              resize: 'vertical',
              boxSizing: 'border-box',
              outline: 'none',
            }}
          />
        </div>
      ))}
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export function AttemptPage(): JSX.Element {
  const { id: attemptId = '' } = useParams<{ id: string }>();
  const navigate = useNavigate();

  // ── Page-level state ──────────────────────────────────────────────────────
  const [pageState, setPageState] = useState<PageState>({ tag: 'loading' });
  const [currentQuestionId, setCurrentQuestionId] = useState<string | null>(null);
  // answers: Map<questionId, unknown> — source of truth for the current UI values.
  // Initialized from server's answers array after fetch; updated locally on every
  // candidate keystroke. The autosave hook writes these to the server + localStorage.
  const [answers, setAnswers] = useState<Map<string, unknown>>(new Map());
  // flags: Map<questionId, boolean>
  const [flags, setFlags] = useState<Map<string, boolean>>(new Map());
  const [locked, setLocked] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  // M2a: drawer open state for the mobile bottom-sheet question navigator.
  // Desktop never opens it (the aside is always visible); mobile toggles via
  // the .aiq-attempt-nav-toggle header button. Closes on item-select.
  const [navOpen, setNavOpen] = useState(false);

  // Stable ref so callbacks can read the latest currentQuestionId without
  // re-creating and breaking memo/effect deps.
  const currentQuestionIdRef = useRef<string | null>(null);
  currentQuestionIdRef.current = currentQuestionId;

  // ── Fetch on mount ────────────────────────────────────────────────────────

  useEffect(() => {
    if (!attemptId) {
      setPageState({ tag: 'auth_error' });
      return;
    }

    void (async () => {
      try {
        const view = await getAttempt(attemptId);

        // Seed local answer + flag maps from server state.
        const answerMap = new Map<string, unknown>();
        const flagMap = new Map<string, boolean>();
        for (const a of view.answers) {
          answerMap.set(a.question_id, a.answer);
          flagMap.set(a.question_id, a.flagged);
        }
        setAnswers(answerMap);
        setFlags(flagMap);

        // If the attempt is already terminal, lock immediately.
        if (view.attempt.status !== 'in_progress') {
          setLocked(true);
        }

        // Set the initial current question (first in position order).
        const sorted = [...view.questions].sort((a, b) => a.position - b.position);
        const first = sorted[0];
        if (first !== undefined && currentQuestionIdRef.current === null) {
          setCurrentQuestionId(first.question_id);
        }

        setPageState({ tag: 'ready', view });

        // LocalStorage backup check. Per contract: Phase 1 does NOT auto-restore
        // (too risky without UX confirmation). Phase 2 will add an explicit prompt.
        // Dev-only console.warn (gated to avoid noise in production where retry
        // storms can produce inflated local revisions vs server — see
        // modules/11-candidate-ui/RESILIENCE.md § Known cosmetic limitations).
        const backup = readBackup(attemptId);
        if (backup !== null && import.meta.env.DEV) {
          const maxServerRevision = view.answers.reduce(
            (max, a: AttemptAnswerWire) => Math.max(max, a.client_revision),
            0,
          );
          if (backup.clientRevision > maxServerRevision) {
            console.warn(
              '[AssessIQ] Local backup revision is newer than server' +
                ` (backup=${backup.clientRevision}, server=${maxServerRevision}).` +
                ' Phase 2 will surface a restore prompt.',
            );
          }
        }
      } catch (err) {
        if (err instanceof CandidateApiError) {
          const s = err.status;
          if (s === 401 || s === 403 || s === 404) {
            setPageState({ tag: 'auth_error' });
          } else {
            setPageState({ tag: 'network_error' });
          }
        } else {
          setPageState({ tag: 'network_error' });
        }
      }
    })();
    // Intentionally runs once on mount — attemptId is stable for the page lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Hooks (always called — args safe when not yet ready) ──────────────────

  const autosave = useAutosave({ attemptId, locked });

  useIntegrityHooks({
    attemptId,
    currentQuestionId,
    enabled: !locked,
  });

  const { multiTabActive } = useMultiTabWarning({ attemptId });

  // ── Timer expiry (stable via useCallback) ─────────────────────────────────

  const handleExpire = useCallback(() => {
    setLocked(true);
    // Server auto-submits past ends_at; a fresh getAttempt will confirm the
    // transition. Redirect to submitted view.
    void getAttempt(attemptId)
      .catch(() => {
        // Even if the re-fetch fails, the server has already auto-submitted.
        // Redirect anyway so the candidate doesn't sit on a locked blank page.
      })
      .finally(() => {
        navigate(`/take/attempt/${attemptId}/submitted`, { replace: true });
      });
  }, [attemptId, navigate]);

  // ── Submit handler ────────────────────────────────────────────────────────

  const handleSubmit = useCallback(async (): Promise<void> => {
    const confirmed = window.confirm(
      'Submit your attempt? You cannot edit answers after this.',
    );
    if (!confirmed) return;

    setSubmitting(true);
    try {
      await submitAttempt(attemptId);
      clearBackup(attemptId);
      navigate(`/take/attempt/${attemptId}/submitted`, { replace: true });
    } catch (err) {
      // Surface submit failures — don't swallow silently.
      setSubmitting(false);
      const msg =
        err instanceof CandidateApiError
          ? err.apiError?.message ?? `HTTP ${err.status}`
          : err instanceof Error
            ? err.message
            : 'Unknown error. Please try again.';
      window.alert(`Submit failed: ${msg}`);
    }
  }, [attemptId, navigate]);

  // ── Locked-redirect effect ────────────────────────────────────────────────
  // When locked becomes true (timer expire or terminal status on fetch), show a
  // 1.5 s notice then redirect.
  const lockedRedirectFired = useRef(false);
  useEffect(() => {
    if (!locked) return;
    if (lockedRedirectFired.current) return;
    lockedRedirectFired.current = true;
    const timer = setTimeout(() => {
      navigate(`/take/attempt/${attemptId}/submitted`, { replace: true });
    }, 1500);
    return () => clearTimeout(timer);
  }, [locked, attemptId, navigate]);

  // ─────────────────────────────────────────────────────────────────────────
  // Render branches
  // ─────────────────────────────────────────────────────────────────────────

  // Loading
  if (pageState.tag === 'loading') {
    return (
      <div
        className="aiq-screen"
        style={{
          minHeight: '100vh',
          display: 'grid',
          placeItems: 'center',
        }}
      >
        <Spinner size="md" />
      </div>
    );
  }

  // Auth error → redirect
  if (pageState.tag === 'auth_error') {
    return <Navigate to="/take/error" replace />;
  }

  // Network / 5xx error
  if (pageState.tag === 'network_error') {
    return (
      <div
        className="aiq-screen"
        style={{
          minHeight: '100vh',
          display: 'grid',
          placeItems: 'center',
          background: 'var(--aiq-color-bg-base)',
          padding: 'var(--aiq-space-2xl)',
        }}
      >
        <div data-help-id="candidate.attempt.disconnect" style={{ maxWidth: 560, width: '100%' }}>
          <IntegrityBanner
            kind="stale_connection"
            action={{
              label: 'Reload',
              onClick: () => window.location.reload(),
            }}
          />
        </div>
      </div>
    );
  }

  // ── Ready — full attempt surface ──────────────────────────────────────────

  const { view } = pageState;
  const { attempt, questions } = view;

  // Sort questions by position (ascending); this is the navigation order.
  const sorted: FrozenQuestionWire[] = [...questions].sort(
    (a, b) => a.position - b.position,
  );

  const currentIdx = currentQuestionId !== null
    ? sorted.findIndex((q) => q.question_id === currentQuestionId)
    : 0;
  const safeIdx = currentIdx < 0 ? 0 : currentIdx;
  const currentQuestion = sorted[safeIdx] ?? null;
  const isFirst = safeIdx === 0;
  const isLast = safeIdx === sorted.length - 1;

  // Derive topic from the first question for the header chip.
  const topicLabel = sorted[0]?.topic ?? '';

  // ── Answer change handler ─────────────────────────────────────────────────
  function handleAnswerChange(value: unknown): void {
    if (!currentQuestion || locked) return;
    const qid = currentQuestion.question_id;
    setAnswers((prev) => {
      const next = new Map(prev);
      next.set(qid, value);
      return next;
    });
    autosave.queueSave(qid, value);
  }

  function handleAnswerBlur(): void {
    if (!currentQuestion || locked) return;
    void autosave.flushSave(currentQuestion.question_id);
  }

  // ── Flag toggle ───────────────────────────────────────────────────────────
  function handleFlagToggle(): void {
    if (!currentQuestion || locked) return;
    const qid = currentQuestion.question_id;
    const currentFlag = flags.get(qid) ?? false;
    const nextFlag = !currentFlag;
    // Optimistic local update
    setFlags((prev) => {
      const next = new Map(prev);
      next.set(qid, nextFlag);
      return next;
    });
    // Fire-and-forget: server is authoritative; local state reflects intent
    toggleFlag(attemptId, qid, nextFlag).catch(() => {
      // Roll back on failure
      setFlags((prev) => {
        const next = new Map(prev);
        next.set(qid, currentFlag);
        return next;
      });
    });
  }

  // ── Navigator items ───────────────────────────────────────────────────────
  const navigatorItems = sorted.map((q) => {
    const qid = q.question_id;
    const isCurrentQ = qid === currentQuestionId;
    const isFlagged = flags.get(qid) ?? false;
    const ans = answers.get(qid);
    const isAnswered = ans !== null && ans !== undefined && ans !== '';

    let status: 'unanswered' | 'answered' | 'flagged' | 'current';
    if (isCurrentQ) {
      status = 'current';
    } else if (isFlagged) {
      status = 'flagged';
    } else if (isAnswered) {
      status = 'answered';
    } else {
      status = 'unanswered';
    }

    return { questionId: qid, position: q.position, status };
  });

  // ── Navigator body (shared between desktop aside and mobile <Drawer>) ─────
  // Same JSX rendered in both surfaces — same items, same onSelect, same per-
  // cell states. The aside is hidden under [data-viewport="mobile"] (M2a CSS
  // in tokens.css); the Drawer mounts lazily only when navOpen is true.
  const navigatorBody = (
    <>
      <QuestionNavigator
        items={navigatorItems}
        onSelect={(qid) => {
          setCurrentQuestionId(qid);
          setNavOpen(false); // close mobile drawer after pick; no-op on desktop
          // Navigator click does NOT flush; debounced autosave handles it.
        }}
      />
      {/* Legend */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--aiq-space-xs)',
          marginTop: 'var(--aiq-space-md)',
          paddingLeft: 'var(--aiq-space-md)',
        }}
      >
        {[
          { color: 'var(--aiq-color-accent)', label: 'Current' },
          { color: 'var(--aiq-color-success-soft)', border: 'var(--aiq-color-success)', label: 'Answered' },
          { color: 'var(--aiq-color-warning-soft)', border: 'var(--aiq-color-warning)', label: 'Flagged' },
          { color: 'var(--aiq-color-bg-base)', border: 'var(--aiq-color-border)', label: 'Unseen' },
        ].map(({ color, border, label }) => (
          <span
            key={label}
            style={{ display: 'flex', alignItems: 'center', gap: 'var(--aiq-space-sm)', fontSize: 11, color: 'var(--aiq-color-fg-secondary)', fontFamily: 'var(--aiq-font-sans)' }}
          >
            <span
              style={{
                width: 10,
                height: 10,
                borderRadius: 3,
                background: color,
                border: border ? `1px solid ${border}` : undefined,
                flexShrink: 0,
              }}
            />
            {label}
          </span>
        ))}
      </div>
    </>
  );

  // ── Locked banner ─────────────────────────────────────────────────────────
  const lockedBanner = locked ? (
    <div
      style={{
        padding: 'var(--aiq-space-sm) var(--aiq-space-2xl)',
        background: 'var(--aiq-color-warning-soft)',
        borderBottom: '1px solid var(--aiq-color-warning)',
        fontFamily: 'var(--aiq-font-sans)',
        fontSize: 14,
        color: 'var(--aiq-color-fg-primary)',
        textAlign: 'center',
      }}
    >
      Attempt is now locked. Redirecting…
    </div>
  ) : null;

  // ── Outer grid ────────────────────────────────────────────────────────────
  return (
    <div
      className="aiq-screen aiq-attempt-shell"
      style={{
        display: 'grid',
        gridTemplateRows: 'auto auto 1fr auto',
        minHeight: '100vh',
        background: 'var(--aiq-color-bg-base)',
      }}
    >
      {/* ── TOP BAR ─────────────────────────────────────────────────────── */}
      <header className="aiq-attempt-top" style={TOP_BAR}>
        <Logo />

        {topicLabel && (
          <Chip variant="default" style={{ flexShrink: 0 }}>
            {topicLabel}
          </Chip>
        )}

        <span style={{ ...COUNTER_LABEL, flex: 1 }}>
          Question {safeIdx + 1} of {sorted.length}
        </span>

        {attempt.ends_at !== null && (
          <AttemptTimer
            endsAt={attempt.ends_at}
            onExpire={handleExpire}
            data-help-id="candidate.attempt.timer"
          />
        )}

        <AutosaveIndicator
          status={autosave.status}
          lastSavedAt={autosave.lastSavedAt}
          retryCount={autosave.retryCount}
        />

        {/* M2a — mobile-only: open the bottom-sheet question navigator.
            Hidden on desktop (the right-side aside is always visible there). */}
        <button
          type="button"
          className="aiq-attempt-nav-toggle"
          onClick={() => setNavOpen(true)}
          aria-label="Open question navigator"
          data-help-id="candidate.attempt.navigator.toggle"
          style={{
            background: 'transparent',
            border: '1px solid var(--aiq-color-border-strong)',
            borderRadius: 'var(--aiq-radius-pill)',
            width: 36,
            height: 36,
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
            padding: 0,
            color: 'var(--aiq-color-fg-primary)',
          }}
        >
          <Icon name="grid" size={14} />
        </button>

        <CandidateHelp />
      </header>

      {/* ── PROGRESS STRIP + LOCK NOTICE ─────────────────────────────── */}
      <div>
        <div style={{ height: 2, background: 'var(--aiq-color-bg-raised)' }}>
          <div
            style={{
              width: `${sorted.length > 0 ? ((safeIdx + 1) / sorted.length) * 100 : 0}%`,
              height: '100%',
              background: 'var(--aiq-color-accent)',
              transition: 'width 300ms ease',
            }}
          />
        </div>
        {lockedBanner}
      </div>

      {/* ── MIDDLE ROW (main pane + side panel) ─────────────────────────── */}
      <div
        className="aiq-attempt-middle"
        style={{
          display: 'grid',
          overflow: 'auto',
        }}
      >
        {/* Main pane */}
        <main style={{ minWidth: 0 }}>
          {/* Multi-tab warning */}
          {multiTabActive && (
            <div style={{ marginBottom: 'var(--aiq-space-md)' }}>
              <IntegrityBanner kind="multi_tab" />
            </div>
          )}

          {currentQuestion !== null ? (
            <>
              {/* Question text — canonical field names per type; no forbidden-synonym reads.
                   For scenario, title is the stem; intro is rendered inside ScenarioAnswerArea.
                   For all others, content.question is the stem.
                   If the content is malformed (forbidden synonym), skip the text; MalformedQuestion
                   is rendered by AnswerArea. */}
              {(() => {
                if (hasForbiddenSynonym(currentQuestion.content)) return null;
                const c = currentQuestion.content as Record<string, unknown>;
                const text =
                  currentQuestion.type === 'scenario'
                    ? (typeof c.title === 'string' ? c.title : null)
                    : (typeof c.question === 'string' ? c.question : null);
                if (text === null) return null;
                return (
                  <p className="aiq-serif aiq-attempt-q-text" style={QUESTION_TEXT}>
                    {text}
                  </p>
                );
              })()}

              {/* Type-switched answer area */}
              <AnswerArea
                question={currentQuestion}
                answer={answers.get(currentQuestion.question_id) ?? null}
                disabled={locked}
                onAnswerChange={handleAnswerChange}
                onBlur={handleAnswerBlur}
              />
            </>
          ) : (
            <p style={{ color: 'var(--aiq-color-fg-muted)', fontFamily: 'var(--aiq-font-sans)' }}>
              No questions available.
            </p>
          )}
        </main>

        {/* Side panel — hidden on mobile via .aiq-attempt-aside CSS rule;
            the same {navigatorBody} also renders inside the Drawer below. */}
        <aside
          className="aiq-attempt-aside"
          style={{
            borderLeft: '1px solid var(--aiq-color-border)',
            paddingLeft: 'var(--aiq-space-md)',
            background: 'var(--aiq-color-bg-raised)',
            paddingTop: 'var(--aiq-space-lg)',
            paddingBottom: 'var(--aiq-space-lg)',
            paddingRight: 'var(--aiq-space-md)',
          }}
        >
          <div
            style={{
              fontFamily: 'var(--aiq-font-mono)',
              fontSize: 11,
              textTransform: 'uppercase',
              letterSpacing: '0.08em',
              color: 'var(--aiq-color-fg-muted)',
              marginBottom: 'var(--aiq-space-sm)',
              paddingLeft: 'var(--aiq-space-md)',
            }}
          >
            Navigator
          </div>
          {navigatorBody}
        </aside>
      </div>

      {/* ── BOTTOM BAR ──────────────────────────────────────────────────── */}
      <footer className="aiq-attempt-bottom" style={BOTTOM_BAR}>
        {/* Flag toggle */}
        <Button
          variant="ghost"
          size="sm"
          className="aiq-attempt-flag-btn"
          onClick={handleFlagToggle}
          disabled={locked || currentQuestion === null}
          data-help-id="candidate.attempt.flag"
          style={{
            color:
              currentQuestion !== null && (flags.get(currentQuestion.question_id) ?? false)
                ? 'var(--aiq-color-warning)'
                : 'var(--aiq-color-fg-secondary)',
          }}
        >
          <Icon name="flag" size={14} style={{ marginRight: 'var(--aiq-space-2xs)' }} />
          {currentQuestion !== null && (flags.get(currentQuestion.question_id) ?? false)
            ? 'Flagged'
            : 'Flag'}
        </Button>

        {/* Spacer — hidden on mobile via .aiq-attempt-spacer CSS rule */}
        <span className="aiq-attempt-spacer" style={{ flex: 1 }} />

        {/* Prev */}
        <Button
          variant="outline"
          size="sm"
          className="aiq-attempt-prev-btn"
          disabled={isFirst || locked}
          onClick={() => {
            const prev = sorted[safeIdx - 1];
            if (prev !== undefined) {
              setCurrentQuestionId(prev.question_id);
            }
          }}
        >
          <Icon name="arrowLeft" size={14} style={{ marginRight: 'var(--aiq-space-2xs)' }} />
          Prev
        </Button>

        {/* Next (hidden on last question, but Next + Submit are BOTH always shown) */}
        {!isLast && (
          <Button
            variant="outline"
            size="sm"
            className="aiq-attempt-next-btn"
            disabled={locked}
            onClick={() => {
              const next = sorted[safeIdx + 1];
              if (next !== undefined) {
                setCurrentQuestionId(next.question_id);
              }
            }}
          >
            Next
            <Icon name="arrow" size={14} style={{ marginLeft: 'var(--aiq-space-2xs)' }} />
          </Button>
        )}

        {/* Submit — always visible; enabled even if not all questions answered
            (Phase 1 uses window.confirm guard per contract decision) */}
        <Button
          variant="primary"
          size="sm"
          className="aiq-attempt-submit-btn"
          disabled={locked || submitting}
          data-help-id="candidate.attempt.submit.confirm"
          onClick={() => void handleSubmit()}
        >
          {submitting ? 'Submitting…' : 'Submit'}
        </Button>
      </footer>

      {/* ── MOBILE NAVIGATOR DRAWER ───────────────────────────────────────
          Renders only when navOpen=true (Drawer returns null otherwise).
          The toggle button (in the header) is itself display:none on
          desktop, so navOpen will only flip on mobile. Same items, same
          onSelect, same backend semantics as the desktop aside. */}
      <Drawer
        open={navOpen}
        onClose={() => setNavOpen(false)}
        title="Navigator"
      >
        {navigatorBody}
      </Drawer>

    </div>
  );
}

// ─── AnswerArea dispatcher ────────────────────────────────────────────────────
// Extracted to a named component so React's reconciler never loses the element
// tree when the question type changes (different sub-components but same slot).

function AnswerArea({
  question,
  answer,
  disabled,
  onAnswerChange,
  onBlur,
}: {
  question: FrozenQuestionWire;
  answer: unknown;
  disabled: boolean;
  onAnswerChange: (value: unknown) => void;
  onBlur: () => void;
}): JSX.Element {
  // Stage 1.5d shape lock: any forbidden synonym key in content triggers a
  // hard malformed fallback — no partial render of legacy rows.
  if (hasForbiddenSynonym(question.content)) {
    return <MalformedQuestion />;
  }

  switch (question.type) {
    case 'mcq':
      return (
        <McqAnswerArea
          question={question}
          answer={answer}
          disabled={disabled}
          onAnswerChange={onAnswerChange}
        />
      );

    case 'subjective':
      return (
        <SubjectiveAnswerArea
          answer={answer}
          disabled={disabled}
          onAnswerChange={onAnswerChange}
          onBlur={onBlur}
        />
      );

    case 'kql':
      return (
        <KqlAnswerArea
          question={question}
          answer={answer}
          disabled={disabled}
          onAnswerChange={onAnswerChange}
          onBlur={onBlur}
        />
      );

    case 'log_analysis':
      return (
        <LogAnalysisAnswerArea
          question={question}
          answer={answer}
          disabled={disabled}
          onAnswerChange={onAnswerChange}
          onBlur={onBlur}
        />
      );

    case 'scenario':
      return (
        <ScenarioAnswerArea
          question={question}
          answer={answer}
          disabled={disabled}
          onAnswerChange={onAnswerChange}
          onBlur={onBlur}
        />
      );

    default:
      return <UnknownTypeArea type={question.type} />;
  }
}
