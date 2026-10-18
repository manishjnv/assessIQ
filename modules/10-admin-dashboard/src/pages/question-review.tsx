// AssessIQ — Admin question review page (EXP-18 part 2).
//
// /admin/question-bank/:id/review
//
// The review gate before students are invited. For one question set it shows each question with its
// answer key, rationale, source reference and rights status, and three actions: Verify, Needs fix
// (a note is required) and Withdraw. "Verify all in this question set" verifies every question in
// review after a confirm step that shows the count.
//
// Fetches:
//   GET  /admin/packs/:id/review?state=&page=      → { pack, counts, total, items }
//   POST /admin/questions/:id/review               → { action: verify | needs_fix | withdraw, note? }
//   POST /admin/packs/:id/review/verify-all        → { confirm: true, expected_count }
//
// Who sees what is decided by the server: the super admin reviews platform questions, an
// organisation admin reviews that organisation's questions. A refused call shows the server message.
//
// INVARIANTS:
//  - No claude/anthropic imports or copy.
//  - Source links render only for https URLs.

import React, { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ConfirmDialog, Modal } from "@assessiq/ui-system";
import { HelpTip } from "@assessiq/help-system/components";
import { AdminShell } from "../components/AdminShell.js";
import { adminApi, AdminApiError } from "../api.js";
import { questionPrompt } from "./pack-detail/shared.js";

type ReviewState = "in_review" | "verified" | "disputed" | "needs_fix";
type Filter = "open" | "all" | "in_review" | "needs_fix" | "disputed" | "verified" | "none";

interface ReviewItem {
  id: string;
  type: string;
  topic: string;
  points: number;
  review_state: ReviewState | null;
  content: Record<string, unknown>;
  rubric: unknown;
  answer_guidance: string | null;
  origin: string | null;
  rights_status: string | null;
  source_ref: string | null;
  source_url: string | null;
}

interface PackReview {
  pack: { id: string; name: string; status: string; is_platform: boolean };
  counts: Record<"in_review" | "verified" | "disputed" | "needs_fix" | "none", number>;
  total: number;
  items: ReviewItem[];
}

const PAGE_SIZE = 25;

const FILTERS: ReadonlyArray<{ id: Filter; label: string; count: (c: PackReview["counts"]) => number }> = [
  { id: "open", label: "Needs review", count: (c) => c.in_review + c.needs_fix + c.disputed },
  { id: "in_review", label: "In review", count: (c) => c.in_review },
  { id: "needs_fix", label: "Needs fix", count: (c) => c.needs_fix },
  { id: "disputed", label: "Disputed", count: (c) => c.disputed },
  { id: "verified", label: "Verified", count: (c) => c.verified },
  { id: "none", label: "Not set", count: (c) => c.none },
  { id: "all", label: "All", count: (c) => c.in_review + c.needs_fix + c.disputed + c.verified + c.none },
];

const STATE_LABEL: Record<string, string> = {
  in_review: "In review",
  verified: "Verified",
  disputed: "Disputed",
  needs_fix: "Needs fix",
  none: "Not set",
};

const RIGHTS_LABEL: Record<string, string> = {
  original: "Original",
  derived_from_source: "Derived from source",
  scraped_raw: "Scraped, not cleared",
  licensed: "Licensed",
  metadata_only: "Metadata only",
  withdrawn: "Withdrawn",
};

const LABEL_STYLE: React.CSSProperties = {
  fontFamily: "var(--aiq-font-mono)",
  fontSize: "var(--aiq-text-xs)",
  textTransform: "uppercase",
  letterSpacing: "0.04em",
  color: "var(--aiq-color-fg-muted)",
};

const BODY_STYLE: React.CSSProperties = {
  fontFamily: "var(--aiq-font-sans)",
  fontSize: "var(--aiq-text-sm)",
  color: "var(--aiq-color-fg-primary)",
};

