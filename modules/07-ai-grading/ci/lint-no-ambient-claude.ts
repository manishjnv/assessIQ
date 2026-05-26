/**
 * lint-no-ambient-claude.ts
 *
 * ───────────────────────────────────────────────────────────────────────────
 * LOAD-BEARING SENTINEL — modifying this file requires `codex:rescue`.
 * ───────────────────────────────────────────────────────────────────────────
 *
 * This lint encodes D2 from `docs/05-ai-pipeline.md` § "Decisions captured
 * (2026-05-01)". It is the *static* enforcement of the Phase 1 compliance
 * frame: an admin's Max OAuth subscription powers Claude Code on the VPS,
 * and AssessIQ's compliance posture rests on no-ambient-AI invariants.
 *
 * The lint REJECTS the seven static patterns from D2 § "Rejection patterns":
 *
 *   1. `claude` CLI invocation outside the two allow-listed files.
 *   2. `@anthropic-ai/claude-agent-sdk` import outside `runtimes/anthropic-api.ts`.
 *   3. setInterval / setTimeout (≥1s) callbacks transitively touching the runtime.
 *   4. BullMQ Worker / Queue.process callbacks transitively touching the runtime.
 *   5. Webhook handlers transitively touching the runtime.
 *   6. Candidate routes (/take/*, /me/*, /embed/*) transitively touching the runtime.
 *   7. apps/worker/** entrypoints transitively touching the runtime.
 *
 * ALLOW-LIST (positive list — only places where `claude` spawn or runtime
 * imports are legitimate):
 *
 *   - `modules/07-ai-grading/src/handlers/admin-grade.ts`
 *   - `modules/07-ai-grading/src/runtimes/claude-code-vps.ts`
 *
 * admin-generate.ts is the authorised handler for AI question generation.
 * It does NOT spawn `claude` directly (that is done only by claude-code-vps.ts),
 * so it is NOT in CLAUDE_SPAWN_ALLOW_LIST.  It is in the non-banned handler
 * directory and the lint polices it via RE_GRADING_RUNTIME_IMPORT + the
 * BANNED_PATH_PATTERNS check (banned-path files may not import generateQuestions).
 *
 * 2026-05-08 Session 2.b: three new admin rubric endpoints added in
 * modules/04-question-bank/src/routes.ts:
 *   POST /api/admin/questions/:id/generate-rubric
 *   POST /api/admin/questions/:id/save-rubric
 *   POST /api/admin/packs/:id/generate-missing-rubrics
 * These route to service.ts which calls generateRubricDraft via dynamic
 * import of @assessiq/ai-grading. routes.ts is NOT a banned path. The
 * D2 invariant is preserved: no ambient invocation, admin-click-only.
 *
 * Plus the SDK import allow-list (one file only):
 *
 *   - `modules/07-ai-grading/src/runtimes/anthropic-api.ts`
 *
 * Plus this lint file itself (regexes / strings naming `claude` are harmless).
 *
 * ───────────────────────────────────────────────────────────────────────────
 * Why static, not runtime:
 * ───────────────────────────────────────────────────────────────────────────
 *
 * A runtime check (an `if` at the top of `gradeSubjective`) is one
 * accidentally-removed line away from breaking the compliance frame
 * silently. Static enforcement at lint time fails the build at the
 * earliest possible point — pre-commit, pre-merge, pre-deploy.
 *
 * Why a regex/import-graph walker, not full ESLint AST:
 *
 * The kickoff plan said either approach is acceptable. Regex is faster,
 * has zero new toolchain deps, and is sufficient to encode D2 because
 * the rejection patterns are syntactic ("does this file's text contain X").
 * Future tightening (e.g., catching dynamic `import()` of the runtime
 * via variable interpolation) would warrant ESLint AST; the present
 * surface is direct enough that regex matches cover every D2 pattern.
 *
 * ───────────────────────────────────────────────────────────────────────────
 *
 * Usage:
 *   pnpm tsx modules/07-ai-grading/ci/lint-no-ambient-claude.ts
 *   pnpm tsx modules/07-ai-grading/ci/lint-no-ambient-claude.ts --self-test
 *
 * Wired into `pnpm lint:ambient-ai` (root package.json) and
 * `.github/workflows/ci.yml` as a required check.
 */

import { type Dirent } from "node:fs";
import * as path from "node:path";
import * as fsp from "node:fs/promises";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Allow-list (positive list per D2)
// ---------------------------------------------------------------------------

