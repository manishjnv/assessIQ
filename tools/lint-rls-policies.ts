/**
 * tools/lint-rls-policies.ts
 *
 * RLS policy linter for AssessIQ.
 *
 * Scans all migrations/*.sql files (glob: **\/migrations\/*.sql) and enforces:
 *
 *   1. STANDARD VARIANT — every CREATE TABLE that contains a `tenant_id` column
 *      MUST be accompanied by BOTH `CREATE POLICY tenant_isolation` AND
 *      `CREATE POLICY tenant_isolation_insert` in the same file.
 *
 *   2. JOIN-BASED VARIANT — child tables without their own `tenant_id` column
 *      that derive tenancy through a parent FK (e.g. `levels.pack_id`,
 *      `questions.pack_id`, `question_versions.question_id`,
 *      `question_tags.question_id`). These are listed explicitly in
 *      JOIN_RLS_TABLES below. They MUST have both `tenant_isolation` and
 *      `tenant_isolation_insert` policies, AND those policies MUST contain
 *      an EXISTS sub-select that references `current_setting('app.current_tenant'`
 *      (so tenancy is genuinely enforced at the DB layer rather than the policy
 *      being a no-op `USING (true)`).
 *
 *   3. TENANTS SPECIAL CASE — the `tenants` table itself uses its own `id`
 *      column as the tenant discriminator; any `CREATE POLICY tenant_isolation`
 *      in that file is accepted regardless of which column it references.
 *      tenant_isolation_insert is not required for the tenants table itself.
 *
 * If a migration file ships a CREATE TABLE for a table that is neither a
 * tenant_id-bearing table NOR in the explicit JOIN_RLS_TABLES list, the linter
 * leaves it alone (e.g. junction tables that are intentionally global, or
 * helper tables added by Phase 2+ work — those need to be added to one of
 * the above categories before the linter starts protecting them).
 *
 * 2026-10-23 A2-5 (GATE-8): rules 1-3 are now checked PER TABLE across ALL
 * migrations in order (CREATE TABLE, ENABLE ROW LEVEL SECURITY, CREATE POLICY
 * ... FOR <verb|ALL>, DROP POLICY). Every tenant-bearing or JOIN-listed table
 * needs RLS enabled and a policy covering SELECT, INSERT, UPDATE and DELETE
 * (a policy with no FOR clause is FOR ALL), except the verbs listed with a
 * reason in NO_WRITE_VERB_ALLOWLIST. getPool().query() is also a pool hit.
 *
 * Usage:
 *   pnpm tsx tools/lint-rls-policies.ts            # scan repo
 *   pnpm tsx tools/lint-rls-policies.ts --self-test # CI self-validation
 */

import { type Dirent } from "node:fs";
import * as path from "node:path";
import * as fsp from "node:fs/promises";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
  ".turbo",
  "AssessIQ_UI_Template",
]);

/**
 * Tables that MUST have JOIN-based RLS even though they carry no `tenant_id`
 * column directly. Tenancy derives through a parent FK chain.
 *
 * Add a table to this list when:
 *   - it has a foreign key to a tenant-bearing parent (directly or transitively)
 *   - it should be subject to tenant isolation
 *   - and the migration uses `CREATE POLICY tenant_isolation ON <table>` with an
 *     EXISTS sub-select referencing current_setting('app.current_tenant', ...).
 *
 * The linter rejects a migration that creates any of these tables without both
 * policies present and at least one EXISTS clause referencing the GUC.
 */
const JOIN_RLS_TABLES: ReadonlySet<string> = new Set([
  // Phase 1 G1.A — modules/04-question-bank
  "levels",                // pack_id → question_packs.tenant_id
  "questions",             // pack_id → question_packs.tenant_id
  "question_versions",     // question_id → questions.pack_id → question_packs.tenant_id
  "question_tags",         // question_id → questions.pack_id → question_packs.tenant_id
  "question_taxonomy",     // question_id → questions.pack_id → question_packs.tenant_id (migration 0169)
  // Phase 1 G1.B — modules/05-assessment-lifecycle
  "assessment_invitations", // assessment_id → assessments.tenant_id
  // Phase 1 G1.C — modules/06-attempt-engine (forward-declared so the lint
  // gate is in place when those migrations land; until they exist this
  // entry is inert).
  "attempt_questions",
  "attempt_answers",
  "attempt_events",
  // Phase 3 G3.B — modules/13-notifications (migration 0058)
  // webhook_deliveries has no tenant_id column; tenancy flows via
  // endpoint_id → webhook_endpoints.tenant_id (one-hop EXISTS).
  "webhook_deliveries",
]);

// Standard tenant_id-direct tables added in Phase 3 G3.B:
//   email_log            — migration 0055; tenant_id column, standard two-policy RLS
//   in_app_notifications — migration 0056; tenant_id column, standard two-policy RLS
//   webhook_endpoints    — migration 0058; tenant_id column, standard two-policy RLS
// These appear in the standard branch of validateSqlContent (hasTenantIdColumn)
// and do NOT need to be listed in JOIN_RLS_TABLES.

/** Recursively collect files whose path matches the migration glob pattern. */
async function findMigrationFiles(dir: string): Promise<string[]> {
  const results: string[] = [];

  async function walk(current: string): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await fsp.readdir(current, { withFileTypes: true });
    } catch {
      return; // unreadable directory — skip silently
    }

    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name)) continue;

      const full = path.join(current, entry.name);

      if (entry.isDirectory()) {
        await walk(full);
      } else if (
        entry.isFile() &&
        entry.name.endsWith(".sql") &&
        path.basename(path.dirname(full)) === "migrations"
      ) {
        results.push(full);
      }
    }
  }

  await walk(dir);
  return results;
}

