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
import { adminApi, AdminApiError, listDomainsApi, listCategoriesApi, getCompanyEntitlements, getCompanyUsage, getAvailableSets, createAssessmentFromSet } from "../api.js";
import type { DomainItem, CategoryItem, TenantEntitlement, CompanyUsage, AvailableSet } from "../api.js";
import { HelpTip } from "@assessiq/help-system/components";
import { UsageBanner } from "../components/UsageBanner.js";

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

interface BlueprintCriterion {
  category_id: string;
  type: string;
  count: number;
}

// One row in the blueprint builder UI.  Mirrors generate-wizard CategoryConfig.
// category = the selected CategoryItem; selectedTypes = checked types from supported_types.
// On submit: flatten to criteria [{category_id, type, count}] per checked type.
interface BlueprintCategoryRow {
  category: CategoryItem | null;  // null until admin picks a category
  selectedTypes: string[];
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
// Sort helper
// ---------------------------------------------------------------------------

type SortDir = "asc" | "desc";

/** Client-side row sort. Keys ending in `_at` sort as dates; numeric columns
 *  numerically; everything else case-insensitively. */
function sortRows<T>(rows: T[], key: string, dir: SortDir): T[] {
  const sign = dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const av = (a as unknown as Record<string, unknown>)[key];
    const bv = (b as unknown as Record<string, unknown>)[key];
    if (key.endsWith("_at")) {
      const at = av ? new Date(av as string).getTime() : 0;
      const bt = bv ? new Date(bv as string).getTime() : 0;
      return sign * (at - bt);
    }
    if (typeof av === "number" && typeof bv === "number") return sign * (av - bv);
    const as = String(av ?? "").toLowerCase();
    const bs = String(bv ?? "").toLowerCase();
    return as < bs ? -1 * sign : as > bs ? 1 * sign : 0;
  });
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

/** Compute live total = Σ(selectedTypes.length × count) across all category rows. */
function blueprintLiveTotal(rows: BlueprintCategoryRow[]): number {
  return rows.reduce((sum, r) => {
    if (r.category === null) return sum;
    return sum + r.selectedTypes.length * r.count;
  }, 0);
}

/**
 * Flatten category-rows to the backend criteria array shape:
 *   [{category_id, type, count}]  — one entry per checked type.
 * The backend blueprint JSON shape is UNCHANGED by this UX change.
 */
