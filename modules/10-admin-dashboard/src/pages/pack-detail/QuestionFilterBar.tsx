// EXP-5: search box and facet filters for the questions of one question set.
// Server does the work: GET /admin/questions (filters) and /admin/questions/facets (counts).
// Every control has a help id under the pack page prefix (admin.question_bank.pack).
import React, { useEffect, useState } from "react";
import { HelpTip } from "@assessiq/help-system/components";
import { adminApi } from "../../api.js";
import { humanize } from "../../lib/labels.js";

export type QuestionFilters = {
  [K in
    | "q" | "stage_id" | "subject_id" | "unit_id" | "outcome_id" | "difficulty_min" | "difficulty_max"
    | "origin" | "rights_status" | "review_state" | "language" | "has_solution" | "has_passage"]?: string | undefined;
};

interface Bucket { value: string; count: number }
interface NodeBucket { node_id: string; label: string; count: number }
interface Facets {
  total: number;
  origin: Bucket[]; rights_status: Bucket[]; review_state: Bucket[]; language: Bucket[];
  difficulty: Bucket[]; has_solution: Bucket[];
  stage: NodeBucket[]; subject: NodeBucket[]; unit: NodeBucket[]; outcome: NodeBucket[];
}

/** Query string (leading "&") for the non-empty filters; "" when none. */
export function filtersToQuery(f: QuestionFilters): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(f)) if (v !== undefined && v !== "") p.set(k, v);
  const s = p.toString();
  return s === "" ? "" : `&${s}`;
}

const bucketLabel = (v: string): string => (v === "none" ? "Not set" : humanize(v));
const countOf = (rows: Bucket[], v: string): number => rows.find((r) => r.value === v)?.count ?? 0;

const fieldStyle: React.CSSProperties = {
  fontFamily: "var(--aiq-font-sans)",
  fontSize: "var(--aiq-text-sm)",
  padding: "var(--aiq-space-xs) var(--aiq-space-sm)",
  border: "1px solid var(--aiq-color-border)",
  borderRadius: "var(--aiq-radius-sm)",
  background: "var(--aiq-color-bg-base)",
  color: "var(--aiq-color-fg-primary)",
};