function stateColors(s: string | null): { bg: string; color: string } {
  switch (s) {
    case "verified":
      return { bg: "var(--aiq-color-success-soft)", color: "var(--aiq-color-success)" };
    case "needs_fix":
    case "disputed":
      return { bg: "var(--aiq-color-bg-sunken)", color: "var(--aiq-color-danger)" };
    case "in_review":
      return { bg: "var(--aiq-color-accent-soft)", color: "var(--aiq-color-accent)" };
    default:
      return { bg: "var(--aiq-color-bg-sunken)", color: "var(--aiq-color-fg-muted)" };
  }
}

function Pill({ text, colors }: { text: string; colors: { bg: string; color: string } }): React.ReactElement {
  return (
    <span
      style={{
        ...LABEL_STYLE,
        padding: "1px 8px",
        borderRadius: "var(--aiq-radius-pill)",
        background: colors.bg,
        color: colors.color,
        whiteSpace: "nowrap",
      }}
    >
      {text}
    </span>
  );
}

function asString(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

/** The answer key of one question: options with the correct ones marked, or the stored key fields. */
function AnswerKey({ item }: { item: ReviewItem }): React.ReactElement {
  const c = item.content;
  const options = Array.isArray(c["options"]) ? (c["options"] as unknown[]) : null;
  const correct = c["correct"];
  const correctSet = new Set<number>(
    Array.isArray(correct) ? correct.filter((n): n is number => typeof n === "number") : typeof correct === "number" ? [correct] : [],
  );
  const textKey = ["answer", "correct_answer", "expected", "solution", "key"]
    .map((k) => [k, c[k]] as const)
    .filter(([, v]) => v !== undefined && v !== null && typeof v !== "object")
    .map(([k, v]) => `${k.replace(/_/g, " ")}: ${String(v)}`);
  return (
    <div>
      <div style={LABEL_STYLE}>Answer key</div>
      {options !== null ? (
        <ol style={{ ...BODY_STYLE, margin: "4px 0 0", paddingLeft: 22 }}>
          {options.map((o, i) => (
            <li
              key={i}
              style={correctSet.has(i) ? { fontWeight: 600, color: "var(--aiq-color-success)" } : undefined}
            >
              {typeof o === "string" ? o : JSON.stringify(o)}
              {correctSet.has(i) ? " (correct)" : ""}
            </li>
          ))}
        </ol>
      ) : null}
      {options === null && textKey.length > 0 ? (
        <ul style={{ ...BODY_STYLE, margin: "4px 0 0", paddingLeft: 22 }}>
          {textKey.map((t) => <li key={t}>{t}</li>)}
        </ul>
      ) : null}
      {options === null && textKey.length === 0 && item.rubric === null ? (
        <div style={{ ...BODY_STYLE, color: "var(--aiq-color-fg-muted)" }}>No key stored. Open the full content below.</div>
      ) : null}
      {item.rubric !== null && item.rubric !== undefined ? (
        <details style={{ marginTop: 4 }}>
          <summary style={{ ...BODY_STYLE, cursor: "pointer" }}>Rubric</summary>
          <pre style={{ ...BODY_STYLE, whiteSpace: "pre-wrap", margin: "4px 0 0" }}>{JSON.stringify(item.rubric, null, 2)}</pre>
        </details>
      ) : null}
      <details style={{ marginTop: 4 }}>
        <summary style={{ ...BODY_STYLE, cursor: "pointer" }}>Full content</summary>
        <pre style={{ ...BODY_STYLE, whiteSpace: "pre-wrap", margin: "4px 0 0" }}>{JSON.stringify(c, null, 2)}</pre>
      </details>
    </div>
  );
}

export function AdminQuestionReview(): React.ReactElement {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const [filter, setFilter] = useState<Filter>("open");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<PackReview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const [fixFor, setFixFor] = useState<ReviewItem | null>(null);
  const [fixNote, setFixNote] = useState("");
  const [withdrawFor, setWithdrawFor] = useState<ReviewItem | null>(null);
  const [verifyAllCount, setVerifyAllCount] = useState<number | null>(null);
  const [verifyAllBusy, setVerifyAllBusy] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    try {
      const r = await adminApi<PackReview>(`/admin/packs/${id}/review?state=${filter}&page=${page}&pageSize=${PAGE_SIZE}`);
      setData(r);
      setError(null);
    } catch (err) {
      setError(err instanceof AdminApiError ? err.apiError.message : "Failed to load the questions.");
    } finally {
      setLoading(false);
    }
  }, [id, filter, page]);

  useEffect(() => { void load(); }, [load]);

  async function act(item: ReviewItem, action: "verify" | "needs_fix" | "withdraw", note?: string): Promise<boolean> {
    setBusyId(item.id);
    setActionError(null);
    try {
      await adminApi(`/admin/questions/${item.id}/review`, {
        method: "POST",
        body: JSON.stringify({ action, ...(note !== undefined ? { note } : {}) }),
      });
      await load();
      return true;
    } catch (err) {
      setActionError(err instanceof AdminApiError ? err.apiError.message : "The action failed. Try again.");
      return false;
    } finally {
      setBusyId(null);
    }
  }

  async function doVerifyAll(): Promise<void> {
    if (!id || verifyAllCount === null) return;
    setVerifyAllBusy(true);
    setActionError(null);
    try {
      await adminApi(`/admin/packs/${id}/review/verify-all`, {
        method: "POST",
        body: JSON.stringify({ confirm: true, expected_count: verifyAllCount }),
      });
      setVerifyAllCount(null);
      await load();
    } catch (err) {
      setVerifyAllCount(null);
      setActionError(err instanceof AdminApiError ? err.apiError.message : "Verify all failed. Try again.");
      await load();
    } finally {
      setVerifyAllBusy(false);
    }
  }

  const crumbs = [{ label: "Question bank", href: "/admin/question-bank" }, { label: data?.pack.name ?? "Question set", href: `/admin/question-bank/${id ?? ""}` }, "Review"];
  const pages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;

  return (
    <AdminShell breadcrumbs={crumbs} helpPage="admin.question_bank.review">
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-lg)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: "var(--aiq-space-md)" }}>
          <div>
            <h1 style={{ fontFamily: "var(--aiq-font-serif)", fontSize: "var(--aiq-h1-size)", fontWeight: 400, margin: 0, letterSpacing: "-0.02em" }}>
              Review questions.
            </h1>
            <p style={{ ...LABEL_STYLE, margin: "4px 0 0" }}>
              {data ? `${data.pack.name} · ${data.counts.in_review} in review · ${data.counts.needs_fix} need a fix · ${data.counts.verified} verified` : "Loading"}
            </p>
            <p style={{ ...BODY_STYLE, color: "var(--aiq-color-fg-secondary)", margin: "8px 0 0", maxWidth: 640 }}>
              Candidates cannot be invited to an assessment while a question in its pool is not verified.
            </p>
          </div>
          <div style={{ display: "flex", gap: "var(--aiq-space-sm)", flexShrink: 0 }}>
            <button type="button" className="aiq-btn aiq-btn-outline aiq-btn-sm" onClick={() => navigate(`/admin/question-bank/${id ?? ""}`)}>
              ← Back
            </button>
            {data && data.counts.in_review > 0 ? (
              <HelpTip helpId="admin.question_bank.review.verify_all">
                <button
                  type="button"
                  className="aiq-btn aiq-btn-primary aiq-btn-sm"
                  disabled={verifyAllBusy}
                  onClick={() => setVerifyAllCount(data.counts.in_review)}
                >
                  Verify all in this question set ({data.counts.in_review})
                </button>
              </HelpTip>
            ) : null}
          </div>
        </div>

        {data ? (
          <HelpTip helpId="admin.question_bank.review.filter">
            <div role="tablist" aria-label="Review state" style={{ display: "flex", gap: "var(--aiq-space-xs)", flexWrap: "wrap" }}>
              {FILTERS.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  role="tab"
                  aria-selected={filter === f.id}
                  className={`aiq-btn aiq-btn-sm ${filter === f.id ? "aiq-btn-primary" : "aiq-btn-outline"}`}
                  onClick={() => { setFilter(f.id); setPage(1); }}
                >
                  {f.label} ({f.count(data.counts)})
                </button>
              ))}
            </div>
          </HelpTip>
        ) : null}

        {actionError ? <div role="alert" style={{ ...BODY_STYLE, color: "var(--aiq-color-danger)" }}>{actionError}</div> : null}
        {error ? <div role="alert" style={{ ...BODY_STYLE, color: "var(--aiq-color-danger)" }}>{error}</div> : null}
        {loading && !data ? <div style={{ ...BODY_STYLE, color: "var(--aiq-color-fg-muted)" }}>Loading…</div> : null}

        {data && data.items.length === 0 ? (
          <div style={{ ...BODY_STYLE, color: "var(--aiq-color-fg-muted)", padding: "var(--aiq-space-lg) 0" }}>
            {filter === "open" ? "Nothing waits for review in this question set." : "No questions match this filter."}
          </div>
        ) : null}

        {data?.items.map((item) => {
          const prompt = questionPrompt(item.content);
          const rationale = asString(item.content["rationale"]) ?? asString(item.content["explanation"]) ?? item.answer_guidance;
          const url = item.source_url !== null && /^https:\/\//i.test(item.source_url) ? item.source_url : null;
          const busy = busyId === item.id;
          return (
            <section
              key={item.id}
              aria-label={`Question ${item.topic}`}
              style={{
                border: "1px solid var(--aiq-color-border)",
                borderRadius: "var(--aiq-radius-lg)",
                padding: "var(--aiq-space-lg)",
                display: "flex",
                flexDirection: "column",
                gap: "var(--aiq-space-md)",
                background: "var(--aiq-color-bg-base)",
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", gap: "var(--aiq-space-md)", flexWrap: "wrap" }}>
                <span style={LABEL_STYLE}>{item.topic} · {item.type} · {item.points} {item.points === 1 ? "point" : "points"}</span>
                <span style={{ display: "flex", gap: 6 }}>
                  <Pill text={STATE_LABEL[item.review_state ?? "none"] ?? "Not set"} colors={stateColors(item.review_state)} />
                  <Pill
                    text={RIGHTS_LABEL[item.rights_status ?? ""] ?? "Rights not set"}
                    colors={stateColors(item.rights_status === "original" || item.rights_status === "licensed" || item.rights_status === "derived_from_source" ? "verified" : "needs_fix")}
                  />
                </span>
              </div>

              <div>
                <div style={LABEL_STYLE}>Question</div>
                <p style={{ ...BODY_STYLE, margin: "4px 0 0", whiteSpace: "pre-wrap" }}>{prompt !== "" ? prompt : "(no prompt text)"}</p>
              </div>

              <AnswerKey item={item} />

              <div>
                <div style={LABEL_STYLE}>Rationale</div>
                <p style={{ ...BODY_STYLE, margin: "4px 0 0", whiteSpace: "pre-wrap", color: rationale ? undefined : "var(--aiq-color-fg-muted)" }}>
                  {rationale ?? "No rationale stored."}
                </p>
              </div>

              <div>
                <div style={LABEL_STYLE}>Source</div>
                <p style={{ ...BODY_STYLE, margin: "4px 0 0" }}>
                  {item.source_ref ?? "No source reference."}
                  {url ? <> · <a href={url} target="_blank" rel="noopener noreferrer">Open source</a></> : null}
                </p>
              </div>

              <div style={{ display: "flex", gap: "var(--aiq-space-sm)", flexWrap: "wrap" }}>
                <HelpTip helpId="admin.question_bank.review.verify">
                  <button
                    type="button"
                    className="aiq-btn aiq-btn-primary aiq-btn-sm"
                    disabled={busy || item.review_state === "verified"}
                    onClick={() => void act(item, "verify")}
                  >
                    {item.review_state === "verified" ? "Verified" : "Verify"}
                  </button>
                </HelpTip>
                <HelpTip helpId="admin.question_bank.review.needs_fix">
                  <button
                    type="button"
                    className="aiq-btn aiq-btn-outline aiq-btn-sm"
                    disabled={busy}
                    onClick={() => { setFixFor(item); setFixNote(""); }}
                  >
                    Needs fix
                  </button>
                </HelpTip>
                <HelpTip helpId="admin.question_bank.review.withdraw">
                  <button
                    type="button"
                    className="aiq-btn aiq-btn-ghost aiq-btn-sm"
                    disabled={busy}
                    style={{ color: "var(--aiq-color-danger)" }}
                    onClick={() => setWithdrawFor(item)}
                  >
                    Withdraw
                  </button>
                </HelpTip>
              </div>
            </section>
          );
        })}

        {data && pages > 1 ? (
          <div style={{ display: "flex", gap: "var(--aiq-space-sm)", alignItems: "center" }}>
            <button type="button" className="aiq-btn aiq-btn-outline aiq-btn-sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button>
            <span style={LABEL_STYLE}>Page {page} of {pages}</span>
            <button type="button" className="aiq-btn aiq-btn-outline aiq-btn-sm" disabled={page >= pages} onClick={() => setPage(page + 1)}>Next</button>
          </div>
        ) : null}
      </div>

      <Modal open={fixFor !== null} onClose={() => setFixFor(null)} title="Needs fix">
        <label htmlFor="review-fix-note" style={{ ...BODY_STYLE, display: "block", fontWeight: 500, marginBottom: 6 }}>
          What must change? The note is saved in the audit log.
        </label>
        <textarea
          id="review-fix-note"
          value={fixNote}
          onChange={(e) => setFixNote(e.target.value)}
          maxLength={1000}
          rows={4}
          style={{
            ...BODY_STYLE,
            width: "100%",
            padding: "8px 10px",
            borderRadius: "var(--aiq-radius-md)",
            border: "1px solid var(--aiq-color-border-strong)",
            background: "var(--aiq-color-bg-raised)",
            boxSizing: "border-box",
            resize: "vertical",
            marginBottom: "var(--aiq-space-md)",
          }}
        />
        <div style={{ display: "flex", justifyContent: "flex-end", gap: "var(--aiq-space-sm)" }}>
          <button type="button" className="aiq-btn aiq-btn-outline" onClick={() => setFixFor(null)}>Cancel</button>
          <button
            type="button"
            className="aiq-btn aiq-btn-primary"
            disabled={fixNote.trim() === "" || busyId !== null}
            onClick={() => {
              const item = fixFor;
              if (item === null) return;
              void act(item, "needs_fix", fixNote.trim()).then((ok) => { if (ok) setFixFor(null); });
            }}
          >
            Mark needs fix
          </button>
        </div>
      </Modal>

      <ConfirmDialog
        open={withdrawFor !== null}
        title="Withdraw this question"
        body="This takes the question out of every question set at the next sync. Attempts that already used it keep their copy. This cannot be undone."
        confirmLabel="Withdraw"
        danger
        busy={busyId !== null}
        onConfirm={() => {
          const item = withdrawFor;
          setWithdrawFor(null);
          if (item !== null) void act(item, "withdraw");
        }}
        onCancel={() => setWithdrawFor(null)}
      />

      <ConfirmDialog
        open={verifyAllCount !== null}
        title="Verify all in this question set"
        body={`Verify ${verifyAllCount ?? 0} ${verifyAllCount === 1 ? "question" : "questions"} that are in review? Questions marked Needs fix or Disputed stay as they are. Each question gets its own audit entry.`}
        confirmLabel={`Verify ${verifyAllCount ?? 0}`}
        busy={verifyAllBusy}
        onConfirm={() => void doVerifyAll()}
        onCancel={() => setVerifyAllCount(null)}
      />
    </AdminShell>
  );
}
