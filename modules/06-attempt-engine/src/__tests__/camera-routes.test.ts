/**
 * Real-exam camera, part 2 (Batch A): consent endpoint, start gate, uploads, staff routes.
 * Real services and real schema; only token resolution, session minting and the rate-limit
 * store are stubbed (same pattern as attempt-engine.test.ts). No AI, no image processing.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import Fastify from "fastify";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { Client } from "pg";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config, AuthzError } from "@assessiq/core";
import { applyAllMigrations } from "../../../../tools/test-support/apply-all-migrations.js";

const routeCtx = vi.hoisted(() => ({
  resolved: null as unknown,
  session: null as { userId: string; tenantId: string; role: string } | null,
  rl: { allowed: true, retryAfterSeconds: 30 },
}));
vi.mock("@assessiq/assessment-lifecycle", async (orig) => ({
  ...(await orig<typeof import("@assessiq/assessment-lifecycle")>()),
  resolveInvitationToken: vi.fn(async () => routeCtx.resolved),
  markInvitationViewedByToken: vi.fn(async () => undefined),
}));
vi.mock("@assessiq/auth", async (orig) => ({
  ...(await orig<typeof import("@assessiq/auth")>()),
  mintCandidateSession: vi.fn(async () => ({ id: "sess-1", token: "sess-token" })),
  consumeRateLimit: vi.fn(async () => routeCtx.rl),
}));

import { setPoolForTesting, closePool } from "../../../02-tenancy/src/pool.js";
import { createPack, addLevel, createQuestion, publishPack } from "../../../04-question-bank/src/service.js";
import { createAssessment, publishAssessment, inviteUsers } from "../../../05-assessment-lifecycle/src/service.js";
import { startAttempt as rawStartAttempt, recordTakeConsent } from "../service.js";
import { registerAttemptTakeRoutes } from "../routes.take.js";
import { registerAttemptCandidateRoutes } from "../routes.candidate.js";
import { registerCameraCandidateRoutes } from "../routes.camera.candidate.js";
import { registerCameraAdminRoutes } from "../routes.camera.admin.js";
import { CAMERA_NOTICE_VERSION, PHOTO_MAX_BYTES } from "../camera/constants.js";

const TOKEN = "tok_0123456789abcdef0123456789abcdef";
const READY = { browser: { name: "chrome", version: "126" }, screenWidth: 1920, screenHeight: 1080, downlinkMbps: 10, rttMs: 40 };
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("fake-jpeg-body")]);
const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.from("fake-webm-body")]);

let container: StartedTestContainer;
let url: string;
let dir: string;
let T: string;
let TB: string; // second organisation
let admin: string; // tenant admin, not a reviewer
let reviewer: string; // tenant admin named as camera reviewer
let superUser: string;
let reviewerB: string;
const cfg = config as unknown as { CAMERA_ENFORCED: boolean; CAMERA_STORAGE_DIR: string; CAMERA_STORAGE_MAX_BYTES: number };
const prev = { dir: cfg.CAMERA_STORAGE_DIR, enforced: cfg.CAMERA_ENFORCED, max: cfg.CAMERA_STORAGE_MAX_BYTES };

async function sup<R = Record<string, unknown>>(q: string, p: unknown[] = []): Promise<R[]> {
  const c = new Client({ connectionString: url });
  await c.connect();
  try {
    return (await c.query(q, p)).rows as R[];
  } finally {
    await c.end();
  }
}

const insertUser = (id: string, tenant: string, role: string, name = role) =>
  sup(`INSERT INTO users (id, tenant_id, email, name, role, status) VALUES ($1, $2, $3, $4, $5, 'active')`, [id, tenant, `${id}@x.com`, name, role]);

beforeAll(async () => {
  container = await new GenericContainer("postgres:16-alpine")
    .withEnvironment({ POSTGRES_USER: "assessiq", POSTGRES_PASSWORD: "pw", POSTGRES_DB: "assessiq" })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .withStartupTimeout(60_000)
    .start();
  url = `postgres://assessiq:pw@${container.getHost()}:${container.getMappedPort(5432)}/assessiq`;
  const c = new Client({ connectionString: url });
  await c.connect();
  await applyAllMigrations(c);
  await c.query(`GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO assessiq_app, assessiq_system`);
  await c.query(`GRANT USAGE, SELECT ON SEQUENCE audit_log_id_seq TO assessiq_app`);
  await c.end();
  setPoolForTesting(url);

  dir = await mkdtemp(join(tmpdir(), "aiq-camera-routes-"));
  cfg.CAMERA_STORAGE_DIR = dir;
  T = randomUUID();
  TB = randomUUID();
  admin = randomUUID();
  reviewer = randomUUID();
  superUser = randomUUID();
  reviewerB = randomUUID();
  for (const [id, slug] of [[T, "ta"], [TB, "tb"]] as const) {
    await sup(`INSERT INTO tenants (id, slug, name) VALUES ($1, $2, $3)`, [id, slug, `Tenant ${slug}`]);
    await sup(`INSERT INTO tenant_settings (tenant_id) VALUES ($1)`, [id]);
    await sup(`INSERT INTO tenant_plans (tenant_id, tier, included_credits) VALUES ($1, 'internal', NULL)`, [id]);
  }
  await insertUser(admin, T, "admin", "Plain Admin");
  await insertUser(reviewer, T, "admin", "Named Reviewer");
  await insertUser(superUser, T, "super_admin", "Super");
  await insertUser(reviewerB, TB, "admin", "Reviewer B");
  await sup(`INSERT INTO camera_reviewers (tenant_id, user_id, added_by) VALUES ($1, $2, $3), ($4, $5, $5)`, [T, reviewer, admin, TB, reviewerB]);
}, 180_000);

afterAll(async () => {
  cfg.CAMERA_STORAGE_DIR = prev.dir;
  cfg.CAMERA_ENFORCED = prev.enforced;
  cfg.CAMERA_STORAGE_MAX_BYTES = prev.max;
  await rm(dir, { recursive: true, force: true });
  await closePool();
  if (container !== undefined) await container.stop();
}, 30_000);

beforeEach(async () => {
  cfg.CAMERA_ENFORCED = true;
  cfg.CAMERA_STORAGE_MAX_BYTES = prev.max;
  routeCtx.rl = { allowed: true, retryAfterSeconds: 30 };
  // Non-school, notice confirmed: a real exam needs the camera.
  await sup(`UPDATE tenants SET is_school = false WHERE id = $1`, [T]);
  await sup(`UPDATE tenant_settings SET camera_enabled = true, camera_photos_enabled = true, camera_notice_confirmed_version = $2 WHERE tenant_id = $1`, [T, CAMERA_NOTICE_VERSION]);
});

async function buildApp() {
  const app = Fastify();
  app.setErrorHandler((err, _req, reply) => {
    const e = err as { status?: number; toJson?: () => unknown; statusCode?: number; code?: string };
    if (typeof e.toJson === "function") return reply.code(e.status ?? 500).send({ error: e.toJson() });
    if (typeof e.statusCode === "number" && e.statusCode >= 400 && e.statusCode < 500) {
      return reply.code(e.statusCode).send({ error: { code: e.code ?? "HTTP_ERROR" } });
    }
    return reply.code(500).send({ error: { code: "INTERNAL", message: String((err as Error).message) } });
  });
  const asSession = async (req: unknown) => {
    (req as { session: unknown }).session = routeCtx.session;
  };
  const adminChain = async (req: unknown) => {
    await asSession(req);
    const s = routeCtx.session;
    if (s === null || (s.role !== "admin" && s.role !== "super_admin")) throw new AuthzError("role not authorized");
  };
  const superChain = async (req: unknown) => {
    await asSession(req);
    if (routeCtx.session?.role !== "super_admin") throw new AuthzError("role not authorized");
  };
  await registerAttemptTakeRoutes(app, { publicChain: [] });
  await registerAttemptCandidateRoutes(app, { candidateOnly: asSession });
  await registerCameraCandidateRoutes(app, { candidateOnly: asSession });
  await registerCameraAdminRoutes(app, {
    adminOnly: adminChain,
    superAdminOnly: superChain,
    users: {
      get: async (tenantId, userId) => {
        const r = await sup<{ id: string; name: string; email: string }>(`SELECT id, name, email FROM users WHERE id = $1 AND tenant_id = $2`, [userId, tenantId]);
        return r[0] ?? null;
      },
    },
  });
  return app;
}

async function newExam(label: string, mode: "real" | "mock" = "real") {
  const candidate = randomUUID();
  await insertUser(candidate, T, "candidate", label);
  const pack = await createPack(T, { slug: `p-${randomUUID().slice(0, 8)}`, name: "P", domain: "soc" }, admin);
  const level = await addLevel(T, pack.id, { position: 1, label: "L1", duration_minutes: 30, default_question_count: 2 }, admin);
  for (let i = 0; i < 2; i++) {
    await createQuestion(T, { pack_id: pack.id, level_id: level.id, type: "mcq", topic: `t${i}`, points: 5, content: { question: `Q${i}?`, options: ["A", "B", "C", "D"], correct: 0, rationale: "A" } }, admin);
  }
  await publishPack(T, pack.id, admin);
  await sup(`UPDATE questions SET status = 'active', review_state = 'verified' WHERE pack_id = $1`, [pack.id]);
  const a = await createAssessment(T, { pack_id: pack.id, level_id: level.id, name: "Camera test", question_count: 2, opens_at: new Date(Date.now() + 60_000) }, admin);
  await publishAssessment(T, a.id, admin);
  await sup(`UPDATE assessments SET status = 'active' WHERE id = $1`, [a.id]);
  await inviteUsers(T, a.id, [candidate], admin);
  await sup(`UPDATE assessment_invitations SET delivery_mode = $2 WHERE assessment_id = $1`, [a.id, mode]);
  const invitationId = (await sup<{ id: string }>(`SELECT id FROM assessment_invitations WHERE assessment_id = $1`, [a.id]))[0]!.id;
  routeCtx.resolved = {
    already_submitted: false,
    assessment: { id: a.id, tenant_id: T, name: "Camera test" },
    invitation: { id: invitationId, delivery_mode: mode },
    candidate: { id: candidate, name: label },
    level: { duration_minutes: 30 },
  };
  routeCtx.session = { userId: candidate, tenantId: T, role: "candidate" };
  return { candidate, assessmentId: a.id, invitationId };
}

const consent = (app: Awaited<ReturnType<typeof buildApp>>, decision: "agreed" | "declined" = "agreed", noticeVersion = CAMERA_NOTICE_VERSION) =>
  app.inject({ method: "POST", url: "/take/camera-consent", payload: { token: TOKEN, decision, noticeVersion } });
const takeStart = (app: Awaited<ReturnType<typeof buildApp>>) =>
  app.inject({ method: "POST", url: "/take/start", payload: { token: TOKEN, consent: true, readiness: READY } });
const audit = (action: string) => sup<{ entity_id: string; actor_user_id: string | null; after: unknown }>(`SELECT entity_id, actor_user_id, after FROM audit_log WHERE tenant_id = $1 AND action = $2`, [T, action]);

/** A started real attempt with an agreed, linked consent. */
async function startedAttempt(app: Awaited<ReturnType<typeof buildApp>>, label: string) {
  const ex = await newExam(label);
  expect((await consent(app)).statusCode).toBe(200);
  const r = await takeStart(app);
  expect(r.statusCode).toBe(201);
  return { ...ex, attemptId: r.json().attempt_id as string };
}

