// AssessIQ — Admin Assessments list page.
//
// /admin/assessments — list of assessment cycles in the current tenant.
//
// NOTE: "Cycles" in the original product spec maps to "Assessments" in the
// backend. The backend noun is "assessments" (05-assessment-lifecycle module).
// The sidebar nav label is "Assessments"; this note is here so future
// maintainers don't confuse the two terms.
//
// Filter state: URL query params (?status=draft) per CLAUDE.md anti-pattern
// guard (no localStorage / sessionStorage for filter state — shareable links,
// no cross-tenant leak risk).
//
// "+ New Assessment" opens an inline form (consistent with question-bank.tsx).
//
// Phase 2 Slice A — Blueprint Builder (C5):
//   The "Use Blueprint" toggle switches the form to blueprint mode.
//   Domain → Level → Criteria rows (Category + Type + Count) → Save sends
//   settings.blueprint. Live preview adequacy from GET /:id/preview (C4).
//   Assign = existing invite flow on assessment-detail (unchanged).
//
// INVARIANTS:
//  - No claude/anthropic imports or copy.
//  - Filter state in URL query params only.
//  - Empty-state renders; no hardcoded fake rows.
//  - No new invite backend. No manual authoring. No swap endpoint.

import React, { useEffect, useState, useCallback } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Chip, Table } from "@assessiq/ui-system";
import type { ColumnDef } from "@assessiq/ui-system";
import { AdminShell } from "../components/AdminShell.js";
import { adminApi, AdminApiError, listDomainsApi, listCategoriesApi } from "../api.js";
import type { DomainItem, CategoryItem } from "../api.js";

type AssessmentStatus = "draft" | "published" | "active" | "closed";

interface InvitationCounts {
  total: number;
  pending: number;
  viewed: number;
  started: number;
  submitted: number;
  expired: number;
}

interface AssessmentListItem {
  id: string;
  name: string;
  status: AssessmentStatus;
  pack_id: string | null;
  opens_at: string | null;
  closes_at: string | null;
  created_at: string;
  invitations?: InvitationCounts;
}

interface AssessmentsResponse {
  items: AssessmentListItem[];
  total: number;
}

// ---------------------------------------------------------------------------
// Blueprint types (mirrors Phase 2 types.ts shape — no import from backend)
// ---------------------------------------------------------------------------

type BlueprintLevel = "L1" | "L2" | "L3";
const BLUEPRINT_LEVELS: BlueprintLevel[] = ["L1", "L2", "L3"];

type BlueprintQuestionType = "mcq" | "scenario" | "subjective" | "kql" | "log_analysis";
const BLUEPRINT_QUESTION_TYPES: BlueprintQuestionType[] = [
  "mcq",
  "scenario",
  "subjective",
  "kql",
  "log_analysis",
];

interface BlueprintCriterion {
  category_id: string;
  type: BlueprintQuestionType;
  count: number;
}

interface BlueprintPreviewCriterion {
  criterion_index: number;
  category_id: string;
  type: string;
  required: number;
  available: number;
  sample: unknown[];
}

