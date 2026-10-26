// EXP-6: exam blueprints (platform data, migration 0201). Reads: any admin (RLS SELECT policy only).
// Writes: super admin only, run as assessiq_system and audited in the same transaction.
// A blueprint has no tenant_id: a tenant session can never write it (no write policy exists).
import type { FastifyInstance, preHandlerHookHandler } from "fastify";
import type { PoolClient } from "pg";
import { z } from "zod";
import { AuthzError, NotFoundError, ValidationError } from "@assessiq/core";
import { withTenant, withSystemRole } from "@assessiq/tenancy";
import { auditInTx } from "@assessiq/audit-log";
import { QUESTION_TYPES } from "@assessiq/question-types";

const SectionIn = z
  .object({
    name: z.string().trim().min(1).max(80),
    subject_node_id: z.string().uuid().nullable().default(null),
    question_count: z.number().int().min(1).max(500), // the real cap is the blueprint's max_questions (superRefine below)
    marks_per_question: z.number().min(0).max(1000),
    negative_marks_per_question: z.number().min(0).max(1000).default(0),
    minutes: z.number().int().min(1).max(300).nullable().default(null),
    sectional_timing: z.boolean().default(false),
    qualifying: z.boolean().default(false),
    cutoff_marks: z.number().min(0).max(1_000_000).nullable().default(null),
    calculator_allowed: z.boolean().default(false),
    allowed_types: z.array(z.enum(QUESTION_TYPES)).min(1).default(["mcq"]),
  })
  .strict();

export const BlueprintBodySchema = z
  .object({
    stage_node_id: z.string().uuid().nullable().default(null),
    edition: z.string().trim().min(1).max(40),
    name: z.string().trim().min(1).max(120),
    total_minutes: z.number().int().min(1).max(600),
    qualifying: z.boolean().default(false),
    verification_status: z.enum(["verified", "unverified"]),
    source_note: z.string().max(2000).nullable().default(null),
    /** CT-0: per-pattern question cap (default 100). Higher only where the official pattern needs it (NEET UG 180). */
    max_questions: z.number().int().min(1).max(500).default(100),
    /** CT-0 upkeep: who owns the monthly check. */
    owner_contact: z.string().trim().max(200).nullable().default(null),
    /** Optional cross-check: must equal the sum of the section question counts. */
    total_questions: z.number().int().min(1).optional(),
    sections: z.array(SectionIn).min(1).max(10), // 10 = module 05 sections limit
  })
  .strict()
  .superRefine((b, ctx) => {
    const bad = (message: string): void => ctx.addIssue({ code: z.ZodIssueCode.custom, message, path: ["sections"] });
    b.sections.forEach((s, i) => {
      if (s.negative_marks_per_question > s.marks_per_question) bad(`section ${i + 1}: negative marks exceed marks per question`);
      if (s.cutoff_marks !== null && !s.qualifying) bad(`section ${i + 1}: cutoff_marks needs qualifying`);
      if (s.cutoff_marks !== null && s.cutoff_marks > s.question_count * s.marks_per_question) bad(`section ${i + 1}: cutoff_marks exceed section marks`);
      if (s.sectional_timing && s.minutes === null) bad(`section ${i + 1}: sectional timing needs minutes`);
    });
    const timed = b.sections.filter((s) => s.sectional_timing).length;
    if (timed !== 0 && timed !== b.sections.length) bad("sectional_timing must be the same for every section");
    if (timed > 0 && b.sections.reduce((n, s) => n + (s.minutes ?? 0), 0) !== b.total_minutes) bad("section minutes must add up to total_minutes");
    const total = b.sections.reduce((n, s) => n + s.question_count, 0);
    if (total > b.max_questions) bad(`the sections add up to ${total} questions, above the cap of ${b.max_questions}`);
    if (b.total_questions !== undefined && b.total_questions !== total) bad(`total_questions ${b.total_questions} does not match the section sum ${total}`);
  });
export type BlueprintBody = z.infer<typeof BlueprintBodySchema>;

export interface ExamBlueprintSection {
  position: number;
  name: string;
  subject_node_id: string | null;
  question_count: number;
  marks_per_question: number;
  negative_marks_per_question: number;
  minutes: number | null;
  sectional_timing: boolean;
  qualifying: boolean;
  cutoff_marks: number | null;
  calculator_allowed: boolean;
  allowed_types: string[];
}
export interface ExamBlueprint {
  id: string;
  stage_node_id: string | null;
  edition: string;
  name: string;
  total_minutes: number;
  qualifying: boolean;
  verification_status: "verified" | "unverified";
  source_note: string | null;
  max_questions: number;
  owner_contact: string | null;
  archived_at: string | null;
  supersedes_id: string | null;
  last_checked_at: string | null;
  next_check_due: string;
  total_questions: number;
  total_marks: number;
  sections: ExamBlueprintSection[];
}

