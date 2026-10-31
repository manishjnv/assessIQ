// AssessIQ — Exam blueprint editor (super admin only). Used by pages/exam-blueprints.tsx.
//
// Writes:
//   POST /api/admin/blueprints       -> create a pattern (createBlueprintApi, below)
//   PUT  /api/admin/blueprints/:id   -> save a change (saveBlueprintEditionApi). A verified edition is
//                                       never edited: the server adds a new edition row when the label is new.
// The client checks in buildBlueprintBody mirror BlueprintBodySchema and its superRefine rules in
// modules/04-question-bank/src/exam-blueprints.ts. The server checks again and stays the authority.
// Fields the page does not show (stage, subject, allowed question types) keep their stored values on edit.

import React, { useState } from "react";
import { HelpTip } from "@assessiq/help-system/components";
import { adminApi, AdminApiError } from "../api.js";
import { saveBlueprintEditionApi } from "../api/exam-blueprints.js";
import type { BlueprintSection, BlueprintWriteBody, ExamBlueprintFull } from "../api/exam-blueprints.js";

const sans: React.CSSProperties = { fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-sm)", color: "var(--aiq-color-fg-primary)" };
const muted: React.CSSProperties = { ...sans, color: "var(--aiq-color-fg-muted)", fontSize: "var(--aiq-text-xs)" };
const fieldStyle: React.CSSProperties = {
  fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-sm)", padding: "var(--aiq-space-xs) var(--aiq-space-sm)",
  border: "1px solid var(--aiq-color-border)", borderRadius: "var(--aiq-radius-sm)",
  background: "var(--aiq-color-bg-base)", color: "var(--aiq-color-fg-primary)",
};
const labelStyle: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 2, fontSize: "var(--aiq-text-xs)", minWidth: 180 };
const rowStyle: React.CSSProperties = { display: "flex", flexWrap: "wrap", gap: "var(--aiq-space-sm)", alignItems: "flex-end" };
const sectionBox: React.CSSProperties = {
  display: "flex", flexDirection: "column", gap: "var(--aiq-space-sm)", padding: "var(--aiq-space-sm)",
  border: "1px solid var(--aiq-color-border)", borderRadius: "var(--aiq-radius-md)", margin: 0,
};
const checkStyle: React.CSSProperties = { ...sans, display: "flex", gap: "var(--aiq-space-xs)", alignItems: "center" };

/** Form state: every number is text until it is checked, so an empty box is told apart from a zero. */
export interface SectionForm {
  uid: string;
  name: string;
  question_count: string;
  marks_per_question: string;
  negative_marks_per_question: string;
  minutes: string;
  sectional_timing: boolean;
  qualifying: boolean;
  cutoff_marks: string;
  calculator_allowed: boolean;
  subject_node_id: string | null;
  allowed_types: string[];
}

export interface PatternForm {
  name: string;
  edition: string;
  total_minutes: string;
  qualifying: boolean;
  verified: boolean;
  source_note: string;
  max_questions: string;
  owner_contact: string;
  sections: SectionForm[];
}

let uidSeq = 0;
const nextUid = (): string => `sec-${++uidSeq}`;

export function emptySection(): SectionForm {
  return {
    uid: nextUid(), name: "", question_count: "", marks_per_question: "", negative_marks_per_question: "0", minutes: "",
    sectional_timing: false, qualifying: false, cutoff_marks: "", calculator_allowed: false, subject_node_id: null, allowed_types: ["mcq"],
  };
}

export function emptyForm(): PatternForm {
  return {
    name: "", edition: "", total_minutes: "", qualifying: false, verified: false, source_note: "",
    max_questions: "100", owner_contact: "", sections: [emptySection()],
  };
}

