/**
 * tools/lint-edge-routing.ts
 *
 * Edge-routing lint for AssessIQ.
 *
 * RCA-prevention guard against the /help/* (2026-05-02) and /take/* (2026-05-03)
 * Caddy fallthrough incidents — two consecutive days where a bare-root Fastify
 * route mount was missing from the Caddy @api matcher, causing requests to fall
 * through to the SPA's catch-all and return index.html instead of the API JSON
 * envelope. See docs/RCA_LOG.md entries for both dates.
 *
 * ## What this lint does
 *
 * 1. Reads the canonical Caddy @api matcher list from docs/06-deployment.md
 *    (the `@api path ...` line inside the fenced Caddyfile block). This is the
 *    single source of truth — updating the doc automatically updates the lint
 *    constraint without any code change.
 *
 * 2. Walks a fixed list of Fastify route-registration source files:
 *      apps/api/src/server.ts
 *      apps/api/src/routes/ (all .ts files, recursive)
 *      modules/{n}-{name}/src/routes*.ts
 *      modules/{n}-{name}/src/{name}-routes.ts
 *      modules/{n}-{name}/src/{name}.routes.ts
 *    For each file, extracts every route URL from:
 *      - app.get/post/put/patch/delete/head/options/all("url", ...)
 *      - app.route({ ..., url: "url", ... })
 *
 * 3. For each extracted URL:
 *    - `/api/*` prefixed → already covered by `@api path /api/*`, skip.
 *    - Otherwise: assert that at least one canonical-matcher entry shares the
 *      same FIRST PATH SEGMENT as the URL.
 *
 * ## First-segment-overlap rule (the semantic this lint encodes)
 *
 * Caddy's exact-path matching means `/take/start` in the matcher does NOT
 * route `/take/:token` to the API — that falls through to the SPA intentionally
 * (the React Router TokenLanding page renders for GET /take/<token>, then
 * POSTs /take/start). However, the PRESENCE of `/take/start` in the matcher
 * signals that the `/take/` segment is deliberately split: one specific path
 * goes to the API, everything else goes to the SPA.
 *
 * The lint encodes this intent as: "every non-/api/* mount must have SOME
 * @api-path entry whose first path segment overlaps with the mount's first
 * path segment." If nothing in the matcher covers `/foo/`, a new mount of
 * `/foo/anything` is a violation — the developer forgot to add a matcher
 * entry entirely.
 *
 * Worked examples (current repo):
 *   mount /help/:key   → matcher has /help/*   (segment /help/) → OK
 *   mount /take/start  → matcher has /take/start (segment /take/) → OK
 *   mount /embed       → matcher has /embed*   (segment /embed) → OK
 *   mount /foo/bar     → nothing covers /foo/  → VIOLATION
 *
 * ## Violation message format
 *
 * <file>:<line> mount "<url>" — not covered by Caddy @api matcher.
 *   Canonical matcher (docs/06-deployment.md): @api path <list>
 *   Add the path (or a prefix glob covering it) to the @api matcher in
 *   /opt/ti-platform/caddy/Caddyfile and run `caddy reload`.
 *   See RCA_LOG.md 2026-05-02 (/help/*) + 2026-05-03 (/take/*).
 *
 * Usage:
 *   pnpm tsx tools/lint-edge-routing.ts            # scan repo
 *   pnpm tsx tools/lint-edge-routing.ts --self-test # CI self-validation
 */

import * as path from "node:path";
import * as fsp from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { type Dirent } from "node:fs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
  ".turbo",
  "AccessIQ_UI_Template",
]);

// ---------------------------------------------------------------------------
// Canonical matcher extraction
// ---------------------------------------------------------------------------

/**
 * Reads docs/06-deployment.md and extracts the @api path matcher list.
 *
 * The doc contains a fenced Caddyfile block with a line like:
 *   @api path /api/* /embed* /help/* /take/start
 *
 * Returns the array of path patterns (e.g. ["/api/*", "/embed*", "/help/*", "/take/start"]).
 * Throws if the line is missing (indicates the doc section was restructured).
 */
