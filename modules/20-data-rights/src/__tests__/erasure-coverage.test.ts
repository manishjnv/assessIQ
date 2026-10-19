// Static guard (RW-51b): every personal-data-looking column in migrations must be
// handled by erasure.ts (REGISTRY) or carry a reasoned exemption (EXEMPT). No DB needed.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const MODULES = resolve(__dirname, '../../..');
const ERASURE_SRC = readFileSync(resolve(__dirname, '../erasure.ts'), 'utf8');

// Columns that erasure.ts scrubs today. Each must appear in an UPDATE/DELETE there.
const REGISTRY = [
  'users.name',
  'users.email',
  'users.metadata',
  'attempt_answers.answer',
  'gradings.stage_inputs',
  'gradings.anchor_hits',
  'gradings.ai_justification',
  'attempts.ai_proposals',
  'sessions.ip',
  'sessions.user_agent',
  'candidate_login_tokens.requested_ip',
  'candidate_login_tokens.requested_ua',
  'user_invitations.email',
  'email_log.to_address',
  'email_log.subject',
  'email_log.body_text',
  'email_log.body_html',
  'attempts.evaluation_note',
];

// Personal-looking columns deliberately NOT erased. One-line reason each.
const EXEMPT: Record<string, string> = {
  'question_review_notes.note': 'staff note about a question (Z-52 gap 6); append-only like audit_log, author is a plain uuid, holds no candidate personal data',
  'exam_blueprints.name': 'exam title from the platform blueprint table (EXP-6); platform reference data, no personal data',
  'exam_blueprints.source_note': 'note naming the official exam notice the blueprint was checked against (EXP-6); no personal data',
  'exam_blueprint_sections.name': 'exam section title such as Quant (EXP-6); platform reference data, no personal data',
  'tenant_settings.result_feedback_level': 'tenant display setting (per-question feedback level); no personal data (S15 RW-80)',
  // Organisation / content data, not candidate personal data
  'oauth_identities.email_verified': 'boolean flag, not an address',
  'tenant_plans.ai_answers_included_override': 'plan quota number set by the super admin (PT-4), not personal data',
  'embed_secrets.name': 'admin-chosen label for a secret',
  'api_keys.name': 'admin-chosen label for a key',
  'tenants.name': 'organisation name',
  'question_packs.name': 'content pack title',
  'tags.name': 'content tag label',
  'domains.name': 'content domain label (lives in packs)',
  'categories.name': 'content category label',
  'frameworks.name': 'curriculum framework title',
  'assessments.name': 'assessment title set by admin',
  'webhook_endpoints.name': 'admin-chosen label for an endpoint',
  'questions.answer_guidance': 'author-written content for graders, not candidate input',
  'tenant_plans.notes': 'platform-operator billing notes about a tenant',
  'question_imports.file_name': 'uploaded file name chosen by the super admin (RW-58); content metadata, not candidate data',
  'question_imports.pack_name': 'draft question-set name typed by the super admin (RW-58); content metadata',
  // Kept by design
  'certificates.display_name': 'D5: certificates are immutable HMAC snapshots, never mutated',
  'audit_log.ip': 'audit_log is append-only by design (14-audit-log invariant)',
  'audit_log.user_agent': 'audit_log is append-only by design (14-audit-log invariant)',
  // Kept: owner decision pending
  'consent_events.ip': 'kept: legal retention, owner decision pending (RW-89)',
  'consent_events.user_agent': 'kept: legal retention, owner decision pending (RW-89)',
  'gradings.reasoning_band': 'numeric band (0/25/50/75/100), not text; matched on the word reasoning',
};

// Column-name heuristic for personal / answer data (matched per snake_case word).
const SUSPECT =
  /(^|_)(email|name|phone|mobile|roll|answer|answers|justification|proposal|proposals|metadata|address|dob|birth|ip|ua|user_agent|aadhaar|pan|passport|reasoning|notes?|comment|comments|feedback|rationale|stage_inputs|anchor_hits)(_|$)/i;

const CONSTRAINT_START = /^(constraint|primary|foreign|unique|check|exclude|like)\b/i;

function stripComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');
}

