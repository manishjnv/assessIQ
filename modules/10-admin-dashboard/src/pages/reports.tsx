// AssessIQ — Admin Reports landing page.
//
// /admin/reports — two-section landing for Cohort and Individual reporting.
//
// ── Backend note (2026-05-04) ──────────────────────────────────────────────
// No dedicated report-list endpoints exist as of this session.
// FALLBACK per spec: consume existing endpoints:
//   Cohort list:     GET /admin/assessments?pageSize=50
//                    (filtered client-side to non-draft assessments)
//   Individual list: GET /admin/attempts?status=released&limit=20
//                    (recent released attempts; individual reports keyed by
//                    user_id, fetched from attempt.user_id if present)
//
// FLAG for follow-up session: land dedicated endpoints to clean this up:
//   GET /api/admin/reports/cycles         (assessments eligible for cohort)
//   GET /api/admin/reports/recent-attempts (individuals ready for reporting)
// ──────────────────────────────────────────────────────────────────────────
//
// INVARIANTS:
//  - No claude/anthropic imports or copy.
//  - No hardcoded test data; empty-states only.

import React, { useEffect, useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { AdminShell } from "../components/AdminShell.js";
import { adminApi, AdminApiError } from "../api.js";

interface AssessmentItem {
  id: string;
  name: string;
  status: string;
  closes_at: string | null;
}

interface AssessmentsResponse {
  items: AssessmentItem[];
  total: number;
}

interface AttemptItem {
  id: string;
  user_id?: string;
  candidate_email: string;
  assessment_name: string;
  status: string;
  submitted_at: string | null;
}

interface AttemptsResponse {
  items: AttemptItem[];
  total: number;
}

// Card section wrapper — consistent with the editorial card pattern from
// docs/10-branding-guideline.md: thin border, no box-shadow, bg-raised header.
function ReportSection({
  title,
  description,
  loading,
  error,
  children,
  emptyMessage,
  isEmpty,
}: {
  title: string;
  description: string;
  loading: boolean;
  error: string | null;
  children: React.ReactNode;
  emptyMessage: string;
  isEmpty: boolean;
}): React.ReactElement {
  return (
    <div
      style={{
        border: "1px solid var(--aiq-color-border)",
        borderRadius: "var(--aiq-radius-md)",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          padding: "var(--aiq-space-md) var(--aiq-space-lg)",
          background: "var(--aiq-color-bg-raised)",
          borderBottom: "1px solid var(--aiq-color-border)",
        }}
      >
        <h2
          style={{
            fontFamily: "var(--aiq-font-serif)",
            fontSize: "var(--aiq-text-xl)",
            fontWeight: 400,
            margin: 0,
            letterSpacing: "-0.015em",
          }}
        >
          {title}
        </h2>
        <p
          style={{
            fontFamily: "var(--aiq-font-sans)",
            fontSize: "var(--aiq-text-sm)",
            color: "var(--aiq-color-fg-secondary)",
            margin: "var(--aiq-space-xs) 0 0",
          }}
        >
          {description}
        </p>
      </div>
      <div style={{ padding: "var(--aiq-space-sm) 0" }}>
        {error && (
          <div
            style={{
              padding: "var(--aiq-space-md) var(--aiq-space-lg)",
              color: "var(--aiq-color-danger)",
              fontFamily: "var(--aiq-font-sans)",
              fontSize: "var(--aiq-text-sm)",
            }}
          >
            {error}
          </div>
        )}
        {loading ? (
          <div
            style={{
              padding: "var(--aiq-space-md) var(--aiq-space-lg)",
              color: "var(--aiq-color-fg-muted)",
              fontFamily: "var(--aiq-font-sans)",
              fontSize: "var(--aiq-text-sm)",
            }}
          >
            Loading…
          </div>
        ) : isEmpty ? (
          <div
            style={{
              padding: "var(--aiq-space-xl) var(--aiq-space-lg)",
              textAlign: "center",
              color: "var(--aiq-color-fg-muted)",
            }}
          >
            <p
              style={{
                fontFamily: "var(--aiq-font-sans)",
                fontSize: "var(--aiq-text-sm)",
                margin: 0,
              }}
            >
              {emptyMessage}
            </p>
          </div>
        ) : (
          children
        )}
      </div>
    </div>
  );
}

export function AdminReports(): React.ReactElement {
  const navigate = useNavigate();

  const [assessments, setAssessments] = useState<AssessmentItem[]>([]);
  const [attempts, setAttempts] = useState<AttemptItem[]>([]);
  const [loadingAssessments, setLoadingAssessments] = useState(true);
  const [loadingAttempts, setLoadingAttempts] = useState(true);
  const [assessmentsError, setAssessmentsError] = useState<string | null>(null);
  const [attemptsError, setAttemptsError] = useState<string | null>(null);

  const fetchAssessments = useCallback(async () => {
    setLoadingAssessments(true);
    setAssessmentsError(null);
    try {
      // Fallback: show all non-draft assessments as cohort report candidates.
      // Follow-up: replace with GET /api/admin/reports/cycles when that lands.
      const data = await adminApi<AssessmentsResponse>("/admin/assessments?pageSize=50");
      setAssessments(data.items.filter((a) => a.status !== "draft"));
    } catch (err) {
      setAssessmentsError(
        err instanceof AdminApiError ? err.apiError.message : "Failed to load assessments.",
      );
    } finally {
      setLoadingAssessments(false);
    }
  }, []);

  const fetchAttempts = useCallback(async () => {
    setLoadingAttempts(true);
    setAttemptsError(null);
    try {
      // Fallback: recent released attempts for individual report entry points.
      // Follow-up: replace with GET /api/admin/reports/recent-attempts when that lands.
      const data = await adminApi<AttemptsResponse>(
        "/admin/attempts?status=released&limit=20",
      );
      setAttempts(data.items);
    } catch (err) {
      setAttemptsError(
        err instanceof AdminApiError ? err.apiError.message : "Failed to load attempts.",
      );
    } finally {
      setLoadingAttempts(false);
    }
  }, []);

  useEffect(() => {
    void fetchAssessments();
    void fetchAttempts();
  }, [fetchAssessments, fetchAttempts]);

  // Deduplicate attempts by user_id so individual section shows one row per person.
  const seenUserIds = new Set<string>();
  const uniqueAttempts = attempts.filter((a) => {
    const key = a.user_id ?? a.candidate_email;
    if (seenUserIds.has(key)) return false;
    seenUserIds.add(key);
    return true;
  });

  return (
    <AdminShell breadcrumbs={["Reports"]} helpPage="admin.reports.landing">
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-xl)" }}>
        <h1
          style={{
            fontFamily: "var(--aiq-font-serif)",
            fontSize: "var(--aiq-text-3xl)",
            fontWeight: 400,
            margin: 0,
            letterSpacing: "-0.02em",
          }}
        >
          Reports.
        </h1>

        {/* Cohort reports */}
        <ReportSection
          title="Cohort reports."
          description="Score distribution, archetype mix, and top performers per assessment."
          loading={loadingAssessments}
          error={assessmentsError}
          isEmpty={assessments.length === 0}
          emptyMessage="No assessments with data yet. Publish an assessment and collect attempts first."
        >
          {assessments.map((a, i) => (
            <div
              key={a.id}
              role="button"
              tabIndex={0}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "var(--aiq-space-sm) var(--aiq-space-lg)",
                borderBottom:
                  i < assessments.length - 1 ? "1px solid var(--aiq-color-border)" : "none",
                cursor: "pointer",
              }}
              onClick={() => navigate(`/admin/reports/cohort/${a.id}`)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") navigate(`/admin/reports/cohort/${a.id}`);
              }}
            >
              <div>
                <span
                  style={{
                    fontFamily: "var(--aiq-font-sans)",
                    fontWeight: 500,
                    fontSize: "var(--aiq-text-sm)",
                    display: "block",
                  }}
                >
                  {a.name}
                </span>
                {a.closes_at && (
                  <span
                    style={{
                      fontFamily: "var(--aiq-font-mono)",
                      fontSize: "var(--aiq-text-xs)",
                      color: "var(--aiq-color-fg-muted)",
                      textTransform: "uppercase",
                      letterSpacing: "0.04em",
                    }}
                  >
                    Closed {new Date(a.closes_at).toLocaleDateString()}
                  </span>
                )}
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: "var(--aiq-space-sm)" }}>
                <span
                  style={{
                    fontFamily: "var(--aiq-font-mono)",
                    fontSize: "var(--aiq-text-xs)",
                    color: "var(--aiq-color-fg-muted)",
                    textTransform: "uppercase",
                    letterSpacing: "0.04em",
                  }}
                >
                  {a.status}
                </span>
                <button
                  type="button"
                  className="aiq-btn aiq-btn-outline aiq-btn-sm"
                  onClick={(e) => {
                    e.stopPropagation();
                    navigate(`/admin/reports/cohort/${a.id}`);
                  }}
                >
                  View report
                </button>
              </div>
            </div>
          ))}
        </ReportSection>

        {/* Individual reports */}
        <ReportSection
          title="Individual reports."
          description="Per-candidate score history and progression across assessments."
          loading={loadingAttempts}
          error={attemptsError}
          isEmpty={uniqueAttempts.length === 0}
          emptyMessage="No graded and released attempts yet."
        >
          {uniqueAttempts.map((a, i) => {
            // Individual report route uses userId; fall back to email as the
            // identifier if user_id is absent from the attempts list response.
            const userId = a.user_id ?? encodeURIComponent(a.candidate_email);
            return (
              <div
                key={a.user_id ?? a.candidate_email}
                role="button"
                tabIndex={0}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  padding: "var(--aiq-space-sm) var(--aiq-space-lg)",
                  borderBottom:
                    i < uniqueAttempts.length - 1 ? "1px solid var(--aiq-color-border)" : "none",
                  cursor: "pointer",
                }}
                onClick={() => navigate(`/admin/reports/individual/${userId}`)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ")
                    navigate(`/admin/reports/individual/${userId}`);
                }}
              >
                <div>
                  <span
                    style={{
                      fontFamily: "var(--aiq-font-sans)",
                      fontWeight: 500,
                      fontSize: "var(--aiq-text-sm)",
                      display: "block",
                    }}
                  >
                    {a.candidate_email}
                  </span>
                  <span
                    style={{
                      fontFamily: "var(--aiq-font-mono)",
                      fontSize: "var(--aiq-text-xs)",
                      color: "var(--aiq-color-fg-muted)",
                      textTransform: "uppercase",
                      letterSpacing: "0.04em",
                    }}
                  >
                    {a.assessment_name}
                    {a.submitted_at
                      ? ` · ${new Date(a.submitted_at).toLocaleDateString()}`
                      : ""}
                  </span>
                </div>
                <button
                  type="button"
                  className="aiq-btn aiq-btn-outline aiq-btn-sm"
                  onClick={(e) => {
                    e.stopPropagation();
                    navigate(`/admin/reports/individual/${userId}`);
                  }}
                >
                  View report
                </button>
              </div>
            );
          })}
        </ReportSection>
      </div>
    </AdminShell>
  );
}
