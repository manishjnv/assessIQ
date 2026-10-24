/**
 * Camera policy table, storage path safety, atomic write, disk guard thresholds. No database.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, readFile, stat, symlink, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "@assessiq/core";
import { CAMERA_NOTICE_VERSION } from "../camera/constants.js";
import {
  resolveCameraPolicy,
  cameraSetupBlocker,
  computeExpiresAt,
  buildCameraRelativePath,
  resolveSafe,
  writeFileAtomic,
  deleteFile,
  evaluateDiskGuard,
  hashCameraIp,
} from "../camera/index.js";

const tc = (o: Partial<{ isSchool: boolean; cameraEnabled: boolean; photosEnabled: boolean; noticeConfirmedVersion: string | null }> = {}) => ({
  isSchool: false,
  cameraEnabled: false,
  photosEnabled: false,
  noticeConfirmedVersion: null,
  ...o,
});
const base = { deliveryMode: "real" as const, isEmbed: false, assessmentCamera: true, enforced: true, tenantCamera: tc() };

describe("resolveCameraPolicy", () => {
  it("mock exam: not required", () => {
    expect(resolveCameraPolicy({ ...base, deliveryMode: "mock" })).toMatchObject({ required: false, reason: "mock" });
  });
  it("card without camera (assessmentCamera=false): not required for a real non-embed attempt", () => {
    expect(resolveCameraPolicy({ ...base, assessmentCamera: false })).toMatchObject({ required: false, reason: "not_required" });
    expect(resolveCameraPolicy({ ...base, assessmentCamera: false, tenantCamera: tc({ isSchool: true, cameraEnabled: true }) }).required).toBe(false);
  });
  it("embed: not required (accepted gap)", () => {
    expect(resolveCameraPolicy({ ...base, isEmbed: true })).toMatchObject({ required: false, reason: "embed" });
  });
  it("enforced off: not required", () => {
    expect(resolveCameraPolicy({ ...base, enforced: false })).toMatchObject({ required: false, reason: "not_enforced" });
  });
  it("school with camera off: not required", () => {
    expect(resolveCameraPolicy({ ...base, tenantCamera: tc({ isSchool: true }) })).toMatchObject({ required: false, reason: "school_off" });
  });
  it("school with camera on: required, photos follow the switch, keep 7 days for both", () => {
    const p = resolveCameraPolicy({ ...base, tenantCamera: tc({ isSchool: true, cameraEnabled: true, photosEnabled: false }) });
    expect(p).toMatchObject({ required: true, photos: false, video: true, keepDays: { photo: 7, video: 7 } });
    expect(resolveCameraPolicy({ ...base, tenantCamera: tc({ isSchool: true, cameraEnabled: true, photosEnabled: true }) }).photos).toBe(true);
  });
  it("non-school real exam: required, photos on, keep 90 / 7", () => {
    expect(resolveCameraPolicy(base)).toMatchObject({ required: true, photos: true, video: true, keepDays: { photo: 90, video: 7 } });
  });
});

describe("cameraSetupBlocker and computeExpiresAt", () => {
  it("blocks only when required and the notice is not confirmed", () => {
    const req = resolveCameraPolicy(base);
    expect(cameraSetupBlocker(req, tc())).toBe("NOT_CONFIRMED");
    expect(cameraSetupBlocker(resolveCameraPolicy({ ...base, deliveryMode: "mock" }), tc())).toBeNull();
    // Z-144: compares the version, not null
    expect(cameraSetupBlocker(req, tc({ noticeConfirmedVersion: "2020-old" }))).toBe("NOT_CONFIRMED");
    expect(cameraSetupBlocker(req, tc({ noticeConfirmedVersion: CAMERA_NOTICE_VERSION }))).toBeNull();
  });
  it("adds the keep days", () => {
    const t = new Date("2026-01-01T00:00:00Z");
    expect(computeExpiresAt("photo", t, { keepDays: { photo: 90, video: 7 } }).toISOString()).toBe("2026-04-01T00:00:00.000Z");
    expect(computeExpiresAt("video", t, { keepDays: { photo: 90, video: 7 } }).toISOString()).toBe("2026-01-08T00:00:00.000Z");
  });
});

describe("storage", () => {
  let dir: string;
  const prev = config.CAMERA_STORAGE_DIR;
  const [t, a, f] = [randomUUID(), randomUUID(), randomUUID()];

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "aiq-camera-"));
    (config as { CAMERA_STORAGE_DIR: string }).CAMERA_STORAGE_DIR = dir;
  });
  afterAll(async () => {
    (config as { CAMERA_STORAGE_DIR: string }).CAMERA_STORAGE_DIR = prev;
    await rm(dir, { recursive: true, force: true });
  });

  it("builds a relative path and refuses a bad id or kind", () => {
    expect(buildCameraRelativePath(t, a, f, "photo")).toBe(`${t}/${a}/${f}.jpg`);
    expect(buildCameraRelativePath(t, a, f, "video")).toBe(`${t}/${a}/${f}.webm`);
    expect(() => buildCameraRelativePath("../x", a, f, "photo")).toThrow();
    expect(() => buildCameraRelativePath(t, a, f, "gif" as "photo")).toThrow();
  });

  it("refuses traversal and absolute paths", async () => {
    await expect(resolveSafe(`../../etc/passwd`)).rejects.toThrow();
    await expect(resolveSafe(`${t}/${a}/../../../x.jpg`)).rejects.toThrow();
    await expect(resolveSafe(`/etc/passwd`)).rejects.toThrow();
    await expect(resolveSafe(`${t}/${a}/${f}.exe`)).rejects.toThrow();
  });

  it("writes atomically, then deletes; a second delete is fine", async () => {
    const rel = buildCameraRelativePath(t, a, f, "photo");
    await writeFileAtomic(rel, Buffer.from("jpegbytes"));
    expect((await readFile(join(dir, rel))).toString()).toBe("jpegbytes");
    if (process.platform !== "win32") expect((await stat(join(dir, rel))).mode & 0o777).toBe(0o600);
    await deleteFile(rel);
    await deleteFile(rel);
    await expect(stat(join(dir, rel))).rejects.toThrow();
  });

  it("refuses a symlinked tenant folder that points outside the root", async () => {
    const outside = await mkdtemp(join(tmpdir(), "aiq-outside-"));
    const t2 = randomUUID();
    try {
      await mkdir(dir, { recursive: true });
      try {
        await symlink(outside, join(dir, t2), "dir");
      } catch {
        return; // no symlink right on this machine: nothing to prove
      }
      await expect(writeFileAtomic(buildCameraRelativePath(t2, a, f, "photo"), Buffer.from("x"))).rejects.toThrow();
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("hashCameraIp is a stable keyed hash, not the IP", () => {
    expect(hashCameraIp("203.0.113.9")).toBe(hashCameraIp("203.0.113.9"));
    expect(hashCameraIp("203.0.113.9")).not.toContain("203.0.113.9");
    expect(hashCameraIp("203.0.113.9")).not.toBe(hashCameraIp("203.0.113.10"));
  });
});

describe("evaluateDiskGuard", () => {
  const MAX = 1000;
  const GB = 1024 ** 3;
  it("ok below 80%", () => expect(evaluateDiskGuard(500, 10, MAX, GB)).toMatchObject({ ok: true, warn: false, full: false }));
  it("warns at 80%", () => expect(evaluateDiskGuard(800, 10, MAX, GB)).toMatchObject({ ok: true, warn: true, full: false }));
  it("full when used + incoming exceeds the cap", () => {
    expect(evaluateDiskGuard(995, 10, MAX, GB)).toMatchObject({ ok: false, full: true });
    expect(evaluateDiskGuard(990, 10, MAX, GB).full).toBe(false);
  });
  it("full when free disk space is under 256 MB", () => {
    expect(evaluateDiskGuard(0, 1, MAX, 255 * 1024 * 1024).full).toBe(true);
    expect(evaluateDiskGuard(0, 1, MAX, null).full).toBe(false);
  });
});
