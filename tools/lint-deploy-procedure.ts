/**
 * tools/lint-deploy-procedure.ts
 *
 * Deploy-procedure lint for AssessIQ.
 *
 * RCA-prevention guard against the "code shipped, operational dependency
 * missed" class of bugs documented in docs/RCA_LOG.md entries for
 * 2026-05-03 through 2026-05-08. Four independent checks, each exits 1
 * on violation and 2 on internal error. Clean run exits 0.
 *
 * ─── CHECK A — Skill bind-mount integrity ─────────────────────────────────────
 *
 *   Every prompts/skills/<name>/SKILL.md in the repo must have a volume mount
 *   in infra/docker-compose.yml for the assessiq-api and assessiq-worker services.
 *   Also detects the inverse: mount declared but skills directory is empty.
 *
 * ─── CHECK B — Migration apply chain ──────────────────────────────────────────
 *
 *   Every .sql file under modules/ or apps/ that is NOT at the exact depth
 *   modules/<name>/migrations/<file>.sql (the migrate.ts discovery pattern)
 *   is flagged as an orphan unless it carries the manual-deploy marker:
 *     -- DEPLOY: manual; not part of migration sequence
 *
 * ─── CHECK C — Env var declaration coverage ───────────────────────────────────
 *
 *   Every process.env.VAR_NAME read in modules/<n>/src/ and apps/<name>/src/ must
 *   appear in .env.example (including comment mentions — see ANTHROPIC_API_KEY).
 *   Standard Node/system vars are skipped.
 *
 * ─── CHECK D — Email template URL ↔ SPA route consistency ────────────────────
 *
 *   Template HTML files are scanned for hardcoded href paths (non-Handlebars).
 *   Email-sending service code is scanned for template-literal URL construction
 *   patterns (${base}/path/${segment}). Every extracted first-path-segment must
 *   match a route path in apps/web/src/App.tsx. (Check D)
 *   Last incident: 2026-05-04 candidate magic-link /invite/ vs /take/.
 *
 * ─── Exit codes ───────────────────────────────────────────────────────────────
 *
 *   0  clean (no violations)
 *   1  one or more violations found
 *   2  internal error (missing file, parse failure, etc.)
 *
 * ─── Flags ────────────────────────────────────────────────────────────────────
 *
 *   --self-test   Run against synthetic in-memory / temp fixtures and assert
 *                 that violations are correctly detected. Exit 0 = lint works.
 *   --json        Machine-readable JSON output (array of violation objects).
 *
 * ─── Usage ────────────────────────────────────────────────────────────────────
 *
 *   pnpm tsx tools/lint-deploy-procedure.ts
 *   pnpm tsx tools/lint-deploy-procedure.ts --self-test
 *   pnpm tsx tools/lint-deploy-procedure.ts --json
 */

import * as fsp from "node:fs/promises";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import type { Dirent } from "node:fs";

// ─── Bootstrap ────────────────────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
  ".turbo",
  "AssessIQ_UI_Template",
  "storybook-static",
]);

// ─── Constants ────────────────────────────────────────────────────────────────

/** Services in docker-compose that must have the skills bind-mount. */
const SKILL_SERVICES = ["assessiq-api", "assessiq-worker"];

/** Pattern that exempts a SQL file from migrate.ts discovery requirements. */
const MIGRATION_MANUAL_MARKER =
  "-- DEPLOY: manual; not part of migration sequence";

/**
 * Standard Node / system environment variable names that code legitimately reads
 * without declaring in .env.example. Keep this list explicit and minimal.
 */
const SKIP_ENV_VARS = new Set([
  "NODE_ENV",
  "NODE_VERSION",
  "HOME",
  "PATH",
  "USER",
  "HOSTNAME",
  "SHELL",
  "PWD",
  "OLDPWD",
  "TERM",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TMPDIR",
  "TMP",
  "TEMP",
  "XDG_RUNTIME_DIR",
  "LOGNAME",
  // Standard CI/CD environment variables (set automatically by GitHub Actions
  // and other CI systems — not project-specific secrets, not in .env.example)
  "CI",
  "GITHUB_ACTIONS",
  "GITHUB_TOKEN",
  "GITHUB_WORKSPACE",
  "GITHUB_SHA",
  "GITHUB_REF",
  "RUNNER_OS",
  // Common server port override — not a secret, follows 12-factor convention
  "PORT",
  // Operational override declared in config.ts Zod schema; intentionally absent
  // from .env.example because it's a runtime path not a credential
  "LOG_DIR",
]);

/**
 * Directories containing email-sending service code to scan for URL construction.
 * These are the modules that build hrefs for email templates.
 */
const EMAIL_SERVICE_MODULE_NAMES = [
  "05-assessment-lifecycle",
  "03-users",
  "13-notifications",
];

// ─── Types ────────────────────────────────────────────────────────────────────

interface Violation {
  checkId: "A" | "B" | "C" | "D";
  severity: "ERROR";
  file: string;
  line?: number;
  message: string;
  suggestion: string;
}

