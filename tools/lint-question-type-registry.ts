/**
 * tools/lint-question-type-registry.ts
 *
 * Keeps packages/question-types the single source of truth for question-type
 * ids (RW-54a step 8). WARN mode by default: prints hits, exits 0.
 *
 *   tsx tools/lint-question-type-registry.ts             warn mode
 *   tsx tools/lint-question-type-registry.ts --strict    exit 1 on any hit
 *   tsx tools/lint-question-type-registry.ts --self-test check R3/R5 on fixtures
 *
 * Rules (output: file:line RULE message)
 *   R1 each packages/question-types/src/types/<id>/index.ts exports `definition`
 *      with every required key.
 *   R2 folder names equal QUESTION_TYPES; definition.id equals its folder name.
 *   R3 `case '<id>'`, `=== '<id>'`, `!== '<id>'`, `== '<id>'`, `!= '<id>'`, the reversed
 *      forms (`'<id>' === x`), SQL `IN ('<id>'` outside ALLOWLIST (registry package, the two
 *      renderer maps, gen-question-type-check, tests, e2e/, migrations).
 *   R4 each renderer map has an entry for every id.
 *   R5 a re-declared union or array of 2+ type-id literals outside the registry, on one line
 *      or one literal per line (`| 'mcq'` / `'mcq',` on two or more consecutive lines).
 *      Typed subsets written as Extract<QuestionType, ...> / Exclude<QuestionType, ...>
 *      are allowed (they are checked against the registry by the compiler).
 *   R6 every registry definition implements every RW-68 member: flags with valid values and
 *      the behaviour functions. deterministicScore exists exactly when scoring is
 *      'deterministic'; synthConcepts exists exactly when rubricSynthesis is not 'none'.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = resolve(import.meta.dirname, "..");
const TYPES_DIR = "packages/question-types/src/types";
const RENDERER_MAPS = [
  "modules/10-admin-dashboard/src/question-types/renderers.tsx",
  "apps/web/src/pages/take/renderers.tsx",
];
/** Files that may enumerate type literals. Everything else goes through the registry. */
export const ALLOWLIST: readonly (string | RegExp)[] = [
  /^packages\/question-types\//,
  ...RENDERER_MAPS,
  "tools/lint-question-type-registry.ts",
  "tools/gen-question-type-check.ts",
  /\.test\.[cm]?[jt]sx?$/,
  /(^|\/)__tests__\//,
  /(^|\/)e2e\//,
  /(^|\/)migrations\//,
  // Per-domain supported_types seed data (migration 0020 values), not type dispatch.
  "modules/04-question-bank/src/seed.ts",
  // Standalone package: built with `npm install && npx tsc` on the VPS and cannot import
  // workspace packages. Its coerce/enum copies are pinned to the registry by
  // modules/04-question-bank/src/__tests__/mcp-coerce-parity.test.ts.
  /^tools\/assessiq-mcp\//,
];

const REQUIRED_KEYS = [
  "id", "label", "contentSchema", "answerSchema", "importColumns",
  "qtiInteraction", "generatorSkill", "scoring", "helpKey",
] as const;

export interface Hit { file: string; line: number; rule: string; message: string }

export function isAllowlisted(file: string): boolean {
  return ALLOWLIST.some((a) => (typeof a === "string" ? a === file : a.test(file)));
}

/** R3 + R5 on one file's text. Pure, used by the self-test. */
export function scanText(file: string, text: string, ids: readonly string[]): Hit[] {
  if (isAllowlisted(file)) return [];
  const alt = ids.join("|");
  const r3 = [
    new RegExp(`\\bcase\\s+['"](${alt})['"]`),
    new RegExp(`[!=]==?\\s*['"](${alt})['"]`),
    new RegExp(`['"](${alt})['"]\\s*[!=]==?`),
    new RegExp(`\\bIN\\s*\\(\\s*['"](${alt})['"]`, "i"),
  ];
  const r5 = new RegExp(`['"](${alt})['"]\\s*[|,]\\s*['"](${alt})['"]`);
  // one literal per line: `| 'mcq'` or `'mcq',` alone on a line (2+ consecutive lines make a list)
  const sole = new RegExp("^(?:\\|\\s*)?['\"](?:" + alt + ")['\"][,;]?$");
  let prevSole = false;
  const hits: Hit[] = [];
  text.split("\n").forEach((raw, i) => {
    const line = raw.trim();
    const isSole = sole.test(line);
    const consecutive = isSole && prevSole;
    prevSole = isSole;
    if (consecutive) hits.push({ file, line: i + 1, rule: "R5", message: "re-declared union/list of question-type ids, one per line; import QuestionType / QUESTION_TYPES" });
    if (line.startsWith("//") || line.startsWith("*") || line.startsWith("/*")) return;
    for (const re of r3) {
      const m = re.exec(raw);
      if (m) { hits.push({ file, line: i + 1, rule: "R3", message: `question-type id '${m[1]}' compared outside the registry; use the registry or a renderer map` }); break; }
    }
    if (/\b(Extract|Exclude)<\w*QuestionType/.test(raw)) return;
    if (r5.test(raw)) hits.push({ file, line: i + 1, rule: "R5", message: "re-declared union/array of question-type ids; import QuestionType / QUESTION_TYPES" });
  });
  return hits;
}