async function readCanonicalMatcherFromDoc(): Promise<string[]> {
  const docPath = path.join(REPO_ROOT, "docs", "06-deployment.md");
  const content = await fsp.readFile(docPath, "utf8");
  return parseMatcherFromDocContent(content, docPath);
}

function parseMatcherFromDocContent(content: string, sourcePath: string): string[] {
  // Find the @api path line inside the Caddyfile fenced block.
  // The line looks like: "    @api path /api/* /embed* /help/* /take/start"
  // We match it regardless of leading whitespace.
  const matcherLineRe = /^\s*@api\s+path\s+(.+)$/m;
  const m = matcherLineRe.exec(content);
  if (m === null) {
    throw new Error(
      `Edge-routing lint: could not find '@api path ...' line in ${sourcePath}.\n` +
        `Expected a line like: @api path /api/* /embed* /help/* /take/start\n` +
        `inside the Caddyfile fenced block. Check docs/06-deployment.md § Current live state.`
    );
  }
  // Split on whitespace; each token is a path pattern.
  const patterns = m[1]!.trim().split(/\s+/).filter((p) => p.length > 0);
  if (patterns.length === 0) {
    throw new Error(
      `Edge-routing lint: '@api path' line in ${sourcePath} contains no path patterns.`
    );
  }
  return patterns;
}

// ---------------------------------------------------------------------------
// Caddy path-matching semantics
// ---------------------------------------------------------------------------

/**
 * Returns true if a concrete URL path is covered by a Caddy path matcher pattern.
 *
 * Caddy's `path` matcher supports:
 *   /foo/*   — matches /foo/ and anything starting with /foo/
 *   /foo*    — matches anything starting with /foo (no trailing slash required)
 *   /foo     — matches exactly /foo
 *
 * We also treat Fastify path parameters (:param) as wildcard segments — a
 * mount of /help/:key is "covered by" /help/* because the `:key` segment
 * will match any literal value at runtime.
 */
function caddyPathCoversUrl(pattern: string, url: string): boolean {
  if (pattern.endsWith("/*")) {
    // /foo/* matches /foo/ and /foo/<anything>
    const prefix = pattern.slice(0, -2); // e.g. "/foo"
    // Normalise the URL by stripping param tokens for segment comparison.
    const normUrl = normaliseUrl(url);
    return normUrl === prefix + "/" || normUrl.startsWith(prefix + "/");
  }
  if (pattern.endsWith("*")) {
    // /foo* matches anything starting with /foo
    const prefix = pattern.slice(0, -1); // e.g. "/embed"
    const normUrl = normaliseUrl(url);
    return normUrl.startsWith(prefix);
  }
  // Exact match — normalise both sides (strip trailing slash from both for safety).
  const normUrl = normaliseUrl(url);
  const normPattern = pattern.replace(/\/$/, "");
  return normUrl === normPattern;
}

/**
 * Normalise a Fastify URL pattern for Caddy-match comparison.
 * Replaces :param segments with a wildcard token so they compare equal to
 * any literal segment.  e.g. "/help/:key" → "/help/:param"
 * We don't need the actual replacement value — we use first-segment logic
 * for the coverage check, so this is just for the exact-match fallback.
 */
function normaliseUrl(url: string): string {
  return url.replace(/:[\w]+/g, ":param");
}

// ---------------------------------------------------------------------------
// First-segment-overlap check
// ---------------------------------------------------------------------------

/**
 * Returns the first path segment of a URL.
 * "/take/start"  → "/take"
 * "/embed"       → "/embed"
 * "/api/health"  → "/api"
 * "/take/:token" → "/take"
 */
function firstSegment(url: string): string {
  const parts = url.split("/").filter((p) => p.length > 0);
  if (parts.length === 0) return "/";
  return "/" + parts[0]!;
}

/**
 * Returns the first path segment covered by a Caddy matcher pattern.
 * "/api/*"   → "/api"
 * "/embed*"  → "/embed"
 * "/help/*"  → "/help"
 * "/take/start" → "/take"
 */
function firstSegmentOfPattern(pattern: string): string {
  // Strip trailing glob chars, then split
  const stripped = pattern.replace(/\*$/, "");
  return firstSegment(stripped);
}

