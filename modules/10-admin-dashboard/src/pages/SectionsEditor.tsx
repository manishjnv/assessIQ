// Test sections editor for the "New assessment" form (from-set mode).
// Each row = one timed section: name, question count and/or categories, minutes,
// calculator. Output goes to settings.sections (validated server-side, module 05).
// Categories are optional: pick the domain they come from, then tick per section.

import React, { useEffect, useRef, useState } from "react";
import { HelpTip } from "@assessiq/help-system/components";
import { listDomainsApi, listCategoriesApi } from "../api.js";
import type { DomainItem, CategoryItem } from "../api.js";

export interface SectionRow {
  name: string;
  count: string; // text so the field can be empty
  minutes: string;
  calculator: boolean;
  categoryIds: string[];
  /** Z-131: lock the section after the candidate leaves it (needs a whole-test time). Absent = off. */
  locked?: boolean;
  /** Z-131: seconds per question, text so the field can be empty. Blank = none. */
  secondsPerQuestion?: string;
}

export const NEW_SECTION_ROW: SectionRow = { name: "", count: "", minutes: "", calculator: false, categoryIds: [] };

/** Z-131: one edit here when the take page countdown ships (Z-130). Remove the line from the editor. */
export const TIMER_LOCK_NOTE = "Do not turn these on for a live assessment until the take page countdown is shipped.";

export interface SectionsSettings {
  sections: Array<{
    name: string;
    question_count?: number;
    category_ids?: string[];
    minutes: number;
    calculator?: boolean;
    locked?: boolean;
    seconds_per_question?: number;
  }>;
}

/** Validate the rows and build settings.sections; `total` = sum of counts when every row has one. */
export function buildSections(
  rows: SectionRow[],
): { settings: SectionsSettings; total: number | null } | { error: string } {
  const sections: SectionsSettings["sections"] = [];
  for (const [i, r] of rows.entries()) {
    const label = `Section ${i + 1}`;
    const name = r.name.trim();
    const minutes = Number(r.minutes);
    const count = r.count.trim() === "" ? undefined : Number(r.count);
    const secondsText = (r.secondsPerQuestion ?? "").trim();
    const seconds = secondsText === "" ? undefined : Number(secondsText);
    if (name === "") return { error: `${label}: give it a name.` };
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 300) {
      return { error: `${label}: minutes must be a whole number from 1 to 300.` };
    }
    if (count !== undefined && (!Number.isInteger(count) || count < 1)) {
      return { error: `${label}: number of questions must be a whole number, 1 or more.` };
    }
    if (count === undefined && r.categoryIds.length === 0) {
      return { error: `${label}: set the number of questions or pick at least one category.` };
    }
    if (seconds !== undefined && (!Number.isInteger(seconds) || seconds < 10 || seconds > 3600)) {
      return { error: `${label}: seconds per question must be a whole number from 10 to 3600.` };
    }
    sections.push({
      name,
      minutes,
      ...(count !== undefined ? { question_count: count } : {}),
      ...(r.categoryIds.length > 0 ? { category_ids: r.categoryIds } : {}),
      ...(r.calculator ? { calculator: true } : {}),
      ...(r.locked === true ? { locked: true } : {}),
      ...(seconds !== undefined ? { seconds_per_question: seconds } : {}),
    });
  }
  const total = sections.every((s) => s.question_count !== undefined)
    ? sections.reduce((n, s) => n + (s.question_count as number), 0)
    : null;
  return { settings: { sections }, total };
}

const FIELD: React.CSSProperties = {
  padding: "4px 8px",
  fontFamily: "var(--aiq-font-sans)",
  fontSize: "var(--aiq-text-sm)",
  border: "1px solid var(--aiq-color-border)",
  borderRadius: "var(--aiq-radius-sm)",
  background: "var(--aiq-color-bg-raised)",
};

/**
 * `subjectSlug` undefined: the old free picker (any active subject). A string: the chosen set's
 * subject, preselected and locked. null: no set chosen, so no categories are offered.
 * `setId`: the chosen set. Ticked categories are cleared when it changes (create form only).
 */
