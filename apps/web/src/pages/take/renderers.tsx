// Candidate take view: one renderer per question type (RW-54a step 7).
// Add a type to packages/question-types and `satisfies` fails here until the
// new type has an entry. Use `null` for a type with no candidate renderer.
import type { QuestionType } from '@assessiq/question-types';
import type { FrozenQuestionWire } from '@assessiq/candidate-ui';
import { McqAnswerArea } from './McqAnswerArea.js';
import { NumericAnswerArea } from './NumericAnswerArea.js';
import { MultiSelectAnswerArea } from './MultiSelectAnswerArea.js';
import { OrderingAnswerArea } from './OrderingAnswerArea.js';
import { StructuredCaseAnswerArea } from './StructuredCaseAnswerArea.js';
import {
  SubjectiveAnswerArea,
  KqlAnswerArea,
  LogAnalysisAnswerArea,
  ScenarioAnswerArea,
} from './LocalAnswerAreas.js';

/**
 * Props every candidate renderer accepts. `content` and `answer` are the
 * contract; `question`, `disabled`, `onAnswerChange`, `onBlur` are the take
 * view's wiring (each renderer reads only what it needs).
 */
export interface QuestionRendererProps {
  content: unknown;
  answer: unknown;
  question: FrozenQuestionWire;
  disabled: boolean;
  onAnswerChange: (value: unknown) => void;
  onBlur: () => void;
}

export type QuestionRenderer = (props: QuestionRendererProps) => React.JSX.Element;

export const rendererMap = {
  mcq: McqAnswerArea,
  subjective: SubjectiveAnswerArea,
  kql: KqlAnswerArea,
  scenario: ScenarioAnswerArea,
  log_analysis: LogAnalysisAnswerArea,
  numeric: NumericAnswerArea,
  multi_select: MultiSelectAnswerArea,
  ordering: OrderingAnswerArea,
  structured_case: StructuredCaseAnswerArea,
} satisfies { [K in QuestionType]: QuestionRenderer | null };
