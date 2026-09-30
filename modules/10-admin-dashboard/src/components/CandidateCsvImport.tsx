// AssessIQ — bulk candidate CSV import (assessment detail → Invitations).
//
// Flow: "Import from CSV" → file picker → client-side preview (first 10 rows +
// row count) → Confirm → POST /admin/users/import { csv, assessment_id } →
// result summary (+ skipped rows, downloadable as CSV) → onImported() refresh.
//
// The preview parser is display-only; the server re-parses and validates
// everything (limits, emails, dedupe) and is authoritative.

import React, { useRef, useState } from "react";
import { Chip, Spinner } from "@assessiq/ui-system";
import { HelpTip } from "@assessiq/help-system/components";
import { adminApi, AdminApiError } from "../api.js";

const MAX_BYTES = 512 * 1024;
const MAX_ROWS = 1000;

export interface ImportSkip {
  row: number;
  email: string;
  reason: string;
}

export interface ImportResult {
  created: number;
  existing: number;
  invited: number;
  skipped: ImportSkip[];
  warning?: string;
}

const SAMPLE_CSV = "name,email\nAsha Verma,asha.verma@example.com\nRohan Mehta,rohan.mehta@example.com\n";

// ponytail: minimal quote-aware splitter for the preview only — the server
// parser is the real one.
export function previewCsv(text: string): { rows: string[][]; total: number } {
  const t = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const out: string[][] = [];
  let row: string[] = [];
  let f = "";
  let q = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i]!;
    if (q) {
      if (c === '"') {
        if (t[i + 1] === '"') { f += '"'; i++; } else q = false;
      } else f += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(f); f = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && t[i + 1] === "\n") i++;
      row.push(f); out.push(row); row = []; f = "";
    } else f += c;
  }
  if (f !== "" || row.length > 0) { row.push(f); out.push(row); }
  const data = out.slice(1).filter((r) => r.some((c) => c.trim() !== ""));
  const header = (out[0] ?? []).map((h) => h.trim().toLowerCase());
  const ni = header.indexOf("name");
  const ei = header.indexOf("email");
  if (ni < 0 || ei < 0) return { rows: [], total: -1 };
  return { rows: data.slice(0, 10).map((r) => [(r[ni] ?? "").trim(), (r[ei] ?? "").trim()]), total: data.length };
}

