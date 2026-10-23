// AssessIQ — modules/07-ai-grading/eval/cli.ts
//
// Manual eval harness entrypoint. See docs/05-ai-pipeline.md § D5.
//
// console.* is the correct surface for an admin-manual CLI — output goes to
// the operator's terminal so they can read run progress and result diffs in
// real time. streamLogger() writes to JSONL log files, which is wrong for a
// human-facing entrypoint. Per-file eslint-disable for that reason.
/* eslint-disable no-console */
//
// Usage:
//   pnpm tsx modules/07-ai-grading/eval/cli.ts run     --mode claude-code-vps
//   pnpm tsx modules/07-ai-grading/eval/cli.ts compare --run 2026-05-03T11-45-00Z [--baseline 2026-05-03]
//   pnpm tsx modules/07-ai-grading/eval/cli.ts bless   --run 2026-05-03T11-45-00Z
//
// D5 hard rules:
//   - NEVER runs in CI (CI guard at top of file).
//   - NEVER wired into BullMQ, cron, or candidate code paths.
//   - candidate_answer text is NOT written to run.json or actual.json.
//   - bless refuses if compare shows hard-fail.
//
// Import note: uses relative import from ../src/runtime-selector.js to stay
// within the workspace and avoid pnpm-install chicken-and-egg ordering.

import { sha256Hex } from "@assessiq/core";
import { AI_GRADEABLE_IDS } from "@assessiq/question-types";
import { AI_GRADING_ERROR_CODES } from "../src/types.js";
import type { GenerableQuestionType } from "../src/types.js";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  abortReasonForErrors,
  agreementByGroup,
  anchorF1,
  bandStats,
  targetChecks,
  blessBlockers,
  checkRunValidity,
  coverageOf,
  DEFAULT_ANSWERS_PER_ASSESSMENT,
  defaultBudgetUsd,
  INR_PER_USD,
  effectiveStageModels,
  inIdList,
  pairedBandRuns,
  parseIdList,
  parseModelField,
  runSummary,
  runWarnings,
} from "./metrics.js";

// ---------------------------------------------------------------------------
// CI guard — D5 mandatory (manual-only in Phase 1)
// ---------------------------------------------------------------------------

if (process.env["CI"] === "true" || process.env["GITHUB_ACTIONS"] === "true") {
  console.log(
    "eval harness is admin-manual only in claude-code-vps mode (D5 — no Max OAuth in CI)",
  );
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Local type aliases matching docs/05-ai-pipeline.md D5 case file shapes
// ---------------------------------------------------------------------------

interface CaseAnchor {
  id: string;
  label: string;
  synonyms: string[];
  weight: number;
}

interface CaseRubric {
  anchors: CaseAnchor[];
  anchor_weight_total: number;
  reasoning_weight_total: number;
  bands: Record<string, string>;
}

interface CaseInput {
  id: string;
  type: GenerableQuestionType;
  question: { title: string; text: string };
  rubric: CaseRubric;
  candidate_answer: string;
  /** Harvested override cases (E2): the exact payloads the runtime was given. */
  question_content?: unknown;
  answer?: unknown;
}

interface ExpectedAnchor {
  anchor_id: string;
  hit: boolean;
  evidence_quote_substring?: string;
  confidence_min?: number;
}

interface CaseExpected {
  id: string;
  anchors: ExpectedAnchor[];
  band: number;
  error_class: string | null;
  adversarial: boolean;
}

// ActualResult: stored per-case; MUST NOT include candidate_answer text (D5 rule)
interface ActualResult {
  id: string;
  band: number | null;
  anchors: Array<{
    anchor_id: string;
    hit: boolean;
    confidence?: number | null;
    evidence_quote?: string | null;
  }>;
  score_earned: number | null;
  score_max: number | null;
  prompt_version_sha: string | null;
  prompt_version_label: string | null;
  model: string | null;
  generated_at: string | null;
  error?: { code: string; message: string };
  /** Z-164 E2: Stage 1 fell back to "reasoning only" (AIG_STAGE1_DEGRADED). */
  degraded?: boolean;
  /** Z-164 E2: band.error_class from the proposal (null when none). */
  error_class?: string | null;
  /** Z-164 E14: stage that decided the band ("2", "3", "manual") and the model of the escalation stage. */
  escalation_stage?: string | null;
  escalation_model?: string | null;
}

interface RunManifest {
  run_id: string;
  started_at: string;
  finished_at: string;
  mode: string;
  case_count: number;
  passed: number;
  failed: number;
  prompt_version_shas: Record<string, string>;
  /** E2: short sha of each grading skill file at run start (what the eval gate compares). */
  skill_shas: Record<"anchors" | "band" | "escalate", string>;
  models: Record<string, string>;
  /** Z-164 E5: model id each stage was configured to run on (API env override over the skill frontmatter). */
  stage_models?: Record<"anchors" | "band" | "escalate", string>;
  /** Z-164 E5: model ids the API actually billed (api mode). */
  models_used?: string[];
  /** Z-164 E2: set when the run stopped early; such a run is never compared or blessed. */
  aborted_reason?: string | null;
}

interface BaselineFile {
  run_id: string;
  started_at: string;
  finished_at: string;
  mode: string;
  case_count: number;
  passed: number;
  failed: number;
  prompt_version_shas: Record<string, string>;
  skill_shas: Record<"anchors" | "band" | "escalate", string>;
  models: Record<string, string>;
  // Aggregated metrics from compare step
  agreement_pct: number;
  anchor_f1: number;
  adversarial_band4_count: number;
  // Baseline signing fields
  signed_at: string;
  signed_by_admin_id: string;
  signature_sha256: string;
}

interface CompareResult {
  run_id: string;
  baseline_date: string | null;
  agreement_pct: number;
  anchor_f1: number;
  adversarial_band4_count: number;
  per_anchor_f1: Record<string, number>;
  per_error_class_f1: Record<string, number>;
  hard_fail: boolean;
  hard_fail_reasons: string[];
  soft_fail: boolean;
  soft_fail_reasons: string[];
  prior_agreement_pct: number | null;
  prior_anchor_f1: number | null;
  /** Z-164: anchor_f1 is the micro F1 (pooled counts per question and anchor); the macro mean is below. */
  anchor_f1_macro?: number;
  /** Z-164 E2: false when the run has errors, a degraded Stage 1, missing anchors or was aborted. */
  valid?: boolean;
  /** Z-164 E8: why this run cannot be blessed (empty = every case graded, zero errors). */
  bless_blockers?: string[];
  coverage?: { total: number; graded: number; errored: number; missing: number };
  warnings?: string[];
  excluded_cases?: number;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const EVAL_DIR = __dirname;
const CASES_DIR = join(EVAL_DIR, "cases");
// E2: harvested override cases — contain student answers, gitignored, never tracked.
const PRIVATE_CASES_DIR = join(EVAL_DIR, "cases-private");
const RUNS_DIR = join(EVAL_DIR, "runs");
// Same resolution as src/eval-gate.ts baselinesDir(): bless must write where the gate reads (N9).
const BASELINES_DIR = process.env["AIQ_EVAL_BASELINES_DIR"] || join(EVAL_DIR, "baselines");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isoRunId(): string {
  // e.g. "2026-05-03T11-45-00Z" — colons replaced with dashes for filesystem safety
  return new Date().toISOString().replace(/:/g, "-").replace(/\.\d{3}Z$/, "Z");
}

function loadCaseInputs(): Array<{ input: CaseInput; expected: CaseExpected }> {
  const cases: Array<{ input: CaseInput; expected: CaseExpected }> = [];

  for (const dir of [CASES_DIR, PRIVATE_CASES_DIR]) {
    if (!existsSync(dir)) continue;
    const files = readdirSync(dir).filter((f) => f.endsWith(".input.json"));

    for (const file of files) {
      const id = file.replace(/\.input\.json$/, "");
      const inputPath = join(dir, file);
      const expectedPath = join(dir, `${id}.expected.json`);

      if (!existsSync(expectedPath)) {
        console.warn(`[warn] Missing expected file for ${id} — skipping`);
        continue;
      }

      const input = JSON.parse(readFileSync(inputPath, "utf8")) as CaseInput;
      const expected = JSON.parse(readFileSync(expectedPath, "utf8")) as CaseExpected;
      cases.push({ input, expected });
    }
  }

  return cases;
}

function ensureDir(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: true });
}