export function QuestionFilterBar(props: {
  packId: string;
  value: QuestionFilters;
  onChange: (next: QuestionFilters) => void;
}): React.ReactElement {
  const { packId, value, onChange } = props;
  const [facets, setFacets] = useState<Facets | null>(null);
  const [qInput, setQInput] = useState(value.q ?? "");
  const queryString = filtersToQuery(value);

  // Counts follow the current filters; a facet ignores its own filter, so options never vanish.
  useEffect(() => {
    let live = true;
    adminApi<Facets>(`/admin/questions/facets?pack_id=${encodeURIComponent(packId)}${queryString}`)
      .then((f) => { if (live) setFacets(f); })
      .catch(() => { if (live) setFacets(null); });
    return () => { live = false; };
  }, [packId, queryString]);

  // Search runs 300 ms after the last key.
  useEffect(() => {
    const t = setTimeout(() => {
      const next = qInput.trim();
      if (next !== (value.q ?? "")) onChange({ ...value, q: next === "" ? undefined : next });
    }, 300);
    return () => clearTimeout(t);
  }, [qInput]);

  const set = (k: keyof QuestionFilters, v: string): void => onChange({ ...value, [k]: v === "" ? undefined : v });
  const active = Object.values(value).some((v) => v !== undefined && v !== "");

  const bucketSelect = (key: keyof QuestionFilters, helpId: string, label: string, rows: Bucket[]): React.ReactElement => (
    <HelpTip helpId={helpId}>
      <label style={{ display: "flex", flexDirection: "column", gap: 2, fontSize: "var(--aiq-text-xs)" }}>
        {label}
        <select style={fieldStyle} value={value[key] ?? ""} onChange={(e) => set(key, e.target.value)}>
          <option value="">All</option>
          {rows.map((r) => <option key={r.value} value={r.value}>{bucketLabel(r.value)} ({r.count})</option>)}
        </select>
      </label>
    </HelpTip>
  );
  const nodeSelect = (key: keyof QuestionFilters, helpId: string, label: string, rows: NodeBucket[]): React.ReactElement => (
    <HelpTip helpId={helpId}>
      <label style={{ display: "flex", flexDirection: "column", gap: 2, fontSize: "var(--aiq-text-xs)" }}>
        {label}
        <select style={fieldStyle} value={value[key] ?? ""} onChange={(e) => set(key, e.target.value)}>
          <option value="">All</option>
          {rows.map((r) => <option key={r.node_id} value={r.node_id}>{r.label} ({r.count})</option>)}
        </select>
      </label>
    </HelpTip>
  );

  const f = facets;
  const diff = f?.difficulty ?? [];
  const levels = ["1", "2", "3", "4", "5"];
  return (
    <div
      style={{ display: "flex", flexWrap: "wrap", gap: "var(--aiq-space-sm)", alignItems: "flex-end", marginBottom: "var(--aiq-space-md)" }}
    >
      <HelpTip helpId="admin.question_bank.pack.filter_search">
        <label style={{ display: "flex", flexDirection: "column", gap: 2, fontSize: "var(--aiq-text-xs)", minWidth: 220 }}>
          Search questions
          <input
            type="search"
            style={fieldStyle}
            value={qInput}
            maxLength={200}
            placeholder="Words from the question or answers"
            onChange={(e) => setQInput(e.target.value)}
          />
        </label>
      </HelpTip>
      {nodeSelect("stage_id", "admin.question_bank.pack.filter_stage", "Exam stage", f?.stage ?? [])}
      {nodeSelect("subject_id", "admin.question_bank.pack.filter_subject", "Subject", f?.subject ?? [])}
      {nodeSelect("unit_id", "admin.question_bank.pack.filter_unit", "Topic", f?.unit ?? [])}
      {nodeSelect("outcome_id", "admin.question_bank.pack.filter_outcome", "Subtopic", f?.outcome ?? [])}
      <HelpTip helpId="admin.question_bank.pack.filter_difficulty">
        <span style={{ display: "flex", flexDirection: "column", gap: 2, fontSize: "var(--aiq-text-xs)" }}>
          Difficulty (1 easy, 5 hard)
          <span style={{ display: "flex", gap: 4 }}>
            <select aria-label="Lowest difficulty" style={fieldStyle} value={value.difficulty_min ?? ""} onChange={(e) => set("difficulty_min", e.target.value)}>
              <option value="">Any</option>
              {levels.map((l) => <option key={l} value={l}>{l} ({countOf(diff, l)})</option>)}
            </select>
            <select aria-label="Highest difficulty" style={fieldStyle} value={value.difficulty_max ?? ""} onChange={(e) => set("difficulty_max", e.target.value)}>
              <option value="">Any</option>
              {levels.map((l) => <option key={l} value={l}>{l}</option>)}
            </select>
          </span>
        </span>
      </HelpTip>
      {bucketSelect("origin", "admin.question_bank.pack.filter_origin", "Origin", f?.origin ?? [])}
      {bucketSelect("rights_status", "admin.question_bank.pack.filter_rights", "Rights", f?.rights_status ?? [])}
      {bucketSelect("review_state", "admin.question_bank.pack.filter_review", "Review", f?.review_state ?? [])}
      {bucketSelect("language", "admin.question_bank.pack.filter_language", "Language", f?.language ?? [])}
      <HelpTip helpId="admin.question_bank.pack.filter_solution">
        <label style={{ display: "flex", flexDirection: "column", gap: 2, fontSize: "var(--aiq-text-xs)" }}>
          Solution
          <select style={fieldStyle} value={value.has_solution ?? ""} onChange={(e) => set("has_solution", e.target.value)}>
            <option value="">All</option>
            <option value="true">With solution ({countOf(f?.has_solution ?? [], "true")})</option>
            <option value="false">Without solution ({countOf(f?.has_solution ?? [], "false")})</option>
          </select>
        </label>
      </HelpTip>
      <HelpTip helpId="admin.question_bank.pack.filter_passage">
        <label style={{ display: "flex", flexDirection: "column", gap: 2, fontSize: "var(--aiq-text-xs)" }}>
          Passage
          <select style={fieldStyle} value={value.has_passage ?? ""} onChange={(e) => set("has_passage", e.target.value)}>
            <option value="">All</option>
            <option value="true">With passage</option>
            <option value="false">Without passage</option>
          </select>
        </label>
      </HelpTip>
      {active && (
        <button type="button" className="aiq-btn aiq-btn-ghost aiq-btn-sm" onClick={() => { setQInput(""); onChange({}); }}>
          Clear filters
        </button>
      )}
      {f !== null && (
        <span style={{ fontSize: "var(--aiq-text-xs)", color: "var(--aiq-color-fg-muted)" }} aria-live="polite">
          {f.total} {f.total === 1 ? "question" : "questions"}
        </span>
      )}
    </div>
  );
}
