/**
 * RW-93: detached variant of generateQuestions for POST /api/admin/generate/start.
 *
 * The admin click starts exactly one run; the HTTP request returns at once and the
 * UI polls GET /api/admin/generation-attempts/:id. Same single-flight lock, same
 * attempt row as the sync route: the id is minted here and handed to
 * handleAdminGenerate, which inserts the row with it.
 */

import { uuidv7 } from "@assessiq/core";
import { withTenant } from "@assessiq/tenancy";
import { generateQuestions } from "./generation.js";
import { log } from "./_shared.js";

type Args = Parameters<typeof generateQuestions>;

export interface DetachedArgs {
  tenantId: string;
  userId: string;
  packId: string;
  levelId: string;
  count: number;
  typeCounts?: Partial<Record<string, number>> | undefined;
  domainId?: string | undefined;
  categoryId?: string | undefined;
  batchId?: string | undefined;
  topicFocus?: string | undefined;
}

export interface DetachedDeps {
  run: (...a: Args) => ReturnType<typeof generateQuestions>;
  markFailed: (tenantId: string, id: string, code: string, msg: string) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
}

const defaultDeps: DetachedDeps = {
  run: generateQuestions,
  markFailed: (tenantId, id, code, msg) =>
    withTenant(tenantId, async (c) => {
      // Only touches rows the handler left running; the handler's own finalize wins otherwise.
      await c.query(
        `UPDATE generation_attempts
            SET status = 'failed', error_code = $2, error_message = $3, finished_at = now()
          WHERE id = $1 AND status = 'running'`,
        [id, code, msg.slice(0, 1024)],
      );
    }),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

/**
 * Start a generation run without awaiting it. Resolves with the attempt id.
 * ponytail: only an error thrown within 300 ms (409 lock held, 503, 501, guards) reaches
 * the start request; a later error lands in the attempt row (status failed) for the poller.
 */
export async function startGenerateDetached(
  a: DetachedArgs,
  deps: DetachedDeps = defaultDeps,
): Promise<{ attemptId: string }> {
  const attemptId = uuidv7();
  let early: { err: unknown } | null = null;
  log.info({ attemptId, packId: a.packId, levelId: a.levelId, count: a.count }, "generation.detached.start");
  // Detached on purpose; the rejection handler keeps an error from becoming an unhandled rejection.
  void deps
    .run(a.tenantId, a.userId, a.packId, a.levelId, a.count, a.topicFocus, a.typeCounts, a.domainId, a.categoryId, a.batchId, attemptId)
    .then(
      (out) => log.info({ attemptId, generated: out.generated }, "generation.detached.end"),
      async (err: unknown) => {
        early = { err };
        const e = err as { code?: string; message?: string };
        log.error({ attemptId, code: e.code, err: e.message }, "generation.detached.failed");
        await deps
          .markFailed(a.tenantId, attemptId, e.code ?? "GENERATION_FAILED", e.message ?? "generation failed")
          .catch(() => undefined);
      },
    );

  await deps.sleep(300);
  if (early !== null) throw (early as { err: unknown }).err;
  return { attemptId };
}
