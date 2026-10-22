#!/usr/bin/env node
// AssessIQ - load-test data seed (Node 22, stdlib only).
//
// Emits ONE SQL transaction on stdout. Nothing is executed here: the operator pipes the SQL to psql
// inside the Postgres container, connected as the DB OWNER role (RLS is bypassed, so no
// app.current_tenant is needed). Raw invitation tokens go ONLY to local files, never to stdout.
//
// USAGE
//   node tools/load-test/seed-test-tenant.mjs --tokens-out <main-tokens.txt> --warmup-out <warmup-tokens.txt> \
//        [--users 600] [--warmup 60] [--run-id <a-z0-9-, max 24>] [--expires-days 7] > seed.sql
//   docker exec -i assessiq-postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1' < seed.sql
//   (the SQL starts with "\set ON_ERROR_STOP on"; run it with psql, not with a driver)
//
// WHAT IT CREATES (one tenant, slug "loadtest-<run-id>", status active)
//   tenants, tenant_settings (camera off, notice flags unset), tenant_plans (tier internal: no entitlement
//   or credit cap), audit_log (1 system row), 1 admin user, N + warmup candidate users
//   (lt-0001@loadtest.invalid ..., warm-up: ltw-0001@loadtest.invalid ...), tenant_candidate_counted,
//   question_packs (published, version 2), levels (1), tags (3), questions (40 active mcq + 5 active
//   subjective with a rubric), question_versions (version 1 snapshot, as pack publish writes),
//   question_source (rights cleared), question_tags, assessments (mock, camera-free, question_count 20,
//   30 min, opens 1 h ago, closes in N days), assessment_frozen_pool (what publish freezes),
//   assessment_invitations (delivery_mode mock, status pending, one per user).
//
// STATUS NOTE: the assessment is written as status 'active', not 'published'. startAttempt requires
//   'active'; the boundary worker would flip published -> active after opens_at. Writing 'active'
//   avoids a wait on that worker.
//
// TOKENS: plaintext = randomBytes(32).toString("base64url"); token_hash = sha256(plaintext) as lower-case
//   hex. This is exactly modules/05-assessment-lifecycle/src/tokens.ts (sha256Hex from @assessiq/core).
//   There is NO pepper and NO secret. Files are created with mode 0600 and the script refuses to
//   overwrite an existing file. Treat them as secrets: do not commit them.
//
// ENV NEEDED: none. The script reads no environment variable and never prints a token.

import { randomBytes, createHash } from "node:crypto";
import { writeFileSync } from "node:fs";

function fail(msg) {
  process.stderr.write(`seed-test-tenant: ${msg}\n`);
  process.exit(2);
}

// ---- args -----------------------------------------------------------------
const argv = process.argv.slice(2);
const opts = { users: 600, warmup: 60, "expires-days": 7 };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (!a.startsWith("--")) fail(`unexpected argument: ${a}`);
  const k = a.slice(2);
  if (!["users", "warmup", "tokens-out", "warmup-out", "run-id", "expires-days"].includes(k)) fail(`unknown option: ${a}`);
  const v = argv[++i];
  if (v === undefined) fail(`missing value for ${a}`);
  opts[k] = v;
}
const USERS = Number(opts.users);
const WARM = Number(opts.warmup);
const EXPIRES_DAYS = Number(opts["expires-days"]);
if (!Number.isInteger(USERS) || USERS < 1 || USERS > 5000) fail("--users must be an integer 1..5000");
if (!Number.isInteger(WARM) || WARM < 0 || WARM > 1000) fail("--warmup must be an integer 0..1000");
if (!Number.isInteger(EXPIRES_DAYS) || EXPIRES_DAYS < 1 || EXPIRES_DAYS > 30) fail("--expires-days must be 1..30");
if (!opts["tokens-out"]) fail("--tokens-out <path> is required");
if (WARM > 0 && !opts["warmup-out"]) fail("--warmup-out <path> is required when --warmup > 0");

const now = new Date();
const stamp = now.toISOString().replace(/[-:T]/g, "").slice(0, 12); // yyyymmddhhmm
const runId = String(opts["run-id"] ?? `${stamp}-${randomBytes(2).toString("hex")}`);
if (!/^[a-z0-9][a-z0-9-]{0,23}$/.test(runId)) fail("--run-id must match [a-z0-9-], max 24 chars");
const SLUG = `loadtest-${runId}`;

