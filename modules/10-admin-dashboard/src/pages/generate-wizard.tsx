// AssessIQ — Admin Generate Question Wizard page.
//
// /admin/generate-wizard
//
// Few-click AI generation: pick Level + Domain + Categories -> Generate -> Review.
// Reuses the existing generation engine (POST .../generate).
// No manual question authoring -- only AI drafts, inline edit, and approve.
//
// Slice 2.2 changes (D1-D5):
//  D1: Category Count input + type checkboxes disabled until category checkbox is ticked.
//  D2: Live per-category subtotal (K×C) + grand total on "Generate N questions" button.
//  D3-FE: Sends type_counts={type:C each} and count=K×C (per-type semantics).
//  D4: Sequential per-category progress with "Generating X of Y: <name>", ✓/✗ per cat,
//      persistent "you can leave" note, continue-on-failure isolation.
//  D5: Durable DB-backed Review reachable any time; groups by domain→category;
//      formatted question display (never raw JSON); inline Edit (PATCH); per-question
//      + bulk Approve; "Back to config" never discards; resume-on-return entry point.
//
// INVARIANTS:
//  - No "+ Add question" / manual authoring anywhere.
//  - Sequential generation calls (single-flight mutex on server).
//  - No claude/anthropic imports or copy.
//  - No hardcoded test data.

