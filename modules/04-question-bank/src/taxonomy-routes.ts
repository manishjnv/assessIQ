// RW-55: read-only curriculum framework routes. Runs inside withTenant, so RLS
// returns NULL-tenant (platform) rows plus the caller's own rows. Writes: RW-61.
import type { FastifyInstance, preHandlerHookHandler } from "fastify";
import { z } from "zod";
import { AuthzError, NotFoundError, ValidationError } from "@assessiq/core";
import { withTenant } from "@assessiq/tenancy";
import { auditInTx } from "@assessiq/audit-log";
import { listBundledSeeds, loadFrameworkSeed } from "./framework-seeds.js";

const FrameworksQuery = z.object({ status: z.enum(["active", "all"]).default("active") });
const SeedCodeParams = z.object({ code: z.string().regex(/^[a-z0-9-]+$/) });
const IdParams =z.object({ id: z.string().uuid() });
const TaxonomyBody = z.object({ node_ids: z.array(z.string().uuid()).max(50) });
const PackTaxonomyQuery = z.object({ node_id: z.string().uuid().optional() });
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
  // RW-57: the super-admin seed routes get the real super chain from routes.ts; defaults to preHandler for callers that pass one.
  superPreHandler: preHandlerHookHandler[] | preHandlerHookHandler = preHandler,
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

  // RW-57: framework seeds. The registrar receives only adminOnly, so super_admin is
  // enforced here (defence in depth even once routes.ts passes superAdminOnly).
  const requireSuper = (req: { session?: { role?: string } }): void => {
    if (req.session?.role !== "super_admin") throw new AuthzError("super_admin required");
  };

  app.get("/api/admin/super/frameworks/seeds", { preHandler: superPreHandler }, async (req) => {
    requireSuper(req);
    return { items: await listBundledSeeds() };
  });

  app.post("/api/admin/super/frameworks/seeds/:code/load", { preHandler: superPreHandler }, async (req) => {
    requireSuper(req);
    const { code } = parse(SeedCodeParams, req.params, "params");
    return loadFrameworkSeed(req.session!.userId, code);
  });

  // RW-61: question <-> node links. Reads: any admin. Writes: super admin (question authoring is platform-only).
  app.get("/api/admin/questions/:id/taxonomy", { preHandler }, async (req) => {
    const { id } = parse(IdParams, req.params, "params");
    return withTenant(req.session!.tenantId, async (client) => {
      const q = await client.query(`SELECT 1 FROM questions WHERE id = $1`, [id]);
      if (q.rows.length === 0) throw new NotFoundError("question not found");
      const nodes = (await client.query(
        `SELECT n.id, n.parent_id, n.kind, n.code, n.label
           FROM question_taxonomy qt JOIN taxonomy_nodes n ON n.id = qt.node_id
          WHERE qt.question_id = $1 ORDER BY n.label`,
        [id],
      )).rows as { id: string }[];
      return { node_ids: nodes.map((n) => n.id), nodes };
    });
  });

  app.put("/api/admin/questions/:id/taxonomy", { preHandler: superPreHandler }, async (req) => {
    requireSuper(req);
    const { id } = parse(IdParams, req.params, "params");
    const { node_ids } = parse(TaxonomyBody, req.body, "body");
    const ids = [...new Set(node_ids)];
    const { tenantId, userId } = req.session!;
    return withTenant(tenantId, async (client) => {
      const q = await client.query(`SELECT 1 FROM questions WHERE id = $1`, [id]);
      if (q.rows.length === 0) throw new NotFoundError("question not found");
      // FK checks bypass RLS, so confirm every node is visible to this tenant first.
      const vis = await client.query(`SELECT id FROM taxonomy_nodes WHERE id = ANY($1::uuid[])`, [ids]);
      if (vis.rows.length !== ids.length) {
        throw new ValidationError("unknown framework node", { details: { code: "INVALID_PARAM", param: "node_ids" } });
      }
      const before = (await client.query(`SELECT node_id FROM question_taxonomy WHERE question_id = $1`, [id])).rows.map((r: { node_id: string }) => r.node_id);
      await client.query(`DELETE FROM question_taxonomy WHERE question_id = $1`, [id]);
      if (ids.length > 0) {
        await client.query(
          `INSERT INTO question_taxonomy (question_id, node_id) SELECT $1, UNNEST($2::uuid[])`,
          [id, ids],
        );
      }
      await auditInTx(client, {
        tenantId,
        actorKind: "user",
        actorUserId: userId,
        // ponytail: AuditAction (14-audit-log/types.ts) has no "question.taxonomy.updated"; reuse
        // "question.updated" with kind "taxonomy" (same pattern as kind "save_rubric") until it is added.
        action: "question.updated",
        entityType: "question",
        entityId: id,
        before: { kind: "taxonomy", node_ids: before },
        after: { kind: "taxonomy", node_ids: ids },
      });
      return { node_ids: ids };
    });
  });

  // RW-61: question <-> node links of one question set, for the read-only filter.
  // With ?node_id= only links under that node or any descendant are returned.
  app.get("/api/admin/packs/:id/taxonomy", { preHandler }, async (req) => {
    const { id } = parse(IdParams, req.params, "params");
    const { node_id } = parse(PackTaxonomyQuery, req.query, "query");
    const items = await withTenant(req.session!.tenantId, async (client) =>
      (await client.query(
        `WITH RECURSIVE sub AS (
           SELECT id FROM taxonomy_nodes WHERE id = $2::uuid
           UNION
           SELECT c.id FROM taxonomy_nodes c JOIN sub ON c.parent_id = sub.id
         )
         SELECT qt.question_id, qt.node_id
           FROM question_taxonomy qt JOIN questions q ON q.id = qt.question_id
          WHERE q.pack_id = $1 AND ($2::uuid IS NULL OR qt.node_id IN (SELECT id FROM sub))`,
        [id, node_id ?? null],
      )).rows,
    );
    return { items };
  });
}
