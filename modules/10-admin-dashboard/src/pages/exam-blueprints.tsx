// AssessIQ — Exam blueprints (EXP-6 tail, CT-1 editor). Super admin only.
//
// /admin/exam-blueprints
//
// Lists every exam blueprint with its sections: questions, marks, negative marks, minutes and the
// qualifying flag. "Start full mock" opens a small form (question set, level, opens at) and calls
// POST /api/admin/blueprints/:id/mock. The new draft id and its warnings, or the server error, show
// under the form. Nothing is sent to candidates.
//
// Fetches:
//   GET  /api/admin/blueprints                 -> { items: ExamBlueprintFull[] }
//   GET  /api/admin/packs (platform packs)     -> { packs }
//   GET  /api/admin/packs/:id                  -> { levels: { id, order }[] }
//   POST /api/admin/blueprints/:id/mock        -> 201 { assessment, warnings }
//
// CT-1 (pattern upkeep): each card shows the last and next check dates and an owner contact, with three actions:
//   "Mark checked" (POST /blueprints/:id/checked), "New edition" (PUT /blueprints/:id: a verified edition is never
//   edited, so the server adds a new edition row) and "Archive" (DELETE archives; old assessments keep working).
// INVARIANTS: no claude/anthropic copy; the monthly check is a person, never an AI call.

import React, { useEffect, useRef, useState } from "react";
import { Chip, Spinner } from "@assessiq/ui-system";
import { HelpTip } from "@assessiq/help-system/components";
import { AdminShell } from "../components/AdminShell.js";
import { AdminApiError, getPackLevelsApi, listPlatformPublishedPacks } from "../api.js";
import type { PlatformPackOption } from "../api.js";
import { archiveBlueprintApi, listExamBlueprintsFullApi, markBlueprintCheckedApi, saveBlueprintEditionApi, startFullMockApi } from "../api/exam-blueprints.js";
import type { BlueprintWriteBody, ExamBlueprintFull } from "../api/exam-blueprints.js";

const wrap: React.CSSProperties = { padding: "var(--aiq-space-lg) var(--aiq-space-xl)", display: "flex", flexDirection: "column", gap: "var(--aiq-space-lg)" };
const card: React.CSSProperties = { display: "flex", flexDirection: "column", gap: "var(--aiq-space-md)", padding: "var(--aiq-space-md)", border: "1px solid var(--aiq-color-border)", borderRadius: "var(--aiq-radius-md)" };
const sans: React.CSSProperties = { fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-sm)", color: "var(--aiq-color-fg-primary)" };
const muted: React.CSSProperties = { ...sans, color: "var(--aiq-color-fg-muted)", fontSize: "var(--aiq-text-xs)" };
const cell: React.CSSProperties = { ...sans, padding: "var(--aiq-space-xs) var(--aiq-space-sm)", borderBottom: "1px solid var(--aiq-color-border)", textAlign: "left" };
const fieldStyle: React.CSSProperties = {
  fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-sm)", padding: "var(--aiq-space-xs) var(--aiq-space-sm)",
  border: "1px solid var(--aiq-color-border)", borderRadius: "var(--aiq-radius-sm)",
  background: "var(--aiq-color-bg-base)", color: "var(--aiq-color-fg-primary)",
};
const labelStyle: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 2, fontSize: "var(--aiq-text-xs)", minWidth: 200 };

const HEADERS = ["Section", "Questions", "Marks per question", "Negative marks", "Minutes", "Qualifying"];