// ---- helpers --------------------------------------------------------------
function uuidv7() {
  const b = randomBytes(16);
  const ms = BigInt(Date.now());
  b[0] = Number((ms >> 40n) & 0xffn);
  b[1] = Number((ms >> 32n) & 0xffn);
  b[2] = Number((ms >> 24n) & 0xffn);
  b[3] = Number((ms >> 16n) & 0xffn);
  b[4] = Number((ms >> 8n) & 0xffn);
  b[5] = Number(ms & 0xffn);
  b[6] = (b[6] & 0x0f) | 0x70;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
const q = (s) => `'${String(s).replace(/'/g, "''")}'`; // SQL string literal
const j = (o) => `${q(JSON.stringify(o))}::jsonb`;
const sha256Hex = (s) => createHash("sha256").update(s).digest("hex"); // == sha256Hex in @assessiq/core
const pad = (n) => String(n).padStart(4, "0");
const out = [];
const emit = (s) => out.push(s);
function batchInsert(table, cols, rows, size = 200) {
  for (let i = 0; i < rows.length; i += size) {
    emit(`INSERT INTO ${table} (${cols}) VALUES\n${rows.slice(i, i + size).join(",\n")};`);
  }
}

// ---- ids ------------------------------------------------------------------
const tenantId = uuidv7();
const adminId = uuidv7();
const packId = uuidv7();
const levelId = uuidv7();
const assessmentId = uuidv7();
const tagIds = ["loadtest", "mcq", "subjective"].map((name) => ({ id: uuidv7(), name }));

// ---- question content -----------------------------------------------------
const MCQ_COUNT = 40;
const SUBJ_COUNT = 5;
const questions = [];
for (let n = 1; n <= MCQ_COUNT; n++) {
  const correct = n % 4;
  questions.push({
    id: uuidv7(),
    type: "mcq",
    points: 1,
    content: {
      question: `Load test question ${n}: pick option ${String.fromCharCode(65 + correct)}.`,
      options: ["Option A", "Option B", "Option C", "Option D"],
      correct,
      rationale: `Option ${String.fromCharCode(65 + correct)} is correct by construction (synthetic load-test item).`,
    },
    rubric: null,
  });
}
for (let n = 1; n <= SUBJ_COUNT; n++) {
  questions.push({
    id: uuidv7(),
    type: "subjective",
    points: 5,
    content: { question: `Load test written question ${n}: describe in two sentences how you would test a web login page.` },
    rubric: {
      anchors: [
        { id: "a1", concept: "test valid and invalid input", weight: 60, synonyms: ["invalid input", "wrong password"] },
        { id: "a2", concept: "check error messages", weight: 40, synonyms: ["error message"] },
      ],
      reasoning_bands: { band_4: "Complete and precise.", band_3: "Mostly complete.", band_2: "Partly complete.", band_1: "Minimal.", band_0: "No relevant content." },
      anchor_weight_total: 70,
      reasoning_weight_total: 30,
    },
  });
}

// ---- tokens ---------------------------------------------------------------
function makeTokens(count) {
  return Array.from({ length: count }, () => {
    const plaintext = randomBytes(32).toString("base64url");
    return { plaintext, hash: sha256Hex(plaintext) };
  });
}
const mainTokens = makeTokens(USERS);
const warmTokens = makeTokens(WARM);
const hashSet = new Set([...mainTokens, ...warmTokens].map((t) => t.hash));
if (hashSet.size !== USERS + WARM) fail("token collision (retry)"); // 2^-256 odds; guard anyway

// ---- SQL ------------------------------------------------------------------
emit(`-- loadtest tenant_id=${tenantId} slug=${SLUG} users=${USERS} warmup_users=${WARM}`);
emit(`\\set ON_ERROR_STOP on`);
emit(`BEGIN;`);
emit(`DO $$ BEGIN IF EXISTS (SELECT 1 FROM tenants WHERE slug = ${q(SLUG)}) THEN RAISE EXCEPTION 'tenant slug ${SLUG} already exists (seed already applied)'; END IF; END $$;`);

// 1. tenant. Same minimal rows as createTenant (02-tenancy/src/service.ts) plus the plan row
//    that provisionDefaultPlan writes. tier 'internal' = no entitlement gate, no credit or candidate cap.
emit(`INSERT INTO tenants (id, slug, name, status, self_registered, is_school) VALUES (${q(tenantId)}, ${q(SLUG)}, ${q("Load test " + runId)}, 'active', false, false);`);
emit(`INSERT INTO tenant_settings (tenant_id, ai_grading_enabled, ai_grading_scope, camera_enabled, camera_photos_enabled, camera_notice_confirmed_version, camera_notice_confirmed_at, camera_notice_confirmed_by) VALUES (${q(tenantId)}, false, 'none', false, false, NULL, NULL, NULL);`);
emit(`INSERT INTO tenant_plans (tenant_id, tier, included_credits, status, notes) VALUES (${q(tenantId)}, 'internal', NULL, 'active', ${q("load test " + runId + " - safe to archive")});`);
emit(`INSERT INTO audit_log (tenant_id, actor_kind, action, entity_type, entity_id, after) VALUES (${q(tenantId)}, 'system', 'tenant.provisioned', 'tenant', ${q(tenantId)}, ${j({ slug: SLUG, source: "tools/load-test/seed-test-tenant.mjs" })});`);

// 3. users (admin first: packs/questions/assessments need created_by)
emit(`INSERT INTO users (id, tenant_id, email, name, role, status) VALUES (${q(adminId)}, ${q(tenantId)}, ${q("lt-admin@loadtest.invalid")}, 'Load Test Admin', 'admin', 'active');`);
const userRows = [];
const candidates = []; // {id, kind, idx}
for (let i = 1; i <= USERS; i++) candidates.push({ id: uuidv7(), email: `lt-${pad(i)}@loadtest.invalid`, name: `LT Candidate ${pad(i)}`, tok: mainTokens[i - 1] });
for (let i = 1; i <= WARM; i++) candidates.push({ id: uuidv7(), email: `ltw-${pad(i)}@loadtest.invalid`, name: `LT Warmup ${pad(i)}`, tok: warmTokens[i - 1] });
for (const c of candidates) userRows.push(`(${q(c.id)}, ${q(tenantId)}, ${q(c.email)}, ${q(c.name)}, 'candidate', 'active')`);
batchInsert("users", "id, tenant_id, email, name, role, status", userRows);
batchInsert("tenant_candidate_counted", "tenant_id, user_id", candidates.map((c) => `(${q(tenantId)}, ${q(c.id)})`));

// 2. content. State after pack publish (04-question-bank publishPack): pack published + version 2,
//    questions active + version 2, one question_versions snapshot at version 1.
emit(`INSERT INTO question_packs (id, tenant_id, slug, name, domain, description, status, version, created_by, source) VALUES (${q(packId)}, ${q(tenantId)}, ${q("loadtest-" + runId)}, ${q("Load test pack " + runId)}, 'loadtest', 'Synthetic questions for the load test.', 'published', 2, ${q(adminId)}, 'authored');`);
emit(`INSERT INTO levels (id, pack_id, position, label, description, duration_minutes, default_question_count, passing_score_pct) VALUES (${q(levelId)}, ${q(packId)}, 1, 'Load test level', NULL, 30, 20, 60);`);
batchInsert("tags", "id, tenant_id, name", tagIds.map((t) => `(${q(t.id)}, ${q(tenantId)}, ${q(t.name)})`));
batchInsert(
  "questions",
  "id, pack_id, level_id, type, topic, points, status, version, content, rubric, created_by, cognitive_level, language_primary, review_state",
  questions.map((x) => `(${q(x.id)}, ${q(packId)}, ${q(levelId)}, ${q(x.type)}, 'loadtest', ${x.points}, 'active', 2, ${j(x.content)}, ${x.rubric ? j(x.rubric) : "NULL"}, ${q(adminId)}, 'remember', 'en', 'verified')`),
  20,
);
batchInsert(
  "question_versions",
  "id, question_id, version, content, rubric, saved_by, type",
  questions.map((x) => `(${q(uuidv7())}, ${q(x.id)}, 1, ${j(x.content)}, ${x.rubric ? j(x.rubric) : "NULL"}, ${q(adminId)}, ${q(x.type)})`),
  20,
);
batchInsert(
  "question_source",
  "tenant_id, question_id, origin, rights_status",
  questions.map((x) => `(${q(tenantId)}, ${q(x.id)}, 'original_human', 'original')`),
);
const tagRows = [];
for (const x of questions) {
  tagRows.push(`(${q(x.id)}, ${q(tagIds[0].id)})`);
  tagRows.push(`(${q(x.id)}, ${q(x.type === "mcq" ? tagIds[1].id : tagIds[2].id)})`);
}
batchInsert("question_tags", "question_id, tag_id", tagRows);

// 4. assessment: status as after publish + boundary activation. pack_version = pack.version (2).
emit(`INSERT INTO assessments (id, tenant_id, pack_id, level_id, pack_version, name, description, status, question_count, randomize, opens_at, closes_at, settings, created_by, passing_score_pct, max_attempts, delivery_mode, duration_minutes) VALUES (${q(assessmentId)}, ${q(tenantId)}, ${q(packId)}, ${q(levelId)}, 2, ${q("Load test assessment " + runId)}, 'Synthetic mock assessment for the load test.', 'active', 20, true, now() - interval '1 hour', now() + interval '${EXPIRES_DAYS} days', '{}'::jsonb, ${q(adminId)}, 60, NULL, 'mock', 30);`);
// What publishAssessment freezes (lifecycle.ts freezeAssessmentPool): active questions of pack+level at MAX(version).
batchInsert(
  "assessment_frozen_pool",
  "tenant_id, assessment_id, question_id, question_version, level_id, domain_id, category_id, type, points",
  questions.map((x) => `(${q(tenantId)}, ${q(assessmentId)}, ${q(x.id)}, 1, ${q(levelId)}, NULL, NULL, ${q(x.type)}, ${x.points})`),
);
emit(`INSERT INTO audit_log (tenant_id, actor_kind, action, entity_type, entity_id, after) VALUES (${q(tenantId)}, 'system', 'assessment.published', 'assessment', ${q(assessmentId)}, ${j({ status: "active", question_count: 20, frozen_pool_size: questions.length, source: "load-test seed" })});`);

// 5. invitations: mock, pending, hash only. Plaintext never goes into the SQL.
batchInsert(
  "assessment_invitations",
  "id, assessment_id, user_id, token_hash, expires_at, status, invited_by, delivery_mode",
  candidates.map((c) => `(${q(uuidv7())}, ${q(assessmentId)}, ${q(c.id)}, ${q(c.tok.hash)}, now() + interval '${EXPIRES_DAYS} days', 'pending', ${q(adminId)}, 'mock')`),
);

// Sanity gates inside the transaction: any mismatch aborts the whole seed.
emit(`DO $$ DECLARE n int; BEGIN
  SELECT count(*) INTO n FROM assessment_invitations WHERE assessment_id = ${q(assessmentId)};
  IF n <> ${USERS + WARM} THEN RAISE EXCEPTION 'expected ${USERS + WARM} invitations, got %', n; END IF;
  SELECT count(*) INTO n FROM questions WHERE pack_id = ${q(packId)} AND status = 'active';
  IF n < 20 THEN RAISE EXCEPTION 'active pool too small: %', n; END IF;
END $$;`);
emit(`COMMIT;`);

// ---- write token files, then SQL ------------------------------------------
try {
  writeFileSync(opts["tokens-out"], mainTokens.map((t) => t.plaintext).join("\n") + "\n", { flag: "wx", mode: 0o600 });
  if (WARM > 0) writeFileSync(opts["warmup-out"], warmTokens.map((t) => t.plaintext).join("\n") + "\n", { flag: "wx", mode: 0o600 });
} catch (e) {
  fail(`cannot write token file (existing files are never overwritten): ${e.code ?? e.message}`);
}
process.stdout.write(out.join("\n") + "\n");
process.stderr.write(`seed-test-tenant: tenant ${SLUG} (${tenantId}); ${USERS} main + ${WARM} warm-up tokens written to files\n`);