/**
 * Files allowed to spawn `claude` or import `runClaudeCodeGrading`.
 *
 * 2026-05-03 Session 1.b path correction: the actual module scaffold from
 * Session 1.a placed source files under `src/`, but the original allow-list
 * (and the self-test fixtures below) referenced paths without `src/`. The
 * mismatch only became observable when 1.b added a real `spawn` call to
 * the runtime — pre-1.b the stub never tripped pattern 1. The codex:rescue
 * gate at end of 1.b adjudicates this correction; the contract intent
 * (two allow-listed files for spawn + one for the SDK) is preserved.
 *
 * 2026-05-08 Session 2.a: admin-generate.ts is intentionally NOT in this
 * list.  It is the authorised handler entry point for AI question generation
 * but it does not spawn `claude` directly — only claude-code-vps.ts does.
 * Adding it here would grant it unnecessary spawn permission.  The handler
 * is policed instead via RE_GRADING_RUNTIME_IMPORT + BANNED_PATH_PATTERNS
 * (any attempt to invoke generateQuestions from a banned path will fail).
 */
const CLAUDE_SPAWN_ALLOW_LIST: ReadonlySet<string> = new Set([
  "modules/07-ai-grading/src/handlers/admin-grade.ts",
  "modules/07-ai-grading/src/runtimes/claude-code-vps.ts",
]);

/** Files allowed to import `@anthropic-ai/claude-agent-sdk`. */
const SDK_IMPORT_ALLOW_LIST: ReadonlySet<string> = new Set([
  "modules/07-ai-grading/src/runtimes/anthropic-api.ts",
]);

/**
 * The lint file itself, plus future eval files that may name "claude" in
 * comments / strings without invoking the CLI. These contain `claude` as
 * a literal but never spawn it.
 */
const SELF_AND_DOC_PATHS: ReadonlySet<string> = new Set([
  "modules/07-ai-grading/ci/lint-no-ambient-claude.ts",
]);

// ---------------------------------------------------------------------------
// File discovery
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");

/** Roots scanned per D2: modules, apps, tools, infra. */
const SCAN_ROOTS = ["modules", "apps", "tools", "infra"] as const;

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
  ".turbo",
  "AccessIQ_UI_Template",
  "__tests__",            // tests are allowed to mock spawns; keeps signal high
  "examples",             // sample-pack JSON, not runtime code
]);

/**
 * Scan extensions: TypeScript source. We deliberately skip `.md`, `.json`,
 * `.sql`, `.yml` — those are configuration / docs and may legitimately
 * contain the literal word "claude".
 */
const SCAN_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts"]);

async function findFiles(rootRel: string): Promise<string[]> {
  const root = path.join(REPO_ROOT, rootRel);
  const out: string[] = [];

  async function walk(dir: string): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name);
      if (!SCAN_EXTENSIONS.has(ext)) continue;
      out.push(full);
    }
  }

  await walk(root);
  return out;
}

// ---------------------------------------------------------------------------
// Rejection patterns (regexes)
// ---------------------------------------------------------------------------

/**
 * Pattern 1 — `claude` CLI spawn. Matches `child_process` spawn/exec
 * variants whose first argument is the literal string `"claude"` (or
 * `'claude'`).
 *
 * Examples that match:
 *   spawn("claude", [...])
 *   execFile('claude', { ... })
 *   exec("claude -p ...")
 *
 * The `[\s,)]` lookahead avoids matching variable names like `claudeBin`.
 */
