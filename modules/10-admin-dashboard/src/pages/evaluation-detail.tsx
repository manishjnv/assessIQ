// AssessIQ — Super-admin evaluate page.
//
// /admin/platform/evaluations/:attemptId
//
// Where AssessIQ evaluates one attempt from the cross-tenant queue (spec
// 2026-10-01 §11, wire contract §5b). The shared <AttemptGradingPanel
// mode="evaluate"> does the work — Grade all, per-question proposals, Accept,
// Re-run (Opus), manual score for KQL / ungraded questions, Override — against
// /admin/super/evaluations/:attemptId/*. "Release to company" hands the finished
// evaluation to the tenant, which then reviews and publishes it.
//
// INVARIANTS:
//  - Blind evaluation: NO candidate name or email is rendered here, even if the
//    payload carried one. The attempt is identified by its short id only.
//  - No claude/anthropic imports.
//  - Fresh-MFA failures open the inline step-up and retry (useMfaGuard).

import React, { useEffect, useState, useCallback, useMemo } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { Chip, Modal, Spinner } from "@assessiq/ui-system";
import { AdminShell } from "../components/AdminShell.js";
import { AttemptGradingPanel } from "../components/AttemptGradingPanel.js";
import { useMfaGuard } from "../components/useMfaGuard.js";
import { adminApi } from "../api.js";
import {
  apiMessage,
  effectiveGradings,
  evaluationMeta,
  normaliseDetail,
} from "../lib/evaluation.js";
import type { AttemptDetailResponse } from "../lib/evaluation.js";

const QUEUE_PATH = "/admin/platform/evaluations";

const MONO_LABEL: React.CSSProperties = {
  fontFamily: "var(--aiq-font-mono)",
  fontSize: "var(--aiq-text-xs)",
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  color: "var(--aiq-color-fg-muted)",
};