/** R4 on one renderer-map source. Pure. */
export function checkRendererMap(file: string, text: string, ids: readonly string[]): Hit[] {
  const start = text.indexOf("rendererMap");
  if (start < 0) return [{ file, line: 1, rule: "R4", message: "no rendererMap found" }];
  const body = text.slice(text.indexOf("{", text.indexOf("=", start)), text.indexOf("satisfies", start));
  const line = text.slice(0, start).split("\n").length;
  return ids
    .filter((id) => !new RegExp(`^\\s*${id}\\s*:`, "m").test(body))
    .map((id) => ({ file, line, rule: "R4", message: `rendererMap has no entry for '${id}'` }));
}

async function registryHits(): Promise<{ hits: Hit[]; ids: string[] }> {
  const hits: Hit[] = [];
  const reg = (await import(pathToFileURL(join(ROOT, "packages/question-types/src/index.ts")).href)) as {
    QUESTION_TYPES: readonly string[];
  };
  const ids = [...reg.QUESTION_TYPES];
  const dir = join(ROOT, TYPES_DIR);
  const folders = readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  const regFile = "packages/question-types/src/registry.ts";
  for (const id of ids) {
    if (!folders.includes(id)) hits.push({ file: regFile, line: 1, rule: "R2", message: `QUESTION_TYPES has '${id}' but no folder ${TYPES_DIR}/${id}` });
  }
  for (const f of folders) {
    const rel = `${TYPES_DIR}/${f}/index.ts`;
    if (!ids.includes(f)) hits.push({ file: rel, line: 1, rule: "R2", message: `folder '${f}' is not in QUESTION_TYPES` });
    if (!existsSync(join(ROOT, rel))) { hits.push({ file: rel, line: 1, rule: "R1", message: "index.ts missing" }); continue; }
    const mod = (await import(pathToFileURL(join(ROOT, rel)).href)) as { definition?: Record<string, unknown> };
    if (!mod.definition) { hits.push({ file: rel, line: 1, rule: "R1", message: "does not export `definition`" }); continue; }
    for (const k of REQUIRED_KEYS) {
      if (!(k in mod.definition)) hits.push({ file: rel, line: 1, rule: "R1", message: `definition is missing key '${k}'` });
    }
    hits.push(...checkDefinition(rel, mod.definition));
    if (mod.definition.id !== f) hits.push({ file: rel, line: 1, rule: "R2", message: `definition.id '${String(mod.definition.id)}' differs from folder '${f}'` });
  }
  return { hits, ids };
}

const FLAG_VALUES = {
  rubricSynthesis: ["none", "expected_findings", "steps_expected"],
  shuffleField: ["options", "items", null],
} as const;
const REQUIRED_FUNCTIONS = ["candidateView", "coerceContent", "guidanceText", "rubricText", "evalStructuralCheck"] as const;
const REQUIRED_BOOLEANS = ["aiGradeable", "rubricRequired"] as const;

/** R6 on one definition object. Pure, used by the self-test. */
export function checkDefinition(file: string, d: Record<string, unknown>): Hit[] {
  const hits: Hit[] = [];
  const add = (message: string): void => { hits.push({ file, line: 1, rule: "R6", message }); };
  for (const k of REQUIRED_BOOLEANS) if (typeof d[k] !== "boolean") add(`${k} must be a boolean`);
  for (const [k, allowed] of Object.entries(FLAG_VALUES)) {
    if (!(allowed as readonly unknown[]).includes(d[k])) add(`${k} must be one of ${allowed.map(String).join(" | ")}`);
  }
  for (const k of REQUIRED_FUNCTIONS) if (typeof d[k] !== "function") add(`missing function '${k}'`);
  const det = d.scoring === "deterministic";
  if (det && typeof d.deterministicScore !== "function") add("scoring is 'deterministic' but deterministicScore is missing");
  if (!det && d.deterministicScore !== undefined) add("scoring is 'ai' but deterministicScore is present");
  const synth = d.rubricSynthesis !== "none";
  if (synth && typeof d.synthConcepts !== "function") add("rubricSynthesis is set but synthConcepts is missing");
  if (!synth && d.synthConcepts !== undefined) add("rubricSynthesis is 'none' but synthConcepts is present");
  if (d.checkAnswer !== undefined && typeof d.checkAnswer !== "function") add("checkAnswer must be a function when present");
  return hits;
}

