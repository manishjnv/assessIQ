// RW-58: commit a staged import -> one draft pack (source = 'import') holding the ok rows.
import { ConflictError, NotFoundError, ValidationError, uuidv7 } from "@assessiq/core";
import { withTenant } from "@assessiq/tenancy";
import { auditInTx } from "@assessiq/audit-log";
import * as repo from "../repository.js";
import { assertAppendTarget } from "./staging.js";
import { generateSlugFromName } from "../service/_shared.js";
import type { CommitResult, NormalizedRow } from "./types.js";
import type { QuestionType } from "@assessiq/question-types";

export async function commitImport(
  tenantId: string,
  actorUserId: string,
  importId: string,
  _opts: { mode: "skip-errors" },
): Promise<CommitResult> {
  return withTenant(tenantId, async (client) => {
    const imp = (await client.query<{ status: string; domain: string; pack_name: string; file_sha256: string; target_pack_id: string | null; target_level_position: number | null }>(
      `SELECT status, domain, pack_name, file_sha256, target_pack_id, target_level_position FROM question_imports WHERE id = $1 FOR UPDATE`, [importId],
    )).rows[0];
    if (imp === undefined) throw new NotFoundError("question import not found", { details: { code: "IMPORT_NOT_FOUND" } });
    if (imp.status !== "staged") {
      throw new ConflictError(`import is already ${imp.status}`, { details: { code: "IMPORT_NOT_STAGED" } });
    }
    const okRows = (await client.query<{ normalized: NormalizedRow; content_hash: string | null }>(
      `SELECT normalized, content_hash FROM question_import_rows WHERE import_id = $1 AND decision = 'ok' ORDER BY row_number`, [importId],
    )).rows;
    const ok = okRows.map((r) => r.normalized);
    if (ok.length === 0) {
      throw new ValidationError("import has no valid rows to commit", { details: { code: "IMPORT_NO_OK_ROWS" } });
    }

    // EXP-23: append to an existing pack (re-checked here: it may have been archived since staging).
    // The pack version is not bumped: a manual question add does not bump it either; publishPack does.
    let packId: string;
    const levelIds = new Map<number, string>();
    if (imp.target_pack_id !== null) {
      packId = imp.target_pack_id;
      await assertAppendTarget(client, tenantId, packId, imp.domain);
      for (const l of await repo.listLevelsByPack(client, packId)) levelIds.set(l.position, l.id);
      if (imp.target_level_position !== null && !levelIds.has(imp.target_level_position)) {
        throw new ValidationError("target level does not exist in the question set", { details: { code: "IMPORT_TARGET_LEVEL_NOT_FOUND" } });
      }
      if (imp.target_level_position === null && levelIds.size === 0) {
        throw new ValidationError("target question set has no level", { details: { code: "IMPORT_TARGET_LEVEL_NOT_FOUND" } });
      }
    } else {
      packId = uuidv7();
      const slug = `${generateSlugFromName(imp.pack_name) || "import"}-${importId.slice(-8)}`;
      await repo.insertPack(client, {
        id: packId, tenantId, slug, name: imp.pack_name, domain: imp.domain, createdBy: actorUserId,
      });
      await client.query(
        `UPDATE question_packs SET source = 'import', import_file_sha256 = $2 WHERE id = $1`, [packId, imp.file_sha256],
      );
    }
    const levelFor = (q: NormalizedRow): string =>
      levelIds.get(imp.target_level_position ?? q.level) ?? levelIds.get([...levelIds.keys()].sort((a, b) => a - b)[0]!)!;

    if (imp.target_pack_id === null) {
      const counts = new Map<number, number>();
      for (const q of ok) counts.set(q.level, (counts.get(q.level) ?? 0) + 1);
      for (const [position, n] of [...counts].sort((a, b) => a[0] - b[0])) {
        const id = uuidv7();
        await repo.insertLevel(client, {
          id, packId, position, label: `L${position}`, durationMinutes: Math.max(10, n * 2), defaultQuestionCount: n,
        });
        levelIds.set(position, id);
      }
    }
    const passageIds = new Map<string, string>(); // EXP-8: passage_ref -> passages.id (one per ref per file)
    const passageCount = new Map<string, number>();
    for (const [i, q] of ok.entries()) {
      const id = uuidv7();
      // Rows staged before v2 have no meta: they commit as human originals, as every import did before.
      const m = q.meta;
      await repo.insertQuestion(client, {
        id, packId, levelId: levelFor(q), type: q.type as QuestionType,
        topic: q.topic, points: q.points, negativeMarks: q.negative_marks, content: q.content, createdBy: actorUserId,
        reviewState: "in_review", // EXP-18: every import starts unverified
        ...(m ? {
          origin: m.origin, rightsStatus: m.rightsStatus, difficultyEst: m.difficultyEst, languagePrimary: m.language,
          sourceExtra: {
            sourceRef: m.sourceRef, sourceUrl: m.sourceUrl, seedRef: m.seedRef, importId, uploadedBy: actorUserId,
            sourceDifficultyRaw: m.sourceDifficultyRaw, contentHash: okRows[i]!.content_hash,
            normalisedTextHash: m.normalisedHash, pyqYear: m.pyqYear, pyqShift: m.pyqShift,
          },
        } : {}),
      });
      const ref = m?.passageRef ?? null;
      if (ref !== null && m?.passageText) {
        let pid = passageIds.get(ref);
        if (pid === undefined) {
          pid = uuidv7();
          await client.query(`INSERT INTO passages (id, tenant_id, body, language) VALUES ($1, $2, $3, $4)`, [pid, tenantId, m.passageText, m.language]);
          passageIds.set(ref, pid);
        }
        const pos = (passageCount.get(ref) ?? 0) + 1;
        passageCount.set(ref, pos);
        await client.query(`UPDATE questions SET passage_id = $2, passage_position = $3 WHERE id = $1`, [id, pid, pos]);
      }
      const nodeIds = [m?.stageNodeId, m?.subjectNodeId].filter((n): n is string => typeof n === "string");
      if (nodeIds.length > 0) {
        await client.query(
          `INSERT INTO question_taxonomy (question_id, node_id) SELECT $1, UNNEST($2::uuid[]) ON CONFLICT DO NOTHING`,
          [id, nodeIds],
        );
      }
    }

    await client.query(
      `UPDATE question_imports SET status = 'committed', committed_pack_id = $2, updated_at = now() WHERE id = $1`,
      [importId, packId],
    );
    await auditInTx(client, {
      tenantId, actorKind: "user", actorUserId, action: "question_import.committed",
      entityType: "question_import", entityId: importId,
      after: { pack_id: packId, committed: ok.length, mode: "skip-errors", ...(imp.target_pack_id !== null ? { appended: true } : {}) },
    });
    return { importId, packId, committed: ok.length };
  }).catch((err: unknown) => {
    // EXP-22: a concurrent import won the same template_generated seed_ref (partial unique index, 0246).
    if ((err as { code?: string }).code === "23505" && (err as { constraint?: string }).constraint === "question_source_template_seed_uniq") {
      throw new ConflictError("a template_generated seed_ref in this import already exists", { details: { code: "IMPORT_SEED_REF_DUPLICATE" } });
    }
    throw err;
  });
}
