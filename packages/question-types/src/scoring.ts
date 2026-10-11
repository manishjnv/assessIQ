// Pure scoring primitives, re-exported for callers that need the building blocks (module 09).
export { isMcqAnswerCorrect } from "./types/mcq/index.js";
export { isNumericAnswerCorrect, parseNumericAnswer } from "./types/numeric/index.js";
export { multiSelectFraction } from "./types/multi_select/index.js";
export { orderingFraction } from "./types/ordering/index.js";
export { structuredCaseFraction } from "./types/structured_case/index.js";
