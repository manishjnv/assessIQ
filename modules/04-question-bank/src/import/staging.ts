// RW-58: stage an upload (validate every row through the question-type registry),
// fix single rows, discard. Nothing here calls AI. All writes run in withTenant + RLS.
import type { PoolClient } from "pg";
import { ConflictError, NotFoundError, ValidationError, sha256Hex } from "@assessiq/core";
import { withTenant } from "@assessiq/tenancy";
import { auditInTx } from "@assessiq/audit-log";
import { getQuestionType, isQuestionType } from "@assessiq/question-types";
import type {
  DryRunReport, DryRunRow, DupClass, ImportDecision, ImportFileMeta, ImportFormat, ImportStatus, NormalizedRow, ParsedRow,
  ParseResult, RowError,
} from "./types.js";
import { loadTaxonomyIndex, normalisedTextHash, normaliseText, parseV2, type TaxonomyIndex } from "./v2.js";

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

/** EXP-4: validateRow plus the v2 columns. rights_status is required for csv/xlsx; gift/aiken/qti cannot carry it. */
export function validateRowV2(
  row: number,
  cells: Record<string, string>,
  ctx: { format: ImportFormat; taxonomy: TaxonomyIndex },
): { normalized: NormalizedRow | null; errors: RowError[] } {
  const v = validateRow(row, cells);
  const v2 = parseV2(row, cells, { requireRights: ctx.format === "csv" || ctx.format === "xlsx", taxonomy: ctx.taxonomy });
  const errors = [...v.errors, ...v2.errors];
  if (errors.length > 0 || v.normalized === null) return { normalized: null, errors };
  return {
    normalized: { ...v.normalized, meta: { ...v2.meta, normalisedHash: normalisedTextHash(v.normalized.content) } },
    errors,
  };
}

export interface DecideRow {
  normalized: NormalizedRow | null; hash: string | null; errors: RowError[]; skipped: boolean;
  /** Trigram hit against an existing question (computed by the caller when pg_trgm exists). */
  similar?: boolean;
}

const normHashOf = (n: NormalizedRow): string => n.meta?.normalisedHash ?? normalisedTextHash(n.content);

/**
 * Decisions in row order: errors stay error, skip stays skip. A repeat of a content hash is an
 * 'exact' duplicate, a repeat of a normalised-text hash a 'normalised' duplicate (both excluded).
 * A trigram hit stays 'ok' and is only flagged 'similar'.
 */
export function decide(
  rows: DecideRow[],
  existingHashes: ReadonlySet<string>,
  existingNorm: ReadonlySet<string> = new Set(),
): { decision: ImportDecision; dup: DupClass | null }[] {
  const seen = new Set<string>();
  const seenNorm = new Set<string>();
  return rows.map((r) => {
    if (r.errors.length > 0 || r.normalized === null) return { decision: "error", dup: null };
    if (r.skipped) return { decision: "skip", dup: null };
    if (r.hash !== null && (existingHashes.has(r.hash) || seen.has(r.hash))) return { decision: "duplicate", dup: "exact" };
    const nh = normHashOf(r.normalized);
    if (existingNorm.has(nh) || seenNorm.has(nh)) return { decision: "duplicate", dup: "normalised" };
    if (r.hash !== null) seen.add(r.hash);
    seenNorm.add(nh);
    return { decision: "ok", dup: r.similar === true ? "similar" : null };
  });
}

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

interface ImportRow { id: string; domain: string; status: ImportStatus; format: ImportFormat }

async function loadImport(client: PoolClient, importId: string, lock = false): Promise<ImportRow> {
  const r = await client.query<ImportRow>(
    `SELECT id, domain, status, format FROM question_imports WHERE id = $1${lock ? " FOR UPDATE" : ""}`,
    [importId],
  );
  const row = r.rows[0];
  if (row === undefined) throw new NotFoundError("question import not found", { details: { code: "IMPORT_NOT_FOUND" } });
  return row;
}

/**
 * Hashes of the non-archived questions the new rows are compared against: the domain's questions
 * (hashed here from their content, so old rows without stored hashes are caught) plus every
 * stored question_source hash of the tenant (RLS-scoped, covers other domains).
 */
async function existingHashes(client: PoolClient, domain: string): Promise<{ exact: Set<string>; norm: Set<string> }> {
  // ponytail: hashes computed in JS over the domain's questions; fine to ~50k questions, then rely on stored hashes only.
  const r = await client.query<{ type: string; content: unknown }>(
    `SELECT q.type, q.content FROM questions q JOIN question_packs p ON p.id = q.pack_id
      WHERE p.domain = $1 AND q.status <> 'archived'`,
    [domain],
  );
  const exact = new Set(r.rows.map((q) => contentHash(q.type, q.content)));
  const norm = new Set(r.rows.map((q) => normalisedTextHash(q.content)));
  const s = await client.query<{ content_hash: string | null; normalised_text_hash: string | null }>(
    `SELECT s.content_hash, s.normalised_text_hash FROM question_source s JOIN questions q ON q.id = s.question_id
      WHERE q.status <> 'archived' AND (s.content_hash IS NOT NULL OR s.normalised_text_hash IS NOT NULL)`,
  );
  for (const x of s.rows) {
    if (x.content_hash) exact.add(x.content_hash);
    if (x.normalised_text_hash) norm.add(x.normalised_text_hash);
  }
  return { exact, norm };
}

/** The trigram class runs only when pg_trgm is installed. No migration creates it (EXP-4 rule). */
export async function trigramAvailable(client: PoolClient): Promise<boolean> {
  const r = await client.query(`SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm'`);
  return (r.rowCount ?? 0) > 0;
}