/** Local "YYYY-MM-DDTHH:mm" for a datetime-local input, five minutes from now. */
function defaultOpensAt(): string {
  const d = new Date(Math.ceil(Date.now() / 300000) * 300000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function errorText(e: unknown, fallback: string): string {
  return e instanceof AdminApiError ? e.apiError.message : fallback;
}

function MockForm({ blueprint }: { blueprint: ExamBlueprintFull }): React.ReactElement {
  const [packs, setPacks] = useState<PlatformPackOption[] | null>(null);
  const [packId, setPackId] = useState("");
  const [levels, setLevels] = useState<{ id: string; order: number }[]>([]);
  const [levelId, setLevelId] = useState("");
  const [opensAt, setOpensAt] = useState(defaultOpensAt);
  const [scope, setScope] = useState<"full" | "subjects">("full");
  const [picked, setPicked] = useState<number[]>([]);
  const [sizePct, setSizePct] = useState(100);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ id: string; warnings: string[] } | null>(null);
  const firstField = useRef<HTMLSelectElement>(null);

  useEffect(() => {
    firstField.current?.focus();
    listPlatformPublishedPacks().then((d) => setPacks(d.packs)).catch(() => setPacks([]));
  }, []);

  useEffect(() => {
    setLevelId("");
    setLevels([]);
    if (packId === "") return;
    let live = true;
    getPackLevelsApi(packId).then((d) => { if (live) setLevels(d.levels); }).catch(() => { if (live) setLevels([]); });
    return () => { live = false; };
  }, [packId]);

  const canStart = packId !== "" && levelId !== "" && opensAt !== "" && !busy && (scope === "full" || picked.length > 0);

  async function start(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const r = await startFullMockApi(blueprint.id, {
        pack_id: packId,
        level_id: levelId,
        opens_at: new Date(opensAt).toISOString(),
        ...(scope === "subjects" ? { section_positions: [...picked].sort((a, b) => a - b) } : {}),
        ...(sizePct < 100 ? { scale_percent: sizePct } : {}),
      });
      setResult({ id: r.assessment.id, warnings: r.warnings });
    } catch (err) {
      setError(errorText(err, "The mock could not be created."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={start} aria-label={`Start a full mock from ${blueprint.name}`} style={card}>
      <HelpTip helpId="admin.blueprints.mock_form">
        <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--aiq-space-sm)", alignItems: "flex-end" }}>
          <label style={labelStyle}>
            Question set
            <select ref={firstField} style={fieldStyle} value={packId} onChange={(e) => setPackId(e.target.value)} required>
              <option value="">Choose a question set</option>
              {(packs ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
          <label style={labelStyle}>
            Level
            <select style={fieldStyle} value={levelId} onChange={(e) => setLevelId(e.target.value)} disabled={levels.length === 0} required>
              <option value="">Choose a level</option>
              {levels.map((l) => <option key={l.id} value={l.id}>Level {l.order}</option>)}
            </select>
          </label>
          <label style={labelStyle}>
            Opens at
            <input type="datetime-local" style={fieldStyle} value={opensAt} onChange={(e) => setOpensAt(e.target.value)} required />
          </label>
        </div>
      </HelpTip>
      <HelpTip helpId="admin.blueprints.mock_scope">
        <fieldset style={{ ...labelStyle, border: "none", padding: 0, margin: 0 }}>
          <legend style={labelStyle}>What the mock covers</legend>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--aiq-space-sm)", alignItems: "center" }}>
            <label style={labelStyle}>
              Scope
              <select style={fieldStyle} value={scope} onChange={(e) => setScope(e.target.value as "full" | "subjects")}>
                <option value="full">Full test (all sections)</option>
                <option value="subjects">Chosen subjects only</option>
              </select>
            </label>
            <label style={labelStyle}>
              Size
              <select style={fieldStyle} value={sizePct} onChange={(e) => setSizePct(Number(e.target.value))}>
                {[100, 75, 50, 25].map((n) => <option key={n} value={n}>{n === 100 ? "Full size" : `${n}% of the questions`}</option>)}
              </select>
            </label>
          </div>
          {scope === "subjects" && (
            <div role="group" aria-label="Subjects" style={{ display: "flex", flexWrap: "wrap", gap: "var(--aiq-space-sm)" }}>
              {blueprint.sections.map((s, i) => (
                <label key={s.position} style={{ ...sans, display: "flex", gap: "var(--aiq-space-xs)", alignItems: "center" }}>
                  <input
                    type="checkbox"
                    checked={picked.includes(i)}
                    onChange={(e) => setPicked((cur) => (e.target.checked ? [...cur, i] : cur.filter((x) => x !== i)))}
                  />
                  {s.name}
                </label>
              ))}
            </div>
          )}
          {(scope === "subjects" || sizePct < 100) && (
            <p style={muted}>A shorter mock is a practice test: it has no cut-off. Marks per question stay the same.</p>
          )}
        </fieldset>
      </HelpTip>
      <div>
        <HelpTip helpId="admin.blueprints.start_mock">
          <button type="submit" className="aiq-btn aiq-btn-primary aiq-btn-sm" disabled={!canStart}>
            {busy ? "Creating…" : "Create draft mock"}
          </button>
        </HelpTip>
      </div>
      {error !== null && <p role="alert" style={sans}>{error}</p>}
      {result !== null && (
        <div role="status" style={sans}>
          <p>Draft mock created. Assessment ID: <code>{result.id}</code>. Nothing is sent to candidates yet.</p>
          {result.warnings.length > 0 && (
            <ul>{result.warnings.map((w) => <li key={w}>{w}</li>)}</ul>
          )}
        </div>
      )}
    </form>
  );
}

const todayIso = (): string => new Date().toISOString().slice(0, 10);

/** CT-1: upkeep dates and the three actions. `onChanged` reloads the list after a write. */
function UpkeepPanel({ bp, onChanged }: { bp: ExamBlueprintFull; onChanged: () => void }): React.ReactElement {
  const [mode, setMode] = useState<"none" | "check" | "edition">("none");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // new edition form
  const [edition, setEdition] = useState("");
  const [name, setName] = useState(bp.name);
  const [minutes, setMinutes] = useState(String(bp.total_minutes));
  const [contact, setContact] = useState(bp.owner_contact ?? "");
  const [source, setSource] = useState(bp.source_note ?? "");
  const [verified, setVerified] = useState(false);
  const [counts, setCounts] = useState(bp.sections.map((x) => String(x.question_count)));
  const overdue = bp.next_check_due <= todayIso();

  async function run(fn: () => Promise<unknown>, failure: string): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await fn();
      setMode("none");
      setNote("");
      onChanged();
    } catch (e) {
      setError(errorText(e, failure));
    } finally {
      setBusy(false);
    }
  }

  function saveEdition(e: React.FormEvent): void {
    e.preventDefault();
    const body: BlueprintWriteBody = {
      stage_node_id: bp.stage_node_id,
      edition: edition.trim(),
      name: name.trim(),
      total_minutes: Number(minutes),
      qualifying: bp.qualifying,
      verification_status: verified ? "verified" : "unverified",
      source_note: source.trim() === "" ? null : source.trim(),
      max_questions: bp.max_questions,
      owner_contact: contact.trim() === "" ? null : contact.trim(),
      sections: bp.sections.map(({ position: _p, ...sec }, i) => ({ ...sec, question_count: Number(counts[i]) })),
    };
    void run(() => saveBlueprintEditionApi(bp.id, body), "The new edition could not be saved.");
  }

  const when = bp.last_checked_at === null ? "never" : bp.last_checked_at.slice(0, 10);
  const valid = edition.trim() !== "" && edition.trim() !== bp.edition && name.trim() !== "" && Number(minutes) >= 1 && counts.every((c) => Number(c) >= 1);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-sm)" }}>
      <HelpTip helpId="admin.blueprints.upkeep">
        <p style={muted}>
          Last checked: {when}. Next check due: {bp.next_check_due}. Owner: {bp.owner_contact ?? "not set"}. Cap: {bp.max_questions} questions.{" "}
          {overdue && <Chip>Check due</Chip>}
        </p>
      </HelpTip>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--aiq-space-sm)" }}>
        <button type="button" className="aiq-btn aiq-btn-ghost aiq-btn-sm" aria-expanded={mode === "check"} onClick={() => setMode(mode === "check" ? "none" : "check")}>
          Mark checked
        </button>
        <HelpTip helpId="admin.blueprints.new_edition">
          <button type="button" className="aiq-btn aiq-btn-ghost aiq-btn-sm" aria-expanded={mode === "edition"} onClick={() => setMode(mode === "edition" ? "none" : "edition")}>
            New edition
          </button>
        </HelpTip>
        <HelpTip helpId="admin.blueprints.archive">
          <button
            type="button"
            className="aiq-btn aiq-btn-ghost aiq-btn-sm"
            disabled={busy}
            onClick={() => { if (window.confirm(`Archive ${bp.name} ${bp.edition}? Tests already made from it keep working.`)) void run(() => archiveBlueprintApi(bp.id), "The pattern could not be archived."); }}
          >
            Archive
          </button>
        </HelpTip>
      </div>
      {mode === "check" && (
        <form
          aria-label={`Mark ${bp.name} checked`}
          style={{ display: "flex", flexWrap: "wrap", gap: "var(--aiq-space-sm)", alignItems: "flex-end" }}
          onSubmit={(e) => { e.preventDefault(); void run(() => markBlueprintCheckedApi(bp.id, note.trim() === "" ? null : note.trim()), "The check could not be saved."); }}
        >
          <label style={labelStyle}>
            Note (optional)
            <input style={fieldStyle} value={note} maxLength={2000} onChange={(e) => setNote(e.target.value)} />
          </label>
          <button type="submit" className="aiq-btn aiq-btn-primary aiq-btn-sm" disabled={busy}>Save check</button>
        </form>
      )}
      {mode === "edition" && (
        <form aria-label={`New edition of ${bp.name}`} onSubmit={saveEdition} style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-sm)" }}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--aiq-space-sm)" }}>
            <label style={labelStyle}>New edition label<input style={fieldStyle} value={edition} maxLength={40} onChange={(e) => setEdition(e.target.value)} required /></label>
            <label style={labelStyle}>Name<input style={fieldStyle} value={name} maxLength={120} onChange={(e) => setName(e.target.value)} required /></label>
            <label style={labelStyle}>Total minutes<input style={fieldStyle} type="number" min={1} max={600} value={minutes} onChange={(e) => setMinutes(e.target.value)} required /></label>
            <label style={labelStyle}>Owner contact<input style={fieldStyle} value={contact} maxLength={200} onChange={(e) => setContact(e.target.value)} /></label>
            <label style={labelStyle}>Source note<input style={fieldStyle} value={source} maxLength={2000} onChange={(e) => setSource(e.target.value)} /></label>
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--aiq-space-sm)" }}>
            {bp.sections.map((sec, i) => (
              <label key={sec.position} style={labelStyle}>
                {sec.name}: questions
                <input
                  style={fieldStyle}
                  type="number"
                  min={1}
                  max={bp.max_questions}
                  value={counts[i]}
                  onChange={(e) => setCounts((cur) => cur.map((c, j) => (j === i ? e.target.value : c)))}
                  required
                />
              </label>
            ))}
          </div>
          <label style={{ ...sans, display: "flex", gap: "var(--aiq-space-xs)", alignItems: "center" }}>
            <input type="checkbox" checked={verified} onChange={(e) => setVerified(e.target.checked)} />
            I checked this against the official notice (mark it verified)
          </label>
          <p style={muted}>A verified edition is never changed. This adds a new edition and keeps the old one, so tests already made stay correct.</p>
          <div><button type="submit" className="aiq-btn aiq-btn-primary aiq-btn-sm" disabled={busy || !valid}>{busy ? "Saving…" : "Save new edition"}</button></div>
        </form>
      )}
      {error !== null && <p role="alert" style={sans}>{error}</p>}
    </div>
  );
}

