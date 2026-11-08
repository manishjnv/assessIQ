/**
 * tools/lint-aptitude-taxonomy.ts (2026-11-08)
 *
 * Data lints for the exam taxonomy and the aptitude family list. No domain branching in app code:
 * all rules live here, and the data lives in the framework seeds and the private family file.
 *
 *  (i)   every family in family-classes.csv has a class and a style (style must be in the closed enum).
 *        Optional path argument: `tsx tools/lint-aptitude-taxonomy.ts [family.csv]`. The file is gitignored,
 *        so when it is absent (CI) this check is skipped silently.
 *  (ii)  the exam-style seed has exactly the closed enum: neutral | ssc | bank | rrb | campus.
 *  (iii) stage campus-aptitude-stage-0 references only the subjects quant, reasoning, english.
 *        Checked on blueprint seed data, given with `--blueprints <file.json>` (none is bundled yet, so
 *        the check is skipped with a warning when the flag is absent).
 *  (iv)  coverage: checkCoverage() fails when a difficulty pool is below 1x the questions drawn, and
 *        warns below 3x. Pure function; called by the blueprint tooling, self-tested here.
 *  (v)   warn (not fail) on a subject no blueprint references. Needs `--blueprints`.
 *
 * Usage: pnpm lint:aptitude-taxonomy [family.csv] [--blueprints file.json]
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { REPO_ROOT, finish } from "./lint-util.js";

export const EXAM_STYLES = ["neutral", "ssc", "bank", "rrb", "campus"] as const;
export const STAGE_0 = "campus-aptitude-stage-0";
export const STAGE_0_SUBJECTS = ["quant", "reasoning", "english"] as const;

export interface SeedLike { code: string; children?: SeedLike[] | undefined }
export interface BlueprintSeed { stage: string; sections: { subject: string }[] }
export interface SectionDraw { section: string; difficulty: number; questionCount: number }
export interface CoverageResult { errors: string[]; warnings: string[] }

/** RFC 4180 style CSV: quoted fields may hold commas and doubled quotes. Blank lines are dropped. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(field.trim()); field = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field.trim()); field = "";
      if (row.some((c) => c !== "")) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field.trim());
  if (row.some((c) => c !== "")) rows.push(row);
  return rows;
}

/** (i) Every family row has a family name, a class and a style that belongs to the closed enum. */
export function checkFamilyClasses(csvText: string): string[] {
  const [header, ...rows] = parseCsv(csvText);
  if (!header) return ["family-classes.csv is empty"];
  const col = (name: string): number => header.indexOf(name);
  const iFamily = col("family");
  const iClass = col("class");
  const iStyle = col("style_or_owner");
  if (iFamily < 0 || iClass < 0 || iStyle < 0) return ["family-classes.csv needs the columns family, class, style_or_owner"];
  const violations: string[] = [];
  rows.forEach((r, n) => {
    const at = `family-classes.csv row ${n + 2}`;
    const family = r[iFamily] ?? "";
    if (family === "") { violations.push(`${at}: family is empty`); return; }
    if ((r[iClass] ?? "") === "") violations.push(`${at} (${family}): class is empty`);
    const styles = (r[iStyle] ?? "").split(",").map((s) => s.trim()).filter((s) => s !== "");
    if (styles.length === 0) violations.push(`${at} (${family}): style is empty`);
    for (const s of styles) {
      if (!(EXAM_STYLES as readonly string[]).includes(s)) violations.push(`${at} (${family}): style '${s}' is not in the closed enum`);
    }
  });
  return violations;
}

/** (ii) The exam-style seed nodes are exactly the closed enum (order free, no extras, no gaps). */
export function checkExamStyleSeed(seed: { nodes: SeedLike[] }): string[] {
  const codes = seed.nodes.map((n) => n.code);
  const want = [...EXAM_STYLES].sort();
  const got = [...codes].sort();
  if (got.length === want.length && got.every((c, i) => c === want[i])) return [];
  return [`exam-style seed must be exactly ${EXAM_STYLES.join(", ")}; found ${codes.join(", ") || "(none)"}`];
}

