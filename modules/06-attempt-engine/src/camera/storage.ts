// Camera disk storage. Path rules live in @assessiq/core (shared with erasure and tenant purge).

import { promises as fs, constants as fsc } from "node:fs";
import path from "node:path";
import { config, cameraRoot, buildCameraRelativePath, resolveCameraPath, deleteCameraFile } from "@assessiq/core";
import { withSystemRole, withTenant } from "@assessiq/tenancy";

export { cameraRoot, buildCameraRelativePath, resolveCameraPath as resolveSafe, deleteCameraFile as deleteFile };

const MIN_FREE_BYTES = 256 * 1024 * 1024;

/** Write atomically: tmp file then rename. Dirs 0700, file 0600. */
export async function writeFileAtomic(rel: string, buf: Buffer): Promise<void> {
  const abs = await resolveCameraPath(rel);
  await fs.mkdir(path.dirname(abs), { recursive: true, mode: 0o700 });
  // The parent now exists: check symlink escape again before writing.
  await resolveCameraPath(rel);
  const tmp = `${abs}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(tmp, buf, { mode: 0o600, flag: fsc.O_WRONLY | fsc.O_CREAT | fsc.O_EXCL });
    await fs.rename(tmp, abs);
  } catch (e) {
    await fs.unlink(tmp).catch(() => undefined);
    throw e;
  }
}

/** System-wide camera bytes. Cross-tenant, so it runs under the system role. Call it outside a tenant tx. */
export async function getUsage(): Promise<number> {
  return withSystemRole("camera storage usage", async (client) => {
    const r = await client.query<{ n: string }>(`SELECT COALESCE(sum(size_bytes), 0)::text AS n FROM camera_files`);
    return Number(r.rows[0]?.n ?? "0");
  });
}

/** One organisation's camera bytes, from its own rows under its own RLS (GATE-8 A2-6). No cross-tenant read. */
export async function getTenantUsage(tenantId: string): Promise<number> {
  return withTenant(tenantId, async (client) => {
    const r = await client.query<{ n: string }>(`SELECT COALESCE(sum(size_bytes), 0)::text AS n FROM camera_files WHERE tenant_id = $1`, [tenantId]);
    return Number(r.rows[0]?.n ?? "0");
  });
}

export interface DiskGuard {
  ok: boolean;
  usedBytes: number;
  maxBytes: number;
  /** used >= 80% of the cap */
  warn: boolean;
  /** used + incoming > cap, or free disk space < 256 MB */
  full: boolean;
}

/** Pure thresholds (tested directly). */
export function evaluateDiskGuard(usedBytes: number, incomingBytes: number, maxBytes: number, freeBytes: number | null): DiskGuard {
  const full = usedBytes + incomingBytes > maxBytes || (freeBytes !== null && freeBytes < MIN_FREE_BYTES);
  return { ok: !full, usedBytes, maxBytes, warn: usedBytes >= maxBytes * 0.8, full };
}

const FREE_CACHE_MS = 30_000;
let freeCache: { at: number; bytes: number | null } | null = null;

/** Free bytes on the camera volume, cached for 30 s so the upload path does not stat the disk each time. */
async function freeBytesCached(): Promise<number | null> {
  if (freeCache !== null && Date.now() - freeCache.at < FREE_CACHE_MS) return freeCache.bytes;
  let free: number | null = null;
  try {
    await fs.mkdir(cameraRoot(), { recursive: true, mode: 0o700 });
    const s = await fs.statfs(cameraRoot());
    free = Number(s.bavail) * Number(s.bsize);
  } catch {
    free = null; // ponytail: an unreadable fs is not treated as full; the byte cap still applies
  }
  freeCache = { at: Date.now(), bytes: free };
  return free;
}

/** Whole-system guard for the worker and admin screens (cross-tenant sum; NOT used by the upload path). */
export async function diskGuard(opts: { incomingBytes: number; usedBytes?: number }): Promise<DiskGuard> {
  const used = opts.usedBytes ?? (await getUsage());
  return evaluateDiskGuard(used, opts.incomingBytes, config.CAMERA_STORAGE_MAX_BYTES, await freeBytesCached());
}

/** Upload-path guard: the tenant's own cap plus the cached free-disk check. Other tenants are not read. */
export async function tenantDiskGuard(opts: { tenantId: string; incomingBytes: number }): Promise<DiskGuard> {
  const used = await getTenantUsage(opts.tenantId);
  return evaluateDiskGuard(used, opts.incomingBytes, config.CAMERA_TENANT_STORAGE_MAX_BYTES, await freeBytesCached());
}
