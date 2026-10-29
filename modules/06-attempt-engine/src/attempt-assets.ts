// EXP-10 part 1: the candidate image route. One indexed check, no JSON scan:
//   the attempt belongs to the session user and is in progress, AND the asset id is in the `asset_ids` column
//   of a question_versions row that this attempt froze (attempt_questions -> question_versions).
// Every miss is the same 404, so a caller cannot tell "no such image" from "not your image".
import { NotFoundError, isUuid } from "@assessiq/core";
import { withTenant } from "@assessiq/tenancy";

export interface AttemptAsset { mime: string; data: Buffer; sha256: string }

const notFound = (): NotFoundError => new NotFoundError("Image not found", { details: { code: "ASSET_NOT_FOUND" } });

export async function getAttemptAsset(tenantId: string, userId: string, attemptId: string, assetId: string): Promise<AttemptAsset> {
  if (!isUuid(attemptId) || !isUuid(assetId)) throw notFound();
  return withTenant(tenantId, async (client) => {
    const r = await client.query<AttemptAsset>(
      `SELECT qa.mime, qa.data, qa.sha256
         FROM attempts a
         JOIN attempt_questions aq ON aq.attempt_id = a.id
         JOIN question_versions qv ON qv.question_id = aq.question_id AND qv.version = aq.question_version
         JOIN question_assets qa ON qa.id = $3
        WHERE a.id = $1 AND a.user_id = $2 AND a.status = 'in_progress'
          AND $3::uuid = ANY(qv.asset_ids)
        LIMIT 1`,
      [attemptId, userId, assetId],
    );
    if (r.rows[0] === undefined) throw notFound();
    return r.rows[0];
  });
}
