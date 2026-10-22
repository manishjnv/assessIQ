// AssessIQ — "Run an assessment" checklist card on the admin Home (Z-24).
//
// Reads the most recent assessment and its attempt counts with existing
// endpoints only:
//   GET /api/admin/assessments?pageSize=1        (invitation counts per row)
//   GET /api/admin/attempts?assessmentId=&limit=1 (total, and status-filtered totals)
// Ticks are computed in lib/checklist.ts. The card hides itself when all six
// steps are done; a small button reopens it.
//
// INVARIANTS:
//  - Read-only. No writes from this card.
//  - Errors show a fixed fallback text; raw API messages are not rendered.

import React, { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router";
import { HelpTip } from "@assessiq/help-system/components";
import { adminApi } from "../api.js";
import {
  ATTEMPT_AWAITING_STATUSES,
  allStepsDone,
  buildChecklistSteps,
  safeCount,
  stepHref,
} from "../lib/checklist.js";
import type {
  ChecklistAttemptCounts,
  ChecklistInvitationCounts,
  ChecklistStep,
  ChecklistStepId,
} from "../lib/checklist.js";

const POLL_MS = 30_000;

const STEP_LABELS: Record<ChecklistStepId, { label: string; help: string }> = {
  assessment: { label: "Create or pick an assessment", help: "admin.dashboard.home.checklist.step_assessment" },
  candidates: { label: "Add candidates", help: "admin.dashboard.home.checklist.step_candidates" },
  invitations: { label: "Send invitations", help: "admin.dashboard.home.checklist.step_invitations" },
  attempts: { label: "Watch attempts", help: "admin.dashboard.home.checklist.step_attempts" },
  grading: { label: "Grade and review", help: "admin.dashboard.home.checklist.step_grading" },
  release: { label: "Release results and certificates", help: "admin.dashboard.home.checklist.step_release" },
};

const VISUALLY_HIDDEN: React.CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  overflow: "hidden",
  clip: "rect(0 0 0 0)",
  whiteSpace: "nowrap",
};

const STEP_ORDER: ChecklistStepId[] = ["assessment", "candidates", "invitations", "attempts", "grading", "release"];

interface AssessmentListItem {
  id?: unknown;
  invitations?: Partial<ChecklistInvitationCounts>;
}

interface AssessmentListResponse {
  items?: AssessmentListItem[];
}

interface CountResponse {
  total?: unknown;
}

interface ChecklistState {
  steps: ChecklistStep[];
  assessmentId: string | null;
}

const FALLBACK_ERROR = "The checklist could not load. Refresh the page to try again.";

async function loadChecklist(): Promise<ChecklistState> {
  const list = await adminApi<AssessmentListResponse>("/admin/assessments?pageSize=1");
  const first = Array.isArray(list.items) ? list.items[0] : undefined;
  const assessmentId = first && typeof first.id === "string" ? first.id : null;
  if (assessmentId === null) {
    return { steps: buildChecklistSteps({ assessmentId: null }), assessmentId: null };
  }
  const q = (params: Record<string, string>) => new URLSearchParams({ assessmentId, limit: "1", ...params }).toString();
  const [all, awaiting, gradedOrLater, released] = await Promise.all([
    adminApi<CountResponse>(`/admin/attempts?${q({})}`),
    adminApi<CountResponse>(`/admin/attempts?${q({ status: ATTEMPT_AWAITING_STATUSES })}`),
    adminApi<CountResponse>(`/admin/attempts?${q({ status: "graded,released" })}`),
    adminApi<CountResponse>(`/admin/attempts?${q({ status: "released" })}`),
  ]);
  const attempts: ChecklistAttemptCounts = {
    all: safeCount(all.total),
    awaiting: safeCount(awaiting.total),
    gradedOrLater: safeCount(gradedOrLater.total),
    released: safeCount(released.total),
  };
  const inv = first?.invitations ?? {};
  const invitations: ChecklistInvitationCounts = {
    total: safeCount(inv.total),
    viewed: safeCount(inv.viewed),
    started: safeCount(inv.started),
    submitted: safeCount(inv.submitted),
  };
  return { steps: buildChecklistSteps({ assessmentId, invitations, attempts }), assessmentId };
}

