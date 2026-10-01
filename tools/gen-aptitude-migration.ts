/**
 * tools/gen-aptitude-migration.ts
 *
 * Generates docs/exam-content/0109_seed_platform_aptitude_pack.sql (gitignored, local only)
 * from an aptitude-question JSON file. The SQL is idempotent (safe to re-run).
 * It holds question text + answer keys, so it must never be committed (public repo):
 * apply it on the VPS by hand, or load questions via POST /api/admin/questions/import.
 *
 * Usage:
 *   pnpm tsx tools/gen-aptitude-migration.ts <questions.json> [--out <file.sql>] [--publish]
 *
 *   default  pack + questions land as 'draft' (super_admin reviews, then clicks
 *            Publish in the UI -> canonical publishPack path: snapshots, audit row).
 *   --publish pack lands 'published' (version 2), questions 'active' (version 2) with a
 *            question_versions v1 snapshot — the exact end-state publishPack leaves.
 *
 * Input: { pack:{name,description}, questions:[{id,category,difficulty,topic,stem,
 *          options[],correct_index,explanation}] }
 *
 * See docs/design (aptitude pack) / SESSION notes for the why. Pure function
 * `generateAptitudeSql` is exported for the integration test.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface AptitudeQuestion {
  id: string;
  category: "quantitative" | "logical" | "verbal";
  difficulty: "L1" | "L2";
  topic: string;
  stem: string;
  options: string[];
  correct_index: number;
  explanation: string;
}
export interface AptitudeInput {
  pack: { name: string; description: string };
  questions: AptitudeQuestion[];
}

export const PACK_SLUG = "campus-placement-aptitude";
export const DOMAIN_SLUG = "aptitude";
const CATEGORY: Record<AptitudeQuestion["category"], { slug: string; name: string; score: number }> = {
  quantitative: { slug: "quantitative-aptitude", name: "Quantitative Aptitude", score: 3 },
  logical: { slug: "logical-reasoning", name: "Logical Reasoning", score: 2 },
  verbal: { slug: "verbal-ability", name: "Verbal Ability", score: 1 },
};
const LEVEL_POS = { L1: 1, L2: 2 } as const;

/** Validate input; throws with every problem listed. Mirrors McqContentSchema constraints. */
export function validateInput(d: AptitudeInput): void {
  const errs: string[] = [];
  const nonEmpty = (s: unknown): s is string => typeof s === "string" && s.trim().length > 0 && !s.includes("\u0000");
  if (!nonEmpty(d?.pack?.name)) errs.push("pack.name required");
  if (!nonEmpty(d?.pack?.description)) errs.push("pack.description required");
  if (!Array.isArray(d?.questions) || d.questions.length === 0) errs.push("questions[] required");
  const seen = new Set<string>();
  for (const q of d?.questions ?? []) {
    const w = `question ${q?.id}`;
    if (!nonEmpty(q.id)) errs.push(`${w}: id required`);
    if (seen.has(q.id)) errs.push(`${w}: duplicate id`);
    seen.add(q.id);
    if (!(q.category in CATEGORY)) errs.push(`${w}: bad category '${q.category}'`);
    if (!(q.difficulty in LEVEL_POS)) errs.push(`${w}: bad difficulty '${q.difficulty}'`);
    for (const f of ["topic", "stem", "explanation"] as const) if (!nonEmpty(q[f])) errs.push(`${w}: ${f} required`);
    if (!Array.isArray(q.options) || q.options.length < 2 || q.options.length > 8 || !q.options.every(nonEmpty)) {
      errs.push(`${w}: options must be 2-8 non-empty strings`);
    } else if (new Set(q.options.map((o) => o.trim())).size !== q.options.length) {
      errs.push(`${w}: duplicate options`);
    }
    if (!Number.isInteger(q.correct_index) || q.correct_index < 0 || q.correct_index >= (q.options?.length ?? 0)) {
      errs.push(`${w}: correct_index out of range`);
    }
  }
  if (errs.length > 0) throw new Error(`Invalid aptitude input:\n - ${errs.join("\n - ")}`);
}

