// AssessIQ — Super-admin question import (RW-58). /admin/question-import
// Flow: template download -> upload (dry run) -> fix or skip rows -> commit (skip errors) | discard.
// Nothing is saved to a question set until the admin commits; the commit makes a DRAFT set.

import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Chip, ConfirmDialog, Modal, Table } from "@assessiq/ui-system";
import type { ColumnDef } from "@assessiq/ui-system";
import { QUESTION_TYPES } from "@assessiq/question-types";
import { HelpTip } from "@assessiq/help-system/components";
import { AdminShell } from "../components/AdminShell.js";
import { AdminApiError, generateRubricApi, listDomainsApi, listQuestionsApi, saveRubricApi } from "../api.js";
import { RUBRIC_REQUIRED_IDS, type QuestionType } from "@assessiq/question-types";
import type { DomainItem, QuestionListItem } from "../api.js";
import {
  IMPORT_MAX_BYTES, commitImportApi, discardImportApi, downloadImportTemplate, fixImportRowApi, getImportApi, uploadImportApi,
} from "../api/question-imports.js";
import type { ImportFormat, ImportReport, ImportRow, TemplateFormat } from "../api/question-imports.js";
import { useAdminSession } from "../session.js";
import { importDecisionLabel, questionTypeLabel } from "../lib/labels.js";

const msg = (err: unknown, fallback: string): string => (err instanceof AdminApiError ? err.apiError.message : fallback);

const errorStyle: React.CSSProperties = { color: "var(--aiq-color-danger)", fontSize: "var(--aiq-text-sm)" };
const fieldStyle: React.CSSProperties = { display: "flex", flexDirection: "column", gap: "var(--aiq-space-xs)" };
const labelStyle: React.CSSProperties = { fontSize: "var(--aiq-text-sm)", fontWeight: 500 };
const h2Style: React.CSSProperties = { margin: "0 0 var(--aiq-space-md)", fontSize: "var(--aiq-text-xl)", fontWeight: 400 };

/** File extension -> import format. .txt is ambiguous, so the user picks GIFT or Aiken. */
function formatOfFile(name: string, text: "gift" | "aiken"): ImportFormat {
  const n = name.toLowerCase();
  if (n.endsWith(".xlsx")) return "xlsx";
  if (n.endsWith(".gift")) return "gift";
  if (n.endsWith(".aiken")) return "aiken";
  if (n.endsWith(".txt")) return text;
  if (n.endsWith(".xml") || n.endsWith(".zip")) return "qti";
  return "csv";
}

