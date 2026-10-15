// RW-58: commit a staged import -> one draft pack (source = 'import') holding the ok rows.
import { ConflictError, NotFoundError, ValidationError, uuidv7 } from "@assessiq/core";
import { withTenant } from "@assessiq/tenancy";
import { auditInTx } from "@assessiq/audit-log";
import * as repo from "../repository.js";
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
    const imp = (await client.query<{ status: string; domain: string; pack_name: string; file_sha256: string }>(
      `SELECT status, domain, pack_name, file_sha256 FROM question_imports WHERE id = $1 FOR UPDATE`, [importId],
    )).rows[0];
    if (imp === undefined) throw new NotFoundError("question import not found", { details: { code: "IMPORT_NOT_FOUND" } });
    if (imp.status !== "staged") {
      throw new ConflictError(`import is already ${imp.status}`, { details: { code: "IMPORT_NOT_STAGED" } });
    }
    const ok = (await client.query<{ normalized: NormalizedRow }>(
      `SELECT normalized FROM question_import_rows WHERE import_id = $1 AND decision = 'ok' ORDER BY row_number`, [importId],
    )).rows.map((r) => r.normalized);
    if (ok.length === 0) {
      throw new ValidationError("import has no valid rows to commit", { details: { code: "IMPORT_NO_OK_ROWS" } });
    }

    const packId = uuidv7();
    const slug = `${generateSlugFromName(imp.pack_name) || "import"}-${importId.slice(-8)}`;
    await repo.insertPack(client, {
      id: packId, tenantId, slug, name: imp.pack_name, domain: imp.domain, createdBy: actorUserId,
    });
    await client.query(
      `UPDATE question_packs SET source = 'import', import_file_sha256 = $2 WHERE id = $1`, [packId, imp.file_sha256],
    );

    const counts = new Map<number, number>();
    for (const q of ok) counts.set(q.level, (counts.get(q.level) ?? 0) + 1);
    const levelIds = new Map<number, string>();
    for (const [position, n] of [...counts].sort((a, b) => a[0] - b[0])) {
      const id = uuidv7();
      await repo.insertLevel(client, {
        id, packId, position, label: `L${position}`, durationMinutes: Math.max(10, n * 2), defaultQuestionCount: n,
      });
      levelIds.set(position, id);
    }
    for (const q of ok) {
      await repo.insertQuestion(client, {
        id: uuidv7(), packId, levelId: levelIds.get(q.level)!, type: q.type as QuestionType,
        topic: q.topic, points: q.points, content: q.content, createdBy: actorUserId,
      });
    }

    await client.query(
      `UPDATE question_imports SET status = 'committed', committed_pack_id = $2, updated_at = now() WHERE id = $1`,
      [importId, packId],
    );
    await auditInTx(client, {
      tenantId, actorKind: "user", actorUserId, action: "question_import.committed",
      entityType: "question_import", entityId: importId,
      after: { pack_id: packId, committed: ok.length, mode: "skip-errors" },
    });
    return { importId, packId, committed: ok.length };
  });
}
