import React, { useEffect, useState } from "react";
import { AdminApiError, listDomainsApi, listCategoriesApi } from "../../api.js";
import type { DomainItem, CategoryItem } from "../../api.js";
import { HelpTip } from "@assessiq/help-system/components";
import { FrameworkTreePicker } from "../../components/FrameworkTreePicker.js";
import { type BlueprintLevel, BLUEPRINT_LEVELS, DIFFICULTY_LABEL, type BlueprintCriterion, type BlueprintCategoryRow, blueprintLiveTotal, flattenToCriteria } from "./shared.js";

interface BlueprintBuilderProps {
  onBlueprintChange: (bp: { domain_id: string; level: BlueprintLevel; criteria: BlueprintCriterion[] } | null) => void;
  /** Set of entitled domain scope_ids. null = fail-open (show all). Empty set + not null = no content enabled yet. */
  entitledDomains: Set<string> | null;
  /** When true, skip filtering entirely (internal/unlimited tenant). */
  skipFilter: boolean;
}

export function BlueprintBuilder({ onBlueprintChange, entitledDomains, skipFilter }: BlueprintBuilderProps): React.ReactElement {
  const [domains, setDomains] = useState<DomainItem[]>([]);
  const [domainsLoading, setDomainsLoading] = useState(true);
  const [domainsError, setDomainsError] = useState<string | null>(null);

  const [selectedDomainId, setSelectedDomainId] = useState<string>("");
  const [selectedLevel, setSelectedLevel] = useState<BlueprintLevel>("L1");
  // RW-61: framework node as an alternative way to choose the subject (domain).
  const [fwPick, setFwPick] = useState<string[]>([]);
  const [fwNoMatch, setFwNoMatch] = useState(false);

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
          err instanceof AdminApiError ? err.apiError.message : "Failed to load subjects.",
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
        Blueprint mode: each candidate draws a fresh random set per criterion. Subject + Difficulty resolve
        the question set automatically. Count = questions per checked type.
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
              <span>Subject</span>
            </HelpTip>
          </div>
          {domainsLoading ? (
            <span style={{ fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-sm)", color: "var(--aiq-color-fg-muted)" }}>
              Loading…
            </span>
          ) : !skipFilter && entitledDomains !== null && domains.length === 0 ? (
            <span style={{ fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-sm)", color: "var(--aiq-color-fg-muted)" }}>
              No content is enabled for your organisation yet — contact your platform operator.
            </span>
          ) : (
            <>
              <select
                className="aiq-input"
                value={selectedDomainId}
                onChange={(e) => setSelectedDomainId(e.target.value)}
                disabled={domains.length === 0}
              >
                <option value="">— Select subject —</option>
                {domains.map((d) => (
                  <option key={d.id} value={d.id}>{d.name}</option>
                ))}
              </select>
              <div style={{ marginTop: "var(--aiq-space-xs)" }}>
                <div style={{ ...labelStyle, textTransform: "none", letterSpacing: 0 }}>Or pick a subject from a framework</div>
                <FrameworkTreePicker
                  kinds={["subject"]}
                  value={fwPick}
                  helpId="admin.assessments.blueprint.framework_pick"
                  onChange={(ids) => {
                    setFwPick(ids);
                    if (ids.length === 0) { setFwNoMatch(false); return; }
                    const match = domains.find((d) => (d as DomainItem & { node_id?: string | null }).node_id === ids[0]);
                    setFwNoMatch(!match);
                    if (match) setSelectedDomainId(match.id);
                  }}
                />
                {fwNoMatch && (
                  <p style={{ fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-xs)", color: "var(--aiq-color-fg-muted)", margin: "4px 0 0" }}>
                    No question set uses this node yet.
                  </p>
                )}
              </div>
              {!skipFilter && entitledDomains !== null && (
                <p style={{ fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-xs)", color: "var(--aiq-color-fg-muted)", margin: "4px 0 0" }}>
                  Only content your organisation is entitled to is shown. Contact your platform operator to enable more.
                </p>
              )}
            </>
          )}
        </div>
        <div>
          <div style={labelStyle}>Difficulty</div>
          <select
            className="aiq-input"
            value={selectedLevel}
            onChange={(e) => setSelectedLevel(e.target.value as BlueprintLevel)}
          >
            {BLUEPRINT_LEVELS.map((l) => (
              <option key={l} value={l}>{DIFFICULTY_LABEL[l]}</option>
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
              No active categories in this subject.
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
                          fontSize: "var(--aiq-text-xs)",
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