export function formFromBlueprint(bp: ExamBlueprintFull): PatternForm {
  return {
    name: bp.name,
    edition: bp.edition,
    total_minutes: String(bp.total_minutes),
    qualifying: bp.qualifying,
    verified: bp.verification_status === "verified",
    source_note: bp.source_note ?? "",
    max_questions: String(bp.max_questions),
    owner_contact: bp.owner_contact ?? "",
    sections: bp.sections.map((s) => ({
      uid: nextUid(),
      name: s.name,
      question_count: String(s.question_count),
      marks_per_question: String(s.marks_per_question),
      negative_marks_per_question: String(s.negative_marks_per_question),
      minutes: s.minutes === null ? "" : String(s.minutes),
      sectional_timing: s.sectional_timing,
      qualifying: s.qualifying,
      cutoff_marks: s.cutoff_marks === null ? "" : String(s.cutoff_marks),
      calculator_allowed: s.calculator_allowed,
      subject_node_id: s.subject_node_id,
      allowed_types: s.allowed_types,
    })),
  };
}

/** Empty text is null. Text that is not a finite number is NaN. */
function toNum(text: string): number | null {
  const t = text.trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

function isInt(n: number | null, min: number, max: number): n is number {
  return n !== null && Number.isInteger(n) && n >= min && n <= max;
}

/**
 * Checks the form and builds the write body. Returns the messages (plain words) and the body when there are none.
 * Mirrors BlueprintBodySchema: ranges, negative marks <= marks, cut-off needs qualifying and fits the section marks,
 * own timer needs minutes and is all or nothing, section minutes add up to the total when timed, sections <= cap.
 */
export function buildBlueprintBody(
  f: PatternForm,
  original: ExamBlueprintFull | null,
): { body: BlueprintWriteBody | null; errors: string[] } {
  const errors: string[] = [];
  const name = f.name.trim();
  const edition = f.edition.trim();
  if (name === "" || name.length > 120) errors.push("Type a pattern name of up to 120 characters.");
  if (edition === "" || edition.length > 40) errors.push("Type an edition label of up to 40 characters.");
  if (original !== null && original.verification_status === "verified" && edition === original.edition) {
    errors.push("A verified edition needs a new edition label to save a change.");
  }
  const total = toNum(f.total_minutes);
  const totalOk = isInt(total, 1, 600);
  if (!totalOk) errors.push("Total minutes must be a whole number from 1 to 600.");
  const cap = toNum(f.max_questions);
  if (!isInt(cap, 1, 500)) errors.push("The question cap must be a whole number from 1 to 500.");
  const source = f.source_note.trim();
  if (source.length > 2000) errors.push("The source note can be up to 2000 characters.");
  const owner = f.owner_contact.trim();
  if (owner.length > 200) errors.push("The owner contact can be up to 200 characters.");
  if (f.sections.length < 1) errors.push("Add at least one section.");
  if (f.sections.length > 10) errors.push("A pattern can have up to 10 sections.");

  const sections: Array<Omit<BlueprintSection, "position">> = [];
  f.sections.forEach((s, i) => {
    const label = `Section ${i + 1}`;
    const sectionName = s.name.trim();
    if (sectionName === "" || sectionName.length > 80) errors.push(`${label}: type a name of up to 80 characters.`);
    const count = toNum(s.question_count);
    if (!isInt(count, 1, 500)) errors.push(`${label}: questions must be a whole number from 1 to 500.`);
    const marks = toNum(s.marks_per_question);
    if (marks === null || marks < 0 || marks > 1000) errors.push(`${label}: marks per question must be from 0 to 1000.`);
    const negative = s.negative_marks_per_question.trim() === "" ? 0 : toNum(s.negative_marks_per_question);
    if (negative === null || negative < 0 || negative > 1000) errors.push(`${label}: negative marks must be from 0 to 1000.`);
    const minutes = s.minutes.trim() === "" ? null : toNum(s.minutes);
    if (minutes !== null && !isInt(minutes, 1, 300)) errors.push(`${label}: minutes must be a whole number from 1 to 300.`);
    const cutoff = s.cutoff_marks.trim() === "" ? null : toNum(s.cutoff_marks);
    if (cutoff !== null && (cutoff < 0 || cutoff > 1_000_000)) errors.push(`${label}: the cut-off mark must be from 0 to 1000000.`);
    if (marks !== null && negative !== null && negative > marks) errors.push(`${label}: negative marks cannot be more than the marks per question.`);
    if (cutoff !== null && !s.qualifying) errors.push(`${label}: a cut-off mark needs Qualifying section to be ticked.`);
    if (cutoff !== null && count !== null && marks !== null && cutoff > count * marks) {
      errors.push(`${label}: the cut-off mark cannot be more than the total marks of the section.`);
    }
    if (s.sectional_timing && minutes === null) errors.push(`${label}: an own timer needs minutes.`);
    sections.push({
      name: sectionName,
      subject_node_id: s.subject_node_id,
      question_count: count ?? 0,
      marks_per_question: marks ?? 0,
      negative_marks_per_question: negative ?? 0,
      minutes,
      sectional_timing: s.sectional_timing,
      qualifying: s.qualifying,
      cutoff_marks: cutoff,
      calculator_allowed: s.calculator_allowed,
      allowed_types: s.allowed_types,
    });
  });

  const timed = f.sections.filter((s) => s.sectional_timing).length;
  if (timed !== 0 && timed !== f.sections.length) errors.push("Own timer must be ticked for every section, or for none.");
  if (timed > 0 && totalOk) {
    const sum = sections.reduce((n, s) => n + (s.minutes ?? 0), 0);
    if (sum !== total) errors.push(`The section minutes add up to ${sum}. They must equal the total minutes, ${total}.`);
  }
  const questionSum = sections.reduce((n, s) => n + s.question_count, 0);
  if (isInt(cap, 1, 500) && questionSum > cap) errors.push(`The sections add up to ${questionSum} questions, above the cap of ${cap}.`);

  if (errors.length > 0 || !totalOk || !isInt(cap, 1, 500)) return { body: null, errors };
  const body: BlueprintWriteBody = {
    stage_node_id: original?.stage_node_id ?? null,
    edition,
    name,
    total_minutes: total,
    qualifying: f.qualifying,
    verification_status: f.verified ? "verified" : "unverified",
    source_note: source === "" ? null : source,
    max_questions: cap,
    owner_contact: owner === "" ? null : owner,
    sections,
  };
  return { body, errors: [] };
}

/** POST /api/admin/blueprints — create a pattern. The server validates the same body again. */
export async function createBlueprintApi(body: BlueprintWriteBody): Promise<ExamBlueprintFull> {
  return adminApi<ExamBlueprintFull>("/admin/blueprints", { method: "POST", body: JSON.stringify(body) });
}

function errorText(e: unknown, fallback: string): string {
  return e instanceof AdminApiError ? e.apiError.message : fallback;
}

export interface BlueprintEditorProps {
  /** null = a new pattern. */
  original: ExamBlueprintFull | null;
  onSaved: () => void;
  onCancel: () => void;
}

export function BlueprintEditor({ original, onSaved, onCancel }: BlueprintEditorProps): React.ReactElement {
  const [form, setForm] = useState<PatternForm>(() => (original === null ? emptyForm() : formFromBlueprint(original)));
  const [errors, setErrors] = useState<string[]>([]);
  const [serverError, setServerError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const isNew = original === null;

  function setPattern<K extends keyof PatternForm>(key: K, value: PatternForm[K]): void {
    setForm((cur) => ({ ...cur, [key]: value }));
  }
  function setSection(index: number, patch: Partial<SectionForm>): void {
    setForm((cur) => ({ ...cur, sections: cur.sections.map((s, i) => (i === index ? { ...s, ...patch } : s)) }));
  }
  function addSection(): void {
    setForm((cur) => (cur.sections.length >= 10 ? cur : { ...cur, sections: [...cur.sections, emptySection()] }));
  }
  function removeSection(index: number): void {
    setForm((cur) => (cur.sections.length <= 1 ? cur : { ...cur, sections: cur.sections.filter((_, i) => i !== index) }));
  }
  function moveSection(index: number, by: -1 | 1): void {
    setForm((cur) => {
      const to = index + by;
      if (to < 0 || to >= cur.sections.length) return cur;
      const next = [...cur.sections];
      [next[index], next[to]] = [next[to]!, next[index]!];
      return { ...cur, sections: next };
    });
  }

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    const checked = buildBlueprintBody(form, original);
    if (checked.body === null) {
      setErrors(checked.errors);
      setServerError(null);
      return;
    }
    setErrors([]);
    setServerError(null);
    setBusy(true);
    try {
      if (original === null) await createBlueprintApi(checked.body);
      else await saveBlueprintEditionApi(original.id, checked.body);
      onSaved();
    } catch (err) {
      setServerError(errorText(err, isNew ? "The pattern could not be created." : "The change could not be saved."));
    } finally {
      setBusy(false);
    }
  }

  const sectionCount = form.sections.length;
  return (
    <form
      aria-label={isNew ? "New exam pattern" : `Edit ${original.name} ${original.edition}`}
      noValidate
      onSubmit={(e) => void submit(e)}
      style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-md)" }}
    >
      <div>
        <HelpTip helpId="admin.blueprints.editor.fields">
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-sm)" }}>
            <p style={{ ...sans, fontWeight: 600, margin: 0 }}>Pattern</p>
            <div style={rowStyle}>
              <label style={labelStyle}>Pattern name<input style={fieldStyle} value={form.name} maxLength={120} aria-required="true" onChange={(e) => setPattern("name", e.target.value)} /></label>
              <label style={labelStyle}>Edition label<input style={fieldStyle} value={form.edition} maxLength={40} aria-required="true" onChange={(e) => setPattern("edition", e.target.value)} /></label>
              <label style={labelStyle}>Total minutes<input style={fieldStyle} type="number" min={1} max={600} value={form.total_minutes} aria-required="true" onChange={(e) => setPattern("total_minutes", e.target.value)} /></label>
              <label style={labelStyle}>Question cap<input style={fieldStyle} type="number" min={1} max={500} value={form.max_questions} aria-required="true" onChange={(e) => setPattern("max_questions", e.target.value)} /></label>
            </div>
            <div style={rowStyle}>
              <label style={labelStyle}>Owner contact<input style={fieldStyle} value={form.owner_contact} maxLength={200} onChange={(e) => setPattern("owner_contact", e.target.value)} /></label>
              <label style={{ ...labelStyle, minWidth: 320 }}>Source note<input style={fieldStyle} value={form.source_note} maxLength={2000} onChange={(e) => setPattern("source_note", e.target.value)} /></label>
            </div>
            <label style={checkStyle}>
              <input type="checkbox" checked={form.qualifying} onChange={(e) => setPattern("qualifying", e.target.checked)} />
              Qualifying exam
            </label>
          </div>
        </HelpTip>
      </div>

      <div>
        <HelpTip helpId="admin.blueprints.editor.verified">
          <label style={checkStyle}>
            <input type="checkbox" checked={form.verified} onChange={(e) => setPattern("verified", e.target.checked)} />
            Verified against the official notice
          </label>
        </HelpTip>
        {!isNew && original.verification_status === "verified" && (
          <p style={muted}>This edition is verified. Type a new edition label to save a change. The old edition stays.</p>
        )}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-sm)" }}>
        <p style={{ ...sans, fontWeight: 600, margin: 0 }}>Sections ({sectionCount} of 10)</p>
        {form.sections.map((s, i) => (
          <fieldset key={s.uid} style={sectionBox}>
            <legend style={{ ...sans, fontWeight: 600, padding: "0 var(--aiq-space-xs)" }}>Section {i + 1}</legend>
            <HelpTip helpId="admin.blueprints.editor.section_fields">
              <div style={rowStyle}>
                <label style={labelStyle}>Section name<input style={fieldStyle} value={s.name} maxLength={80} aria-required="true" onChange={(e) => setSection(i, { name: e.target.value })} /></label>
                <label style={labelStyle}>Questions<input style={fieldStyle} type="number" min={1} max={500} value={s.question_count} aria-required="true" onChange={(e) => setSection(i, { question_count: e.target.value })} /></label>
                <label style={labelStyle}>Marks per question<input style={fieldStyle} type="number" min={0} max={1000} step="any" value={s.marks_per_question} aria-required="true" onChange={(e) => setSection(i, { marks_per_question: e.target.value })} /></label>
                <label style={labelStyle}>Negative marks<input style={fieldStyle} type="number" min={0} max={1000} step="any" value={s.negative_marks_per_question} onChange={(e) => setSection(i, { negative_marks_per_question: e.target.value })} /></label>
                <label style={labelStyle}>Minutes<input style={fieldStyle} type="number" min={1} max={300} value={s.minutes} onChange={(e) => setSection(i, { minutes: e.target.value })} /></label>
                <label style={labelStyle}>Cut-off mark<input style={fieldStyle} type="number" min={0} max={1000000} step="any" value={s.cutoff_marks} onChange={(e) => setSection(i, { cutoff_marks: e.target.value })} /></label>
              </div>
            </HelpTip>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--aiq-space-md)" }}>
              <label style={checkStyle}><input type="checkbox" checked={s.sectional_timing} onChange={(e) => setSection(i, { sectional_timing: e.target.checked })} />Own timer</label>
              <label style={checkStyle}><input type="checkbox" checked={s.qualifying} onChange={(e) => setSection(i, { qualifying: e.target.checked })} />Qualifying section</label>
              <label style={checkStyle}><input type="checkbox" checked={s.calculator_allowed} onChange={(e) => setSection(i, { calculator_allowed: e.target.checked })} />Calculator allowed</label>
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--aiq-space-sm)" }}>
              <button type="button" className="aiq-btn aiq-btn-ghost aiq-btn-sm" aria-label={`Move section ${i + 1} up`} disabled={i === 0} onClick={() => moveSection(i, -1)}>Move up</button>
              <button type="button" className="aiq-btn aiq-btn-ghost aiq-btn-sm" aria-label={`Move section ${i + 1} down`} disabled={i === sectionCount - 1} onClick={() => moveSection(i, 1)}>Move down</button>
              <button type="button" className="aiq-btn aiq-btn-ghost aiq-btn-sm" aria-label={`Remove section ${i + 1}`} disabled={sectionCount <= 1} onClick={() => removeSection(i)}>Remove</button>
            </div>
          </fieldset>
        ))}
        <div>
          <HelpTip helpId="admin.blueprints.editor.sections">
            <button type="button" className="aiq-btn aiq-btn-ghost aiq-btn-sm" disabled={sectionCount >= 10} onClick={addSection}>Add section</button>
          </HelpTip>
        </div>
      </div>

      {errors.length > 0 && (
        <div role="alert" style={{ ...sans, color: "var(--aiq-color-danger)" }}>
          <p style={{ margin: 0 }}>Check these fields before you save:</p>
          <ul style={{ margin: 0, paddingLeft: "var(--aiq-space-lg)" }}>
            {errors.map((m) => <li key={m}>{m}</li>)}
          </ul>
        </div>
      )}
      {serverError !== null && <p role="alert" style={{ ...sans, color: "var(--aiq-color-danger)" }}>{serverError}</p>}

      <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--aiq-space-sm)" }}>
        <button type="submit" className="aiq-btn aiq-btn-primary aiq-btn-sm" disabled={busy}>
          {busy ? "Saving…" : isNew ? "Save pattern" : "Save changes"}
        </button>
        <button type="button" className="aiq-btn aiq-btn-ghost aiq-btn-sm" disabled={busy} onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}
