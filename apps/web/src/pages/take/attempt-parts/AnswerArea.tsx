import type { FrozenQuestionWire } from "@assessiq/candidate-ui";
import { isQuestionType } from "@assessiq/question-types";
import { rendererMap, type QuestionRenderer } from "../renderers.js";
import { hasForbiddenSynonym, MalformedQuestion, UnknownTypeArea } from "./shared.js";

// ─── AnswerArea dispatcher ────────────────────────────────────────────────────
// Extracted to a named component so React's reconciler never loses the element
// tree when the question type changes (different sub-components but same slot).

export function AnswerArea({
  question,
  answer,
  disabled,
  onAnswerChange,
  onBlur,
}: {
  question: FrozenQuestionWire;
  answer: unknown;
  disabled: boolean;
  onAnswerChange: (value: unknown) => void;
  onBlur: () => void;
}): React.JSX.Element {
  // Stage 1.5d shape lock: any forbidden synonym key in content triggers a
  // hard malformed fallback — no partial render of legacy rows.
  if (hasForbiddenSynonym(question.content)) {
    return <MalformedQuestion />;
  }

  if (!isQuestionType(question.type)) {
    return <UnknownTypeArea type={question.type} />;
  }
  const Renderer: QuestionRenderer | null = rendererMap[question.type];
  if (Renderer === null) return <UnknownTypeArea type={question.type} />;
  return (
    <Renderer
      question={question}
      content={question.content}
      answer={answer}
      disabled={disabled}
      onAnswerChange={onAnswerChange}
      onBlur={onBlur}
    />
  );
}