interface BlueprintPreviewResponse {
  blueprint_criteria?: BlueprintPreviewCriterion[];
  pool_size: number;
  question_count: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const STATUS_TABS: { label: string; value: string }[] = [
  { label: "All", value: "" },
  { label: "Draft", value: "draft" },
  { label: "Published", value: "published" },
  { label: "Active", value: "active" },
  { label: "Closed", value: "closed" },
];

function assessmentStatusColor(s: string): { bg: string; color: string } {
  switch (s) {
    case "active":
      return { bg: "var(--aiq-color-success-soft)", color: "var(--aiq-color-success)" };
    case "published":
      return { bg: "var(--aiq-color-accent-soft)", color: "var(--aiq-color-accent)" };
    case "closed":
      return { bg: "var(--aiq-color-bg-sunken)", color: "var(--aiq-color-fg-muted)" };
    default:
      return { bg: "var(--aiq-color-bg-sunken)", color: "var(--aiq-color-fg-secondary)" };
  }
}

function criterionTotal(criteria: BlueprintCriterion[]): number {
  return criteria.reduce((sum, c) => sum + c.count, 0);
}

// ---------------------------------------------------------------------------
// BlueprintBuilder sub-component
// ---------------------------------------------------------------------------
//
// Isolated to keep AdminAssessments readable. Receives domain list + a callback
// to push the assembled blueprint up to the parent form.

interface BlueprintBuilderProps {
  onBlueprintChange: (bp: { domain_id: string; level: BlueprintLevel; criteria: BlueprintCriterion[] } | null) => void;
}

function BlueprintBuilder({ onBlueprintChange }: BlueprintBuilderProps): React.ReactElement {
  const [domains, setDomains] = useState<DomainItem[]>([]);
  const [domainsLoading, setDomainsLoading] = useState(true);
  const [domainsError, setDomainsError] = useState<string | null>(null);

  const [selectedDomainId, setSelectedDomainId] = useState<string>("");
  const [selectedLevel, setSelectedLevel] = useState<BlueprintLevel>("L1");

  const [categories, setCategories] = useState<CategoryItem[]>([]);
  const [categoriesLoading, setCategoriesLoading] = useState(false);

  const [criteria, setCriteria] = useState<BlueprintCriterion[]>([]);

  // Load domains on mount
  useEffect(() => {
    void (async () => {
      setDomainsLoading(true);
      try {
        const data = await listDomainsApi();
        setDomains(data.items.filter((d) => d.status === "active"));
      } catch (err) {
        setDomainsError(
          err instanceof AdminApiError ? err.apiError.message : "Failed to load domains.",
        );
      } finally {
        setDomainsLoading(false);
      }
    })();
  }, []);

  // Load categories when domain changes
  useEffect(() => {
    if (!selectedDomainId) {
      setCategories([]);
      setCriteria([]);
      return;
    }
    void (async () => {
      setCategoriesLoading(true);
      try {
        const data = await listCategoriesApi(selectedDomainId);
        setCategories(data.items.filter((c) => c.status === "active"));
      } finally {
        setCategoriesLoading(false);
      }
    })();
  }, [selectedDomainId]);

  // Notify parent whenever blueprint changes
  useEffect(() => {
    if (!selectedDomainId || criteria.length === 0) {
      onBlueprintChange(null);
      return;
    }
    // Only push if every criterion has a category + type + count >= 1
    const valid = criteria.every(
      (c) => c.category_id && c.type && c.count >= 1,
    );
    if (!valid) {
      onBlueprintChange(null);
      return;
    }
    onBlueprintChange({ domain_id: selectedDomainId, level: selectedLevel, criteria });
  }, [selectedDomainId, selectedLevel, criteria, onBlueprintChange]);

  function addCriterion() {
    setCriteria((prev) => [
      ...prev,
      { category_id: "", type: "mcq", count: 5 },
    ]);
  }

  function removeCriterion(idx: number) {
    setCriteria((prev) => prev.filter((_, i) => i !== idx));
  }

  function updateCriterion(idx: number, patch: Partial<BlueprintCriterion>) {
    setCriteria((prev) =>
      prev.map((c, i) => (i === idx ? { ...c, ...patch } : c)),
    );
  }

  const total = criterionTotal(criteria);

  const labelStyle: React.CSSProperties = {
    fontFamily: "var(--aiq-font-sans)",
    fontSize: "var(--aiq-text-xs)",
    fontWeight: 600,
    color: "var(--aiq-color-fg-muted)",
    textTransform: "uppercase",
    letterSpacing: "0.06em",
    marginBottom: 4,
  };

  return (
    <div
      style={{
        border: "1px solid var(--aiq-color-border)",
        borderRadius: "var(--aiq-radius-sm)",
        padding: "var(--aiq-space-md)",
        background: "var(--aiq-color-bg-sunken)",
        display: "flex",
        flexDirection: "column",
        gap: "var(--aiq-space-md)",
      }}
    >
      <p
        style={{
          fontFamily: "var(--aiq-font-sans)",
          fontSize: "var(--aiq-text-xs)",
          color: "var(--aiq-color-fg-muted)",
          margin: 0,
        }}
      >
        Blueprint mode: each candidate draws a fresh random set per criterion. Domain + Level resolve
        the question pack automatically.
      </p>

      {domainsError && (
        <div style={{ color: "var(--aiq-color-error, #dc2626)", fontSize: "var(--aiq-text-xs)" }}>
          {domainsError}
        </div>
      )}

      {/* Domain + Level row */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: "var(--aiq-space-md)" }}>
        <div>
          <div style={labelStyle}>Domain</div>
          {domainsLoading ? (
            <span style={{ fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-sm)", color: "var(--aiq-color-fg-muted)" }}>
              Loading…
            </span>
          ) : (
            <select
              className="aiq-input"
              value={selectedDomainId}
              onChange={(e) => setSelectedDomainId(e.target.value)}
            >
              <option value="">— Select domain —</option>
              {domains.map((d) => (
                <option key={d.id} value={d.id}>{d.name}</option>
              ))}
            </select>
          )}
        </div>
        <div>
          <div style={labelStyle}>Level</div>
          <select
            className="aiq-input"
            value={selectedLevel}
            onChange={(e) => setSelectedLevel(e.target.value as BlueprintLevel)}
          >
            {BLUEPRINT_LEVELS.map((l) => (
              <option key={l} value={l}>{l}</option>
            ))}
          </select>
        </div>
      </div>

      {/* Criteria table */}
      {selectedDomainId && (
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-sm)" }}>
          <div style={labelStyle}>Criteria</div>

          {categoriesLoading && (
            <span style={{ fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-sm)", color: "var(--aiq-color-fg-muted)" }}>
              Loading categories…
            </span>
          )}

          {!categoriesLoading && categories.length === 0 && (
            <span style={{ fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-sm)", color: "var(--aiq-color-fg-muted)" }}>
              No active categories in this domain.
            </span>
          )}

          {criteria.map((criterion, idx) => (
            <div
              key={idx}
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr 80px auto",
                gap: "var(--aiq-space-sm)",
                alignItems: "center",
              }}
            >
              <select
                className="aiq-input"
                value={criterion.category_id}
                onChange={(e) => updateCriterion(idx, { category_id: e.target.value })}
              >
                <option value="">— Category —</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>

              <select
                className="aiq-input"
                value={criterion.type}
                onChange={(e) => updateCriterion(idx, { type: e.target.value as BlueprintQuestionType })}
              >
                {BLUEPRINT_QUESTION_TYPES.map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>

              <input
                className="aiq-input"
                type="number"
                min={1}
                value={criterion.count}
                onChange={(e) =>
                  updateCriterion(idx, { count: Math.max(1, parseInt(e.target.value, 10) || 1) })
                }
                style={{ textAlign: "center" }}
              />

              <button
                type="button"
                className="aiq-btn aiq-btn-outline aiq-btn-sm"
                onClick={() => removeCriterion(idx)}
                style={{ color: "var(--aiq-color-error, #dc2626)" }}
                aria-label="Remove criterion"
              >
                ×
              </button>
            </div>
          ))}

          <button
            type="button"
            className="aiq-btn aiq-btn-outline aiq-btn-sm"
            onClick={addCriterion}
            disabled={categories.length === 0}
          >
            + Add criterion
          </button>

          {/* Live total */}
          {criteria.length > 0 && (
            <div
              style={{
                fontFamily: "var(--aiq-font-mono)",
                fontSize: "var(--aiq-text-sm)",
                color: total > 0 ? "var(--aiq-color-fg-primary)" : "var(--aiq-color-fg-muted)",
                fontWeight: 600,
              }}
            >
              Total: {total} question{total !== 1 ? "s" : ""}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// PreviewAdequacy sub-component — shows C4 blueprint preview after creation
// ---------------------------------------------------------------------------

interface PreviewAdequacyProps {
  assessmentId: string;
}

function PreviewAdequacy({ assessmentId }: PreviewAdequacyProps): React.ReactElement {
  const [preview, setPreview] = useState<BlueprintPreviewResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      setLoading(true);
      try {
        const data = await adminApi<BlueprintPreviewResponse>(
          `/admin/assessments/${assessmentId}/preview`,
        );
        setPreview(data);
      } catch (err) {
        setError(
          err instanceof AdminApiError ? err.apiError.message : "Failed to load preview.",
        );
      } finally {
        setLoading(false);
      }
    })();
  }, [assessmentId]);

  if (loading) {
    return (
      <span style={{ fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-xs)", color: "var(--aiq-color-fg-muted)" }}>
        Checking pool adequacy…
      </span>
    );
  }

  if (error) {
    return (
      <span style={{ fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-xs)", color: "var(--aiq-color-error, #dc2626)" }}>
        {error}
      </span>
    );
  }

  if (!preview?.blueprint_criteria) {
    return (
      <span style={{ fontFamily: "var(--aiq-font-mono)", fontSize: "var(--aiq-text-xs)", color: "var(--aiq-color-fg-muted)" }}>
        Pool size: {preview?.pool_size ?? "—"} / {preview?.question_count ?? "—"} required
      </span>
    );
  }

  const allAdequate = preview.blueprint_criteria.every((c) => c.available >= c.required);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      {preview.blueprint_criteria.map((c) => {
        const ok = c.available >= c.required;
        return (
          <div
            key={c.criterion_index}
            style={{
              fontFamily: "var(--aiq-font-mono)",
              fontSize: "var(--aiq-text-xs)",
              color: ok ? "var(--aiq-color-success)" : "var(--aiq-color-error, #dc2626)",
            }}
          >
            {ok ? "✓" : "✗"} {c.type} — {c.available}/{c.required} available
          </div>
        );
      })}
      {allAdequate && (
        <div style={{ fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-xs)", color: "var(--aiq-color-success)", fontWeight: 600 }}>
          Pool adequate — ready to publish.
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// AdminAssessments — main page
// ---------------------------------------------------------------------------

interface NewAssessmentForm {
  name: string;
  opens_at: string;
  closes_at: string;
}

export function AdminAssessments(): React.ReactElement {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const statusFilter = searchParams.get("status") ?? "";

  const [items, setItems] = useState<AssessmentListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [showNewForm, setShowNewForm] = useState(false);
  const [newForm, setNewForm] = useState<NewAssessmentForm>({
    name: "",
    opens_at: "",
    closes_at: "",
  });
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  // Blueprint mode state
  const [useBlueprintMode, setUseBlueprintMode] = useState(false);
  const [pendingBlueprint, setPendingBlueprint] = useState<{
    domain_id: string;
    level: BlueprintLevel;
    criteria: BlueprintCriterion[];
  } | null>(null);

  // Created assessment ID for preview adequacy display
  const [createdAssessmentId, setCreatedAssessmentId] = useState<string | null>(null);

  const fetchAssessments = useCallback(async (status: string) => {
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams({ pageSize: "100" });
      if (status) qs.set("status", status);
      const data = await adminApi<AssessmentsResponse>(`/admin/assessments?${qs.toString()}`);
      setItems(data.items);
    } catch (err) {
      setError(
        err instanceof AdminApiError
          ? err.apiError.message
          : "Failed to load assessments.",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchAssessments(statusFilter);
  }, [fetchAssessments, statusFilter]);

  function handleStatusChange(val: string) {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (val) next.set("status", val);
        else next.delete("status");
        return next;
      },
      { replace: true },
    );
  }

  async function handleCreateAssessment(e: React.FormEvent) {
    e.preventDefault();
    if (!newForm.name.trim()) {
      setCreateError("Assessment name is required.");
      return;
    }
    if (useBlueprintMode && pendingBlueprint === null) {
      setCreateError("Blueprint is incomplete. Select a domain, level, and at least one valid criterion.");
      return;
    }
    setCreating(true);
    setCreateError(null);
    setCreatedAssessmentId(null);
    try {
      const body: Record<string, unknown> = { name: newForm.name.trim() };
      if (newForm.opens_at) body.opens_at = new Date(newForm.opens_at).toISOString();
      if (newForm.closes_at) body.closes_at = new Date(newForm.closes_at).toISOString();

      if (useBlueprintMode && pendingBlueprint !== null) {
        // Blueprint mode: send settings.blueprint; backend resolves pack/level/question_count
        body.settings = { blueprint: pendingBlueprint };
        // question_count placeholder — backend overrides via Σcriteria.count
        body.question_count = pendingBlueprint.criteria.reduce((s, c) => s + c.count, 0);
        // pack_id / level_id resolved by findOrCreatePackForDomain on backend
        body.pack_id = "";
        body.level_id = "";
      }

      const created = await adminApi<{ id: string }>("/admin/assessments", {
        method: "POST",
        body: JSON.stringify(body),
      });

      if (useBlueprintMode) {
        // Show adequacy preview before navigating
        setCreatedAssessmentId(created.id);
        // Also refresh the list
        void fetchAssessments(statusFilter);
        setCreating(false);
      } else {
        navigate(`/admin/assessments/${created.id}`);
      }
    } catch (err) {
      setCreateError(
        err instanceof AdminApiError
          ? err.apiError.message
          : "Failed to create assessment.",
      );
      setCreating(false);
    }
  }

  const columns: ColumnDef<AssessmentListItem>[] = [
    {
      key: "name",
      label: "Name",
      render: (row: AssessmentListItem) => (
        <span
          style={{
            fontFamily: "var(--aiq-font-sans)",
            fontWeight: 500,
            fontSize: "var(--aiq-text-sm)",
          }}
        >
          {row.name}
        </span>
      ),
    },
    {
      key: "status",
      label: "Status",
      render: (row: AssessmentListItem) => {
        const c = assessmentStatusColor(row.status);
        return (
          <span
            style={{
              fontFamily: "var(--aiq-font-mono)",
              fontSize: "var(--aiq-text-xs)",
              textTransform: "uppercase",
              letterSpacing: "0.04em",
              padding: "1px 8px",
              borderRadius: "var(--aiq-radius-pill)",
              background: c.bg,
              color: c.color,
            }}
          >
            {row.status}
          </span>
        );
      },
    },
    {
      key: "invitations",
      label: "Invited",
      render: (row: AssessmentListItem) => {
        const inv = row.invitations;
        const total = inv?.total ?? 0;
        if (total === 0) {
          return (
            <span
              style={{
                fontFamily: "var(--aiq-font-mono)",
                fontSize: "var(--aiq-text-xs)",
                color: "var(--aiq-color-fg-muted)",
              }}
            >
              —
            </span>
          );
        }
        const nonPending = total - (inv?.pending ?? 0);
        return (
          <span
            style={{
              display: "inline-flex",
              flexDirection: "column",
              gap: "2px",
              fontFamily: "var(--aiq-font-mono)",
              fontSize: "var(--aiq-text-xs)",
            }}
          >
            <span style={{ fontWeight: 600 }}>{total} invited</span>
            <span style={{ color: "var(--aiq-color-fg-muted)" }}>
              {nonPending} sent · {inv?.pending ?? 0} pending
            </span>
          </span>
        );
      },
    },
    {
      key: "opens_at",
      label: "Opens",
      render: (row: AssessmentListItem) => (
        <span
          style={{
            fontFamily: "var(--aiq-font-mono)",
            fontSize: "var(--aiq-text-xs)",
            color: "var(--aiq-color-fg-muted)",
          }}
        >
          {row.opens_at ? new Date(row.opens_at).toLocaleDateString() : "—"}
        </span>
      ),
    },
    {
      key: "closes_at",
      label: "Closes",
      render: (row: AssessmentListItem) => (
        <span
          style={{
            fontFamily: "var(--aiq-font-mono)",
            fontSize: "var(--aiq-text-xs)",
            color: "var(--aiq-color-fg-muted)",
          }}
        >
          {row.closes_at ? new Date(row.closes_at).toLocaleDateString() : "—"}
        </span>
      ),
    },
    {
      key: "created_at",
      label: "Created",
      render: (row: AssessmentListItem) => (
        <span
          style={{
            fontFamily: "var(--aiq-font-mono)",
            fontSize: "var(--aiq-text-xs)",
            color: "var(--aiq-color-fg-muted)",
          }}
        >
          {new Date(row.created_at).toLocaleDateString()}
        </span>
      ),
    },
    {
      key: "action",
      label: "",
      width: 80,
      render: (row: AssessmentListItem) => (
        <button
          type="button"
          className="aiq-btn aiq-btn-outline aiq-btn-sm"
          onClick={(e) => {
            e.stopPropagation();
            navigate(`/admin/assessments/${row.id}`);
          }}
        >
          Open
        </button>
      ),
    },
  ];

  return (
    <AdminShell breadcrumbs={["Assessments"]} helpPage="admin.assessments.list">
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-xl)" }}>
        {/* Page header — count chip + serif h1 + lede + action */}
        <div>
          <div style={{ marginBottom: 12 }}>
            <Chip leftIcon="grid">{items.length} assessment{items.length !== 1 ? "s" : ""}</Chip>
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "flex-start",
              justifyContent: "space-between",
              gap: "var(--aiq-space-md)",
            }}
          >
            <div>
              <h1
                style={{
                  fontFamily: "var(--aiq-font-serif)",
                  fontSize: "var(--aiq-text-3xl)",
                  fontWeight: 400,
                  margin: 0,
                  letterSpacing: "-0.02em",
                }}
              >
                Assessments.
              </h1>
              <p style={{ fontSize: 14, color: "var(--aiq-color-fg-secondary)", margin: "8px 0 0", lineHeight: 1.5 }}>
                Assessment cycles — set dates, invite candidates, track completion.
              </p>
            </div>
            <button
              type="button"
              className="aiq-btn aiq-btn-primary"
              onClick={() => {
                setShowNewForm((v) => !v);
                setCreateError(null);
                setCreatedAssessmentId(null);
              }}
            >
              {showNewForm ? "Cancel" : "+ New Assessment"}
            </button>
          </div>
        </div>

        {/* Inline new-assessment form */}
        {showNewForm && (
          <div
            style={{
              border: "1px solid var(--aiq-color-border)",
              borderRadius: "var(--aiq-radius-md)",
              padding: "var(--aiq-space-lg)",
              background: "var(--aiq-color-bg-raised)",
            }}
          >
            <h2
              style={{
                fontFamily: "var(--aiq-font-serif)",
                fontSize: "var(--aiq-text-xl)",
                fontWeight: 400,
                margin: "0 0 var(--aiq-space-md)",
                letterSpacing: "-0.015em",
              }}
            >
              New assessment.
            </h2>

            {/* Blueprint mode toggle */}
            <div style={{ marginBottom: "var(--aiq-space-md)" }}>
              <label
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "var(--aiq-space-sm)",
                  cursor: "pointer",
                  fontFamily: "var(--aiq-font-sans)",
                  fontSize: "var(--aiq-text-sm)",
                }}
              >
                <input
                  type="checkbox"
                  checked={useBlueprintMode}
                  onChange={(e) => {
                    setUseBlueprintMode(e.target.checked);
                    setPendingBlueprint(null);
                    setCreatedAssessmentId(null);
                  }}
                />
                <span>
                  Use Blueprint{" "}
                  <span style={{ fontFamily: "var(--aiq-font-mono)", fontSize: "var(--aiq-text-xs)", color: "var(--aiq-color-fg-muted)" }}>
                    (per-criterion random draw — auto-resolves pack/level)
                  </span>
                </span>
              </label>
            </div>

            <form onSubmit={(e) => void handleCreateAssessment(e)}>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 1fr",
                  gap: "var(--aiq-space-md)",
                  marginBottom: "var(--aiq-space-md)",
                }}
              >
                {/* Name */}
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: "var(--aiq-space-xs)",
                    gridColumn: "1 / -1",
                  }}
                >
                  <label
                    style={{
                      fontFamily: "var(--aiq-font-sans)",
                      fontSize: "var(--aiq-text-sm)",
                      fontWeight: 500,
                    }}
                  >
                    Name *
                  </label>
                  <input
                    className="aiq-input"
                    type="text"
                    placeholder="e.g. SOC L1 — May 2026"
                    value={newForm.name}
                    onChange={(e) => setNewForm((f) => ({ ...f, name: e.target.value }))}
                    required
                  />
                </div>

                {/* Opens */}
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: "var(--aiq-space-xs)",
                  }}
                >
                  <label
                    style={{
                      fontFamily: "var(--aiq-font-sans)",
                      fontSize: "var(--aiq-text-sm)",
                      fontWeight: 500,
                    }}
                  >
                    Opens
                  </label>
                  <input
                    className="aiq-input"
                    type="datetime-local"
                    value={newForm.opens_at}
                    onChange={(e) => setNewForm((f) => ({ ...f, opens_at: e.target.value }))}
                  />
                </div>

                {/* Closes */}
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: "var(--aiq-space-xs)",
                  }}
                >
                  <label
                    style={{
                      fontFamily: "var(--aiq-font-sans)",
                      fontSize: "var(--aiq-text-sm)",
                      fontWeight: 500,
                    }}
                  >
                    Closes
                  </label>
                  <input
                    className="aiq-input"
                    type="datetime-local"
                    value={newForm.closes_at}
                    onChange={(e) => setNewForm((f) => ({ ...f, closes_at: e.target.value }))}
                  />
                </div>
              </div>

              {/* Blueprint builder — only shown when blueprint mode is on */}
              {useBlueprintMode && (
                <div style={{ marginBottom: "var(--aiq-space-md)" }}>
                  <BlueprintBuilder onBlueprintChange={setPendingBlueprint} />
                </div>
              )}

              {createError && (
                <div
                  style={{
                    color: "var(--aiq-color-danger)",
                    fontFamily: "var(--aiq-font-sans)",
                    fontSize: "var(--aiq-text-sm)",
                    marginBottom: "var(--aiq-space-sm)",
                  }}
                >
                  {createError}
                </div>
              )}

              {/* Blueprint adequacy preview — shown after successful blueprint creation */}
              {createdAssessmentId !== null && (
                <div
                  style={{
                    border: "1px solid var(--aiq-color-border)",
                    borderRadius: "var(--aiq-radius-sm)",
                    padding: "var(--aiq-space-md)",
                    marginBottom: "var(--aiq-space-md)",
                    background: "var(--aiq-color-bg-sunken)",
                  }}
                >
                  <div
                    style={{
                      fontFamily: "var(--aiq-font-sans)",
                      fontSize: "var(--aiq-text-sm)",
                      fontWeight: 600,
                      marginBottom: "var(--aiq-space-sm)",
                    }}
                  >
                    Assessment created — pool adequacy:
                  </div>
                  <PreviewAdequacy assessmentId={createdAssessmentId} />
                  <button
                    type="button"
                    className="aiq-btn aiq-btn-primary aiq-btn-sm"
                    style={{ marginTop: "var(--aiq-space-md)" }}
                    onClick={() => navigate(`/admin/assessments/${createdAssessmentId}`)}
                  >
                    Open assessment
                  </button>
                </div>
              )}

              {createdAssessmentId === null && (
                <button type="submit" className="aiq-btn aiq-btn-primary" disabled={creating}>
                  {creating ? "Creating…" : "Create assessment"}
                </button>
              )}
            </form>
          </div>
        )}

        {/* Filter chips */}
        <div style={{ display: "flex", gap: "var(--aiq-space-xs)", flexWrap: "wrap" }}>
          {STATUS_TABS.map((tab) => (
            <button
              key={tab.value}
              type="button"
              className={`aiq-btn aiq-btn-sm ${
                statusFilter === tab.value ? "aiq-btn-primary" : "aiq-btn-outline"
              }`}
              onClick={() => handleStatusChange(tab.value)}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {error && (
          <div
            style={{
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
              color: "var(--aiq-color-fg-muted)",
              fontFamily: "var(--aiq-font-sans)",
              fontSize: "var(--aiq-text-sm)",
              padding: "var(--aiq-space-xl) 0",
            }}
          >
            Loading…
          </div>
        ) : items.length === 0 ? (
          <div
            style={{
              textAlign: "center",
              padding: "var(--aiq-space-3xl) 0",
              color: "var(--aiq-color-fg-muted)",
            }}
          >
            <p
              style={{
                fontFamily: "var(--aiq-font-serif)",
                fontSize: "var(--aiq-text-xl)",
                fontWeight: 400,
                margin: "0 0 var(--aiq-space-sm)",
              }}
            >
              No assessments yet.
            </p>
            <p
              style={{
                fontFamily: "var(--aiq-font-sans)",
                fontSize: "var(--aiq-text-sm)",
                margin: 0,
              }}
            >
              Create an assessment to invite candidates and open a cycle.
            </p>
          </div>
        ) : (
          <Table
            columns={columns}
            data={items}
            emptyMessage="No assessments found."
          />
        )}
      </div>
    </AdminShell>
  );
}
