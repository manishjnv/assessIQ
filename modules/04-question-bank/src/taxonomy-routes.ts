// RW-55: read-only curriculum framework routes. Runs inside withTenant, so RLS
// returns NULL-tenant (platform) rows plus the caller's own rows. Writes: RW-61.
import type { FastifyInstance, preHandlerHookHandler } from "fastify";
import { z } from "zod";
import { ValidationError } from "@assessiq/core";
import { withTenant } from "@assessiq/tenancy";

const FrameworksQuery = z.object({ status: z.enum(["active", "all"]).default("active") });
const IdParams = z.object({ id: z.string().uuid() });
const NodesQuery = z.object({
  kind: z.enum(["board", "stage", "grade", "subject", "unit", "outcome", "criterion"]).optional(),
});

function parse<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, v: unknown, what: string): T {
  const r = schema.safeParse(v);
  if (!r.success) {
    throw new ValidationError(`invalid ${what}`, { details: { code: "INVALID_PARAM", issues: r.error.issues } });
  }
  return r.data;
}

export function registerTaxonomyRoutes(
  app: FastifyInstance,
  preHandler: preHandlerHookHandler[] | preHandlerHookHandler,
): void {
  app.get("/api/admin/frameworks", { preHandler }, async (req) => {
    const { status } = parse(FrameworksQuery, req.query, "query");
    const items = await withTenant(req.session!.tenantId, async (client) =>
      (await client.query(
        `SELECT id, slug, name, source, status, tenant_id FROM frameworks
          WHERE ($1::text = 'all' OR status = 'active')
          ORDER BY name, slug`,
        [status],
      )).rows,
    );
    return { items };
  });

  app.get("/api/admin/frameworks/:id/nodes", { preHandler }, async (req) => {
    const { id } = parse(IdParams, req.params, "params");
    const { kind } = parse(NodesQuery, req.query, "query");
    const items = await withTenant(req.session!.tenantId, async (client) =>
      (await client.query(
        `SELECT id, parent_id, kind, code, label, position, syllabus_edition, external_id, status, tenant_id
           FROM taxonomy_nodes
          WHERE framework_id = $1 AND ($2::text IS NULL OR kind = $2)
          ORDER BY parent_id NULLS FIRST, position, label`,
        [id, kind ?? null],
      )).rows,
    );
    return { items };
  });
}