// ---------------------------------------------------------------------------
// Violation record
// ---------------------------------------------------------------------------

type Verb = "select" | "insert" | "update" | "delete";
const VERBS: readonly Verb[] = ["select", "insert", "update", "delete"];

interface Violation {
  file: string;
  tableName: string;
  missing: (
    | "rls_not_enabled"
    | "policy_select"
    | "policy_insert"
    | "policy_update"
    | "policy_delete"
    | "exists_clause_with_current_setting"
    | "stale_allowlist_entry"
  )[];
}

/**
 * A1 (GATE-8 A2-5): tables whose UPDATE and/or DELETE have no policy ON PURPOSE.
 * Without a policy RLS denies the verb for assessiq_app, which is what
 * append-only or never-deleted tables want. Each entry: table -> verbs left
 * uncovered + one-line reason. Built from running this lint on the repo and
 * grepping modules/*\/src and apps/api/src for the verb on that table. NEVER
 * add a table the app writes with that verb (the write would fail closed).
 */
const NO_WRITE_VERB_ALLOWLIST: Readonly<Record<string, { verbs: readonly Verb[]; reason: string }>> = {
  audit_log: { verbs: ["update", "delete"], reason: "append-only by design (14-audit-log invariant); the app never updates or deletes rows" },
  affected_attempt_reviews: { verbs: ["delete"], reason: "EXP-12 manual review marks are upserted (INSERT, UPDATE); the app never deletes them" },
  question_reports: { verbs: ["delete"], reason: "EXP-28 candidate reports are upserted (INSERT, UPDATE); the app never deletes them; they cascade with the attempt" },
  certificates: { verbs: ["delete"], reason: "certificates are revoked (UPDATE), never deleted; no DELETE in modules/18-certification" },
  email_log: { verbs: ["delete"], reason: "append-only send log; the only write besides INSERT is UPDATE (status, erasure)" },
  webhook_deliveries: { verbs: ["delete"], reason: "delivery history kept; the app only inserts and updates status" },
  tenant_plans: { verbs: ["update", "delete"], reason: "UPDATE runs only under withSystemRole (billing updateTenantPlan, two-role tx by A1 design); never deleted" },
  billing_events: { verbs: ["update", "delete"], reason: "append-only billing ledger; the app only inserts" },
  tenant_entitlements: { verbs: ["update", "delete"], reason: "revoke is UPDATE under withSystemRole (billing revokeEntitlement); never deleted" },
  consent_events: { verbs: ["update", "delete"], reason: "append-only consent log (20-data-rights); the app only inserts" },
  question_review_notes: { verbs: ["update", "delete"], reason: "insert-only review notes; the app never edits or deletes them" },
  credit_grants: { verbs: ["delete"], reason: "remaining is decremented by UPDATE; grants are never deleted" },
  credit_burns: { verbs: ["update", "delete"], reason: "append-only credit burn ledger; the app only inserts" },
  tenant_candidate_counted: { verbs: ["update", "delete"], reason: "insert-only marker (ON CONFLICT DO NOTHING); never updated or deleted" },
  tenant_legal_acceptances: { verbs: ["update", "delete"], reason: "append-only acceptance record; the app only inserts" },
  credit_lowbalance_notices: { verbs: ["update", "delete"], reason: "insert-only dedupe marker (ON CONFLICT DO NOTHING)" },
  credit_expiry_notices: { verbs: ["update", "delete"], reason: "insert-only dedupe marker (ON CONFLICT DO NOTHING)" },
  camera_files: { verbs: ["update"], reason: "rows are inserted and deleted (retention, erasure); never updated" },
  camera_reviewers: { verbs: ["update"], reason: "rows are inserted (ON CONFLICT DO NOTHING) and deleted; never updated" },
};

// ---------------------------------------------------------------------------
// Cross-migration analysis (per table, per verb, in migration order)
// ---------------------------------------------------------------------------

interface TableState {
  tenantBearing: boolean;
  /** EXP-14: the CREATE TABLE has a pack_id column (a child of the question store). */
  hasPackId?: boolean;
  rlsEnabled: boolean;
  file: string;
  /** policy name -> verb ("all" covers every verb) + body text */
  policies: Map<string, { verb: Verb | "all"; body: string }>;
}

const NAME = String.raw`(?:"?\w+"?\.)?"?(\w+)"?`;
const EVENT_RE = new RegExp(
  [
    String.raw`create\s+table(?:\s+if\s+not\s+exists)?\s+${NAME}\s*\(([\s\S]*?)\)\s*;`, // 1,2
    String.raw`alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?${NAME}\s+enable\s+row\s+level\s+security`, // 3
    String.raw`alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?${NAME}\s+add\s+column\s+(?:if\s+not\s+exists\s+)?tenant_id\b`, // 4
    String.raw`create\s+policy\s+"?(\w+)"?\s+on\s+${NAME}([^;]*);`, // 5,6,7
    String.raw`drop\s+policy\s+(?:if\s+exists\s+)?"?(\w+)"?\s+on\s+${NAME}`, // 8,9
    String.raw`drop\s+table\s+(?:if\s+exists\s+)?${NAME}`, // 10
  ].join("|"),
  "gi",
);

function stripSqlComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, "");
}