const upload = (app: Awaited<ReturnType<typeof buildApp>>, attemptId: string, kind: "photo" | "video", body: Buffer, type?: string, query = "") =>
  app.inject({
    method: "POST",
    url: `/api/me/attempts/${attemptId}/camera/${kind}${kind === "video" ? (query || "?reason=camera_stopped") : ""}`,
    headers: { "content-type": type ?? (kind === "photo" ? "image/jpeg" : "video/webm") },
    payload: body,
  });

describe("consent endpoint and start gate", () => {
  it("consent agreed, then start succeeds and links the consent; /take/start and the me route both pass the gate", async () => {
    const app = await buildApp();
    const ex = await newExam("Gate");
    // no consent yet: refused (proves /take/start passes `gate`)
    const no = await takeStart(app);
    expect(no.statusCode).toBe(422);
    expect(no.json().error.code).toBe("CAMERA_CONSENT_REQUIRED");
    // the other request-facing route refuses the same way
    const me = await app.inject({ method: "POST", url: `/api/me/assessments/${ex.assessmentId}/start`, payload: { consent: true, readiness: READY } });
    expect(me.statusCode).toBe(422);
    expect(me.json().error.code).toBe("CAMERA_CONSENT_REQUIRED");
    expect((await sup(`SELECT 1 FROM attempts WHERE user_id = $1`, [ex.candidate])).length).toBe(0);
    // preview says the camera is required
    const pv = await app.inject({ method: "POST", url: "/take/start", payload: { token: TOKEN, preview: true } });
    expect(pv.json().assessment.camera_required).toBe(true);
    expect(pv.json().assessment.camera_notice_version).toBe(CAMERA_NOTICE_VERSION);

    expect((await consent(app)).json()).toEqual({ ok: true });
    const ok = await takeStart(app);
    expect(ok.statusCode).toBe(201);
    const row = (await sup<{ attempt_id: string; device_type: string; ip_hash: string }>(`SELECT attempt_id, device_type, ip_hash FROM camera_consents WHERE invitation_id = $1`, [ex.invitationId]))[0]!;
    expect(row.attempt_id).toBe(ok.json().attempt_id);
    expect(row.device_type).toBe("desktop");
    expect(row.ip_hash).not.toMatch(/127\.0\.0\.1/);
    expect((await audit("camera.consent.recorded")).some((a) => a.actor_user_id === ex.candidate)).toBe(true);
    // resume never needs consent again
    expect((await takeStart(app)).statusCode).toBe(201);
  });

  it("declined consent counts as missing", async () => {
    const app = await buildApp();
    await newExam("Declined");
    expect((await consent(app, "declined")).statusCode).toBe(200);
    const r = await takeStart(app);
    expect(r.statusCode).toBe(422);
    expect(r.json().error.code).toBe("CAMERA_CONSENT_REQUIRED");
  });

  it("stale notice version -> 422 CAMERA_NOTICE_STALE; unknown token -> 404", async () => {
    const app = await buildApp();
    await newExam("Stale");
    const r = await consent(app, "agreed", "1999-old");
    expect(r.statusCode).toBe(422);
    expect(r.json().error.code).toBe("CAMERA_NOTICE_STALE");
    routeCtx.resolved = null;
    expect((await consent(app)).statusCode).toBe(404);
  });

  it("organisation has not confirmed the notice -> 422 CAMERA_SETUP_REQUIRED", async () => {
    const app = await buildApp();
    await newExam("Setup");
    await sup(`UPDATE tenant_settings SET camera_notice_confirmed_version = NULL WHERE tenant_id = $1`, [T]);
    expect((await consent(app)).statusCode).toBe(200);
    const r = await takeStart(app);
    expect(r.statusCode).toBe(422);
    expect(r.json().error.code).toBe("CAMERA_SETUP_REQUIRED");
  });

  it("mock test never asks for the camera", async () => {
    const app = await buildApp();
    await newExam("Mock", "mock");
    const c = await consent(app);
    expect(c.statusCode).toBe(409);
    expect(c.json().error.code).toBe("CAMERA_NOT_REQUIRED");
    const r = await app.inject({ method: "POST", url: "/take/start", payload: { token: TOKEN, consent: true } });
    expect(r.statusCode).toBe(201);
  });

  it("CAMERA_ENFORCED=false changes nothing; a school with the camera off is not required", async () => {
    const app = await buildApp();
    await newExam("Off");
    cfg.CAMERA_ENFORCED = false;
    expect((await consent(app)).json().error.code).toBe("CAMERA_NOT_REQUIRED");
    expect((await takeStart(app)).statusCode).toBe(201);

    cfg.CAMERA_ENFORCED = true;
    await sup(`UPDATE tenants SET is_school = true WHERE id = $1`, [T]);
    await sup(`UPDATE tenant_settings SET camera_enabled = false WHERE tenant_id = $1`, [T]);
    await newExam("School off");
    expect((await takeStart(app)).statusCode).toBe(201);
  });

  it("embed attempts are exempt", async () => {
    const candidate = randomUUID();
    await insertUser(candidate, T, "candidate", "Embed");
    const { assessmentId } = await newExam("EmbedBase");
    const a = await rawStartAttempt(T, { userId: candidate, assessmentId, embedOrigin: true, gate: { mobile: false } });
    expect(a.id).toBeTruthy();
  });
});

