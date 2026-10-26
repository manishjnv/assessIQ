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
// "New assessment (advanced)" opens an inline form (consistent with question-bank.tsx).
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
import { Link, useNavigate, useSearchParams } from "react-router";
import { Chip, EmptyState, Table } from "@assessiq/ui-system";
import type { ColumnDef } from "@assessiq/ui-system";
import { AdminShell } from "../components/AdminShell.js";
import { adminApi, AdminApiError, getCompanyEntitlements, createAssessmentFromSet } from "../api.js";
import type { TenantEntitlement, CompanyUsage } from "../api.js";
import { HelpTip } from "@assessiq/help-system/components";
import { DangerConfirmModal } from "../components/DangerConfirmModal.js";
import { UsageBanner } from "../components/UsageBanner.js";
import { useCompanyUsage } from "../hooks/useCompanyUsage.js";
import { SectionsEditor, buildSections } from "./SectionsEditor.js";
import type { SectionRow } from "./SectionsEditor.js";
import { useAdminSession } from "../session.js";
import { type AssessmentListItem, type AssessmentsResponse, type BlueprintLevel, type BlueprintCriterion, type SortDir, sortRows, STATUS_TABS, normalizeStatusTab, statusesForTab, isEmptyDraftCandidate } from "./assessments/shared.js";
import { TestTypeChooser, fromTestType, feedbackSetting, type FeedbackLevel, type TestType, type ChooserCameraSettings } from "../components/TestTypeChooser.js";
import { getCameraSettingsApi } from "../api/camera.js";
import { buildAssessmentColumns } from "./assessments/columns.js";
import { BlueprintBuilder } from "./assessments/BlueprintBuilder.js";
import { PreviewAdequacy } from "./assessments/PreviewAdequacy.js";
import { type FromSetSelection, FromSetPicker } from "./assessments/FromSetPicker.js";

interface NewAssessmentForm {
  name: string;
  opens_at: string;
  closes_at: string;
}

