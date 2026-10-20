// Camera file path helpers shared by 06-attempt-engine, 20-data-rights and 02-tenancy purge.
// Paths are RELATIVE to the storage root: <tenantId>/<attemptId>/<fileId>.jpg|.webm.
// No AI, no image processing here.

import { promises as fs } from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { UUID_RE } from "./ids.js";
import { ValidationError } from "./errors.js";

export function cameraRoot(): string {
  return path.resolve(config.CAMERA_STORAGE_DIR);
}

export function buildCameraRelativePath(
  tenantId: string,
  attemptId: string,
  fileId: string,
  kind: "photo" | "video",
): string {
  for (const id of [tenantId, attemptId, fileId]) {
    if (typeof id !== "string" || !UUID_RE.test(id)) {
      throw new ValidationError("camera path: id must be a uuid", { details: { code: "CAMERA_BAD_ID" } });
    }
  }
  if (kind !== "photo" && kind !== "video") {
    throw new ValidationError("camera path: bad kind", { details: { code: "CAMERA_BAD_KIND" } });
  }
  return `${tenantId}/${attemptId}/${fileId}.${kind === "photo" ? "jpg" : "webm"}`;
}

const REL_RE = /^[0-9a-f-]{36}\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.(jpg|webm)$/i;

/** Absolute path for a relative one. Throws unless it has the exact shape and stays under the root (symlinks included). */
export async function resolveCameraPath(rel: string): Promise<string> {
  if (typeof rel !== "string" || !REL_RE.test(rel)) {
    throw new ValidationError("camera path: bad path", { details: { code: "CAMERA_BAD_PATH" } });
  }
  const root = cameraRoot();
  const abs = path.resolve(root, rel);
  if (!abs.startsWith(root + path.sep)) {
    throw new ValidationError("camera path: outside root", { details: { code: "CAMERA_BAD_PATH" } });
  }
  // Symlink escape: the nearest existing parent must resolve under the real root.
  let realRoot: string;
  try {
    realRoot = await fs.realpath(root);
  } catch {
    return abs; // root does not exist yet: nothing can be linked
  }
  let dir = path.dirname(abs);
  for (;;) {
    try {
      const real = await fs.realpath(dir);
      if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
        throw new ValidationError("camera path: symlink escape", { details: { code: "CAMERA_BAD_PATH" } });
      }
      break;
    } catch (e) {
      if (e instanceof ValidationError) throw e;
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      const up = path.dirname(dir);
      if (up === dir) break;
      dir = up;
    }
  }
  return abs;
}

/** Delete one camera file. A missing file (ENOENT) is fine; any other error is thrown so the caller can retry. */
export async function deleteCameraFile(rel: string): Promise<void> {
  const abs = await resolveCameraPath(rel);
  try {
    await fs.unlink(abs);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
}

/** Remove a tenant's whole camera folder (tenant purge). Missing folder is fine. */
export async function removeCameraTenantDir(tenantId: string): Promise<void> {
  if (!UUID_RE.test(tenantId)) {
    throw new ValidationError("camera path: id must be a uuid", { details: { code: "CAMERA_BAD_ID" } });
  }
  await fs.rm(path.join(cameraRoot(), tenantId), { recursive: true, force: true });
}
