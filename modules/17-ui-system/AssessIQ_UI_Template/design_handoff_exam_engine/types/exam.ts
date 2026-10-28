// AssessIQ exam engine — data contracts
// Mirrors data/sample-exam.json and the prototype's in-memory model.
// Adapt names to the existing AssessIQ API; keep the shapes.

export type QuestionType = "single" | "multi" | "grid" | "number" | "text" | "essay" | "order" | "cloze";

interface QuestionBase {
  id: string;
  type: QuestionType;
  /** Short type chip label, e.g. "Choose one", "True or false". Falls back to TYPE_LABEL[type]. */
  pill?: string;
  /** Question stem. Plain text. */
  t: string;
  /** Optional passage / diagram / table shown beside the question (left pane on wide screens). */
  passage?: string;
  /** Render passage in monospace (diagrams, ASCII tables). */
  pre?: boolean;
  /** Excluded from scoring (self-report items). */
  ungraded?: boolean;
  /** Explanation shown in the answer key after submission. */
  ex: string;
}

export interface SingleQ extends QuestionBase { type: "single"; o: string[]; ans?: number; layout?: "scale" }
export interface MultiQ extends QuestionBase { type: "multi"; o: string[]; ans: boolean[] }
/** Rows (s) × columns (cols), one choice per row. Used for true/false, match, classify, label-diagram, yes/no. */
export interface GridQ extends QuestionBase { type: "grid"; s: string[]; cols: string[]; ans: number[] }
export interface NumberQ extends QuestionBase { type: "number"; kind: "integer" | "decimal"; unit?: string; ans: number }
export interface TextQ extends QuestionBase { type: "text"; max: number; accept: string[] }
export interface EssayQ extends QuestionBase { type: "essay"; min: number; max: number }
export interface OrderQ extends QuestionBase { type: "order"; o: string[]; ans: number[] }
/** Stem contains "____" placeholders; accept[k] lists accepted answers for blank k (case-insensitive, trimmed). */
export interface ClozeQ extends QuestionBase { type: "cloze"; accept: string[][] }

export type Question = SingleQ | MultiQ | GridQ | NumberQ | TextQ | EssayQ | OrderQ | ClozeQ;

/** Answer value per type. Empty values: single -1 · multi all false · grid all null · cloze all "" · number/text/essay "" · order null */
export type AnswerValue = number | boolean[] | (number | null)[] | string | string[] | number[] | null;

export interface Exam {
  id: string;
  title: string;
  durationSecs: number;      // 7200
  passMarkPct: number;       // 70
  lowTimeWarningSecs: number; // 300
  organization: { name: string; short: string; logoUrl: string | null };
  candidate: { id: string; name: string };
  questions: Question[];
}

export type View = "question" | "review" | "result" | "key";
export type NavFilter = "all" | "ans" | "open" | "flag";
export type Theme = "mid" | "light" | "dark";
export type OrgDisplay = "both" | "logo" | "name" | "off";
export type Grade = "correct" | "incorrect" | "unanswered" | "manual" | "na";

export interface AttemptState {
  view: View;
  idx: number;                 // current question index (0-based)
  answers: AnswerValue[];
  flags: boolean[];
  secsLeft: number;
  savedAt: number;             // epoch ms of last successful save
}

export interface UiPrefs {
  theme: Theme;                // default "mid"
  themeSet: boolean;           // true once the user picks a theme explicitly
  fontScale: 0.92 | 1 | 1.12 | 1.25;
  nav: "open" | "closed";      // desktop navigator panel
  org: OrgDisplay;             // default "both"
  navFilter: NavFilter;        // default "all" (not persisted)
}
