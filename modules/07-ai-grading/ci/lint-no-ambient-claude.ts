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
 * 2026-10-23 A4-4 (GATE-8) tightening, all static:
 *   - pattern 1b: `claude` named as a command in ANY string literal (aliases,
 *     `const bin`, `sh -c`, `npx`), and in .sh scripts.
 *   - pattern 8: any child_process import outside CHILD_PROCESS_ALLOW_LIST.
 *   - dynamic `import("@assessiq/ai-grading")`, relative imports into the
 *     grading module, and handleAdminGrade/Rerun/Generate count as runtime hits.
 *   - banned paths now include any `jobs/` and `cron/` directory; a timer or
 *     scheduler next to a grading symbol fails anywhere outside the module.
 *   - tools/ and apps/ also scan .js .mjs .cjs .sh. `__tests__` stay skipped:
 *     tests never run in production and mocking the runtime would false-positive.
 *   Limits (regex, not AST): a command built from pieces ("cla"+"ude"), read
 *   from env/config, or a runtime import through a computed specifier is not seen.
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
  "fixtures",             // test fixtures (A4-4: may hold sample scripts)
  "__fixtures__",
]);

/**
 * Scan extensions: TypeScript source. We deliberately skip `.md`, `.json`,
 * `.sql`, `.yml` — those are configuration / docs and may legitimately
 * contain the literal word "claude".
 */
const SCAN_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts"]);

/**
 * A4-4 (d): under tools/ and apps/ also scan plain JS and shell scripts, which
 * can spawn `claude` just as well as TypeScript. modules/ and infra/ stay
 * TypeScript only (no scripts there today).
 */
const SCRIPT_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".sh"]);
const SCRIPT_ROOTS = new Set(["tools", "apps"]);

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
      if (!SCAN_EXTENSIONS.has(ext) && !(SCRIPT_ROOTS.has(rootRel) && SCRIPT_EXTENSIONS.has(ext))) continue;
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
 * RW-65: the first argument may be any string or template literal that
 * CONTAINS `claude` (e.g. "claude -p ...", "/usr/bin/claude"), so a call
 * rewritten from spawn to exec/execSync is still caught. Over-approximate
 * on purpose (also hits "claudeBin" strings): a false positive is a visible
 * lint failure, a false negative breaks the compliance frame.
 *
 * Examples that match:
 *   spawn("claude", [...])
 *   execFile('claude', { ... })
 *   exec("claude -p ...")
 *
 * The `(?:^|[^\w])` prefix avoids matching names like `myspawn(`.
 */
