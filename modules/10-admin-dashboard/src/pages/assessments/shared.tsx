import type { CategoryItem } from "../../api.js";

type AssessmentStatus = "draft" | "published" | "active" | "closed";

interface InvitationCounts {
  total: number;
  pending: number;
  viewed: number;
  started: number;
  submitted: number;
  expired: number;
}

export interface AssessmentListItem {
  id: string;
  name: string;
  status: AssessmentStatus;
  pack_id: string | null;
  /** levels.label for the bound level (e.g. "Level 2"). null if FK dangling. */
  level_label?: string | null;
  /** question_packs.domain slug; rendered via domainLabel(). null if FK dangling. */
  domain?: string | null;
  opens_at: string | null;
  closes_at: string | null;
  created_at: string;
  invitations?: InvitationCounts;
}

export interface AssessmentsResponse {
  items: AssessmentListItem[];
  total: number;
}

// ---------------------------------------------------------------------------
// Blueprint types (mirrors Phase 2 types.ts shape — no import from backend)
// ---------------------------------------------------------------------------

export type BlueprintLevel = "L1" | "L2" | "L3";
export const BLUEPRINT_LEVELS: BlueprintLevel[] = ["L1", "L2", "L3"];
export const DIFFICULTY_LABEL: Record<BlueprintLevel, string> = { L1: "Beginner", L2: "Intermediate", L3: "Advanced" };

export interface BlueprintCriterion {
  category_id: string;
  type: string;
  count: number;
}

// One row in the blueprint builder UI.  Mirrors generate-wizard CategoryConfig.
// category = the selected CategoryItem; selectedTypes = checked types from supported_types.
// On submit: flatten to criteria [{category_id, type, count}] per checked type.
export interface BlueprintCategoryRow {
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

export interface BlueprintPreviewResponse {
  blueprint_criteria?: BlueprintPreviewCriterion[];
  pool_size: number;
  question_count: number;
}

// ---------------------------------------------------------------------------
// Sort helper
// ---------------------------------------------------------------------------

export type SortDir = "asc" | "desc";

/** Client-side row sort. Keys ending in `_at` sort as dates; numeric columns
 *  numerically; everything else case-insensitively. */
export function sortRows<T>(rows: T[], key: string, dir: SortDir): T[] {
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

export const STATUS_TABS: { label: string; value: string }[] = [
  { label: "All", value: "" },
  { label: "Draft", value: "draft" },
  { label: "Published", value: "published" },
  { label: "Active", value: "active" },
  { label: "Closed", value: "closed" },
];

export function assessmentStatusVariant(s: string): "default" | "accent" | "success" {
  return s === "active" ? "success" : s === "published" ? "accent" : "default";
}

/** Compute live total = Σ(selectedTypes.length × count) across all category rows. */
export function blueprintLiveTotal(rows: BlueprintCategoryRow[]): number {
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
export function flattenToCriteria(rows: BlueprintCategoryRow[]): BlueprintCriterion[] {
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

