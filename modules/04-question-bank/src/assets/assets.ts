// EXP-10 part 1: question image service (table question_assets, migration 0284).
//   - uploadQuestionAsset: clean the bytes, check alt text and the caps, insert (or return the same image of the pack).
//   - getAssetMeta / getAssetBytes: admin reads under RLS. getAssetBytes is the ONLY admin function that reads `data`.
//   - copyAssetsForContent: clone-on-grant and re-sync copy the images of a question into the target pack.
// The candidate route (module 06) reads the bytes in its own function, after the attempt check.
import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { AppError, NotFoundError, ValidationError } from "@assessiq/core";
import { withTenant } from "@assessiq/tenancy";
import { auditInTx } from "@assessiq/audit-log";
import { ASSET_ID_RE } from "@assessiq/question-types";
import { cleanAltText, cleanImage } from "./image-clean.js";

export const ASSET_TENANT_MAX_BYTES = 100 * 1024 * 1024;
export const ASSET_PACK_MAX_COUNT = 500;

export interface AssetMeta {
  id: string;
  pack_id: string;
  sha256: string;
  mime: "image/png" | "image/jpeg";
  byte_size: number;
  width: number;
  height: number;
  alt_text: string;
  created_at: string;
}

// Explicit column list: the `data` column is never part of a list or meta query.
const META_COLS = "id, pack_id, sha256, mime, byte_size, width, height, alt_text, created_at";

const asMeta = (r: Record<string, unknown>): AssetMeta => ({
  id: r["id"] as string,
  pack_id: r["pack_id"] as string,
  sha256: r["sha256"] as string,
  mime: r["mime"] as AssetMeta["mime"],
  byte_size: Number(r["byte_size"]),
  width: Number(r["width"]),
  height: Number(r["height"]),
  alt_text: r["alt_text"] as string,
  created_at: r["created_at"] instanceof Date ? (r["created_at"] as Date).toISOString() : String(r["created_at"]),
});

export async function uploadQuestionAsset(
  tenantId: string,
  actorUserId: string,
  packId: string,
  raw: Buffer,
  altRaw: unknown,
): Promise<AssetMeta & { deduped: boolean }> {
  if (typeof packId !== "string" || !ASSET_ID_RE.test(packId)) {
    throw new ValidationError("pack_id is required", { details: { code: "ASSET_PACK_REQUIRED" } });
  }
  const alt = cleanAltText(altRaw);
  const img = cleanImage(raw);
  const sha = createHash("sha256").update(img.data).digest("hex");

  return withTenant(tenantId, async (client) => {
    // The pack must be this tenant's own (a licensed platform pack is visible but not writable).
    const pack = await client.query(`SELECT 1 FROM question_packs WHERE id = $1 AND tenant_id = $2`, [packId, tenantId]);
    if (pack.rowCount === 0) throw new NotFoundError("Question set not found", { details: { code: "PACK_NOT_FOUND" } });

    // One lock per tenant: two uploads cannot both pass the byte cap.
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`question_assets:${tenantId}`]);

    const same = await client.query(
      `SELECT ${META_COLS} FROM question_assets WHERE tenant_id = $1 AND pack_id = $2 AND sha256 = $3`,
      [tenantId, packId, sha],
    );
    if (same.rows[0] !== undefined) return { ...asMeta(same.rows[0]), deduped: true };

    const use = await client.query<{ bytes: string; n: number }>(
      `SELECT COALESCE(sum(byte_size), 0)::text AS bytes, count(*) FILTER (WHERE pack_id = $2)::int AS n
         FROM question_assets WHERE tenant_id = $1`,
      [tenantId, packId],
    );
    if (Number(use.rows[0]!.bytes) + img.data.length > ASSET_TENANT_MAX_BYTES) {
      throw new AppError("Your organisation reached its image storage limit (100 MB).", "ASSET_TENANT_CAP", 409, { details: { code: "ASSET_TENANT_CAP" } });
    }
    if (use.rows[0]!.n >= ASSET_PACK_MAX_COUNT) {
      throw new AppError("This question set already has 500 images.", "ASSET_PACK_CAP", 409, { details: { code: "ASSET_PACK_CAP" } });
    }

    const ins = await client.query(
      `INSERT INTO question_assets (tenant_id, pack_id, sha256, mime, byte_size, width, height, alt_text, data, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING ${META_COLS}`,
      [tenantId, packId, sha, img.mime, img.data.length, img.width, img.height, alt, img.data, actorUserId],
    );
    const meta = asMeta(ins.rows[0]);
    await auditInTx(client, {
      tenantId,
      actorKind: "user",
      actorUserId,
      action: "question.asset.uploaded",
      entityType: "question_asset",
      entityId: meta.id,
      after: { pack_id: packId, mime: meta.mime, byte_size: meta.byte_size, width: meta.width, height: meta.height, sha256: meta.sha256 },
    });
    return { ...meta, deduped: false };
  });
}