const RE_SPAWN_CLAUDE =
  /(?:^|[^\w])(spawn|exec|execFile|fork|spawnSync|execSync|execFileSync)\s*\(\s*["'`][^"'`]*claude/;

/**
 * Pattern 1b (A4-4 a) — `claude` named as a command in ANY string literal, so
 * aliased or promisified wrappers (`execFileP('claude', ...)`), a variable
 * (`const bin = "claude"; spawn(bin, ...)`), shell strings
 * (`spawn("sh", ["-c", "claude -p x"])`) and runners (`spawn("npx", ["claude"])`)
 * cannot hide. Matches the literal CONTENT: optional runner prefix, optional
 * path, `claude` (or claude.cmd/.exe), then end / space / shell punctuation.
 * `claude-sonnet`, `.claude/`, `x/claude-code` do not match. Over-approximates
 * on purpose (prose like "ask claude to" in a string also hits): a visible
 * failure is cheaper than a silent bypass.
 */
const RE_CLAUDE_CMD_IN_STRING =
  /(?:^|[\s;&|(){}]|\$\()(?:(?:npx|bunx|sudo|nohup|exec|env)\s+(?:-\S+\s+)*)?(?:[^\s"'`]*[\\/])?claude(?:\.cmd|\.exe)?(?=$|[\s;&|)])|@anthropic-ai\/claude-code\b/;

/** Pulls string and template literal contents out of comment-stripped code. */
const RE_STRING_LITERAL = /"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g;

function hasClaudeCommandLiteral(code: string): boolean {
  for (const m of code.matchAll(RE_STRING_LITERAL)) {
    if (RE_CLAUDE_CMD_IN_STRING.test(m[1] ?? m[2] ?? m[3] ?? "")) return true;
  }
  return false;
}

/** Shell scripts: `claude` as a command word on a non-comment line. */
function hasClaudeCommandInShell(src: string): boolean {
  return src
    .split(/\r?\n/)
    .some((l) => !/^\s*#/.test(l) && RE_CLAUDE_CMD_IN_STRING.test(l));
}

/** The health probe file and its one allowed call shape (`'claude', ['--version']`). */
const HEALTH_PROBE_FILE = "apps/api/src/routes/health.ts";
const RE_VERSION_PROBE_CALL = /["']claude["']\s*,\s*\[\s*["']--version["']\s*\]/g;

/**
 * Pattern 8 (A4-4) — any `child_process` (or spawn-library) import. Only files
 * on CHILD_PROCESS_ALLOW_LIST may have one. A file that imports it AND names a
 * grading-runtime symbol fails even when listed (never allow-list a file that
 * can reach a grading runtime).
 */
const RE_CHILD_PROCESS_IMPORT =
  /(?:from\s+|require\s*\(\s*|import\s*\(\s*|import\s+[\w$]+\s*=\s*require\s*\(\s*)["'](?:node:)?(?:child_process|execa|cross-spawn|shelljs|zx)["']|\bprocess\.binding\s*\(\s*["']spawn_sync["']/;

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
  /(?:(?:from|import|require)\s*\(?\s*["'](?:[^"']*\/)?(?:07-ai-grading|ai-grading)(?:\/[^"']*)?["']|(?:from|import|require)\s*\(?\s*["']@assessiq\/ai-grading(?:\/[^"']*)?["']|\brunClaudeCodeGrading\b|\bgradeSubjective\b|\bgenerateQuestions(?:ByType)?\b|\bgenerateRubricDraft\b|\bgenerateAnswerGuidanceDraft\b|\bhandleAdmin(?:Grade|Rerun|Generate)\b)/;

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
  // A4-4 (c): D2 pattern 3 (cron / interval callbacks). Scheduled jobs live in
  // apps/api/src/jobs/; any cron or jobs directory is banned wholesale.
  {
    name: "scheduled jobs and cron (D2 pattern 3)",
    matches: (rel) => /(?:^|\/)(?:cron|jobs)\//.test(rel),
  },
];

/**
 * D2 pattern 3, direct form: a timer / scheduler in the same file as a grading
 * runtime symbol, anywhere outside the grading module itself (its handlers
 * legitimately hold lease heartbeats).
 */
const RE_SCHEDULER = /\bsetInterval\s*\(|\bnode-cron\b|\bcron\.schedule\s*\(|\bnew\s+CronJob\b|\bnode-schedule\b/;

/** `import type {..} from ".."` is erased at build time: it cannot reach a runtime (browser UIs poll with setInterval). */
const RE_TYPE_ONLY_IMPORT = /import\s+type\s+[^;]*?from\s+["'][^"']+["'];?/g;

/**
 * Files allowed to import child_process (or a spawn library). Each entry was
 * read (A4-4, 2026-10-23): fixed binaries only (git, pnpm, node, tar, vale),
 * never `claude`, and none names a grading-runtime symbol (re-checked by the
 * lint on every run, see RE_CHILD_PROCESS_IMPORT).
 */
const CHILD_PROCESS_ALLOW_LIST: ReadonlyMap<string, string> = new Map([
  ["apps/api/src/routes/health.ts", "readiness probe: execFile('claude', ['--version']), no model call, no quota (benign, the spawn lint polices 'claude' separately)"],
  ["apps/marketing/scripts/page-dates.mjs", "build script: git log for page dates"],
  ["apps/web/e2e/lighthouse-authed.mjs", "dev script: runs pnpm exec lhci"],
  ["tools/check-docs-links.mjs", "dev script: git ls-files"],
  ["tools/check-docs-privacy.mjs", "dev script: git diff / ls-files"],
  ["tools/close-session.mjs", "dev script: runs the other tools with node"],
  ["tools/docs-move.mjs", "dev script: git -C"],
  ["tools/docs-plans-index.mjs", "dev script: git ls-files"],
  ["tools/generate-help-seed.ts", "dev script: git"],
  ["tools/lint-docs.mjs", "dev script: vale, markdownlint-cli2, git"],
  ["tools/lint-question-type-registry.ts", "dev script: git ls-files"],
  ["tools/next-brief.mjs", "dev script: git"],
  ["tools/sample-quiz-report.mjs", "dev script: git check-ignore, tar"],
  ["tools/verify-stamp.mjs", "dev script: git"],
  ["tools/verify.mjs", "dev script: runs lint and typecheck"],
]);

// ---------------------------------------------------------------------------
// Comment stripper (RW-65)
// ---------------------------------------------------------------------------

/**
 * A `/` starts a regex literal (not a division) when the code before it is
 * empty, ends in one of these punctuators, or ends in one of these keywords.
 */
const RE_REGEX_ALLOWED_AFTER =
  /(?:^|[(,=:\[!&|?{};+\-*%<>~^]|(?:^|[^\w$.])(?:return|typeof|case|in|of|delete|void|throw|else|do|yield|await))$/;

/**
 * Remove `//` and block comments so prose that quotes a pattern (RCA
 * 2026-10-09) cannot trip the regexes. String, template and regex literals
 * are copied verbatim, so a real call site inside a string still counts and
 * a `//` inside a URL string or regex is not mistaken for a comment.
 * Newlines survive.
 *
 * ponytail: a small state machine, not a parser. A regex literal is
 * recognised by the preceding token; `${ }` nesting in templates is tracked
 * with a brace-depth stack. Ceiling: a regex after `)` or an identifier is
 * read as division, so its body is scanned as code (only a `//` or block
 * comment opener inside such a body could mis-pair). Fail closed: an
 * unterminated block comment or unclosed regex is NOT stripped.
 */
function stripComments(src: string): string {
  let out = "";
  let i = 0;
  let inTpl = false; // inside template text (not inside a ${ } expression)
  let depth = 0; // brace depth inside the current ${ } expression
  const stack: number[] = []; // saved depths of enclosing ${ } expressions
  while (i < src.length) {
    const c = src[i]!;
    const n = src[i + 1];
    if (inTpl) {
      if (c === "\\") {
        out += src.slice(i, i + 2);
        i += 2;
        continue;
      }
      if (c === "`") inTpl = false;
      else if (c === "$" && n === "{") {
        stack.push(depth);
        depth = 0;
        inTpl = false;
        out += "${";
        i += 2;
        continue;
      }
      out += c;
      i++;
    } else if (c === "/" && n === "/") {
      while (i < src.length && src[i] !== "\n") i++;
    } else if (c === "/" && n === "*") {
      const end = src.indexOf("*/", i + 2);
      if (end === -1) return out + src.slice(i); // fail closed
      out += src.slice(i, end).replace(/[^\n]/g, " ") + "  ";
      i = end + 2;
    } else if (c === "/" && RE_REGEX_ALLOWED_AFTER.test(out.trimEnd())) {
      // Regex literal: copy verbatim (escapes and [...] classes may hold `/`).
      let j = i + 1;
      let inClass = false;
      while (j < src.length && src[j] !== "\n") {
        const r = src[j]!;
        if (r === "\\") j++;
        else if (r === "[") inClass = true;
        else if (r === "]") inClass = false;
        else if (r === "/" && !inClass) break;
        j++;
      }
      if (src[j] === "/") {
        j++;
        while (j < src.length && /[a-z]/.test(src[j]!)) j++;
        out += src.slice(i, j);
        i = j;
      } else {
        out += c; // not a closed literal: treat the `/` as plain code
        i++;
      }
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < src.length && src[j] !== c && src[j] !== "\n") {
        if (src[j] === "\\") j++;
        j++;
      }
      out += src.slice(i, j + 1);
      i = j + 1;
    } else {
      if (c === "`") inTpl = true;
      else if (c === "{") depth++;
      else if (c === "}") {
        if (depth === 0 && stack.length > 0) {
          depth = stack.pop()!;
          inTpl = true;
        } else if (depth > 0) depth--;
      }
      out += c;
      i++;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Violation record
// ---------------------------------------------------------------------------

interface Violation {
  file: string;
  rule: 1 | 2 | 3456 | 7 | 8;
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

  const isShell = normalised.endsWith(".sh");
  // RW-65: match on code only; comments never produce hits.
  content = isShell ? content : stripComments(content);

  // The one benign `claude` spawn outside the allow-list: the readiness probe
  // (`--version`, no model call). Anything else in that file still counts.
  const claudeCode =
    normalised === HEALTH_PROBE_FILE ? content.replace(RE_VERSION_PROBE_CALL, "") : content;

  // Pattern 1 — claude CLI spawn outside allow-list
  const spawnsClaude =
    RE_SPAWN_CLAUDE.test(claudeCode) ||
    (isShell ? hasClaudeCommandInShell(claudeCode) : hasClaudeCommandLiteral(claudeCode));
  if (spawnsClaude && !CLAUDE_SPAWN_ALLOW_LIST.has(normalised)) {
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

  // Pattern 8 — child_process outside the explicit allow-list, and never together
  // with a grading-runtime symbol (outside the two spawn sites).
  if (RE_CHILD_PROCESS_IMPORT.test(content) && !CLAUDE_SPAWN_ALLOW_LIST.has(normalised)) {
    if (!CHILD_PROCESS_ALLOW_LIST.has(normalised)) {
      violations.push({
        file: relPath,
        rule: 8,
        message:
          "D2 pattern 8: child_process import outside the allow-list. If the use is legitimate " +
          "(fixed binary, no claude, no grading runtime) add the file with a reason to CHILD_PROCESS_ALLOW_LIST.",
      });
    } else if (RE_GRADING_RUNTIME_IMPORT.test(content)) {
      violations.push({
        file: relPath,
        rule: 8,
        message: "D2 pattern 8: a file that imports child_process must not name a grading-runtime symbol.",
      });
    }
  }

  // Pattern 3 (direct form) — timer / scheduler together with a grading symbol.
  if (
    RE_SCHEDULER.test(content) &&
    RE_GRADING_RUNTIME_IMPORT.test(content.replace(RE_TYPE_ONLY_IMPORT, "")) &&
    !normalised.startsWith("modules/07-ai-grading/src/")
  ) {
    violations.push({
      file: relPath,
      rule: 3456,
      message: "D2 pattern 3: setInterval / cron next to a grading-runtime symbol. Grading is admin-click-only.",
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

  // --- Fixtures 15-23: RW-65 comment stripping + exec variants ---
  const T = "tools/some-script.ts";
  const extra: Array<[string, string, number]> = [
    ["comment-only-line", `// we never call spawn("claude", args) here
export const x = 1;`, 0],
    ["comment-only-block", `/* spawn("claude", []) 
 exec("claude -p") */
export const x = 1;`, 0],
    ["url-then-real-spawn", `const u = "http://x.test/a"; spawn("claude", [u]);`, 1],
    ["real-spawn-after-block", `/* note */ spawn("claude", []);`, 1],
    ["spawn-in-template", "const r = exec(`claude -p ${q}`);", 1],
    ["execSync-claude", `execSync("claude -p hi");`, 1],
    ["execFileSync-path", `execFileSync('/usr/bin/claude', []);`, 1],
    ["execFile-claude", `execFile("claude", ["-p"], cb);`, 1],
    ["spawnSync-claude", `spawnSync("claude", []);`, 1],
    ["exec-unrelated", `exec("ls -la"); execSync("git status");`, 0],
    ["regex-tail-then-spawn", "/^https?:\\/\\//; spawn(\"claude\", []);", 1],
    ["regex-slash-star-then-doc", "const r = /\\/*/; spawn(\"claude\", []);\n/** doc */", 1],
    ["regex-class-slash-star", "const r = /[/*]/;\nspawn(\"claude\", []);\n/** doc */", 1],
    ["nested-template-then-spawn", "const a = `a${`b`}c`; spawn(\"claude\", []);", 1],
    ["slash-string-then-spawn", "const s = \"//\"; spawn(\"claude\", []);", 1],
    ["multiline-template-spawn", "const t = `l1\nspawn(\"claude\", [])\nl3`;", 1],
    ["regex-quotes-then-spawn", "const r = /[\"']/g;\nspawn(\"claude\", []);", 1],
    ["regex-then-comment", "const r = /ab+c/g; // spawn(\"claude\", [])", 0],
    ["unterminated-block-fails-closed", `/* oops
spawn("claude", []);`, 1],
  ];

  const extraResults: Array<{ fixture: string; actual: Violation[]; expectViolations: number }> = [];
  // --- A4-4 bypass fixtures: path, content, expected violation count ---
  const bypass: Array<[string, string, string, number]> = [
    ["aliased execFileP('claude')", "apps/api/src/x.ts", `const r = await execFileP('claude', ['--version']);`, 1],
    ["const bin = claude; spawn(bin)", "apps/api/src/x.ts", `const bin = "claude";\nspawn(bin, ["-p", "x"]);`, 1],
    ["spawn sh -c claude", "apps/api/src/x.ts", `spawn("sh", ["-c", "claude -p hi"]);`, 1],
    ["spawn npx claude", "apps/api/src/x.ts", `spawn("npx", ["claude"]);`, 1],
    ["absolute path in array", "apps/api/src/x.ts", `run(["/usr/local/bin/claude", "-p"]);`, 1],
    ["claude after &&", "apps/api/src/x.ts", "const c = `cd /srv && claude -p x`;", 1],
    ["npx @anthropic-ai/claude-code", "apps/api/src/x.ts", `const p = "@anthropic-ai/claude-code";`, 1],
    ["claude in a .mjs script", "tools/x.mjs", `execFileSync("claude", ["-p"]);`, 1],
    ["claude command in a .sh script", "tools/x.sh", `#!/bin/sh\nclaude -p "hello"\n`, 1],
    ["claude after a pipe in .sh", "tools/x.sh", `echo hi | claude -p\n`, 1],
    [".sh comment about claude is fine", "tools/x.sh", `# runs claude later\ngit status\n`, 0],
    [".sh .claude/ path is fine", "tools/x.sh", `cd .claude/worktrees && ls\n`, 0],
    ["model name claude-sonnet is fine", "modules/04-question-bank/src/x.ts", `const m = "claude-sonnet-5";`, 0],
    [".claude/ path string is fine", "modules/04-question-bank/src/x.ts", `const d = "C:/x/.claude/worktrees";`, 0],
    ["health --version probe is the one allowed shape", "apps/api/src/routes/health.ts", `import { execFile } from 'node:child_process';\nexecFileP('claude', ['--version']);`, 0],
    ["health file with another claude call fails", "apps/api/src/routes/health.ts", `import { execFile } from 'node:child_process';\nexecFileP('claude', ['-p', 'x']);`, 1],
    ["child_process import outside allow-list", "apps/api/src/x.ts", `import { execFile } from "node:child_process";`, 1],
    ["child_process require", "apps/api/src/x.js", `const cp = require("child_process");`, 1],
    ["dynamic child_process import", "apps/api/src/x.ts", `const cp = await import("node:child_process");`, 1],
    ["child_process allow-listed tools script", "tools/verify.mjs", `import { spawnSync } from "node:child_process";`, 0],
    ["allow-listed child_process file naming a grading symbol", "tools/verify.mjs", `import { spawnSync } from "node:child_process";\ngradeSubjective();`, 1],
    ["dynamic import of ai-grading in a webhook", "apps/api/src/routes/webhooks/x.ts", `const m = await import("@assessiq/ai-grading");`, 1],
    ["relative runtime import in a candidate route", "apps/api/src/routes/take/x.ts", `import { x } from "../../../../modules/07-ai-grading/src/runtimes/claude-code-vps.js";`, 1],
    ["handleAdminGrade in a worker", "apps/worker/src/x.ts", `handleAdminGrade(input);`, 1],
    ["handleAdminRerun in a job", "apps/api/src/jobs/x.ts", `await handleAdminRerun(input);`, 1],
    ["handleAdminGenerate in a cron dir", "modules/05-assessment-lifecycle/src/cron/x.ts", `handleAdminGenerate(input);`, 1],
    ["generateQuestionsByType in a job", "apps/api/src/jobs/x.ts", `generateQuestionsByType(i);`, 1],
    ["clean job file", "apps/api/src/jobs/ok.ts", `import { withSystemRole } from "@assessiq/tenancy";\nsetInterval(() => run(), 1000);`, 0],
    ["setInterval next to a grading symbol anywhere", "apps/api/src/x.ts", `setInterval(() => gradeSubjective(i), 1000);`, 1],
    ["setInterval with a type-only grading import is fine", "modules/10-admin-dashboard/src/p.tsx", `import type { Row } from "@assessiq/ai-grading";\nsetInterval(() => f(), 1000);`, 0],
  ];
  for (const [fixture, filePath, content, expectViolations] of bypass) {
    extraResults.push({ fixture: `a4-4 ${fixture}`, actual: validateFile(filePath, content), expectViolations });
  }

  const results = [
    ...extraResults,
    ...extra.map(([fixture, content, expectViolations]) => ({
      fixture,
      actual: validateFile(T, content),
      expectViolations,
    })),
    { fixture: "ok", actual: validateFile(okFile.path, okFile.content), expectViolations: 0 },
    { fixture: "spawn-violation", actual: validateFile(spawnViolation.path, spawnViolation.content), expectViolations: 2 /* pattern 1 + pattern 8 */ },
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
    `lint-no-ambient-claude: OK (${allFiles.length} TS/JS/shell files scanned across ${SCAN_ROOTS.join(", ")}; allow-list: 2 spawn sites + 1 SDK import site)\n`,
  );
  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(`lint-no-ambient-claude error: ${String(err)}\n`);
  process.exit(1);
});
