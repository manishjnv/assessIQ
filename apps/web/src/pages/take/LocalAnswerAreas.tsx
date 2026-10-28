// Free-text / scenario answer areas, split out of Attempt.tsx so renderers.tsx
// can import them without an import cycle (RW-54a step 7).

import './take-theme.css';
import { Button, Card } from '@assessiq/ui-system';
import type { FrozenQuestionWire } from '@assessiq/candidate-ui';
import type { QuestionType } from '@assessiq/question-types';

/** A scenario step of this type renders as radio options (the step's own type, not the question's). */
const SINGLE_CHOICE_STEP: QuestionType = 'mcq';

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
  type?: string;
  options?: string[]; // only on mcq-typed steps (server allowlist)
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
interface _SubjectiveContent {
  question: string;
}

// ─── Answer area sub-components ───────────────────────────────────────────────

function countWords(text: string): number {
  const trimmed = text.trim();
  if (trimmed === '') return 0;
  return trimmed.split(/\s+/).length;
}

export function SubjectiveAnswerArea({
  answer,
  disabled,
  onAnswerChange,
  onBlur,
}: {
  answer: unknown;
  disabled: boolean;
  onAnswerChange: (value: unknown) => void;
  onBlur: () => void;
}): React.JSX.Element {
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
        maxLength={20000} // GATE-8 A4-6: the server refuses more than 20,000 characters
        onChange={(e) => onAnswerChange({ response: e.target.value })}
        onBlur={onBlur}
        aria-label="Your answer"
        className="aiq-take-textarea"
        style={{
          // M2b: 15px desktop / 16px mobile via .aiq-attempt-shell CSS var.
          // 16px on mobile defeats iOS Safari's auto-zoom-on-focus.
          fontSize: 'var(--aiq-answer-input-size)',
        }}
      />
      <div
        data-help-id="candidate.attempt.subjective.length"
        style={{
          fontSize: 13,
          color: 'var(--aiq-color-fg-muted)',
          textAlign: 'right',
        }}
      >
        {wordCount} words
      </div>
    </div>
  );
}

export function KqlAnswerArea({
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
}): React.JSX.Element {
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
          borderRadius: 12,
        }}
      >
        Tip: KQL is easier on a desktop browser. You can answer here, but consider switching for syntax-heavy queries.
      </p>
      {tables.length > 0 && (
        <div
          style={{
            fontFamily: 'var(--aiq-font-mono)',
            fontSize: 13,
            color: 'var(--aiq-color-fg-muted)',
            padding: '8px 12px',
            background: 'var(--aiq-color-bg-raised)',
            border: '1px solid var(--aiq-color-border)',
            borderRadius: 12,
            overflowWrap: 'anywhere',
          }}
        >
          Tables: {tables.join(', ')}
        </div>
      )}
      <textarea
        value={text}
        disabled={disabled}
        maxLength={20000}
        onChange={(e) => onAnswerChange({ query: e.target.value })}
        onBlur={onBlur}
        aria-label="KQL query"
        data-help-id="candidate.attempt.kql.editor"
        className="aiq-take-textarea aiq-take-field--mono"
        style={{
          minHeight: 200,
          // M2b: 13px mono desktop / 16px mono mobile via .aiq-attempt-shell CSS var.
          fontSize: 'var(--aiq-answer-mono-size)',
        }}
      />
    </div>
  );
}

export function LogAnalysisAnswerArea({
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
}): React.JSX.Element {
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
              borderRadius: 14,
              padding: 16,
              overflow: 'auto',
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
            fontSize: 13,
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
              className="aiq-take-field"
              style={{
                flex: 1,
                minWidth: 0,
                // M2b: 14px desktop bumps to 15px desktop / 16px mobile via the
                // .aiq-attempt-shell CSS var. Mobile 16px defeats iOS auto-zoom.
                fontSize: 'var(--aiq-answer-input-size)',
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
            fontSize: 13,
            color: 'var(--aiq-color-fg-muted)',
            marginBottom: 'var(--aiq-space-2xs)',
          }}
        >
          Explain your reasoning. Describe what the findings indicate.
        </div>
        <textarea
          value={explanation}
          disabled={disabled}
          maxLength={20000}
          onChange={(e) => emitAnswer(displayFindings, e.target.value)}
          onBlur={onBlur}
          aria-label="Explanation"
          className="aiq-take-textarea"
          style={{
            minHeight: 120,
            // M2b: 15px desktop / 16px mobile via the .aiq-attempt-shell CSS var.
            fontSize: 'var(--aiq-answer-input-size)',
          }}
        />
      </div>
    </div>
  );
}

export function ScenarioAnswerArea({
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
}): React.JSX.Element {
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
            fontSize: 'var(--aiq-text-lg)',
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
            padding: 20,
            background: 'var(--aiq-color-bg-raised)',
            border: '1px solid var(--aiq-color-border)',
            borderRadius: 14,
            overflowWrap: 'anywhere',
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
              fontSize: 'var(--aiq-text-lg)',
              lineHeight: 1.55,
              color: 'var(--aiq-color-fg-primary)',
              margin: 0,
            }}
          >
            {step.prompt}
          </p>
          {step.type === SINGLE_CHOICE_STEP && Array.isArray(step.options) ? (
            // The chosen option TEXT is saved as the step response (same string shape as
            // free-text steps; the AI grader reads it).
            <div role="radiogroup" aria-label={`Step ${idx + 1} options`} className="aiq-take-opts">
              {step.options.map((opt, oi) => (
                <label
                  key={oi}
                  className="aiq-take-opt"
                  data-checked={getResponse(idx) === opt}
                  data-disabled={disabled}
                  style={{ position: 'relative' }}
                >
                  <input
                    type="radio"
                    className="aiq-take-visually-hidden-input"
                    name={`scenario-step-${idx}`}
                    checked={getResponse(idx) === opt}
                    disabled={disabled}
                    onChange={() => { updateStep(idx, opt); onBlur(); }}
                  />
                  <span className="aiq-take-opt-badge" aria-hidden="true">{String.fromCharCode(65 + oi)}</span>
                  <span className="aiq-take-opt-text">{opt}</span>
                  <span className="aiq-take-radio" aria-hidden="true" />
                </label>
              ))}
            </div>
          ) : (
          <textarea
            value={getResponse(idx)}
            disabled={disabled}
            maxLength={20000}
            onChange={(e) => updateStep(idx, e.target.value)}
            onBlur={onBlur}
            aria-label={`Step ${idx + 1} response`}
            className="aiq-take-textarea"
            style={{
              minHeight: 100,
              // M2b: 15px desktop / 16px mobile via the .aiq-attempt-shell CSS var.
              fontSize: 'var(--aiq-answer-input-size)',
            }}
          />
          )}
        </div>
      ))}
    </div>
  );
}