/** Feed migration files IN ORDER; returns the final per-table state. */
function analyseMigrations(files: ReadonlyArray<{ file: string; content: string }>): Map<string, TableState> {
  const tables = new Map<string, TableState>();
  for (const { file, content } of files) {
    const sql = stripSqlComments(content);
    EVENT_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = EVENT_RE.exec(sql)) !== null) {
      const get = (t: string): TableState => {
        let st = tables.get(t);
        if (!st) {
          st = { tenantBearing: false, rlsEnabled: false, file, policies: new Map() };
          tables.set(t, st);
        }
        return st;
      };
      if (m[1] !== undefined) {
        const st = get(m[1].toLowerCase());
        st.file = file;
        if (/\btenant_id\b/i.test(m[2]!)) st.tenantBearing = true;
        if (/\bpack_id\b/i.test(m[2]!)) st.hasPackId = true;
      } else if (m[3] !== undefined) {
        get(m[3].toLowerCase()).rlsEnabled = true;
      } else if (m[4] !== undefined) {
        get(m[4].toLowerCase()).tenantBearing = true;
      } else if (m[5] !== undefined) {
        const rest = m[7] ?? "";
        const v = /^\s*(?:as\s+\w+\s+)?for\s+(select|insert|update|delete|all)\b/i.exec(rest);
        get(m[6]!.toLowerCase()).policies.set(m[5].toLowerCase(), {
          verb: (v ? v[1]!.toLowerCase() : "all") as Verb | "all",
          body: rest,
        });
      } else if (m[8] !== undefined) {
        tables.get(m[9]!.toLowerCase())?.policies.delete(m[8].toLowerCase());
      } else if (m[10] !== undefined) {
        tables.delete(m[10].toLowerCase());
      }
    }
  }
  return tables;
}

function covers(st: TableState, verb: Verb): boolean {
  for (const p of st.policies.values()) if (p.verb === verb || p.verb === "all") return true;
  return false;
}