type HeadRow = Omit<ExamBlueprint, "total_questions" | "total_marks" | "sections">;
interface SectionRow extends Omit<ExamBlueprintSection, "marks_per_question" | "negative_marks_per_question" | "cutoff_marks"> {
  blueprint_id: string;
  marks_per_question: string;
  negative_marks_per_question: string;
  cutoff_marks: string | null;
}

const HEAD_COLS = `id, stage_node_id, edition, name, total_minutes, qualifying, verification_status, source_note,
  max_questions, owner_contact, archived_at, supersedes_id, last_checked_at, next_check_due::text AS next_check_due`;

/** A list hides archived patterns; a read by id still returns one (old assessments point at it). */
async function load(client: PoolClient, id: string | null): Promise<ExamBlueprint[]> {
  const heads = (await client.query<HeadRow>(
    `SELECT ${HEAD_COLS} FROM exam_blueprints WHERE ($1::uuid IS NULL AND archived_at IS NULL) OR id = $1 ORDER BY name, edition`, [id])).rows;
  if (heads.length === 0) return [];
  const secs = (await client.query<SectionRow>(
    `SELECT blueprint_id, position, name, subject_node_id, question_count, marks_per_question::text, negative_marks_per_question::text,
            minutes, sectional_timing, qualifying, cutoff_marks::text, calculator_allowed, allowed_types
       FROM exam_blueprint_sections WHERE blueprint_id = ANY($1::uuid[]) ORDER BY blueprint_id, position`,
    [heads.map((h) => h.id)])).rows;
  return heads.map((h) => {
    const sections = secs.filter((s) => s.blueprint_id === h.id).map(({ blueprint_id: _b, ...s }) => ({
      ...s,
      marks_per_question: Number(s.marks_per_question),
      negative_marks_per_question: Number(s.negative_marks_per_question),
      cutoff_marks: s.cutoff_marks === null ? null : Number(s.cutoff_marks),
    }));
    return {
      ...h,
      sections,
      total_questions: sections.reduce((n, s) => n + s.question_count, 0),
      total_marks: Math.round(sections.reduce((n, s) => n + s.question_count * s.marks_per_question, 0) * 1000) / 1000,
    };
  });
}

/** Public read: every blueprint with its sections (platform data, same for every tenant). */
export async function listExamBlueprints(tenantId: string): Promise<ExamBlueprint[]> {
  return withTenant(tenantId, (client) => load(client, null));
}

export async function getExamBlueprint(tenantId: string, id: string): Promise<ExamBlueprint> {
  const bp = (await withTenant(tenantId, (client) => load(client, id)))[0];
  if (bp === undefined) throw new NotFoundError("exam blueprint not found");
  return bp;
}

/** Stage and subject ids must be PLATFORM nodes (tenant_id NULL) of the right kind; FK checks alone bypass RLS. */
async function assertNodes(client: PoolClient, b: BlueprintBody): Promise<void> {
  const check = async (ids: string[], kind: string, what: string): Promise<void> => {
    if (ids.length === 0) return;
    const r = await client.query(
      `SELECT id FROM taxonomy_nodes WHERE id = ANY($1::uuid[]) AND tenant_id IS NULL AND kind = $2`, [ids, kind]);
    if (r.rows.length !== new Set(ids).size) {
      throw new ValidationError(`unknown ${what} node`, { details: { code: "INVALID_PARAM", param: what } });
    }
  };
  await check(b.stage_node_id === null ? [] : [b.stage_node_id], "stage", "stage_node_id");
  await check(b.sections.flatMap((s) => (s.subject_node_id === null ? [] : [s.subject_node_id])), "subject", "subject_node_id");
}