export function AdminQuestionImport(): React.ReactElement {
  const { session } = useAdminSession();
  const isSuper = session?.user.role === "super_admin";

  const [domains, setDomains] = useState<DomainItem[]>([]);
  const [tplType, setTplType] = useState<string>(QUESTION_TYPES[0]);
  const [tplFormat, setTplFormat] = useState<TemplateFormat>("csv");
  const [textFormat, setTextFormat] = useState<"gift" | "aiken">("gift");
  const [domain, setDomain] = useState("");
  const [packName, setPackName] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [report, setReport] = useState<ImportReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fixRow, setFixRow] = useState<ImportRow | null>(null);
  const [fixValues, setFixValues] = useState<Record<string, string>>({});
  const [confirm, setConfirm] = useState<"commit" | "discard" | null>(null);
  const [packId, setPackId] = useState<string | null>(null);
  const [needRubric, setNeedRubric] = useState<QuestionListItem[]>([]);
  const [rubricStatus, setRubricStatus] = useState<Record<string, string>>({});
  const [rubricBusy, setRubricBusy] = useState(false);
  const [rubricNote, setRubricNote] = useState<string | null>(null);

  useEffect(() => {
    if (!isSuper) return;
    listDomainsApi().then((r) => setDomains(r.items)).catch(() => { /* non-critical: the list stays empty */ });
  }, [isSuper]);

  async function run<T>(fn: () => Promise<T>, fallback: string): Promise<T | undefined> {
    setBusy(true);
    setError(null);
    try {
      return await fn();
    } catch (err) {
      setError(msg(err, fallback));
      return undefined;
    } finally {
      setBusy(false);
    }
  }

  async function onUpload(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!file) { setError("Choose a file to upload."); return; }
    if (file.size > IMPORT_MAX_BYTES) { setError("This file is larger than 4 MB. Split it into smaller files."); return; }
    const format = formatOfFile(file.name, textFormat);
    const r = await run(() => uploadImportApi({
      file_name: file.name, format, file, domain,
      ...(packName.trim() ? { pack_name: packName.trim() } : {}),
    }), "Could not read this file.");
    if (r) setReport(r);
  }

  async function onTemplate(): Promise<void> {
    await run(() => downloadImportTemplate(tplType, tplFormat), "Could not download the template.");
  }

  async function onSaveFix(): Promise<void> {
    if (!report || !fixRow) return;
    const r = await run(async () => {
      await fixImportRowApi(report.importId, fixRow.row, { values: fixValues });
      return getImportApi(report.importId);
    }, "Could not save this row.");
    if (r) { setReport(r); setFixRow(null); }
  }

  async function onSkip(row: ImportRow): Promise<void> {
    if (!report) return;
    const r = await run(async () => {
      await fixImportRowApi(report.importId, row.row, { skip: true });
      return getImportApi(report.importId);
    }, "Could not skip this row.");
    if (r) setReport(r);
  }

  // Sequential on purpose: the server runs one AI call at a time (same as the generate wizard).
  async function onDraftRubrics(): Promise<void> {
    setRubricBusy(true);
    setRubricNote(null);
    for (let i = 0; i < needRubric.length; i++) {
      const q = needRubric[i]!;
      if (rubricStatus[q.id] === "Done") continue;
      setRubricStatus((s) => ({ ...s, [q.id]: "Drafting…" }));
      try {
        const { proposal } = await generateRubricApi(q.id);
        await saveRubricApi(q.id, proposal);
        setRubricStatus((s) => ({ ...s, [q.id]: "Done" }));
      } catch (err) {
        if (err instanceof AdminApiError && err.apiError.code === "AIG_GRADING_IN_PROGRESS") {
          setRubricStatus((s) => { const n = { ...s }; delete n[q.id]; return n; });
          setRubricNote("The AI is busy. Try again in a moment.");
          break;
        }
        setRubricStatus((s) => ({ ...s, [q.id]: `Failed: ${msg(err, "Could not draft this rubric.")}` }));
      }
    }
    setRubricBusy(false);
  }

  async function onConfirm(): Promise<void> {
    if (!report || !confirm) return;
    const which = confirm;
    setConfirm(null);
    if (which === "commit") {
      const r = await run(() => commitImportApi(report.importId), "Could not add the questions.");
      if (r) {
        setPackId(r.packId);
        try {
          const list = await listQuestionsApi({ pack_id: r.packId, pageSize: 500 });
          setNeedRubric(list.items.filter((q) => RUBRIC_REQUIRED_IDS.includes(q.type as QuestionType)
            && (q.rubric === null || q.rubric === undefined || Object.keys(q.rubric).length === 0)));
        } catch { /* non-critical: the rubric step is hidden */ }
      }
    } else {
      const r = await run(() => discardImportApi(report.importId), "Could not discard this import.");
      if (r !== undefined) { setReport(null); setFile(null); }
    }
  }

  const columns: ColumnDef<ImportRow>[] = [
    { key: "row", label: "Row", render: (r) => <span className="num">{r.row}</span> },
    { key: "decision", label: "Result", render: (r) => <Chip>{importDecisionLabel(r.decision)}</Chip> },
    {
      key: "errors", label: "Details",
      render: (r) => r.errors.length === 0 ? null : (
        <details>
          <summary>{r.errors.length} {r.errors.length === 1 ? "problem" : "problems"}</summary>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {r.errors.map((e, i) => <li key={i}>{e.column}: {e.message}</li>)}
          </ul>
        </details>
      ),
    },
    {
      key: "action", label: "", width: 160,
      render: (r) => (r.decision === "error" || r.decision === "duplicate") ? (
        <div style={{ display: "flex", gap: "var(--aiq-space-xs)", justifyContent: "flex-end" }}>
          <button type="button" className="aiq-btn aiq-btn-ghost aiq-btn-sm" disabled={busy}
            onClick={() => { setFixRow(r); setFixValues({ ...r.raw }); }}>Fix</button>
          <button type="button" className="aiq-btn aiq-btn-ghost aiq-btn-sm" disabled={busy}
            onClick={() => void onSkip(r)}>Skip row</button>
        </div>
      ) : null,
    },
  ];

  if (!isSuper) {
    return (
      <AdminShell breadcrumbs={["Question bank", "Import questions"]} helpPage="admin.question_import">
        <p role="alert" style={errorStyle}>Only platform admins can import questions.</p>
      </AdminShell>
    );
  }

  return (
    <AdminShell breadcrumbs={["Question bank", "Import questions"]} helpPage="admin.question_import">
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-xl)" }}>
        <div>
          <h1 style={{ fontFamily: "var(--aiq-font-serif)", fontSize: "var(--aiq-text-3xl)", fontWeight: 400, margin: 0, letterSpacing: "-0.02em" }}>
            Import questions.
          </h1>
          <p style={{ fontSize: 14, color: "var(--aiq-color-fg-secondary)", margin: "8px 0 0", lineHeight: 1.5 }}>
            Upload a CSV or XLSX file. You see a report first. Nothing is saved until you add the questions.
          </p>
        </div>

        {error && <div role="alert" style={errorStyle}>{error}</div>}

        {packId ? (
          <div className="aiq-card" style={{ padding: "var(--aiq-space-lg)" }}>
            <p style={{ margin: 0 }}>The questions are in a new draft question set.</p>
            <p style={{ margin: "8px 0 0" }}><Link to={`/admin/question-bank/${packId}`}>Open the draft question set</Link></p>
            {needRubric.length > 0 && (
              <div style={{ marginTop: "var(--aiq-space-md)", display: "flex", flexDirection: "column", gap: "var(--aiq-space-sm)" }}>
                <p style={{ margin: 0 }}>{needRubric.length} imported {needRubric.length === 1 ? "question has" : "questions have"} no rubric.</p>
                <div>
                  <HelpTip helpId="admin.question_import.draft_rubrics">
                    <button type="button" className="aiq-btn aiq-btn-outline" disabled={rubricBusy} onClick={() => void onDraftRubrics()}>
                      {rubricBusy ? "Drafting…" : "Draft rubrics"}
                    </button>
                  </HelpTip>
                </div>
                {rubricNote && <div role="alert" style={errorStyle}>{rubricNote}</div>}
                <ul style={{ margin: 0, paddingLeft: 18 }}>
                  {needRubric.filter((q) => rubricStatus[q.id]).map((q) => (
                    <li key={q.id}>{q.topic ?? `Question ${needRubric.indexOf(q) + 1} of ${needRubric.length}`}: {rubricStatus[q.id]}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        ) : report === null ? (
          <>
            <section className="aiq-card" style={{ padding: "var(--aiq-space-lg)" }}>
              <h2 style={h2Style}>1. Get a template.</h2>
              <HelpTip helpId="admin.question_import.template">
                <div style={{ display: "flex", gap: "var(--aiq-space-md)", alignItems: "flex-end", flexWrap: "wrap" }}>
                  <div style={fieldStyle}>
                    <label htmlFor="qi-type" style={labelStyle}>Question type</label>
                    <select id="qi-type" className="aiq-input" value={tplType} onChange={(e) => setTplType(e.target.value)}>
                      {QUESTION_TYPES.map((t) => <option key={t} value={t}>{questionTypeLabel(t)}</option>)}
                    </select>
                  </div>
                  <div style={fieldStyle}>
                    <label htmlFor="qi-format" style={labelStyle}>File format</label>
                    <select id="qi-format" className="aiq-input" value={tplFormat} onChange={(e) => setTplFormat(e.target.value as TemplateFormat)}>
                      <option value="csv">CSV</option>
                      <option value="xlsx">XLSX</option>
                    </select>
                  </div>
                  <button type="button" className="aiq-btn aiq-btn-outline" disabled={busy} onClick={() => void onTemplate()}>
                    Download template
                  </button>
                </div>
              </HelpTip>
              <div data-help-id="admin.question_import.formats" style={{ marginTop: "var(--aiq-space-md)" }}>
                <div style={labelStyle}>Accepted formats</div>
                <ul style={{ margin: 0, paddingLeft: "var(--aiq-space-lg)" }}>
                  <li>CSV</li>
                  <li>XLSX</li>
                  <li>GIFT (multiple choice only)</li>
                  <li>Aiken (multiple choice only)</li>
                  <li>QTI 2.1, 2.2 or 3.0 package (.zip or one .xml item)</li>
                </ul>
              </div>
            </section>

            <section className="aiq-card" style={{ padding: "var(--aiq-space-lg)" }}>
              <h2 style={h2Style}>2. Upload your file.</h2>
              <form onSubmit={(e) => void onUpload(e)} data-help-id="admin.question_import.upload"
                style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-md)", maxWidth: 480 }}>
                <div style={fieldStyle}>
                  <label htmlFor="qi-domain" style={labelStyle}>Subject *</label>
                  <select id="qi-domain" className="aiq-input" value={domain} onChange={(e) => setDomain(e.target.value)} required>
                    <option value="">— Select a subject —</option>
                    {domains.map((d) => <option key={d.id} value={d.slug}>{d.name}</option>)}
                  </select>
                </div>
                <div style={fieldStyle}>
                  <label htmlFor="qi-name" style={labelStyle}>Question set name</label>
                  <input id="qi-name" className="aiq-input" type="text" placeholder="Optional. The file name is used if empty."
                    value={packName} onChange={(e) => setPackName(e.target.value)} />
                </div>
                <div style={fieldStyle}>
                  <label htmlFor="qi-file" style={labelStyle}>File (up to 4 MB) *</label>
                  <input id="qi-file" type="file" accept=".csv,.xlsx,.txt,.gift,.aiken,.xml,.zip" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
                </div>
                {file !== null && file.name.toLowerCase().endsWith(".txt") && (
                  <div style={fieldStyle} data-help-id="admin.question_import.text_format">
                    <label htmlFor="qi-text-format" style={labelStyle}>Text format</label>
                    <select id="qi-text-format" className="aiq-input" value={textFormat} onChange={(e) => setTextFormat(e.target.value as "gift" | "aiken")}>
                      <option value="gift">GIFT</option>
                      <option value="aiken">Aiken</option>
                    </select>
                  </div>
                )}
                <div>
                  <button type="submit" className="aiq-btn aiq-btn-primary" disabled={busy}>{busy ? "Checking…" : "Check file"}</button>
                </div>
              </form>
            </section>
          </>
        ) : (
          <section data-help-id="admin.question_import.report" style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-md)" }}>
            <h2 style={{ ...h2Style, margin: 0 }}>3. Check the report.</h2>
            <div style={{ display: "flex", gap: "var(--aiq-space-xs)", flexWrap: "wrap" }}>
              <Chip>{report.counts.total} rows</Chip>
              <Chip>{report.counts.ok} ready</Chip>
              <Chip>{report.counts.error} need a fix</Chip>
              <Chip>{report.counts.duplicate} duplicate</Chip>
              <Chip>{report.counts.skip} skipped</Chip>
            </div>
            <div className="aiq-card" data-density="compact" style={{ padding: 0, overflow: "hidden" }}>
              <Table columns={columns} data={report.rows} emptyMessage="This file has no rows." />
            </div>
            <div style={{ display: "flex", gap: "var(--aiq-space-sm)" }}>
              <HelpTip helpId="admin.question_import.commit">
                <button type="button" className="aiq-btn aiq-btn-primary" disabled={busy || report.counts.ok === 0}
                  onClick={() => setConfirm("commit")}>Commit (skip errors)</button>
              </HelpTip>
              <button type="button" className="aiq-btn aiq-btn-outline" disabled={busy} onClick={() => setConfirm("discard")}>Discard</button>
            </div>
          </section>
        )}
      </div>

      <Modal open={fixRow !== null} onClose={() => setFixRow(null)} title={`Fix row ${fixRow?.row ?? ""}`} width={560}>
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-sm)" }}>
          {Object.keys(fixValues).map((k) => (
            <div key={k} style={fieldStyle}>
              <label htmlFor={`qi-fix-${k}`} style={labelStyle}>{k}</label>
              <textarea id={`qi-fix-${k}`} className="aiq-input" rows={2} value={fixValues[k]}
                onChange={(e) => setFixValues((v) => ({ ...v, [k]: e.target.value }))} />
            </div>
          ))}
          <div style={{ display: "flex", gap: "var(--aiq-space-sm)", justifyContent: "flex-end" }}>
            <button type="button" className="aiq-btn aiq-btn-outline" onClick={() => setFixRow(null)}>Cancel</button>
            <button type="button" className="aiq-btn aiq-btn-primary" disabled={busy} onClick={() => void onSaveFix()}>Save row</button>
          </div>
        </div>
      </Modal>

      <ConfirmDialog
        open={confirm !== null}
        title={confirm === "commit" ? "Add these questions" : "Discard this import"}
        body={confirm === "commit"
          ? `This adds ${report?.counts.ok ?? 0} ready questions to a new draft question set. Rows with problems are left out.`
          : "This removes the report. Nothing is added to the question bank."}
        confirmLabel={confirm === "commit" ? "Add questions" : "Discard"}
        danger={confirm === "discard"}
        busy={busy}
        onConfirm={() => void onConfirm()}
        onCancel={() => setConfirm(null)}
      />
    </AdminShell>
  );
}
