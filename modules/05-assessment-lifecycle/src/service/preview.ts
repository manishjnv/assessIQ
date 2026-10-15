import { NotFoundError } from "@assessiq/core";
import { withTenant } from "@assessiq/tenancy";
import * as repo from "../repository.js";
import { AL_ERROR_CODES } from "../types.js";
import type { ResolvedBlueprint, PreviewCriterionResult, PreviewQuestionSet } from "../types.js";
import { countActiveQuestionsForLevel, listActiveQuestionsForPreview } from "./_shared.js";
import { countActiveQuestionsForCriterion, listActiveQuestionsForCriterion } from "./blueprint.js";

// ---------------------------------------------------------------------------
// previewAssessment — admin sample of question pool; no attempt created
// ---------------------------------------------------------------------------

export async function previewAssessment(
  tenantId: string,
  id: string,
): Promise<PreviewQuestionSet> {
  return withTenant(tenantId, async (client) => {
    // a. Read assessment
    const assessment = await repo.findAssessmentById(client, id);
    if (assessment === null) {
      throw new NotFoundError(`Assessment not found: ${id}`, {
        details: { code: AL_ERROR_CODES.ASSESSMENT_NOT_FOUND },
      });
    }

    const blueprint = (assessment.settings as Record<string, unknown>)?.["blueprint"] as
      | ResolvedBlueprint
      | undefined;

    // RV63: once frozen (publish/reopen), candidates draw from assessment_frozen_pool,
    // so preview must too. Draft or pre-0096 (no rows) keeps the live path.
    const useFrozen =
      assessment.status !== "draft" &&
      (await repo.countFrozenPoolRows(client, assessment.id)) > 0;

    if (blueprint !== undefined) {
      // C4 — blueprint-aware preview: per-criterion adequacy + sample
      let totalPoolSize = 0;
      const blueprintCriteria: PreviewCriterionResult[] = [];

      for (let idx = 0; idx < blueprint.criteria.length; idx++) {
        const criterion = blueprint.criteria[idx]!;
        const criterionAvailable = useFrozen
          ? await repo.countFrozenForCriterion(
              client,
              assessment.id,
              blueprint.domain_id,
              criterion.category_id,
              criterion.type,
            )
          : await countActiveQuestionsForCriterion(
              client,
              assessment.pack_id,
              assessment.level_id,
              blueprint.domain_id,
              criterion.category_id,
              criterion.type,
            );
        totalPoolSize += criterionAvailable;

        const sampleLimit = Math.min(criterionAvailable, criterion.count);
        const sample = sampleLimit > 0 && useFrozen
          ? await repo.listFrozenForCriterionPreview(
              client,
              assessment.id,
              blueprint.domain_id,
              criterion.category_id,
              criterion.type,
              sampleLimit,
            )
          : sampleLimit > 0
          ? await listActiveQuestionsForCriterion(
              client,
              assessment.pack_id,
              assessment.level_id,
              blueprint.domain_id,
              criterion.category_id,
              criterion.type,
              sampleLimit,
            )
          : [];

        blueprintCriteria.push({
          criterion_index: idx,
          category_id: criterion.category_id,
          type: criterion.type,
          required: criterion.count,
          available: criterionAvailable,
          sample,
        });
      }

      return {
        assessment_id: assessment.id,
        pack_id: assessment.pack_id,
        pack_version: assessment.pack_version,
        level_id: assessment.level_id,
        pool_size: totalPoolSize,
        question_count: assessment.question_count,
        questions: [],   // no flat sample in blueprint mode — use blueprint_criteria
        blueprint_criteria: blueprintCriteria,
        frozen: useFrozen,
      };
    }

    // No-blueprint path — live behaviour unchanged unless the pool is frozen
    // b. Count questions in the pool
    const poolSize = useFrozen
      ? await repo.countFrozenPoolRows(client, assessment.id)
      : await countActiveQuestionsForLevel(
          client,
          assessment.pack_id,
          assessment.level_id,
        );

    // c. Pull up to min(pool_size, question_count) questions for the preview
    const previewLimit = Math.min(poolSize, assessment.question_count);
    const questions = previewLimit > 0 && useFrozen
      ? await repo.listFrozenForPreview(client, assessment.id, previewLimit)
      : previewLimit > 0
      ? await listActiveQuestionsForPreview(
          client,
          assessment.pack_id,
          assessment.level_id,
          previewLimit,
        )
      : [];

    return {
      assessment_id: assessment.id,
      pack_id: assessment.pack_id,
      pack_version: assessment.pack_version,
      level_id: assessment.level_id,
      pool_size: poolSize,
      question_count: assessment.question_count,
      questions,
      frozen: useFrozen,
    };
  });
}