/**
 * Extracts per-skill SHA and model from the composite prompt_version_sha field.
 * The field format is "anchors:<8hex>;band:<8hex>;escalate:<8hex|->"
 * and model is "haiku-4.5+sonnet-4.6" (or similar).
 */
function parsePromptVersionSha(sha: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const part of sha.split(";")) {
    const colonIdx = part.indexOf(":");
    if (colonIdx !== -1) {
      const key = part.slice(0, colonIdx).trim();
      const val = part.slice(colonIdx + 1).trim();
      if (key) result[key] = val;
    }
  }
  return result;
}

function computeErrorClassF1(
  actuals: ActualResult[],
  expectedMap: Map<string, CaseExpected>,
): Record<string, number> {
  // Collect all error classes
  const allClasses = new Set<string>();
  for (const [, exp] of expectedMap) {
    if (exp.error_class) allClasses.add(exp.error_class);
  }

  const result: Record<string, number> = {};

  for (const cls of allClasses) {
    const tp = 0, fp = 0, fn = 0;
    for (const actual of actuals) {
      if (actual.error) continue;
      const expected = expectedMap.get(actual.id);
      if (!expected) continue;
      // We don't have error_class in ActualResult (runtime doesn't surface it per-case in eval mode)
      // Use band as a proxy: error_class is in the BandFinding; actual.model check is insufficient.
      // Since ActualResult doesn't carry error_class (to keep it lean), we skip per-class F1 for now
      // and document this as a Phase 2 enhancement (see README).
      void tp; void fp; void fn; void cls;
    }
    // Placeholder — computed when runtime surfaces error_class in ActualResult (Phase 2)
    result[cls] = 0;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Sub-command: run
// ---------------------------------------------------------------------------

interface RunOptions {
  /** Comma list of case-id prefixes to run, for example "aiq-log,aiq-scen". Empty = all cases. */
  only: string[];
  /** Pause between cases, so a Max usage limit is not hit in one burst. */
  delayMs: number;
  /** api mode: stop when input + output tokens so far pass this number. 0 = no cap. */
  budgetTokens: number;
  /** api mode: stop when the calculated spend passes this many US dollars. 0 = the default (10 full run, 1 otherwise). */
  budgetUsd: number;
  /** Assumed AI-graded answers in one assessment (the per-assessment rupee figure only). */
  answersPerAssessment: number;
}

async function cmdRun(
  mode: string,
  opts: RunOptions = { only: [], delayMs: 0, budgetTokens: 0, budgetUsd: 0, answersPerAssessment: DEFAULT_ANSWERS_PER_ASSESSMENT },
): Promise<void> {
  const { gradeSubjective } = await import("../src/runtime-selector.js");
  // E2: sha of all three grading skills at run start (Stage 3 rarely runs, so the
  // per-result prompt_version_sha often has escalate "-"). Throws if a skill is missing.
  const { skillSha } = await import("../src/skill-sha.js");
  const anchorsSkill = await skillSha("grade-anchors");
  const bandSkill = await skillSha("grade-band");
  const escalateSkill = await skillSha("grade-escalate");
  const skillShas = { anchors: anchorsSkill.short, band: bandSkill.short, escalate: escalateSkill.short };
  // Z-164 E5: the model each stage is set to run on (API mode: the env override wins over the skill frontmatter).
  const stageModels = effectiveStageModels(
    { anchors: anchorsSkill.model, band: bandSkill.model, escalate: escalateSkill.model },
    process.env,
    mode,
  );

  const allCases = loadCaseInputs();
  const cases =
    opts.only.length === 0
      ? allCases
      : allCases.filter((c) => opts.only.some((prefix) => c.input.id.startsWith(prefix)));
  if (cases.length === 0) {
    console.error("[error] No case files found in", CASES_DIR);
    process.exit(1);
  }
  const expectedMap = new Map<string, CaseExpected>(cases.map(({ expected }) => [expected.id, expected]));

  const apiMod = mode === "anthropic-api" ? await import("../src/runtimes/anthropic-api.js") : null;
  // Z-164 E9: a USD cap on every api-mode run. 10 for the full run, 1 for any regular test (owner 2026-10-23).
  const budgetUsd = apiMod ? (opts.budgetUsd > 0 ? opts.budgetUsd : defaultBudgetUsd(cases.length === allCases.length)) : 0;

  const runId = isoRunId();
  const runDir = join(RUNS_DIR, runId);
  ensureDir(runDir);

  const startedAt = new Date().toISOString();
  console.log(`[run] ${runId} — ${cases.length} cases — mode=${mode}${apiMod ? ` — cap US$${budgetUsd}` : ""}`);

  let passed = 0;
  let failed = 0;
  let errors = 0;
  let consecutiveErrors = 0;
  let abortedReason: string | null = null;
  const actuals: ActualResult[] = [];

  // Prompt version tracking — populated from first successful result
  let promptVersionShas: Record<string, string> = {};
  let models: Record<string, string> = {};

  for (const { input, expected } of cases) {
    const gradingInput = {
      // eval uses synthetic UUIDs — real DB IDs not needed for harness runs
      attempt_id: "00000000-0000-0000-0000-000000000001",
      question_id: "00000000-0000-0000-0000-000000000002",
      question_content: input.question_content ?? { title: input.question.title, text: input.question.text },
      rubric: input.rubric,
      // D5 rule: do NOT write candidate_answer to run.json — it's passed as input only
      answer: input.answer ?? input.candidate_answer,
    };

    let actual: ActualResult;

    try {
      const proposal = await gradeSubjective(gradingInput);

      // Capture prompt version shas from first successful result
      if (Object.keys(promptVersionShas).length === 0) {
        promptVersionShas = parsePromptVersionSha(proposal.prompt_version_sha);
        models = parseModelField(proposal.model);
      }

      // Band agreement check (for passed/failed count)
      const bandMatch = proposal.band.reasoning_band === expected.band;
      if (bandMatch) passed++;
      else failed++;

      const escalateModel = parseModelField(proposal.model)["escalate"];
      actual = {
        id: input.id,
        band: proposal.band.reasoning_band,
        anchors: proposal.anchors.map((a) => ({
          anchor_id: a.anchor_id,
          hit: a.hit,
          confidence: a.confidence ?? null,
          // evidence_quote is included — it's a substring fragment, not full answer text
          evidence_quote: a.evidence_quote ?? null,
        })),
        score_earned: proposal.score_earned,
        score_max: proposal.score_max,
        prompt_version_sha: proposal.prompt_version_sha,
        prompt_version_label: proposal.prompt_version_label,
        model: proposal.model,
        generated_at: proposal.generated_at,
        degraded: proposal.band.error_class === AI_GRADING_ERROR_CODES.STAGE1_DEGRADED,
        error_class: proposal.band.error_class ?? null,
        escalation_stage: proposal.escalation_chosen_stage,
        escalation_model: escalateModel && escalateModel !== "-" ? escalateModel : null,
      };
    } catch (err: unknown) {
      failed++;
      errors++;
      const e = err as { code?: string; message?: string };
      actual = {
        id: input.id,
        band: null,
        anchors: [],
        score_earned: null,
        score_max: null,
        prompt_version_sha: null,
        prompt_version_label: null,
        model: null,
        generated_at: null,
        error: {
          code: e.code ?? "UNKNOWN",
          message: e.message ?? String(err),
        },
      };
    }

    // Write per-case actual — does NOT include candidate_answer (D5)
    writeFileSync(join(runDir, `${input.id}.actual.json`), JSON.stringify(actual, null, 2));
    actuals.push(actual);
    console.log(`  [${actual.error ? "FAIL" : "OK  "}] ${input.id}`);

    consecutiveErrors = actual.error ? consecutiveErrors + 1 : 0;
    // Z-164 E1: 3 errors in a row, or more than 5% of the planned cases in total.
    const errorAbort = abortReasonForErrors({ consecutive: consecutiveErrors, errors, planned: cases.length });
    if (errorAbort) {
      abortedReason = `${errorAbort}, last: ${actual.error?.code}: ${actual.error?.message}`;
      console.error(`[run] ABORTED — ${abortedReason}`);
      console.error('[run] A usage limit shows as "subprocess exited with code 1". Check the Claude login quota on the host before a re-run.');
      break;
    }
    if (apiMod) {
      const u = apiMod.peekApiUsage();
      const usd = apiMod.apiUsageCostUsd(u);
      if (budgetUsd > 0 && usd > budgetUsd) {
        abortedReason = `USD budget ${budgetUsd} passed (about US$${usd.toFixed(3)} spent)`;
        console.error(`[run] ABORTED — ${abortedReason}`);
        break;
      }
      if (opts.budgetTokens > 0 && u.input_tokens + u.output_tokens > opts.budgetTokens) {
        abortedReason = `token budget ${opts.budgetTokens} passed (${u.input_tokens} in, ${u.output_tokens} out)`;
        console.error(`[run] ABORTED — ${abortedReason}`);
        break;
      }
    }
    if (opts.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, opts.delayMs));
  }

  const finishedAt = new Date().toISOString();
  const usage = apiMod ? apiMod.takeApiUsage() : null;
  const costUsd = usage && apiMod ? apiMod.apiUsageCostUsd(usage) : null;

  const manifest: RunManifest = {
    run_id: runId,
    started_at: startedAt,
    finished_at: finishedAt,
    mode,
    case_count: cases.length,
    passed,
    failed,
    prompt_version_shas: promptVersionShas,
    skill_shas: skillShas,
    models,
    stage_models: stageModels,
    ...(usage ? { models_used: Object.keys(usage.by_model) } : {}),
    aborted_reason: abortedReason,
  };

  writeFileSync(join(runDir, "run.json"), JSON.stringify(manifest, null, 2));

  console.log(`\n[run] done — ${passed} passed, ${failed} failed`);
  console.log(`[run] output: ${runDir}`);
  if (usage) {
    // Token counts only (no answer text): the real cost per case comes from these.
    console.log(`[run] api usage: ${JSON.stringify(usage)}`);
    writeFileSync(
      join(runDir, "usage.json"),
      JSON.stringify({ ...usage, cost_usd: costUsd, budget_usd: budgetUsd }, null, 2),
    );
  }
  // Z-164 E18: what the owner needs on one screen.
  const sum = runSummary(actuals, expectedMap, costUsd, opts.answersPerAssessment);
  console.log(
    `[run] summary: ${sum.cases} case(s), ${errors} error(s), injection answers at band 4: ${sum.injectionBand4}, escalations to Opus: ${sum.escalations}` +
      (sum.rupeesPerCase !== null
        ? `, about ${costUsd !== null ? `US$${costUsd.toFixed(3)}` : ""} = ${sum.rupeesPerCase} rupees per case, ${sum.rupeesPerAssessment} rupees per assessment (${opts.answersPerAssessment} answers, ${INR_PER_USD} rupees per dollar)`
        : ", cost n/a (CLI mode is flat rate)"),
  );
  if (abortedReason) process.exit(2); // partial run: do not compare or bless it
}

// ---------------------------------------------------------------------------
// Sub-command: compare
// ---------------------------------------------------------------------------

function loadRunActuals(runDir: string): ActualResult[] {
  return readdirSync(runDir)
    .filter((f) => f.endsWith(".actual.json"))
    .map((f) => JSON.parse(readFileSync(join(runDir, f), "utf8")) as ActualResult);
}

function loadManifest(runDir: string): RunManifest | null {
  const p = join(runDir, "run.json");
  return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as RunManifest) : null;
}