export async function getAssetMeta(tenantId: string, id: string): Promise<AssetMeta> {
  if (!ASSET_ID_RE.test(id)) throw new NotFoundError("Image not found", { details: { code: "ASSET_NOT_FOUND" } });
  return withTenant(tenantId, async (client) => {
    const r = await client.query(`SELECT ${META_COLS} FROM question_assets WHERE id = $1`, [id]);
    if (r.rows[0] === undefined) throw new NotFoundError("Image not found", { details: { code: "ASSET_NOT_FOUND" } });
    return asMeta(r.rows[0]);
  });
}

/** The only admin read of `data`. RLS decides who can see the row (own tenant, or a licensed pack when that is on). */
export async function getAssetBytes(tenantId: string, id: string): Promise<{ mime: AssetMeta["mime"]; data: Buffer; sha256: string }> {
  if (!ASSET_ID_RE.test(id)) throw new NotFoundError("Image not found", { details: { code: "ASSET_NOT_FOUND" } });
  return withTenant(tenantId, async (client) => {
    const r = await client.query<{ mime: AssetMeta["mime"]; data: Buffer; sha256: string }>(
      `SELECT mime, data, sha256 FROM question_assets WHERE id = $1`,
      [id],
    );
    if (r.rows[0] === undefined) throw new NotFoundError("Image not found", { details: { code: "ASSET_NOT_FOUND" } });
    return r.rows[0];
  });
}

/** Asset ids named by a content object (stem_assets and option_assets), in first-seen order, no duplicates. */
export function assetIdsOf(content: unknown): string[] {
  if (content === null || typeof content !== "object" || Array.isArray(content)) return [];
  const c = content as { stem_assets?: unknown; option_assets?: unknown };
  const out: string[] = [];
  for (const arr of [c.stem_assets, c.option_assets]) {
    if (!Array.isArray(arr)) continue;
    for (const x of arr) if (typeof x === "string" && !out.includes(x)) out.push(x);
  }
  return out;
}

/**
 * Clone-on-grant / re-sync: copy the images a question uses into the target pack and return the content with
 * the ids rewritten to the copies. Same bytes and sha256, new id, target tenant and pack. A repeat copy reuses
 * the row (unique tenant + pack + sha256). Run it BEFORE the question is inserted, in the same transaction,
 * so the question_versions trigger finds every image in the target pack.
 */
export async function copyAssetsForContent(
  client: PoolClient,
  content: unknown,
  dstPackId: string,
  dstTenantId: string,
  actorUserId: string,
): Promise<unknown> {
  const ids = assetIdsOf(content);
  if (ids.length === 0) return content;
  const src = await client.query(
    `SELECT id, sha256, mime, byte_size, width, height, alt_text, data FROM question_assets WHERE id = ANY($1::uuid[])`,
    [ids],
  );
  const map = new Map<string, string>();
  for (const id of ids) {
    const row = src.rows.find((r) => r.id === id);
    if (row === undefined) throw new NotFoundError("An image of this question is missing", { details: { code: "ASSET_NOT_FOUND" } });
    await client.query(
      `INSERT INTO question_assets (tenant_id, pack_id, sha256, mime, byte_size, width, height, alt_text, data, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (tenant_id, pack_id, sha256) DO NOTHING`,
      [dstTenantId, dstPackId, row.sha256, row.mime, row.byte_size, row.width, row.height, row.alt_text, row.data, actorUserId],
    );
    const got = await client.query<{ id: string }>(
      `SELECT id FROM question_assets WHERE tenant_id = $1 AND pack_id = $2 AND sha256 = $3`,
      [dstTenantId, dstPackId, row.sha256],
    );
    map.set(id, got.rows[0]!.id);
  }
  const c = content as { stem_assets?: unknown; option_assets?: unknown } & Record<string, unknown>;
  const re = (arr: unknown): unknown => (Array.isArray(arr) ? arr.map((x) => (typeof x === "string" ? (map.get(x) ?? x) : x)) : arr);
  const out: Record<string, unknown> = { ...c };
  if (c.stem_assets !== undefined) out["stem_assets"] = re(c.stem_assets);
  if (c.option_assets !== undefined) out["option_assets"] = re(c.option_assets);
  return out;
}

/** Friendly pre-check before a save: every image the content names must be a row of THIS pack and tenant. The database trigger is the backstop. */
export async function assertAssetsInPack(client: PoolClient, packId: string, content: unknown): Promise<void> {
  const ids = assetIdsOf(content);
  if (ids.length === 0) return;
  const r = await client.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM question_assets a
      WHERE a.id = ANY($1::uuid[]) AND a.pack_id = $2
        AND a.tenant_id = current_setting('app.current_tenant', true)::uuid`,
    [ids, packId],
  );
  if (r.rows[0]!.n !== ids.length) {
    throw new ValidationError("Every image of a question must be uploaded to the same question set.", {
      details: { code: "ASSET_NOT_IN_PACK" },
    });
  }
}
