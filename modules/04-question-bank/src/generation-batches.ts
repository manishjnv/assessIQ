// E6: server-side durability for question-generation batches.
// Table: generation_batches (07-ai-grading migration 0142). The browser still
// orchestrates categories; this only stores the plan + progress per (tenant, user).
// Progress is also unioned in server-side by admin-generate.ts after each success.

import type { FastifyInstance, preHandlerHookHandler } from "fastify";
import { z } from "zod";
import { ConflictError, NotFoundError, ValidationError } from "@assessiq/core";
import { withTenant } from "@assessiq/tenancy";

const uuid = z.string().uuid();

const PlanBody = z.object({
  domainId: uuid.nullish(),
  level: z.string().max(10).nullish(),
  categories: z.array(z.record(z.unknown())).max(50),
  completedCategoryIds: z.array(uuid).max(50).default([]),
});
const StatusBody = z.object({ status: z.enum(["done", "dismissed"]) });

export type GenerationBatchPlanInput = z.infer<typeof PlanBody>;

export interface GenerationBatchRow {
  id: string;
  domainId: string | null;
  level: string | null;
  categories: unknown[];
  completedCategoryIds: string[];
  status: string;
  updatedAt: string;
}

const COLS = `id, domain_id AS "domainId", level, categories,
  completed_category_ids AS "completedCategoryIds", status, updated_at AS "updatedAt"`;

function parse<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, v: unknown, what: string): T {
  const r = schema.safeParse(v);
  if (!r.success) {
    throw new ValidationError(`invalid ${what}`, { details: { code: "INVALID_PARAM", issues: r.error.issues } });
  }
  return r.data;
}

export async function upsertGenerationBatch(
  tenantId: string,
  userId: string,
  id: string,
  plan: GenerationBatchPlanInput,
): Promise<GenerationBatchRow> {
  try {
    const row = await withTenant(tenantId, async (client) => {
      const res = await client.query<GenerationBatchRow>(
        `INSERT INTO generation_batches
           (id, tenant_id, user_id, domain_id, level, categories, completed_category_ids)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb)
         ON CONFLICT (id) DO UPDATE
           SET domain_id = EXCLUDED.domain_id,
               level = EXCLUDED.level,
               categories = EXCLUDED.categories,
               completed_category_ids = (
                 SELECT COALESCE(jsonb_agg(DISTINCT v), '[]'::jsonb)
                   FROM jsonb_array_elements_text(
                          generation_batches.completed_category_ids || EXCLUDED.completed_category_ids) v),
               updated_at = now()
           WHERE generation_batches.tenant_id = $2 AND generation_batches.user_id = $3
         RETURNING ${COLS}`,
        [
          id, tenantId, userId, plan.domainId ?? null, plan.level ?? null,
          JSON.stringify(plan.categories), JSON.stringify(plan.completedCategoryIds),
        ],
      );
      return res.rows[0];
    });
    if (row) return row;
  } catch (err) {
    // Foreign tenant's id -> unique violation / RLS rejection; never reveal which.
    const code = (err as { code?: string }).code;
    if (code !== "23505" && code !== "42501") throw err;
  }
  throw new ConflictError("generation batch id belongs to another user");
}

export async function getActiveGenerationBatch(
  tenantId: string,
  userId: string,
): Promise<GenerationBatchRow | null> {
  return withTenant(tenantId, async (client) => {
    const res = await client.query<GenerationBatchRow>(
      `SELECT ${COLS} FROM generation_batches
        WHERE tenant_id = $1 AND user_id = $2 AND status = 'active'
        ORDER BY updated_at DESC LIMIT 1`,
      [tenantId, userId],
    );
    return res.rows[0] ?? null;
  });
}

export async function setGenerationBatchStatus(
  tenantId: string,
  userId: string,
  id: string,
  status: "done" | "dismissed",
): Promise<void> {
  const n = await withTenant(tenantId, async (client) =>
    (await client.query(
      `UPDATE generation_batches SET status = $4, updated_at = now()
        WHERE id = $1 AND tenant_id = $2 AND user_id = $3`,
      [id, tenantId, userId, status],
    )).rowCount,
  );
  if (!n) throw new NotFoundError("generation batch not found");
}

export function registerGenerationBatchRoutes(
  app: FastifyInstance,
  preHandler: preHandlerHookHandler[] | preHandlerHookHandler,
): void {
  app.get("/api/admin/generation-batches/active", { preHandler }, async (req) => ({
    batch: await getActiveGenerationBatch(req.session!.tenantId, req.session!.userId),
  }));

  app.put("/api/admin/generation-batches/:id", { preHandler }, async (req) => {
    const id = parse(uuid, (req.params as { id: string }).id, "id");
    const plan = parse(PlanBody, req.body, "body");
    return { batch: await upsertGenerationBatch(req.session!.tenantId, req.session!.userId, id, plan) };
  });

  app.patch("/api/admin/generation-batches/:id", { preHandler }, async (req) => {
    const id = parse(uuid, (req.params as { id: string }).id, "id");
    const { status } = parse(StatusBody, req.body, "body");
    await setGenerationBatchStatus(req.session!.tenantId, req.session!.userId, id, status);
    return { ok: true };
  });
}
