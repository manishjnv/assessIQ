// One-shot smoke runner for the sharded generation path.
// Runs inside assessiq-api container via:
//   docker exec assessiq-api pnpm exec tsx /app/tools/stage1-sharded-smoke.ts
//
// Calls handleAdminGenerate directly (bypasses HTTP/auth). Targets
// WIPRO-SOC L2 with count=8 to exercise mcq+log_analysis+scenario+kql.
import { handleAdminGenerate } from "@assessiq/ai-grading";
import { SOC_KNOWLEDGE_BASE } from "@assessiq/question-bank";
import { getPool } from "@assessiq/tenancy";

const TENANT_ID = "019d8000-0001-7f00-8000-000000000001";
const USER_ID = "26a8f5b1-979d-4188-a2dc-a0e8745a2a62";
const PACK_ID = "019df000-44f3-7c97-9403-f7bde6a36843";
const LEVEL_ID = process.env.SMOKE_LEVEL_ID ?? "019df008-b3e0-79b0-b409-624e2037fbe6";
const COUNT = parseInt(process.env.SMOKE_COUNT ?? "15", 10);

async function main() {
  console.log(`[smoke] starting level=${LEVEL_ID} count=${COUNT}`);
  const sources = SOC_KNOWLEDGE_BASE.filter((s) => s.level_fit === "L2");
  console.log(`[smoke] tenant=${TENANT_ID.slice(0, 8)} pack=${PACK_ID.slice(0, 8)} level=${LEVEL_ID.slice(0, 8)} count=${COUNT} sources=${sources.length}`);

  const startedAt = Date.now();
  try {
    const result = await handleAdminGenerate({
      tenantId: TENANT_ID,
      userId: USER_ID,
      packId: PACK_ID,
      levelId: LEVEL_ID,
      count: COUNT,
      socLevel: "L2",
      sources: sources as any,
      existingTopics: [],
    });
    const ms = Date.now() - startedAt;
    console.log(`[smoke] ok generated=${result.generated} ids=${result.questionIds.length} skill=${result.skillSha} duration=${ms}ms`);

    // Fetch the latest generation_attempts row for this pack/level so we can
    // print a ready-to-run score-candidate command. Uses assessiq_system to
    // bypass RLS (same pattern as listActiveTenantIds in @assessiq/tenancy).
    try {
      const pool = getPool();
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL ROLE assessiq_system");
        const res = await client.query<{ id: string }>(
          `SELECT id FROM generation_attempts
            WHERE pack_id = $1 AND level_id = $2
            ORDER BY started_at DESC LIMIT 1`,
          [PACK_ID, LEVEL_ID],
        );
        await client.query("COMMIT");
        const attemptId = res.rows[0]?.id;
        if (attemptId) {
          console.log(
            `[smoke] To score this attempt: pnpm -C modules/07-ai-grading exec tsx eval/cli-typed.ts score-candidate --attempt-id ${attemptId}`,
          );
        }
      } catch {
        // Attempt-row lookup is best-effort; do not mask the generation result.
        console.log(
          `[smoke] Could not fetch attempt id — score manually:\n` +
            `  question ids: ${result.questionIds.join(", ")}\n` +
            `  TODO: run score-candidate --attempt-id <id> after locating the row in generation_attempts`,
        );
      } finally {
        client.release();
      }
    } catch {
      // Pool connect failure — non-critical, log and continue.
      console.log(`[smoke] Could not connect to DB for attempt-id lookup.`);
    }
  } catch (err) {
    const ms = Date.now() - startedAt;
    console.log(`[smoke] FAIL duration=${ms}ms`);
    console.log(err);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