class LintInternalError extends Error {
  constructor(
    message: string,
    public readonly exitCode: 2 = 2
  ) {
    super(message);
    this.name = "LintInternalError";
  }
}

// ─── Helper: directory walker ──────────────────────────────────────────────────

async function walkDir(
  dir: string,
  filter: (entry: Dirent, relPath: string) => boolean,
  baseDir = dir
): Promise<string[]> {
  const results: string[] = [];
  let entries: Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const relPath = path.relative(baseDir, fullPath).replace(/\\/g, "/");
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const children = await walkDir(fullPath, filter, baseDir);
      results.push(...children);
    } else if (entry.isFile() && filter(entry, relPath)) {
      results.push(fullPath);
    }
  }
  return results;
}

// ─── Helper: docker-compose volume parser ─────────────────────────────────────

/**
 * Parses the docker-compose YAML (as a string) and returns, for each service
 * in `targetServices`, the list of volume mount strings declared under that
 * service's `volumes:` key.
 *
 * Uses line-by-line structural parsing rather than a full YAML parser to avoid
 * an external dependency. Assumes standard 2-space YAML indentation.
 */
function parseComposeServiceVolumes(
  content: string,
  targetServices: string[]
): Map<string, string[]> {
  const result = new Map<string, string[]>();
  const lines = content.split("\n");
  let inServicesSection = false;
  let currentService: string | null = null;
  let inVolumesBlock = false;

  for (const line of lines) {
    // Top-level `services:` key
    if (line === "services:") {
      inServicesSection = true;
      currentService = null;
      inVolumesBlock = false;
      continue;
    }

    // Another top-level key ends the services section
    if (inServicesSection && /^[a-z]/.test(line) && !line.startsWith(" ")) {
      inServicesSection = false;
      currentService = null;
      inVolumesBlock = false;
      continue;
    }

    if (!inServicesSection) continue;

    // Service header: exactly 2-space indent + name + colon
    const serviceMatch = /^  ([a-z][a-z0-9-]+):$/.exec(line);
    if (serviceMatch) {
      currentService = serviceMatch[1];
      inVolumesBlock = false;
      continue;
    }

    // volumes: key under a service (4-space indent)
    if (currentService && /^    volumes:$/.test(line)) {
      inVolumesBlock = true;
      continue;
    }

    // Another 4-space key ends the volumes block
    if (inVolumesBlock && /^    [a-z_]/.test(line) && !/^      /.test(line)) {
      inVolumesBlock = false;
    }

    // Volume entry (6-space indent + "- ")
    if (
      inVolumesBlock &&
      currentService !== null &&
      targetServices.includes(currentService)
    ) {
      const volumeMatch = /^      - (.+)$/.exec(line);
      if (volumeMatch) {
        const volume = volumeMatch[1].trim();
        if (!result.has(currentService)) result.set(currentService, []);
        result.get(currentService)!.push(volume);
      }
    }
  }
  return result;
}

// ─── Helper: .env.example parser ──────────────────────────────────────────────

/**
 * Returns a Set of env var names that appear *anywhere* in .env.example —
 * including comment mentions (e.g. "# WARNING — DO NOT ADD ANTHROPIC_API_KEY").
 * This intentionally covers vars that are documented but intentionally absent
 * from the `KEY=value` assignment list.
 */
function parseEnvExampleKeys(content: string): Set<string> {
  const keys = new Set<string>();
  const re = /\b([A-Z][A-Z0-9_]+)\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    keys.add(m[1]);
  }
  return keys;
}

// ─── Helper: App.tsx route parser ─────────────────────────────────────────────

/**
 * Extracts all `path="..."` attribute values from the SPA router (App.tsx).
 * Returns every literal path string found — both absolute (/admin/login) and
 * relative (expired, :token) since nested routes use relative paths.
 */
function parseSpaRoutes(content: string): string[] {
  const routes: string[] = [];
  const re = /\bpath="([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    routes.push(m[1]);
  }
  return routes;
}

/**
 * Returns the first path segment of a URL path, e.g. "/take/expired" → "/take".
 * Returns the full path if it has only one segment.
 */
function firstPathSegment(urlPath: string): string {
  const parts = urlPath.replace(/\/+$/, "").split("/").filter(Boolean);
  return parts.length > 0 ? "/" + parts[0] : urlPath;
}

/**
 * Returns true if `segment` (e.g., "/take") is covered by any of the SPA routes.
 * A route "covers" the segment if the route path equals it, starts with it
 * followed by "/", or is a relative sub-path whose parent is this segment.
 */
function matchesSpaRoute(segment: string, routes: string[]): boolean {
  const seg = segment.replace(/\/$/, "");
  return routes.some((route) => {
    const r = route.replace(/\/$/, "");
    // Absolute match: route starts with this segment
    if (r === seg || r.startsWith(seg + "/")) return true;
    // Relative match: for routes like "expired" under parent "/take"
    // we already have "/take" as an absolute route so the segment matches
    return false;
  });
}

// ─── CHECK A — Skill bind-mount integrity ─────────────────────────────────────