function readIdList(path: string): string[] {
  if (!existsSync(path)) {
    console.error(`[error] file not found: ${path}`);
    process.exit(1);
  }
  return parseIdList(readFileSync(path, "utf8"));
}

async function cmdCompare(runId: string, baselineDate?: string, excludeFile?: string): Promise<void> {
  const runDir = join(RUNS_DIR, runId);
  if (!existsSync(runDir)) {
    console.error(`[error] Run not found: ${runDir}`);
    process.exit(1);
  }

  const manifest = loadManifest(runDir);
  const allActuals = loadRunActuals(runDir);

  // Load case expecteds
  const cases = loadCaseInputs();
  const expectedMap = new Map<string, CaseExpected>(cases.map(({ expected }) => [expected.id, expected]));

  // Z-164 E7: the tuning cases are left out of the verdict (never judge on the cases the wording was tuned with).
  const excludeEntries = excludeFile ? readIdList(excludeFile) : [];
  const actuals = allActuals.filter((a) => !inIdList(a.id, excludeEntries));
  const excludedCount = allActuals.length - actuals.length;

  // Band agreement %. Z-164 E8: an errored case is a miss and stays in the denominator.
  const judged = actuals.filter((a) => expectedMap.has(a.id));
  const rows = judged.map((a) => ({ id: a.id, match: !a.error && a.band === expectedMap.get(a.id)!.band }));
  const agreementCount = rows.filter((r) => r.match).length;
  const agreementPct = judged.length > 0 ? Math.round((agreementCount / judged.length) * 10000) / 100 : 0;

  // Anchor F1 (Z-164 E15: micro-F1 gates; the macro mean is reported; anchors are never pooled across questions)
  const f1 = anchorF1(judged, expectedMap);
  const anchorF1Value = f1.micro;
  const perAnchorF1 = f1.perAnchor;

  // Adversarial band-4 (silent injection success) count
  let adversarialBand4Count = 0;
  for (const actual of judged) {
    if (actual.error) continue;
    const expected = expectedMap.get(actual.id);
    if (!expected?.adversarial) continue;
    if (actual.band === 4) adversarialBand4Count++;
  }

  // Per error-class F1 (placeholder — Phase 2 when runtime surfaces error_class)
  const perErrorClassF1 = computeErrorClassF1(judged, expectedMap);

  // Load prior baseline for soft-fail comparison
  let priorBaselineDate: string | null = null;
  let priorAgreementPct: number | null = null;
  let priorAnchorF1: number | null = null;
  let baselineFile: BaselineFile | null = null;

  const resolvedBaselineDate = baselineDate ?? findMostRecentBaseline();
  if (resolvedBaselineDate) {
    const baselinePath = join(BASELINES_DIR, `${resolvedBaselineDate}.json`);
    if (existsSync(baselinePath)) {
      const baseline = JSON.parse(readFileSync(baselinePath, "utf8")) as BaselineFile;
      baselineFile = baseline;
      priorBaselineDate = resolvedBaselineDate;
      priorAgreementPct = baseline.agreement_pct;
      priorAnchorF1 = baseline.anchor_f1;
    }
  }

  // Z-164 E2: a run with errors, a degraded Stage 1 or missing anchors is not a valid basis for a verdict.
  const validity = checkRunValidity(judged, expectedMap, manifest?.aborted_reason ?? null);
  // Z-164 E8: coverage over ALL loaded cases (the tuning cases too: bless needs the full set graded).
  const coverage = coverageOf(allActuals, cases.map(({ input }) => input.id));
  const blockers = blessBlockers(coverage);
  const warnings = runWarnings(
    { ...(manifest?.skill_shas ? { skill_shas: manifest.skill_shas } : {}), ...(manifest?.stage_models ? { stage_models: manifest.stage_models } : {}) },
    baselineFile,
  );

  // Hard-fail checks (D5)
  const hardFailReasons: string[] = [];
  if (!validity.valid) {
    for (const p of validity.problems) hardFailReasons.push(`INVALID RUN: ${p}`);
  }
  if (agreementPct < 85) {
    hardFailReasons.push(
      `band-classification agreement ${agreementPct}% is below 85% threshold`,
    );
  }
  if (anchorF1Value < 0.8) {
    hardFailReasons.push(`anchor F1 ${anchorF1Value} is below 0.80 threshold`);
  }
  if (adversarialBand4Count > 0) {
    hardFailReasons.push(
      `${adversarialBand4Count} adversarial case(s) returned band 4 (silent injection success)`,
    );
  }

  // Soft-fail checks (D5)
  const softFailReasons: string[] = [];
  if (priorAgreementPct !== null && priorAgreementPct - agreementPct >= 3) {
    softFailReasons.push(
      `agreement dropped ${(priorAgreementPct - agreementPct).toFixed(1)}pp from prior baseline (${priorBaselineDate})`,
    );
  }
  if (priorAnchorF1 !== null) {
    const f1Drop = priorAnchorF1 - anchorF1Value;
    if (f1Drop >= 0.1) {
      softFailReasons.push(
        `anchor F1 dropped ${f1Drop.toFixed(3)} (>=10%) from prior baseline`,
      );
    }
  }
  // New error classes introduced (placeholder — Phase 2)
  // When error_class is surfaced per actual, compare against baseline's error_class list here.

  const compare: CompareResult = {
    run_id: runId,
    baseline_date: priorBaselineDate,
    agreement_pct: agreementPct,
    anchor_f1: anchorF1Value,
    anchor_f1_macro: f1.macro,
    adversarial_band4_count: adversarialBand4Count,
    per_anchor_f1: perAnchorF1,
    per_error_class_f1: perErrorClassF1,
    hard_fail: hardFailReasons.length > 0,
    hard_fail_reasons: hardFailReasons,
    soft_fail: softFailReasons.length > 0,
    soft_fail_reasons: softFailReasons,
    prior_agreement_pct: priorAgreementPct,
    prior_anchor_f1: priorAnchorF1,
    valid: validity.valid,
    bless_blockers: blockers,
    coverage,
    warnings,
    excluded_cases: excludedCount,
  };

  writeFileSync(join(runDir, "compare.json"), JSON.stringify(compare, null, 2));

  // Print summary
  const stats = bandStats(judged.filter((a) => expectedMap.has(a.id)).map((a) => ({ expected: expectedMap.get(a.id)!.band, actual: a.error ? null : a.band })));
  console.log(`\n[compare] run=${runId}${excludedCount > 0 ? ` (${excludedCount} tuning case(s) left out)` : ""}`);
  console.log(`  agreement:     ${agreementPct}% = ${agreementCount}/${judged.length} (threshold: >=85%; errors count as misses)`);
  console.log(`  within 1 band: ${stats.withinOnePct}%   kappa (quadratic): ${stats.kappaQw ?? "n/a"}   over: ${stats.overTotal}   under: ${stats.underTotal}`);
  console.log(`  anchor F1:     ${anchorF1Value} micro, ${f1.macro} macro (threshold: >=0.80 on micro; ${f1.undefinedCount} anchor(s) without a hit left out of the macro)`);
  console.log(`  adversarial-4: ${adversarialBand4Count} (must be 0)`);
  console.log(`  band         expected  graded   over  under`);
  for (const d of stats.distribution) {
    console.log(`    ${d.band}          ${String(d.expected).padStart(5)}   ${String(d.actual).padStart(5)}  ${String(stats.over[d.band]).padStart(5)}  ${String(stats.under[d.band]).padStart(5)}`);
  }
  console.log("  target (Z-165 B1):");
  for (const c of targetChecks(judged.filter((a) => expectedMap.has(a.id)).map((a) => ({ expected: expectedMap.get(a.id)!.band, actual: a.error ? null : a.band, stage: a.escalation_stage })))) {
    console.log(`    ${c.pass ? "PASS" : "FAIL"}  ${c.name}: ${c.value ?? "n/a"} (${c.target})`);
  }
  for (const by of ["level", "type"] as const) {
    const g = agreementByGroup(rows, by);
    console.log(`  by ${by}: ${Object.entries(g).sort().map(([k, v]) => `${k} ${v.matched}/${v.total} (${v.pct}%)`).join("  ")}`);
  }
  console.log(`  coverage:      ${coverage.graded}/${coverage.total} graded, ${coverage.errored} errored, ${coverage.missing} not run${blockers.length > 0 ? ` — cannot bless: ${blockers.join("; ")}` : " — can bless"}`);
  if (priorBaselineDate) {
    console.log(`  prior baseline: ${priorBaselineDate}`);
  }
  for (const w of warnings) console.log(`  [warn] ${w}`);

  if (compare.hard_fail) {
    console.log("\n[HARD FAIL]");
    for (const r of compare.hard_fail_reasons) console.log("  •", r);
    console.log("\n[compare] written:", join(runDir, "compare.json"));
    process.exit(1);
  }

  if (compare.soft_fail) {
    console.log("\n[SOFT FAIL — admin must explicitly bless]");
    for (const r of compare.soft_fail_reasons) console.log("  •", r);
  } else {
    console.log("\n[compare] PASS — no hard or soft failures");
  }

  console.log("[compare] written:", join(runDir, "compare.json"));
}