function BlueprintCard({ bp, onChanged }: { bp: ExamBlueprintFull; onChanged: () => void }): React.ReactElement {
  const [open, setOpen] = useState(false);
  const headId = `bp-${bp.id}`;
  const formId = `mock-${bp.id}`;
  return (
    <section aria-labelledby={headId} style={card}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--aiq-space-sm)", alignItems: "center", justifyContent: "space-between" }}>
        <div>
          <h2 id={headId} style={{ ...sans, fontSize: "var(--aiq-text-lg)", fontWeight: 600, margin: 0 }}>{bp.name}</h2>
          <p style={muted}>Edition {bp.edition}. {bp.total_questions} questions, {bp.total_marks} marks, {bp.total_minutes} minutes.{bp.qualifying ? " Qualifying exam." : ""}</p>
        </div>
        <div style={{ display: "flex", gap: "var(--aiq-space-sm)", alignItems: "center" }}>
          <HelpTip helpId="admin.blueprints.verification">
            <Chip>{bp.verification_status === "verified" ? "Verified" : "Unverified"}</Chip>
          </HelpTip>
          <button
            type="button"
            className="aiq-btn aiq-btn-ghost aiq-btn-sm"
            aria-expanded={open}
            aria-controls={formId}
            onClick={() => setOpen((v) => !v)}
          >
            Start full mock
          </button>
        </div>
      </div>
      {bp.source_note !== null && <p style={muted}>{bp.source_note}</p>}
      <UpkeepPanel bp={bp} onChanged={onChanged} />
      <div style={{ overflowX: "auto" }}>
        <HelpTip helpId="admin.blueprints.sections">
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <caption style={{ ...muted, textAlign: "left", paddingBottom: "var(--aiq-space-xs)" }}>Sections of {bp.name}</caption>
            <thead>
              <tr>{HEADERS.map((h) => <th key={h} scope="col" style={{ ...cell, fontWeight: 600 }}>{h}</th>)}</tr>
            </thead>
            <tbody>
              {bp.sections.map((s) => (
                <tr key={s.position}>
                  <th scope="row" style={{ ...cell, fontWeight: 400 }}>{s.name}</th>
                  <td style={cell}>{s.question_count}</td>
                  <td style={cell}>{s.marks_per_question}</td>
                  <td style={cell}>{s.negative_marks_per_question}</td>
                  <td style={cell}>{s.minutes ?? "—"}</td>
                  <td style={cell}>
                    {s.qualifying ? `Yes${s.cutoff_marks !== null ? `, cut-off ${s.cutoff_marks}` : ""}` : "No"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </HelpTip>
      </div>
      {open && <div id={formId}><MockForm blueprint={bp} /></div>}
    </section>
  );
}

export function AdminExamBlueprints(): React.ReactElement {
  const [items, setItems] = useState<ExamBlueprintFull[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const reload = (): void => {
    listExamBlueprintsFullApi()
      .then((d) => setItems(d.items))
      .catch((e: unknown) => {
        setItems([]);
        setLoadError(errorText(e, "Could not load the exam blueprints."));
      });
  };
  useEffect(reload, []);
  const dueCount = (items ?? []).filter((b) => b.next_check_due <= todayIso()).length;

  return (
    <AdminShell breadcrumbs={["Exam blueprints"]} helpPage="admin.blueprints">
      <div style={wrap}>
        <HelpTip helpId="admin.blueprints.page">
          <h1 style={{ ...sans, fontSize: "var(--aiq-text-xl)", fontWeight: 600, margin: 0 }}>Exam blueprints</h1>
        </HelpTip>
        {dueCount > 0 && <p style={sans}>{dueCount} exam {dueCount === 1 ? "pattern is" : "patterns are"} due for the monthly check.</p>}
        {items === null && <Spinner />}
        {loadError !== null && <p role="alert" style={sans}>{loadError}</p>}
        {items !== null && items.length === 0 && loadError === null && <p style={sans}>No exam blueprints yet.</p>}
        {(items ?? []).map((bp) => <BlueprintCard key={bp.id} bp={bp} onChanged={reload} />)}
      </div>
    </AdminShell>
  );
}