export function AdminEvaluationDetail(): React.ReactElement {
  const { attemptId } = useParams<{ attemptId: string }>();
  const navigate = useNavigate();
  const apiBase = `/admin/super/evaluations/${attemptId ?? ""}`;

  const [detail, setDetail] = useState<AttemptDetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showRelease, setShowRelease] = useState(false);
  const [releasing, setReleasing] = useState(false);
  const { guard, stepUp } = useMfaGuard(
    "Releasing an evaluation needs a fresh authenticator check. Enter your 6-digit code to continue.",
  );

  // `silent` reloads keep the page (and the panel's open forms) on screen; only
  // the first load shows the spinner.
  const fetchDetail = useCallback(
    async (silent: boolean): Promise<void> => {
      if (!attemptId) return;
      if (!silent) {
        setLoading(true);
        setError(null);
      }
      try {
        setDetail(normaliseDetail(await adminApi<AttemptDetailResponse>(`/admin/super/evaluations/${attemptId}`)));
      } catch (err) {
        setError(apiMessage(err, "Failed to load evaluation."));
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [attemptId],
  );
  const reload = useCallback(() => fetchDetail(true), [fetchDetail]);

  useEffect(() => {
    void fetchDetail(false);
  }, [fetchDetail]);

  const effective = useMemo(() => effectiveGradings(detail?.gradings ?? []), [detail]);

  async function handleRelease(): Promise<void> {
    setShowRelease(false);
    setReleasing(true);
    await guard(
      async () => {
        await adminApi(`${apiBase}/release-to-tenant`, { method: "POST" });
        navigate(QUEUE_PATH);
      },
      (message) => setError(message),
    );
    setReleasing(false);
  }

  const handle = (attemptId ?? "").slice(0, 8);
  const crumbs = [
    { label: "Platform", href: "/admin/platform" },
    { label: "Evaluations", href: QUEUE_PATH },
    handle ? `#${handle}` : "Evaluation",
  ];

  if (loading) {
    return (
      <AdminShell breadcrumbs={crumbs} helpPage="admin.evaluations.detail">
        <div style={{ padding: "var(--aiq-space-3xl)", display: "flex", justifyContent: "center" }}>
          <Spinner aria-label="Loading evaluation" />
        </div>
      </AdminShell>
    );
  }

  if (!detail) {
    return (
      <AdminShell breadcrumbs={crumbs} helpPage="admin.evaluations.detail">
        <div style={{ color: "var(--aiq-color-danger)", padding: "var(--aiq-space-xl)" }}>{error ?? "Not found."}</div>
      </AdminShell>
    );
  }

  const { attempt, frozen_questions } = detail;
  const meta = evaluationMeta(detail);
  const tenantName = meta.tenant_name ?? "the company";
  const complete = attempt.status === "graded";
  const released = !!meta.evaluation_released_at;
  const canRelease = complete && !released;

  const scoreEarned = [...effective.values()].reduce((s, g) => s + Number(g.score_earned ?? 0), 0);
  const scoreMax = [...effective.values()].reduce((s, g) => s + Number(g.score_max ?? 0), 0);

  const statusChip = released
    ? { label: "Released to company", variant: "default" as const }
    : complete
      ? { label: "Ready to release", variant: "success" as const }
      : { label: "Pending evaluation", variant: "accent" as const };

  return (
    <AdminShell breadcrumbs={crumbs} helpPage="admin.evaluations.detail">
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-xl)" }}>
        {/* Header — attempt handle, company, level; never the candidate. */}
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "var(--aiq-space-md)", flexWrap: "wrap" }}>
          <div>
            <div style={{ marginBottom: 12 }}>
              <Chip variant={statusChip.variant}>{statusChip.label}</Chip>
            </div>
            <h1 style={{ fontFamily: "var(--aiq-font-serif)", fontSize: "var(--aiq-text-3xl)", fontWeight: 400, margin: 0, letterSpacing: "-0.02em" }}>
              {attempt.assessment_name || `Attempt ${handle}`}
            </h1>
            <div style={{ ...MONO_LABEL, marginTop: "var(--aiq-space-xs)" }}>
              {[
                meta.tenant_name,
                attempt.level_label,
                attempt.submitted_at ? new Date(attempt.submitted_at).toLocaleString() : null,
                `#${handle}`,
              ].filter(Boolean).join(" · ")}
            </div>
          </div>
          <div style={{ display: "flex", gap: "var(--aiq-space-sm)", flexWrap: "wrap" }}>
            {effective.size > 0 && (
              <button
                type="button"
                className="aiq-btn aiq-btn-outline aiq-no-print"
                data-help-id="admin.attempts.print_review"
                onClick={() => window.print()}
              >
                Print review
              </button>
            )}
            <button
              type="button"
              className={`aiq-btn aiq-no-print ${canRelease ? "aiq-btn-primary" : "aiq-btn-outline"}`}
              data-help-id="admin.evaluations.release_to_company"
              disabled={!canRelease || releasing}
              title={
                released
                  ? "Already released to the company."
                  : complete
                    ? undefined
                    : "Every question needs a final grade before this can be released."
              }
              onClick={() => setShowRelease(true)}
            >
              {releasing ? "Releasing…" : "Release to company"}
            </button>
          </div>
        </div>

        {error && (
          <div className="aiq-banner aiq-banner-error aiq-error-banner" style={{ display: "flex", alignItems: "center", gap: "var(--aiq-space-md)", padding: "var(--aiq-space-md) var(--aiq-space-xl)", backgroundColor: "var(--aiq-color-danger-subtle, #fff0f0)", border: "1px solid var(--aiq-color-danger)", borderRadius: "var(--aiq-radius-sm, 4px)", fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-sm)", color: "var(--aiq-color-danger)" }}>
            <span style={{ flex: 1 }}>{error}</span>
            <button type="button" className="aiq-btn aiq-btn-sm" style={{ flexShrink: 0 }} onClick={() => { setError(null); void reload(); }}>
              Refresh
            </button>
            <button type="button" className="aiq-btn aiq-btn-sm aiq-btn-outline" style={{ flexShrink: 0 }} onClick={() => setError(null)}>
              Dismiss
            </button>
          </div>
        )}

        {/* Sent back by the company — the note says what to look at again. */}
        {meta.evaluation_sent_back_at && (
          <div
            className="aiq-banner"
            data-help-id="admin.evaluations.sent_back"
            role="status"
            style={{ display: "flex", flexDirection: "column", gap: 2, padding: "var(--aiq-space-md) var(--aiq-space-xl)", backgroundColor: "var(--aiq-color-warning-subtle, #fff8e0)", border: "1px solid var(--aiq-color-warning, #b08000)", borderRadius: "var(--aiq-radius-sm, 4px)", fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-sm)", color: "var(--aiq-color-fg-primary)" }}
          >
            <div style={{ fontWeight: 500 }}>Sent back by {tenantName} for re-evaluation.</div>
            {meta.evaluation_note && (
              <div style={{ whiteSpace: "pre-wrap", color: "var(--aiq-color-fg-secondary)" }}>{meta.evaluation_note}</div>
            )}
          </div>
        )}

        <AttemptGradingPanel
          detail={detail}
          reload={reload}
          mode="evaluate"
          apiBase={apiBase}
          canOverride
          onError={setError}
        />
      </div>

      {stepUp}

      {/* Confirm before handing the evaluation to the company. */}
      <Modal open={showRelease} onClose={() => setShowRelease(false)} title="Release to company?" width={480}>
        <p style={{ margin: 0, fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-sm)", color: "var(--aiq-color-fg-secondary)", lineHeight: 1.6 }}>
          {tenantName} will be able to review these scores and publish them to the candidate. They can send the
          attempt back to this queue if something needs another look.
        </p>
        <div style={{ ...MONO_LABEL, display: "flex", gap: "var(--aiq-space-md)", flexWrap: "wrap" }}>
          <span>{effective.size} of {frozen_questions.length} questions graded</span>
          {scoreMax > 0 && <span>Score {scoreEarned} / {scoreMax}</span>}
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: "var(--aiq-space-sm)" }}>
          <button type="button" className="aiq-btn aiq-btn-ghost" onClick={() => setShowRelease(false)}>
            Cancel
          </button>
          <button type="button" className="aiq-btn aiq-btn-primary" onClick={() => void handleRelease()}>
            Release to company
          </button>
        </div>
      </Modal>
    </AdminShell>
  );
}