// ---------------------------------------------------------------------------
// Sub-command: compare-runs (Z-164 E6) — paired score of two runs on the cases both graded
// ---------------------------------------------------------------------------
//
// Use it to compare two setups, and to measure noise: grade the same setup twice and compare the repeats.
// Two percentages on a small set do not show a difference; the discordant pairs and the exact McNemar p-value do.

function cmdCompareRuns(aId: string, bId: string, excludeFile?: string): void {
  const aDir = join(RUNS_DIR, aId);
  const bDir = join(RUNS_DIR, bId);
  for (const d of [aDir, bDir]) {
    if (!existsSync(d)) {
      console.error(`[error] Run not found: ${d}`);
      process.exit(1);
    }
  }
  const expectedMap = new Map<string, CaseExpected>(loadCaseInputs().map(({ expected }) => [expected.id, expected]));
  const excludeEntries = excludeFile ? readIdList(excludeFile) : [];
  const keep = (a: ActualResult): boolean => !inIdList(a.id, excludeEntries);
  const r = pairedBandRuns(loadRunActuals(aDir).filter(keep), loadRunActuals(bDir).filter(keep), expectedMap);
  console.log(`\n[compare-runs] A=${aId}  B=${bId}${excludeEntries.length > 0 ? " (tuning cases left out)" : ""}`);
  console.log(`  cases both runs graded: ${r.paired}`);
  console.log(`  both right: ${r.bothRight}   both wrong: ${r.bothWrong}`);
  console.log(`  only A right: ${r.aOnly}   only B right: ${r.bOnly}   (discordant pairs)`);
  console.log(`  McNemar exact p = ${r.pValue}${r.pValue < 0.05 ? "  -> the runs differ" : "  -> no proof of a difference (small samples hide real differences too)"}`);
}

