// AssessIQ - Organisation question upload (EXP-17). /admin/org-question-upload
// Flow: choose file + rights + warranty -> check (dry run, nothing saved) -> add questions (second click) -> result.
// Imported questions are private to the organisation and start In review. The list below can withdraw a whole upload.

import React, { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Chip, ConfirmDialog, Table } from "@assessiq/ui-system";
import type { ColumnDef } from "@assessiq/ui-system";
import { QUESTION_TYPES } from "@assessiq/question-types";
import { HelpTip } from "@assessiq/help-system/components";
import { AdminShell } from "../components/AdminShell.js";
import { AdminApiError, listDomainsApi } from "../api.js";
import type { DomainItem } from "../api.js";
import {
  IMPORT_MAX_BYTES, commitOrgImportApi, discardOrgImportApi, downloadOrgImportTemplate, isTierLocked,
  listOrgUploadsApi, uploadOrgImportApi, withdrawOrgUploadApi,
} from "../api/question-imports.js";
import type { ImportReport, ImportRow, OrgRightsStatus, OrgUploadItem, TemplateFormat } from "../api/question-imports.js";
import { importDecisionLabel, questionTypeLabel } from "../lib/labels.js";

/** The exact words the admin confirms. The server stores who confirmed and when. */
export const ORG_UPLOAD_WARRANTY_TEXT =
  "I confirm that I own this content or hold the right to use and upload it, and that it does not break anyone's copyright.";

const RIGHTS: { value: OrgRightsStatus; label: string }[] = [
  { value: "original", label: "Original (we wrote it)" },
  { value: "derived_from_source", label: "Based on another source (we may use it)" },
  { value: "licensed", label: "Licensed (we hold a licence)" },
];
const RIGHTS_LABEL: Record<string, string> = { original: "Original", derived_from_source: "Based on a source", licensed: "Licensed" };
const STATUS_LABEL: Record<string, string> = { staged: "Not saved", committed: "Added" };

const msg = (err: unknown, fallback: string): string => (err instanceof AdminApiError ? err.apiError.message : fallback);
const errorStyle: React.CSSProperties = { color: "var(--aiq-color-danger)", fontSize: "var(--aiq-text-sm)" };
const fieldStyle: React.CSSProperties = { display: "flex", flexDirection: "column", gap: "var(--aiq-space-xs)" };
const labelStyle: React.CSSProperties = { fontSize: "var(--aiq-text-sm)", fontWeight: 500 };
const h2Style: React.CSSProperties = { margin: "0 0 var(--aiq-space-md)", fontSize: "var(--aiq-text-xl)", fontWeight: 400 };

function fileFormat(name: string): "csv" | "xlsx" | null {
  const n = name.toLowerCase();
  if (n.endsWith(".csv")) return "csv";
  if (n.endsWith(".xlsx")) return "xlsx";
  return null;
}

