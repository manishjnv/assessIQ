// AssessIQ — modules/07-ai-grading/eval/metrics.ts
//
// Pure helpers for the eval harness (Z-164 EVAL-HARDEN). No file or process access, no AI call, so
// the unit tests can import it (cli.ts cannot be imported: its CI guard and its top-level switch run on load).
// Decision rules baked in (Opus 5.5 review, 2026-10-23): errors count as misses; judge only on cases that
// were not used for tuning; compare two setups with paired per-case counts (McNemar), not with two percentages.

export interface EvalExpected {
  id: string;
  anchors: Array<{ anchor_id: string; hit: boolean }>;
  band: number;
  adversarial: boolean;
}

export interface EvalActual {
  id: string;
  band: number | null;
  anchors: Array<{ anchor_id: string; hit: boolean }>;
  error?: { code: string; message: string };
  /** Stage 1 payload did not parse and the runtime fell back to "reasoning only" (AIG_STAGE1_DEGRADED). */
  degraded?: boolean;
  error_class?: string | null;
  /** "2" band stage kept the verdict, "3" the escalation stage decided, "manual" the two disagreed. */
  escalation_stage?: string | null;
  escalation_model?: string | null;
}

// ---------------------------------------------------------------------------
// E1 — abort rule
// ---------------------------------------------------------------------------

/** Abort after this many cases in a row that end in an error (usage limit, auth, config). */
export const MAX_CONSECUTIVE_ERRORS = 3;
/** Abort when errors pass this share of the planned cases (a failure that hides between successes). */
export const MAX_ERROR_SHARE = 0.05;