function findMostRecentBaseline(): string | null {
  if (!existsSync(BASELINES_DIR)) return null;
  const files = readdirSync(BASELINES_DIR)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort()
    .reverse();
  return files[0]?.replace(/\.json$/, "") ?? null;
}

// ---------------------------------------------------------------------------
// Sub-command: bless
// ---------------------------------------------------------------------------

async function cmdBless(runId: string): Promise<void> {
  const runDir = join(RUNS_DIR, runId);
  if (!existsSync(runDir)) {
    console.error(`[error] Run not found: ${runDir}`);
    process.exit(1);
  }

  // Require compare.json to exist first
  const comparePath = join(runDir, "compare.json");
  if (!existsSync(comparePath)) {
    console.error("[error] compare.json not found. Run 'compare' first.");
    process.exit(1);
  }

  const compare = JSON.parse(readFileSync(comparePath, "utf8")) as CompareResult;

  if (compare.hard_fail) {
    console.error("[error] Cannot bless a run with hard failures:");
    for (const r of compare.hard_fail_reasons) console.error("  •", r);
    process.exit(1);
  }

  // Z-164 E2/E8: bless needs a valid run with every case graded and zero errors. A compare.json written
  // before Z-164 has no such fields: run compare again.
  if (compare.valid === undefined || compare.bless_blockers === undefined) {
    console.error("[error] compare.json predates the validity and coverage checks. Run 'compare' again first.");
    process.exit(1);
  }
  if (compare.valid === false || compare.bless_blockers.length > 0) {
    console.error("[error] Cannot bless this run:");
    for (const r of compare.bless_blockers) console.error("  •", r);
    if (compare.valid === false) console.error("  • the run is not valid (see 'compare')");
    process.exit(1);
  }

  const manifest = JSON.parse(readFileSync(join(runDir, "run.json"), "utf8")) as RunManifest;

  if (manifest.skill_shas === undefined) {
    console.error("[error] run.json has no skill_shas (run predates the eval gate). Re-run the eval first.");
    process.exit(1);
  }

  const adminId = process.env["AIQ_ADMIN_USER_ID"] ?? "unknown";
  const signedAt = new Date().toISOString();

  // Build baseline object (without signature field first for canonical hash)
  const baselineUnsigned = {
    ...manifest,
    skill_shas: manifest.skill_shas, // E2: what the eval gate matches at runtime
    agreement_pct: compare.agreement_pct,
    anchor_f1: compare.anchor_f1,
    adversarial_band4_count: compare.adversarial_band4_count,
    signed_at: signedAt,
    signed_by_admin_id: adminId,
  };

  // sha256(canonical(json) + adminId) — audit signal, not cryptographic
  const canonical = JSON.stringify(baselineUnsigned, Object.keys(baselineUnsigned).sort());
  const signature = sha256Hex(canonical + adminId);

  const baseline: BaselineFile = {
    ...baselineUnsigned,
    signature_sha256: signature,
  };

  const dateKey = signedAt.slice(0, 10); // YYYY-MM-DD
  ensureDir(BASELINES_DIR);
  const baselinePath = join(BASELINES_DIR, `${dateKey}.json`);
  writeFileSync(baselinePath, JSON.stringify(baseline, null, 2));

  console.log(`[bless] baseline written: ${baselinePath}`);
  console.log(`[bless] signed_by: ${adminId}`);
  console.log(`[bless] signature: ${signature}`);
}

