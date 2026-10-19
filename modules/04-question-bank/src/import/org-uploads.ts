// EXP-17: organisation upload list + withdraw of a whole import. Tenant-scoped (RLS); question ids come from
// question_source.import_id, which commit.ts writes for every committed question.
import { ConflictError, NotFoundError } from "@assessiq/core";
import { withTenant } from "@assessiq/tenancy";
import * as repo from "../repository.js";
import { withdrawInTx } from "../service/questions.js";

export interface OrgUploadItem {
  id: string;
  file_name: string;
  format: string;
  status: string;
  row_count: number;
  error_count: number;
  rights_status: string | null;
  created_at: string;
  committed_pack_id: string | null;
  question_count: number;
  withdrawn_count: number;
}

/** The caller tenant's own uploads (imports with an uploader rights_status), newest first. Discarded ones are hidden. */
export async function listOrgUploads(tenantId: string): Promise<{ items: OrgUploadItem[] }> {
  return withTenant(tenantId, async (client) => {
    const r = await client.query<OrgUploadItem>(
      `SELECT i.id, i.file_name, i.format, i.status, i.row_count, i.error_count,
              i.upload_rights_status AS rights_status, i.created_at, i.committed_pack_id,
              COUNT(s.id)::int AS question_count,
              COUNT(s.id) FILTER (WHERE s.rights_status = 'withdrawn')::int AS withdrawn_count
         FROM question_imports i
         LEFT JOIN question_source s ON s.import_id = i.id AND s.tenant_id = i.tenant_id
        WHERE i.upload_rights_status IS NOT NULL AND i.status <> 'discarded'
        GROUP BY i.id
        ORDER BY i.created_at DESC
        LIMIT 100`,
    );
    return { items: r.rows };
  });
}

/** Withdraws every question the import made, in one transaction. Idempotent: a second call changes nothing. Audit: withdrawInTx writes one question.withdrawn row per question (ids only); module 14 has no import-level withdraw action. */
export async function withdrawImport(
  tenantId: string,
  actorUserId: string,
  importId: string,
): Promise<{ importId: string; withdrawn: number }> {
  return withTenant(tenantId, async (client) => {
    const imp = (await client.query<{ status: string }>(
      `SELECT status FROM question_imports WHERE id = $1 AND upload_rights_status IS NOT NULL FOR UPDATE`, [importId],
    )).rows[0];
    if (imp === undefined) throw new NotFoundError("question import not found", { details: { code: "IMPORT_NOT_FOUND" } });
    if (imp.status !== "committed") {
      throw new ConflictError("only a committed import can be withdrawn", { details: { code: "IMPORT_NOT_COMMITTED" } });
    }
    const src = (await client.query<{ question_id: string; withdrawn: boolean }>(
      `SELECT question_id, rights_status = 'withdrawn' AS withdrawn FROM question_source WHERE import_id = $1 ORDER BY question_id`, [importId],
    )).rows;
    let withdrawn = 0;
    for (const s of src) {
      const q = await repo.findQuestionById(client, s.question_id);
      if (q === null) continue;
      await withdrawInTx(client, tenantId, actorUserId, q);
      if (!s.withdrawn) withdrawn++;
    }
    return { importId, withdrawn };
  });
}