describe("candidate camera routes", () => {
  it("status returns the policy; upload stores a photo and a flagged video; no storage path leaks", async () => {
    const app = await buildApp();
    const ex = await startedAttempt(app, "Up");
    const st = await app.inject({ method: "GET", url: `/api/me/attempts/${ex.attemptId}/camera/status` });
    expect(st.json()).toEqual({ required: true, photos: true, video: true, photoIntervalSeconds: 60, noticeVersion: CAMERA_NOTICE_VERSION });

    const p = await upload(app, ex.attemptId, "photo", JPEG);
    expect(p.statusCode).toBe(201);
    expect(Object.keys(p.json())).toEqual(["id"]);
    const row = (await sup<{ storage_path: string; flagged: boolean; expires_at: Date; taken_at: Date; size_bytes: string }>(`SELECT storage_path, flagged, expires_at, taken_at, size_bytes::text FROM camera_files WHERE id = $1`, [p.json().id]))[0]!;
    expect(row.flagged).toBe(false);
    expect(Number(row.size_bytes)).toBe(JPEG.length);
    expect(Math.round((row.expires_at.getTime() - row.taken_at.getTime()) / 86_400_000)).toBe(90);
    expect((await stat(join(dir, row.storage_path))).size).toBe(JPEG.length);

    const v = await upload(app, ex.attemptId, "video", WEBM, "video/webm;codecs=vp9", "?reason=camera_blocked");
    expect(v.statusCode).toBe(201);
    const vr = (await sup<{ flagged: boolean; flag_reason: string }>(`SELECT flagged, flag_reason FROM camera_files WHERE id = $1`, [v.json().id]))[0]!;
    expect(vr).toEqual({ flagged: true, flag_reason: "camera_blocked" });
    expect((await upload(app, ex.attemptId, "video", WEBM, undefined, "")).statusCode).toBe(201); // default reason in helper
    expect((await app.inject({ method: "POST", url: `/api/me/attempts/${ex.attemptId}/camera/video`, headers: { "content-type": "video/webm" }, payload: WEBM })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: `/api/me/attempts/${ex.attemptId}/camera/video?reason=x`, headers: { "content-type": "video/webm" }, payload: WEBM })).statusCode).toBe(400);
  });

  it("refuses wrong type, bad magic, oversize and empty bodies", async () => {
    const app = await buildApp();
    const ex = await startedAttempt(app, "Bad");
    const tp = await upload(app, ex.attemptId, "photo", JPEG, "text/plain");
    expect(tp.statusCode).toBe(415);
    expect((await upload(app, ex.attemptId, "photo", WEBM, "video/webm")).statusCode).toBe(415); // wrong type for the route
    expect((await upload(app, ex.attemptId, "photo", Buffer.from("not a jpeg at all"))).statusCode).toBe(415);
    expect((await upload(app, ex.attemptId, "video", Buffer.from("not a webm"))).statusCode).toBe(415);
    const big = Buffer.concat([JPEG, Buffer.alloc(PHOTO_MAX_BYTES)]);
    expect((await upload(app, ex.attemptId, "photo", big)).statusCode).toBe(413);
    expect((await upload(app, ex.attemptId, "photo", Buffer.alloc(0))).statusCode).toBe(400);
    expect((await sup(`SELECT 1 FROM camera_files WHERE attempt_id = $1`, [ex.attemptId])).length).toBe(0);
  });

  it("another candidate gets 404; a submitted attempt gets 409", async () => {
    const app = await buildApp();
    const ex = await startedAttempt(app, "Own");
    const other = randomUUID();
    await insertUser(other, T, "candidate", "Other");
    routeCtx.session = { userId: other, tenantId: T, role: "candidate" };
    const r = await upload(app, ex.attemptId, "photo", JPEG);
    expect(r.statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `/api/me/attempts/${ex.attemptId}/camera/status` })).statusCode).toBe(404);
    routeCtx.session = { userId: ex.candidate, tenantId: T, role: "candidate" };
    await sup(`UPDATE attempts SET status = 'submitted' WHERE id = $1`, [ex.attemptId]);
    const late = await upload(app, ex.attemptId, "photo", JPEG);
    expect(late.statusCode).toBe(409);
    expect(late.json().error.code).toBe("ATTEMPT_NOT_ACTIVE");
  });

  it("school with photos off -> 403 CAMERA_PHOTOS_OFF (video still allowed)", async () => {
    const app = await buildApp();
    const ex = await startedAttempt(app, "NoPhotos");
    await sup(`UPDATE tenants SET is_school = true WHERE id = $1`, [T]);
    await sup(`UPDATE tenant_settings SET camera_photos_enabled = false WHERE tenant_id = $1`, [T]);
    const r = await upload(app, ex.attemptId, "photo", JPEG);
    expect(r.statusCode).toBe(403);
    expect(r.json().error.code).toBe("CAMERA_PHOTOS_OFF");
    expect((await upload(app, ex.attemptId, "video", WEBM)).statusCode).toBe(201);
  });

  it("no linked consent -> 403 CAMERA_CONSENT_REQUIRED", async () => {
    const app = await buildApp();
    const ex = await newExam("NoConsent");
    // a service-level start (no gate) makes an attempt without any camera consent
    await recordTakeConsent(T, { userId: ex.candidate, ip: null, userAgent: null });
    const a = await rawStartAttempt(T, { userId: ex.candidate, assessmentId: ex.assessmentId });
    const r = await upload(app, a.id, "photo", JPEG);
    expect(r.statusCode).toBe(403);
    expect(r.json().error.code).toBe("CAMERA_CONSENT_REQUIRED");
  });

  it("rate limit -> 429 with Retry-After", async () => {
    const app = await buildApp();
    const ex = await startedAttempt(app, "Rate");
    routeCtx.rl = { allowed: false, retryAfterSeconds: 17 };
    const r = await upload(app, ex.attemptId, "photo", JPEG);
    expect(r.statusCode).toBe(429);
    expect(r.headers["retry-after"]).toBe("17");
  });

  it("storage full -> 507, upload_refused flagged, audit row, nothing stored", async () => {
    const app = await buildApp();
    const ex = await startedAttempt(app, "Full");
    cfg.CAMERA_STORAGE_MAX_BYTES = 10;
    const r = await upload(app, ex.attemptId, "photo", JPEG);
    expect(r.statusCode).toBe(507);
    expect(r.json().error.code).toBe("CAMERA_STORAGE_FULL");
    expect((await sup<{ upload_refused: boolean }>(`SELECT upload_refused FROM camera_attempt_reviews WHERE attempt_id = $1`, [ex.attemptId]))[0]?.upload_refused).toBe(true);
    expect((await audit("camera.upload.refused")).some((a) => a.entity_id === ex.attemptId)).toBe(true);
    expect((await sup(`SELECT 1 FROM camera_files WHERE attempt_id = $1`, [ex.attemptId])).length).toBe(0);
  });
});