function checkTables(
  tables: Map<string, TableState>,
  allow: Readonly<Record<string, { verbs: readonly Verb[]; reason: string }>> = NO_WRITE_VERB_ALLOWLIST,
): Violation[] {
  const out: Violation[] = [];
  for (const [name, st] of tables) {
    const isJoin = JOIN_RLS_TABLES.has(name);
    if (name !== "tenants" && !st.tenantBearing && !isJoin) continue;
    const missing: Violation["missing"] = [];
    if (!st.rlsEnabled) missing.push("rls_not_enabled");
    // tenants: its own id is the discriminator; only a read policy is required.
    const need: readonly Verb[] = name === "tenants" ? ["select"] : VERBS;
    const skip = allow[name]?.verbs ?? [];
    for (const v of need) {
      if (!covers(st, v) && !skip.includes(v)) missing.push(`policy_${v}` as Violation["missing"][number]);
    }
    if (isJoin && st.policies.size > 0) {
      const ok = [...st.policies.values()].some((p) =>
        /exists\s*\([\s\S]*?current_setting\s*\(\s*'app\.current_tenant'/i.test(p.body),
      );
      if (!ok) missing.push("exists_clause_with_current_setting");
    }
    if (missing.length > 0) out.push({ file: st.file, tableName: name, missing });
  }
  return out;
}

// ---------------------------------------------------------------------------
// EXP-14 phase 2: licensed-read policy family. A licensed tenant may read platform question-store rows only
// through a `licensed_read` policy: FOR SELECT, behind the app.licensed_read switch, deciding WHO through one
// of the three helper functions. No write verb may ever carry the licensed rule.
// ---------------------------------------------------------------------------
const LICENSED_READ_TABLES: ReadonlySet<string> = new Set([
  "question_packs", "levels", "questions", "question_versions", "question_source",
  "question_tags", "question_taxonomy", "passages", "domains", "categories", "tags",
  "question_assets", // EXP-10 part 1 (0284): the 12th question-store table
]);
const LICENSED_FUNCTIONS = ["licensed_pack_ids", "readable_platform_packs", "licensed_platform_tenant"];
/** Tables with a pack_id column that are NOT part of the question store (each with its reason). */
const PACK_ID_NOT_QUESTION_STORE: Readonly<Record<string, string>> = {
  assessments: "tenant-owned assessment row; names the pack it was built from",
  assessment_frozen_pool: "tenant-owned frozen copy of the pool",
  generation_attempts: "tenant-owned log of super-admin generation runs; never read by a licensed tenant",
};

function checkLicensedRead(tables: Map<string, TableState>): string[] {
  const errors: string[] = [];
  for (const name of LICENSED_READ_TABLES) {
    const st = tables.get(name);
    const p = st?.policies.get("licensed_read");
    if (!st || !p) {
      errors.push(`${name}: missing licensed_read policy (EXP-14: every question-store table needs one)`);
      continue;
    }
    if (p.verb !== "select") errors.push(`${name}: licensed_read must be FOR SELECT (found ${p.verb})`);
    if (!/app\.licensed_read/i.test(p.body)) errors.push(`${name}: licensed_read must check the app.licensed_read switch`);
    if (!LICENSED_FUNCTIONS.some((f) => new RegExp(String.raw`\b${f}\s*\(`, "i").test(p.body))) {
      errors.push(`${name}: licensed_read must decide through ${LICENSED_FUNCTIONS.join(" / ")}`);
    }
  }
  // Module 05 adds the pinned-question policy on questions (assessment_frozen_pool is a module 05 table).
  const pinned = tables.get("questions")?.policies.get("licensed_read_pinned");
  if (pinned !== undefined) {
    if (pinned.verb !== "select") errors.push(`questions: licensed_read_pinned must be FOR SELECT (found ${pinned.verb})`);
    if (!/app\.licensed_read/i.test(pinned.body)) errors.push("questions: licensed_read_pinned must check the app.licensed_read switch");
  }
  for (const [name, st] of tables) {
    if (LICENSED_READ_TABLES.has(name)) continue;
    if (st.policies.has("licensed_read")) errors.push(`${name}: licensed_read is only for the question-store tables`);
    if (st.hasPackId === true && PACK_ID_NOT_QUESTION_STORE[name] === undefined) {
      errors.push(`${name}: new table with a pack_id column: add a licensed_read policy and list it in LICENSED_READ_TABLES, or list it in PACK_ID_NOT_QUESTION_STORE with a reason`);
    }
  }
  return errors;
}

/** A listed verb that is now covered by a policy (or whose table is gone) is stale: remove the entry. */
function staleAllowlist(
  tables: Map<string, TableState>,
  allow: Readonly<Record<string, { verbs: readonly Verb[]; reason: string }>> = NO_WRITE_VERB_ALLOWLIST,
): Violation[] {
  const out: Violation[] = [];
  for (const [name, a] of Object.entries(allow)) {
    const st = tables.get(name);
    if (!st || a.verbs.some((v) => covers(st, v))) {
      out.push({ file: st?.file ?? "tools/lint-rls-policies.ts", tableName: name, missing: ["stale_allowlist_entry"] });
    }
  }
  return out;
}

/** Back-compat helper for single-file fixtures. */
function validateSqlContent(filePath: string, content: string): Violation[] {
  return checkTables(analyseMigrations([{ file: filePath, content }]));
}

/** Migration order: numeric prefix of the file name, then name. */
function migrationOrder(a: string, b: string): number {
  const na = parseInt(path.basename(a), 10);
  const nb = parseInt(path.basename(b), 10);
  return na - nb || path.basename(a).localeCompare(path.basename(b));
}

// ---------------------------------------------------------------------------
// Raw pool.connect() allowlist (RW-38)
// ---------------------------------------------------------------------------
//
// Every `pool.connect()` / `getPool().connect()` in app code must go through
// withTenant / withSystemRole (modules/02-tenancy/src/with-tenant.ts). A raw
// connect is allowed only when listed in tools/pool-connect.allowlist.txt with
// a reason. A listed entry that matches no hit is stale and also fails.

const POOL_CONNECT_RE = /(?:\bpool|getPool\(\))\.connect\(/;
const POOL_ALIAS_RE = /\b(?:const|let|var)\s+(\w+)\s*=\s*getPool\(\)/g;
const POOL_NEW_RE = /\bnew\s+(?:pg\.)?(?:Pool|Client)\s*\(/;
const POOL_CONNECT_HOME = "modules/02-tenancy/src/with-tenant.ts";
const POOL_NEW_HOME = "modules/02-tenancy/src/";
// new Pool()/new Client() is exempt in test files: they build throwaway test containers.
const POOL_NEW_EXEMPT_RE = /(?:^|\/)__tests__\/|^tools\/test-support\/|\.test\.ts$/;
// A4/A2-5: a query straight on the pool has no tenant context (RLS fails closed). Multi-line safe.
const POOL_QUERY_RE = /getPool\(\)\s*\.query\s*(?:<[^()]*?>)?\s*\(/g;
const POOL_QUERY_MSG =
  "getPool().query() runs without tenant context; use withTenant/withSystemRole, or list the file in tools/pool-connect.allowlist.txt (one entry per hit)";
const POOL_MARKER = "// pool-connect-ok:";
// FUT-10: only withSystemRole (with-tenant.ts) may switch to the BYPASSRLS role.
const SYSTEM_ROLE_RE = /SET\s+(?:LOCAL\s+|SESSION\s+)?ROLE\s+assessiq_system/i;
const SYSTEM_ROLE_MSG =
  "raw SET ROLE assessiq_system outside modules/02-tenancy/src/with-tenant.ts; use withSystemRole (FUT-10)";
const POOL_CONNECT_MSG =
  "raw pool.connect() outside withTenant/withSystemRole; list the file in tools/pool-connect.allowlist.txt and mark the line, or use withSystemRole";
const POOL_NEW_MSG =
  "new Pool()/new Client() outside modules/02-tenancy/src; use the shared tenancy pool (or list the file and mark the line)";

type PoolHit = { file: string; loc: string; msg: string; marked: boolean };

/** Pure scan of one file. Catches aliases of getPool(). `marked` = marker comment on the hit line or the line above. */
function scanPoolText(rel: string, text: string): PoolHit[] {
  const out: PoolHit[] = [];
  const aliases = [...text.matchAll(POOL_ALIAS_RE)].map((m) => m[1]!);
  const hasAlias = (line: string) => aliases.some((a) => line.includes(`${a}.connect(`));
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    const loc = `${rel}:${i + 1}`;
    const marked = line.includes(POOL_MARKER) || (lines[i - 1] ?? "").includes(POOL_MARKER);
    if ((POOL_CONNECT_RE.test(line) || hasAlias(line)) && rel !== POOL_CONNECT_HOME) {
      out.push({ file: rel, loc, msg: POOL_CONNECT_MSG, marked });
    }
    const code = line.trim();
    if (SYSTEM_ROLE_RE.test(line) && rel !== POOL_CONNECT_HOME && !/^(\/\/|\*|\/\*)/.test(code)) {
      out.push({ file: rel, loc, msg: SYSTEM_ROLE_MSG, marked: false });
    }
    if (POOL_NEW_RE.test(line) && !rel.startsWith(POOL_NEW_HOME) && !POOL_NEW_EXEMPT_RE.test(rel)) {
      out.push({ file: rel, loc, msg: POOL_NEW_MSG, marked });
    }
  });
  // Pool-level query: whole-text scan, so a call split over two lines is caught. The allowlist entry is the control (no marker).
  const lineOf = (idx: number) => text.slice(0, idx).split("\n").length;
  if (rel !== POOL_CONNECT_HOME) {
    for (const m of text.matchAll(POOL_QUERY_RE)) {
      out.push({ file: rel, loc: `${rel}:${lineOf(m.index!)}`, msg: POOL_QUERY_MSG, marked: true });
    }
    for (const a of aliases) {
      for (const m of text.matchAll(new RegExp(String.raw`\b${a}\s*\.query\s*(?:<[^()]*?>)?\s*\(`, "g"))) {
        out.push({ file: rel, loc: `${rel}:${lineOf(m.index!)}`, msg: POOL_QUERY_MSG, marked: true });
      }
    }
  }
  return out;
}

/**
 * Pure check, per hit line. An allowlist entry is `<file>` (covers one marked hit in that file; list it once per
 * hit) or `<file>:<line>` (covers exactly that line). A hit passes only if it is marked AND consumes an entry,
 * so a second connect in an allowlisted file needs its own entry. Unused entries are stale.
 */
function checkPoolConnect(hits: PoolHit[], allowed: readonly string[]): string[] {
  const errors: string[] = [];
  const left = [...allowed];
  const take = (key: string): boolean => {
    const i = left.indexOf(key);
    if (i < 0) return false;
    left.splice(i, 1);
    return true;
  };
  for (const h of hits) {
    const listed = left.includes(h.loc) || left.includes(h.file);
    if (listed && h.marked) {
      if (!take(h.loc)) take(h.file);
      continue;
    }
    const why = listed ? `missing '${POOL_MARKER} <reason>' marker` : "no free entry in tools/pool-connect.allowlist.txt (one entry per hit line)";
    errors.push(`${h.loc} — ${h.msg} (${why})`);
  }
  for (const a of left) errors.push(`tools/pool-connect.allowlist.txt: stale entry ${a} (no pool hit)`);
  return errors;
}

async function collectTsFiles(dir: string, out: string[]): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name) && e.name !== "__tests__") await collectTsFiles(full, out);
    } else if (e.name.endsWith(".ts") && !e.name.endsWith(".test.ts") && !e.name.endsWith(".d.ts")) {
      out.push(full);
    }
  }
}

