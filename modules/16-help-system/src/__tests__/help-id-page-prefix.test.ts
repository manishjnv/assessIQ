// N20 / RV71 guard: an element help id must start with its page's helpPage id,
// otherwise the page-scoped loader (key LIKE '<page>.%') never returns its text.
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(__dirname, "../../../..");
const DIRS = ["modules/10-admin-dashboard/src/pages", "apps/web/src/pages"];

// Real exceptions: { file (basename), id, reason }.
const ALLOWLIST: { file: string; id: string; reason: string }[] = [
  { file: "assessment-detail.tsx", id: "admin.assessment.results_csv.sort", reason: "N20 follow-up" },
  { file: "assessments.tsx", id: "admin.assessment.integrity.fullscreen", reason: "N20 follow-up" },
  { file: "assessments.tsx", id: "admin.assessment.integrity.block_copy_paste", reason: "N20 follow-up" },
  { file: "assessments.tsx", id: "admin.assessment.high_stakes", reason: "N20 follow-up" },
  { file: "attempt-detail.tsx", id: "admin.attempts.print_review", reason: "N20 follow-up" },
  { file: "attempt-detail.tsx", id: "admin.attempts.send_back", reason: "N20 follow-up" },
  { file: "attempt-detail.tsx", id: "admin.attempts.release_button", reason: "N20 follow-up" },
  { file: "attempt-detail.tsx", id: "admin.attempts.awaiting_evaluation", reason: "N20 follow-up" },
  { file: "attempt-detail.tsx", id: "admin.attempts.section_scores", reason: "N20 follow-up" },
  { file: "billing.tsx", id: "admin.settings.ai_generate_mode", reason: "N20 follow-up" },
  { file: "cohort-report.tsx", id: "admin.analytics.cohort_report", reason: "N20 follow-up" },
  { file: "cohort-report.tsx", id: "admin.scoring.cohort.percentiles", reason: "N20 follow-up" },
  { file: "evaluation-detail.tsx", id: "admin.assessment.high_stakes.edit", reason: "N20 follow-up" },
  { file: "evaluation-detail.tsx", id: "admin.attempts.print_review", reason: "N20 follow-up" },
  { file: "evaluation-detail.tsx", id: "admin.evaluations.release_to_company", reason: "N20 follow-up" },
  { file: "evaluation-detail.tsx", id: "admin.evaluations.sent_back", reason: "N20 follow-up" },
  { file: "evaluations-queue.tsx", id: "admin.evaluations.age_badge", reason: "N20 follow-up" },
  { file: "evaluations-queue.tsx", id: "admin.evaluations.sent_back", reason: "N20 follow-up" },
  { file: "evaluations-queue.tsx", id: "admin.evaluations.eval_gate", reason: "N20 follow-up" },
  { file: "evaluations-queue.tsx", id: "admin.evaluations.grading_quality", reason: "N20 follow-up" },
  { file: "evaluations-queue.tsx", id: "admin.evaluations.tenant_filter", reason: "N20 follow-up" },
  { file: "evaluations-queue.tsx", id: "admin.evaluations.release_selected", reason: "N20 follow-up" },
  { file: "evaluations-queue.tsx", id: "admin.evaluations.evaluate_next", reason: "N20 follow-up" },
  { file: "evaluations-queue.tsx", id: "admin.evaluations.queue", reason: "N20 follow-up" },
  { file: "generation-attempts.tsx", id: "admin.generation_attempts.history", reason: "N20 follow-up" },
  { file: "individual-report.tsx", id: "admin.scoring.attempt.archetype", reason: "N20 follow-up" },
  { file: "pack-detail.tsx", id: "admin.questions.attempt_status", reason: "N20 follow-up" },
  { file: "question-bank.tsx", id: "admin.packs.create.domain", reason: "N20 follow-up" },
  { file: "users.tsx", id: "admin.users.role", reason: "N20 follow-up" },
  { file: "users.tsx", id: "admin.users.candidate.fields", reason: "N20 follow-up" },
  { file: "users.tsx", id: "admin.user.data_export", reason: "N20 follow-up" },
  { file: "users.tsx", id: "admin.user.erase", reason: "N20 follow-up" },
];

function tsxFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? tsxFiles(join(dir, e.name)) : e.name.endsWith(".tsx") ? [join(dir, e.name)] : [],
  );
}

describe("help ids sit under their page prefix", () => {
  it("has no id outside its helpPage prefix", () => {
    const bad: string[] = [];
    for (const d of DIRS) {
      for (const f of tsxFiles(join(ROOT, d))) {
        const src = readFileSync(f, "utf8");
        const pages = new Set([...src.matchAll(/helpPage="([^"]+)"/g)].map((m) => m[1]));
        if (pages.size !== 1) continue;
        const [page] = [...pages];
        const ids = [...src.matchAll(/(?:data-help-id|helpId)(?:=\{?|["']?\s*:\s*)[`"']([^"'`$]*)/g)].map((m) => m[1]!);
        for (const id of ids) {
          if (id.startsWith(`${page}.`)) continue;
          if (ALLOWLIST.some((a) => f.endsWith(a.file) && a.id === id)) continue;
          bad.push(`${f.slice(ROOT.length + 1)}: ${id} (page ${page})`);
        }
      }
    }
    expect(bad).toEqual([]);
  });
});