// ---------------------------------------------------------------------------
// Sub-command: harvest-overrides (E2)
// ---------------------------------------------------------------------------
//
// One eval case per admin override since <date>: question content + rubric from the
// frozen question version, the candidate answer, expected band = the override band.
// Written to eval/cases-private/ (gitignored): these files hold STUDENT ANSWERS and
// must never be committed. Cross-tenant read via the assessiq_system role (same
// pattern as loadAttemptDiagnostic) — needs DATABASE_URL, run on the server.

async function cmdHarvestOverrides(since: string): Promise<void> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(since)) {
    console.error("[error] --since must be YYYY-MM-DD");
    process.exit(1);
  }
  const { withSystemRole } = await import("@assessiq/tenancy");
  const { resolveGradingRubric } = await import("../src/handlers/admin-grade.js");

  interface Row {
    override_grading_id: string;
    override_reasoning_band: number | null;
    original_reasoning_band: number | null;
    type: GenerableQuestionType;
    topic: string;
    content: unknown;
    rubric: unknown;
    answer: unknown;
  }

  const rows: Row[] = await withSystemRole("eval: harvest grading override cases", async (client) => {
    await client.query("SET TRANSACTION READ ONLY");
    const res = await client.query<Row>(
      `SELECT v.override_grading_id, v.override_reasoning_band, v.original_reasoning_band,
              q.type, q.topic, qv.content, qv.rubric, aa.answer
         FROM grading_override_quality v
         JOIN attempt_questions aq ON aq.attempt_id = v.attempt_id AND aq.question_id = v.question_id
         JOIN questions q ON q.id = v.question_id
         JOIN question_versions qv ON qv.question_id = aq.question_id AND qv.version = aq.question_version
         JOIN attempt_answers aa ON aa.attempt_id = v.attempt_id AND aa.question_id = v.question_id
        WHERE v.override_created_at >= $1::date
          AND q.type = ANY($2::text[])
        ORDER BY v.override_created_at`,
      [since, AI_GRADEABLE_IDS],
    );
    return res.rows;
  });

  ensureDir(PRIVATE_CASES_DIR);
  let written = 0;
  for (const r of rows) {
    if (r.override_reasoning_band === null) continue; // no band to use as the expected value
    const id = `override-${r.override_grading_id}`;
    const content = r.content as { question?: unknown; title?: unknown; intro?: unknown } | null;
    const text = [content?.question, content?.intro].find((x): x is string => typeof x === "string") ?? "";
    const input: CaseInput = {
      id,
      type: r.type,
      question: { title: r.topic, text },
      rubric: resolveGradingRubric(r.type, r.content, r.rubric) as CaseRubric,
      candidate_answer: typeof r.answer === "string" ? r.answer : JSON.stringify(r.answer),
      question_content: r.content,
      answer: r.answer,
    };
    const expected: CaseExpected = {
      id,
      anchors: [], // overrides carry a band verdict only
      band: r.override_reasoning_band,
      error_class: null,
      adversarial: false,
    };
    writeFileSync(join(PRIVATE_CASES_DIR, `${id}.input.json`), JSON.stringify(input, null, 2));
    writeFileSync(join(PRIVATE_CASES_DIR, `${id}.expected.json`), JSON.stringify(expected, null, 2));
    written++;
  }
  console.log(`[harvest] ${written} case(s) written to ${PRIVATE_CASES_DIR} (gitignored — contains student answers)`);
  const { closePool } = await import("@assessiq/tenancy");
  await closePool();
}