async function scanPoolConnect(): Promise<string[]> {
  const roots: string[] = [];
  const modulesDir = path.join(REPO_ROOT, "modules");
  for (const m of await fsp.readdir(modulesDir, { withFileTypes: true })) {
    if (m.isDirectory()) await collectTsFiles(path.join(modulesDir, m.name, "src"), roots);
  }
  await collectTsFiles(path.join(REPO_ROOT, "apps", "api", "src"), roots);

  const allowText = await fsp.readFile(path.join(REPO_ROOT, "tools", "pool-connect.allowlist.txt"), "utf8");
  const allowed = (
    allowText
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith("#"))
      .map((l) => l.split("|")[0]!.trim())
  );

  const hits: PoolHit[] = [];
  for (const f of roots) {
    const rel = path.relative(REPO_ROOT, f).split(path.sep).join("/");
    hits.push(...scanPoolText(rel, await fsp.readFile(f, "utf8")));
  }
  return checkPoolConnect(hits, allowed);
}

// ---------------------------------------------------------------------------
// Self-test mode
// ---------------------------------------------------------------------------

function runSelfTest(): void {
  process.stdout.write("RLS policy linter — running self-test...\n");

  // --- Fixture 1: valid migration with both policies ---
  const validSql = `
CREATE TABLE public.assessments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  title        text NOT NULL
);

ALTER TABLE public.assessments ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation
  ON public.assessments
  FOR SELECT
  USING (tenant_id = current_setting('app.current_tenant')::uuid);

CREATE POLICY tenant_isolation_insert
  ON public.assessments
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.current_tenant')::uuid);

CREATE POLICY tenant_isolation_update
  ON public.assessments
  FOR UPDATE
  USING (tenant_id = current_setting('app.current_tenant')::uuid);

CREATE POLICY tenant_isolation_delete
  ON public.assessments
  FOR DELETE
  USING (tenant_id = current_setting('app.current_tenant')::uuid);
`;

  // --- Fixture 2: invalid migration — missing insert policy ---
  const invalidSql = `
CREATE TABLE public.submissions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  data         jsonb
);

ALTER TABLE public.submissions ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation
  ON public.submissions
  FOR SELECT
  USING (tenant_id = current_setting('app.current_tenant')::uuid);
`;

  // --- Fixture 3: tenants table itself (special case) ---
  const tenantsSql = `
CREATE TABLE public.tenants (
  id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug  text NOT NULL UNIQUE
);

ALTER TABLE public.tenants ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation
  ON public.tenants
  FOR SELECT
  USING (id = current_setting('app.current_tenant')::uuid);
`;

  // --- Fixture 4: valid JOIN-based migration (child table, no tenant_id) ---
  const validJoinSql = `
CREATE TABLE public.levels (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pack_id   uuid NOT NULL REFERENCES question_packs(id) ON DELETE CASCADE,
  position  int NOT NULL,
  label     text NOT NULL
);

ALTER TABLE public.levels ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON public.levels
  USING (
    EXISTS (
      SELECT 1 FROM question_packs p
      WHERE p.id = levels.pack_id
        AND p.tenant_id = current_setting('app.current_tenant', true)::uuid
    )
  );

CREATE POLICY tenant_isolation_insert ON public.levels
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM question_packs p
      WHERE p.id = levels.pack_id
        AND p.tenant_id = current_setting('app.current_tenant', true)::uuid
    )
  );
`;

  // --- Fixture 5: child table missing RLS entirely ---
  const childMissingRlsSql = `
CREATE TABLE public.levels (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pack_id   uuid NOT NULL REFERENCES question_packs(id),
  position  int NOT NULL
);
`;

  // --- Fixture 6: child table policies named correctly but body is a no-op ---
  const childNoOpPolicySql = `
CREATE TABLE public.questions (
  id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pack_id  uuid NOT NULL REFERENCES question_packs(id),
  topic    text NOT NULL
);

ALTER TABLE public.questions ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON public.questions
  USING (true);

CREATE POLICY tenant_isolation_insert ON public.questions
  FOR INSERT
  WITH CHECK (true);
`;

  const v1 = validateSqlContent("<fixture:valid>", validSql);
  const v2 = validateSqlContent("<fixture:invalid>", invalidSql);
  const v3 = validateSqlContent("<fixture:tenants>", tenantsSql);
  const v4 = validateSqlContent("<fixture:join-valid>", validJoinSql);
  const v5 = validateSqlContent("<fixture:child-missing-rls>", childMissingRlsSql);
  const v6 = validateSqlContent("<fixture:child-noop-policy>", childNoOpPolicySql);

  let passed = true;

  if (v1.length !== 0) {
    process.stderr.write(
      `FAIL: valid fixture should have 0 violations, got ${v1.length}\n`
    );
    passed = false;
  } else {
    process.stdout.write("  PASS: valid fixture — 0 violations (expected)\n");
  }

  if (v2.length !== 1 || !v2[0]!.missing.includes("policy_insert")) {
    process.stderr.write(
      `FAIL: invalid fixture should have 1 violation (missing tenant_isolation_insert), got ${JSON.stringify(v2)}\n`
    );
    passed = false;
  } else {
    process.stdout.write(
      "  PASS: invalid fixture — 1 violation missing tenant_isolation_insert (expected)\n"
    );
  }

  if (v3.length !== 0) {
    process.stderr.write(
      `FAIL: tenants-table fixture should have 0 violations, got ${v3.length}\n`
    );
    passed = false;
  } else {
    process.stdout.write("  PASS: tenants-table fixture — 0 violations (expected)\n");
  }

  if (v4.length !== 0) {
    process.stderr.write(
      `FAIL: JOIN-valid fixture should have 0 violations, got ${JSON.stringify(v4)}\n`
    );
    passed = false;
  } else {
    process.stdout.write(
      "  PASS: JOIN-based valid fixture — 0 violations (expected)\n"
    );
  }

  if (
    v5.length !== 1 ||
    !v5[0]!.missing.includes("policy_select") ||
    !v5[0]!.missing.includes("policy_insert")
  ) {
    process.stderr.write(
      `FAIL: child-missing-rls fixture should have 1 violation (both policies missing on \`levels\`), got ${JSON.stringify(v5)}\n`
    );
    passed = false;
  } else {
    process.stdout.write(
      "  PASS: child-missing-rls fixture — both policies missing on `levels` (expected)\n"
    );
  }

  if (
    v6.length !== 1 ||
    !v6[0]!.missing.includes("exists_clause_with_current_setting")
  ) {
    process.stderr.write(
      `FAIL: child-noop-policy fixture should flag exists_clause_with_current_setting on \`questions\`, got ${JSON.stringify(v6)}\n`
    );
    passed = false;
  } else {
    process.stdout.write(
      "  PASS: child-noop-policy fixture — exists_clause_with_current_setting flagged (expected)\n"
    );
  }

  // --- A2-5: per-table, per-verb, cross-file fixtures ---
  const tbl = (n: string, extra = "") => `CREATE TABLE ${n} (id uuid PRIMARY KEY, tenant_id uuid NOT NULL${extra});\n`;
  const rls = (n: string) => `ALTER TABLE ${n} ENABLE ROW LEVEL SECURITY;\n`;
  const pol = (n: string, verb: string, name = `p_${verb}`) =>
    `CREATE POLICY ${name} ON ${n} FOR ${verb} USING (tenant_id = current_setting('app.current_tenant')::uuid);\n`;
  const full = (n: string) => tbl(n) + rls(n) + ["SELECT", "INSERT", "UPDATE", "DELETE"].map((v) => pol(n, v)).join("");
  const miss = (sql: string) => validateSqlContent("<f>", sql).map((v) => `${v.tableName}:${v.missing.join("+")}`).join(",");
  const rlsCases: Array<[string, boolean]> = [
    ["all four verbs ok", miss(full("a")) === ""],
    ["FOR ALL (no FOR clause) covers every verb", miss(tbl("a") + rls("a") + "CREATE POLICY tenant_isolation ON a USING (true);") === ""],
    ["table A policies do not satisfy table B", miss(full("a") + tbl("b") + rls("b")) === "b:policy_select+policy_insert+policy_update+policy_delete"],
    ["missing ENABLE ROW LEVEL SECURITY", miss(tbl("a") + ["SELECT", "INSERT", "UPDATE", "DELETE"].map((v) => pol("a", v)).join("")) === "a:rls_not_enabled"],
    ["missing DELETE", miss(tbl("a") + rls("a") + pol("a", "SELECT") + pol("a", "INSERT") + pol("a", "UPDATE")) === "a:policy_delete"],
    ["missing UPDATE", miss(tbl("a") + rls("a") + pol("a", "SELECT") + pol("a", "INSERT") + pol("a", "DELETE")) === "a:policy_update"],
    ["DROP POLICY removes coverage", miss(full("a") + "DROP POLICY IF EXISTS p_delete ON a;") === "a:policy_delete"],
    ["DROP then CREATE restores coverage", miss(full("a") + "DROP POLICY p_delete ON a;" + pol("a", "DELETE", "p_delete2")) === ""],
    ["later migration adds the missing verb", checkTables(analyseMigrations([{ file: "1", content: tbl("a") + rls("a") + pol("a", "SELECT") + pol("a", "INSERT") + pol("a", "UPDATE") }, { file: "2", content: pol("a", "DELETE") }])).length === 0],
    ["allowlisted verb passes", checkTables(analyseMigrations([{ file: "1", content: tbl("a") + rls("a") + pol("a", "SELECT") + pol("a", "INSERT") }]), { a: { verbs: ["update", "delete"], reason: "r" } }).length === 0],
    ["allowlist does not cover other verbs", checkTables(analyseMigrations([{ file: "1", content: tbl("a") + rls("a") + pol("a", "SELECT") }]), { a: { verbs: ["update", "delete"], reason: "r" } }).map((v) => v.missing.join()).join() === "policy_insert"],
    ["stale allowlist entry fails", staleAllowlist(analyseMigrations([{ file: "1", content: full("a") }]), { a: { verbs: ["delete"], reason: "r" } }).some((v) => v.missing.includes("stale_allowlist_entry"))],
    ["table without tenant_id is ignored", miss("CREATE TABLE g (id uuid PRIMARY KEY);") === ""],
    ["ALTER ADD COLUMN tenant_id makes it tenant-bearing", miss("CREATE TABLE g (id uuid PRIMARY KEY);\nALTER TABLE g ADD COLUMN IF NOT EXISTS tenant_id uuid;") !== ""],
    ["policy text in a comment does not count", miss(tbl("a") + rls("a") + "-- CREATE POLICY x ON a FOR SELECT USING (true);\n") === "a:policy_select+policy_insert+policy_update+policy_delete"],
    ["getPool().query flagged", scanPoolText("modules/x/src/a.ts", "await getPool().query('x');").length === 1],
    ["getPool() then .query on next line flagged", scanPoolText("modules/x/src/a.ts", "getPool()\n  .query(\n 'x')").map((h) => h.loc).join() === "modules/x/src/a.ts:1"],
    ["getPool().query<T>( flagged", scanPoolText("modules/x/src/a.ts", "getPool().query<{ a: 1 }>('x')").length === 1],
    ["aliased pool .query flagged", scanPoolText("modules/x/src/a.ts", "const p = getPool();\np.query('x')").length === 1],
    ["getPool().query allowed in with-tenant.ts", scanPoolText("modules/02-tenancy/src/with-tenant.ts", "getPool().query('x')").length === 0],
    ["getPool().query listed in allowlist passes", checkPoolConnect(scanPoolText("modules/x/src/a.ts", "getPool().query('x')"), ["modules/x/src/a.ts"]).length === 0],
  ];
  for (const [name, ok] of rlsCases) {
    if (ok) process.stdout.write(`  PASS: rls fixture — ${name} (expected)\n`);
    else {
      process.stderr.write(`FAIL: rls fixture — ${name}\n`);
      passed = false;
    }
  }

  // --- pool.connect() allowlist check ---
  const scan = (rel: string, txt: string) => scanPoolText(rel, txt).map((h) => h.loc);
  const pcCases: Array<[string, boolean]> = [
    ["aliased pool", scan("modules/x/src/a.ts", "const p = getPool();\nawait p.connect();").join() === "modules/x/src/a.ts:2"],
    ["new Pool outside tenancy", scan("modules/x/src/a.ts", "const p = new Pool({});").length === 1],
    ["new Client outside tenancy", scan("modules/x/src/a.ts", "const c = new Client({});").length === 1],
    ["new Pool in tenancy not flagged", scan("modules/02-tenancy/src/pool.ts", "const p = new Pool({});").length === 0],
    ["new Client in __tests__ exempt", scan("modules/x/src/__tests__/a.ts", "new Client({})").length === 0],
    ["raw SET LOCAL ROLE assessiq_system flagged", scan("modules/x/src/a.ts", 'await c.query("SET LOCAL ROLE assessiq_system");').length === 1],
    ["raw SET ROLE assessiq_system flagged", scan("modules/x/src/a.ts", "await c.query('SET ROLE assessiq_system');").length === 1],
    ["system role in with-tenant.ts allowed", scan("modules/02-tenancy/src/with-tenant.ts", 'c.query("SET LOCAL ROLE assessiq_system")').length === 0],
    ["system role in a comment allowed", scan("modules/x/src/a.ts", "// SET LOCAL ROLE assessiq_system lets us").length === 0],
    ["plain pool.connect still flagged", scan("modules/x/src/a.ts", "pool.connect()").length === 1],
  ];
  const listed = ["modules/x/src/a.ts"];
  const chk = (rel: string, txt: string, set: readonly string[]) => checkPoolConnect(scanPoolText(rel, txt), set);
  const mk = "// pool-connect-ok: r";
  pcCases.push(["marker on line + file listed ok", chk("modules/x/src/a.ts", `pool.connect(); ${mk}`, listed).length === 0]);
  pcCases.push(["marker on line above ok", chk("modules/x/src/a.ts", `${mk}${String.fromCharCode(10)}pool.connect();`, listed).length === 0]);
  const unmarked = chk("modules/x/src/a.ts", `pool.connect(); ${mk}${String.fromCharCode(10)}foo();${String.fromCharCode(10)}${String.fromCharCode(10)}pool.connect();`, listed);
  pcCases.push(["listed file + second unmarked connect fails", unmarked.length === 1 && unmarked[0]!.startsWith("modules/x/src/a.ts:4")]);
  const unlisted = chk("modules/x/src/b.ts", `pool.connect(); ${mk}`, listed);
  pcCases.push(["marker but file not listed fails", unlisted.length === 2 && unlisted[0]!.includes("no free entry")]);
  const twoMarked = chk("modules/x/src/a.ts", `pool.connect(); ${mk}${String.fromCharCode(10)}pool.connect(); ${mk}`, listed);
  pcCases.push(["second marked connect, one entry, fails", twoMarked.length === 1 && twoMarked[0]!.startsWith("modules/x/src/a.ts:2")]);
  pcCases.push(["two entries cover two marked hits", chk("modules/x/src/a.ts", `pool.connect(); ${mk}${String.fromCharCode(10)}pool.connect(); ${mk}`, [...listed, ...listed]).length === 0]);
  pcCases.push(["file:line entry matches exact line", chk("modules/x/src/a.ts", `foo();${String.fromCharCode(10)}pool.connect(); ${mk}`, ["modules/x/src/a.ts:2"]).length === 0]);
  const stale = checkPoolConnect([], ["modules/x/src/gone.ts"]);
  pcCases.push(["stale entry reported", stale.length === 1 && stale[0]!.includes("stale entry")]);
  for (const [name, ok] of pcCases) {
    if (ok) process.stdout.write(`  PASS: pool-connect fixture — ${name} (expected)\n`);
    else {
      process.stderr.write(`FAIL: pool-connect fixture — ${name}\n`);
      passed = false;
    }
  }

  // EXP-14 licensed_read fixtures: a write verb, a missing switch and a new pack_id table are all refused.
  const lrBase = (extra: string): Map<string, TableState> =>
    analyseMigrations([{ file: "x.sql", content: extra }]);
  const lrCases: Array<[string, boolean]> = [
    ["FOR ALL licensed_read is refused", checkLicensedRead(lrBase(
      `CREATE TABLE questions (id uuid); ALTER TABLE questions ENABLE ROW LEVEL SECURITY;
       CREATE POLICY licensed_read ON questions FOR ALL USING (current_setting('app.licensed_read', true) = 'on' AND pack_id = ANY((SELECT licensed_pack_ids())));`,
    )).some((e) => e.startsWith("questions: licensed_read must be FOR SELECT"))],
    ["missing switch is refused", checkLicensedRead(lrBase(
      `CREATE TABLE questions (id uuid); CREATE POLICY licensed_read ON questions FOR SELECT USING (pack_id = ANY((SELECT licensed_pack_ids())));`,
    )).some((e) => e.includes("app.licensed_read switch"))],
    ["new pack_id table is refused", checkLicensedRead(lrBase(
      `CREATE TABLE new_thing (id uuid, pack_id uuid);`,
    )).some((e) => e.startsWith("new_thing: new table with a pack_id column"))],
  ];
  for (const [name, ok] of lrCases) {
    if (ok) process.stdout.write(`  PASS: licensed_read fixture — ${name} (expected)\n`);
    else {
      process.stderr.write(`FAIL: licensed_read fixture — ${name}\n`);
      passed = false;
    }
  }

  if (passed) {
    process.stdout.write("RLS policy linter self-test: PASSED\n");
    process.exit(0);
  } else {
    process.stderr.write("RLS policy linter self-test: FAILED\n");
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes("--self-test")) {
    runSelfTest();
    return; // runSelfTest calls process.exit, but keep TS happy
  }

  const files = (await findMigrationFiles(REPO_ROOT)).sort(migrationOrder);
  const loaded = await Promise.all(files.map(async (file) => ({ file, content: await fsp.readFile(file, "utf8") })));
  const tables = analyseMigrations(loaded);
  const allViolations = [...checkTables(tables), ...staleAllowlist(tables)];
  const tenantBearingTables = [...tables.values()].filter((t) => t.tenantBearing).length;
  const joinBasedTables = [...tables.keys()].filter((n) => JOIN_RLS_TABLES.has(n)).length;

  const poolErrors = [...(await scanPoolConnect()), ...checkLicensedRead(tables)];

  if (allViolations.length > 0 || poolErrors.length > 0) {
    for (const v of allViolations) {
      const rel = path.relative(REPO_ROOT, v.file);
      process.stderr.write(
        `${rel}:${v.tableName} — missing ${v.missing.join(", ")} policy\n`
      );
    }
    for (const e of poolErrors) process.stderr.write(`${e}\n`);
    process.exit(1);
  }

  process.stdout.write(
    `RLS policy linter: OK (${files.length} migration files scanned, ${tenantBearingTables} tenant-bearing tables + ${joinBasedTables} JOIN-based child tables matched policies)\n`
  );
  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(`RLS policy linter error: ${String(err)}\n`);
  process.exit(1);
});
