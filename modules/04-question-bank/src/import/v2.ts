// EXP-4: import v2 columns (exam tags, rights, provenance), duplicate normalisation, taxonomy lookup.
// Pure except loadTaxonomyIndex. Nothing here calls AI.
import type { PoolClient } from "pg";
import { sha256Hex } from "@assessiq/core";
import { mapDifficulty } from "./difficulty.js";
import type { RowError, RowMeta } from "./types.js";

/** Template columns added by v2, in template order. */
export const V2_COLUMNS = [
  "exam_stage", "subject_path", "difficulty", "difficulty_scale", "rights_status", "origin",
  "source_ref", "source_url", "seed_ref", "language", "pyq_year", "pyq_shift",
  "passage_ref", "passage_text",
] as const;

/** 'withdrawn' is a takedown state set by the withdraw route; it is never importable. */
export const IMPORT_RIGHTS = ["original", "derived_from_source", "scraped_raw", "licensed", "metadata_only"] as const;
/** question_source.origin CHECK values minus 'tenant_upload' (EXP-17: set by the tenant upload route, never by a cell). */
export const IMPORT_ORIGINS = ["original_human", "ai_original", "ai_seeded", "derived_from_source", "scraped_raw", "licensed", "template_generated"] as const;
type Rights = (typeof IMPORT_RIGHTS)[number];

/** Default origin when the origin cell is blank. */
const DEFAULT_ORIGIN: Record<Rights, RowMeta["origin"]> = {
  original: "original_human", derived_from_source: "derived_from_source", scraped_raw: "scraped_raw",
  licensed: "licensed", metadata_only: "original_human",
};

// ---------------------------------------------------------------------------
// Normalised-text hash
// ---------------------------------------------------------------------------

function leaves(v: unknown, out: string[]): void {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) for (const x of v) leaves(x, out);
  else if (v !== null && typeof v === "object") {
    const o = v as Record<string, unknown>;
    for (const k of Object.keys(o).sort()) if (k !== "rationale") leaves(o[k], out);
  }
}

/** NFKC, lower-case, drop option labels ('A)', '(a)', '1.'), collapse whitespace. */
export function normaliseText(s: string): string {
  return s.normalize("NFKC").toLowerCase()
    .replace(/^\s*\(?(?:[a-z]|\d{1,2})[.)]\s+/, "")
    .replace(/\s+/g, " ").trim();
}

/** Text of a question as compared for duplicates: every string in content except the rationale. */
export function normalisedText(content: unknown): string {
  const out: string[] = [];
  leaves(content, out);
  return out.map(normaliseText).filter((s) => s !== "").join("\n");
}

export function normalisedTextHash(content: unknown): string {
  return sha256Hex(normalisedText(content));
}

// ---------------------------------------------------------------------------
// Taxonomy lookup (Exam structure + Subject map, platform-owned frameworks)
// ---------------------------------------------------------------------------

interface Node { id: string; parentId: string | null; kind: string; code: string; label: string; fw: string }
export interface TaxonomyIndex { nodes: Node[] }

export async function loadTaxonomyIndex(client: PoolClient): Promise<TaxonomyIndex> {
  const r = await client.query<{ id: string; parent_id: string | null; kind: string; code: string; label: string; fw: string }>(
    `SELECT n.id, n.parent_id, n.kind, n.code, n.label, f.slug AS fw
       FROM taxonomy_nodes n JOIN frameworks f ON f.id = n.framework_id
      WHERE f.tenant_id IS NULL AND f.slug IN ('exam-structure', 'subject-map') AND n.status = 'active'`,
  );
  return { nodes: r.rows.map((x) => ({ id: x.id, parentId: x.parent_id, kind: x.kind, code: x.code, label: x.label, fw: x.fw })) };
}

const same = (n: Node, name: string): boolean => {
  const k = name.trim().toLowerCase();
  return n.label.toLowerCase() === k || n.code.toLowerCase() === k;
};

// ---------------------------------------------------------------------------
// Row parsing
// ---------------------------------------------------------------------------

