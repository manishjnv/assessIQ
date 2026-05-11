// One-shot smoke runner for the sharded generation path.
// Runs inside assessiq-api container via:
//   docker exec assessiq-api pnpm exec tsx /app/tools/stage1-sharded-smoke.ts
//
// Calls handleAdminGenerate directly (bypasses HTTP/auth).
//
// Optional env vars:
//   SMOKE_LEVEL_ID  — target level UUID (default: WIPRO-SOC L2)
//   SMOKE_COUNT     — total questions to generate (default: 15)
//   SMOKE_TYPE      — comma-separated question type(s) to restrict generation.
//                     Unset or "all" → full weight-based allocation (default).
//                     One type       → SMOKE_COUNT questions of that type only.
//                     Multiple types → SMOKE_COUNT split evenly, round-down;
//                                      SMOKE_COUNT must be >= number of types.
//
// Examples:
//   Full smoke:       docker exec assessiq-api pnpm exec tsx /app/tools/stage1-sharded-smoke.ts
//   Scenario-only:    SMOKE_TYPE=scenario SMOKE_COUNT=2 pnpm exec tsx /app/tools/stage1-sharded-smoke.ts
//   Two-type:         SMOKE_TYPE=scenario,log_analysis SMOKE_COUNT=4 pnpm exec tsx ...
//   L1 single-type:   SMOKE_LEVEL_ID=<l1-uuid> SMOKE_TYPE=mcq SMOKE_COUNT=2 pnpm exec tsx ...
import { handleAdminGenerate } from "@assessiq/ai-grading";
import type { QuestionType } from "@assessiq/ai-grading";
import { SOC_KNOWLEDGE_BASE } from "@assessiq/question-bank";
import { getPool } from "@assessiq/tenancy";

// ---------------------------------------------------------------------------
// SMOKE_TYPE resolution
// ---------------------------------------------------------------------------

/** Canonical question types — mirrors QuestionType union in types.ts. */
const CANONICAL_TYPES: readonly QuestionType[] = [
  "mcq",
  "log_analysis",
  "scenario",
  "kql",
  "subjective",
];

/**
 * Build a full per-type allocation from SMOKE_TYPE + count.
 *
 * Returns undefined when SMOKE_TYPE is unset or "all" (→ handler uses
 * weight-based allocateByWeight internally, preserving default behaviour).
 *
 * Returns a Record<QuestionType, number> with non-requested types zeroed when
 * SMOKE_TYPE names one or more types.  Passing all five types to the handler's
 * typeCounts keeps freeTypes empty inside applyOverride, preventing residual
 * leaking into unwanted types.
 */
function resolveTypeCounts(
  smokeType: string | undefined,
  count: number,
): Record<QuestionType, number> | undefined {
  if (!smokeType || smokeType === "all") {
    return undefined;
  }

  const tokens = smokeType
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  // Validate each token against the canonical set.
  for (const t of tokens) {
    if (!(CANONICAL_TYPES as readonly string[]).includes(t)) {
      console.error(
        `[smoke] ERROR: invalid SMOKE_TYPE token "${t}". ` +
          `Valid types: ${CANONICAL_TYPES.join(", ")}`,
      );
      process.exit(1);
    }
  }

  // Deduplicate while preserving order.
  const requested = [...new Set(tokens)] as QuestionType[];

  // Each requested type must receive at least 1 question.
  if (count < requested.length) {
    console.error(
      `[smoke] ERROR: SMOKE_COUNT=${count} is less than the number of ` +
        `SMOKE_TYPE tokens (${requested.length}). ` +
        `Each type needs at least 1 question — increase SMOKE_COUNT or reduce SMOKE_TYPE.`,
    );
    process.exit(1);
  }

  // Distribute evenly; remainder is dropped (round-down semantics).
  const perType = Math.floor(count / requested.length);

  // Build a full Record so that all types appear in the override.
  // applyOverride treats absent keys as "free" and redistributes residual
  // to them — setting them to 0 explicitly prevents that.
  const typeCounts = Object.fromEntries(
    CANONICAL_TYPES.map((t) => [t, 0]),
  ) as Record<QuestionType, number>;
  for (const t of requested) {
    typeCounts[t] = perType;
  }

  return typeCounts;
}

// ---------------------------------------------------------------------------
// Fixed configuration
// ---------------------------------------------------------------------------

const TENANT_ID = "019d8000-0001-7f00-8000-000000000001";
const USER_ID = "26a8f5b1-979d-4188-a2dc-a0e8745a2a62";
const PACK_ID = "019df000-44f3-7c97-9403-f7bde6a36843";
const LEVEL_ID = process.env.SMOKE_LEVEL_ID ?? "019df008-b3e0-79b0-b409-624e2037fbe6";

const COUNT = parseInt(process.env.SMOKE_COUNT ?? "15", 10);
if (!Number.isFinite(COUNT) || COUNT <= 0) {
  console.error(
    `[smoke] ERROR: SMOKE_COUNT must be a positive integer (got: ${process.env.SMOKE_COUNT ?? "15"})`,
  );
  process.exit(1);
}

const TYPE_COUNTS = resolveTypeCounts(process.env.SMOKE_TYPE, COUNT);

/** Human-readable allocation descriptor for the smoke log header. */
const ALLOCATION_DESC = TYPE_COUNTS
  ? CANONICAL_TYPES.filter((t) => TYPE_COUNTS[t] > 0)
      .map((t) => `${t}:${TYPE_COUNTS[t]}`)
      .join(",") || "all-zero"
  : "weight-based";

async function main() {
  console.log(`[smoke] starting allocation=${ALLOCATION_DESC} level=${LEVEL_ID} count=${COUNT}`);
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
      typeCounts: TYPE_COUNTS,
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
