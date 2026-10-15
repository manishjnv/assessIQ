// RW-57: curriculum framework seed contract. Bundled JSON seeds (src/frameworks/<code>.json)
// are validated and upserted as NULL-tenant (platform) framework + taxonomy_nodes rows.
// Shape documented in schemas/framework-seed.schema.json (Zod below is the runtime validator;
// no JSON-schema library is installed). Idempotency key: framework slug + (parent, node code).
// frameworks has no JSONB column: board / sourceUrls / node description are validated but not stored;
// version is stored in taxonomy_nodes.syllabus_edition.
import { NotFoundError, ValidationError } from "@assessiq/core";
import { withSystemRole } from "@assessiq/tenancy";
import { auditInTx } from "@assessiq/audit-log";
import { z } from "zod";
import type { PoolClient } from "pg";
import { findNodeId } from "./taxonomy-nodes.js";
import sampleSeed from "./frameworks/sample.json" with { type: "json" };
import cbseSeed from "./frameworks/cbse.json" with { type: "json" };
import icseSeed from "./frameworks/icse.json" with { type: "json" };
import ibSeed from "./frameworks/ib.json" with { type: "json" };

const Code = z.string().regex(/^[a-z0-9-]{1,64}$/);
const KINDS = ["board", "stage", "grade", "subject", "unit", "outcome", "criterion"] as const;

export interface SeedNode {
  code: string;
  title: string;
  kind: (typeof KINDS)[number];
  description?: string | undefined;
  externalId?: string | undefined;
  children?: SeedNode[] | undefined;
}

function noDuplicateCodes(items: { code: string }[], path: (string | number)[], ctx: z.RefinementCtx): void {
  const seen = new Set<string>();
  items.forEach((c, i) => {
    if (seen.has(c.code)) ctx.addIssue({ code: "custom", path: [...path, i, "code"], message: "duplicate sibling code" });
    seen.add(c.code);
  });
}

const NodeSchema: z.ZodType<SeedNode> = z.lazy(() =>
  z
    .object({
      code: Code,
      title: z.string().min(1).max(300),
      kind: z.enum(KINDS),
      description: z.string().max(2000).optional(),
      externalId: z.string().max(128).optional(),
      children: z.array(NodeSchema).optional(),
    })
    .strict()
    .superRefine((n, ctx) => noDuplicateCodes(n.children ?? [], ["children"], ctx)),
);

const SeedSchema = z
  .object({
    code: Code,
    name: z.string().min(1).max(200),
    board: z.string().min(1).max(64),
    version: z.string().min(1).max(64),
    sourceUrls: z.array(z.string().url()).optional(),
    nodes: z.array(NodeSchema).min(1),
  })
  .strict()
  .superRefine((s, ctx) => noDuplicateCodes(s.nodes, ["nodes"], ctx));

export type FrameworkSeed = z.infer<typeof SeedSchema>;

// Add new bundled seeds here (one static import each, so they ship in the API image).
const BUNDLED: Record<string, unknown> = { sample: sampleSeed, cbse: cbseSeed, icse: icseSeed, ib: ibSeed };

/** Validate; throws ValidationError naming the schema path of the FIRST error (e.g. nodes.0.children.1.kind). */
export function validateFrameworkSeed(raw: unknown): FrameworkSeed {
  const r = SeedSchema.safeParse(raw);
  if (!r.success) {
    const i = r.error.issues[0]!;
    const path = i.path.join(".") || "(root)";
    throw new ValidationError(`invalid framework seed at ${path}: ${i.message}`, {
      details: { code: "INVALID_FRAMEWORK_SEED", path, issues: r.error.issues },
    });
  }
  return r.data;
}

function countNodes(nodes: SeedNode[]): number {
  return nodes.reduce((n, c) => n + 1 + countNodes(c.children ?? []), 0);
}

export interface BundledSeedInfo {
  code: string;
  name: string;
  board: string;
  version: string;
  nodeCount: number;
  loadedVersion: string | null; // null = framework not in the DB yet
}