describe("staff camera routes", () => {
  async function flaggedAttempt(app: Awaited<ReturnType<typeof buildApp>>, label: string) {
    const ex = await startedAttempt(app, label);
    const p = await upload(app, ex.attemptId, "photo", JPEG);
    const v = await upload(app, ex.attemptId, "video", WEBM);
    return { ...ex, photoId: p.json().id as string, videoId: v.json().id as string };
  }
  const as = (userId: string, tenantId: string, role: string) => {
    routeCtx.session = { userId, tenantId, role };
  };

  it("access probe answers 200 for every admin and says who is a reviewer", async () => {
    const app = await buildApp();
    as(admin, T, "admin");
    const plain = await app.inject({ method: "GET", url: "/api/admin/camera/access" });
    expect(plain.statusCode).toBe(200);
    expect(plain.json()).toEqual({ reviewer: false });
    as(reviewer, T, "admin");
    expect((await app.inject({ method: "GET", url: "/api/admin/camera/access" })).json()).toEqual({ reviewer: true });
  });

  it("named reviewer views a file: audit row written, safe headers; plain admin gets 403; other tenant gets 404", async () => {
    const app = await buildApp();
    const f = await flaggedAttempt(app, "View");
    const path = `/api/admin/camera/files/${f.videoId}/content`;

    as(admin, T, "admin"); // tenant admin, not named
    expect((await app.inject({ method: "GET", url: path })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: "/api/admin/camera/flagged" })).statusCode).toBe(403);
    expect((await audit("camera.file.viewed")).length).toBe(0);

    as(reviewerB, TB, "admin"); // another organisation
    expect((await app.inject({ method: "GET", url: path })).statusCode).toBe(404);

    as(reviewer, T, "admin");
    const ok = await app.inject({ method: "GET", url: path });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers["content-type"]).toBe("video/webm");
    expect(ok.headers["cache-control"]).toBe("private, no-store");
    expect(ok.headers["x-content-type-options"]).toBe("nosniff");
    expect(ok.headers["content-disposition"]).toBe("inline");
    expect(ok.rawPayload.equals(WEBM)).toBe(true);
    const a = await audit("camera.file.viewed");
    expect(a).toHaveLength(1);
    expect(a[0]!.entity_id).toBe(f.videoId);
    expect(a[0]!.actor_user_id).toBe(reviewer);
    expect(JSON.stringify(a[0]!.after)).not.toContain("fake-webm");

    // super admin passes the reviewer guard too
    as(superUser, T, "super_admin");
    expect((await app.inject({ method: "GET", url: path })).statusCode).toBe(200);
  });

  it("flagged list, file list (no storage path), reviewed and appeal are audited", async () => {
    const app = await buildApp();
    const f = await flaggedAttempt(app, "Review");
    as(reviewer, T, "admin");
    const list = (await app.inject({ method: "GET", url: "/api/admin/camera/flagged" })).json();
    const item = list.items.find((i: { attemptId: string }) => i.attemptId === f.attemptId);
    expect(item).toMatchObject({ candidateName: "Review", flaggedFiles: 1, appealState: "none", reviewedAt: null });
    const files = await app.inject({ method: "GET", url: `/api/admin/camera/attempts/${f.attemptId}/files` });
    expect(files.json().items).toHaveLength(2);
    expect(files.body).not.toContain("storage");
    expect(files.body).not.toContain(".webm");

    expect((await app.inject({ method: "POST", url: `/api/admin/camera/attempts/${f.attemptId}/reviewed` })).statusCode).toBe(200);
    expect((await audit("camera.review.marked")).some((a) => a.entity_id === f.attemptId && a.actor_user_id === reviewer)).toBe(true);
    const ap = await app.inject({ method: "POST", url: `/api/admin/camera/attempts/${f.attemptId}/appeal`, payload: { state: "open" } });
    expect(ap.statusCode).toBe(200);
    const ch = (await audit("camera.appeal.changed")).find((a) => a.entity_id === f.attemptId)!;
    expect(ch.after).toEqual({ appealState: "open" });
    expect((await app.inject({ method: "POST", url: `/api/admin/camera/attempts/${f.attemptId}/appeal`, payload: { state: "bogus" } })).statusCode).toBe(400);
    // an attempt of another tenant is not found
    as(reviewerB, TB, "admin");
    expect((await app.inject({ method: "POST", url: `/api/admin/camera/attempts/${f.attemptId}/reviewed` })).statusCode).toBe(404);
  });

  it("reviewer CRUD is tenant-admin only and audited", async () => {
    const app = await buildApp();
    const target = randomUUID();
    await insertUser(target, T, "admin", "New Reviewer");
    as(admin, T, "admin");
    expect((await app.inject({ method: "POST", url: "/api/admin/camera/reviewers", payload: { userId: randomUUID() } })).statusCode).toBe(404); // not in this tenant
    expect((await app.inject({ method: "POST", url: "/api/admin/camera/reviewers", payload: { userId: target } })).statusCode).toBe(201);
    expect((await audit("camera.reviewer.added")).some((a) => a.entity_id === target)).toBe(true);
    const list = (await app.inject({ method: "GET", url: "/api/admin/camera/reviewers" })).json();
    expect(list.items.map((i: { userId: string }) => i.userId)).toContain(target);
    expect((await app.inject({ method: "DELETE", url: `/api/admin/camera/reviewers/${target}` })).statusCode).toBe(200);
    expect((await audit("camera.reviewer.removed")).some((a) => a.entity_id === target)).toBe(true);
    expect((await app.inject({ method: "DELETE", url: `/api/admin/camera/reviewers/${target}` })).statusCode).toBe(404);
    as(randomUUID(), T, "candidate");
    expect((await app.inject({ method: "GET", url: "/api/admin/camera/reviewers" })).statusCode).toBe(403);
  });

  it("settings: GET shape, PATCH school only, confirm-notice; school flag is super admin only", async () => {
    const app = await buildApp();
    as(admin, T, "admin");
    const g = (await app.inject({ method: "GET", url: "/api/admin/camera/settings" })).json();
    expect(g).toMatchObject({ isSchool: false, requiredNoticeVersion: CAMERA_NOTICE_VERSION, noticeConfirmedVersion: CAMERA_NOTICE_VERSION });
    expect(g.storage).toMatchObject({ maxBytes: expect.any(Number), usedBytes: expect.any(Number), warn: expect.any(Boolean) });
    const no = await app.inject({ method: "PATCH", url: "/api/admin/camera/settings", payload: { cameraEnabled: false } });
    expect(no.statusCode).toBe(403);
    expect(no.json().error.code).toBe("CAMERA_SCHOOL_ONLY");

    // a tenant admin cannot flip the school flag
    expect((await app.inject({ method: "POST", url: `/api/admin/platform/tenants/${T}/school`, payload: { isSchool: true } })).statusCode).toBe(403);
    as(superUser, T, "super_admin");
    expect((await app.inject({ method: "POST", url: `/api/admin/platform/tenants/${T}/school`, payload: { isSchool: true } })).statusCode).toBe(200);
    expect((await sup<{ is_school: boolean }>(`SELECT is_school FROM tenants WHERE id = $1`, [T]))[0]!.is_school).toBe(true);
    expect((await app.inject({ method: "POST", url: `/api/admin/platform/tenants/${T}/school`, payload: { isSchool: "yes" } })).statusCode).toBe(400);

    as(admin, T, "admin");
    expect((await app.inject({ method: "PATCH", url: "/api/admin/camera/settings", payload: { photosEnabled: false } })).statusCode).toBe(200);
    expect((await sup<{ camera_photos_enabled: boolean }>(`SELECT camera_photos_enabled FROM tenant_settings WHERE tenant_id = $1`, [T]))[0]!.camera_photos_enabled).toBe(false);
    await sup(`UPDATE tenant_settings SET camera_notice_confirmed_version = NULL WHERE tenant_id = $1`, [T]);
    expect((await app.inject({ method: "POST", url: "/api/admin/camera/confirm-notice", payload: { confirm: false } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/api/admin/camera/confirm-notice", payload: { confirm: true } })).statusCode).toBe(200);
    expect((await sup<{ v: string }>(`SELECT camera_notice_confirmed_version AS v FROM tenant_settings WHERE tenant_id = $1`, [T]))[0]!.v).toBe(CAMERA_NOTICE_VERSION);
  });
});