async function insertSections(client: PoolClient, id: string, b: BlueprintBody): Promise<void> {
  for (const [i, s] of b.sections.entries()) {
    await client.query(
      `INSERT INTO exam_blueprint_sections
         (blueprint_id, position, name, subject_node_id, question_count, marks_per_question, negative_marks_per_question,
          minutes, sectional_timing, qualifying, cutoff_marks, calculator_allowed, allowed_types)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [id, i + 1, s.name, s.subject_node_id, s.question_count, s.marks_per_question, s.negative_marks_per_question,
       s.minutes, s.sectional_timing, s.qualifying, s.cutoff_marks, s.calculator_allowed, s.allowed_types],
    );
  }
}

/** Run a write as the system role, then audit in assessiq_app under the caller's tenant (same transaction). */
async function write<T>(
  tenantId: string,
  reason: string,
  fn: (client: PoolClient) => Promise<{ result: T; audit: Parameters<typeof auditInTx>[1] }>,
): Promise<T> {
  return withSystemRole(reason, async (client) => {
    const { result, audit } = await fn(client);
    await client.query("SET LOCAL ROLE assessiq_app");
    await client.query("SELECT set_config('app.current_tenant', $1, true)", [tenantId]);
    await auditInTx(client, audit);
    return result;
  });
}

export async function createExamBlueprint(tenantId: string, userId: string, b: BlueprintBody): Promise<ExamBlueprint> {
  return write(tenantId, "exam blueprint create", async (client) => {
    await assertNodes(client, b);
    const dup = b.stage_node_id === null ? [] : (await client.query(
      `SELECT 1 FROM exam_blueprints WHERE stage_node_id = $1 AND edition = $2`, [b.stage_node_id, b.edition])).rows;
    if (dup.length > 0) throw new ValidationError("a blueprint for this stage and edition exists", { details: { code: "DUPLICATE" } });
    const id = (await client.query<{ id: string }>(
      `INSERT INTO exam_blueprints (stage_node_id, edition, name, total_minutes, qualifying, verification_status, source_note, max_questions, owner_contact)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [b.stage_node_id, b.edition, b.name, b.total_minutes, b.qualifying, b.verification_status, b.source_note, b.max_questions, b.owner_contact])).rows[0]!.id;
    await insertSections(client, id, b);
    const result = (await load(client, id))[0]!;
    return { result, audit: { tenantId, actorKind: "user", actorUserId: userId, action: "exam_blueprint.created", entityType: "exam_blueprint", entityId: id, after: { ...result } } };
  });
}

/**
 * CT-0: a VERIFIED edition is never edited. A change creates a new edition (new row, `supersedes_id` = the old one); the
 * old row and its sections stay, so assessments already made keep their copy and old results stay correct. The new
 * edition needs a new label. An unverified (draft) pattern is still replaced in place.
 */
