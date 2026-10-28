import { useEffect, useState } from "react";
import { Button, Icon } from "@assessiq/ui-system";
import type { FrozenQuestionWire } from "@assessiq/candidate-ui";
import { STEM_FIELD, SR_ONLY, isAnsweredValue } from "./shared.js";

// Z-171: the finish summary (handoff view 2). Display and navigation only: it reads the same
// answers and flags the page already holds, and opens the existing confirm dialog.

export interface SummaryRow {
  q: FrozenQuestionWire;
  position: number;
  answer: unknown;
  flagged: boolean;
}

export interface FinishSummaryProps {
  rows: SummaryRow[];
  /** Overall counts (all sections on a sectioned test). */
  answered: number;
  total: number;
  flagged: number;
  /** Deadline for the "Time left" card; null hides the card. */
  endsAt: string | null;
  onOpen: (questionId: string) => void;
  onBack: () => void;
  onSubmit: () => void;
  submitting: boolean;
}

type RowFilter = "all" | "open" | "flagged";

export function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
}

/** One line of plain text for the "your answer" column. Never throws on an unknown shape. */
export function answerText(q: FrozenQuestionWire, answer: unknown): string {
  if (!isAnsweredValue(answer)) return "—";
  if (typeof answer === "string") return answer;
  if (typeof answer === "number") return String(answer);
  if (Array.isArray(answer)) return answer.map(String).join(", ");
  if (answer !== null && typeof answer === "object") {
    const a = answer as Record<string, unknown>;
    const opts = (q.content as Record<string, unknown> | undefined)?.options;
    const pick = (i: unknown): string =>
      typeof i === "number" && Array.isArray(opts) && typeof opts[i] === "string" ? (opts[i] as string) : String(i);
    if (typeof a.selected === "number") return pick(a.selected);
    if (Array.isArray(a.selected)) return a.selected.map(pick).join(", ");
    for (const k of ["text", "value", "answer"]) {
      if (typeof a[k] === "string" || typeof a[k] === "number") return String(a[k]);
    }
    return "Answered";
  }
  return "Answered";
}

function stem(q: FrozenQuestionWire): string {
  const c = q.content as Record<string, unknown> | undefined;
  const field = (STEM_FIELD as Record<string, string>)[q.type] ?? "question";
  const t = c?.[field];
  return typeof t === "string" ? t : `Question ${q.position}`;
}

function TimeLeft({ endsAt }: { endsAt: string }): React.JSX.Element {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return <span className="aiq-fs-n aiq-fs-mono">{clock((new Date(endsAt).getTime() - now) / 1000)}</span>;
}

export function FinishSummary(props: FinishSummaryProps): React.JSX.Element {
  const { rows, answered, total, flagged, endsAt, onOpen, onBack, onSubmit, submitting } = props;
  const [filter, setFilter] = useState<RowFilter>("all");
  const open = total - answered;
  const shown = rows.filter((r) =>
    filter === "all" ? true : filter === "flagged" ? r.flagged : !isAnsweredValue(r.answer),
  );
  const seg = (v: RowFilter, label: string, n: number): React.JSX.Element => (
    <button type="button" aria-pressed={filter === v} onClick={() => setFilter(v)}>
      {label} · {n}
    </button>
  );
  const openRows = rows.filter((r) => !isAnsweredValue(r.answer)).length;
  const flaggedRows = rows.filter((r) => r.flagged).length;
  return (
    <div className="aiq-fs" data-testid="finish-summary">
      <main className="aiq-fs-main">
        <div className="aiq-take-eyebrow">Review before submitting</div>
        <h1 className="aiq-fs-h1">Finish summary.</h1>
        <p className="aiq-fs-lede">Check each answer before you submit. Select a row to jump back and change it.</p>
        <div className="aiq-fs-stats">
          <div className="aiq-fs-stat"><span className="aiq-take-eyebrow">Answered</span><span className="aiq-fs-n">{answered}<small> / {total}</small></span></div>
          <div className="aiq-fs-stat"><span className="aiq-take-eyebrow">Flagged</span><span className="aiq-fs-n">{flagged}</span></div>
          <div className="aiq-fs-stat"><span className="aiq-take-eyebrow">Open</span><span className="aiq-fs-n">{open}</span></div>
          {endsAt !== null && (
            <div className="aiq-fs-stat"><span className="aiq-take-eyebrow">Time left</span><TimeLeft endsAt={endsAt} /></div>
          )}
        </div>
        <div className="aiq-take-seg aiq-fs-seg" role="group" aria-label="Filter questions">
          {seg("all", "All", rows.length)}
          {seg("open", "Open", openRows)}
          {seg("flagged", "Flagged", flaggedRows)}
        </div>
        <table className="aiq-fs-table">
          <thead>
            <tr><th scope="col">#</th><th scope="col">Question</th><th scope="col">Your answer</th><th scope="col">Status</th><th scope="col"><span style={SR_ONLY}>Edit</span></th></tr>
          </thead>
          <tbody>
            {shown.map((r) => {
              // UAT 2026-10-29: the status is always Answered or Not answered; a flag adds a dot, it never replaces the status.
              const status = isAnsweredValue(r.answer) ? "Answered" : "Not answered";
              return (
                <tr
                  key={r.q.question_id}
                  tabIndex={0}
                  aria-label={`Question ${r.position}, ${status.toLowerCase()}${r.flagged ? ", flagged" : ""}. Edit`}
                  onClick={() => onOpen(r.q.question_id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") onOpen(r.q.question_id);
                  }}
                >
                  <td className="aiq-fs-mono">{String(r.position).padStart(2, "0")}</td>
                  <td className="aiq-fs-ell">{stem(r.q)}</td>
                  <td className="aiq-fs-ell aiq-fs-muted">{answerText(r.q, r.answer)}</td>
                  <td>
                    <span className="aiq-fs-chip" data-status={status === "Answered" ? "answered" : "open"}>{status}</span>
                    {r.flagged && (
                      <span className="aiq-fs-flag" title="Flagged for review">
                        <span className="aiq-fs-flagdot" aria-hidden="true" />
                        <span style={SR_ONLY}>Flagged</span>
                      </span>
                    )}
                  </td>
                  <td className="aiq-fs-muted">Edit ›</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </main>
      <aside className="aiq-fs-side" aria-label="Before you submit">
        <ul className="aiq-fs-check">
          <li data-ok={open === 0}><Icon name={open === 0 ? "check" : "flag"} size={12} />{open > 0 ? `${open} question${open === 1 ? " has" : "s have"} no answer yet.` : `All ${total} questions have an answer.`}</li>
          <li data-ok={flagged === 0}><Icon name={flagged === 0 ? "check" : "flag"} size={12} />{flagged > 0 ? `${flagged} question${flagged === 1 ? " is" : "s are"} flagged for review.` : "No questions are flagged."}</li>
          <li data-ok="true"><Icon name="check" size={12} />Answers saved automatically.</li>
        </ul>
        <p className="aiq-fs-notice"><strong>Submitting ends the assessment.</strong> You can&apos;t change answers afterwards.</p>
        <div className="aiq-fs-actions">
          <Button variant="primary" size="lg" disabled={submitting} onClick={onSubmit} data-help-id="candidate.attempt.submit.confirm">
            Submit assessment
          </Button>
          <Button variant="outline" size="lg" onClick={onBack}>‹ Back to questions</Button>
        </div>
      </aside>
    </div>
  );
}