function csvCell(v: string | number): string {
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function download(filename: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

const sans: React.CSSProperties = { fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-sm)" };

export function CandidateCsvImport({
  assessmentId,
  onImported,
}: {
  assessmentId: string;
  onImported: () => void | Promise<void>;
}): React.ReactElement {
  const fileRef = useRef<HTMLInputElement>(null);
  const [csv, setCsv] = useState<string | null>(null);
  const [fileName, setFileName] = useState("");
  const [preview, setPreview] = useState<{ rows: string[][]; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);

  function reset() {
    setCsv(null);
    setPreview(null);
    setFileName("");
    setError(null);
    if (fileRef.current) fileRef.current.value = "";
  }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setResult(null);
    setError(null);
    if (file.size > MAX_BYTES) {
      setError("That file is larger than 512 KB. Split it into smaller files.");
      return;
    }
    const text = await file.text();
    const p = previewCsv(text);
    if (p.total < 0) {
      setError('The first row must be a header with "name" and "email" columns.');
      return;
    }
    if (p.total === 0) {
      setError("No data rows found below the header.");
      return;
    }
    if (p.total > MAX_ROWS) {
      setError(`This file has ${p.total} rows; the limit is ${MAX_ROWS}.`);
      return;
    }
    setCsv(text);
    setFileName(file.name);
    setPreview(p);
  }

  async function confirm() {
    if (csv === null) return;
    setBusy(true);
    setError(null);
    try {
      const r = await adminApi<ImportResult>("/admin/users/import", {
        method: "POST",
        body: JSON.stringify({ csv, assessment_id: assessmentId }),
      });
      setResult(r);
      reset();
      await onImported();
    } catch (err) {
      setError(err instanceof AdminApiError ? err.apiError.message : "Import failed. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ marginBottom: "var(--aiq-space-md)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "var(--aiq-space-md)", flexWrap: "wrap" }}>
        <HelpTip helpId="admin.assessments.invite.import_csv">
          <button
            type="button"
            className="aiq-btn aiq-btn-outline aiq-btn-sm"
            data-help-id="admin.assessments.invite.import_csv"
            disabled={busy}
            onClick={() => fileRef.current?.click()}
          >
            Import from CSV
          </button>
        </HelpTip>
        <input
          ref={fileRef}
          type="file"
          accept=".csv,text/csv"
          hidden
          data-testid="csv-file-input"
          onChange={(e) => void onFile(e)}
        />
        <a
          href="#sample-csv"
          style={{ ...sans, color: "var(--aiq-color-accent)", textDecoration: "none" }}
          onClick={(e) => {
            e.preventDefault();
            download("candidates-sample.csv", SAMPLE_CSV);
          }}
        >
          Download sample CSV
        </a>
      </div>

      {error && (
        <div role="alert" style={{ ...sans, color: "var(--aiq-color-danger)", marginTop: "var(--aiq-space-sm)" }}>
          {error}
        </div>
      )}

      {preview && (
        <div
          style={{
            border: "1px solid var(--aiq-color-border)",
            borderRadius: "var(--aiq-radius-md)",
            padding: "var(--aiq-space-md)",
            marginTop: "var(--aiq-space-md)",
            background: "var(--aiq-color-bg-raised)",
          }}
        >
          <p style={{ ...sans, margin: "0 0 var(--aiq-space-sm)" }}>
            <strong>{fileName}</strong> — {preview.total} row{preview.total !== 1 ? "s" : ""}.
            {preview.total > preview.rows.length ? ` Showing the first ${preview.rows.length}.` : ""}
          </p>
          <table style={{ ...sans, borderCollapse: "collapse", width: "100%" }}>
            <thead>
              <tr>
                <th style={{ textAlign: "left", padding: "4px 8px" }}>Name</th>
                <th style={{ textAlign: "left", padding: "4px 8px" }}>Email</th>
              </tr>
            </thead>
            <tbody>
              {preview.rows.map((r, i) => (
                <tr key={i} style={{ borderTop: "1px solid var(--aiq-color-border)" }}>
                  <td style={{ padding: "4px 8px" }}>{r[0]}</td>
                  <td style={{ padding: "4px 8px" }}>{r[1]}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ display: "flex", gap: "var(--aiq-space-sm)", marginTop: "var(--aiq-space-md)", alignItems: "center" }}>
            <button type="button" className="aiq-btn aiq-btn-primary" disabled={busy} onClick={() => void confirm()}>
              {busy ? <><Spinner size="sm" aria-label="Importing" /> Importing…</> : `Import and invite ${preview.total}`}
            </button>
            <button type="button" className="aiq-btn aiq-btn-ghost" disabled={busy} onClick={reset}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {result && (
        <div
          data-help-id="admin.assessments.invite.import_result"
          style={{
            border: "1px solid var(--aiq-color-border)",
            borderRadius: "var(--aiq-radius-md)",
            padding: "var(--aiq-space-md)",
            marginTop: "var(--aiq-space-md)",
            background: "var(--aiq-color-bg-raised)",
          }}
        >
          <HelpTip helpId="admin.assessments.invite.import_result">
            <div style={{ display: "flex", gap: "var(--aiq-space-sm)", flexWrap: "wrap" }}>
              <Chip variant="success">{result.created} created</Chip>
              <Chip>{result.existing} existing</Chip>
              <Chip variant="accent">{result.invited} invited</Chip>
              <Chip variant={result.skipped.length > 0 ? "warn" : "default"}>{result.skipped.length} skipped</Chip>
            </div>
          </HelpTip>
          {result.warning && (
            <p role="status" style={{ ...sans, color: "var(--aiq-color-fg-secondary)", margin: "var(--aiq-space-sm) 0 0" }}>
              {result.warning}
            </p>
          )}
          {result.skipped.length > 0 && (
            <>
              <ul style={{ ...sans, margin: "var(--aiq-space-sm) 0", paddingLeft: 20, maxHeight: 200, overflowY: "auto" }}>
                {result.skipped.map((s, i) => (
                  <li key={i}>
                    Row {s.row}: {s.email || "(blank)"} — {s.reason}
                  </li>
                ))}
              </ul>
              <button
                type="button"
                className="aiq-btn aiq-btn-outline aiq-btn-sm"
                onClick={() =>
                  download(
                    "skipped-rows.csv",
                    "row,email,reason\n" +
                      result.skipped.map((s) => [s.row, s.email, s.reason].map(csvCell).join(",")).join("\n") +
                      "\n",
                  )
                }
              >
                Download skipped rows
              </button>
            </>
          )}
          <button
            type="button"
            className="aiq-btn aiq-btn-ghost aiq-btn-sm"
            style={{ marginLeft: "var(--aiq-space-sm)" }}
            onClick={() => setResult(null)}
          >
            Dismiss
          </button>
        </div>
      )}
    </div>
  );
}