function splitTopLevel(body: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of body) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

/** Returns "table.column" for every column created/added in the SQL. DROP/RENAME ignored. */
function extractColumns(rawSql: string): string[] {
  const sql = stripComments(rawSql);
  const cols: string[] = [];
  const createRe = /create\s+table\s+(?:if\s+not\s+exists\s+)?(?:\w+\.)?"?(\w+)"?\s*\(/gi;
  let m: RegExpExecArray | null;
  while ((m = createRe.exec(sql)) !== null) {
    const table = m[1]!.toLowerCase();
    let i = createRe.lastIndex;
    let depth = 1;
    const start = i;
    while (i < sql.length && depth > 0) {
      if (sql[i] === '(') depth++;
      if (sql[i] === ')') depth--;
      i++;
    }
    for (const item of splitTopLevel(sql.slice(start, i - 1))) {
      const t = item.trim();
      if (!t || CONSTRAINT_START.test(t)) continue;
      const name = /^"?(\w+)"?/.exec(t)?.[1];
      if (name) cols.push(`${table}.${name.toLowerCase()}`);
    }
  }
  const alterRe = /alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?(?:\w+\.)?"?(\w+)"?([^;]*);/gi;
  while ((m = alterRe.exec(sql)) !== null) {
    const table = m[1]!.toLowerCase();
    const addRe = /add\s+column\s+(?:if\s+not\s+exists\s+)?"?(\w+)"?/gi;
    let a: RegExpExecArray | null;
    while ((a = addRe.exec(m[2]!)) !== null) cols.push(`${table}.${a[1]!.toLowerCase()}`);
  }
  return cols;
}

/** Suspect columns that are neither registered nor exempt. */
function findUncovered(sql: string, covered: ReadonlySet<string>): string[] {
  return extractColumns(sql).filter((c) => SUSPECT.test(c.split('.')[1]!) && !covered.has(c));
}

function sqlFiles(): string[] {
  const files: string[] = [];
  for (const mod of readdirSync(MODULES)) {
    for (const dir of ['migrations', 'seeds']) {
      const d = join(MODULES, mod, dir);
      if (!existsSync(d)) continue;
      for (const f of readdirSync(d)) if (f.endsWith('.sql')) files.push(join(d, f));
    }
  }
  return files;
}

const COVERED = new Set([...REGISTRY, ...Object.keys(EXEMPT)]);

describe('erasure coverage', () => {
  it.each(REGISTRY)('erasure.ts updates %s', (entry) => {
    const [table, col] = entry.split('.') as [string, string];
    const stmts = (ERASURE_SRC.match(/`[^`]*`/g) ?? []).filter((q) => /^`\s*(UPDATE|DELETE)\s/i.test(q));
    const hit = stmts.some(
      (s) => new RegExp(String.raw`\b${table}\b`, 'i').test(s) && new RegExp(String.raw`\b${col}\b`, 'i').test(s),
    );
    expect(hit, `${entry} is registered but no UPDATE/DELETE on it in erasure.ts`).toBe(true);
  });

  it('every personal-looking migration column is handled or exempted', () => {
    const bad: string[] = [];
    for (const f of sqlFiles()) {
      for (const c of findUncovered(readFileSync(f, 'utf8'), COVERED)) bad.push(`${c} (${f.slice(MODULES.length + 1)})`);
    }
    expect(bad, 'Add to REGISTRY (and erasure.ts) or EXEMPT with a reason:\n' + bad.join('\n')).toEqual([]);
  });

  it('fixture: a migration adding users.phone_number is flagged', () => {
    const fixture = `ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_number text;`;
    expect(findUncovered(fixture, COVERED)).toEqual(['users.phone_number']);
  });

  it('fixture: create-table columns are parsed; constraints, drops and renames ignored', () => {
    const sql = `CREATE TABLE t (id uuid, contact_email text, CONSTRAINT x CHECK (a > 1), UNIQUE (contact_email));
      ALTER TABLE t DROP COLUMN old_email; ALTER TABLE t RENAME COLUMN a TO b_email;`;
    expect(findUncovered(sql, new Set())).toEqual(['t.contact_email']);
  });
});