export async function updateExamBlueprint(tenantId: string, userId: string, id: string, b: BlueprintBody): Promise<ExamBlueprint> {
  return write(tenantId, "exam blueprint update", async (client) => {
    const before = (await load(client, id))[0];
    if (before === undefined) throw new NotFoundError("exam blueprint not found");
    if (before.archived_at !== null) throw new ValidationError("an archived pattern cannot be changed", { details: { code: "ARCHIVED" } });
    await assertNodes(client, b);
    if (before.verification_status === "verified") {
      if (b.edition === before.edition) {
        throw new ValidationError("a verified edition is never edited: give the new edition a new label", { details: { code: "EDITION_IMMUTABLE" } });
      }
      const dup = b.stage_node_id === null ? [] : (await client.query(
        `SELECT 1 FROM exam_blueprints WHERE stage_node_id = $1 AND edition = $2`, [b.stage_node_id, b.edition])).rows;
      if (dup.length > 0) throw new ValidationError("a blueprint for this stage and edition exists", { details: { code: "DUPLICATE" } });
      const nid = (await client.query<{ id: string }>(
        `INSERT INTO exam_blueprints (stage_node_id, edition, name, total_minutes, qualifying, verification_status, source_note, max_questions, owner_contact, supersedes_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
        [b.stage_node_id, b.edition, b.name, b.total_minutes, b.qualifying, b.verification_status, b.source_note, b.max_questions, b.owner_contact, id])).rows[0]!.id;
      await insertSections(client, nid, b);
      const result = (await load(client, nid))[0]!;
      return { result, audit: { tenantId, actorKind: "user", actorUserId: userId, action: "exam_blueprint.created", entityType: "exam_blueprint", entityId: nid, before: { ...before }, after: { ...result } } };
    }
    if (b.stage_node_id !== null) {
      const dup = await client.query(
        `SELECT 1 FROM exam_blueprints WHERE stage_node_id = $1 AND edition = $2 AND id <> $3`, [b.stage_node_id, b.edition, id]);
      if (dup.rows.length > 0) throw new ValidationError("a blueprint for this stage and edition exists", { details: { code: "DUPLICATE" } });
    }
    await client.query(
      `UPDATE exam_blueprints SET stage_node_id=$2, edition=$3, name=$4, total_minutes=$5, qualifying=$6,
              verification_status=$7, source_note=$8, max_questions=$9, owner_contact=$10, updated_at=now() WHERE id=$1`,
      [id, b.stage_node_id, b.edition, b.name, b.total_minutes, b.qualifying, b.verification_status, b.source_note, b.max_questions, b.owner_contact]);
    await client.query(`DELETE FROM exam_blueprint_sections WHERE blueprint_id = $1`, [id]);
    await insertSections(client, id, b);
    const result = (await load(client, id))[0]!;
    return { result, audit: { tenantId, actorKind: "user", actorUserId: userId, action: "exam_blueprint.updated", entityType: "exam_blueprint", entityId: id, before: { ...before }, after: { ...result } } };
  });
}

/** CT-0: archive instead of delete. The row, its sections and every assessment that used it stay. */
export async function archiveExamBlueprint(tenantId: string, userId: string, id: string): Promise<{ archived: true }> {
  return write(tenantId, "exam blueprint archive", async (client) => {
    const before = (await load(client, id))[0];
    if (before === undefined) throw new NotFoundError("exam blueprint not found");
    await client.query(`UPDATE exam_blueprints SET archived_at = COALESCE(archived_at, now()), updated_at = now() WHERE id = $1`, [id]);
    return { result: { archived: true as const }, audit: { tenantId, actorKind: "user", actorUserId: userId, action: "exam_blueprint.archived", entityType: "exam_blueprint", entityId: id, before: { ...before } } };
  });
}

/** CT-0: "Mark checked, no change": the monthly check is done. Sets the dates; a note replaces the source note when given. */
export async function markExamBlueprintChecked(tenantId: string, userId: string, id: string, note: string | null): Promise<ExamBlueprint> {
  return write(tenantId, "exam blueprint checked", async (client) => {
    const before = (await load(client, id))[0];
    if (before === undefined) throw new NotFoundError("exam blueprint not found");
    if (before.archived_at !== null) throw new ValidationError("an archived pattern cannot be checked", { details: { code: "ARCHIVED" } });
    await client.query(
      `UPDATE exam_blueprints SET last_checked_at = now(), next_check_due = CURRENT_DATE + 30, upkeep_reminded_at = NULL,
              source_note = COALESCE($2, source_note), updated_at = now() WHERE id = $1`, [id, note]);
    const result = (await load(client, id))[0]!;
    return { result, audit: { tenantId, actorKind: "user", actorUserId: userId, action: "exam_blueprint.checked", entityType: "exam_blueprint", entityId: id, before: { ...before }, after: { ...result } } };
  });
}

const IdParams = z.object({ id: z.string().uuid() });
function parse<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, v: unknown, what: string): T {
  const r = schema.safeParse(v);
  if (!r.success) throw new ValidationError(`invalid ${what}`, { details: { code: "INVALID_PARAM", issues: r.error.issues } });
  return r.data;
}

export function registerExamBlueprintRoutes(
  app: FastifyInstance,
  preHandler: preHandlerHookHandler[] | preHandlerHookHandler,
  superPreHandler: preHandlerHookHandler[] | preHandlerHookHandler,
): void {
  // Defence in depth: the handler re-checks the role even if the chain is mis-wired.
  const requireSuper = (req: { session?: { role?: string } }): void => {
    if (req.session?.role !== "super_admin") throw new AuthzError("super_admin required");
  };

  app.get("/api/admin/blueprints", { preHandler }, async (req) => ({ items: await listExamBlueprints(req.session!.tenantId) }));

  app.get("/api/admin/blueprints/:id", { preHandler }, async (req) => {
    const { id } = parse(IdParams, req.params, "params");
    return getExamBlueprint(req.session!.tenantId, id);
  });

  app.post("/api/admin/blueprints", { preHandler: superPreHandler }, async (req, reply) => {
    requireSuper(req);
    const body = parse(BlueprintBodySchema, req.body, "body");
    return reply.code(201).send(await createExamBlueprint(req.session!.tenantId, req.session!.userId, body));
  });

  app.put("/api/admin/blueprints/:id", { preHandler: superPreHandler }, async (req) => {
    requireSuper(req);
    const { id } = parse(IdParams, req.params, "params");
    return updateExamBlueprint(req.session!.tenantId, req.session!.userId, id, parse(BlueprintBodySchema, req.body, "body"));
  });

  // CT-0: DELETE archives (the row and old assessments stay). There is no hard delete route.
  app.delete("/api/admin/blueprints/:id", { preHandler: superPreHandler }, async (req) => {
    requireSuper(req);
    const { id } = parse(IdParams, req.params, "params");
    return archiveExamBlueprint(req.session!.tenantId, req.session!.userId, id);
  });

  app.post("/api/admin/blueprints/:id/checked", { preHandler: superPreHandler }, async (req) => {
    requireSuper(req);
    const { id } = parse(IdParams, req.params, "params");
    const { note } = parse(z.object({ note: z.string().trim().min(1).max(2000).nullable().default(null) }).strict(), req.body ?? {}, "body");
    return markExamBlueprintChecked(req.session!.tenantId, req.session!.userId, id, note);
  });
}