interface CheckAOpts {
  skillsDir: string;
  composePath: string;
  services?: string[];
  relBase: string;
}

async function checkSkillBindMounts(
  opts: CheckAOpts
): Promise<Violation[]> {
  const { skillsDir, composePath, services = SKILL_SERVICES, relBase } = opts;
  const violations: Violation[] = [];

  // 1. Find skill subdirectories that contain SKILL.md
  const skillsWithMd: string[] = [];
  let allSkillEntries: Dirent[] = [];
  try {
    allSkillEntries = await fsp.readdir(skillsDir, { withFileTypes: true });
  } catch {
    // Skills directory doesn't exist — check for inverse (mount with no dir)
  }

  for (const entry of allSkillEntries) {
    if (!entry.isDirectory()) continue;
    try {
      await fsp.access(path.join(skillsDir, entry.name, "SKILL.md"));
      skillsWithMd.push(entry.name);
    } catch {
      // No SKILL.md in this skill dir — not a violation for Check A
    }
  }

  // 2. Parse docker-compose.yml for volume mounts per service
  let composeContent: string;
  try {
    composeContent = await fsp.readFile(composePath, "utf-8");
  } catch (e) {
    throw new LintInternalError(
      `CHECK A: Cannot read ${composePath}: ${String(e)}`
    );
  }

  const serviceVolumes = parseComposeServiceVolumes(composeContent, services);
  const composeRelPath = path.relative(relBase, composePath).replace(/\\/g, "/");

  // Helper: does a service have a skill-dir volume mount?
  // Check the SOURCE side of the mount (the repo path) rather than the
  // container destination, so the lint stays clean of container-internal paths.
  function serviceHasSkillMount(svc: string): boolean {
    const volumes = serviceVolumes.get(svc) ?? [];
    return volumes.some((v) => v.includes("prompts/skills"));
  }

  // 3. Skills exist → every service must have the bind-mount
  if (skillsWithMd.length > 0) {
    for (const svc of services) {
      if (!serviceHasSkillMount(svc)) {
        violations.push({
          checkId: "A",
          severity: "ERROR",
          file: composeRelPath,
          message: `SKILL UNREACHABLE: ${skillsWithMd.length} skill(s) in prompts/skills/ will not be visible to the ${svc} runtime (no bind-mount found).`,
          suggestion: `Add a read-only bind-mount in infra/docker-compose.yml under services.${svc}.volumes mapping prompts/skills (repo) → the skills directory inside the container. See existing assessiq-api.volumes for the correct pattern.`,
        });
      }
    }
  }

  // 4. Inverse: service has skill mount but skills dir is empty / has no SKILL.md
  for (const svc of services) {
    if (serviceHasSkillMount(svc) && skillsWithMd.length === 0) {
      violations.push({
        checkId: "A",
        severity: "ERROR",
        file: composeRelPath,
        message: `SKILL MOUNT EMPTY: services.${svc} has a bind-mount for the skills directory but prompts/skills/ contains no SKILL.md files (directory missing or skills are empty).`,
        suggestion: `Either add skill files under prompts/skills/<name>/SKILL.md or remove the dead bind-mount from services.${svc}.volumes`,
      });
    }
  }

  return violations;
}

// ─── CHECK B — Migration apply chain ──────────────────────────────────────────

interface CheckBOpts {
  /** Root paths to search for SQL files (non-recursive top-level dirs). */
  searchRoots: string[];
  relBase: string;
}

/**
 * Returns true if the SQL file is discoverable by tools/migrate.ts.
 * migrate.ts discovery: modules/<name>/migrations/<file>.sql
 * (exactly 4 path parts: modules / <name> / migrations / <file>.sql).
 */
function isDiscoverableByMigrateRunner(relPath: string): boolean {
  const parts = relPath.split("/");
  return (
    parts.length === 4 &&
    parts[0] === "modules" &&
    parts[2] === "migrations" &&
    parts[3].endsWith(".sql")
  );
}

async function checkMigrationApplyChain(
  opts: CheckBOpts
): Promise<Violation[]> {
  const { searchRoots, relBase } = opts;
  const violations: Violation[] = [];

  for (const searchRoot of searchRoots) {
    const sqlFiles = await walkDir(
      searchRoot,
      (entry) => entry.name.endsWith(".sql"),
      relBase
    );

    for (const sqlAbsPath of sqlFiles) {
      const relPath = path
        .relative(relBase, sqlAbsPath)
        .replace(/\\/g, "/");
      if (isDiscoverableByMigrateRunner(relPath)) continue; // ✓ runner picks this up

      // Check for manual-deploy exemption marker
      let content: string;
      try {
        content = await fsp.readFile(sqlAbsPath, "utf-8");
      } catch (e) {
        throw new LintInternalError(
          `CHECK B: Cannot read ${relPath}: ${String(e)}`
        );
      }

      if (content.includes(MIGRATION_MANUAL_MARKER)) continue; // ✓ exempt

      violations.push({
        checkId: "B",
        severity: "ERROR",
        file: relPath,
        message: `MIGRATION ORPHAN: ${relPath} is in git but tools/migrate.ts will not discover it (runner scans only modules/<name>/migrations/<file>.sql).`,
        suggestion: `Either:\n  1. Move the file to modules/<name>/migrations/<basename>.sql\n  2. Add exempt marker at the top of the file:\n     ${MIGRATION_MANUAL_MARKER}\n  3. Document the manual apply step in docs/06-deployment.md § Migrations.`,
      });
    }
  }

  return violations;
}