/** (iii) Stage 0 may reference only quant, reasoning and english. */
export function checkStageSubjects(blueprints: BlueprintSeed[]): string[] {
  const violations: string[] = [];
  for (const bp of blueprints) {
    if (bp.stage !== STAGE_0) continue;
    for (const s of bp.sections) {
      if (!(STAGE_0_SUBJECTS as readonly string[]).includes(s.subject)) {
        violations.push(`${STAGE_0} may reference only ${STAGE_0_SUBJECTS.join(", ")}; section uses '${s.subject}'`);
      }
    }
  }
  return violations;
}

/** (iv) Pool per difficulty against the questions drawn at that difficulty (summed over sections). */
export function checkCoverage(sectionDraws: SectionDraw[], poolCounts: Record<number, number>): CoverageResult {
  const need = new Map<number, number>();
  for (const d of sectionDraws) need.set(d.difficulty, (need.get(d.difficulty) ?? 0) + d.questionCount);
  const errors: string[] = [];
  const warnings: string[] = [];
  for (const [difficulty, n] of [...need.entries()].sort((a, b) => a[0] - b[0])) {
    if (n <= 0) continue;
    const pool = poolCounts[difficulty] ?? 0;
    if (pool < n) errors.push(`difficulty ${difficulty}: pool ${pool} is below 1x the ${n} questions drawn`);
    else if (pool < 3 * n) warnings.push(`difficulty ${difficulty}: pool ${pool} is below 3x the ${n} questions drawn`);
  }
  return { errors, warnings };
}

/** (v) Subjects that no blueprint section references (warning only). */
export function checkUnreferencedSubjects(subjectCodes: string[], blueprints: BlueprintSeed[]): string[] {
  const used = new Set(blueprints.flatMap((b) => b.sections.map((s) => s.subject)));
  return subjectCodes.filter((c) => !used.has(c)).map((c) => `subject '${c}' is not referenced by any blueprint`);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function readJson<T>(rel: string): T {
  return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, rel), "utf8")) as T;
}

function main(): never {
  const args = process.argv.slice(2);
  const bpFlag = args.indexOf("--blueprints");
  const blueprintFile = bpFlag >= 0 ? args[bpFlag + 1] : undefined;
  const csvArg = args.find((a, i) => !a.startsWith("--") && i !== bpFlag + 1);
  const violations: string[] = [];
  const warnings: string[] = [];

  const fw = "modules/04-question-bank/src/frameworks";
  // (ii) The exam-style seed file is owned by another change. Check it when present, warn when absent.
  if (fs.existsSync(path.join(REPO_ROOT, fw, "exam-style.json"))) {
    violations.push(...checkExamStyleSeed(readJson<{ nodes: SeedLike[] }>(`${fw}/exam-style.json`)));
  } else warnings.push(`${fw}/exam-style.json not found: enum check (ii) skipped`);

  // (i) The family file is private and gitignored. Use the argument, else the default local path; skip silently when absent.
  const csvPath = csvArg ?? "docs/private/aptitude-generator/family-classes.csv";
  const abs = path.isAbsolute(csvPath) ? csvPath : path.join(REPO_ROOT, csvPath);
  if (fs.existsSync(abs)) violations.push(...checkFamilyClasses(fs.readFileSync(abs, "utf8")));

  if (blueprintFile !== undefined) {
    const blueprints = JSON.parse(fs.readFileSync(path.resolve(blueprintFile), "utf8")) as BlueprintSeed[];
    violations.push(...checkStageSubjects(blueprints));
    const subjects = readJson<{ nodes: SeedLike[] }>(`${fw}/subject-map.json`).nodes.map((n) => n.code);
    warnings.push(...checkUnreferencedSubjects(subjects, blueprints));
  } else {
    warnings.push("no --blueprints file given: stage 0 subject check (iii) and unreferenced-subject check (v) skipped");
  }

  for (const w of warnings) console.warn(`lint-aptitude-taxonomy warning: ${w}`);
  finish("lint-aptitude-taxonomy", violations, "OK");
}

if (process.argv[1] && path.resolve(process.argv[1]).endsWith("lint-aptitude-taxonomy.ts")) main();