/** Dollar-quote a string with a tag whose `$tag` prefix is absent from it (no escaping needed). */
function dq(s: string): string {
  let tag = "aq";
  for (let i = 0; s.includes(`$${tag}`); i++) tag = `aq${i}`;
  return `$${tag}$${s}$${tag}$`;
}

export function generateAptitudeSql(d: AptitudeInput, opts: { publish?: boolean; inputSha?: string } = {}): string {
  validateInput(d);
  const publish = opts.publish === true;
  const qs = d.questions;
  const levelCount = (pos: 1 | 2) => qs.filter((q) => LEVEL_POS[q.difficulty] === pos).length;

  const catValues = Object.values(CATEGORY)
    .map((c) => `(${dq(c.slug)}, ${dq(c.name)}, ${c.score})`)
    .join(",\n      ");

  const levelDefs = ([1, 2] as const)
    .filter((p) => levelCount(p) > 0)
    .map((p) => {
      const n = levelCount(p);
      const desc = p === 1 ? "Foundation: core campus-placement aptitude." : "Advanced: multi-step aptitude problems.";
      // ponytail: 1.5 min/question, floor 10 — tune per pilot feedback (levels are editable in UI).
      return `(${p}, 'L${p}', ${dq(desc)}, ${Math.max(10, Math.ceil(n * 1.5))}, ${n}, 60)`;
    })
    .join(",\n      ");

  const qValues = qs
    .map((q) => {
      const content = JSON.stringify({
        question: q.stem,
        options: q.options,
        correct: q.correct_index,
        rationale: q.explanation,
      });
      return `(${dq(q.id)}, ${LEVEL_POS[q.difficulty]}, ${dq(CATEGORY[q.category].slug)}, ${dq(q.topic)}, ${dq(content)})`;
    })
    .join(",\n      ");

  const qStatus = publish ? "'active'" : "'draft'";
  const qVersion = publish ? 2 : 1;
  const packStatus = publish ? "'published'" : "'draft'";
  const packVersion = publish ? 2 : 1;

  return `-- owned by modules/04-question-bank
-- 0109_seed_platform_aptitude_pack.sql
-- GENERATED by tools/gen-aptitude-migration.ts — do not hand-edit; regenerate and, if this
-- file was already applied anywhere, ship the change as a NEW migration (checksum drift gate).
-- Input sha256: ${opts.inputSha ?? "n/a"} | questions: ${qs.length} | mode: ${publish ? "published" : "draft"}
--
-- WHAT: seeds the platform-library "Aptitude" domain (3 categories, MCQ only) and the
--   "${d.pack.name.replace(/\s+/g, " ")}" pack with ${qs.length} MCQ questions into the PLATFORM tenant, and
--   registers the domain (+ categories) in every company tenant exactly like
--   platform-domains.ts createPlatformDomain (INSERT ... source='platform', ON CONFLICT DO NOTHING).
-- WHY in SQL: the content is static seed data; same sanctioned pattern as 0019/0083.
--   Tenants still need an entitlement (domain 'aptitude' or this pack) to use it.
-- MODE ${publish ? "published: pack published v2, questions active v2 + question_versions v1 snapshot (publishPack end-state)" : "draft: pack + questions draft v1; super_admin clicks Publish in the UI (snapshots + audit + auto-activate)"}.
-- IDEMPOTENT: domains/categories ON CONFLICT DO NOTHING; pack guarded by slug; questions have
--   deterministic ids (md5 of the external id) + ON CONFLICT DO NOTHING. Re-run = no-op.
-- NO-OP (with NOTICE) when the platform tenant or a platform super_admin/admin user is absent
--   (fresh DB before the manual platform bootstrap) — re-apply with
--   'tools/migrate.ts --force-rerun 0109_seed_platform_aptitude_pack.sql' after bootstrap.

DO $aptmig$
DECLARE
  v_platform uuid;
  v_user     uuid;
  v_domain   uuid;
  v_pack     uuid;
  v_have     int;
BEGIN
  SELECT id INTO v_platform FROM tenants WHERE slug = 'platform' LIMIT 1;
  IF v_platform IS NULL THEN
    RAISE NOTICE '0109: platform tenant absent — skipping aptitude seed';
    RETURN;
  END IF;

  SELECT id INTO v_user FROM users
   WHERE tenant_id = v_platform AND role IN ('super_admin', 'admin')
     AND status = 'active' AND deleted_at IS NULL
   ORDER BY (role = 'super_admin') DESC, created_at ASC LIMIT 1;
  IF v_user IS NULL THEN
    RAISE NOTICE '0109: no active platform super_admin/admin user — skipping aptitude seed';
    RETURN;
  END IF;

  -- 1. Canonical platform domain (display_order = MAX+1 within the platform tenant).
  INSERT INTO domains (tenant_id, slug, name, description, source, status, display_order)
  SELECT v_platform, ${dq(DOMAIN_SLUG)}, 'Aptitude',
         'Campus-placement aptitude: quantitative, logical and verbal ability (MCQ).',
         'platform', 'active',
         COALESCE((SELECT MAX(display_order) FROM domains WHERE tenant_id = v_platform), 0) + 1
  ON CONFLICT (tenant_id, slug) DO NOTHING;

  -- 2. Propagate to every NON-platform tenant (same SQL as createPlatformDomain).
  INSERT INTO domains (tenant_id, slug, name, description, source, status, display_order)
  SELECT t.id, pd.slug, pd.name, pd.description, 'platform', 'active',
         COALESCE((SELECT MAX(d.display_order) FROM domains d WHERE d.tenant_id = t.id), 0) + 1
    FROM tenants t
    CROSS JOIN (SELECT slug, name, description FROM domains
                 WHERE tenant_id = v_platform AND slug = ${dq(DOMAIN_SLUG)}) pd
   WHERE t.id <> v_platform
  ON CONFLICT (tenant_id, slug) DO NOTHING;

  SELECT id INTO v_domain FROM domains WHERE tenant_id = v_platform AND slug = ${dq(DOMAIN_SLUG)};

  -- 3. Categories (MCQ only) in the platform tenant AND every tenant holding a platform-origin
  --    copy of the domain (never under a tenant-LOCAL 'aptitude' domain — same guard as seed.ts).
  --    createPlatformDomain does not propagate categories; clone-on-use self-heals them, but we
  --    register them up front so the taxonomy is complete at once.
  INSERT INTO categories (tenant_id, domain_id, slug, name, relevance_score, default_selected,
                          supported_types, default_question_count, status)
  SELECT d.tenant_id, d.id, c.slug, c.name, c.score, true, '["mcq"]'::jsonb, 1, 'active'
    FROM domains d
    CROSS JOIN (VALUES
      ${catValues}
    ) AS c(slug, name, score)
   WHERE d.slug = ${dq(DOMAIN_SLUG)} AND d.source = 'platform'
  ON CONFLICT (tenant_id, domain_id, slug) DO NOTHING;

  -- 4. Pack (platform tenant). Skipped if a pack with this slug already exists.
  INSERT INTO question_packs (id, tenant_id, slug, name, domain, description, status, version, created_by)
  SELECT md5('assessiq:aptitude:pack')::uuid, v_platform, ${dq(PACK_SLUG)}, ${dq(d.pack.name)},
         ${dq(DOMAIN_SLUG)}, ${dq(d.pack.description)}, ${packStatus}, ${packVersion}, v_user
   WHERE NOT EXISTS (SELECT 1 FROM question_packs WHERE tenant_id = v_platform AND slug = ${dq(PACK_SLUG)});

  SELECT id INTO v_pack FROM question_packs
   WHERE tenant_id = v_platform AND slug = ${dq(PACK_SLUG)} ORDER BY version DESC LIMIT 1;

  -- 5. Levels (L1/L2 -> position 1/2; only levels that have questions).
  INSERT INTO levels (pack_id, position, label, description, duration_minutes, default_question_count, passing_score_pct)
  SELECT v_pack, l.position, l.label, l.description, l.duration, l.cnt, l.pass
    FROM (VALUES
      ${levelDefs}
    ) AS l(position, label, description, duration, cnt, pass)
  ON CONFLICT (pack_id, position) DO NOTHING;

  -- 6. Questions: 1 point each, MCQ content = {question, options, correct, rationale}
  --    (McqContentSchema, strict). Deterministic ids make re-runs no-ops.
  INSERT INTO questions (id, pack_id, level_id, type, topic, points, status, version, content,
                         created_by, domain_id, category_id)
  SELECT md5('assessiq:aptitude:' || v.ext_id)::uuid, v_pack, lv.id, 'mcq', v.topic, 1,
         ${qStatus}, ${qVersion}, v.content::jsonb, v_user, v_domain, c.id
    FROM (VALUES
      ${qValues}
    ) AS v(ext_id, level_pos, cat_slug, topic, content)
    JOIN levels lv ON lv.pack_id = v_pack AND lv.position = v.level_pos
    JOIN categories c ON c.tenant_id = v_platform AND c.domain_id = v_domain AND c.slug = v.cat_slug
  ON CONFLICT (id) DO NOTHING;
${
  publish
    ? `
  -- 7. v1 snapshot (what publishPack writes before bumping version 1 -> 2).
  INSERT INTO question_versions (question_id, version, content, rubric, saved_by)
  SELECT q.id, 1, q.content, q.rubric, v_user
    FROM questions q
   WHERE q.pack_id = v_pack AND q.id IN (SELECT md5('assessiq:aptitude:' || e)::uuid FROM unnest(ARRAY[${qs.map((q) => dq(q.id)).join(", ")}]) AS e)
  ON CONFLICT (question_id, version) DO NOTHING;
`
    : ""
}
  -- 8. Integrity guard: every expected question must exist (a silent JOIN drop would fail here).
  SELECT count(*) INTO v_have FROM questions
   WHERE pack_id = v_pack AND id IN (SELECT md5('assessiq:aptitude:' || e)::uuid
         FROM unnest(ARRAY[${qs.map((q) => dq(q.id)).join(", ")}]) AS e);
  IF v_have <> ${qs.length} THEN
    RAISE EXCEPTION '0109: expected ${qs.length} aptitude questions, found %', v_have;
  END IF;
END
$aptmig$;
`;
}

// ---- CLI -------------------------------------------------------------------
const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const input = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--out");
  if (input === undefined) {
    console.error("usage: tsx tools/gen-aptitude-migration.ts <questions.json> [--out file.sql] [--publish]");
    process.exit(2);
  }
  const outIdx = args.indexOf("--out");
  const out =
    outIdx >= 0
      ? args[outIdx + 1]!
      : path.resolve(
          path.dirname(fileURLToPath(import.meta.url)),
          // ponytail: exam content stays out of git (public repo) — docs/ is gitignored.
          "../docs/exam-content/0109_seed_platform_aptitude_pack.sql",
        );
  const raw = readFileSync(input, "utf8");
  const sql = generateAptitudeSql(JSON.parse(raw) as AptitudeInput, {
    publish: args.includes("--publish"),
    inputSha: createHash("sha256").update(raw).digest("hex"),
  });
  mkdirSync(path.dirname(out), { recursive: true }); // docs/ is gitignored, so the folder may not exist
  writeFileSync(out, sql, "utf8");
  console.log(`wrote ${out} (${sql.length} bytes)`);
}