// ─── CHECK C — Env var declaration coverage ───────────────────────────────────

interface CheckCOpts {
  envExamplePath: string;
  sourceDirs: string[];
  relBase: string;
}

/** Regex to extract process.env.VAR_NAME or process.env['VAR_NAME']. */
const PROCESS_ENV_RE =
  /process\.env(?:\[['"]([A-Z_][A-Z0-9_]*)['"\]]|\.([A-Z_][A-Z0-9_]*))/g;

async function checkEnvVarDeclaration(
  opts: CheckCOpts
): Promise<Violation[]> {
  const { envExamplePath, sourceDirs, relBase } = opts;
  const violations: Violation[] = [];

  // 1. Parse .env.example — any mention of a var name (including comments)
  let envExampleContent: string;
  try {
    envExampleContent = await fsp.readFile(envExamplePath, "utf-8");
  } catch (e) {
    throw new LintInternalError(
      `CHECK C: Cannot read .env.example at ${envExamplePath}: ${String(e)}`
    );
  }
  const declaredKeys = parseEnvExampleKeys(envExampleContent);

  // 2. Find process.env.VAR references in source files
  // Track first-seen location per var name to avoid duplicate violations
  const seen = new Map<string, { file: string; line: number }>();

  for (const srcDir of sourceDirs) {
    const tsFiles = await walkDir(
      srcDir,
      (entry) =>
        (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) &&
        !entry.name.endsWith(".d.ts"),
      relBase
    );

    for (const tsAbsPath of tsFiles) {
      const relPath = path
        .relative(relBase, tsAbsPath)
        .replace(/\\/g, "/");

      let content: string;
      try {
        content = await fsp.readFile(tsAbsPath, "utf-8");
      } catch {
        continue; // skip unreadable files
      }

      const lines = content.split("\n");
      for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
        const line = lines[lineIdx];
        // Skip comment lines
        const trimmed = line.trimStart();
        if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;

        PROCESS_ENV_RE.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = PROCESS_ENV_RE.exec(line)) !== null) {
          const varName = m[1] ?? m[2];
          if (varName === undefined) continue;
          if (SKIP_ENV_VARS.has(varName)) continue;
          if (seen.has(varName)) continue;

          seen.set(varName, { file: relPath, line: lineIdx + 1 });
        }
      }
    }
  }

  // 3. Report vars not in .env.example
  for (const [varName, loc] of seen) {
    if (!declaredKeys.has(varName)) {
      violations.push({
        checkId: "C",
        severity: "ERROR",
        file: loc.file,
        line: loc.line,
        message: `ENV VAR UNDECLARED: ${varName} read at ${loc.file}:${loc.line} but not in .env.example.`,
        suggestion: `Add a placeholder line + a comment to .env.example explaining ${varName}'s purpose. If optional with a sensible default, declare in modules/00-core/src/config.ts as z.optional() or z.default().`,
      });
    }
  }

  return violations;
}

// ─── CHECK D — Email template URL ↔ SPA route consistency ────────────────────

interface CheckDOpts {
  templatesDir: string;
  emailServiceDirs: string[];
  appTsxPath: string;
  relBase: string;
}

/**
 * Regex to find template-literal URL construction in service code.
 * Matches the pattern: }  /path  ${ or } /path `
 * Example: `${PUBLIC_URL}/take/${plaintext}` → captures "/take/"
 * Example: `${base}/invite/${token}` → captures "/invite/"
 */
