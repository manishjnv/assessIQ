# @assessiq/question-types

Leaf package. It holds the one registry of question types. It has no React and no DB code.

## Definition shape

`QuestionTypeDef` (see `src/registry.ts`):
- Data: `id`, `label`, `contentSchema`, `answerSchema`, `importColumns`, `qtiInteraction`, `generatorSkill`, `scoring`, `helpKey`.
- Flags: `aiGradeable`, `rubricRequired`, `rubricSynthesis`, `shuffleField`.
- Hooks (pure): `candidateView`, `coerceContent`, `guidanceText`, `rubricText`, `evalStructuralCheck`. Optional: `synthConcepts`, `deterministicScore`, `isAttempted`, `deterministicMarks` (signed marks override; only `structured_case` passage sets, EX-3), `checkAnswer`.

Derived arrays: `DETERMINISTIC_IDS`, `AI_GRADEABLE_IDS`, `RUBRIC_REQUIRED_IDS`, `RUBRIC_SYNTHESIS_IDS`. String wrappers: `candidateViewFor`, `coerceContentFor`, `deterministicScoreFor`, `checkAnswerFor`.

## Which flag answers which question

- "Does AI grade it on admin click?" Use `aiGradeable`.
- "Must it have a stored rubric before activation?" Use `rubricRequired` (subjective, scenario).
- "Does the rubric come from content at grade time?" Use `rubricSynthesis !== 'none'`.
- "Does the wizard generate a rubric?" Use `aiGradeable && rubricSynthesis === 'none'`. `rubricRequired` also covers scenario, which is wrong here.

## Add a type

1. Add `src/types/<id>/index.ts` that exports `definition`.
2. Add the id to `QUESTION_TYPES` and the definition to `QUESTION_TYPE_REGISTRY`.
3. Run `pnpm gen:question-type-check` and commit the migration.
4. Add an entry in the two renderer maps and the help content.

## Lint

`pnpm lint:question-type-registry` (strict in `lint:repo`) blocks type-id literals outside this package and the allowlist. Rule R6 checks that every definition is complete. Details: `docs/02-data-model.md` "Question type registry".

## Golden test

`src/__tests__/golden.test.ts` compares `candidateView`, `guidanceText`, `deterministicScore`, `isAttempted` and `deterministicMarks` (points 4, negative marks 1) of every type with literal outputs in `src/__tests__/golden.fixtures.ts`. The module parity test cannot catch a hook change, because the modules delegate to the registry. After an intentional hook change, review the failing diff. Then regenerate the literals: run the hooks over the inputs in `fixtures.ts` (same order as the test), paste the new output into `golden.fixtures.ts`, and commit both with the hook change.
