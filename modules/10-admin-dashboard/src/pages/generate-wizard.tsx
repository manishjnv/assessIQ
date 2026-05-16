// AssessIQ — Admin Generate Question Wizard page.
//
// /admin/generate-wizard
//
// Few-click AI generation: pick Pack + Level + Domain + Categories -> Generate -> Review.
// Reuses the existing generation engine (POST .../generate).
// No manual question authoring -- only AI drafts, inline edit, and approve.
//
// INVARIANTS:
//  - No "+ Add question" / manual authoring anywhere.
//  - Sequential generation calls (single-flight mutex on server).
//  - No claude/anthropic imports or copy.
//  - No hardcoded test data.

import React, { useEffect, useState, useCallback } from "react";
import { AdminShell } from "../components/AdminShell.js";
import {
  adminApi,
  AdminApiError,
  generateForDomainApi,
  listDomainsApi,
  listCategoriesApi,
  createDomainApi,
  createCategoryApi,
  bulkUpdateQuestionStatus,
} from "../api.js";
import type { DomainItem, CategoryItem } from "../api.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SelectedLevel = "L1" | "L2" | "L3";

interface QuestionItem {
  id: string;
  type: string;
  topic: string | null;
  status: string;
  content: Record<string, unknown>;
  domain_id: string | null;
  category_id: string | null;
}

type WizardStep = "config" | "generating" | "review";

interface CategoryConfig {
  category: CategoryItem;
  count: number;
  selectedTypes: string[];
  checked: boolean;
}