export function OrgQuestionUpload(): React.ReactElement {
  const [locked, setLocked] = useState(false);
  const [uploads, setUploads] = useState<OrgUploadItem[]>([]);
  const [domains, setDomains] = useState<DomainItem[]>([]);
  const [tplType, setTplType] = useState<string>(QUESTION_TYPES[0]);
  const [tplFormat, setTplFormat] = useState<TemplateFormat>("csv");
  const [domain, setDomain] = useState("");
  const [packName, setPackName] = useState("");
  const [sourceRef, setSourceRef] = useState("");
  const [rights, setRights] = useState<OrgRightsStatus | "">("");
  const [warranty, setWarranty] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [report, setReport] = useState<ImportReport | null>(null);
  const [done, setDone] = useState<{ packId: string; committed: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [withdrawFor, setWithdrawFor] = useState<OrgUploadItem | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setUploads((await listOrgUploadsApi()).items);
    } catch (err) {
      if (isTierLocked(err)) setLocked(true);
      else setError(msg(err, "Could not load your uploads."));
    }
  }, []);

  useEffect(() => {
    void refresh();
    listDomainsApi().then((r) => setDomains(r.items)).catch(() => { /* non-critical: the list stays empty */ });
  }, [refresh]);

  async function run<T>(fn: () => Promise<T>, fallback: string): Promise<T | undefined> {
    setBusy(true);
    setError(null);
    try {
      return await fn();
    } catch (err) {
      if (isTierLocked(err)) setLocked(true);
      else setError(msg(err, fallback));
      return undefined;
    } finally {
      setBusy(false);
    }
  }

  async function onCheck(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setNotice(null);
    if (!file) { setError("Choose a CSV or XLSX file."); return; }
    const format = fileFormat(file.name);
    if (format === null) { setError("Only CSV and XLSX files are accepted."); return; }
    if (file.size > IMPORT_MAX_BYTES) { setError("This file is larger than 4 MB. Split it into smaller files."); return; }
    if (rights === "") { setError("Say how you hold the rights to this content."); return; }
    if (!warranty) { setError("Tick the rights confirmation to continue."); return; }
    const r = await run(() => uploadOrgImportApi({
      file_name: file.name, format, file, domain, rights_status: rights,
      ...(packName.trim() ? { pack_name: packName.trim() } : {}),
      ...(sourceRef.trim() ? { source_ref: sourceRef.trim() } : {}),
    }), "Could not read this file.");
    if (r) setReport(r);
  }

  async function onCommit(): Promise<void> {
    if (!report) return;
    const r = await run(() => commitOrgImportApi(report.importId), "Could not add the questions.");
    if (r) {
      setDone({ packId: r.packId, committed: r.committed });
      setReport(null);
      setFile(null);
      setWarranty(false);
      void refresh();
    }
  }

  async function onDiscard(): Promise<void> {
    if (!report) return;
    const r = await run(() => discardOrgImportApi(report.importId), "Could not discard this check.");
    if (r !== undefined) { setReport(null); setFile(null); void refresh(); }
  }

  async function onWithdraw(): Promise<void> {
    const target = withdrawFor;
    setWithdrawFor(null);
    if (!target) return;
    const r = await run(() => withdrawOrgUploadApi(target.id), "Could not withdraw this upload.");
    if (r) {
      setNotice(r.withdrawn === 0 ? "Nothing to withdraw. These questions were already withdrawn." : `${r.withdrawn} questions withdrawn.`);
      void refresh();
    }
  }

  const problemRows = (report?.rows ?? []).filter((r) => r.decision !== "ok");
  const rowColumns: ColumnDef<ImportRow>[] = [
    { key: "row", label: "Row", render: (r) => <span className="num">{r.row}</span> },
    { key: "decision", label: "Result", render: (r) => <Chip>{importDecisionLabel(r.decision)}</Chip> },
    {
      key: "errors", label: "Problem",
      render: (r) => r.errors.length === 0 ? null : (
        <ul style={{ margin: 0, paddingLeft: 18 }}>{r.errors.map((e, i) => <li key={i}>{e.column}: {e.message}</li>)}</ul>
      ),
    },
  ];
  const uploadColumns: ColumnDef<OrgUploadItem>[] = [
    { key: "file_name", label: "File", render: (u) => u.file_name },
    { key: "created_at", label: "Date", render: (u) => new Date(u.created_at).toLocaleDateString() },
    { key: "status", label: "State", render: (u) => <Chip>{STATUS_LABEL[u.status] ?? u.status}</Chip> },
    { key: "rights", label: "Rights", render: (u) => (u.rights_status ? RIGHTS_LABEL[u.rights_status] ?? u.rights_status : "") },
    {
      key: "questions", label: "Questions",
      render: (u) => <span className="num">{u.question_count}{u.withdrawn_count > 0 ? ` (${u.withdrawn_count} withdrawn)` : ""}</span>,
    },
    {
      key: "action", label: "", width: 220,
      render: (u) => u.status !== "committed" ? null : (
        <div style={{ display: "flex", gap: "var(--aiq-space-xs)", justifyContent: "flex-end" }}>
          {u.committed_pack_id && <Link to={`/admin/question-bank/${u.committed_pack_id}`}>Open set</Link>}
          <HelpTip helpId="admin.org_upload.withdraw">
            <button type="button" className="aiq-btn aiq-btn-ghost aiq-btn-sm" disabled={busy || u.question_count === u.withdrawn_count}
              aria-label={`Withdraw upload ${u.file_name}`} onClick={() => setWithdrawFor(u)}>Withdraw</button>
          </HelpTip>
        </div>
      ),
    },
  ];

  return (
    <AdminShell breadcrumbs={["Question bank", "Upload questions"]} helpPage="admin.org_upload">
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-xl)" }}>
        <div data-help-id="admin.org_upload.page">
          <h1 style={{ fontFamily: "var(--aiq-font-serif)", fontSize: "var(--aiq-h1-size)", fontWeight: 400, margin: 0, letterSpacing: "-0.02em" }}>
            Upload questions.
          </h1>
          <p style={{ fontSize: 14, color: "var(--aiq-color-fg-secondary)", margin: "8px 0 0", lineHeight: 1.5 }}>
            Add your own questions from a CSV or XLSX file. You see a check first. Nothing is saved until you add the questions.
            The questions stay private to your organisation and start In review.
          </p>
        </div>

        {error && <div role="alert" style={errorStyle}>{error}</div>}
        {notice && <div role="status">{notice}</div>}

        {locked ? (
          <section className="aiq-card" style={{ padding: "var(--aiq-space-lg)" }} aria-labelledby="ou-locked">
            <h2 id="ou-locked" style={h2Style}>Question upload is not in your plan.</h2>
            <p style={{ margin: 0 }}>
              Contact us to add it. Ask your AssessIQ administrator, at the email address in your onboarding documents.
            </p>
          </section>
        ) : done ? (
          <section className="aiq-card" style={{ padding: "var(--aiq-space-lg)" }} aria-labelledby="ou-done">
            <h2 id="ou-done" style={h2Style}>Done. {done.committed} questions added.</h2>
            <p style={{ margin: 0 }}>They are in a new draft question set and start In review. Check them before you invite candidates.</p>
            <p style={{ margin: "8px 0 var(--aiq-space-md)" }}><Link to={`/admin/question-bank/${done.packId}`}>Open the draft question set</Link></p>
            <button type="button" className="aiq-btn aiq-btn-outline" onClick={() => setDone(null)}>Upload another file</button>
          </section>
        ) : report === null ? (
          <>
            <section className="aiq-card" style={{ padding: "var(--aiq-space-lg)" }} aria-labelledby="ou-s1">
              <h2 id="ou-s1" style={h2Style}>1. Get a template.</h2>
              <div style={{ display: "flex", gap: "var(--aiq-space-md)", alignItems: "flex-end", flexWrap: "wrap" }}>
                <div style={fieldStyle}>
                  <label htmlFor="ou-type" style={labelStyle}>Question type</label>
                  <select id="ou-type" className="aiq-input" value={tplType} onChange={(e) => setTplType(e.target.value)}>
                    {QUESTION_TYPES.map((t) => <option key={t} value={t}>{questionTypeLabel(t)}</option>)}
                  </select>
                </div>
                <div style={fieldStyle}>
                  <label htmlFor="ou-tpl-format" style={labelStyle}>File format</label>
                  <select id="ou-tpl-format" className="aiq-input" value={tplFormat} onChange={(e) => setTplFormat(e.target.value as TemplateFormat)}>
                    <option value="csv">CSV</option>
                    <option value="xlsx">XLSX</option>
                  </select>
                </div>
                <button type="button" className="aiq-btn aiq-btn-outline" disabled={busy}
                  onClick={() => void run(() => downloadOrgImportTemplate(tplType, tplFormat), "Could not download the template.")}>
                  Download template
                </button>
              </div>
            </section>

            <section className="aiq-card" style={{ padding: "var(--aiq-space-lg)" }} aria-labelledby="ou-s2">
              <h2 id="ou-s2" style={h2Style}>2. Choose your file.</h2>
              <form onSubmit={(e) => void onCheck(e)} style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-md)", maxWidth: 520 }}>
                <div style={fieldStyle} data-help-id="admin.org_upload.file">
                  <label htmlFor="ou-file" style={labelStyle}>File, CSV or XLSX, up to 4 MB *</label>
                  <input id="ou-file" type="file" accept=".csv,.xlsx" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
                </div>
                <div style={fieldStyle} data-help-id="admin.org_upload.domain">
                  <label htmlFor="ou-domain" style={labelStyle}>Subject *</label>
                  <select id="ou-domain" className="aiq-input" value={domain} onChange={(e) => setDomain(e.target.value)} required>
                    <option value="">Select a subject</option>
                    {domains.map((d) => <option key={d.id} value={d.slug}>{d.name}</option>)}
                  </select>
                </div>
                <div style={fieldStyle}>
                  <label htmlFor="ou-name" style={labelStyle}>Question set name</label>
                  <input id="ou-name" className="aiq-input" type="text" placeholder="Optional. The file name is used if empty."
                    value={packName} onChange={(e) => setPackName(e.target.value)} maxLength={200} />
                </div>
                <div style={fieldStyle} data-help-id="admin.org_upload.source_ref">
                  <label htmlFor="ou-source" style={labelStyle}>Source reference</label>
                  <input id="ou-source" className="aiq-input" type="text" placeholder="Optional. A book, course or document name."
                    value={sourceRef} onChange={(e) => setSourceRef(e.target.value)} maxLength={500} />
                </div>
                <div style={fieldStyle} data-help-id="admin.org_upload.rights">
                  <label htmlFor="ou-rights" style={labelStyle}>Rights *</label>
                  <select id="ou-rights" className="aiq-input" value={rights} onChange={(e) => setRights(e.target.value as OrgRightsStatus | "")} required>
                    <option value="">Select how you hold the rights</option>
                    {RIGHTS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
                  </select>
                </div>
                <div data-help-id="admin.org_upload.warranty" style={{ display: "flex", gap: "var(--aiq-space-sm)", alignItems: "flex-start" }}>
                  <input id="ou-warranty" type="checkbox" checked={warranty} onChange={(e) => setWarranty(e.target.checked)} style={{ marginTop: 4 }} />
                  <label htmlFor="ou-warranty" style={{ fontSize: "var(--aiq-text-sm)" }}>{ORG_UPLOAD_WARRANTY_TEXT}</label>
                </div>
                <div>
                  <button type="submit" className="aiq-btn aiq-btn-primary" disabled={busy || !warranty}>{busy ? "Checking..." : "Check file"}</button>
                </div>
              </form>
            </section>
          </>
        ) : (
          <section data-help-id="admin.org_upload.preview" aria-labelledby="ou-s3" style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-md)" }}>
            <h2 id="ou-s3" style={{ ...h2Style, margin: 0 }}>3. Check the result. Nothing is saved yet.</h2>
            <div role="status" aria-live="polite" style={{ display: "flex", gap: "var(--aiq-space-xs)", flexWrap: "wrap" }}>
              <Chip>{report.counts.ok} valid</Chip>
              <Chip>{report.counts.error} with problems</Chip>
              <Chip>{report.counts.duplicate} duplicates</Chip>
              <Chip>{report.counts.skip} skipped</Chip>
            </div>
            {problemRows.length > 0 && (
              <div className="aiq-card" data-density="compact" style={{ padding: 0, overflow: "hidden" }}>
                <Table columns={rowColumns} data={problemRows} emptyMessage="No problems." />
              </div>
            )}
            {report.counts.error > 0 && <p style={{ margin: 0 }}>Rows with problems are left out. To include them, fix the file and upload it again.</p>}
            <div style={{ display: "flex", gap: "var(--aiq-space-sm)" }}>
              <HelpTip helpId="admin.org_upload.commit">
                <button type="button" className="aiq-btn aiq-btn-primary" disabled={busy || report.counts.ok === 0} onClick={() => void onCommit()}>
                  Add {report.counts.ok} questions
                </button>
              </HelpTip>
              <button type="button" className="aiq-btn aiq-btn-outline" disabled={busy} onClick={() => void onDiscard()}>Discard</button>
            </div>
          </section>
        )}

        {!locked && (
          <section aria-labelledby="ou-list">
            <h2 id="ou-list" style={h2Style}>Your uploads.</h2>
            <div className="aiq-card" data-density="compact" style={{ padding: 0, overflow: "hidden" }}>
              <Table columns={uploadColumns} data={uploads} emptyMessage="You have not uploaded any questions yet." />
            </div>
          </section>
        )}
      </div>

      <ConfirmDialog
        open={withdrawFor !== null}
        title="Withdraw this upload"
        body={`This archives every question from ${withdrawFor?.file_name ?? "this upload"} and marks it withdrawn. Candidates who already took a test keep their results.`}
        confirmLabel="Withdraw"
        danger
        busy={busy}
        onConfirm={() => void onWithdraw()}
        onCancel={() => setWithdrawFor(null)}
      />
    </AdminShell>
  );
}