const SIMILAR_MIN = 0.8;

/** Rows (by row number) whose question text is trigram-similar to an existing question of the domain. */
export async function similarRowNumbers(
  client: PoolClient, domain: string, rows: { row: number; stem: string }[],
): Promise<Set<number>> {
  if (rows.length === 0 || !(await trigramAvailable(client))) return new Set();
  // ponytail: no trigram index, so this scans the domain once per row; add a GIN gin_trgm_ops index if imports get slow.
  const r = await client.query<{ n: number }>(
    `SELECT t.n FROM unnest($2::int[], $3::text[]) AS t(n, txt)
      WHERE EXISTS (
        SELECT 1 FROM questions q JOIN question_packs p ON p.id = q.pack_id
         WHERE p.domain = $1 AND q.status <> 'archived' AND jsonb_typeof(q.content->'question') = 'string'
           AND similarity(lower(q.content->>'question'), t.txt) >= $4)`,
    [domain, rows.map((x) => x.row), rows.map((x) => x.stem), SIMILAR_MIN],
  );
  return new Set(r.rows.map((x) => x.n));
}

const stemOf = (n: NormalizedRow | null): string | null => {
  const q = n?.content["question"];
  return typeof q === "string" && q.trim() !== "" ? normaliseText(q) : null;
};

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
    row: x.row_number, decision: x.decision, dupClass: x.normalized?.meta?.dupClass ?? null,
    errors: x.errors, raw: x.raw, normalized: x.normalized,
  }));
  const dc = (c: DupClass): number => rows.filter((x) => x.dupClass === c).length;
  const checksRun: DupClass[] = ["exact", "normalised"];
  if (await trigramAvailable(client)) checksRun.push("similar");
  const n = (d: ImportDecision): number => rows.filter((x) => x.decision === d).length;
  return {
    importId, status: imp.status,
    counts: { total: rows.length, ok: n("ok"), error: n("error"), duplicate: n("duplicate"), skip: n("skip") },
    duplicateClasses: { exact: dc("exact"), normalised: dc("normalised"), similar: dc("similar") },
    checksRun,
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

    const taxonomy = await loadTaxonomyIndex(client);
    const checked = parsed.rows.map((p: ParsedRow) => {
      const v = validateRowV2(p.row, p.cells, { format: meta.format, taxonomy });
      return {
        row: p.row, raw: p.cells, normalized: v.normalized, errors: v.errors,
        hash: v.normalized ? contentHash(v.normalized.type, v.normalized.content) : null, skipped: false, similar: false,
      };
    });
    for (const e of parsed.errors) {
      checked.push({ row: e.row, raw: {}, normalized: null, errors: [e], hash: null, skipped: false, similar: false });
    }
    checked.sort((a, b) => a.row - b.row);
    const stems = checked.flatMap((c) => { const stem = stemOf(c.normalized); return stem === null ? [] : [{ row: c.row, stem }]; });
    const similarRows = await similarRowNumbers(client, domain, stems);
    for (const c of checked) c.similar = similarRows.has(c.row);
    const existing = await existingHashes(client, domain);
    const verdicts = decide(checked, existing.exact, existing.norm);
    const decisions = verdicts.map((v) => v.decision);
    checked.forEach((c, i) => { if (c.normalized?.meta) c.normalized.meta.dupClass = verdicts[i]!.dup; });

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

    const taxonomy = await loadTaxonomyIndex(client);
    const items = all.rows.map((x) => {
      if (x.row_number !== rowNumber) {
        // Untouched rows keep their stored trigram flag; only the edited row is re-checked below.
        return {
          rec: x, normalized: x.normalized, hash: x.content_hash, errors: x.errors, skipped: x.decision === "skip",
          similar: x.normalized?.meta?.dupClass === "similar",
        };
      }
      const raw = { ...x.raw, ...(patch.values ?? {}) };
      const v = validateRowV2(x.row_number, raw, { format: imp.format, taxonomy });
      return {
        rec: { ...x, raw }, normalized: v.normalized, errors: v.errors,
        hash: v.normalized ? contentHash(v.normalized.type, v.normalized.content) : null,
        skipped: patch.skip ?? x.decision === "skip", similar: false,
      };
    });
    const edited = items.find((it) => it.rec.row_number === rowNumber)!;
    const stem = stemOf(edited.normalized);
    if (stem !== null) edited.similar = (await similarRowNumbers(client, imp.domain, [{ row: rowNumber, stem }])).has(rowNumber);
    const existing = await existingHashes(client, imp.domain);
    const verdicts = decide(items, existing.exact, existing.norm);
    for (let i = 0; i < items.length; i++) {
      const it = items[i]!;
      const dup = verdicts[i]!.dup;
      const before = it.rec.normalized?.meta?.dupClass ?? null; // read first: normalized may be the same object
      if (it.normalized?.meta) it.normalized.meta.dupClass = dup;
      if (verdicts[i]!.decision === it.rec.decision && before === dup && it.rec.row_number !== rowNumber) continue;
      await client.query(
        `UPDATE question_import_rows SET raw = $3::jsonb, normalized = $4::jsonb, content_hash = $5,
                errors = $6::jsonb, decision = $7 WHERE import_id = $1 AND row_number = $2`,
        [importId, it.rec.row_number, JSON.stringify(it.rec.raw), it.normalized ? JSON.stringify(it.normalized) : null,
          it.hash, JSON.stringify(it.errors), verdicts[i]!.decision],
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