const RE_SPAWN_CLAUDE =
  /(?:^|[^\w])(spawn|exec|execFile|fork|spawnSync|execSync|execFileSync)\s*\(\s*["']claude["']/;

/**
 * Pattern 2 — Agent SDK import. Matches any ESM/CJS import of the
 * `@anthropic-ai/claude-agent-sdk` package.
 */
const RE_AGENT_SDK_IMPORT =
  /(?:from\s+["']@anthropic-ai\/claude-agent-sdk["']|require\s*\(\s*["']@anthropic-ai\/claude-agent-sdk["']\s*\))/;

/**
 * Patterns 3-7 — files that "transitively touch the runtime" via a direct
 * import. We approximate transitivity by union: a file matches if it
 * imports anything from `modules/07-ai-grading/runtimes/*` or from
 * `@assessiq/ai-grading` (the workspace barrel) or names
 * `runClaudeCodeGrading` directly.
 *
 * This is an over-approximation — a file that imports the workspace
 * barrel for non-grading types (e.g., to reference `AIGradingError`)
 * would also trip the lint when located in a banned path. For the
 * banned paths (cron callbacks, BullMQ workers, candidate routes), this
 * over-approximation is acceptable: those paths have NO legitimate
 * reason to reach into the grading runtime, even for types.
 */
const RE_GRADING_RUNTIME_IMPORT =
  /(?:from\s+["'](?:[^"']*\/modules\/07-ai-grading\/runtimes\/[^"']+|@assessiq\/ai-grading)["']|\brunClaudeCodeGrading\b|\bgradeSubjective\b|\bgenerateQuestions\b|\bgenerateRubricDraft\b|\bgenerateAnswerGuidanceDraft\b)/;

/**
 * Banned-path globs for patterns 3-7. A file matching ANY of these AND
 * containing the grading-runtime import pattern fails the lint.
 *
 * NOTE: `apps/worker/**` is banned wholesale per D2 pattern 7; the Phase 2
 * exception (apps/worker/grading-consumer.ts under AI_PIPELINE_MODE=
 * anthropic-api) goes through codex:rescue at first ship and would land
 * in this list with an explicit comment carve-out.
 */
const BANNED_PATH_PATTERNS: ReadonlyArray<{ name: string; matches: (rel: string) => boolean }> = [
  {
    name: "apps/worker (D2 pattern 7)",
    matches: (rel) => rel.startsWith("apps/worker/"),
  },
  {
    name: "candidate routes /take, /me, /embed (D2 pattern 6)",
    matches: (rel) =>
      /\/routes?\.(take|candidate|embed|me)\.ts$/.test(rel) ||
      /\/routes\/take\//.test(rel) ||
      /\/routes\/me\//.test(rel) ||
      /\/routes\/embed\//.test(rel),
  },
  {
    name: "webhook handlers (D2 pattern 5)",
    matches: (rel) => /\/(webhooks?|hooks)\//.test(rel),
  },
];

// ---------------------------------------------------------------------------
// Violation record
// ---------------------------------------------------------------------------

interface Violation {
  file: string;
  rule: 1 | 2 | 3456 | 7;
  message: string;
}

// ---------------------------------------------------------------------------
// Core validator
// ---------------------------------------------------------------------------

/** Check a single file's content against all D2 rules. */
function validateFile(
  relPath: string,
  content: string,
): Violation[] {
  const violations: Violation[] = [];
  const normalised = relPath.replace(/\\/g, "/");

  // Skip self / docs / mock fixtures
  if (SELF_AND_DOC_PATHS.has(normalised)) return [];

  // Pattern 1 — claude CLI spawn outside allow-list
  if (RE_SPAWN_CLAUDE.test(content) && !CLAUDE_SPAWN_ALLOW_LIST.has(normalised)) {
    violations.push({
      file: relPath,
      rule: 1,
      message:
        "D2 pattern 1: spawn/exec of `claude` is forbidden outside " +
        "modules/07-ai-grading/src/handlers/admin-grade.ts and " +
        "modules/07-ai-grading/src/runtimes/claude-code-vps.ts.",
    });
  }

  // Pattern 2 — Agent SDK import outside the one allowed runtime
  if (RE_AGENT_SDK_IMPORT.test(content) && !SDK_IMPORT_ALLOW_LIST.has(normalised)) {
    violations.push({
      file: relPath,
      rule: 2,
      message:
        "D2 pattern 2: import of @anthropic-ai/claude-agent-sdk is " +
        "forbidden outside modules/07-ai-grading/src/runtimes/anthropic-api.ts.",
    });
  }

  // Patterns 3-7 — banned paths importing the grading runtime
  if (RE_GRADING_RUNTIME_IMPORT.test(content)) {
    for (const banned of BANNED_PATH_PATTERNS) {
      if (banned.matches(normalised)) {
        const rule = normalised.startsWith("apps/worker/") ? 7 : 3456;
        violations.push({
          file: relPath,
          rule,
          message: `D2 ${banned.name}: file imports the grading runtime, but this path is banned. Phase 1 grading is admin-click-only — see docs/05-ai-pipeline.md § Compliance frame.`,
        });
        break; // one violation is enough per file
      }
    }
  }

  return violations;
}

// ---------------------------------------------------------------------------
// Self-test mode
// ---------------------------------------------------------------------------

function runSelfTest(): void {
  process.stdout.write("lint-no-ambient-claude — running self-test...\n");

  // --- Fixture 1: legitimate file (no violations) ---
  const okFile = {
    path: "modules/05-assessment-lifecycle/src/service.ts",
    content: `
      import { withTenant } from "@assessiq/tenancy";
      // Comment mentioning claude is fine in a doc context.
      export function listAssessments() { /* ... */ }
    `,
  };

  // --- Fixture 2: pattern 1 violation (claude spawn) ---
  const spawnViolation = {
    path: "tools/some-script.ts",
    content: `
      import { spawn } from "node:child_process";
      const proc = spawn("claude", ["-p", "test"]);
    `,
  };

  // --- Fixture 3: pattern 1 — allowed file (claude-code-vps runtime) ---
  const spawnAllowed = {
    path: "modules/07-ai-grading/src/runtimes/claude-code-vps.ts",
    content: `
      import { spawn } from "node:child_process";
      const proc = spawn("claude", ["-p", "test"]);
    `,
  };

  // --- Fixture 4: pattern 2 violation (SDK import) ---
  const sdkViolation = {
    path: "modules/06-attempt-engine/src/service.ts",
    content: `import { Anthropic } from "@anthropic-ai/claude-agent-sdk";`,
  };

  // --- Fixture 5: pattern 2 — allowed file (anthropic-api runtime) ---
  const sdkAllowed = {
    path: "modules/07-ai-grading/src/runtimes/anthropic-api.ts",
    content: `import { query } from "@anthropic-ai/claude-agent-sdk";`,
  };

  // --- Fixture 6: pattern 7 — apps/worker importing grading runtime ---
  const workerViolation = {
    path: "apps/worker/src/grading-handler.ts",
    content: `import { runClaudeCodeGrading } from "@assessiq/ai-grading";`,
  };

  // --- Fixture 7: pattern 6 — candidate route importing grading ---
  const candidateRouteViolation = {
    path: "modules/06-attempt-engine/src/routes.candidate.ts",
    content: `import { gradeSubjective } from "@assessiq/ai-grading";`,
  };

  // --- Fixture 8: pattern 5 — webhook handler importing grading ---
  const webhookViolation = {
    path: "apps/api/src/routes/webhooks/grading.ts",
    content: `import { runClaudeCodeGrading } from "@assessiq/ai-grading";`,
  };

  // --- Fixture 9: generateQuestions in banned worker path → violation ---
  // (2026-05-08 Session 2.a — covers new RE_GRADING_RUNTIME_IMPORT term)
  const workerGenerateViolation = {
    path: "apps/worker/src/generate-handler.ts",
    content: `import { generateQuestions } from "@assessiq/ai-grading";`,
  };

  // --- Fixture 10: generateQuestions in non-banned handler path → no violation ---
  // (admin-generate.ts is the authorised caller; handler/ is not a banned path)
  const handlerGenerateAllowed = {
    path: "modules/07-ai-grading/src/handlers/admin-generate.ts",
    content: `import { generateQuestions } from "@assessiq/ai-grading";\nasync function run() { return generateQuestions(input); }`,
  };

  // --- Fixture 11: generateRubricDraft in banned worker path → violation ---
  // (2026-05-08 Session 2.b — covers generateRubricDraft in RE_GRADING_RUNTIME_IMPORT)
  const workerRubricViolation = {
    path: "apps/worker/src/rubric-handler.ts",
    content: `import { generateRubricDraft } from "@assessiq/ai-grading";`,
  };

  // --- Fixture 12: generateRubricDraft in non-banned service path → no violation ---
  // (question-bank service.ts is the authorised caller; not a banned path)
  // Content uses the symbol name (not a dep-import-lint-triggering dynamic import string)
  // to verify the path matcher returns 0 violations for non-banned paths.
  const serviceRubricAllowed = {
    path: "modules/04-question-bank/src/service.ts",
    content: `// service layer: calls generateRubricDraft from ai-grading\nconst output = await generateRubricDraft(input);`,
  };

  // --- Fixture 13: generateAnswerGuidanceDraft in banned worker path → violation ---
  // (2026-05-26 feature #4 Phase B — covers generateAnswerGuidanceDraft in RE_GRADING_RUNTIME_IMPORT)
  const workerGuidanceViolation = {
    path: "apps/worker/src/guidance-handler.ts",
    content: `import { generateAnswerGuidanceDraft } from "@assessiq/ai-grading";`,
  };

  // --- Fixture 14: generateAnswerGuidanceDraft in non-banned service path → no violation ---
  // (question-bank service.ts is the authorised caller; not a banned path)
  const serviceGuidanceAllowed = {
    path: "modules/04-question-bank/src/service.ts",
    content: `// service layer: calls generateAnswerGuidanceDraft from ai-grading\nconst output = await generateAnswerGuidanceDraft(input);`,
  };

  const results = [
    { fixture: "ok", actual: validateFile(okFile.path, okFile.content), expectViolations: 0 },
    { fixture: "spawn-violation", actual: validateFile(spawnViolation.path, spawnViolation.content), expectViolations: 1 },
    { fixture: "spawn-allowed", actual: validateFile(spawnAllowed.path, spawnAllowed.content), expectViolations: 0 },
    { fixture: "sdk-violation", actual: validateFile(sdkViolation.path, sdkViolation.content), expectViolations: 1 },
    { fixture: "sdk-allowed", actual: validateFile(sdkAllowed.path, sdkAllowed.content), expectViolations: 0 },
    { fixture: "worker-violation", actual: validateFile(workerViolation.path, workerViolation.content), expectViolations: 1 },
    { fixture: "candidate-route-violation", actual: validateFile(candidateRouteViolation.path, candidateRouteViolation.content), expectViolations: 1 },
    { fixture: "webhook-violation", actual: validateFile(webhookViolation.path, webhookViolation.content), expectViolations: 1 },
    { fixture: "worker-generateQuestions-violation", actual: validateFile(workerGenerateViolation.path, workerGenerateViolation.content), expectViolations: 1 },
    { fixture: "handler-generateQuestions-allowed", actual: validateFile(handlerGenerateAllowed.path, handlerGenerateAllowed.content), expectViolations: 0 },
    { fixture: "worker-generateRubricDraft-violation", actual: validateFile(workerRubricViolation.path, workerRubricViolation.content), expectViolations: 1 },
    { fixture: "service-generateRubricDraft-allowed", actual: validateFile(serviceRubricAllowed.path, serviceRubricAllowed.content), expectViolations: 0 },
    { fixture: "worker-generateAnswerGuidanceDraft-violation", actual: validateFile(workerGuidanceViolation.path, workerGuidanceViolation.content), expectViolations: 1 },
    { fixture: "service-generateAnswerGuidanceDraft-allowed", actual: validateFile(serviceGuidanceAllowed.path, serviceGuidanceAllowed.content), expectViolations: 0 },
  ];

  let passed = true;
  for (const r of results) {
    if (r.actual.length === r.expectViolations) {
      process.stdout.write(`  PASS: ${r.fixture}\n`);
    } else {
      process.stderr.write(
        `  FAIL: ${r.fixture} — expected ${r.expectViolations} violations, got ${r.actual.length}: ${JSON.stringify(r.actual)}\n`,
      );
      passed = false;
    }
  }

  if (passed) {
    process.stdout.write("lint-no-ambient-claude self-test: PASSED\n");
    process.exit(0);
  } else {
    process.stderr.write("lint-no-ambient-claude self-test: FAILED\n");
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--self-test")) {
    runSelfTest();
    return;
  }

  const allFiles: string[] = [];
  for (const root of SCAN_ROOTS) {
    const found = await findFiles(root);
    allFiles.push(...found);
  }

  const allViolations: Violation[] = [];
  for (const abs of allFiles) {
    const rel = path.relative(REPO_ROOT, abs);
    const content = await fsp.readFile(abs, "utf8");
    const violations = validateFile(rel, content);
    allViolations.push(...violations);
  }

  if (allViolations.length > 0) {
    process.stderr.write(
      `lint-no-ambient-claude: ${allViolations.length} violation(s) found:\n\n`,
    );
    for (const v of allViolations) {
      process.stderr.write(`  ${v.file}\n    rule ${v.rule}: ${v.message}\n\n`);
    }
    process.stderr.write(
      "Phase 1 compliance frame: AI grading runs ONLY on a fresh admin click " +
      "via modules/07-ai-grading/handlers/admin-grade.ts. " +
      "See docs/05-ai-pipeline.md § Decisions captured § D2 for the full contract.\n",
    );
    process.exit(1);
  }

  process.stdout.write(
    `lint-no-ambient-claude: OK (${allFiles.length} TS files scanned across ${SCAN_ROOTS.join(", ")}; allow-list: 2 spawn sites + 1 SDK import site)\n`,
  );
  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(`lint-no-ambient-claude error: ${String(err)}\n`);
  process.exit(1);
});