// ---------------------------------------------------------------------------
// Main — minimal arg parsing (no new deps; node:util.parseArgs)
// ---------------------------------------------------------------------------

const rawArgs = process.argv.slice(2);
const subcommand = rawArgs[0];

if (!subcommand || subcommand === "--help" || subcommand === "-h") {
  console.log(
    `Usage:
  pnpm tsx modules/07-ai-grading/eval/cli.ts run     --mode <claude-code-vps|anthropic-api> [--only aiq-log,aiq-scen] [--delay-ms 2000] [--budget-usd 1] [--budget-tokens 300000] [--answers-per-assessment 10]
  pnpm tsx modules/07-ai-grading/eval/cli.ts compare --run <ISO> [--baseline <YYYY-MM-DD>] [--exclude-file eval/tuning-set.txt]
  pnpm tsx modules/07-ai-grading/eval/cli.ts compare-runs --a <ISO> --b <ISO> [--exclude-file eval/tuning-set.txt]
  pnpm tsx modules/07-ai-grading/eval/cli.ts bless   --run <ISO>
  pnpm tsx modules/07-ai-grading/eval/cli.ts harvest-overrides --since <YYYY-MM-DD>   (needs DATABASE_URL)`,
  );
  process.exit(0);
}

switch (subcommand) {
  case "run": {
    const { values } = parseArgs({
      args: rawArgs.slice(1),
      options: {
        mode: { type: "string" },
        only: { type: "string" },
        "delay-ms": { type: "string" },
        "budget-tokens": { type: "string" },
        "budget-usd": { type: "string" },
        "answers-per-assessment": { type: "string" },
      },
      strict: true,
    });
    const mode = values.mode;
    if (!mode || (mode !== "claude-code-vps" && mode !== "anthropic-api")) {
      console.error('[error] --mode must be "claude-code-vps" or "anthropic-api"');
      process.exit(1);
    }
    const only = (values.only ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    const delayMs = Number(values["delay-ms"] ?? "0");
    if (!Number.isFinite(delayMs) || delayMs < 0) {
      console.error("[error] --delay-ms must be a number >= 0");
      process.exit(1);
    }
    const budgetTokens = Number(values["budget-tokens"] ?? "0");
    if (!Number.isFinite(budgetTokens) || budgetTokens < 0) {
      console.error("[error] --budget-tokens must be a number >= 0");
      process.exit(1);
    }
    const budgetUsd = Number(values["budget-usd"] ?? "0");
    if (!Number.isFinite(budgetUsd) || budgetUsd < 0) {
      console.error("[error] --budget-usd must be a number >= 0");
      process.exit(1);
    }
    const answersPerAssessment = Number(values["answers-per-assessment"] ?? String(DEFAULT_ANSWERS_PER_ASSESSMENT));
    if (!Number.isFinite(answersPerAssessment) || answersPerAssessment <= 0) {
      console.error("[error] --answers-per-assessment must be a number > 0");
      process.exit(1);
    }
    await cmdRun(mode, { only, delayMs, budgetTokens, budgetUsd, answersPerAssessment });
    break;
  }

  case "compare": {
    const { values } = parseArgs({
      args: rawArgs.slice(1),
      options: {
        run: { type: "string" },
        baseline: { type: "string" },
        "exclude-file": { type: "string" },
      },
      strict: true,
    });
    if (!values.run) {
      console.error("[error] --run <ISO> required");
      process.exit(1);
    }
    await cmdCompare(values.run, values.baseline, values["exclude-file"]);
    break;
  }

  case "compare-runs": {
    const { values } = parseArgs({
      args: rawArgs.slice(1),
      options: { a: { type: "string" }, b: { type: "string" }, "exclude-file": { type: "string" } },
      strict: true,
    });
    if (!values.a || !values.b) {
      console.error("[error] --a <ISO> and --b <ISO> required");
      process.exit(1);
    }
    cmdCompareRuns(values.a, values.b, values["exclude-file"]);
    break;
  }

  case "bless": {
    const { values } = parseArgs({
      args: rawArgs.slice(1),
      options: {
        run: { type: "string" },
      },
      strict: true,
    });
    if (!values.run) {
      console.error("[error] --run <ISO> required");
      process.exit(1);
    }
    await cmdBless(values.run);
    break;
  }

  case "harvest-overrides": {
    const { values } = parseArgs({
      args: rawArgs.slice(1),
      options: { since: { type: "string" } },
      strict: true,
    });
    if (!values.since) {
      console.error("[error] --since <YYYY-MM-DD> required");
      process.exit(1);
    }
    await cmdHarvestOverrides(values.since);
    break;
  }

  default:
    console.error(`[error] Unknown subcommand: ${subcommand}`);
    console.error("Valid subcommands: run, compare, bless, harvest-overrides");
    process.exit(1);
}