const TEMPLATE_URL_PATH_RE =
  /\}\s*(\/[a-z][a-z0-9/-]*)\s*(?:\$\{|['"`]|;|,|\))/g;

/**
 * Regex to find string-concat URL construction.
 * Example: baseUrl + '/take/' + token → captures "/take/"
 */
const CONCAT_URL_PATH_RE = /\+\s*['"](\/?[a-z][a-z0-9/-]*)['"](?:\s*\+)/g;

async function checkEmailTemplateUrls(
  opts: CheckDOpts
): Promise<Violation[]> {
  const { templatesDir, emailServiceDirs, appTsxPath, relBase } = opts;
  const violations: Violation[] = [];

  // 1. Parse SPA routes from App.tsx
  let appTsxContent: string;
  try {
    appTsxContent = await fsp.readFile(appTsxPath, "utf-8");
  } catch (e) {
    throw new LintInternalError(
      `CHECK D: Cannot read App.tsx at ${appTsxPath}: ${String(e)}`
    );
  }
  const spaRoutes = parseSpaRoutes(appTsxContent);

  // 2. Scan template HTML files for hardcoded href paths
  let templateEntries: string[] = [];
  try {
    templateEntries = await fsp.readdir(templatesDir);
  } catch {
    // Templates directory doesn't exist — skip this part
  }

  for (const f of templateEntries) {
    if (!f.endsWith(".html")) continue;
    const filePath = path.join(templatesDir, f);
    let content: string;
    try {
      content = await fsp.readFile(filePath, "utf-8");
    } catch {
      continue;
    }
    const relPath = path.relative(relBase, filePath).replace(/\\/g, "/");
    const lines = content.split("\n");

    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      const line = lines[lineIdx];
      // Find href="..." attributes
      const hrefRe = /href="([^"]+)"/g;
      let m: RegExpExecArray | null;
      while ((m = hrefRe.exec(line)) !== null) {
        const href = m[1];
        // Skip: pure Handlebars variable ({{var}}) — URL comes from caller
        if (/^\{\{[^{}]+\}\}$/.test(href)) continue;
        // Skip: absolute https?:// URLs without a literal path to check
        if (/^https?:\/\//.test(href)) continue;
        // Skip: fragment-only or data URIs
        if (href.startsWith("#") || href.startsWith("data:")) continue;

        if (href.startsWith("/")) {
          const urlPath = href.split("?")[0].split("#")[0];
          const seg = firstPathSegment(urlPath);
          if (seg && !matchesSpaRoute(seg, spaRoutes)) {
            violations.push({
              checkId: "D",
              severity: "ERROR",
              file: relPath,
              line: lineIdx + 1,
              message: `TEMPLATE URL MISMATCH: ${relPath} has href="${href}" but apps/web/src/App.tsx has no matching route for "${seg}".`,
              suggestion: `Fix the path in the template to use a registered SPA route, or add the route to App.tsx. Last known incident: 2026-05-04 candidate magic-link /invite/ vs /take/.`,
            });
          }
        }
      }
    }
  }

  // 3. Scan email service code for URL construction patterns
  for (const serviceDir of emailServiceDirs) {
    const tsFiles = await walkDir(
      serviceDir,
      (entry) =>
        (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) &&
        !entry.name.endsWith(".d.ts"),
      relBase
    );

    for (const tsAbsPath of tsFiles) {
      // Skip test files — they use fake URLs intentionally
      if (
        tsAbsPath.includes("__tests__") ||
        tsAbsPath.endsWith(".test.ts") ||
        tsAbsPath.endsWith(".spec.ts")
      )
        continue;

      let content: string;
      try {
        content = await fsp.readFile(tsAbsPath, "utf-8");
      } catch {
        continue;
      }
      const relPath = path
        .relative(relBase, tsAbsPath)
        .replace(/\\/g, "/");
      const lines = content.split("\n");

      for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
        const line = lines[lineIdx];
        const trimmed = line.trimStart();
        if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;

        // Pattern 1: template literal `${base}/path/${segment}` or `${base}/path`
        TEMPLATE_URL_PATH_RE.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = TEMPLATE_URL_PATH_RE.exec(line)) !== null) {
          const urlPath = m[1];
          // Only check paths that look like app routes (not API paths)
          if (urlPath.startsWith("/api/")) continue;
          if (urlPath.startsWith("/var/") || urlPath.startsWith("/usr/"))
            continue;
          const seg = firstPathSegment(urlPath);
          if (seg && !matchesSpaRoute(seg, spaRoutes)) {
            violations.push({
              checkId: "D",
              severity: "ERROR",
              file: relPath,
              line: lineIdx + 1,
              message: `TEMPLATE URL MISMATCH: ${relPath}:${lineIdx + 1} constructs URL path "${urlPath}" but apps/web/src/App.tsx has no matching route for "${seg}".`,
              suggestion: `Fix the URL path to use a registered SPA route, or add the route to App.tsx. Last known incident: 2026-05-04 candidate magic-link /invite/ vs /take/.`,
            });
          }
        }

        // Pattern 2: string concat baseUrl + '/path/' + segment
        CONCAT_URL_PATH_RE.lastIndex = 0;
        while ((m = CONCAT_URL_PATH_RE.exec(line)) !== null) {
          const urlPath = m[1];
          if (!urlPath.startsWith("/")) continue;
          if (urlPath.startsWith("/api/")) continue;
          const seg = firstPathSegment(urlPath);
          if (seg && !matchesSpaRoute(seg, spaRoutes)) {
            violations.push({
              checkId: "D",
              severity: "ERROR",
              file: relPath,
              line: lineIdx + 1,
              message: `TEMPLATE URL MISMATCH: ${relPath}:${lineIdx + 1} concatenates URL path "${urlPath}" but apps/web/src/App.tsx has no matching route for "${seg}".`,
              suggestion: `Fix the URL path to use a registered SPA route, or add the route to App.tsx. Last known incident: 2026-05-04 candidate magic-link /invite/ vs /take/.`,
            });
          }
        }
      }
    }
  }

  return violations;
}

// ─── Self-test ────────────────────────────────────────────────────────────────

