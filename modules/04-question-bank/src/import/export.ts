// RW-59: QTI 3.0 export of one pack (super-admin route). Reads every non-archived question.
import { NotFoundError } from "@assessiq/core";
import { withTenant } from "@assessiq/tenancy";
import { auditInTx } from "@assessiq/audit-log";
import * as repo from "../repository.js";
import { QB_ERROR_CODES, type Question } from "../types.js";
import { buildQtiPackage } from "./adapters/qti.js";

const PAGE = 500;

export async function exportPackQti(
  tenantId: string,
  actorUserId: string,
  packId: string,
): Promise<{ file: Buffer; fileName: string }> {
  return withTenant(tenantId, async (client) => {
    const pack = await repo.findPackById(client, packId);
    if (pack === null) {
      throw new NotFoundError(`Question set not found: ${packId}`, { details: { code: QB_ERROR_CODES.PACK_NOT_FOUND } });
    }
    const all: Question[] = [];
    for (let page = 1; ; page++) {
      const { items, total } = await repo.listQuestionRows(client, { pack_id: packId, page, pageSize: PAGE });
      all.push(...items);
      if (all.length >= total || items.length === 0) break;
    }
    const questions = all.filter((q) => q.status !== "archived");
    const sources = new Map((await repo.listQuestionSourcesForPack(client, packId)).map((r) => [r.question_id, r]));
    const file = await buildQtiPackage({
      packName: pack.name,
      provenance: questions.map((q) => ({
        id: q.id, difficulty_est: q.difficulty_est, review_state: q.review_state,
        language_primary: q.language_primary, content_i18n: q.content_i18n, source: sources.get(q.id) ?? null,
      })),
      questions: questions.map((q) => ({ id: q.id, type: q.type, topic: q.topic, points: q.points, content: q.content })),
    });
    await auditInTx(client, {
      tenantId, actorKind: "user", actorUserId, action: "pack.exported",
      entityType: "question_pack", entityId: packId,
      after: { format: "qti3", question_count: questions.length },
    });
    return { file, fileName: `${pack.slug || pack.id}.qti3.zip`.replace(/[^A-Za-z0-9._-]/g, "_") };
  });
}