import React, { useEffect, useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { Spinner } from "@assessiq/ui-system";
import { AdminShell } from "../components/AdminShell.js";
import { MfaStepUp } from "../components/mfa-step-up.js";
import {
  adminApi,
  AdminApiError,
  generateForDomainApi,
  listDomainsApi,
  listCategoriesApi,
  createPlatformDomainApi,
  createCategoryApi,
  bulkUpdateQuestionStatus,
  listQuestionsApi,
  listGenerationAttempts,
} from "../api.js";
import type { DomainItem, CategoryItem, QuestionListItem, GenerationAttemptSummary } from "../api.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SelectedLevel = "L1" | "L2" | "L3";

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
  questionCount: number;
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

/** Compute grand total = Σ (selectedTypes.length × count) for checked categories. */
function computeGrandTotal(configs: CategoryConfig[]): number {
  return configs
    .filter((c) => c.checked && c.selectedTypes.length > 0)
    .reduce((sum, c) => sum + c.selectedTypes.length * c.count, 0);
}

/** Compute subtotal for one category: K × C. */
function categorySubtotal(cfg: CategoryConfig): number {
  return cfg.checked ? cfg.selectedTypes.length * cfg.count : 0;
}

/**
 * Render question content in a typed, formatted way.
 * Admin audience — answer/option fields ARE shown.
 * NEVER dumps raw JSON blobs.
 */
function renderQuestionContent(type: string, content: Record<string, unknown>): React.ReactElement {
  const labelStyle: React.CSSProperties = {
    fontFamily: "var(--aiq-font-sans)",
    fontSize: "var(--aiq-text-xs)",
    fontWeight: 600,
    color: "var(--aiq-color-fg-muted)",
    textTransform: "uppercase",
    letterSpacing: "0.06em",
    marginBottom: 2,
  };
  const textStyle: React.CSSProperties = {
    fontFamily: "var(--aiq-font-sans)",
    fontSize: "var(--aiq-text-sm)",
    color: "var(--aiq-color-fg-primary)",
    marginBottom: "var(--aiq-space-xs)",
    whiteSpace: "pre-wrap",
  };

  if (type === "mcq") {
    const question = typeof content["question"] === "string" ? content["question"] : null;
    const options = Array.isArray(content["options"]) ? content["options"] as unknown[] : null;
    const correct = content["correct_answer"] ?? content["correct"] ?? content["answer"];
    const rationale = typeof content["rationale"] === "string" ? content["rationale"] : null;
    return (
      <div>
        {question && (
          <div style={{ marginBottom: "var(--aiq-space-xs)" }}>
            <div style={labelStyle}>Question</div>
            <div style={textStyle}>{question}</div>
          </div>
        )}
        {options && options.length > 0 && (
          <div style={{ marginBottom: "var(--aiq-space-xs)" }}>
            <div style={labelStyle}>Options</div>
            <ol style={{ margin: 0, paddingLeft: "var(--aiq-space-lg)", fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-sm)", color: "var(--aiq-color-fg-primary)" }}>
              {options.map((o, idx) => (
                <li key={idx}>{typeof o === "string" ? o : JSON.stringify(o)}</li>
              ))}
            </ol>
          </div>
        )}
        {correct !== undefined && correct !== null && (
          <div style={{ marginBottom: "var(--aiq-space-xs)" }}>
            <div style={labelStyle}>Correct Answer</div>
            <div style={{ ...textStyle, color: "var(--aiq-color-success)" }}>{String(correct)}</div>
          </div>
        )}
        {rationale && (
          <div>
            <div style={labelStyle}>Rationale</div>
            <div style={textStyle}>{rationale}</div>
          </div>
        )}
      </div>
    );
  }

  if (type === "kql") {
    // Real kql content schema: { question, tables[], expected_keywords[], sample_solution }
    const question = typeof content["question"] === "string" ? content["question"] : null;
    const tables = Array.isArray(content["tables"]) ? content["tables"] as unknown[] : null;
    const keywords = Array.isArray(content["expected_keywords"]) ? content["expected_keywords"] as unknown[] : null;
    const sample = typeof content["sample_solution"] === "string" ? content["sample_solution"] : null;
    return (
      <div>
        {question && (
          <div style={{ marginBottom: "var(--aiq-space-xs)" }}>
            <div style={labelStyle}>Question</div>
            <div style={textStyle}>{question}</div>
          </div>
        )}
        {tables && tables.length > 0 && (
          <div style={{ marginBottom: "var(--aiq-space-xs)" }}>
            <div style={labelStyle}>Tables</div>
            <div style={textStyle}>{tables.map((t) => typeof t === "string" ? t : JSON.stringify(t)).join(", ")}</div>
          </div>
        )}
        {keywords && keywords.length > 0 && (
          <div style={{ marginBottom: "var(--aiq-space-xs)" }}>
            <div style={labelStyle}>Expected Keywords (answer key — admin only)</div>
            <div style={{ ...textStyle, color: "var(--aiq-color-success)" }}>
              {keywords.map((k) => typeof k === "string" ? k : JSON.stringify(k)).join(", ")}
            </div>
          </div>
        )}
        {sample && (
          <div>
            <div style={labelStyle}>Sample Solution (answer key — admin only)</div>
            <pre style={{ fontFamily: "var(--aiq-font-mono)", fontSize: 11, background: "var(--aiq-color-bg-sunken)", padding: "var(--aiq-space-xs)", borderRadius: "var(--aiq-radius-sm)", overflowX: "auto", whiteSpace: "pre-wrap", wordBreak: "break-all", color: "var(--aiq-color-success)" }}>
              {sample}
            </pre>
          </div>
        )}
      </div>
    );
  }

  if (type === "log_analysis") {
    // Real log_analysis schema: { question, log_format, log_excerpt, hint,
    //                             expected_findings, sample_solution }
    const question = typeof content["question"] === "string" ? content["question"] : null;
    const logFormat = typeof content["log_format"] === "string" ? content["log_format"] : null;
    const logExcerpt = typeof content["log_excerpt"] === "string" ? content["log_excerpt"] : null;
    const hint = typeof content["hint"] === "string" ? content["hint"] : null;
    const findingsRaw = content["expected_findings"];
    const findings = findingsRaw !== undefined && findingsRaw !== null
      ? (typeof findingsRaw === "string" ? findingsRaw : JSON.stringify(findingsRaw, null, 2))
      : null;
    const sample = typeof content["sample_solution"] === "string" ? content["sample_solution"] : null;
    return (
      <div>
        {question && (
          <div style={{ marginBottom: "var(--aiq-space-xs)" }}>
            <div style={labelStyle}>Question</div>
            <div style={textStyle}>{question}</div>
          </div>
        )}
        {logFormat && (
          <div style={{ marginBottom: "var(--aiq-space-xs)" }}>
            <div style={labelStyle}>Log Format</div>
            <div style={textStyle}>{logFormat}</div>
          </div>
        )}
        {logExcerpt && (
          <div style={{ marginBottom: "var(--aiq-space-xs)" }}>
            <div style={labelStyle}>Log Excerpt</div>
            <pre style={{ fontFamily: "var(--aiq-font-mono)", fontSize: 11, background: "var(--aiq-color-bg-sunken)", padding: "var(--aiq-space-xs)", borderRadius: "var(--aiq-radius-sm)", overflowX: "auto", whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
              {logExcerpt}
            </pre>
          </div>
        )}
        {hint && (
          <div style={{ marginBottom: "var(--aiq-space-xs)" }}>
            <div style={labelStyle}>Hint</div>
            <div style={textStyle}>{hint}</div>
          </div>
        )}
        {findings && (
          <div style={{ marginBottom: "var(--aiq-space-xs)" }}>
            <div style={labelStyle}>Expected Findings (answer key — admin only)</div>
            <div style={{ ...textStyle, color: "var(--aiq-color-success)" }}>
              {findings}
            </div>
          </div>
        )}
        {sample && (
          <div>
            <div style={labelStyle}>Sample Solution (answer key — admin only)</div>
            <pre style={{ fontFamily: "var(--aiq-font-mono)", fontSize: 11, background: "var(--aiq-color-bg-sunken)", padding: "var(--aiq-space-xs)", borderRadius: "var(--aiq-radius-sm)", overflowX: "auto", whiteSpace: "pre-wrap", wordBreak: "break-all", color: "var(--aiq-color-success)" }}>
              {sample}
            </pre>
          </div>
        )}
      </div>
    );
  }

  if (type === "scenario") {
    // Real scenario schema: { title, intro, steps[{prompt, expected?}], step_dependency }
    const title = typeof content["title"] === "string" ? content["title"] : null;
    const intro = typeof content["intro"] === "string" ? content["intro"] : null;
    const stepDep = typeof content["step_dependency"] === "string" ? content["step_dependency"] : null;
    const steps = Array.isArray(content["steps"]) ? content["steps"] as Array<Record<string, unknown>> : null;
    return (
      <div>
        {title && (
          <div style={{ marginBottom: "var(--aiq-space-xs)" }}>
            <div style={labelStyle}>Title</div>
            <div style={{ ...textStyle, fontWeight: 600 }}>{title}</div>
          </div>
        )}
        {intro && (
          <div style={{ marginBottom: "var(--aiq-space-xs)" }}>
            <div style={labelStyle}>Scenario</div>
            <div style={textStyle}>{intro}</div>
          </div>
        )}
        {stepDep && (
          <div style={{ marginBottom: "var(--aiq-space-xs)" }}>
            <div style={labelStyle}>Step Dependency</div>
            <div style={textStyle}>{stepDep}</div>
          </div>
        )}
        {steps && steps.length > 0 && (
          <div>
            <div style={labelStyle}>Steps</div>
            <ol style={{ margin: 0, paddingLeft: "var(--aiq-space-lg)", fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-sm)", color: "var(--aiq-color-fg-primary)" }}>
              {steps.map((s, idx) => {
                const prompt = typeof s["prompt"] === "string" ? s["prompt"] : JSON.stringify(s);
                const expected = typeof s["expected"] === "string" ? s["expected"] : null;
                return (
                  <li key={idx} style={{ marginBottom: "var(--aiq-space-xs)" }}>
                    <div style={{ whiteSpace: "pre-wrap" }}>{prompt}</div>
                    {expected && (
                      <div style={{ ...textStyle, color: "var(--aiq-color-success)", marginTop: 2, marginBottom: 0 }}>
                        Expected (answer key — admin only): {expected}
                      </div>
                    )}
                  </li>
                );
              })}
            </ol>
          </div>
        )}
      </div>
    );
  }

  // subjective (and any unknown type): real subjective schema is { question }.
  // Rubric lives in the separate `rubric` column, not in content — not shown here.
  const question = typeof content["question"] === "string" ? content["question"] : null;
  return (
    <div>
      {question ? (
        <div>
          <div style={labelStyle}>Question</div>
          <div style={textStyle}>{question}</div>
        </div>
      ) : (
        <div style={{ ...textStyle, color: "var(--aiq-color-fg-muted)", fontStyle: "italic" }}>
          (No renderable content for type "{type}".)
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function AdminGenerateWizard(): React.ReactElement {
  const navigate = useNavigate();
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
  const [showDomainMfa, setShowDomainMfa] = useState(false);

  // Inline create category state (B2)
  const [showNewCategory, setShowNewCategory] = useState(false);
  const [newCategoryName, setNewCategoryName] = useState("");
  const [newCategoryDesc, setNewCategoryDesc] = useState("");
  const [newCategoryLoading, setNewCategoryLoading] = useState(false);
  const [newCategoryError, setNewCategoryError] = useState<string | null>(null);

  // Generating state (D4)
  const [genResults, setGenResults] = useState<CategoryGenResult[]>([]);
  const [genCurrentIdx, setGenCurrentIdx] = useState<number>(0);

  // Review state (D5 — durable)
  const [drafts, setDrafts] = useState<QuestionListItem[]>([]);
  const [draftsLoading, setDraftsLoading] = useState(false);
  const [selectedDraftIds, setSelectedDraftIds] = useState<Set<string>>(new Set());
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTopic, setEditTopic] = useState<string>("");
  const [approveLoading, setApproveLoading] = useState(false);
  const [approveError, setApproveError] = useState<string | null>(null);
  const [reviewError, setReviewError] = useState<string | null>(null);

  // D5: on-mount check for existing drafts (resume-on-return)
  const [resumeCount, setResumeCount] = useState<number | null>(null);

  // ③ Resume-on-return for a generation that is still RUNNING server-side.
  // Progress during handleGenerate lives only in React state (genResults), so
  // navigating away and back used to drop straight to an empty config form even
  // though the server was still generating. We now query for a running attempt
  // on mount and, while one exists, show an "in progress" panel and poll until
  // it terminates — matching what Generation History shows live.
  const [runningAttempt, setRunningAttempt] = useState<GenerationAttemptSummary | null>(null);

  // Fetch domains on mount
  useEffect(() => {
    setDomainsLoading(true);
    listDomainsApi()
      .then((res) => { setDomains(res.items); setDomainsLoading(false); })
      .catch(() => { setDomainsLoading(false); setConfigError("Failed to load domains"); });
  }, []);

  // D5: check for existing ai_draft questions on mount to show resume banner
  useEffect(() => {
    listQuestionsApi({ status: "ai_draft", pageSize: 1 })
      .then((res) => { setResumeCount(res.total > 0 ? res.total : null); })
      .catch(() => { /* non-critical */ });
  }, []);

  // ③ On mount, detect a generation still running server-side (started in a
  // prior visit/tab). Single-flight means at most one is running platform-wide.
  useEffect(() => {
    let cancelled = false;
    listGenerationAttempts({ status: "running", limit: 1 })
      .then((res) => { if (!cancelled) setRunningAttempt(res.items[0] ?? null); })
      .catch(() => { /* non-critical — fall through to the normal config form */ });
    return () => { cancelled = true; };
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

  // Create domain handler (B2) — uses platform endpoint so domain propagates to all tenants
  const handleCreateDomain = useCallback(async () => {
    const name = newDomainName.trim();
    if (!name) { setNewDomainError("Name is required"); return; }
    setNewDomainLoading(true);
    setNewDomainError(null);
    try {
      const created = await createPlatformDomainApi({
        name,
        ...(newDomainDesc.trim() ? { description: newDomainDesc.trim() } : {}),
      });
      const res = await listDomainsApi();
      setDomains(res.items);
      setSelectedDomainId(created.id);
      setNewDomainName("");
      setNewDomainDesc("");
      setShowDomainMfa(false);
      setShowNewDomain(false);
    } catch (err) {
      if (err instanceof AdminApiError && err.status === 401 && /fresh totp/i.test(err.apiError.message)) {
        setShowDomainMfa(true);
        setNewDomainLoading(false);
        return;
      }
      setNewDomainError(err instanceof AdminApiError ? err.apiError.message : "Failed to create domain");
    }
    setNewDomainLoading(false);
  }, [newDomainName, newDomainDesc]);

  const handleDomainMfaVerified = useCallback(() => {
    setShowDomainMfa(false);
    void handleCreateDomain();
  }, [handleCreateDomain]);

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

  // D5: load all ai_draft questions for the review screen
  const loadDrafts = useCallback(async () => {
    setDraftsLoading(true);
    setReviewError(null);
    try {
      const q = await listQuestionsApi({ status: "ai_draft", pageSize: 500 });
      setDrafts(q.items);
      // Auto-select all for convenience
      setSelectedDraftIds(new Set(q.items.map((d) => d.id)));
      // Persist resume count
      setResumeCount(q.total > 0 ? q.total : null);
    } catch (err) {
      setReviewError(err instanceof AdminApiError ? err.apiError.message : "Failed to load drafts");
    }
    setDraftsLoading(false);
  }, []);

  // ③ While a running attempt is tracked, poll until it leaves the running set,
  // then load the resulting drafts and land on Review (same as a fresh generate).
  // Defined after loadDrafts so the dep reference is past its TDZ at render time.
  useEffect(() => {
    if (!runningAttempt) return;
    const trackedId = runningAttempt.id;
    let cancelled = false;
    const timer = window.setInterval(() => {
      listGenerationAttempts({ status: "running", limit: 5 })
        .then(async (res) => {
          if (cancelled) return;
          if (res.items.some((a) => a.id === trackedId)) return; // still running
          window.clearInterval(timer);
          setRunningAttempt(null);
          await loadDrafts();
          setStep("review");
        })
        .catch(() => { /* transient — retry on next tick */ });
    }, 4000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [runningAttempt, loadDrafts]);

  // Generate handler — sequential to respect single-flight mutex (D3-FE + D4)
  const handleGenerate = useCallback(async () => {
    const checkedConfigs = categoryConfigs.filter(
      (c) => c.checked && c.selectedTypes.length > 0,
    );
    if (!selectedDomainId || !selectedLevel || checkedConfigs.length === 0) return;

    const initial: CategoryGenResult[] = checkedConfigs.map((c) => ({
      categoryId: c.category.id,
      status: "pending",
      questionCount: 0,
      error: null,
    }));
    setGenResults(initial);
    setGenCurrentIdx(0);
    setStep("generating");

    const results = [...initial];
    for (let i = 0; i < checkedConfigs.length; i++) {
      const cfg = checkedConfigs[i]!;
      setGenCurrentIdx(i);
      results[i] = { ...results[i]!, status: "generating" };
      setGenResults([...results]);
      try {
        // D3-FE: per-type semantics — count = K×C, type_counts = {type: C each}
        // The server sends this to handleAdminGenerate which honors it in SHARDED mode.
        // In omnibus mode (default) type_counts is ignored server-side; the wizard
        // at least sends the correct count total so the right number of questions generates.
        const C = cfg.count;
        const typeCounts: Partial<Record<"mcq" | "log_analysis" | "scenario" | "kql" | "subjective", number>> = {};
        for (const t of cfg.selectedTypes) {
          typeCounts[t as "mcq" | "log_analysis" | "scenario" | "kql" | "subjective"] = C;
        }
        const totalCount = cfg.selectedTypes.length * C;

        const res = await generateForDomainApi(selectedDomainId, selectedLevel, {
          count: totalCount,
          type_counts: typeCounts,
          category_id: cfg.category.id,
        });
        results[i] = { ...results[i]!, status: "done", questionCount: res.generated };
      } catch (err) {
        const msg = err instanceof AdminApiError ? err.apiError.message : String(err);
        // D4: per-category failure — mark failed but continue remaining
        results[i] = { ...results[i]!, status: "failed", error: msg };
      }
      setGenResults([...results]);
    }

    // Load all drafts for the review screen after generation
    await loadDrafts();
    setStep("review");
  }, [categoryConfigs, selectedDomainId, selectedLevel, loadDrafts]);

  // Navigate to review — load fresh drafts from DB (D5: durable)
  const navigateToReview = useCallback(async () => {
    await loadDrafts();
    setStep("review");
  }, [loadDrafts]);

  // Inline edit
  const startEdit = (draft: QuestionListItem) => {
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

  // Approve selected
  const handleApprove = useCallback(async () => {
    const ids = [...selectedDraftIds];
    if (ids.length === 0) return;
    setApproveLoading(true);
    setApproveError(null);
    try {
      await bulkUpdateQuestionStatus({ ids, status: "active" });
      setDrafts((prev) => prev.filter((d) => !selectedDraftIds.has(d.id)));
      setSelectedDraftIds(new Set());
      // Update resume count
      setResumeCount((prev) => {
        const next = (prev ?? 0) - ids.length;
        return next > 0 ? next : null;
      });
    } catch (err) {
      setApproveError(err instanceof AdminApiError ? err.apiError.message : "Approve failed");
    }
    setApproveLoading(false);
  }, [selectedDraftIds]);

  // ---------------------------------------------------------------------------
  // Render -- config step
  // ---------------------------------------------------------------------------

  function renderConfig(): React.ReactElement {
    const checkedConfigs = categoryConfigs.filter((c) => c.checked && c.selectedTypes.length > 0);
    const grandTotal = computeGrandTotal(categoryConfigs);
    const canGenerate = !!selectedDomainId && !!selectedLevel && checkedConfigs.length > 0 && grandTotal > 0;

    return (
      <div style={{ maxWidth: 760 }}>
        {/* D5: Resume-on-return banner */}
        {resumeCount !== null && (
          <div style={{ marginBottom: "var(--aiq-space-lg)", padding: "var(--aiq-space-sm) var(--aiq-space-md)", background: "var(--aiq-color-accent-soft)", border: "1px solid var(--aiq-color-accent)", borderRadius: "var(--aiq-radius-md)", display: "flex", alignItems: "center", gap: "var(--aiq-space-md)" }}>
            <span style={{ flex: 1, fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-sm)", color: "var(--aiq-color-accent)" }}>
              You have <strong>{resumeCount}</strong> AI draft question{resumeCount !== 1 ? "s" : ""} awaiting review.
            </span>
            <button type="button" className="aiq-btn aiq-btn-primary aiq-btn-sm" onClick={() => void navigateToReview()}>
              Review drafts
            </button>
          </div>
        )}

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
              {showDomainMfa ? (
                <MfaStepUp
                  prompt="Re-verify your MFA to create this platform domain. Enter your 6-digit authenticator code."
                  confirmLabel="Verify & create"
                  onVerified={() => void handleDomainMfaVerified()}
                  onCancel={() => setShowDomainMfa(false)}
                />
              ) : (
                <>
                  <p style={{ margin: 0, fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-xs)", color: "var(--aiq-color-fg-secondary)" }}>
                    Not listed? Creating a domain here adds a <strong>platform domain</strong> shared across every company (requires a fresh MFA code).
                  </p>
                  {newDomainError && (
                    <span style={{ fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-xs)", color: "var(--aiq-color-error, #dc2626)" }}>{newDomainError}</span>
                  )}
                  <input type="text" placeholder="Domain name (required)" value={newDomainName} onChange={(e) => setNewDomainName(e.target.value)} style={{ padding: "4px 8px", fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-sm)", border: "1px solid var(--aiq-color-border)", borderRadius: "var(--aiq-radius-sm)", background: "var(--aiq-color-bg-raised)" }} />
                  <input type="text" placeholder="Description (optional)" value={newDomainDesc} onChange={(e) => setNewDomainDesc(e.target.value)} style={{ padding: "4px 8px", fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-sm)", border: "1px solid var(--aiq-color-border)", borderRadius: "var(--aiq-radius-sm)", background: "var(--aiq-color-bg-raised)" }} />
                  <button type="button" className="aiq-btn aiq-btn-primary aiq-btn-sm" disabled={newDomainLoading || !newDomainName.trim()} onClick={() => void handleCreateDomain()}>
                    {newDomainLoading ? "Creating..." : "Create Domain"}
                  </button>
                </>
              )}
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
                <input type="text" placeholder="Category name (required)" value={newCategoryName} onChange={(e) => setNewCategoryName(e.target.value)} style={{ padding: "4px 8px", fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-sm)", border: "1px solid var(--aiq-color-border)", borderRadius: "var(--aiq-radius-sm)", background: "var(--aiq-color-bg-raised)" }} />
                <input type="text" placeholder="Description (optional)" value={newCategoryDesc} onChange={(e) => setNewCategoryDesc(e.target.value)} style={{ padding: "4px 8px", fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-sm)", border: "1px solid var(--aiq-color-border)", borderRadius: "var(--aiq-radius-sm)", background: "var(--aiq-color-bg-raised)" }} />
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
                {categoryConfigs.map((cfg, i) => {
                  // D1: controls disabled unless category is checked
                  const controlsDisabled = !cfg.checked;
                  const subtotal = categorySubtotal(cfg);

                  return (
                    <div key={cfg.category.id} style={{ padding: "var(--aiq-space-sm) var(--aiq-space-md)", background: cfg.checked ? "var(--aiq-color-accent-soft)" : "var(--aiq-color-bg-raised)", border: "1px solid", borderColor: cfg.checked ? "var(--aiq-color-accent)" : "var(--aiq-color-border)", borderRadius: "var(--aiq-radius-md)" }}>
                      {/* Row 1: checkbox + name + count + types */}
                      <div style={{ display: "flex", alignItems: "center", gap: "var(--aiq-space-md)", flexWrap: "wrap" }}>
                        <input
                          type="checkbox"
                          checked={cfg.checked}
                          onChange={(e) => {
                            const next = [...categoryConfigs];
                            next[i] = { ...next[i]!, checked: e.target.checked };
                            setCategoryConfigs(next);
                          }}
                          style={{ flexShrink: 0, accentColor: "var(--aiq-color-accent)" }}
                        />
                        <span style={{ flex: 1, minWidth: 120, fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-sm)", fontWeight: 500, color: controlsDisabled ? "var(--aiq-color-fg-muted)" : "var(--aiq-color-fg-primary)" }}>
                          {cfg.category.name}
                        </span>

                        {/* D1: Count input — disabled when unchecked */}
                        <div style={{ display: "flex", alignItems: "center", gap: "var(--aiq-space-xs)" }}>
                          <label style={{ fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-xs)", color: "var(--aiq-color-fg-muted)" }}>
                            Count/type
                          </label>
                          <input
                            type="number"
                            min={1}
                            max={10}
                            value={cfg.count}
                            disabled={controlsDisabled}
                            onChange={(e) => {
                              const v = Math.max(1, Math.min(10, parseInt(e.target.value, 10) || 1));
                              const next = [...categoryConfigs];
                              next[i] = { ...next[i]!, count: v };
                              setCategoryConfigs(next);
                            }}
                            style={{ width: 52, padding: "2px 4px", fontFamily: "var(--aiq-font-mono)", fontSize: "var(--aiq-text-sm)", border: "1px solid var(--aiq-color-border)", borderRadius: "var(--aiq-radius-sm)", background: controlsDisabled ? "var(--aiq-color-bg-sunken)" : "var(--aiq-color-bg-raised)", opacity: controlsDisabled ? 0.5 : 1 }}
                          />
                        </div>

                        {/* D1: Type checkboxes — disabled when unchecked */}
                        <div style={{ display: "flex", gap: "var(--aiq-space-xs)", flexWrap: "wrap" }}>
                          {(Array.isArray(cfg.category.supported_types) ? cfg.category.supported_types as string[] : ["subjective", "scenario"]).map((t) => (
                            <label
                              key={t}
                              style={{ display: "flex", alignItems: "center", gap: 3, fontFamily: "var(--aiq-font-mono)", fontSize: 10, color: controlsDisabled ? "var(--aiq-color-fg-muted)" : "var(--aiq-color-fg-secondary)", cursor: controlsDisabled ? "not-allowed" : "pointer", opacity: controlsDisabled ? 0.5 : 1 }}
                            >
                              <input
                                type="checkbox"
                                checked={cfg.selectedTypes.includes(t)}
                                disabled={controlsDisabled}
                                onChange={(e) => {
                                  const next = [...categoryConfigs];
                                  next[i] = { ...next[i]!, selectedTypes: e.target.checked ? [...cfg.selectedTypes, t] : cfg.selectedTypes.filter((x) => x !== t) };
                                  setCategoryConfigs(next);
                                }}
                                style={{ accentColor: "var(--aiq-color-accent)" }}
                              />
                              {t}
                            </label>
                          ))}
                        </div>

                        {/* D2: per-category subtotal */}
                        {cfg.checked && subtotal > 0 && (
                          <span style={{ fontFamily: "var(--aiq-font-mono)", fontSize: "var(--aiq-text-xs)", color: "var(--aiq-color-accent)", whiteSpace: "nowrap" }}>
                            = {subtotal} q
                          </span>
                        )}
                        {cfg.checked && subtotal === 0 && (
                          <span style={{ fontFamily: "var(--aiq-font-mono)", fontSize: "var(--aiq-text-xs)", color: "var(--aiq-color-error, #dc2626)", whiteSpace: "nowrap" }}>
                            select a type
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        )}

        {/* D2: Generate button with grand total */}
        <div style={{ display: "flex", alignItems: "center", gap: "var(--aiq-space-md)" }}>
          <button
            type="button"
            className="aiq-btn aiq-btn-primary"
            disabled={!canGenerate}
            onClick={() => void handleGenerate()}
          >
            {grandTotal > 0 ? `Generate ${grandTotal} questions` : "Generate Question Set"}
          </button>
          {!canGenerate && (
            <span style={{ fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-xs)", color: "var(--aiq-color-fg-muted)" }}>
              {!selectedDomainId
                ? "Select a domain first."
                : categoryConfigs.filter((c) => c.checked).length === 0
                  ? "Tick at least one category."
                  : "Select at least one type per checked category."}
            </span>
          )}
        </div>
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // Render -- generating step (D4)
  // ---------------------------------------------------------------------------

  function renderGenerating(): React.ReactElement {
    const checkedConfigs = categoryConfigs.filter((c) => c.checked && c.selectedTypes.length > 0);
    const total = checkedConfigs.length;
    const currentResult = genResults[genCurrentIdx];
    const currentCfg = currentResult
      ? checkedConfigs.find((c) => c.category.id === currentResult.categoryId)
      : undefined;

    return (
      <div style={{ maxWidth: 640 }}>
        {/* D4: current progress line */}
        {currentResult?.status === "generating" && currentCfg && (
          <div style={{ marginBottom: "var(--aiq-space-lg)", padding: "var(--aiq-space-sm) var(--aiq-space-md)", background: "var(--aiq-color-accent-soft)", border: "1px solid var(--aiq-color-accent)", borderRadius: "var(--aiq-radius-md)", fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-sm)", color: "var(--aiq-color-accent)" }}>
            Generating category {genCurrentIdx + 1} of {total}: <strong>{currentCfg.category.name}</strong> ({currentCfg.selectedTypes.join(", ")})…
          </div>
        )}

        {/* D4: "you can leave" persistent note */}
        <div style={{ marginBottom: "var(--aiq-space-md)", padding: "var(--aiq-space-sm) var(--aiq-space-md)", background: "var(--aiq-color-bg-raised)", border: "1px solid var(--aiq-color-border)", borderRadius: "var(--aiq-radius-md)", fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-xs)", color: "var(--aiq-color-fg-muted)" }}>
          You can leave this page — completed categories are saved automatically and will be waiting under Review. Only the category currently generating would need re-running if you leave now.
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-sm)" }}>
          {genResults.map((r, idx) => {
            const cfg = checkedConfigs.find((c) => c.category.id === r.categoryId);
            const sc = statusColor(r.status);
            return (
              <div key={r.categoryId} style={{ display: "flex", alignItems: "center", gap: "var(--aiq-space-md)", padding: "var(--aiq-space-sm) var(--aiq-space-md)", background: "var(--aiq-color-bg-raised)", border: "1px solid var(--aiq-color-border)", borderRadius: "var(--aiq-radius-md)" }}>
                <span style={{ width: 20, flexShrink: 0, fontFamily: "var(--aiq-font-mono)", fontSize: 11, color: "var(--aiq-color-fg-muted)", textAlign: "right" }}>{idx + 1}</span>
                <span style={{ flex: 1, fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-sm)", fontWeight: 500, color: "var(--aiq-color-fg-primary)" }}>{cfg?.category.name ?? r.categoryId}</span>
                <span style={{ padding: "2px 8px", borderRadius: "var(--aiq-radius-pill)", background: sc.bg, color: sc.color, fontFamily: "var(--aiq-font-mono)", fontSize: 10, textTransform: "uppercase", flexShrink: 0 }}>
                  {r.status === "done" ? "✓ saved" : r.status === "failed" ? "✗ failed" : r.status}
                </span>
                {r.status === "done" && (
                  <span style={{ fontFamily: "var(--aiq-font-mono)", fontSize: "var(--aiq-text-xs)", color: "var(--aiq-color-fg-muted)", flexShrink: 0 }}>{r.questionCount} saved</span>
                )}
                {r.status === "failed" && r.error && (
                  <span style={{ fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-xs)", color: "var(--aiq-color-error, #dc2626)", maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={r.error}>{r.error}</span>
                )}
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // Render -- review step (D5 — durable)
  // ---------------------------------------------------------------------------

  function renderReview(): React.ReactElement {
    const allSelected = drafts.length > 0 && drafts.every((d) => selectedDraftIds.has(d.id));

    // Group drafts by category_id, then within each group by type
    // For draft without category, group under "Uncategorized"
    const byCategoryId = new Map<string | null, QuestionListItem[]>();
    for (const draft of drafts) {
      const key = draft.category_id ?? null;
      if (!byCategoryId.has(key)) byCategoryId.set(key, []);
      byCategoryId.get(key)!.push(draft);
    }

    // Build an ordered list: first known categories (in checkedConfigs order if possible), then null
    const knownCategoryIds = categoryConfigs.map((c) => c.category.id);
    const orderedKeys: (string | null)[] = [];
    for (const id of knownCategoryIds) {
      if (byCategoryId.has(id)) orderedKeys.push(id);
    }
    // Add any category_ids from drafts that weren't in our current wizard selection
    for (const key of byCategoryId.keys()) {
      if (key !== null && !orderedKeys.includes(key)) orderedKeys.push(key);
    }
    if (byCategoryId.has(null)) orderedKeys.push(null);

    return (
      <div style={{ maxWidth: 840 }}>
        <div style={{ display: "flex", alignItems: "center", gap: "var(--aiq-space-md)", marginBottom: "var(--aiq-space-lg)", flexWrap: "wrap" }}>
          <h3 style={{ flex: 1, fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-base)", fontWeight: 600, color: "var(--aiq-color-fg-primary)", margin: 0 }}>
            Review AI Drafts {draftsLoading ? "" : `(${drafts.length})`}
          </h3>
          <button type="button" className="aiq-btn aiq-btn-ghost aiq-btn-sm" onClick={() => void loadDrafts()} disabled={draftsLoading}>
            {draftsLoading ? "Loading…" : "Refresh"}
          </button>
          {/* D5: "Back to config" NEVER discards drafts — only navigates */}
          <button type="button" className="aiq-btn aiq-btn-ghost aiq-btn-sm" onClick={() => setStep("config")}>
            Back to config
          </button>
        </div>

        {/* D5: persistent note about durability */}
        <div style={{ marginBottom: "var(--aiq-space-md)", padding: "var(--aiq-space-xs) var(--aiq-space-md)", background: "var(--aiq-color-bg-raised)", border: "1px solid var(--aiq-color-border)", borderRadius: "var(--aiq-radius-md)", fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-xs)", color: "var(--aiq-color-fg-muted)" }}>
          Drafts are saved in the database. You can leave and return — they will be here. Approve moves questions to active status.
        </div>

        {approveError && (
          <div style={{ marginBottom: "var(--aiq-space-md)", padding: "var(--aiq-space-sm) var(--aiq-space-md)", background: "var(--aiq-color-error-soft, #fee2e2)", color: "var(--aiq-color-error, #dc2626)", borderRadius: "var(--aiq-radius-md)", fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-sm)" }}>{approveError}</div>
        )}
        {reviewError && (
          <div style={{ marginBottom: "var(--aiq-space-md)", padding: "var(--aiq-space-sm) var(--aiq-space-md)", background: "var(--aiq-color-error-soft, #fee2e2)", color: "var(--aiq-color-error, #dc2626)", borderRadius: "var(--aiq-radius-md)", fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-sm)" }}>{reviewError}</div>
        )}

        {draftsLoading ? (
          <p style={{ fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-sm)", color: "var(--aiq-color-fg-muted)" }}>Loading drafts…</p>
        ) : drafts.length === 0 ? (
          <p style={{ fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-sm)", color: "var(--aiq-color-fg-muted)" }}>
            No AI draft questions found. Generate some questions or check if all drafts have already been approved.
          </p>
        ) : (
          <>
            {/* Bulk controls */}
            <div style={{ display: "flex", alignItems: "center", gap: "var(--aiq-space-md)", marginBottom: "var(--aiq-space-md)", padding: "var(--aiq-space-sm) var(--aiq-space-md)", background: "var(--aiq-color-bg-raised)", border: "1px solid var(--aiq-color-border)", borderRadius: "var(--aiq-radius-md)" }}>
              <label style={{ display: "flex", alignItems: "center", gap: "var(--aiq-space-xs)", fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-sm)", color: "var(--aiq-color-fg-secondary)", cursor: "pointer" }}>
                <input type="checkbox" checked={allSelected} onChange={(e) => { setSelectedDraftIds(e.target.checked ? new Set(drafts.map((d) => d.id)) : new Set()); }} style={{ accentColor: "var(--aiq-color-accent)" }} />
                Select all
              </label>
              <button
                type="button"
                className="aiq-btn aiq-btn-primary aiq-btn-sm"
                disabled={selectedDraftIds.size === 0 || approveLoading}
                onClick={() => void handleApprove()}
              >
                {approveLoading ? "Approving…" : `Approve Selected (${selectedDraftIds.size})`}
              </button>
            </div>

            {/* D5: grouped by category */}
            {orderedKeys.map((catId) => {
              const catDrafts = byCategoryId.get(catId) ?? [];
              if (catDrafts.length === 0) return null;

              // Find category name from either wizard configs or draft's category
              const catCfg = categoryConfigs.find((c) => c.category.id === catId);
              const catName = catCfg?.category.name ?? (catId ? `Category ${catId.slice(0, 8)}…` : "Uncategorized");

              return (
                <div key={catId ?? "__uncategorized__"} style={{ marginBottom: "var(--aiq-space-xl)" }}>
                  <h4 style={{ fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-sm)", fontWeight: 600, color: "var(--aiq-color-fg-secondary)", marginBottom: "var(--aiq-space-sm)", textTransform: "uppercase", letterSpacing: "0.06em", display: "flex", alignItems: "center", gap: "var(--aiq-space-xs)" }}>
                    {catName}
                    <span style={{ fontWeight: 400, fontSize: "var(--aiq-text-xs)" }}>({catDrafts.length})</span>
                  </h4>
                  <div style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-sm)" }}>
                    {catDrafts.map((draft) => {
                      const isExpanded = expandedIds.has(draft.id);
                      return (
                        <div key={draft.id} style={{ padding: "var(--aiq-space-md)", background: "var(--aiq-color-bg-raised)", border: "1px solid", borderColor: selectedDraftIds.has(draft.id) ? "var(--aiq-color-accent)" : "var(--aiq-color-border)", borderRadius: "var(--aiq-radius-md)" }}>
                          {/* Header row */}
                          <div style={{ display: "flex", alignItems: "flex-start", gap: "var(--aiq-space-sm)" }}>
                            <input
                              type="checkbox"
                              checked={selectedDraftIds.has(draft.id)}
                              onChange={(e) => {
                                const n = new Set(selectedDraftIds);
                                if (e.target.checked) { n.add(draft.id); } else { n.delete(draft.id); }
                                setSelectedDraftIds(n);
                              }}
                              style={{ marginTop: 3, flexShrink: 0, accentColor: "var(--aiq-color-accent)" }}
                            />
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ display: "flex", alignItems: "center", gap: "var(--aiq-space-xs)", marginBottom: 4, flexWrap: "wrap" }}>
                                <span style={{ fontFamily: "var(--aiq-font-mono)", fontSize: 10, textTransform: "uppercase", padding: "1px 6px", background: "var(--aiq-color-bg-sunken)", borderRadius: "var(--aiq-radius-sm)", color: "var(--aiq-color-fg-muted)", flexShrink: 0 }}>{draft.type}</span>
                              </div>

                              {/* Topic (inline edit) */}
                              {editingId === draft.id ? (
                                <div style={{ display: "flex", gap: "var(--aiq-space-xs)", marginBottom: "var(--aiq-space-xs)" }}>
                                  <input
                                    type="text"
                                    value={editTopic}
                                    onChange={(e) => setEditTopic(e.target.value)}
                                    style={{ flex: 1, padding: "4px 8px", fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-sm)", border: "1px solid var(--aiq-color-accent)", borderRadius: "var(--aiq-radius-sm)", background: "var(--aiq-color-bg-raised)" }}
                                    autoFocus
                                  />
                                  <button type="button" className="aiq-btn aiq-btn-primary aiq-btn-sm" onClick={() => void saveEdit(draft.id)}>Save</button>
                                  <button type="button" className="aiq-btn aiq-btn-ghost aiq-btn-sm" onClick={() => setEditingId(null)}>Cancel</button>
                                </div>
                              ) : (
                                <div style={{ display: "flex", alignItems: "baseline", gap: "var(--aiq-space-sm)", marginBottom: "var(--aiq-space-xs)" }}>
                                  <span style={{ flex: 1, fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-sm)", color: "var(--aiq-color-fg-primary)", fontWeight: 500 }}>{draft.topic ?? "(no topic)"}</span>
                                  <button type="button" className="aiq-btn aiq-btn-ghost aiq-btn-sm" onClick={() => startEdit(draft)} style={{ flexShrink: 0 }}>Edit</button>
                                </div>
                              )}

                              {/* D5: Expand/collapse formatted content — never raw JSON */}
                              <div style={{ display: "flex", alignItems: "center", gap: "var(--aiq-space-sm)" }}>
                                <button
                                  type="button"
                                  className="aiq-btn aiq-btn-ghost aiq-btn-sm"
                                  onClick={() => {
                                    setExpandedIds((prev) => {
                                      const next = new Set(prev);
                                      if (next.has(draft.id)) { next.delete(draft.id); } else { next.add(draft.id); }
                                      return next;
                                    });
                                  }}
                                  style={{ fontSize: "var(--aiq-text-xs)" }}
                                >
                                  {isExpanded ? "Hide content" : "Show content"}
                                </button>
                                {/* Per-question Approve */}
                                <button
                                  type="button"
                                  className="aiq-btn aiq-btn-ghost aiq-btn-sm"
                                  disabled={approveLoading}
                                  onClick={() => {
                                    setSelectedDraftIds(new Set([draft.id]));
                                    void (async () => {
                                      setApproveLoading(true);
                                      setApproveError(null);
                                      try {
                                        await bulkUpdateQuestionStatus({ ids: [draft.id], status: "active" });
                                        setDrafts((prev) => prev.filter((d) => d.id !== draft.id));
                                        setSelectedDraftIds(new Set());
                                        setResumeCount((prev) => {
                                          const next = (prev ?? 1) - 1;
                                          return next > 0 ? next : null;
                                        });
                                      } catch (err) {
                                        setApproveError(err instanceof AdminApiError ? err.apiError.message : "Approve failed");
                                      }
                                      setApproveLoading(false);
                                    })();
                                  }}
                                  style={{ fontSize: "var(--aiq-text-xs)", color: "var(--aiq-color-success)" }}
                                >
                                  Approve
                                </button>
                              </div>

                              {/* D5: Formatted content display (never raw JSON) */}
                              {isExpanded && (
                                <div style={{ marginTop: "var(--aiq-space-sm)", padding: "var(--aiq-space-sm)", background: "var(--aiq-color-bg-sunken)", borderRadius: "var(--aiq-radius-sm)", borderLeft: "3px solid var(--aiq-color-accent)" }}>
                                  {renderQuestionContent(
                                    draft.type,
                                    draft.content as Record<string, unknown>,
                                  )}
                                </div>
                              )}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </>
        )}
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // Main render
  // ---------------------------------------------------------------------------

  // ③ Resumed in-progress panel — shown when a generation is still running
  // server-side (detected on mount). Replaces the step UI so the page reflects
  // the in-flight run; the poll effect flips to Review automatically when done.
  function renderRunningResume(): React.ReactElement {
    const att = runningAttempt;
    const requested = att ? ` for ${att.count_requested} question${att.count_requested === 1 ? "" : "s"}` : "";
    return (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          textAlign: "center",
          gap: "var(--aiq-space-md)",
          padding: "var(--aiq-space-xl)",
          background: "var(--aiq-color-bg-raised)",
          border: "1px solid var(--aiq-color-border)",
          borderRadius: "var(--aiq-radius-sm)",
        }}
        aria-live="polite"
      >
        <Spinner />
        <h3 style={{ fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-xl)", fontWeight: 700, color: "var(--aiq-color-fg-primary)", margin: 0 }}>
          Generation in progress…
        </h3>
        <p style={{ fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-sm)", color: "var(--aiq-color-fg-secondary)", maxWidth: 460, margin: 0 }}>
          A question-generation run{requested} is still working on the server. This page updates
          automatically when it finishes — you don't need to stay here.
        </p>
        <button
          type="button"
          className="aiq-btn aiq-btn-ghost aiq-btn-sm"
          onClick={() => navigate("/admin/generation-attempts")}
        >
          View generation history →
        </button>
      </div>
    );
  }

  return (
    <AdminShell breadcrumbs={["Generate Questions"]} helpPage="admin.generate-wizard">
      <div>
        <div style={{ marginBottom: "var(--aiq-space-xl)" }}>
          <h2 style={{ fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-xl)", fontWeight: 700, color: "var(--aiq-color-fg-primary)", marginBottom: "var(--aiq-space-xs)" }}>
            Generate Question Set
          </h2>
          <p style={{ fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-sm)", color: "var(--aiq-color-fg-secondary)", margin: 0 }}>
            Pick a domain and categories, set per-type counts, then generate AI drafts for review.
          </p>
        </div>

        {runningAttempt ? (
          renderRunningResume()
        ) : (
          <>
            {/* Step nav — config/review are always navigable; generating is transient */}
            <div style={{ display: "flex", alignItems: "center", gap: "var(--aiq-space-xs)", marginBottom: "var(--aiq-space-xl)" }}>
              {(["config", "generating", "review"] as WizardStep[]).map((s, i) => (
                <React.Fragment key={s}>
                  {i > 0 && <span style={{ color: "var(--aiq-color-border-strong)", fontSize: 12 }}>{" → "}</span>}
                  <button
                    type="button"
                    style={{ background: "none", border: "none", padding: 0, cursor: step === "generating" || s === "generating" ? "default" : "pointer", fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-sm)", fontWeight: step === s ? 600 : 400, color: step === s ? "var(--aiq-color-accent)" : "var(--aiq-color-fg-muted)", textDecoration: "none", textTransform: "capitalize" }}
                    disabled={s === "generating"}
                    onClick={() => {
                      if (s === "config") { setStep("config"); return; }
                      if (s === "review") { void navigateToReview(); }
                    }}
                  >
                    {s === "config" ? "Configure" : s === "generating" ? "Generating" : "Review"}
                  </button>
                </React.Fragment>
              ))}
            </div>

            {step === "config" && renderConfig()}
            {step === "generating" && renderGenerating()}
            {step === "review" && renderReview()}
          </>
        )}
      </div>
    </AdminShell>
  );
}