export function RunAssessmentChecklist(): React.ReactElement {
  const navigate = useNavigate();
  const [state, setState] = useState<ChecklistState | null>(null);
  const [error, setError] = useState(false);
  const [forceOpen, setForceOpen] = useState(false);

  const refresh = useCallback(async (isActive: () => boolean) => {
    try {
      const next = await loadChecklist();
      if (!isActive()) return;
      setState(next);
      setError(false);
    } catch {
      if (!isActive()) return;
      setError(true);
    }
  }, []);

  useEffect(() => {
    let active = true;
    const isActive = () => active;
    void refresh(isActive);
    const timer = setInterval(() => void refresh(isActive), POLL_MS);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [refresh]);

  const steps = state?.steps ?? [];
  const assessmentId = state?.assessmentId ?? null;
  const done = state !== null && allStepsDone(steps);

  if (done && !forceOpen) {
    return (
      <div>
        <button
          type="button"
          className="aiq-btn aiq-btn-ghost aiq-btn-sm"
          onClick={() => setForceOpen(true)}
        >
          <HelpTip helpId="admin.dashboard.home.checklist.reopen"><span>Show the assessment checklist</span></HelpTip>
        </button>
      </div>
    );
  }

  const stepById = new Map(steps.map((s) => [s.id, s.done]));

  return (
    <section className="aiq-card" aria-labelledby="home-checklist-title" style={{ padding: "var(--aiq-space-lg)" }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--aiq-space-md)", justifyContent: "space-between", alignItems: "center", marginBottom: "var(--aiq-space-md)" }}>
        <HelpTip helpId="admin.dashboard.home.checklist">
          <h2 id="home-checklist-title" style={{ fontFamily: "var(--aiq-font-serif)", fontSize: "var(--aiq-text-xl)", fontWeight: 500, margin: 0, color: "var(--aiq-color-fg-primary)" }}>
            Run an assessment
          </h2>
        </HelpTip>
        <button
          type="button"
          className="aiq-btn aiq-btn-primary"
          onClick={() => navigate("/admin/start-test")}
        >
          <HelpTip helpId="admin.dashboard.home.checklist.start_test"><span>Start a test</span></HelpTip>
        </button>
      </div>

      {error && (
        <div role="status" style={{ color: "var(--aiq-color-danger)", fontSize: "var(--aiq-text-sm)", marginBottom: "var(--aiq-space-sm)" }}>
          {FALLBACK_ERROR}
        </div>
      )}

      <ol style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "var(--aiq-space-sm)" }}>
        {STEP_ORDER.map((id, index) => {
          const isDone = stepById.get(id) === true;
          const meta = STEP_LABELS[id];
          return (
            <li key={id} style={{ display: "flex", gap: "var(--aiq-space-sm)", alignItems: "flex-start" }}>
              <span
                aria-hidden="true"
                style={{
                  flexShrink: 0,
                  width: 24,
                  height: 24,
                  borderRadius: "50%",
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: "var(--aiq-text-xs)",
                  border: "1px solid var(--aiq-color-border)",
                  background: isDone ? "var(--aiq-color-fg-primary)" : "transparent",
                  color: isDone ? "var(--aiq-color-bg)" : "var(--aiq-color-fg-muted)",
                }}
              >
                {isDone ? "✓" : String(index + 1)}
              </span>
              <Link
                to={stepHref(id, assessmentId)}
                style={{ color: "var(--aiq-color-fg-primary)", fontSize: "var(--aiq-text-sm)", textDecoration: isDone ? "line-through" : "none" }}
              >
                <HelpTip helpId={meta.help}><span>{meta.label}</span></HelpTip>
              </Link>
              <span style={VISUALLY_HIDDEN}>{isDone ? " (done)" : " (to do)"}</span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