interface CategoryGenResult {
  categoryId: string;
  status: "pending" | "generating" | "done" | "failed";
  questionIds: string[];
  error: string | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function statusColor(s: string): { bg: string; color: string } {
  switch (s) {
    case "done": return { bg: "var(--aiq-color-success-soft)", color: "var(--aiq-color-success)" };
    case "failed": return { bg: "var(--aiq-color-error-soft, #fee2e2)", color: "var(--aiq-color-error, #dc2626)" };
    case "generating": return { bg: "var(--aiq-color-accent-soft)", color: "var(--aiq-color-accent)" };
    default: return { bg: "var(--aiq-color-bg-sunken)", color: "var(--aiq-color-fg-muted)" };
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function AdminGenerateWizard(): React.ReactElement {
  const [step, setStep] = useState<WizardStep>("config");

  // Config state
  const [selectedLevel, setSelectedLevel] = useState<SelectedLevel>("L1");
  const [domains, setDomains] = useState<DomainItem[]>([]);
  const [selectedDomainId, setSelectedDomainId] = useState<string>("");
  const [categoryConfigs, setCategoryConfigs] = useState<CategoryConfig[]>([]);

  // Loading / error state
  const [domainsLoading, setDomainsLoading] = useState(true);
  const [categoriesLoading, setCategoriesLoading] = useState(false);
  const [configError, setConfigError] = useState<string | null>(null);

  // Inline create domain state (B2)
  const [showNewDomain, setShowNewDomain] = useState(false);
  const [newDomainName, setNewDomainName] = useState("");
  const [newDomainDesc, setNewDomainDesc] = useState("");
  const [newDomainLoading, setNewDomainLoading] = useState(false);
  const [newDomainError, setNewDomainError] = useState<string | null>(null);

  // Inline create category state (B2)
  const [showNewCategory, setShowNewCategory] = useState(false);
  const [newCategoryName, setNewCategoryName] = useState("");
  const [newCategoryDesc, setNewCategoryDesc] = useState("");
  const [newCategoryLoading, setNewCategoryLoading] = useState(false);
  const [newCategoryError, setNewCategoryError] = useState<string | null>(null);

  // Generating state
  const [genResults, setGenResults] = useState<CategoryGenResult[]>([]);

  // Review state
  const [drafts, setDrafts] = useState<QuestionItem[]>([]);
  const [draftsLoading, setDraftsLoading] = useState(false);
  const [selectedDraftIds, setSelectedDraftIds] = useState<Set<string>>(new Set());
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTopic, setEditTopic] = useState<string>("");
  const [approveLoading, setApproveLoading] = useState(false);
  const [approveError, setApproveError] = useState<string | null>(null);

  // Fetch domains on mount
  useEffect(() => {
    setDomainsLoading(true);
    listDomainsApi()
      .then((res) => { setDomains(res.items); setDomainsLoading(false); })
      .catch(() => { setDomainsLoading(false); setConfigError("Failed to load domains"); });
  }, []);

  // Fetch categories when domain changes
  useEffect(() => {
    if (!selectedDomainId) { setCategoryConfigs([]); return; }
    setCategoriesLoading(true);
    listCategoriesApi(selectedDomainId)
      .then((res) => {
        const configs: CategoryConfig[] = res.items.map((cat) => ({
          category: cat,
          count: cat.default_question_count ?? 3,
          selectedTypes: Array.isArray(cat.supported_types)
            ? [...(cat.supported_types as string[])]
            : ["subjective", "scenario"],
          checked: cat.default_selected,
        }));
        setCategoryConfigs(configs);
        setCategoriesLoading(false);
      })
      .catch(() => { setCategoriesLoading(false); setConfigError("Failed to load categories"); });
  }, [selectedDomainId]);

  // Create domain handler (B2)
  const handleCreateDomain = useCallback(async () => {
    const name = newDomainName.trim();
    if (!name) { setNewDomainError("Name is required"); return; }
    setNewDomainLoading(true);
    setNewDomainError(null);
    try {
      const created = await createDomainApi({
        name,
        ...(newDomainDesc.trim() ? { description: newDomainDesc.trim() } : {}),
      });
      // Refetch domains list and auto-select the new one
      const res = await listDomainsApi();
      setDomains(res.items);
      setSelectedDomainId(created.id);
      setNewDomainName("");
      setNewDomainDesc("");
      setShowNewDomain(false);
    } catch (err) {
      setNewDomainError(err instanceof AdminApiError ? err.apiError.message : "Failed to create domain");
    }
    setNewDomainLoading(false);
  }, [newDomainName, newDomainDesc]);

  // Create category handler (B2)
  const handleCreateCategory = useCallback(async () => {
    const name = newCategoryName.trim();
    if (!name) { setNewCategoryError("Name is required"); return; }
    if (!selectedDomainId) { setNewCategoryError("Select a domain first"); return; }
    setNewCategoryLoading(true);
    setNewCategoryError(null);
    try {
      const created = await createCategoryApi({
        domain_id: selectedDomainId,
        name,
        ...(newCategoryDesc.trim() ? { description: newCategoryDesc.trim() } : {}),
      });
      // Refetch categories for selected domain and auto-select the new one
      const res = await listCategoriesApi(selectedDomainId);
      const configs: CategoryConfig[] = res.items.map((cat) => ({
        category: cat,
        count: cat.default_question_count ?? 3,
        selectedTypes: Array.isArray(cat.supported_types)
          ? [...(cat.supported_types as string[])]
          : ["subjective", "scenario"],
        checked: cat.id === created.id ? true : cat.default_selected,
      }));
      setCategoryConfigs(configs);
      setNewCategoryName("");
      setNewCategoryDesc("");
      setShowNewCategory(false);
    } catch (err) {
      setNewCategoryError(err instanceof AdminApiError ? err.apiError.message : "Failed to create category");
    }
    setNewCategoryLoading(false);
  }, [newCategoryName, newCategoryDesc, selectedDomainId]);

  // Generate handler — sequential to respect single-flight mutex
  const handleGenerate = useCallback(async () => {
    const checkedConfigs = categoryConfigs.filter((c) => c.checked);
    if (!selectedDomainId || !selectedLevel || checkedConfigs.length === 0) return;

    const initial: CategoryGenResult[] = checkedConfigs.map((c) => ({
      categoryId: c.category.id,
      status: "pending",
      questionIds: [],
      error: null,
    }));
    setGenResults(initial);
    setStep("generating");

    const results = [...initial];
    for (let i = 0; i < checkedConfigs.length; i++) {
      const cfg = checkedConfigs[i]!;
      results[i] = { ...results[i]!, status: "generating" };
      setGenResults([...results]);
      try {
        // Distribute count across selected types
        const typeCounts: Partial<Record<string, number>> = {};
        const n = cfg.selectedTypes.length;
        if (n > 0) {
          const base = Math.floor(cfg.count / n);
          let remainder = cfg.count - base * n;
          for (const t of cfg.selectedTypes) {
            typeCounts[t] = base + (remainder > 0 ? 1 : 0);
            if (remainder > 0) remainder--;
          }
        }
        const res = await generateForDomainApi(selectedDomainId, selectedLevel, {
          count: cfg.count,
          type_counts: typeCounts as Partial<Record<"mcq" | "log_analysis" | "scenario" | "kql" | "subjective", number>>,
          category_id: cfg.category.id,
        });
        results[i] = { ...results[i]!, status: "done", questionIds: res.questionIds };
      } catch (err) {
        const msg = err instanceof AdminApiError ? err.apiError.message : String(err);
        results[i] = { ...results[i]!, status: "failed", error: msg };
      }
      setGenResults([...results]);
    }

    // Load drafts for review — query by domain_id since we no longer have pack_id
    setDraftsLoading(true);
    try {
      const q = await adminApi<{ items: QuestionItem[]; total: number }>(
        `/admin/questions?status=ai_draft&pageSize=500`,
      );
      setDrafts(q.items);
      setSelectedDraftIds(new Set(q.items.map((d) => d.id)));
    } catch { /* non-critical */ }
    setDraftsLoading(false);
    setStep("review");
  }, [categoryConfigs, selectedDomainId, selectedLevel]);

  // Inline edit
  const startEdit = (draft: QuestionItem) => {
    setEditingId(draft.id);
    setEditTopic(draft.topic ?? "");
  };

  const saveEdit = useCallback(async (id: string) => {
    try {
      await adminApi(`/admin/questions/${id}`, { method: "PATCH", body: JSON.stringify({ topic: editTopic }) });
      setDrafts((prev) => prev.map((d) => d.id === id ? { ...d, topic: editTopic } : d));
    } catch { /* ignore */ }
    setEditingId(null);
  }, [editTopic]);

  // Approve
  const handleApprove = useCallback(async () => {
    const ids = [...selectedDraftIds];
    if (ids.length === 0) return;
    setApproveLoading(true);
    setApproveError(null);
    try {
      await bulkUpdateQuestionStatus({ ids, status: "active" });
      setDrafts((prev) => prev.filter((d) => !selectedDraftIds.has(d.id)));
      setSelectedDraftIds(new Set());
    } catch (err) {
      setApproveError(err instanceof AdminApiError ? err.apiError.message : "Approve failed");
    }
    setApproveLoading(false);
  }, [selectedDraftIds]);

  // ---------------------------------------------------------------------------
  // Render -- config step
  // ---------------------------------------------------------------------------

  function renderConfig(): React.ReactElement {
    const checkedCount = categoryConfigs.filter((c) => c.checked).length;
    const canGenerate = !!selectedDomainId && !!selectedLevel && checkedCount > 0;

    return (
      <div style={{ maxWidth: 760 }}>
        {configError && (
          <div style={{ marginBottom: "var(--aiq-space-md)", padding: "var(--aiq-space-sm) var(--aiq-space-md)", background: "var(--aiq-color-error-soft, #fee2e2)", color: "var(--aiq-color-error, #dc2626)", borderRadius: "var(--aiq-radius-md)", fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-sm)" }}>
            {configError}
          </div>
        )}

        <section style={{ marginBottom: "var(--aiq-space-xl)" }}>
          <h3 style={{ fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-base)", fontWeight: 600, color: "var(--aiq-color-fg-primary)", marginBottom: "var(--aiq-space-sm)" }}>
            Difficulty Level
          </h3>
          <div style={{ display: "flex", gap: "var(--aiq-space-md)" }}>
            {(["L1", "L2", "L3"] as SelectedLevel[]).map((lv) => (
              <label key={lv} style={{ display: "flex", alignItems: "center", gap: "var(--aiq-space-xs)", fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-sm)", color: "var(--aiq-color-fg-primary)", cursor: "pointer", padding: "var(--aiq-space-xs) var(--aiq-space-sm)", border: "1px solid", borderColor: selectedLevel === lv ? "var(--aiq-color-accent)" : "var(--aiq-color-border)", borderRadius: "var(--aiq-radius-md)", background: selectedLevel === lv ? "var(--aiq-color-accent-soft)" : "var(--aiq-color-bg-raised)" }}>
                <input type="radio" name="level" value={lv} checked={selectedLevel === lv} onChange={() => setSelectedLevel(lv)} style={{ accentColor: "var(--aiq-color-accent)" }} />
                {lv}
              </label>
            ))}
          </div>
        </section>

        <section style={{ marginBottom: "var(--aiq-space-xl)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "var(--aiq-space-sm)", marginBottom: "var(--aiq-space-sm)" }}>
            <h3 style={{ fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-base)", fontWeight: 600, color: "var(--aiq-color-fg-primary)", margin: 0 }}>Domain</h3>
            <button type="button" className="aiq-btn aiq-btn-ghost aiq-btn-sm" onClick={() => { setShowNewDomain((v) => !v); setNewDomainError(null); }} style={{ fontSize: "var(--aiq-text-xs)" }}>
              {showNewDomain ? "Cancel" : "+ New domain"}
            </button>
          </div>
          {showNewDomain && (
            <div style={{ marginBottom: "var(--aiq-space-sm)", padding: "var(--aiq-space-sm) var(--aiq-space-md)", background: "var(--aiq-color-bg-raised)", border: "1px solid var(--aiq-color-border)", borderRadius: "var(--aiq-radius-md)", display: "flex", flexDirection: "column", gap: "var(--aiq-space-xs)", maxWidth: 360 }}>
              {newDomainError && (
                <span style={{ fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-xs)", color: "var(--aiq-color-error, #dc2626)" }}>{newDomainError}</span>
              )}
              <input
                type="text"
                placeholder="Domain name (required)"
                value={newDomainName}
                onChange={(e) => setNewDomainName(e.target.value)}
                style={{ padding: "4px 8px", fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-sm)", border: "1px solid var(--aiq-color-border)", borderRadius: "var(--aiq-radius-sm)", background: "var(--aiq-color-bg-raised)" }}
              />
              <input
                type="text"
                placeholder="Description (optional)"
                value={newDomainDesc}
                onChange={(e) => setNewDomainDesc(e.target.value)}
                style={{ padding: "4px 8px", fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-sm)", border: "1px solid var(--aiq-color-border)", borderRadius: "var(--aiq-radius-sm)", background: "var(--aiq-color-bg-raised)" }}
              />
              <button type="button" className="aiq-btn aiq-btn-primary aiq-btn-sm" disabled={newDomainLoading || !newDomainName.trim()} onClick={() => void handleCreateDomain()}>
                {newDomainLoading ? "Creating..." : "Create Domain"}
              </button>
            </div>
          )}
          <select className="aiq-input" value={selectedDomainId} onChange={(e) => setSelectedDomainId(e.target.value)} disabled={domainsLoading} style={{ maxWidth: 360 }}>
            <option value="">-- Select a domain --</option>
            {domains.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </section>

        {selectedDomainId && (
          <section style={{ marginBottom: "var(--aiq-space-xl)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "var(--aiq-space-sm)", marginBottom: "var(--aiq-space-sm)" }}>
              <h3 style={{ fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-base)", fontWeight: 600, color: "var(--aiq-color-fg-primary)", margin: 0 }}>Categories</h3>
              <button type="button" className="aiq-btn aiq-btn-ghost aiq-btn-sm" onClick={() => { setShowNewCategory((v) => !v); setNewCategoryError(null); }} style={{ fontSize: "var(--aiq-text-xs)" }}>
                {showNewCategory ? "Cancel" : "+ New category"}
              </button>
            </div>
            {showNewCategory && (
              <div style={{ marginBottom: "var(--aiq-space-sm)", padding: "var(--aiq-space-sm) var(--aiq-space-md)", background: "var(--aiq-color-bg-raised)", border: "1px solid var(--aiq-color-border)", borderRadius: "var(--aiq-radius-md)", display: "flex", flexDirection: "column", gap: "var(--aiq-space-xs)", maxWidth: 440 }}>
                {newCategoryError && (
                  <span style={{ fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-xs)", color: "var(--aiq-color-error, #dc2626)" }}>{newCategoryError}</span>
                )}
                <input
                  type="text"
                  placeholder="Category name (required)"
                  value={newCategoryName}
                  onChange={(e) => setNewCategoryName(e.target.value)}
                  style={{ padding: "4px 8px", fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-sm)", border: "1px solid var(--aiq-color-border)", borderRadius: "var(--aiq-radius-sm)", background: "var(--aiq-color-bg-raised)" }}
                />
                <input
                  type="text"
                  placeholder="Description (optional)"
                  value={newCategoryDesc}
                  onChange={(e) => setNewCategoryDesc(e.target.value)}
                  style={{ padding: "4px 8px", fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-sm)", border: "1px solid var(--aiq-color-border)", borderRadius: "var(--aiq-radius-sm)", background: "var(--aiq-color-bg-raised)" }}
                />
                <button type="button" className="aiq-btn aiq-btn-primary aiq-btn-sm" disabled={newCategoryLoading || !newCategoryName.trim()} onClick={() => void handleCreateCategory()}>
                  {newCategoryLoading ? "Creating..." : "Create Category"}
                </button>
              </div>
            )}

            {categoriesLoading ? (
              <p style={{ fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-sm)", color: "var(--aiq-color-fg-muted)" }}>Loading categories...</p>
            ) : categoryConfigs.length === 0 ? (
              <p style={{ fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-sm)", color: "var(--aiq-color-fg-muted)" }}>No active categories for this domain.</p>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-sm)" }}>
                {categoryConfigs.map((cfg, i) => (
                  <div key={cfg.category.id} style={{ display: "flex", alignItems: "center", gap: "var(--aiq-space-md)", padding: "var(--aiq-space-sm) var(--aiq-space-md)", background: cfg.checked ? "var(--aiq-color-accent-soft)" : "var(--aiq-color-bg-raised)", border: "1px solid", borderColor: cfg.checked ? "var(--aiq-color-accent)" : "var(--aiq-color-border)", borderRadius: "var(--aiq-radius-md)" }}>
                    <input type="checkbox" checked={cfg.checked} onChange={(e) => { const next = [...categoryConfigs]; next[i] = { ...next[i]!, checked: e.target.checked }; setCategoryConfigs(next); }} style={{ flexShrink: 0, accentColor: "var(--aiq-color-accent)" }} />
                    <span style={{ flex: 1, fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-sm)", fontWeight: 500, color: "var(--aiq-color-fg-primary)" }}>{cfg.category.name}</span>
                    <div style={{ display: "flex", alignItems: "center", gap: "var(--aiq-space-xs)" }}>
                      <label style={{ fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-xs)", color: "var(--aiq-color-fg-muted)" }}>Count</label>
                      <input type="number" min={1} max={10} value={cfg.count} onChange={(e) => { const v = Math.max(1, Math.min(10, parseInt(e.target.value, 10) || 1)); const next = [...categoryConfigs]; next[i] = { ...next[i]!, count: v }; setCategoryConfigs(next); }} style={{ width: 52, padding: "2px 4px", fontFamily: "var(--aiq-font-mono)", fontSize: "var(--aiq-text-sm)", border: "1px solid var(--aiq-color-border)", borderRadius: "var(--aiq-radius-sm)", background: "var(--aiq-color-bg-raised)" }} />
                    </div>
                    <div style={{ display: "flex", gap: "var(--aiq-space-xs)", flexWrap: "wrap" }}>
                      {(Array.isArray(cfg.category.supported_types) ? cfg.category.supported_types as string[] : ["subjective", "scenario"]).map((t) => (
                        <label key={t} style={{ display: "flex", alignItems: "center", gap: 3, fontFamily: "var(--aiq-font-mono)", fontSize: 10, color: "var(--aiq-color-fg-secondary)", cursor: "pointer" }}>
                          <input type="checkbox" checked={cfg.selectedTypes.includes(t)} onChange={(e) => { const next = [...categoryConfigs]; next[i] = { ...next[i]!, selectedTypes: e.target.checked ? [...cfg.selectedTypes, t] : cfg.selectedTypes.filter((x) => x !== t) }; setCategoryConfigs(next); }} style={{ accentColor: "var(--aiq-color-accent)" }} />
                          {t}
                        </label>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        )}

        <button type="button" className="aiq-btn aiq-btn-primary" disabled={!canGenerate} onClick={() => void handleGenerate()}>
          Generate Question Set
        </button>
        {!canGenerate && (
          <span style={{ marginLeft: "var(--aiq-space-sm)", fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-xs)", color: "var(--aiq-color-fg-muted)" }}>
            Select a domain and at least one category first.
          </span>
        )}
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // Render -- generating step
  // ---------------------------------------------------------------------------

  function renderGenerating(): React.ReactElement {
    const checkedConfigs = categoryConfigs.filter((c) => c.checked);
    return (
      <div style={{ maxWidth: 600 }}>
        <p style={{ fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-sm)", color: "var(--aiq-color-fg-secondary)", marginBottom: "var(--aiq-space-md)" }}>
          Generating questions... please wait. This may take 30-90 seconds per category.
        </p>
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-sm)" }}>
          {genResults.map((r) => {
            const cfg = checkedConfigs.find((c) => c.category.id === r.categoryId);
            const sc = statusColor(r.status);
            return (
              <div key={r.categoryId} style={{ display: "flex", alignItems: "center", gap: "var(--aiq-space-md)", padding: "var(--aiq-space-sm) var(--aiq-space-md)", background: "var(--aiq-color-bg-raised)", border: "1px solid var(--aiq-color-border)", borderRadius: "var(--aiq-radius-md)" }}>
                <span style={{ flex: 1, fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-sm)", fontWeight: 500, color: "var(--aiq-color-fg-primary)" }}>{cfg?.category.name ?? r.categoryId}</span>
                <span style={{ padding: "2px 8px", borderRadius: "var(--aiq-radius-pill)", background: sc.bg, color: sc.color, fontFamily: "var(--aiq-font-mono)", fontSize: 10, textTransform: "uppercase" }}>{r.status}</span>
                {r.status === "done" && <span style={{ fontFamily: "var(--aiq-font-mono)", fontSize: "var(--aiq-text-xs)", color: "var(--aiq-color-fg-muted)" }}>{r.questionIds.length} questions</span>}
                {r.status === "failed" && r.error && <span style={{ fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-xs)", color: "var(--aiq-color-error, #dc2626)" }}>{r.error.slice(0, 80)}</span>}
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // Render -- review step
  // ---------------------------------------------------------------------------

  function renderReview(): React.ReactElement {
    const checkedConfigs = categoryConfigs.filter((c) => c.checked);
    const allSelected = drafts.length > 0 && drafts.every((d) => selectedDraftIds.has(d.id));
    const catIds = new Set(checkedConfigs.map((c) => c.category.id));

    return (
      <div style={{ maxWidth: 800 }}>
        <div style={{ display: "flex", alignItems: "center", gap: "var(--aiq-space-md)", marginBottom: "var(--aiq-space-lg)" }}>
          <h3 style={{ flex: 1, fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-base)", fontWeight: 600, color: "var(--aiq-color-fg-primary)", margin: 0 }}>
            Review AI Drafts ({drafts.length})
          </h3>
          <button type="button" className="aiq-btn aiq-btn-ghost aiq-btn-sm" onClick={() => { setStep("config"); setGenResults([]); setDrafts([]); setSelectedDraftIds(new Set()); }}>
            Back to config
          </button>
        </div>

        {approveError && (
          <div style={{ marginBottom: "var(--aiq-space-md)", padding: "var(--aiq-space-sm) var(--aiq-space-md)", background: "var(--aiq-color-error-soft, #fee2e2)", color: "var(--aiq-color-error, #dc2626)", borderRadius: "var(--aiq-radius-md)", fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-sm)" }}>{approveError}</div>
        )}

        {draftsLoading ? (
          <p style={{ fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-sm)", color: "var(--aiq-color-fg-muted)" }}>Loading drafts...</p>
        ) : drafts.length === 0 ? (
          <p style={{ fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-sm)", color: "var(--aiq-color-fg-muted)" }}>
            No ai_draft questions found. Generation may have failed or all were already approved.
          </p>
        ) : (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: "var(--aiq-space-md)", marginBottom: "var(--aiq-space-md)" }}>
              <label style={{ display: "flex", alignItems: "center", gap: "var(--aiq-space-xs)", fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-sm)", color: "var(--aiq-color-fg-secondary)", cursor: "pointer" }}>
                <input type="checkbox" checked={allSelected} onChange={(e) => { setSelectedDraftIds(e.target.checked ? new Set(drafts.map((d) => d.id)) : new Set()); }} style={{ accentColor: "var(--aiq-color-accent)" }} />
                Select all
              </label>
              <button type="button" className="aiq-btn aiq-btn-primary aiq-btn-sm" disabled={selectedDraftIds.size === 0 || approveLoading} onClick={() => void handleApprove()}>
                {approveLoading ? "Approving..." : `Approve Selected (${selectedDraftIds.size})`}
              </button>
            </div>

            {checkedConfigs.map((cfg) => {
              const catDrafts = drafts.filter((d) => d.category_id === cfg.category.id);
              if (catDrafts.length === 0) return null;
              return (
                <div key={cfg.category.id} style={{ marginBottom: "var(--aiq-space-xl)" }}>
                  <h4 style={{ fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-sm)", fontWeight: 600, color: "var(--aiq-color-fg-secondary)", marginBottom: "var(--aiq-space-sm)", textTransform: "uppercase", letterSpacing: "0.06em" }}>
                    {cfg.category.name} ({catDrafts.length})
                  </h4>
                  <div style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-sm)" }}>
                    {catDrafts.map((draft) => (
                      <div key={draft.id} style={{ padding: "var(--aiq-space-md)", background: "var(--aiq-color-bg-raised)", border: "1px solid", borderColor: selectedDraftIds.has(draft.id) ? "var(--aiq-color-accent)" : "var(--aiq-color-border)", borderRadius: "var(--aiq-radius-md)" }}>
                        <div style={{ display: "flex", alignItems: "flex-start", gap: "var(--aiq-space-sm)" }}>
                          <input type="checkbox" checked={selectedDraftIds.has(draft.id)} onChange={(e) => { const n = new Set(selectedDraftIds); e.target.checked ? n.add(draft.id) : n.delete(draft.id); setSelectedDraftIds(n); }} style={{ marginTop: 2, flexShrink: 0, accentColor: "var(--aiq-color-accent)" }} />
                          <div style={{ flex: 1 }}>
                            <div style={{ display: "flex", alignItems: "center", gap: "var(--aiq-space-xs)", marginBottom: 4 }}>
                              <span style={{ fontFamily: "var(--aiq-font-mono)", fontSize: 10, textTransform: "uppercase", padding: "1px 6px", background: "var(--aiq-color-bg-sunken)", borderRadius: "var(--aiq-radius-sm)", color: "var(--aiq-color-fg-muted)" }}>{draft.type}</span>
                            </div>
                            {editingId === draft.id ? (
                              <div style={{ display: "flex", gap: "var(--aiq-space-xs)" }}>
                                <input type="text" value={editTopic} onChange={(e) => setEditTopic(e.target.value)} style={{ flex: 1, padding: "4px 8px", fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-sm)", border: "1px solid var(--aiq-color-accent)", borderRadius: "var(--aiq-radius-sm)", background: "var(--aiq-color-bg-raised)" }} autoFocus />
                                <button type="button" className="aiq-btn aiq-btn-primary aiq-btn-sm" onClick={() => void saveEdit(draft.id)}>Save</button>
                                <button type="button" className="aiq-btn aiq-btn-ghost aiq-btn-sm" onClick={() => setEditingId(null)}>Cancel</button>
                              </div>
                            ) : (
                              <div style={{ display: "flex", alignItems: "baseline", gap: "var(--aiq-space-sm)" }}>
                                <span style={{ flex: 1, fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-sm)", color: "var(--aiq-color-fg-primary)" }}>{draft.topic ?? "(no topic)"}</span>
                                <button type="button" className="aiq-btn aiq-btn-ghost aiq-btn-sm" onClick={() => startEdit(draft)} style={{ flexShrink: 0 }}>Edit</button>
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}

            {drafts.filter((d) => !d.category_id || !catIds.has(d.category_id)).length > 0 && (
              <div style={{ marginBottom: "var(--aiq-space-xl)" }}>
                <h4 style={{ fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-sm)", fontWeight: 600, color: "var(--aiq-color-fg-secondary)", marginBottom: "var(--aiq-space-sm)", textTransform: "uppercase", letterSpacing: "0.06em" }}>
                  Uncategorized ({drafts.filter((d) => !d.category_id || !catIds.has(d.category_id)).length})
                </h4>
                <div style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-sm)" }}>
                  {drafts.filter((d) => !d.category_id || !catIds.has(d.category_id)).map((draft) => (
                    <div key={draft.id} style={{ padding: "var(--aiq-space-sm) var(--aiq-space-md)", background: "var(--aiq-color-bg-raised)", border: "1px solid var(--aiq-color-border)", borderRadius: "var(--aiq-radius-md)", display: "flex", alignItems: "center", gap: "var(--aiq-space-sm)" }}>
                      <input type="checkbox" checked={selectedDraftIds.has(draft.id)} onChange={(e) => { const n = new Set(selectedDraftIds); e.target.checked ? n.add(draft.id) : n.delete(draft.id); setSelectedDraftIds(n); }} style={{ accentColor: "var(--aiq-color-accent)" }} />
                      <span style={{ fontFamily: "var(--aiq-font-mono)", fontSize: 10, padding: "1px 6px", background: "var(--aiq-color-bg-sunken)", borderRadius: "var(--aiq-radius-sm)", color: "var(--aiq-color-fg-muted)", textTransform: "uppercase" }}>{draft.type}</span>
                      <span style={{ flex: 1, fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-sm)", color: "var(--aiq-color-fg-primary)" }}>{draft.topic ?? "(no topic)"}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // Main render
  // ---------------------------------------------------------------------------

  return (
    <AdminShell breadcrumbs={["Generate Questions"]} helpPage="admin.generate-wizard">
      <div>
        <div style={{ marginBottom: "var(--aiq-space-xl)" }}>
          <h2 style={{ fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-xl)", fontWeight: 700, color: "var(--aiq-color-fg-primary)", marginBottom: "var(--aiq-space-xs)" }}>
            Generate Question Set
          </h2>
          <p style={{ fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-sm)", color: "var(--aiq-color-fg-secondary)", margin: 0 }}>
            Pick a domain and categories, set per-category counts, then generate AI drafts for review.
          </p>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "var(--aiq-space-xs)", marginBottom: "var(--aiq-space-xl)" }}>
          {(["config", "generating", "review"] as WizardStep[]).map((s, i) => (
            <React.Fragment key={s}>
              {i > 0 && <span style={{ color: "var(--aiq-color-border-strong)", fontSize: 12 }}>{" -> "}</span>}
              <span style={{ fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-sm)", fontWeight: step === s ? 600 : 400, color: step === s ? "var(--aiq-color-accent)" : "var(--aiq-color-fg-muted)", textTransform: "capitalize" }}>
                {s === "config" ? "Configure" : s === "generating" ? "Generating" : "Review"}
              </span>
            </React.Fragment>
          ))}
        </div>
        {step === "config" && renderConfig()}
        {step === "generating" && renderGenerating()}
        {step === "review" && renderReview()}
      </div>
    </AdminShell>
  );
}