export async function listBundledSeeds(): Promise<BundledSeedInfo[]> {
  const seeds = Object.values(BUNDLED).map((raw) => validateFrameworkSeed(raw));
  const loaded = await withSystemRole("framework seeds: list loaded versions", async (client) =>
    (await client.query<{ slug: string; v: string | null }>(
      `SELECT f.slug, (SELECT max(n.syllabus_edition) FROM taxonomy_nodes n WHERE n.framework_id = f.id) AS v
         FROM frameworks f WHERE f.tenant_id IS NULL AND f.slug = ANY($1::text[])`,
      [seeds.map((s) => s.code)],
    )).rows,
  );
  const byCode = new Map(loaded.map((r) => [r.slug, r.v]));
  return seeds
    .map((s) => ({
      code: s.code,
      name: s.name,
      board: s.board,
      version: s.version,
      nodeCount: countNodes(s.nodes),
      loadedVersion: byCode.has(s.code) ? (byCode.get(s.code) ?? "") : null,
    }))
    .sort((a, b) => a.code.localeCompare(b.code));
}

export interface SeedLoadCounts {
  frameworks: number;
  nodesCreated: number;
  nodesUpdated: number;
  nodesUnchanged: number;
}

async function upsertNodes(
  client: PoolClient,
  fwId: string,
  parentId: string | null,
  nodes: SeedNode[],
  version: string,
  counts: SeedLoadCounts,
): Promise<void> {
  for (const [position, n] of nodes.entries()) {
    const ext = n.externalId ?? null;
    const existing = await findNodeId(client, fwId, null, parentId, n.code);
    let id: string;
    if (existing === null) {
      id = (await client.query<{ id: string }>(
        `INSERT INTO taxonomy_nodes (tenant_id, framework_id, parent_id, kind, code, label, position, syllabus_edition, external_id)
         VALUES (NULL, $1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [fwId, parentId, n.kind, n.code, n.title, position, version, ext],
      )).rows[0]!.id;
      counts.nodesCreated++;
    } else {
      id = existing;
      const u = await client.query(
        `UPDATE taxonomy_nodes
            SET kind = $2, label = $3, position = $4, syllabus_edition = $5, external_id = $6, status = 'active', updated_at = now()
          WHERE id = $1
            AND (kind, label, position, syllabus_edition, external_id, status)
                IS DISTINCT FROM ($2::text, $3::text, $4::int, $5::text, $6::text, 'active'::text)`,
        [id, n.kind, n.title, position, version, ext],
      );
      if (u.rowCount) counts.nodesUpdated++;
      else counts.nodesUnchanged++;
    }
    await upsertNodes(client, fwId, id, n.children ?? [], version, counts);
  }
}

/** Validate then upsert an already-parsed seed. An invalid seed throws before any write. */
export async function loadFrameworkSeedData(actorUserId: string, raw: unknown): Promise<SeedLoadCounts> {
  const seed = validateFrameworkSeed(raw);
  return withSystemRole("framework seed load", async (client) => {
    const platform = (await client.query<{ id: string }>(`SELECT id FROM tenants WHERE slug = 'platform' LIMIT 1`)).rows[0];
    if (!platform) throw new NotFoundError("platform organisation not found");
    await client.query(
      `INSERT INTO frameworks (tenant_id, slug, name, source, status) VALUES (NULL, $1, $2, 'platform', 'active')
       ON CONFLICT (tenant_id, slug) DO UPDATE SET name = EXCLUDED.name, updated_at = now()
         WHERE frameworks.name IS DISTINCT FROM EXCLUDED.name`,
      [seed.code, seed.name],
    );
    const fwId = (await client.query<{ id: string }>(
      `SELECT id FROM frameworks WHERE tenant_id IS NULL AND slug = $1`, [seed.code])).rows[0]!.id;
    const counts: SeedLoadCounts = { frameworks: 1, nodesCreated: 0, nodesUpdated: 0, nodesUnchanged: 0 };
    await upsertNodes(client, fwId, null, seed.nodes, seed.version, counts);
    // Audit in assessiq_app + tenant GUC, same tx (as platform-domains.ts).
    await client.query("SET LOCAL ROLE assessiq_app");
    await client.query("SELECT set_config('app.current_tenant', $1, true)", [platform.id]);
    await auditInTx(client, {
      action: "framework.seed_loaded",
      actorKind: "user",
      actorUserId,
      tenantId: platform.id,
      entityType: "framework",
      entityId: fwId,
      after: { code: seed.code, version: seed.version, ...counts },
    });
    return counts;
  });
}

export async function loadFrameworkSeed(actorUserId: string, code: string): Promise<SeedLoadCounts> {
  const raw = BUNDLED[code];
  if (raw === undefined) throw new NotFoundError(`no bundled framework seed '${code}'`);
  return loadFrameworkSeedData(actorUserId, raw);
}