export function SectionsEditor({
  rows,
  onChange,
  subjectSlug,
  setId,
  wholeTestMinutes,
}: {
  rows: SectionRow[];
  onChange: (rows: SectionRow[]) => void;
  subjectSlug?: string | null | undefined;
  setId?: string | null | undefined;
  /** Z-131: the assessment's whole-test time. The lock switch shows only when it is set. */
  wholeTestMinutes?: number | null | undefined;
}): React.ReactElement {
  const [domains, setDomains] = useState<DomainItem[]>([]);
  const [domainId, setDomainId] = useState("");
  const [categories, setCategories] = useState<CategoryItem[]>([]);
  const lockedMode = subjectSlug !== undefined;
  const lockedDomain = lockedMode && subjectSlug !== null ? domains.find((d) => d.slug === subjectSlug) : undefined;
  // Locked: the set's subject. Free: the picker value. No set: no subject at all.
  const effectiveDomainId = lockedMode ? (lockedDomain?.id ?? "") : domainId;

  useEffect(() => {
    void listDomainsApi()
      .then((d) => setDomains(d.items.filter((x) => x.status === "active")))
      .catch(() => setDomains([]));
  }, []);
  useEffect(() => {
    if (effectiveDomainId === "") {
      setCategories([]);
      return;
    }
    void listCategoriesApi(effectiveDomainId)
      .then((c) => setCategories(c.items.filter((x) => x.status === "active")))
      .catch(() => setCategories([]));
  }, [effectiveDomainId]);

  // A new set may have another subject: drop the ticks made for the old one. Skipped on mount,
  // so a saved section keeps its categories when the editor opens.
  const lastSetId = useRef(setId);
  useEffect(() => {
    if (lastSetId.current === setId) return;
    lastSetId.current = setId;
    if (rows.some((r) => r.categoryIds.length > 0)) {
      onChange(rows.map((r) => ({ ...r, categoryIds: [] })));
    }
  }, [setId]);

  const update = (i: number, patch: Partial<SectionRow>): void =>
    onChange(rows.map((r, k) => (k === i ? { ...r, ...patch } : r)));

  return (
    <fieldset
      style={{
        border: "1px solid var(--aiq-color-border)",
        borderRadius: "var(--aiq-radius-sm)",
        padding: "var(--aiq-space-sm) var(--aiq-space-md)",
        marginBottom: "var(--aiq-space-md)",
        fontFamily: "var(--aiq-font-sans)",
        fontSize: "var(--aiq-text-sm)",
      }}
    >
      <legend style={{ fontWeight: 500 }}>
        <HelpTip helpId="admin.assessment.sections"><span>Assessment sections</span></HelpTip>
      </legend>
      <p style={{ margin: "0 0 var(--aiq-space-sm)", color: "var(--aiq-color-fg-muted)" }}>
        Optional. Each section has its own timer and students cannot go back to a finished section.
        With no sections the assessment runs as one timed block.
      </p>

      {lockedMode
        ? rows.length > 0 && lockedDomain !== undefined && categories.length > 0 && (
          <label style={{ display: "block", marginBottom: "var(--aiq-space-sm)" }}>
            Categories from{" "}
            <select
              aria-label="Subject for category choices"
              style={FIELD}
              value={lockedDomain.id}
              disabled
            >
              <option value={lockedDomain.id}>{lockedDomain.name}</option>
            </select>
          </label>
        )
        : rows.length > 0 && domains.length > 0 && (
          <label style={{ display: "block", marginBottom: "var(--aiq-space-sm)" }}>
            Categories from{" "}
            <select
              aria-label="Subject for category choices"
              style={FIELD}
              value={domainId}
              onChange={(e) => setDomainId(e.target.value)}
            >
              <option value="">— none (use question counts only) —</option>
              {domains.map((d) => (
                <option key={d.id} value={d.id}>{d.name}</option>
              ))}
            </select>
          </label>
        )}

      {rows.map((r, i) => (
        <div
          key={i}
          style={{
            padding: "var(--aiq-space-sm)",
            marginBottom: "var(--aiq-space-sm)",
            border: "1px solid var(--aiq-color-border)",
            borderRadius: "var(--aiq-radius-md)",
            background: "var(--aiq-color-bg-raised)",
          }}
        >
          <div style={{ display: "flex", gap: "var(--aiq-space-sm)", flexWrap: "wrap", alignItems: "center" }}>
            <input
              aria-label={`Section ${i + 1} name`}
              placeholder="Name, e.g. Quantitative"
              maxLength={80}
              value={r.name}
              onChange={(e) => update(i, { name: e.target.value })}
              style={{ ...FIELD, minWidth: 180 }}
            />
            <input
              aria-label={`Section ${i + 1} number of questions`}
              type="number"
              min={1}
              placeholder="Questions"
              value={r.count}
              onChange={(e) => update(i, { count: e.target.value })}
              style={{ ...FIELD, width: 96 }}
            />
            <input
              aria-label={`Section ${i + 1} minutes`}
              type="number"
              min={1}
              max={300}
              placeholder="Minutes"
              value={r.minutes}
              onChange={(e) => update(i, { minutes: e.target.value })}
              style={{ ...FIELD, width: 88 }}
            />
            <label style={{ display: "flex", alignItems: "center", gap: "var(--aiq-space-xs)" }}>
              <input
                type="checkbox"
                checked={r.calculator}
                onChange={(e) => update(i, { calculator: e.target.checked })}
              />
              Calculator
            </label>
            {wholeTestMinutes != null && (
              <label style={{ display: "flex", alignItems: "center", gap: "var(--aiq-space-xs)" }}>
                <input
                  type="checkbox"
                  role="switch"
                  aria-label={`Section ${i + 1} lock after leaving`}
                  checked={r.locked === true}
                  onChange={(e) => update(i, { locked: e.target.checked })}
                />
                <HelpTip helpId="admin.assessment.sections.lock">
                  <span>Lock this section after leaving it</span>
                </HelpTip>
              </label>
            )}
            <label style={{ display: "flex", alignItems: "center", gap: "var(--aiq-space-xs)" }}>
              <HelpTip helpId="admin.assessment.sections.seconds_per_question">
                <span>Seconds per question</span>
              </HelpTip>
              <input
                aria-label={`Section ${i + 1} seconds per question`}
                type="number"
                min={10}
                max={3600}
                placeholder="None"
                value={r.secondsPerQuestion ?? ""}
                onChange={(e) => update(i, { secondsPerQuestion: e.target.value })}
                style={{ ...FIELD, width: 96 }}
              />
            </label>
            <button
              type="button"
              className="aiq-btn aiq-btn-sm aiq-btn-ghost"
              onClick={() => onChange(rows.filter((_, k) => k !== i))}
            >
              Remove
            </button>
          </div>
          {categories.length > 0 && (
            <div style={{ display: "flex", gap: "var(--aiq-space-sm)", flexWrap: "wrap", marginTop: "var(--aiq-space-xs)" }}>
              {categories.map((c) => (
                <label key={c.id} style={{ display: "flex", alignItems: "center", gap: 4 }}>
                  <input
                    type="checkbox"
                    checked={r.categoryIds.includes(c.id)}
                    onChange={(e) =>
                      update(i, {
                        categoryIds: e.target.checked
                          ? [...r.categoryIds, c.id]
                          : r.categoryIds.filter((x) => x !== c.id),
                      })
                    }
                  />
                  {c.name}
                </label>
              ))}
            </div>
          )}
        </div>
      ))}

      {rows.length > 0 && (
        <p style={{ margin: "0 0 var(--aiq-space-sm)", color: "var(--aiq-color-fg-muted)" }}>{TIMER_LOCK_NOTE}</p>
      )}

      {rows.length < 10 && (
        <button
          type="button"
          className="aiq-btn aiq-btn-sm aiq-btn-outline"
          onClick={() => onChange([...rows, { ...NEW_SECTION_ROW }])}
        >
          Add section
        </button>
      )}
    </fieldset>
  );
}