function flattenToCriteria(rows: BlueprintCategoryRow[]): BlueprintCriterion[] {
  const out: BlueprintCriterion[] = [];
  for (const row of rows) {
    if (row.category === null || row.selectedTypes.length === 0) continue;
    for (const t of row.selectedTypes) {
      out.push({ category_id: row.category.id, type: t, count: row.count });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// BlueprintBuilder sub-component (B2 — wizard-pattern, one row per category)
// ---------------------------------------------------------------------------
//
// Mirrors the generate-wizard category-row pattern:
//   Category select + supported_types checkboxes (disabled until category chosen)
//   + Count input (per checked type, same semantics as the wizard).
// On change: flattens to [{category_id, type, count}] via flattenToCriteria
// and pushes up to the parent. Backend blueprint shape is UNCHANGED.

interface BlueprintBuilderProps {
  onBlueprintChange: (bp: { domain_id: string; level: BlueprintLevel; criteria: BlueprintCriterion[] } | null) => void;
  /** Set of entitled domain scope_ids. null = fail-open (show all). Empty set + not null = no content enabled yet. */
  entitledDomains: Set<string> | null;
  /** When true, skip filtering entirely (internal/unlimited tenant). */
  skipFilter: boolean;
}

function BlueprintBuilder({ onBlueprintChange, entitledDomains, skipFilter }: BlueprintBuilderProps): React.ReactElement {
  const [domains, setDomains] = useState<DomainItem[]>([]);
  const [domainsLoading, setDomainsLoading] = useState(true);
  const [domainsError, setDomainsError] = useState<string | null>(null);

  const [selectedDomainId, setSelectedDomainId] = useState<string>("");
  const [selectedLevel, setSelectedLevel] = useState<BlueprintLevel>("L1");

  // Categories for the selected domain (fetched once per domain change)
  const [categories, setCategories] = useState<CategoryItem[]>([]);
  const [categoriesLoading, setCategoriesLoading] = useState(false);

  // One row per "Add category" click — wizard pattern
  const [categoryRows, setCategoryRows] = useState<BlueprintCategoryRow[]>([]);

  // Load domains on mount
  useEffect(() => {
    void (async () => {
      setDomainsLoading(true);
      try {
        const data = await listDomainsApi();
        const active = data.items.filter((d) => d.status === "active");
        // D3: filter to entitled domains unless skip (internal/unlimited) or fail-open (null).
        // Entitlement scope_id for domain type = question_packs.domain TEXT = DomainItem.slug.
        const filtered = (skipFilter || entitledDomains === null)
          ? active
          : active.filter((d) => entitledDomains.has(d.slug));
        setDomains(filtered);
      } catch (err) {
        setDomainsError(
          err instanceof AdminApiError ? err.apiError.message : "Failed to load domains.",
        );
      } finally {
        setDomainsLoading(false);
      }
    })();
  }, []);

  // Load categories when domain changes; reset rows
  useEffect(() => {
    if (!selectedDomainId) {
      setCategories([]);
      setCategoryRows([]);
      return;
    }
    void (async () => {
      setCategoriesLoading(true);
      try {
        const data = await listCategoriesApi(selectedDomainId);
        setCategories(data.items.filter((c) => c.status === "active"));
        // Reset rows when domain changes so stale category refs are cleared
        setCategoryRows([]);
      } finally {
        setCategoriesLoading(false);
      }
    })();
  }, [selectedDomainId]);

  // Notify parent on every change
  useEffect(() => {
    if (!selectedDomainId) { onBlueprintChange(null); return; }
    const criteria = flattenToCriteria(categoryRows);
    if (criteria.length === 0) { onBlueprintChange(null); return; }
    onBlueprintChange({ domain_id: selectedDomainId, level: selectedLevel, criteria });
  }, [selectedDomainId, selectedLevel, categoryRows, onBlueprintChange]);

  function addCategoryRow() {
    setCategoryRows((prev) => [
      ...prev,
      { category: null, selectedTypes: [], count: 1 },
    ]);
  }

  function removeCategoryRow(idx: number) {
    setCategoryRows((prev) => prev.filter((_, i) => i !== idx));
  }

  function updateRow(idx: number, patch: Partial<BlueprintCategoryRow>) {
    setCategoryRows((prev) => prev.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  }

  const liveTotal = blueprintLiveTotal(categoryRows);

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
        the question pack automatically. Count = questions per checked type.
      </p>

      {domainsError && (
        <div style={{ color: "var(--aiq-color-error, #dc2626)", fontSize: "var(--aiq-text-xs)" }}>
          {domainsError}
        </div>
      )}

      {/* Domain + Level row */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: "var(--aiq-space-md)" }}>
        <div>
          <div style={labelStyle}>
            <HelpTip helpId="admin.assessments.list.content_source">
              <span>Domain</span>
            </HelpTip>
          </div>
          {domainsLoading ? (
            <span style={{ fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-sm)", color: "var(--aiq-color-fg-muted)" }}>
              Loading…
            </span>
          ) : !skipFilter && entitledDomains !== null && domains.length === 0 ? (
            <span style={{ fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-sm)", color: "var(--aiq-color-fg-muted)" }}>
              No content is enabled for your company yet — contact your platform operator.
            </span>
          ) : (
            <>
              <select
                className="aiq-input"
                value={selectedDomainId}
                onChange={(e) => setSelectedDomainId(e.target.value)}
                disabled={domains.length === 0}
              >
                <option value="">— Select domain —</option>
                {domains.map((d) => (
                  <option key={d.id} value={d.id}>{d.name}</option>
                ))}
              </select>
              {!skipFilter && entitledDomains !== null && (
                <p style={{ fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-xs)", color: "var(--aiq-color-fg-muted)", margin: "4px 0 0" }}>
                  Only content your company is entitled to is shown. Contact your platform operator to enable more.
                </p>
              )}
            </>
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

      {/* Category rows — one per "+ Add category" */}
      {selectedDomainId && (
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-sm)" }}>
          <div style={labelStyle}>Categories</div>

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

          {categoryRows.map((row, idx) => {
            // Determine available types: use the selected category's supported_types,
            // or an empty array until a category is chosen (mirrors wizard pattern).
            const catSupportedTypes: string[] = row.category !== null && Array.isArray(row.category.supported_types)
              ? (row.category.supported_types as string[])
              : [];
            const controlsDisabled = row.category === null;
            const rowTotal = row.category !== null ? row.selectedTypes.length * row.count : 0;

            return (
              <div
                key={idx}
                style={{
                  padding: "var(--aiq-space-sm) var(--aiq-space-md)",
                  background: row.category !== null ? "var(--aiq-color-accent-soft)" : "var(--aiq-color-bg-raised)",
                  border: "1px solid",
                  borderColor: row.category !== null ? "var(--aiq-color-accent)" : "var(--aiq-color-border)",
                  borderRadius: "var(--aiq-radius-md)",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: "var(--aiq-space-md)", flexWrap: "wrap" }}>
                  {/* Category select */}
                  <select
                    className="aiq-input"
                    style={{ minWidth: 160, maxWidth: 220 }}
                    value={row.category?.id ?? ""}
                    onChange={(e) => {
                      const cat = categories.find((c) => c.id === e.target.value) ?? null;
                      // Reset selectedTypes to all supported_types of the new category (wizard default)
                      const defaultTypes: string[] = cat !== null && Array.isArray(cat.supported_types)
                        ? (cat.supported_types as string[])
                        : [];
                      updateRow(idx, { category: cat, selectedTypes: defaultTypes });
                    }}
                  >
                    <option value="">— Category —</option>
                    {categories.map((c) => (
                      <option key={c.id} value={c.id}>{c.name}</option>
                    ))}
                  </select>

                  {/* Count input — disabled until category chosen */}
                  <div style={{ display: "flex", alignItems: "center", gap: "var(--aiq-space-xs)" }}>
                    <label style={{ fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-xs)", color: "var(--aiq-color-fg-muted)", whiteSpace: "nowrap" }}>
                      Count/type
                    </label>
                    <input
                      type="number"
                      min={1}
                      max={20}
                      value={row.count}
                      disabled={controlsDisabled}
                      onChange={(e) => {
                        const v = Math.max(1, Math.min(20, parseInt(e.target.value, 10) || 1));
                        updateRow(idx, { count: v });
                      }}
                      style={{
                        width: 52,
                        padding: "2px 4px",
                        fontFamily: "var(--aiq-font-mono)",
                        fontSize: "var(--aiq-text-sm)",
                        border: "1px solid var(--aiq-color-border)",
                        borderRadius: "var(--aiq-radius-sm)",
                        background: controlsDisabled ? "var(--aiq-color-bg-sunken)" : "var(--aiq-color-bg-raised)",
                        opacity: controlsDisabled ? 0.5 : 1,
                        textAlign: "center",
                      }}
                    />
                  </div>

                  {/* Type checkboxes from supported_types — disabled until category chosen */}
                  <div style={{ display: "flex", gap: "var(--aiq-space-xs)", flexWrap: "wrap" }}>
                    {catSupportedTypes.map((t) => (
                      <label
                        key={t}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 3,
                          fontFamily: "var(--aiq-font-mono)",
                          fontSize: 10,
                          color: controlsDisabled ? "var(--aiq-color-fg-muted)" : "var(--aiq-color-fg-secondary)",
                          cursor: controlsDisabled ? "not-allowed" : "pointer",
                          opacity: controlsDisabled ? 0.5 : 1,
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={row.selectedTypes.includes(t)}
                          disabled={controlsDisabled}
                          onChange={(e) => {
                            const next = e.target.checked
                              ? [...row.selectedTypes, t]
                              : row.selectedTypes.filter((x) => x !== t);
                            updateRow(idx, { selectedTypes: next });
                          }}
                          style={{ accentColor: "var(--aiq-color-accent)" }}
                        />
                        {t}
                      </label>
                    ))}
                    {!controlsDisabled && catSupportedTypes.length === 0 && (
                      <span style={{ fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-xs)", color: "var(--aiq-color-fg-muted)" }}>
                        (no types)
                      </span>
                    )}
                  </div>

                  {/* Per-row subtotal */}
                  {row.category !== null && rowTotal > 0 && (
                    <span style={{ fontFamily: "var(--aiq-font-mono)", fontSize: "var(--aiq-text-xs)", color: "var(--aiq-color-accent)", whiteSpace: "nowrap" }}>
                      = {rowTotal} q
                    </span>
                  )}
                  {row.category !== null && row.selectedTypes.length === 0 && (
                    <span style={{ fontFamily: "var(--aiq-font-mono)", fontSize: "var(--aiq-text-xs)", color: "var(--aiq-color-error, #dc2626)", whiteSpace: "nowrap" }}>
                      select a type
                    </span>
                  )}

                  {/* Remove row */}
                  <button
                    type="button"
                    className="aiq-btn aiq-btn-outline aiq-btn-sm"
                    onClick={() => removeCategoryRow(idx)}
                    style={{ color: "var(--aiq-color-error, #dc2626)", flexShrink: 0 }}
                    aria-label="Remove category row"
                  >
                    ×
                  </button>
                </div>
              </div>
            );
          })}

          <button
            type="button"
            className="aiq-btn aiq-btn-outline aiq-btn-sm"
            onClick={addCategoryRow}
            disabled={categories.length === 0 || categoriesLoading}
          >
            + Add category
          </button>

          {/* Live total */}
          {categoryRows.length > 0 && (
            <div
              style={{
                fontFamily: "var(--aiq-font-mono)",
                fontSize: "var(--aiq-text-sm)",
                color: liveTotal > 0 ? "var(--aiq-color-fg-primary)" : "var(--aiq-color-fg-muted)",
                fontWeight: 600,
              }}
            >
              Total: {liveTotal} question{liveTotal !== 1 ? "s" : ""}
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
// FromSetPicker sub-component (Step 2 — clone-on-use, "Assess from a set")
// ---------------------------------------------------------------------------
//
// Company-admin path to consume a licensed PLATFORM-library set. Lists the sets
// this tenant is entitled to (getAvailableSets → GET /billing/available-sets),
// lets the admin pick a set + level (1-based position) + how many questions to
// draw, and reports the selection up. The actual clone-on-use happens server-
// side when createAssessmentFromSet is called on submit — this component only
// reads license-gated METADATA (name, domain, level/question counts, version);
// it never reads platform pack content.
//
// A domain license surfaces all current AND future sets in that domain, so new
// sets the super admin publishes appear here automatically.

interface FromSetSelection {
  source_pack_id: string;
  level_position: number;
  question_count: number;
}

interface FromSetPickerProps {
  /** Stable setState reference from the parent (mirrors BlueprintBuilder). */
  onChange: (sel: FromSetSelection | null) => void;
}

function FromSetPicker({ onChange }: FromSetPickerProps): React.ReactElement {
  const [sets, setSets] = useState<AvailableSet[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [selectedSourceId, setSelectedSourceId] = useState<string>("");
  const [levelPosition, setLevelPosition] = useState<number>(1);
  const [questionCount, setQuestionCount] = useState<number>(10);

  // Load licensed sets on mount (only mounts when "From a set" mode is active).
  useEffect(() => {
    void (async () => {
      setLoading(true);
      try {
        const data = await getAvailableSets();
        setSets(data.sets);
      } catch (err) {
        setLoadError(
          err instanceof AdminApiError ? err.apiError.message : "Failed to load available sets.",
        );
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  // Reset level when the set changes (positions are 1-based within the set).
  useEffect(() => {
    setLevelPosition(1);
  }, [selectedSourceId]);

  // Report selection up on every change. Null until a complete, valid selection.
  useEffect(() => {
    const set = sets?.find((s) => s.source_pack_id === selectedSourceId) ?? null;
    if (!selectedSourceId || set === null) { onChange(null); return; }
    if (!Number.isInteger(levelPosition) || levelPosition < 1) { onChange(null); return; }
    if (!Number.isInteger(questionCount) || questionCount < 1) { onChange(null); return; }
    onChange({ source_pack_id: selectedSourceId, level_position: levelPosition, question_count: questionCount });
  }, [sets, selectedSourceId, levelPosition, questionCount, onChange]);

  const selectedSet = sets?.find((s) => s.source_pack_id === selectedSourceId) ?? null;

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
        Pick a question set your company is licensed for. The set is copied into your
        workspace the first time you assess from it, and each candidate draws a fresh
        set from your own stable copy.
      </p>

      {loadError && (
        <div style={{ color: "var(--aiq-color-danger)", fontSize: "var(--aiq-text-xs)" }}>
          {loadError}
        </div>
      )}

      {loading ? (
        <span style={{ fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-sm)", color: "var(--aiq-color-fg-muted)" }}>
          Loading available sets…
        </span>
      ) : sets !== null && sets.length === 0 ? (
        <span style={{ fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-sm)", color: "var(--aiq-color-fg-muted)" }}>
          No question sets are licensed for your company yet — contact your platform
          operator to enable one.
        </span>
      ) : (
        <>
          {/* Set picker */}
          <div>
            <div style={labelStyle}>Question set</div>
            <select
              className="aiq-input"
              value={selectedSourceId}
              onChange={(e) => setSelectedSourceId(e.target.value)}
            >
              <option value="">— Select a set —</option>
              {(sets ?? []).map((s) => (
                <option key={s.source_pack_id} value={s.source_pack_id}>
                  {s.name} · {s.domain} · {s.level_count} level{s.level_count !== 1 ? "s" : ""} · {s.question_count} q
                  {s.update_available ? " · update available" : ""}
                </option>
              ))}
            </select>
          </div>

          {selectedSet !== null && (
            <>
              <div style={{ display: "flex", gap: "var(--aiq-space-xs)", flexWrap: "wrap" }}>
                {selectedSet.cloned && (
                  <Chip leftIcon="check">In your workspace</Chip>
                )}
                {selectedSet.update_available && (
                  <Chip>Source updated · re-sync available</Chip>
                )}
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--aiq-space-md)" }}>
                {/* Level */}
                <div>
                  <div style={labelStyle}>Level</div>
                  <select
                    className="aiq-input"
                    value={String(levelPosition)}
                    onChange={(e) => setLevelPosition(parseInt(e.target.value, 10) || 1)}
                  >
                    {Array.from({ length: Math.max(1, selectedSet.level_count) }, (_, i) => i + 1).map((pos) => (
                      <option key={pos} value={pos}>Level {pos}</option>
                    ))}
                  </select>
                </div>

                {/* Questions to draw */}
                <div>
                  <div style={labelStyle}>Questions to draw</div>
                  <input
                    className="aiq-input"
                    type="number"
                    min={1}
                    max={200}
                    value={questionCount}
                    onChange={(e) => {
                      const v = Math.max(1, Math.min(200, parseInt(e.target.value, 10) || 1));
                      setQuestionCount(v);
                    }}
                  />
                </div>
              </div>
              <p style={{ fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-xs)", color: "var(--aiq-color-fg-muted)", margin: 0 }}>
                The pool is checked when you publish — if the chosen level has fewer
                questions than this, lower the count before publishing.
              </p>
            </>
          )}
        </>
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

  // Creation method: "from-set" (clone-on-use a licensed platform set, default)
  // | "blueprint" (per-criterion random draw from the company's own domain pack).
  // The legacy non-blueprint "manual" path required a pack_id this form never
  // collected (→ PACK_NOT_FOUND for company admins), so it is intentionally not
  // offered here — companies consume sets, they do not hand-author packs.
  const [createMode, setCreateMode] = useState<"from-set" | "blueprint">("from-set");
  const [pendingFromSet, setPendingFromSet] = useState<FromSetSelection | null>(null);
  const [pendingBlueprint, setPendingBlueprint] = useState<{
    domain_id: string;
    level: BlueprintLevel;
    criteria: BlueprintCriterion[];
  } | null>(null);

  // D3 — entitlement filtering for the domain picker
  // null = fail-open (show all). Non-null set = filter to entitled domains.
  const [entitledDomains, setEntitledDomains] = useState<Set<string> | null>(null);
  const [skipEntitlementFilter, setSkipEntitlementFilter] = useState(false);

  // Created assessment ID for preview adequacy display
  const [createdAssessmentId, setCreatedAssessmentId] = useState<string | null>(null);

  // Client-side sort state
  const [sortBy, setSortBy] = useState<string>("");
  const [sortDir, setSortDir] = useState<SortDir>("asc");

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

  // D3 — load entitlements + usage on mount to determine domain picker filtering.
  // Fail-open: any error leaves entitledDomains=null (show all).
  useEffect(() => {
    void (async () => {
      try {
        const [usageData, entsData] = await Promise.all([
          getCompanyUsage().catch(() => null as CompanyUsage | null),
          getCompanyEntitlements().catch(() => null as { entitlements: TenantEntitlement[] } | null),
        ]);

        // Internal/unlimited tenants bypass filtering
        if (usageData !== null && (usageData.tier === 'internal' || usageData.status === 'unlimited')) {
          setSkipEntitlementFilter(true);
          return;
        }

        if (entsData !== null) {
          const domainScopeIds = new Set(
            entsData.entitlements
              .filter((e) => e.status === 'active' && e.scope_type === 'domain')
              .map((e) => e.scope_id),
          );
          setEntitledDomains(domainScopeIds);
        }
        // If entsData is null (fetch failed), entitledDomains stays null → fail-open
      } catch {
        // Fail-open: leave entitledDomains=null so the server's B2 gate still applies
      }
    })();
  }, []);

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
    if (!newForm.opens_at) {
      setCreateError("Opens is required — an assessment with no Opens date never becomes active and candidates can't start it. Set when it should open.");
      return;
    }
    if (createMode === "from-set" && pendingFromSet === null) {
      setCreateError("Select a licensed set, a level, and the number of questions to draw.");
      return;
    }
    if (createMode === "blueprint" && pendingBlueprint === null) {
      setCreateError("Blueprint is incomplete. Select a domain, level, and at least one valid criterion.");
      return;
    }
    setCreating(true);
    setCreateError(null);
    setCreatedAssessmentId(null);
    try {
      const opensAtIso = new Date(newForm.opens_at).toISOString();
      const closesAtIso = newForm.closes_at ? new Date(newForm.closes_at).toISOString() : undefined;

      // ── From-set (clone-on-use) ───────────────────────────────────────────
      // The server license-checks the source set, clones it into this tenant on
      // first use (idempotent), and creates the assessment from the clone. We
      // navigate straight to the created draft (no blueprint adequacy preview —
      // the source set's level already defines the pool; publish validates it).
      if (createMode === "from-set" && pendingFromSet !== null) {
        const created = await createAssessmentFromSet({
          source_pack_id: pendingFromSet.source_pack_id,
          level_position: pendingFromSet.level_position,
          name: newForm.name.trim(),
          question_count: pendingFromSet.question_count,
          opens_at: opensAtIso,
          ...(closesAtIso ? { closes_at: closesAtIso } : {}),
        });
        navigate(`/admin/assessments/${created.id}`);
        return;
      }

      // ── Blueprint ─────────────────────────────────────────────────────────
      const body: Record<string, unknown> = { name: newForm.name.trim() };
      body.opens_at = opensAtIso;
      if (closesAtIso) body.closes_at = closesAtIso;

      if (pendingBlueprint !== null) {
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

      // Blueprint: show adequacy preview before navigating
      setCreatedAssessmentId(created.id);
      void fetchAssessments(statusFilter);
      setCreating(false);
    } catch (err) {
      // 403 NOT_LICENSED: the source set is no longer licensed for this tenant.
      if (err instanceof AdminApiError && err.apiError.code === "NOT_LICENSED") {
        setCreateError(
          "Your company is no longer licensed for this set. Contact your platform operator to re-enable it.",
        );
      } else {
        setCreateError(
          err instanceof AdminApiError
            ? err.apiError.message
            : "Failed to create assessment.",
        );
      }
      setCreating(false);
    }
  }

  const columns: ColumnDef<AssessmentListItem>[] = [
    {
      key: "name",
      label: "Name",
      sortable: true,
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
      sortable: true,
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
      // Not sortable: value is a composite { total, … } object the generic
      // client-side comparator can't order meaningfully.
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
      sortable: true,
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
      sortable: true,
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
      sortable: true,
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

  const sortedRows = React.useMemo(
    () => (sortBy ? sortRows(items, sortBy, sortDir) : items),
    [items, sortBy, sortDir],
  );

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

        {/* A2 — usage banner (fail-silent; renders nothing when status=unlimited or loading) */}
        <UsageBanner />

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

            {/* Creation method — segmented control (mirrors the status filter strip) */}
            <div style={{ marginBottom: "var(--aiq-space-md)" }}>
              <div style={{ display: "flex", gap: "var(--aiq-space-xs)", flexWrap: "wrap" }}>
                {([
                  { value: "from-set", label: "From a set", hint: "use a licensed platform set" },
                  { value: "blueprint", label: "Blueprint", hint: "per-criterion random draw" },
                ] as const).map((m) => (
                  <button
                    key={m.value}
                    type="button"
                    className={`aiq-btn aiq-btn-sm ${createMode === m.value ? "aiq-btn-primary" : "aiq-btn-outline"}`}
                    onClick={() => {
                      setCreateMode(m.value);
                      setPendingFromSet(null);
                      setPendingBlueprint(null);
                      setCreatedAssessmentId(null);
                      setCreateError(null);
                    }}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
              <p style={{ fontFamily: "var(--aiq-font-mono)", fontSize: "var(--aiq-text-xs)", color: "var(--aiq-color-fg-muted)", margin: "6px 0 0" }}>
                {createMode === "from-set"
                  ? "From a set — assess from a question set your company is licensed for."
                  : "Blueprint — each candidate draws a fresh random set per criterion from your domain content."}
              </p>
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
                    Opens *
                  </label>
                  <input
                    className="aiq-input"
                    type="datetime-local"
                    value={newForm.opens_at}
                    onChange={(e) => setNewForm((f) => ({ ...f, opens_at: e.target.value }))}
                    required
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

              {/* Source builder — "From a set" picker or the Blueprint builder */}
              {createMode === "from-set" && (
                <div style={{ marginBottom: "var(--aiq-space-md)" }}>
                  <FromSetPicker onChange={setPendingFromSet} />
                </div>
              )}
              {createMode === "blueprint" && (
                <div style={{ marginBottom: "var(--aiq-space-md)" }}>
                  <BlueprintBuilder
                    onBlueprintChange={setPendingBlueprint}
                    entitledDomains={entitledDomains}
                    skipFilter={skipEntitlementFilter}
                  />
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
        <div className="aiq-admin-filter-strip" style={{ display: "flex", gap: "var(--aiq-space-xs)", flexWrap: "wrap" }}>
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
          <div className="aiq-admin-table-scroll">
            <Table
              columns={columns}
              data={sortedRows}
              emptyMessage="No assessments found."
              {...(sortBy ? { sortBy } : {})}
              sortDir={sortDir}
              onSort={(key, dir) => { setSortBy(key); setSortDir(dir); }}
            />
          </div>
        )}
      </div>
    </AdminShell>
  );
}