/**
 * Returns true if a URL is covered by ANY entry in the canonical matcher list,
 * using the first-segment-overlap rule described in the file header.
 *
 * Step 1: Full Caddy path-match check (exact, glob).
 * Step 2: First-segment overlap — if ANY matcher entry has the same first
 *         segment as the URL, the URL's segment is "authorised" in the
 *         matcher even if the exact URL falls through to the SPA by design.
 *
 * Why step 2: /take/start in the matcher authorises the /take/ segment.
 * /take/:token is intentionally NOT in the matcher (falls to SPA), but a
 * developer who adds a NEW /take/<x> route still gets coverage — the segment
 * is known. Only an entirely unknown segment (e.g. /foo/) triggers a violation.
 */
function isCoveredByMatcher(url: string, canonicalPatterns: string[]): boolean {
  // Step 1: exact Caddy path match
  for (const pattern of canonicalPatterns) {
    if (caddyPathCoversUrl(pattern, url)) return true;
  }

  // Step 2: first-segment overlap
  const urlSeg = firstSegment(url);
  for (const pattern of canonicalPatterns) {
    if (firstSegmentOfPattern(pattern) === urlSeg) return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Route extraction from TypeScript source files
// ---------------------------------------------------------------------------

interface RouteMount {
  url: string;
  line: number;
  file: string;
}

/**
 * Extracts Fastify route mounts from a TypeScript source file.
 *
 * Handles two forms:
 *   1. app.METHOD("url", ...)   — METHOD ∈ get|post|put|patch|delete|head|options|all
 *   2. app.route({ ..., url: "url", ... })
 *
 * Only string literals are extracted (template literals and variables are
 * skipped with a warning — they're rare in this codebase and untrusted anyway).
 */
function extractRoutes(filePath: string, content: string): RouteMount[] {
  const routes: RouteMount[] = [];
  const lines = content.split("\n");

  // Pattern 1: app.METHOD("url"  or  app.METHOD('url'
  //   Captures: (1) method, (2) quote char, (3) url
  const methodRouteRe =
    /\bapp\.(get|post|put|patch|delete|head|options|all)\s*\(\s*(["'])([^"']+)\2/g;

  // Pattern 2: app.route({ ... url: "url" ... })
  //   We search for url: "..." or url: '...' properties
  const routeObjRe = /\bapp\.route\s*\(\s*\{[\s\S]*?url\s*:\s*(["'])([^"']+)\1/g;

  // Helper: find the 1-based line number for a match offset
  function lineOfOffset(offset: number): number {
    let line = 1;
    for (let i = 0; i < offset && i < content.length; i++) {
      if (content[i] === "\n") line++;
    }
    return line;
  }

  let m: RegExpExecArray | null;

  // Method-style routes
  while ((m = methodRouteRe.exec(content)) !== null) {
    const url = m[3]!;
    routes.push({ url, line: lineOfOffset(m.index), file: filePath });
  }

  // Route-object style
  while ((m = routeObjRe.exec(content)) !== null) {
    const url = m[2]!;
    routes.push({ url, line: lineOfOffset(m.index), file: filePath });
  }

  // Deduplicate by (url, line) — overlapping regexes can double-match
  const seen = new Set<string>();
  return routes.filter((r) => {
    const key = `${r.line}:${r.url}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ---------------------------------------------------------------------------
// Violation record
// ---------------------------------------------------------------------------

interface Violation {
  file: string;
  line: number;
  url: string;
  canonicalPatterns: string[];
}

function formatViolation(v: Violation): string {
  const rel = path.relative(REPO_ROOT, v.file);
  return (
    `${rel}:${v.line} mount "${v.url}" — not covered by Caddy @api matcher.\n` +
    `  Canonical matcher (docs/06-deployment.md): @api path ${v.canonicalPatterns.join(" ")}\n` +
    `  Add the path (or a prefix glob covering it) to the @api matcher in\n` +
    `  /opt/ti-platform/caddy/Caddyfile and run \`caddy reload\`.\n` +
    `  See RCA_LOG.md 2026-05-02 (/help/*) + 2026-05-03 (/take/*).`
  );
}

// ---------------------------------------------------------------------------
// Core validator — operates on a file path + its content + matcher list
// ---------------------------------------------------------------------------

function validateRouteFile(
  filePath: string,
  content: string,
  canonicalPatterns: string[]
): Violation[] {
  const mounts = extractRoutes(filePath, content);
  const violations: Violation[] = [];

  for (const mount of mounts) {
    const url = mount.url;

    // Ignore routes that start with /api/ — covered by @api path /api/*
    if (url.startsWith("/api/") || url === "/api") continue;

    // Check coverage
    if (!isCoveredByMatcher(url, canonicalPatterns)) {
      violations.push({
        file: filePath,
        line: mount.line,
        url,
        canonicalPatterns,
      });
    }
  }

  return violations;
}

// ---------------------------------------------------------------------------
// File discovery
// ---------------------------------------------------------------------------

/**
 * Finds all route-registration source files matching the fixed list:
 *   apps/api/src/server.ts
 *   apps/api/src/routes/ (all .ts files, recursive)
 *   modules/{n}-{name}/src/routes*.ts
 *   modules/{n}-{name}/src/{name}-routes.ts
 *   modules/{n}-{name}/src/{name}.routes.ts
 */
async function findRouteFiles(): Promise<string[]> {
  const results: string[] = [];

  // Fixed entry: apps/api/src/server.ts
  const serverTs = path.join(REPO_ROOT, "apps", "api", "src", "server.ts");
  try {
    await fsp.access(serverTs);
    results.push(serverTs);
  } catch {
    // Not present yet — skip silently
  }

  // apps/api/src/routes/*.ts
  const routesDir = path.join(REPO_ROOT, "apps", "api", "src", "routes");
  await collectTsFiles(routesDir, results, /* recursive */ true);

  // modules/*/src/ — patterns: routes*.ts, *-routes.ts, *.routes.ts
  const modulesDir = path.join(REPO_ROOT, "modules");
  let moduleDirs: Dirent[] = [];
  try {
    moduleDirs = await fsp.readdir(modulesDir, { withFileTypes: true });
  } catch {
    // No modules directory — skip
  }

  for (const modEntry of moduleDirs) {
    if (!modEntry.isDirectory()) continue;
    if (SKIP_DIRS.has(modEntry.name)) continue;
    const srcDir = path.join(modulesDir, modEntry.name, "src");
    let srcEntries: Dirent[] = [];
    try {
      srcEntries = await fsp.readdir(srcDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of srcEntries) {
      if (!entry.isFile()) continue;
      const name = entry.name;
      if (
        name.endsWith(".ts") &&
        (name.startsWith("routes") ||
          name.endsWith("-routes.ts") ||
          name.includes(".routes."))
      ) {
        results.push(path.join(srcDir, name));
      }
    }
  }

  return [...new Set(results)]; // deduplicate
}

/**
 * Recursively collects all .ts files under a directory, skipping SKIP_DIRS.
 */
async function collectTsFiles(dir: string, out: string[], recursive: boolean): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && recursive) {
      await collectTsFiles(full, out, recursive);
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      out.push(full);
    }
  }
}

// ---------------------------------------------------------------------------
// Self-test mode
// ---------------------------------------------------------------------------

function runSelfTest(): void {
  process.stdout.write("Edge-routing lint — running self-test...\n");

  // We test validateRouteFile() directly with inline content + matcher lists.
  // The matcher is passed as a parameter (not read from disk) so tests are hermetic.

  // -------------------------------------------------------------------------
  // Fixture 1: Valid — only /api/* mounts → 0 violations
  // -------------------------------------------------------------------------
  const fixture1Content = `
export async function registerHealthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/health', { config: { skipAuth: true } }, async () => ({ status: 'ok' }));
  app.post('/api/admin/users', { preHandler: adminOnly }, async (req, reply) => {});
}
`;
  const matcher1 = ["/api/*", "/embed*", "/help/*", "/take/start"];
  const v1 = validateRouteFile("<fixture:valid-api-only>", fixture1Content, matcher1);

  // -------------------------------------------------------------------------
  // Fixture 2: Valid — bare /help/:key covered by /help/* → 0 violations
  // -------------------------------------------------------------------------
  const fixture2Content = `
export async function registerHelpPublicRoutes(app: FastifyInstance): Promise<void> {
  app.get("/help/:key", async (req, reply) => {});
}
`;
  const matcher2 = ["/api/*", "/embed*", "/help/*", "/take/start"];
  const v2 = validateRouteFile("<fixture:valid-bare-covered>", fixture2Content, matcher2);

  // -------------------------------------------------------------------------
  // Fixture 3: Valid — /take/start covered by exact /take/start → 0 violations
  // -------------------------------------------------------------------------
  const fixture3Content = `
export async function registerAttemptTakeRoutes(app: FastifyInstance): Promise<void> {
  app.post("/take/start", { preHandler: publicChain }, async (req, reply) => {});
}
`;
  const matcher3 = ["/api/*", "/embed*", "/help/*", "/take/start"];
  const v3 = validateRouteFile("<fixture:valid-take-covered>", fixture3Content, matcher3);

  // -------------------------------------------------------------------------
  // Fixture 4: Invalid — /foo/bar not covered → 1 violation
  // -------------------------------------------------------------------------
  const fixture4Content = `
export async function registerFooRoutes(app: FastifyInstance): Promise<void> {
  app.get("/foo/bar", { config: { skipAuth: true } }, async () => ({}));
}
`;
  const matcher4 = ["/api/*", "/embed*", "/help/*", "/take/start"];
  const v4 = validateRouteFile("<fixture:invalid-missing>", fixture4Content, matcher4);

  // -------------------------------------------------------------------------
  // Fixture 5: Regression guard — /take/:token with narrow matcher /take/start
  //   → first-segment overlap on /take/ → 0 violations (intentional SPA fallthrough)
  // -------------------------------------------------------------------------
  const fixture5Content = `
export async function registerAttemptTakeRoutes(app: FastifyInstance): Promise<void> {
  app.post("/take/start", { preHandler: publicChain }, async (req, reply) => {});
  app.get("/take/:token", { preHandler: publicChain }, async (req, reply) => {});
}
`;
  const matcher5 = ["/api/*", "/embed*", "/help/*", "/take/start"];
  const v5 = validateRouteFile(
    "<fixture:valid-take-token-with-narrow-matcher>",
    fixture5Content,
    matcher5
  );

  // -------------------------------------------------------------------------
  // Fixture 5b: Negative regression — /take/:token with NO /take entry at all
  //   → 1 violation (the /take segment is entirely unknown)
  // -------------------------------------------------------------------------
  const fixture5bContent = `
export async function registerAttemptTakeRoutes(app: FastifyInstance): Promise<void> {
  app.get("/take/:token", { preHandler: publicChain }, async (req, reply) => {});
}
`;
  const matcher5b = ["/api/*", "/embed*", "/help/*"];
  // /take/:token — first segment /take/ has NO overlap in matcher5b → violation
  const v5b = validateRouteFile(
    "<fixture:invalid-take-token-against-no-take-matcher>",
    fixture5bContent,
    matcher5b
  );

  // -------------------------------------------------------------------------
  // Fixture 6: Route-object style — app.route({ url: "/embed/widget" })
  //   covered by /embed* → 0 violations
  // -------------------------------------------------------------------------
  const fixture6Content = `
export async function registerEmbedRoutes(app: FastifyInstance): Promise<void> {
  app.route({
    method: "GET",
    url: "/embed/widget",
    handler: async (req, reply) => {},
  });
}
`;
  const matcher6 = ["/api/*", "/embed*", "/help/*", "/take/start"];
  const v6 = validateRouteFile("<fixture:route-options-style>", fixture6Content, matcher6);

  // -------------------------------------------------------------------------
  // Run assertions
  // -------------------------------------------------------------------------
  let passed = true;

  if (v1.length !== 0) {
    process.stderr.write(
      `FAIL fixture 1 (valid-api-only): expected 0 violations, got ${v1.length}: ${JSON.stringify(v1.map((v) => v.url))}\n`
    );
    passed = false;
  } else {
    process.stdout.write("  PASS fixture 1 — /api/* only → 0 violations (expected)\n");
  }

  if (v2.length !== 0) {
    process.stderr.write(
      `FAIL fixture 2 (valid-bare-covered): expected 0 violations, got ${v2.length}: ${JSON.stringify(v2.map((v) => v.url))}\n`
    );
    passed = false;
  } else {
    process.stdout.write("  PASS fixture 2 — /help/:key covered by /help/* → 0 violations (expected)\n");
  }

  if (v3.length !== 0) {
    process.stderr.write(
      `FAIL fixture 3 (valid-take-covered): expected 0 violations, got ${v3.length}: ${JSON.stringify(v3.map((v) => v.url))}\n`
    );
    passed = false;
  } else {
    process.stdout.write("  PASS fixture 3 — /take/start exact match → 0 violations (expected)\n");
  }

  if (v4.length !== 1 || v4[0]!.url !== "/foo/bar") {
    process.stderr.write(
      `FAIL fixture 4 (invalid-missing): expected 1 violation for /foo/bar, got ${JSON.stringify(v4.map((v) => v.url))}\n`
    );
    passed = false;
  } else {
    process.stdout.write("  PASS fixture 4 — /foo/bar missing → 1 violation (expected)\n");
  }

  if (v5.length !== 0) {
    process.stderr.write(
      `FAIL fixture 5 (valid-take-token-with-narrow-matcher): expected 0 violations (first-segment overlap on /take/), got ${v5.length}: ${JSON.stringify(v5.map((v) => v.url))}\n`
    );
    passed = false;
  } else {
    process.stdout.write(
      "  PASS fixture 5 — /take/:token first-segment overlap with /take/start → 0 violations (expected)\n"
    );
  }

  if (v5b.length !== 1 || v5b[0]!.url !== "/take/:token") {
    process.stderr.write(
      `FAIL fixture 5b (invalid-take-token-against-no-take-matcher): expected 1 violation for /take/:token, got ${JSON.stringify(v5b.map((v) => v.url))}\n`
    );
    passed = false;
  } else {
    process.stdout.write(
      "  PASS fixture 5b — /take/:token with no /take entry in matcher → 1 violation (expected)\n"
    );
  }

  if (v6.length !== 0) {
    process.stderr.write(
      `FAIL fixture 6 (route-options-style): expected 0 violations, got ${v6.length}: ${JSON.stringify(v6.map((v) => v.url))}\n`
    );
    passed = false;
  } else {
    process.stdout.write(
      "  PASS fixture 6 — app.route({ url: '/embed/widget' }) covered by /embed* → 0 violations (expected)\n"
    );
  }

  if (passed) {
    process.stdout.write("Edge-routing lint self-test: PASSED\n");
    process.exit(0);
  } else {
    process.stderr.write("Edge-routing lint self-test: FAILED\n");
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
    return; // runSelfTest calls process.exit, but keep TS happy
  }

  // Read the canonical matcher from the deployment doc
  const canonicalPatterns = await readCanonicalMatcherFromDoc();

  // Discover route files
  const files = await findRouteFiles();

  const allViolations: Violation[] = [];
  let filesScanned = 0;
  let mountsChecked = 0;

  for (const file of files) {
    let content: string;
    try {
      content = await fsp.readFile(file, "utf8");
    } catch {
      continue; // unreadable — skip
    }
    const violations = validateRouteFile(file, content, canonicalPatterns);
    allViolations.push(...violations);
    filesScanned++;
    mountsChecked += extractRoutes(file, content).length;
  }

  if (allViolations.length > 0) {
    for (const v of allViolations) {
      process.stderr.write(formatViolation(v) + "\n\n");
    }
    process.stderr.write(
      `Edge-routing lint: FAILED — ${allViolations.length} violation(s) found.\n`
    );
    process.exit(1);
  }

  process.stdout.write(
    `Edge-routing lint: OK (${filesScanned} files scanned, ${mountsChecked} route mounts checked, ` +
      `canonical matcher: @api path ${canonicalPatterns.join(" ")})\n`
  );
  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(`Edge-routing lint error: ${String(err)}\n`);
  process.exit(1);
});