function selfTest(): void {
  const ids = ["mcq", "subjective", "kql"];
  const t = (file: string, text: string): Hit[] => scanText(file, text, ids);
  const rules = (h: Hit[]): string => h.map((x) => x.rule).join(",");
  const assert = (ok: boolean, msg: string): void => { if (!ok) { console.error(`self-test FAIL: ${msg}`); process.exit(1); } };
  assert(rules(t("a.ts", "switch (t) { case 'mcq': break; }")) === "R3", "case");
  assert(rules(t("a.ts", "if (q.type === \"kql\") {}")) === "R3", "===");
  assert(rules(t("a.ts", "if (q.type !== 'mcq') {}")) === "R3", "!==");
  assert(rules(t("a.sql", "WHERE type IN ('mcq', 'kql')")).startsWith("R3"), "sql IN");
  assert(rules(t("a.ts", "type T = 'mcq' | 'subjective';")) === "R5", "union");
  assert(rules(t("a.ts", "const x = [\"mcq\", \"subjective\"];")) === "R5", "array");
  assert(t("a.ts", "type T = Extract<QuestionType, 'mcq' | 'kql'>;").length === 0, "Extract allowed");
  assert(t("a.ts", "// case 'mcq':").length === 0, "comment skipped");
  assert(t("packages/question-types/src/x.ts", "case 'mcq':").length === 0, "registry allowlisted");
  assert(t("a.test.ts", "case 'mcq':").length === 0, "test allowlisted");
  assert(t("modules/x/migrations/1.sql", "IN ('mcq'").length === 0, "migration allowlisted");
  assert(t("apps/web/e2e/a.ts", "=== 'mcq'").length === 0, "e2e allowlisted");
  assert(t("a.ts", "const kind = 'mcq';").length === 0, "plain literal ok");
  assert(rules(t("a.ts", "if ('mcq' === q.type) {}")) === "R3", "reversed ===");
  assert(rules(t("a.ts", "if (\"kql\" == x) {}")) === "R3", "reversed ==");
  assert(rules(t("a.ts", "if (x != 'mcq') {}")) === "R3", "!=");
  assert(t("a.ts", "x => 'mcq'").length === 0, "arrow ok");
  assert(rules(t("a.ts", "type T =\n  | 'mcq'\n  | 'kql';")) === "R5", "multi-line union");
  assert(rules(t("a.ts", "const x = [\n  'mcq',\n  'kql',\n];")) === "R5", "multi-line list");
  assert(t("a.ts", "type T =\n  | 'mcq'\n  | string;").length === 0, "single multi-line member ok");
  assert(t("tools/gen-question-type-check.ts", "case 'mcq':").length === 0, "gen script allowlisted");
  const good = { aiGradeable: false, rubricRequired: false, rubricSynthesis: "none", shuffleField: null, scoring: "ai", candidateView() {}, coerceContent() {}, guidanceText() {}, rubricText() {}, evalStructuralCheck() {} };
  assert(checkDefinition("d", good).length === 0, "R6 good");
  assert(checkDefinition("d", { ...good, scoring: "deterministic" }).length === 1, "R6 deterministic without score");
  assert(checkDefinition("d", { ...good, deterministicScore() {} }).length === 1, "R6 ai with score");
  assert(checkDefinition("d", { ...good, candidateView: undefined }).length === 1, "R6 missing function");
  assert(checkDefinition("d", { ...good, rubricSynthesis: "expected_findings" }).length === 1, "R6 synth without concepts");
  assert(checkRendererMap("m.tsx", "export const rendererMap = {\n  mcq: a,\n  kql: b,\n} satisfies X;", ids).length === 1, "R4 missing 1");
  assert(checkRendererMap("m.tsx", "export const rendererMap = {\n  mcq: a,\n  subjective: b,\n  kql: c,\n} satisfies X;", ids).length === 0, "R4 full");
  console.log("lint-question-type-registry self-test OK");
}

async function main(): Promise<void> {
  if (process.argv.includes("--self-test")) return selfTest();
  const strict = process.argv.includes("--strict");
  const { hits, ids } = await registryHits();

  for (const m of RENDERER_MAPS) {
    const p = join(ROOT, m);
    if (!existsSync(p)) { hits.push({ file: m, line: 1, rule: "R4", message: "renderer map file missing" }); continue; }
    hits.push(...checkRendererMap(m, readFileSync(p, "utf8"), ids));
  }

  const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
    .split("\n").filter((f) => /\.(ts|tsx|mts|sql)$/.test(f) && !f.endsWith(".d.ts") && !f.startsWith("docs/"));
  for (const f of files) {
    if (!existsSync(join(ROOT, f))) continue;
    hits.push(...scanText(f, readFileSync(join(ROOT, f), "utf8"), ids));
  }

  hits.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  for (const h of hits) console.log(`${h.file}:${h.line} ${h.rule} ${h.message}`);
  const per = ["R1", "R2", "R3", "R4", "R5", "R6"].map((r) => `${r}=${hits.filter((h) => h.rule === r).length}`).join(" ");
  console.log(`lint-question-type-registry: ${hits.length} hit(s) (${per}) [${strict ? "strict" : "warn"}]`);
  process.exit(strict && hits.length > 0 ? 1 : 0);
}

void main();
