/**
 * tools/audit-rubrics.ts  (FU-C17)
 *
 * READ-ONLY audit of stored rubrics against the strict save rules owned by
 * module 08 (`strictRubricIssues`): anchor weights sum to anchor_weight_total,
 * anchor ids unique, band text non-empty. Old rubrics stay loadable and gradeable
 * (parseRubric is lenient); this lists the ones a re-save would now reject.
 *
 * SELECT only, inside a READ ONLY transaction. Uses `SET LOCAL ROLE assessiq_system`
 * (BYPASSRLS, transaction-scoped) for the cross-tenant sweep — same pattern as
 * tools/cleanup-stale-drafts.ts. Run only from trusted operator shell access.
 *
 * Usage (inside the api container):
 *   pnpm exec tsx tools/audit-rubrics.ts
 *
 * Exit codes: 0 audit done (findings or not), 2 usage / DATABASE_URL / DB error.
 */

import { parseRubric, strictRubricIssues } from "@assessiq/rubric-engine";

type Row = { id: string; rubric: unknown };

const RULES: Array<[string, RegExp]> = [
  ["weights-sum", /weights sum/],
  ["duplicate-ids", /duplicate anchor ids/],
  ["empty-band", /band text must not be empty/],
];

function audit(table: string, rows: Row[]): void {
  const failing: Record<string, string[]> = Object.fromEntries(RULES.map(([n]) => [n, []]));
  const unparseable: string[] = [];
  for (const row of rows) {
    const parsed = parseRubric(row.rubric);
    if (!parsed.ok) {
      unparseable.push(row.id);
      continue;
    }
    const issues = strictRubricIssues(parsed.data);
    for (const [name, re] of RULES) {
      if (issues.some((i) => re.test(i))) failing[name]!.push(row.id);
    }
  }
  console.log(`\n== ${table}: ${rows.length} rubric rows ==`);
  for (const [name] of RULES) {
    console.log(`${name}: ${failing[name]!.length}${failing[name]!.length ? "  ids: " + failing[name]!.join(", ") : ""}`);
  }
  console.log(`fails base schema (already unparseable): ${unparseable.length}${unparseable.length ? "  ids: " + unparseable.join(", ") : ""}`);
}

async function main(): Promise<void> {
  if (!process.env["DATABASE_URL"]) {
    process.stderr.write("DATABASE_URL not set — run from inside the api container.\n");
    process.exit(2);
  }
  const { getPool, closePool } = await import("@assessiq/tenancy");
  const client = await getPool().connect();
  try {
    await client.query("BEGIN READ ONLY");
    await client.query("SET LOCAL ROLE assessiq_system");
    const q = await client.query<Row>("SELECT id, rubric FROM questions WHERE rubric IS NOT NULL");
    audit("questions", q.rows);
    const v = await client.query<Row>("SELECT id, rubric FROM question_versions WHERE rubric IS NOT NULL");
    audit("question_versions", v.rows);
    await client.query("ROLLBACK");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    process.stderr.write(`audit failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 2;
  } finally {
    client.release();
    await closePool().catch(() => {});
  }
}

void main();
