// RW-58: stage an upload (validate every row through the question-type registry),
// fix single rows, discard. Nothing here calls AI. All writes run in withTenant + RLS.
import type { PoolClient } from "pg";
import { ConflictError, NotFoundError, ValidationError, sha256Hex } from "@assessiq/core";
import { withTenant } from "@assessiq/tenancy";
import { auditInTx } from "@assessiq/audit-log";
import { getQuestionType, isQuestionType } from "@assessiq/question-types";
import type {
  DryRunReport, DryRunRow, ImportDecision, ImportFileMeta, ImportStatus, NormalizedRow, ParsedRow, ParseResult, RowError,
} from "./types.js";

// ---------------------------------------------------------------------------
// Row validation (pure)
// ---------------------------------------------------------------------------

/** Plain-text cell -> value: JSON for cells that start like a JSON array/object, else the text. */
function cellValue(text: string, numeric: boolean): unknown {
  if (text.startsWith("[") || text.startsWith("{")) {
    try { return JSON.parse(text); } catch { return text; }
  }
  return numeric && /^-?\d+(\.\d+)?$/.test(text) ? Number(text) : text;
}

function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  if (v !== null && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

export function contentHash(type: string, content: unknown): string {
  return sha256Hex(`${type}\n${stableJson(content)}`);
}

export function validateRow(row: number, cells: Record<string, string>): { normalized: NormalizedRow | null; errors: RowError[] } {
  const errors: RowError[] = [];
  const err = (column: string, message: string): void => { errors.push({ row, column, message }); };

  const type = (cells["type"] ?? "").toLowerCase();
  if (!isQuestionType(type)) {
    err("type", `unknown question type '${cells["type"] ?? ""}'`);
    return { normalized: null, errors };
  }
  const topic = cells["topic"] ?? "";
  if (topic === "" || topic.length > 200) err("topic", "topic is required (max 200 characters)");
  const intCell = (col: string, dflt: number, max: number): number => {
    const t = cells[col] ?? "";
    if (t === "") return dflt;
    const n = Number(t);
    if (!Number.isInteger(n) || n < 1 || n > max) { err(col, `${col} must be a whole number from 1 to ${max}`); return dflt; }
    return n;
  };
  const points = intCell("points", 1, 1000);
  const level = intCell("level", 1, 20);
  // EX-1: optional decimal column; blank = null (the assessment default applies at attempt start).
  let negative_marks: number | null = null;
  {
    const t = (cells["negative_marks"] ?? "").trim();
    if (t !== "") {
      const n = Number(t);
      if (!Number.isFinite(n) || n < 0 || n > 1000) err("negative_marks", "negative_marks must be a number from 0 to 1000");
      else negative_marks = Math.round(n * 100) / 100;
    }
  }

  const def = getQuestionType(type);
  for (const col of def.importColumns) {
    if (col.required && (cells[col.key] ?? "") === "") err(col.key, `${col.key} is required`);
  }
  let content: Record<string, unknown> | null = null;
  if (errors.length === 0) {
    // Registry validation. Second pass reads number-looking cells as numbers (mcq `correct`).
    let firstIssues: { path: (string | number)[]; message: string }[] = [];
    for (const numeric of [false, true]) {
      const raw: Record<string, unknown> = {};
      for (const col of def.importColumns) {
        const t = cells[col.key] ?? "";
        if (t !== "") raw[col.key] = cellValue(t, numeric);
      }
      const parsed = def.contentSchema.safeParse(def.coerceContent(raw));
      if (parsed.success) { content = parsed.data as Record<string, unknown>; break; }
      if (!numeric) firstIssues = parsed.error.issues;
    }
    if (content === null) {
      for (const i of firstIssues) err(String(i.path[0] ?? "content"), i.message);
    }
  }
  if (errors.length > 0 || content === null) return { normalized: null, errors };
  return { normalized: { type, topic, points, level, negative_marks, content }, errors };
}

/** Decisions in row order: errors stay error, skip stays skip, repeats of a hash are duplicates. */
export function decide(
  rows: { normalized: NormalizedRow | null; hash: string | null; errors: RowError[]; skipped: boolean }[],
  existingHashes: ReadonlySet<string>,
): ImportDecision[] {
  const seen = new Set<string>();
  return rows.map((r) => {
    if (r.errors.length > 0 || r.normalized === null) return "error";
    if (r.skipped) return "skip";
    if (r.hash !== null && (existingHashes.has(r.hash) || seen.has(r.hash))) return "duplicate";
    if (r.hash !== null) seen.add(r.hash);
    return "ok";
  });
}

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

interface ImportRow { id: string; domain: string; status: ImportStatus }

async function loadImport(client: PoolClient, importId: string, lock = false): Promise<ImportRow> {
  const r = await client.query<ImportRow>(
    `SELECT id, domain, status FROM question_imports WHERE id = $1${lock ? " FOR UPDATE" : ""}`,
    [importId],
  );
  const row = r.rows[0];
  if (row === undefined) throw new NotFoundError("question import not found", { details: { code: "IMPORT_NOT_FOUND" } });
  return row;
}

/** Hashes of the non-archived questions already in packs of this domain. */
async function existingHashes(client: PoolClient, domain: string): Promise<Set<string>> {
  // ponytail: hashes computed in JS over the domain's questions; add a stored hash column if domains grow past ~50k questions.
  const r = await client.query<{ type: string; content: unknown }>(
    `SELECT q.type, q.content FROM questions q JOIN question_packs p ON p.id = q.pack_id
      WHERE p.domain = $1 AND q.status <> 'archived'`,
    [domain],
  );
  return new Set(r.rows.map((q) => contentHash(q.type, q.content)));
}

interface RowRec {
  row_number: number; raw: Record<string, string>; normalized: NormalizedRow | null;
  content_hash: string | null; errors: RowError[]; decision: ImportDecision;
}

export async function buildReport(client: PoolClient, importId: string): Promise<DryRunReport> {
  const imp = await loadImport(client, importId);
  const r = await client.query<RowRec>(
    `SELECT row_number, raw, normalized, content_hash, errors, decision
       FROM question_import_rows WHERE import_id = $1 ORDER BY row_number`,
    [importId],
  );
  const rows: DryRunRow[] = r.rows.map((x) => ({
    row: x.row_number, decision: x.decision, errors: x.errors, raw: x.raw, normalized: x.normalized,
  }));
  const n = (d: ImportDecision): number => rows.filter((x) => x.decision === d).length;
  return {
    importId, status: imp.status,
    counts: { total: rows.length, ok: n("ok"), error: n("error"), duplicate: n("duplicate"), skip: n("skip") },
    rows,
  };
}

async function syncCounts(client: PoolClient, importId: string): Promise<void> {
  await client.query(
    `UPDATE question_imports SET updated_at = now(),
       row_count = (SELECT count(*) FROM question_import_rows WHERE import_id = $1),
       error_count = (SELECT count(*) FROM question_import_rows WHERE import_id = $1 AND decision = 'error')
     WHERE id = $1`,
    [importId],
  );
}

// ---------------------------------------------------------------------------
// stageImport
// ---------------------------------------------------------------------------

export async function stageImport(
  tenantId: string,
  actorUserId: string,
  meta: ImportFileMeta,
  parsed: ParseResult,
): Promise<DryRunReport> {
  return withTenant(tenantId, async (client) => {
    const domain = meta.domain.trim().toLowerCase();
    const dom = await client.query(`SELECT 1 FROM domains WHERE slug = $1 AND status = 'active'`, [domain]);
    if (dom.rowCount === 0) {
      throw new ValidationError(`domain '${domain}' does not exist`, { details: { code: "IMPORT_DOMAIN_NOT_FOUND" } });
    }
    // Same file already staged -> return it.
    const prior = await client.query<{ id: string }>(
      `SELECT id FROM question_imports WHERE file_sha256 = $1 AND status = 'staged'`,
      [meta.fileSha256],
    );
    if (prior.rows[0] !== undefined) return buildReport(client, prior.rows[0].id);

    const checked = parsed.rows.map((p: ParsedRow) => {
      const v = validateRow(p.row, p.cells);
      return {
        row: p.row, raw: p.cells, normalized: v.normalized, errors: v.errors,
        hash: v.normalized ? contentHash(v.normalized.type, v.normalized.content) : null, skipped: false,
      };
    });
    for (const e of parsed.errors) {
      checked.push({ row: e.row, raw: {}, normalized: null, errors: [e], hash: null, skipped: false });
    }
    checked.sort((a, b) => a.row - b.row);
    const decisions = decide(checked, await existingHashes(client, domain));

    const ins = await client.query<{ id: string }>(
      `INSERT INTO question_imports (tenant_id, created_by, file_name, file_sha256, format, domain, pack_name)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [tenantId, actorUserId, meta.fileName, meta.fileSha256, meta.format, domain, meta.packName],
    );
    const importId = ins.rows[0]!.id;
    if (checked.length > 0) {
      await client.query(
        `INSERT INTO question_import_rows (import_id, tenant_id, row_number, raw, normalized, content_hash, errors, decision)
         SELECT $1, $2, t.n, t.raw::jsonb, t.norm::jsonb, t.h, t.errs::jsonb, t.d
           FROM unnest($3::int[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[]) AS t(n, raw, norm, h, errs, d)`,
        [
          importId, tenantId,
          checked.map((c) => c.row),
          checked.map((c) => JSON.stringify(c.raw)),
          checked.map((c) => (c.normalized ? JSON.stringify(c.normalized) : null)),
          checked.map((c) => c.hash),
          checked.map((c) => JSON.stringify(c.errors)),
          decisions,
        ],
      );
    }
    await syncCounts(client, importId);
    await auditInTx(client, {
      tenantId, actorKind: "user", actorUserId, action: "question_import.staged",
      entityType: "question_import", entityId: importId,
      after: { file_name: meta.fileName, format: meta.format, domain, rows: checked.length },
    });
    return buildReport(client, importId);
  }).catch(async (err: unknown) => {
    // Concurrent identical upload lost the unique-index race: return the winner.
    if ((err as { code?: string }).code === "23505") {
      return withTenant(tenantId, async (client) => {
        const w = await client.query<{ id: string }>(
          `SELECT id FROM question_imports WHERE file_sha256 = $1 AND status = 'staged'`, [meta.fileSha256]);
        if (w.rows[0] === undefined) throw err;
        return buildReport(client, w.rows[0].id);
      });
    }
    throw err;
  });
}

export async function getImportReport(tenantId: string, importId: string): Promise<DryRunReport> {
  return withTenant(tenantId, (client) => buildReport(client, importId));
}

// ---------------------------------------------------------------------------
// fixRow: edit cell values and/or toggle skip, then re-decide the whole file
// ---------------------------------------------------------------------------

export async function fixImportRow(
  tenantId: string,
  actorUserId: string,
  importId: string,
  rowNumber: number,
  patch: { values?: Record<string, string> | undefined; skip?: boolean | undefined },
): Promise<DryRunReport> {
  void actorUserId;
  return withTenant(tenantId, async (client) => {
    const imp = await loadImport(client, importId, true);
    if (imp.status !== "staged") {
      throw new ConflictError("import is no longer staged", { details: { code: "IMPORT_NOT_STAGED" } });
    }
    const all = await client.query<RowRec>(
      `SELECT row_number, raw, normalized, content_hash, errors, decision
         FROM question_import_rows WHERE import_id = $1 ORDER BY row_number`,
      [importId],
    );
    const target = all.rows.find((x) => x.row_number === rowNumber);
    if (target === undefined) throw new NotFoundError("import row not found", { details: { code: "IMPORT_ROW_NOT_FOUND" } });

    const items = all.rows.map((x) => {
      if (x.row_number !== rowNumber) {
        return { rec: x, normalized: x.normalized, hash: x.content_hash, errors: x.errors, skipped: x.decision === "skip" };
      }
      const raw = { ...x.raw, ...(patch.values ?? {}) };
      const v = validateRow(x.row_number, raw);
      return {
        rec: { ...x, raw }, normalized: v.normalized, errors: v.errors,
        hash: v.normalized ? contentHash(v.normalized.type, v.normalized.content) : null,
        skipped: patch.skip ?? x.decision === "skip",
      };
    });
    const decisions = decide(items, await existingHashes(client, imp.domain));
    for (let i = 0; i < items.length; i++) {
      const it = items[i]!;
      if (decisions[i] === it.rec.decision && it.rec.row_number !== rowNumber) continue;
      await client.query(
        `UPDATE question_import_rows SET raw = $3::jsonb, normalized = $4::jsonb, content_hash = $5,
                errors = $6::jsonb, decision = $7 WHERE import_id = $1 AND row_number = $2`,
        [importId, it.rec.row_number, JSON.stringify(it.rec.raw), it.normalized ? JSON.stringify(it.normalized) : null,
          it.hash, JSON.stringify(it.errors), decisions[i]],
      );
    }
    await syncCounts(client, importId);
    return buildReport(client, importId);
  });
}

// ---------------------------------------------------------------------------
// discardImport
// ---------------------------------------------------------------------------

export async function discardImport(tenantId: string, actorUserId: string, importId: string): Promise<DryRunReport> {
  return withTenant(tenantId, async (client) => {
    const imp = await loadImport(client, importId, true);
    if (imp.status !== "staged") {
      throw new ConflictError("import is no longer staged", { details: { code: "IMPORT_NOT_STAGED" } });
    }
    await client.query(`UPDATE question_imports SET status = 'discarded', updated_at = now() WHERE id = $1`, [importId]);
    await auditInTx(client, {
      tenantId, actorKind: "user", actorUserId, action: "question_import.discarded",
      entityType: "question_import", entityId: importId,
    });
    return buildReport(client, importId);
  });
}