export function abortReasonForErrors(s: { consecutive: number; errors: number; planned: number }): string | null {
  if (s.consecutive >= MAX_CONSECUTIVE_ERRORS) return `${s.consecutive} errors in a row`;
  if (s.planned > 0 && s.errors / s.planned > MAX_ERROR_SHARE) {
    return `${s.errors} errors, more than ${MAX_ERROR_SHARE * 100}% of ${s.planned} planned cases`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// E2 — run validity
// ---------------------------------------------------------------------------

export interface RunValidity {
  valid: boolean;
  problems: string[];
}

/** A run is valid only with zero errors, no degraded Stage 1, and anchors present on every anchored case. */
export function checkRunValidity(
  actuals: EvalActual[],
  expectedMap: Map<string, EvalExpected>,
  abortedReason: string | null = null,
): RunValidity {
  const problems: string[] = [];
  if (abortedReason) problems.push(`run was aborted: ${abortedReason}`);
  const errored = actuals.filter((a) => a.error).map((a) => a.id);
  if (errored.length > 0) problems.push(`${errored.length} case(s) errored: ${errored.join(", ")}`);
  const degraded = actuals.filter((a) => !a.error && a.degraded).map((a) => a.id);
  if (degraded.length > 0) problems.push(`${degraded.length} case(s) with a degraded Stage 1: ${degraded.join(", ")}`);
  const noAnchors = actuals
    .filter((a) => !a.error && !a.degraded && (expectedMap.get(a.id)?.anchors.length ?? 0) > 0 && a.anchors.length === 0)
    .map((a) => a.id);
  if (noAnchors.length > 0) problems.push(`${noAnchors.length} anchored case(s) returned no anchors: ${noAnchors.join(", ")}`);
  return { valid: problems.length === 0, problems };
}

// ---------------------------------------------------------------------------
// E4 — band statistics
// ---------------------------------------------------------------------------

export interface BandStats {
  /** Cases per band 0..4: how many were expected there and how many were graded there. */
  distribution: Array<{ band: number; expected: number; actual: number }>;
  /** By expected band: graded higher (over) or lower (under) than expected. */
  over: number[];
  under: number[];
  overTotal: number;
  underTotal: number;
  exactPct: number;
  /** Share of cases graded within one band of the expected band. */
  withinOnePct: number;
  /** Quadratic-weighted kappa on the graded cases (null when undefined). */
  kappaQw: number | null;
}

const BANDS = 5;

export function bandStats(pairs: Array<{ expected: number; actual: number | null }>): BandStats {
  const dist = Array.from({ length: BANDS }, (_, band) => ({ band, expected: 0, actual: 0 }));
  const over = new Array<number>(BANDS).fill(0);
  const under = new Array<number>(BANDS).fill(0);
  let exact = 0;
  let within = 0;
  const matrix = Array.from({ length: BANDS }, () => new Array<number>(BANDS).fill(0));
  let graded = 0;
  for (const { expected, actual } of pairs) {
    dist[expected]!.expected++;
    if (actual === null) continue; // an error is a miss: it adds to no cell below
    graded++;
    dist[actual]!.actual++;
    matrix[expected]![actual]!++;
    if (actual === expected) exact++;
    else if (actual > expected) over[expected]!++;
    else under[expected]!++;
    if (Math.abs(actual - expected) <= 1) within++;
  }
  const n = pairs.length;
  return {
    distribution: dist,
    over,
    under,
    overTotal: over.reduce((a, b) => a + b, 0),
    underTotal: under.reduce((a, b) => a + b, 0),
    exactPct: n > 0 ? round2((exact / n) * 100) : 0,
    withinOnePct: n > 0 ? round2((within / n) * 100) : 0,
    kappaQw: graded > 0 ? quadraticKappa(matrix, graded) : null,
  };
}

function quadraticKappa(matrix: number[][], n: number): number | null {
  const rows = matrix.map((r) => r.reduce((a, b) => a + b, 0));
  const cols = matrix[0]!.map((_, j) => matrix.reduce((a, r) => a + r[j]!, 0));
  let observed = 0;
  let expected = 0;
  for (let i = 0; i < BANDS; i++) {
    for (let j = 0; j < BANDS; j++) {
      const w = ((i - j) * (i - j)) / ((BANDS - 1) * (BANDS - 1));
      observed += w * matrix[i]![j]!;
      expected += (w * rows[i]! * cols[j]!) / n;
    }
  }
  if (expected === 0) return null; // all cases in one band: kappa is undefined
  return Math.round((1 - observed / expected) * 1000) / 1000;
}

// ---------------------------------------------------------------------------
// E15 — anchor F1 (micro and macro, never pooled across questions)
// ---------------------------------------------------------------------------

/** "aiq-log-L1-4-02" -> "aiq-log-L1-4": the question; the last two digits are the answer variant. */
export function questionKey(caseId: string): string {
  return caseId.replace(/-\d{2}$/, "");
}

export interface AnchorF1 {
  micro: number;
  macro: number;
  perAnchor: Record<string, number>;
  /** Anchors with no expected hit and no false positive: no F1 exists, they are left out of the macro mean. */
  undefinedCount: number;
}

export function anchorF1(actuals: EvalActual[], expectedMap: Map<string, EvalExpected>): AnchorF1 {
  const stats = new Map<string, { tp: number; fp: number; fn: number }>();
  for (const a of actuals) {
    const exp = expectedMap.get(a.id);
    if (!exp) continue;
    // An errored or degraded case has no anchors: every expected hit is a miss.
    const got = new Map(a.anchors.map((x) => [x.anchor_id, x.hit]));
    for (const ea of exp.anchors) {
      const key = `${questionKey(a.id)}|${ea.anchor_id}`;
      const s = stats.get(key) ?? { tp: 0, fp: 0, fn: 0 };
      const hit = got.get(ea.anchor_id) ?? false;
      if (ea.hit && hit) s.tp++;
      else if (!ea.hit && hit) s.fp++;
      else if (ea.hit && !hit) s.fn++;
      stats.set(key, s);
    }
  }
  const perAnchor: Record<string, number> = {};
  let sum = 0;
  let defined = 0;
  let undef = 0;
  let tp = 0;
  let fp = 0;
  let fn = 0;
  for (const [key, s] of stats) {
    tp += s.tp;
    fp += s.fp;
    fn += s.fn;
    if (s.tp + s.fp + s.fn === 0) {
      undef++;
      continue;
    }
    const f1 = (2 * s.tp) / (2 * s.tp + s.fp + s.fn);
    perAnchor[key] = round3(f1);
    sum += f1;
    defined++;
  }
  const microDen = 2 * tp + fp + fn;
  return {
    micro: microDen > 0 ? round3((2 * tp) / microDen) : 1,
    macro: defined > 0 ? round3(sum / defined) : 1,
    perAnchor,
    undefinedCount: undef,
  };
}

// ---------------------------------------------------------------------------
// E6 — paired comparison of two runs (McNemar exact)
// ---------------------------------------------------------------------------

export interface PairedResult {
  /** Cases both runs graded without error. */
  paired: number;
  bothRight: number;
  bothWrong: number;
  /** Only run A matched the expected band. */
  aOnly: number;
  /** Only run B matched the expected band. */
  bOnly: number;
  pValue: number;
}

/** Two-sided exact McNemar p-value from the discordant counts. */
export function mcnemarExact(b: number, c: number): number {
  const n = b + c;
  if (n === 0) return 1;
  const k = Math.min(b, c);
  // sum_{i=0..k} C(n,i) / 2^n, computed in log space so n up to a few hundred is safe
  let p = 0;
  for (let i = 0; i <= k; i++) p += Math.exp(logChoose(n, i) - n * Math.LN2);
  return Math.min(1, round4(2 * p));
}

function logChoose(n: number, k: number): number {
  let s = 0;
  for (let i = 1; i <= k; i++) s += Math.log((n - k + i) / i);
  return s;
}

export function pairedBandRuns(
  a: EvalActual[],
  b: EvalActual[],
  expectedMap: Map<string, EvalExpected>,
): PairedResult {
  const bById = new Map(b.map((x) => [x.id, x]));
  const r: PairedResult = { paired: 0, bothRight: 0, bothWrong: 0, aOnly: 0, bOnly: 0, pValue: 1 };
  for (const x of a) {
    const y = bById.get(x.id);
    const exp = expectedMap.get(x.id);
    if (!y || !exp || x.error || y.error) continue;
    r.paired++;
    const xr = x.band === exp.band;
    const yr = y.band === exp.band;
    if (xr && yr) r.bothRight++;
    else if (!xr && !yr) r.bothWrong++;
    else if (xr) r.aOnly++;
    else r.bOnly++;
  }
  r.pValue = mcnemarExact(r.aOnly, r.bOnly);
  return r;
}

// ---------------------------------------------------------------------------
// E7 — tuning set (holdout) and grouping by level and type
// ---------------------------------------------------------------------------

/** Entries are ids or id prefixes, one per line; "#" starts a comment. */
export function parseIdList(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.replace(/#.*/, "").trim())
    .filter(Boolean);
}

/** True when the case id equals an entry or continues it with "-" ("aiq-log-L1-1" covers "aiq-log-L1-1-01", not "aiq-log-L1-10"). */
export function inIdList(caseId: string, entries: string[]): boolean {
  return entries.some((e) => caseId === e || caseId.startsWith(`${e}-`));
}

export function groupOfCase(caseId: string): { type: string; level: string } {
  const m = /^aiq-([a-z]+)-(L\d)-/.exec(caseId);
  return m ? { type: m[1]!, level: m[2]! } : { type: "other", level: "other" };
}

export function agreementByGroup(
  rows: Array<{ id: string; match: boolean }>,
  by: "type" | "level",
): Record<string, { matched: number; total: number; pct: number }> {
  const out: Record<string, { matched: number; total: number; pct: number }> = {};
  for (const r of rows) {
    const k = groupOfCase(r.id)[by];
    const g = (out[k] ??= { matched: 0, total: 0, pct: 0 });
    g.total++;
    if (r.match) g.matched++;
  }
  for (const g of Object.values(out)) g.pct = round2((g.matched / g.total) * 100);
  return out;
}

// ---------------------------------------------------------------------------
// E8 — coverage and bless readiness
// ---------------------------------------------------------------------------

export interface Coverage {
  total: number;
  graded: number;
  errored: number;
  missing: number;
}

export function coverageOf(actuals: EvalActual[], allCaseIds: string[]): Coverage {
  const byId = new Map(actuals.map((a) => [a.id, a]));
  let graded = 0;
  let errored = 0;
  let missing = 0;
  for (const id of allCaseIds) {
    const a = byId.get(id);
    if (!a) missing++;
    else if (a.error) errored++;
    else graded++;
  }
  return { total: allCaseIds.length, graded, errored, missing };
}

/** Bless needs every case graded with zero errors (run 1 showed 82.14% = 23/28: an error hid in the denominator). */
export function blessBlockers(c: Coverage): string[] {
  const out: string[] = [];
  if (c.missing > 0) out.push(`${c.missing} of ${c.total} cases were not run`);
  if (c.errored > 0) out.push(`${c.errored} case(s) errored`);
  return out;
}

// ---------------------------------------------------------------------------
// E5 — models and skill shas
// ---------------------------------------------------------------------------

export type Stage = "anchors" | "band" | "escalate";
const STAGE_ENV: Record<Stage, string> = {
  anchors: "AI_API_MODEL_GRADE_ANCHORS",
  band: "AI_API_MODEL_GRADE_BAND",
  escalate: "AI_API_MODEL_GRADE_ESCALATE",
};

/** The model each stage ran on: the API mode env override wins over the skill frontmatter. */
export function effectiveStageModels(
  frontmatter: Record<Stage, string>,
  env: Record<string, string | undefined>,
  mode: string,
): Record<Stage, string> {
  const pick = (s: Stage): string => (mode === "anthropic-api" && env[STAGE_ENV[s]]) || frontmatter[s];
  return { anchors: pick("anchors"), band: pick("band"), escalate: pick("escalate") };
}

/** The proposal model field is "anchors;band;escalate" ("-" = stage did not run). */
export function parseModelField(model: string): Record<string, string> {
  const keys = ["anchors", "band", "escalate"];
  const out: Record<string, string> = {};
  model.split(";").forEach((m, i) => {
    out[keys[i] ?? `stage${i}`] = m.trim() || "unknown";
  });
  return out;
}

const KNOWN_MODEL = /^claude-(haiku|sonnet|opus)-\d/;

/** Warnings for compare: a baseline with another skill sha than the run, or a model id nobody recognises. */
export function runWarnings(
  run: { skill_shas?: Record<string, string>; stage_models?: Record<string, string> },
  baseline: { skill_shas?: Record<string, string> } | null,
): string[] {
  const w: string[] = [];
  if (run.stage_models === undefined) w.push("run.json has no stage_models (run predates Z-164): the models are not recorded");
  else {
    for (const [stage, m] of Object.entries(run.stage_models)) {
      if (!KNOWN_MODEL.test(m)) w.push(`unknown model id for ${stage}: "${m}"`);
    }
  }
  if (baseline) {
    if (!baseline.skill_shas) w.push("baseline has no skill_shas: it is not comparable");
    else if (run.skill_shas) {
      for (const [stage, sha] of Object.entries(run.skill_shas)) {
        const b = baseline.skill_shas[stage];
        if (b !== undefined && b !== sha) w.push(`baseline ${stage} skill sha ${b} differs from this run (${sha})`);
      }
    }
  }
  return w;
}

// ---------------------------------------------------------------------------
// E9 / E18 — budget default and end-of-run summary
// ---------------------------------------------------------------------------

/** Default USD cap in api mode: 10 for the full run (no --only filter), 1 for any regular test. */
export function defaultBudgetUsd(fullRun: boolean): number {
  return fullRun ? 10 : 1;
}

/** Rupees per US dollar used in reports (a planning rate, not a quote). */
export const INR_PER_USD = 85;
/** Assumed AI-graded answers in one assessment, for the per-assessment figure. */
export const DEFAULT_ANSWERS_PER_ASSESSMENT = 10;

export interface RunSummary {
  cases: number;
  injectionBand4: number;
  escalations: number;
  rupeesPerCase: number | null;
  rupeesPerAssessment: number | null;
}

export function runSummary(
  actuals: EvalActual[],
  expectedMap: Map<string, EvalExpected>,
  costUsd: number | null,
  answersPerAssessment = DEFAULT_ANSWERS_PER_ASSESSMENT,
): RunSummary {
  const injectionBand4 = actuals.filter((a) => !a.error && a.band === 4 && expectedMap.get(a.id)?.adversarial).length;
  const escalations = actuals.filter((a) => !a.error && a.escalation_stage === "3").length;
  const perCase = costUsd !== null && actuals.length > 0 ? (costUsd * INR_PER_USD) / actuals.length : null;
  return {
    cases: actuals.length,
    injectionBand4,
    escalations,
    rupeesPerCase: perCase === null ? null : round2(perCase),
    rupeesPerAssessment: perCase === null ? null : round2(perCase * answersPerAssessment),
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