export function AdminAssessments(): React.ReactElement {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  // Old ?status=draft/published/active/closed links map to the new tabs.
  const statusFilter = normalizeStatusTab(searchParams.get("status") ?? "");

  const { session } = useAdminSession();
  // Blueprint authoring is a super_admin-only capability; tenant admins only see
  // "From a set". Backend enforces the same gate on POST /api/admin/assessments.
  const isSuperAdmin = session?.user.role === "super_admin";

  const [items, setItems] = useState<AssessmentListItem[]>([]);
  const [serverTotal, setServerTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [showNewForm, setShowNewForm] = useState(false);
  // Z-22 #2: the dashboard "New assessment" button links here with ?new=1.
  // Open the create form once, then drop the param so a refresh does not reopen it.
  useEffect(() => {
    if (searchParams.get("new") !== "1") return;
    // CT-3: a tenant admin creates tests on the Create a test page. The criteria form below is for the platform super admin.
    if (!isSuperAdmin) { navigate("/admin/create-test", { replace: true }); return; }
    setShowNewForm(true);
    const next = new URLSearchParams(searchParams);
    next.delete("new");
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams, isSuperAdmin, navigate]);
  const [newForm, setNewForm] = useState<NewAssessmentForm>({
    name: "",
    opens_at: "",
    closes_at: "",
  });
  // Z-16: blank = use the level default; otherwise a whole number 1..100.
  const [passMark, setPassMark] = useState("");
  // Z-51: blueprint-mode whole-test fields, sent inside settings.blueprint (blank = not set).
  const [bpWholeMinutes, setBpWholeMinutes] = useState("");
  const [bpMarksPerQuestion, setBpMarksPerQuestion] = useState("");
  // Z-89: default test type of the new assessment (the invite form can still override per batch).
  // Z-143: the card chooser value (Mock / Real / Real + camera). Default Real.
  const [testType, setTestType] = useState<TestType>("real");
  // Z-145: per-question feedback, Mock only (Real and Real + camera send nothing).
  const [feedbackLevel, setFeedbackLevel] = useState<FeedbackLevel>("none");
  const [cameraSettings, setCameraSettings] = useState<ChooserCameraSettings | null>(null);
  useEffect(() => {
    getCameraSettingsApi().then(setCameraSettings).catch(() => setCameraSettings(null));
  }, []);
  const deliveryMode = fromTestType(testType).delivery_mode;
  const cameraRequired = testType === "real_camera";
  const [creating, setCreating] = useState(false);
  // Integrity v1: written to settings.integrity on create (both default off).
  const [integrityFullscreen, setIntegrityFullscreen] = useState(false);
  const [integrityBlockCopy, setIntegrityBlockCopy] = useState(false);
  // Test sections (from-set mode): written to settings.sections on create.
  const [sectionRows, setSectionRows] = useState<SectionRow[]>([]);
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

  // Row delete / cancel + bulk clear-empty-drafts (Q44).
  const [removeTarget, setRemoveTarget] = useState<{ row: AssessmentListItem; mode: "delete" | "cancel" } | null>(null);
  const [showClear, setShowClear] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [clearMsg, setClearMsg] = useState<string | null>(null);

  // A tab can cover more than one server status (Live = published + active), so
  // fetch each status and merge newest-first. All = one fetch, no status filter.
  const fetchAssessments = useCallback(async (tab: string) => {
    setLoading(true);
    setError(null);
    try {
      const pages = await Promise.all(
        statusesForTab(tab).map((status) => {
          const qs = new URLSearchParams({ pageSize: "100" });
          if (status) qs.set("status", status);
          return adminApi<AssessmentsResponse>(`/admin/assessments?${qs.toString()}`);
        }),
      );
      const merged = pages.flatMap((p) => p.items);
      if (pages.length > 1) merged.sort((a, b) => b.created_at.localeCompare(a.created_at));
      setItems(merged);
      setServerTotal(pages.reduce((sum, p) => sum + p.total, 0));
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
  const { usage: sharedUsage, failed: usageFailed } = useCompanyUsage();
  useEffect(() => {
    if (sharedUsage === null && !usageFailed) return; // wait for the shared usage read (Z-149)
    void (async () => {
      try {
        const usageData: CompanyUsage | null = sharedUsage;
        const entsData = await getCompanyEntitlements().catch(() => null as { entitlements: TenantEntitlement[] } | null);

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
  }, [sharedUsage, usageFailed]);

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
    const passMarkNum = passMark.trim() === "" ? null : Number(passMark.trim());
    if (passMarkNum !== null && (!Number.isInteger(passMarkNum) || passMarkNum < 1 || passMarkNum > 100)) {
      setCreateError("Pass mark must be a whole number from 1 to 100.");
      return;
    }
    const bpWhole = bpWholeMinutes.trim() === "" ? null : Number(bpWholeMinutes.trim());
    if (bpWhole !== null && (!Number.isInteger(bpWhole) || bpWhole < 1 || bpWhole > 600)) {
      setCreateError("Whole-test minutes must be a whole number from 1 to 600.");
      return;
    }
    const bpMarks = bpMarksPerQuestion.trim() === "" ? null : Number(bpMarksPerQuestion.trim());
    if (bpMarks !== null && (!Number.isFinite(bpMarks) || bpMarks < 0 || bpMarks > 1000)) {
      setCreateError("Marks per section must be a number from 0 to 1000.");
      return;
    }
    if (createMode === "from-set" && pendingFromSet === null) {
      setCreateError("Select a licensed set, a difficulty, and the number of questions to draw.");
      return;
    }
    if (createMode === "blueprint" && pendingBlueprint === null) {
      setCreateError("Blueprint is incomplete. Select a subject, difficulty, and at least one valid criterion.");
      return;
    }
    const builtSections =
      createMode === "from-set" && sectionRows.length > 0 ? buildSections(sectionRows) : null;
    if (builtSections !== null && "error" in builtSections) {
      setCreateError(builtSections.error);
      return;
    }
    setCreating(true);
    setCreateError(null);
    setCreatedAssessmentId(null);
    try {
      const opensAtIso = new Date(newForm.opens_at).toISOString();
      const closesAtIso = newForm.closes_at ? new Date(newForm.closes_at).toISOString() : undefined;
      const integritySettings = {
        // High-stakes is set on the detail page (HighStakesCard), not at create (RW-17).
        // Z-142: a Real test is fixed on (the server refuses false); only Mock follows the checkboxes.
        integrity: {
          fullscreen: deliveryMode === "real" || integrityFullscreen,
          block_copy_paste: deliveryMode === "real" || integrityBlockCopy,
        },
        ...feedbackSetting(testType, feedbackLevel),
      };

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
          // With sections the total is the sum of the section counts (when all are set).
          question_count: builtSections?.total ?? pendingFromSet.question_count,
          opens_at: opensAtIso,
          ...(closesAtIso ? { closes_at: closesAtIso } : {}),
          ...(passMarkNum !== null ? { passing_score_pct: passMarkNum } : {}),
          delivery_mode: deliveryMode,
          camera_required: cameraRequired,
          settings: { ...integritySettings, ...(builtSections?.settings ?? {}) },
        });
        navigate(`/admin/assessments/${created.id}`);
        return;
      }

      // ── Blueprint ─────────────────────────────────────────────────────────
      const body: Record<string, unknown> = { name: newForm.name.trim() };
      body.opens_at = opensAtIso;
      if (closesAtIso) body.closes_at = closesAtIso;
      if (passMarkNum !== null) body.passing_score_pct = passMarkNum;
      body.delivery_mode = deliveryMode;
      body.camera_required = cameraRequired;

      if (pendingBlueprint !== null) {
        // Blueprint mode: send settings.blueprint; backend resolves pack/level/question_count
        // Z-51: the whole-test fields go inside the blueprint (settings.sections stays exclusive).
        const blueprintWithTiming = {
          ...pendingBlueprint,
          ...(bpWhole !== null ? { whole_test_minutes: bpWhole } : {}),
          ...(bpMarks !== null ? { marks_per_question: bpMarks } : {}),
        };
        body.settings = { blueprint: blueprintWithTiming, ...integritySettings };
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
          "Your organisation is no longer licensed for this set. Contact your platform operator to re-enable it.",
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

  const emptyDrafts = items.filter(isEmptyDraftCandidate).slice(0, 100); // route cap is 100

  const columns: ColumnDef<AssessmentListItem>[] = buildAssessmentColumns({
    navigate,
    onRemove: (row, mode) => {
      setActionError(null);
      setClearMsg(null);
      setRemoveTarget({ row, mode });
    },
  });

  async function handleConfirmRemove() {
    if (removeTarget === null) return;
    const { row, mode } = removeTarget;
    setActionBusy(true);
    setActionError(null);
    try {
      if (mode === "delete") {
        await adminApi(`/admin/assessments/${row.id}`, { method: "DELETE" });
      } else {
        await adminApi(`/admin/assessments/${row.id}/cancel`, { method: "POST" });
      }
      setRemoveTarget(null);
      void fetchAssessments(statusFilter);
    } catch (err) {
      if (err instanceof AdminApiError && err.apiError.code === "ASSESSMENT_HAS_ATTEMPTS") {
        // Our guess was wrong: candidates already started it. Offer Cancel instead.
        setActionError("Candidates have already started this assessment, so it cannot be deleted. You can cancel it instead.");
        setRemoveTarget({ row, mode: "cancel" });
      } else {
        setActionError(err instanceof AdminApiError ? err.apiError.message : "The action failed. Try again.");
      }
    } finally {
      setActionBusy(false);
    }
  }

  async function handleConfirmClear() {
    setActionBusy(true);
    setActionError(null);
    try {
      const res = await adminApi<{ deleted: string[]; skipped: { id: string; reason: string }[] }>(
        "/admin/assessments/clear-empty-drafts",
        { method: "POST", body: JSON.stringify({ ids: emptyDrafts.map((a) => a.id) }) },
      );
      setShowClear(false);
      setClearMsg(`Deleted ${res.deleted.length}, skipped ${res.skipped.length}.`);
      void fetchAssessments(statusFilter);
    } catch (err) {
      setActionError(err instanceof AdminApiError ? err.apiError.message : "The action failed. Try again.");
    } finally {
      setActionBusy(false);
    }
  }

  const sortedRows = React.useMemo(
    () => (sortBy ? sortRows(items, sortBy, sortDir) : items),
    [items, sortBy, sortDir],
  );

  return (
    <AdminShell breadcrumbs={["Assessments"]} helpPage="admin.assessments">
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-xl)" }}>
        {/* Page header — count chip + serif h1 + lede + action */}
        <div>
          <div style={{ marginBottom: 12 }}>
            <Chip leftIcon="grid">{serverTotal > items.length ? `showing ${items.length} of ${serverTotal}` : `${items.length} assessment${items.length !== 1 ? "s" : ""}`}</Chip>
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "flex-start",
              justifyContent: "space-between",
              flexWrap: "wrap",
              gap: "var(--aiq-space-md)",
            }}
          >
            <div>
              <h1
                style={{
                  fontFamily: "var(--aiq-font-serif)",
                  fontSize: "var(--aiq-h1-size)",
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
            <div style={{ display: "flex", gap: "var(--aiq-space-sm)", flexWrap: "wrap", alignSelf: "center" }}>
              <HelpTip helpId="admin.assessments.send_test_now">
                <Link to="/admin/create-test" className="aiq-btn aiq-btn-primary">Create a test</Link>
              </HelpTip>
              {isSuperAdmin && <HelpTip helpId="admin.assessments.new_advanced">
                <button
                  type="button"
                  className="aiq-btn aiq-btn-outline"
                  onClick={() => {
                    setShowNewForm((v) => !v);
                    setCreateError(null);
                    setCreatedAssessmentId(null);
                  }}
                >
                  {showNewForm ? "Cancel" : "New assessment (advanced)"}
                </button>
              </HelpTip>}
            </div>
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
                {[
                  { value: "from-set" as const, label: "From a set", hint: "use a licensed platform set" },
                  { value: "blueprint" as const, label: "Blueprint", hint: "per-criterion random draw" },
                ].filter((m) => m.value !== "blueprint" || isSuperAdmin).map((m) => (
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
                  ? "From a set — assess from a question set your organisation is licensed for."
                  : "Blueprint — each candidate draws a fresh random set per criterion from your subject content."}
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

                {/* Pass mark (Z-16) — blank uses the level default; editable until publish */}
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: "var(--aiq-space-xs)",
                  }}
                >
                  <HelpTip helpId="admin.assessments.pass_mark">
                    <label
                      htmlFor="new-assessment-pass-mark"
                      style={{
                        fontFamily: "var(--aiq-font-sans)",
                        fontSize: "var(--aiq-text-sm)",
                        fontWeight: 500,
                      }}
                    >
                      Pass mark (%)
                    </label>
                  </HelpTip>
                  <input
                    id="new-assessment-pass-mark"
                    className="aiq-input"
                    type="number"
                    min={1}
                    max={100}
                    step={1}
                    placeholder="Level default"
                    value={passMark}
                    onChange={(e) => setPassMark(e.target.value)}
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
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
                      gap: "var(--aiq-space-md)",
                      marginTop: "var(--aiq-space-md)",
                    }}
                  >
                    <div style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-xs)" }}>
                      <HelpTip helpId="admin.assessments.blueprint.whole_test_minutes">
                        <label
                          htmlFor="new-assessment-bp-whole-minutes"
                          style={{ fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-sm)", fontWeight: 500 }}
                        >
                          Whole-test minutes
                        </label>
                      </HelpTip>
                      <input
                        id="new-assessment-bp-whole-minutes"
                        className="aiq-input"
                        type="number"
                        min={1}
                        max={600}
                        step={1}
                        placeholder="No whole-test timer"
                        value={bpWholeMinutes}
                        onChange={(e) => setBpWholeMinutes(e.target.value)}
                      />
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-xs)" }}>
                      <HelpTip helpId="admin.assessments.blueprint.marks_per_question">
                        <label
                          htmlFor="new-assessment-bp-marks"
                          style={{ fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-sm)", fontWeight: 500 }}
                        >
                          Marks per section
                        </label>
                      </HelpTip>
                      <input
                        id="new-assessment-bp-marks"
                        className="aiq-input"
                        type="number"
                        min={0}
                        max={1000}
                        step="any"
                        placeholder="Question points"
                        value={bpMarksPerQuestion}
                        onChange={(e) => setBpMarksPerQuestion(e.target.value)}
                      />
                    </div>
                  </div>
                </div>
              )}

              {createMode === "from-set" && (
                <SectionsEditor
                  rows={sectionRows}
                  onChange={setSectionRows}
                  subjectSlug={pendingFromSet === null ? null : pendingFromSet.domain}
                  setId={pendingFromSet?.source_pack_id ?? null}
                />
              )}

              {/* Z-143: test type cards; the Mock card holds the integrity switches */}
              <div style={{ marginBottom: "var(--aiq-space-md)" }}>
                <TestTypeChooser
                  value={testType}
                  onChange={setTestType}
                  integrity={{ fullscreen: integrityFullscreen, blockCopyPaste: integrityBlockCopy }}
                  onIntegrityChange={(n) => { setIntegrityFullscreen(n.fullscreen); setIntegrityBlockCopy(n.blockCopyPaste); }}
                  cameraSettings={cameraSettings}
                  feedbackLevel={feedbackLevel}
                  onFeedbackLevelChange={setFeedbackLevel}
                />
              </div>

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
                <HelpTip helpId="admin.assessments.create.submit">
                  <button type="submit" className="aiq-btn aiq-btn-primary" disabled={creating}>
                    {creating ? "Creating…" : "Create assessment"}
                  </button>
                </HelpTip>
              )}
            </form>
          </div>
        )}

        {/* Filter chips */}
        <div className="aiq-admin-filter-strip" style={{ display: "flex", gap: "var(--aiq-space-xs)", flexWrap: "wrap", alignItems: "center" }}>
          <HelpTip helpId="admin.assessments.status_tabs">
            <span style={{ display: "inline-flex", gap: "var(--aiq-space-xs)", flexWrap: "wrap" }}>
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
            </span>
          </HelpTip>
          {emptyDrafts.length > 0 && (
            <HelpTip helpId="admin.assessments.clear_empty_drafts">
              <button
                type="button"
                className="aiq-btn aiq-btn-outline aiq-btn-sm"
                onClick={() => {
                  setActionError(null);
                  setClearMsg(null);
                  setShowClear(true);
                }}
              >
                Clear empty drafts
              </button>
            </HelpTip>
          )}
        </div>

        {clearMsg && (
          <div style={{ fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-sm)" }}>{clearMsg}</div>
        )}

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
          <EmptyState
            title="No assessments yet."
            body="Create an assessment to invite candidates and open a cycle."
          />
        ) : (
          <div className="aiq-admin-table-scroll">
            <Table
              columns={columns}
              data={sortedRows}
              emptyMessage="No assessments."
              {...(sortBy ? { sortBy } : {})}
              sortDir={sortDir}
              onSort={(key, dir) => { setSortBy(key); setSortDir(dir); }}
            />
          </div>
        )}
      </div>

      <DangerConfirmModal
        open={removeTarget !== null}
        title={removeTarget?.mode === "delete" ? "Delete this assessment?" : "Cancel this assessment?"}
        body={
          removeTarget?.mode === "delete" ? (
            <>
              Delete <strong>{removeTarget.row.name}</strong> for good. Its invitations are removed with it.
              No candidate has started it. This cannot be undone.
            </>
          ) : (
            <>
              Cancel <strong>{removeTarget?.row.name}</strong>. It leaves the list. Attempts and results are kept.
              This cannot be undone.
            </>
          )
        }
        confirmLabel={removeTarget?.mode === "delete" ? "Delete permanently" : "Cancel assessment"}
        busyLabel={removeTarget?.mode === "delete" ? "Deleting…" : "Cancelling…"}
        busy={actionBusy}
        error={actionError}
        onConfirm={() => void handleConfirmRemove()}
        onCancel={() => {
          setRemoveTarget(null);
          setActionError(null);
        }}
      />

      <DangerConfirmModal
        open={showClear}
        title="Clear empty drafts?"
        body={
          <>
            Delete <strong>{emptyDrafts.length}</strong> empty draft{emptyDrafts.length !== 1 ? "s" : ""} for good.
            An empty draft is a draft with no attempts and no invitations. The server checks each one again
            and skips any that is not empty. This cannot be undone.
          </>
        }
        confirmLabel={`Delete ${emptyDrafts.length}`}
        busyLabel="Deleting…"
        busy={actionBusy}
        error={actionError}
        onConfirm={() => void handleConfirmClear()}
        onCancel={() => {
          setShowClear(false);
          setActionError(null);
        }}
      />
    </AdminShell>
  );
}
