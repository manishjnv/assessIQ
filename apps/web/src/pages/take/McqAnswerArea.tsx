// MCQ option list — shared by the real attempt runner (Attempt.tsx) and the
// practice question on the pre-test landing (TokenLanding.tsx) so a candidate
// rehearses with the exact same control.

import "./take-theme.css";
import { OptionImage, RichText } from "./rich-parts.js";

// mcq: { question, options: string[], correct: number, rationale? }
interface McqContent {
  question: string;
  options: string[];   // 4 option texts, indexed 0–3
  correct: number;     // not rendered to candidate
  rationale?: string;  // not rendered to candidate
}

export function McqAnswerArea({
  question,
  answer,
  disabled,
  onAnswerChange,
}: {
  question: { question_id: string; content: unknown; assets?: Array<{ id: string; alt_text: string; width: number; height: number }> };
  answer: unknown;
  disabled: boolean;
  onAnswerChange: (value: unknown) => void;
}): React.JSX.Element {
  const content = question.content as McqContent;
  const options: string[] = Array.isArray(content?.options) ? (content.options as string[]) : [];
  // Canonical answer shape: { selected: number } — index into options[].
  const answerObj =
    answer !== null && typeof answer === 'object'
      ? (answer as { selected?: unknown })
      : null;
  const selected: number | null =
    typeof answerObj?.selected === 'number' ? answerObj.selected : null;

  return (
    <div role="radiogroup" aria-label="Answer options" className="aiq-take-opts">
      {options.map((text, idx) => {
        const isSelected = selected === idx;
        const letter = String.fromCharCode(65 + idx); // A, B, C, D
        return (
          <label key={idx} className="aiq-take-opt" data-checked={isSelected} data-disabled={disabled}>
            <input
              type="radio"
              className="aiq-take-visually-hidden-input"
              name={question.question_id}
              value={String(idx)}
              checked={isSelected}
              disabled={disabled}
              onChange={() => onAnswerChange({ selected: idx })}
            />
            <span className="aiq-take-opt-badge" aria-hidden="true">{letter}</span>
            <span className="aiq-take-opt-text"><RichText q={question} text={text} /><OptionImage q={question} idx={idx} /></span>
            <span className="aiq-take-radio" aria-hidden="true" />
          </label>
        );
      })}
    </div>
  );
}