async function runSelfTest(): Promise<void> {
  process.stdout.write("Running lint-deploy-procedure self-test...\n\n");

  let passed = true;
  let tmpDir: string | null = null;

  function assert(condition: boolean, name: string): void {
    if (condition) {
      process.stdout.write(`  PASS: ${name}\n`);
    } else {
      process.stderr.write(`  FAIL: ${name}\n`);
      passed = false;
    }
  }

  try {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "aiq-lint-deploy-"));

    // ── CHECK A self-test ──────────────────────────────────────────────────────
    process.stdout.write("CHECK A — Skill bind-mount integrity\n");

    const aSkillsDir = path.join(tmpDir, "prompts", "skills");
    const aTestSkillDir = path.join(aSkillsDir, "test-skill");
    await fsp.mkdir(aTestSkillDir, { recursive: true });
    await fsp.writeFile(path.join(aTestSkillDir, "SKILL.md"), "# Test skill\n");

    const aComposeMissingMount = `
services:
  assessiq-api:
    image: test
    volumes:
      - /var/log:/var/log
  assessiq-worker:
    image: test
    volumes:
      - /var/log:/var/log
`;
    const aComposeWithMount = `
services:
  assessiq-api:
    image: test
    volumes:
      - ../prompts/skills:/srv/app/skills:ro
  assessiq-worker:
    image: test
    volumes:
      - ../prompts/skills:/srv/app/skills:ro
`;

    const aComposeMissingPath = path.join(tmpDir, "docker-compose-missing.yml");
    const aComposeCleanPath = path.join(tmpDir, "docker-compose-clean.yml");
    await fsp.writeFile(aComposeMissingPath, aComposeMissingMount);
    await fsp.writeFile(aComposeCleanPath, aComposeWithMount);

    const aViolations = await checkSkillBindMounts({
      skillsDir: aSkillsDir,
      composePath: aComposeMissingPath,
      services: ["assessiq-api", "assessiq-worker"],
      relBase: tmpDir,
    });
    assert(aViolations.length >= 1, "A-1: missing mount → violation detected");
    assert(
      aViolations.some((v) => v.message.includes("SKILL UNREACHABLE")),
      "A-2: violation message contains SKILL UNREACHABLE"
    );

    const aClean = await checkSkillBindMounts({
      skillsDir: aSkillsDir,
      composePath: aComposeCleanPath,
      services: ["assessiq-api", "assessiq-worker"],
      relBase: tmpDir,
    });
    assert(aClean.length === 0, "A-3: correct mount → no violations");

    // Inverse: mount exists but skills dir is empty
    const aEmptySkillsDir = path.join(tmpDir, "prompts", "empty-skills");
    await fsp.mkdir(aEmptySkillsDir, { recursive: true });
    const aInverseViolations = await checkSkillBindMounts({
      skillsDir: aEmptySkillsDir,
      composePath: aComposeCleanPath,
      services: ["assessiq-api", "assessiq-worker"],
      relBase: tmpDir,
    });
    assert(
      aInverseViolations.some((v) => v.message.includes("SKILL MOUNT EMPTY")),
      "A-4: inverse — mount exists but skills dir empty → violation"
    );

    // ── CHECK B self-test ──────────────────────────────────────────────────────
    process.stdout.write("\nCHECK B — Migration apply chain\n");

    const bModulesDir = path.join(tmpDir, "modules");

    // Correct depth — should be clean
    const bGoodMigDir = path.join(bModulesDir, "good-module", "migrations");
    await fsp.mkdir(bGoodMigDir, { recursive: true });
    await fsp.writeFile(
      path.join(bGoodMigDir, "001_good.sql"),
      "CREATE TABLE good (id SERIAL PRIMARY KEY);"
    );

    // Wrong depth — violation (no marker)
    const bBadMigDir = path.join(
      bModulesDir,
      "bad-module",
      "subdir",
      "migrations"
    );
    await fsp.mkdir(bBadMigDir, { recursive: true });
    await fsp.writeFile(
      path.join(bBadMigDir, "001_orphan.sql"),
      "CREATE TABLE orphan (id SERIAL PRIMARY KEY);"
    );

    // Wrong depth but has exemption marker — should be clean
    const bExemptDir = path.join(bModulesDir, "exempt-module", "seeds");
    await fsp.mkdir(bExemptDir, { recursive: true });
    await fsp.writeFile(
      path.join(bExemptDir, "001_seed.sql"),
      `-- ${MIGRATION_MANUAL_MARKER}\nINSERT INTO ref_data VALUES (1);`
    );

    const bViolations = await checkMigrationApplyChain({
      searchRoots: [bModulesDir],
      relBase: tmpDir,
    });
    assert(
      bViolations.some((v) => v.message.includes("MIGRATION ORPHAN")),
      "B-1: orphan SQL file → violation detected"
    );
    assert(
      bViolations.some((v) => v.file.includes("bad-module")),
      "B-2: violation points to the orphan file"
    );
    assert(
      bViolations.every((v) => !v.file.includes("good-module")),
      "B-3: correct-depth migration → no violation"
    );
    assert(
      bViolations.every((v) => !v.file.includes("exempt-module")),
      "B-4: exemption-marked SQL → no violation"
    );

    // ── CHECK C self-test ──────────────────────────────────────────────────────
    process.stdout.write("\nCHECK C — Env var declaration coverage\n");

    const cDir = path.join(tmpDir, "check-c");
    const cSrcDir = path.join(cDir, "src");
    await fsp.mkdir(cSrcDir, { recursive: true });

    const cEnvExample = `
KNOWN_VAR=some-value
# COMMENTED_VAR — referenced in comment
REDIS_URL=redis://localhost:6379
`;
    const cEnvExamplePath = path.join(cDir, ".env.example");
    await fsp.writeFile(cEnvExamplePath, cEnvExample);

    // Source with undeclared var → violation
    await fsp.writeFile(
      path.join(cSrcDir, "bad.ts"),
      `const x = process.env['TOTALLY_UNDECLARED_SECRET_VAR'];\n`
    );
    // Source with declared var → clean
    await fsp.writeFile(
      path.join(cSrcDir, "good.ts"),
      `const r = process.env['KNOWN_VAR'];\n`
    );
    // Source with skip-list var → clean
    await fsp.writeFile(
      path.join(cSrcDir, "sysvar.ts"),
      `const h = process.env['HOSTNAME'];\n`
    );
    // Source with comment-mentioned var → clean
    await fsp.writeFile(
      path.join(cSrcDir, "commented.ts"),
      `const c = process.env['COMMENTED_VAR'];\n`
    );

    const cViolations = await checkEnvVarDeclaration({
      envExamplePath: cEnvExamplePath,
      sourceDirs: [cSrcDir],
      relBase: tmpDir,
    });
    assert(
      cViolations.some((v) => v.message.includes("TOTALLY_UNDECLARED_SECRET_VAR")),
      "C-1: undeclared var → violation detected"
    );
    assert(
      cViolations.every((v) => !v.message.includes("KNOWN_VAR")),
      "C-2: declared var → no violation"
    );
    assert(
      cViolations.every((v) => !v.message.includes("HOSTNAME")),
      "C-3: system var in skip list → no violation"
    );
    assert(
      cViolations.every((v) => !v.message.includes("COMMENTED_VAR")),
      "C-4: var mentioned in comment in .env.example → no violation"
    );

    // ── CHECK D self-test ──────────────────────────────────────────────────────
    process.stdout.write("\nCHECK D — Email template URL ↔ SPA route\n");

    const dDir = path.join(tmpDir, "check-d");
    const dTemplatesDir = path.join(dDir, "templates");
    const dServiceDir = path.join(dDir, "service");
    await fsp.mkdir(dTemplatesDir, { recursive: true });
    await fsp.mkdir(dServiceDir, { recursive: true });

    const dAppTsxPath = path.join(dDir, "App.tsx");
    await fsp.writeFile(
      dAppTsxPath,
      `
export function App() {
  return (
    <Routes>
      <Route path="/admin/login" element={<Login />} />
      <Route path="/take" element={<TakeRoot />}>
        <Route path=":token" element={<TokenLanding />} />
      </Route>
      <Route path="/admin/invite/accept" element={<InviteAccept />} />
    </Routes>
  );
}
`
    );

    // Template with bad href → violation
    await fsp.writeFile(
      path.join(dTemplatesDir, "bad_template.html"),
      `<!DOCTYPE html><html><body><a href="/invite/{{token}}">Click</a></body></html>`
    );
    // Template with good href → clean
    await fsp.writeFile(
      path.join(dTemplatesDir, "good_template.html"),
      `<!DOCTYPE html><html><body><a href="{{invitationLink}}">Click</a></body></html>`
    );
    // Template with absolute href to SPA path → clean
    await fsp.writeFile(
      path.join(dTemplatesDir, "also_good.html"),
      `<!DOCTYPE html><html><body><a href="/admin/invite/accept">Accept</a></body></html>`
    );

    // Service code with bad URL construction → violation
    await fsp.writeFile(
      path.join(dServiceDir, "bad-service.ts"),
      "const link = `${PUBLIC_URL}/invite/${token}`;\n"
    );
    // Service code with good URL construction → clean
    await fsp.writeFile(
      path.join(dServiceDir, "good-service.ts"),
      "const link = `${PUBLIC_URL}/take/${token}`;\n"
    );

    const dViolations = await checkEmailTemplateUrls({
      templatesDir: dTemplatesDir,
      emailServiceDirs: [dServiceDir],
      appTsxPath: dAppTsxPath,
      relBase: tmpDir,
    });

    assert(
      dViolations.some(
        (v) => v.file.includes("bad_template") && v.message.includes("/invite/")
      ),
      "D-1: template href=/invite/ not in App.tsx → violation"
    );
    assert(
      dViolations.every((v) => !v.file.includes("good_template")),
      "D-2: template with pure Handlebars href → no violation"
    );
    assert(
      dViolations.every((v) => !v.file.includes("also_good")),
      "D-3: template with valid /admin/invite/accept href → no violation"
    );
    assert(
      dViolations.some(
        (v) => v.file.includes("bad-service") && v.message.includes("/invite/")
      ),
      "D-4: service code ${base}/invite/${token} not in routes → violation"
    );
    assert(
      dViolations.every((v) => !v.file.includes("good-service")),
      "D-5: service code ${base}/take/${token} → no violation"
    );
  } finally {
    if (tmpDir !== null) {
      await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  process.stdout.write("\n");
  if (passed) {
    process.stdout.write("lint-deploy-procedure self-test: PASSED\n");
    process.exit(0);
  } else {
    process.stderr.write("lint-deploy-procedure self-test: FAILED\n");
    process.exit(1);
  }
}

// ─── Reporter ─────────────────────────────────────────────────────────────────

function formatViolations(violations: Violation[], useJson: boolean): string {
  if (useJson) {
    return JSON.stringify(violations, null, 2);
  }

  if (violations.length === 0) return "";

  const lines: string[] = [];
  for (const v of violations) {
    const loc = v.line !== undefined ? `${v.file}:${v.line}` : v.file;
    lines.push(`${v.severity}: CHECK_${v.checkId}: ${v.message}`);
    lines.push(`  at ${loc}`);
    const suggestionLines = v.suggestion
      .split("\n")
      .map((l) => `  → ${l}`)
      .join("\n");
    lines.push(suggestionLines);
    lines.push("");
  }
  return lines.join("\n");
}

function printSummary(
  violations: Violation[],
  checkIds: Array<"A" | "B" | "C" | "D">
): void {
  const counts = Object.fromEntries(checkIds.map((id) => [id, 0])) as Record<
    "A" | "B" | "C" | "D",
    number
  >;
  for (const v of violations) {
    counts[v.checkId]++;
  }

  process.stdout.write("─── Summary ─────────────────────────────────────────\n");
  for (const id of checkIds) {
    const label: Record<string, string> = {
      A: "Skill bind-mount",
      B: "Migration apply chain",
      C: "Env var declaration",
      D: "Email template URL",
    };
    const count = counts[id];
    const status = count === 0 ? "✓ clean" : `✗ ${count} violation(s)`;
    process.stdout.write(`  CHECK ${id} (${label[id]}): ${status}\n`);
  }
  process.stdout.write(
    `  TOTAL: ${violations.length} violation(s)\n`
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const isSelfTest = args.includes("--self-test");
  const isJson = args.includes("--json");

  if (isSelfTest) {
    await runSelfTest();
    return; // runSelfTest calls process.exit internally
  }

  const violations: Violation[] = [];

  try {
    // CHECK A
    const aViolations = await checkSkillBindMounts({
      skillsDir: path.join(REPO_ROOT, "prompts", "skills"),
      composePath: path.join(REPO_ROOT, "infra", "docker-compose.yml"),
      services: SKILL_SERVICES,
      relBase: REPO_ROOT,
    });
    violations.push(...aViolations);

    // CHECK B
    const bViolations = await checkMigrationApplyChain({
      searchRoots: [
        path.join(REPO_ROOT, "modules"),
        path.join(REPO_ROOT, "apps"),
      ],
      relBase: REPO_ROOT,
    });
    violations.push(...bViolations);

    // CHECK C
    const cViolations = await checkEnvVarDeclaration({
      envExamplePath: path.join(REPO_ROOT, ".env.example"),
      sourceDirs: [
        path.join(REPO_ROOT, "modules"),
        path.join(REPO_ROOT, "apps"),
      ],
      relBase: REPO_ROOT,
    });
    violations.push(...cViolations);

    // CHECK D
    const dEmailServiceDirs = EMAIL_SERVICE_MODULE_NAMES.map((name) =>
      path.join(REPO_ROOT, "modules", name, "src")
    );
    const dViolations = await checkEmailTemplateUrls({
      templatesDir: path.join(
        REPO_ROOT,
        "modules",
        "13-notifications",
        "src",
        "email",
        "templates"
      ),
      emailServiceDirs: dEmailServiceDirs,
      appTsxPath: path.join(REPO_ROOT, "apps", "web", "src", "App.tsx"),
      relBase: REPO_ROOT,
    });
    violations.push(...dViolations);
  } catch (e) {
    if (e instanceof LintInternalError) {
      process.stderr.write(`INTERNAL ERROR: ${e.message}\n`);
      process.exit(2);
    }
    process.stderr.write(`UNEXPECTED ERROR: ${String(e)}\n`);
    process.exit(2);
  }

  const output = formatViolations(violations, isJson);
  if (output) {
    process.stdout.write(output + "\n");
  }

  if (!isJson) {
    printSummary(violations, ["A", "B", "C", "D"]);
  }

  process.exit(violations.length > 0 ? 1 : 0);
}

main().catch((e) => {
  process.stderr.write(`FATAL: ${String(e)}\n`);
  process.exit(2);
});