export function parseV2(
  row: number,
  cells: Record<string, string>,
  opts: { requireRights: boolean; taxonomy: TaxonomyIndex },
): { meta: Omit<RowMeta, "normalisedHash" | "dupClass">; errors: RowError[] } {
  const errors: RowError[] = [];
  const err = (column: string, message: string): void => { errors.push({ row, column, message }); };
  const c = (k: string): string => (cells[k] ?? "").trim();

  let rights: Rights = "original";
  const rt = c("rights_status").toLowerCase();
  if (rt === "") {
    if (opts.requireRights) err("rights_status", `rights_status is required (${IMPORT_RIGHTS.join(", ")})`);
  } else if ((IMPORT_RIGHTS as readonly string[]).includes(rt)) rights = rt as Rights;
  else err("rights_status", `rights_status '${c("rights_status")}' is not allowed (${IMPORT_RIGHTS.join(", ")})`);

  let origin = DEFAULT_ORIGIN[rights];
  const ot = c("origin").toLowerCase();
  if (ot !== "") {
    if ((IMPORT_ORIGINS as readonly string[]).includes(ot)) origin = ot as RowMeta["origin"];
    else err("origin", `origin '${c("origin")}' is not allowed (${IMPORT_ORIGINS.join(", ")})`);
    if (rights === "scraped_raw" && origin !== "scraped_raw") err("origin", "rights_status scraped_raw needs origin scraped_raw");
  }

  let difficultyEst: number | null = null;
  let sourceDifficultyRaw: string | null = null;
  if (c("difficulty") !== "") {
    sourceDifficultyRaw = c("difficulty");
    const m = mapDifficulty(c("difficulty"), c("difficulty_scale"));
    if ("error" in m) err("difficulty", m.error); else difficultyEst = m.value;
  } else if (c("difficulty_scale") !== "") err("difficulty_scale", "difficulty_scale needs a difficulty value");

  let language = "en";
  if (c("language") !== "") {
    language = c("language").toLowerCase();
    if (!/^[a-z]{2,3}(-[a-z0-9]{2,8})?$/.test(language)) err("language", "language must be a code such as en or hi");
  }
  let pyqYear: number | null = null;
  if (c("pyq_year") !== "") {
    const y = Number(c("pyq_year"));
    if (!Number.isInteger(y) || y < 1950 || y > 2100) err("pyq_year", "pyq_year must be a year from 1950 to 2100"); else pyqYear = y;
  }
  const url = c("source_url");
  if (url !== "" && !/^https?:\/\/\S+$/i.test(url)) err("source_url", "source_url must start with http:// or https://");
  for (const [k, max] of [["source_ref", 500], ["source_url", 2000], ["seed_ref", 200], ["pyq_shift", 100], ["passage_ref", 100], ["passage_text", 20000]] as const) {
    if (c(k).length > max) err(k, `${k} is too long (max ${max} characters)`);
  }

  // EXP-8: passage_text is only meaningful with a passage_ref (rows with the same ref share one passage).
  if (c("passage_text") !== "" && c("passage_ref") === "") err("passage_text", "passage_text needs a passage_ref");

  // Taxonomy: an unknown name is a row error, never a silent skip.
  const { nodes } = opts.taxonomy;
  let stageNodeId: string | null = null;
  let subjectNodeId: string | null = null;
  if (c("exam_stage") !== "") {
    const hit = nodes.find((n) => n.fw === "exam-structure" && n.kind === "stage" && same(n, c("exam_stage")));
    if (hit) stageNodeId = hit.id; else err("exam_stage", `exam_stage '${c("exam_stage")}' is not a stage in the Exam structure framework`);
  }
  if (c("subject_path") !== "") {
    const parts = c("subject_path").split("/").map((p) => p.trim());
    let parent: string | null = null;
    for (const [i, name] of parts.entries()) {
      const hit: Node | undefined = name === "" ? undefined
        : nodes.find((n) => n.fw === "subject-map" && n.parentId === parent && same(n, name));
      if (hit === undefined) {
        err("subject_path", `subject_path: '${name}' (part ${i + 1}) is not in the Subject map framework`);
        parent = null;
        break;
      }
      parent = hit.id;
    }
    if (parent !== null) subjectNodeId = parent;
  }

  return {
    meta: {
      origin, rightsStatus: rights, sourceRef: c("source_ref") || null, sourceUrl: url || null, seedRef: c("seed_ref") || null,
      sourceDifficultyRaw, difficultyEst, language, pyqYear, pyqShift: c("pyq_shift") || null, passageRef: c("passage_ref") || null, passageText: c("passage_text") || null, stageNodeId, subjectNodeId,
    },
    errors,
  };
}
