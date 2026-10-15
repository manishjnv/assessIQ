// Golden guard: hook outputs are compared with literal data in golden.fixtures.ts,
// never with another implementation. Input order matches parity.test.ts.
import { describe, expect, it } from "vitest";
import { QUESTION_TYPES, QUESTION_TYPE_REGISTRY, DETERMINISTIC_IDS } from "../index.js";
import { ANSWERS, CONTENTS } from "./fixtures.js";
import { GOLDEN } from "./golden.fixtures.js";

describe("golden hook outputs", () => {
  it("covers exactly the registered types", () => {
    expect(Object.keys(GOLDEN).sort()).toEqual([...QUESTION_TYPES].sort());
    expect(Object.keys(GOLDEN).filter((t) => GOLDEN[t]!.deterministicScore).sort()).toEqual([...DETERMINISTIC_IDS].sort());
  });

  it.each(QUESTION_TYPES)("%s candidateView", (t) => {
    const inputs = [...CONTENTS[t], null, "str", [1]];
    expect(inputs.map((c) => QUESTION_TYPE_REGISTRY[t].candidateView(c))).toStrictEqual(GOLDEN[t]!.candidateView);
  });

  it.each(QUESTION_TYPES)("%s guidanceText", (t) => {
    const inputs = [...CONTENTS[t], null];
    expect(inputs.map((c) => QUESTION_TYPE_REGISTRY[t].guidanceText(c))).toStrictEqual(GOLDEN[t]!.guidanceText);
  });

  it.each(DETERMINISTIC_IDS)("%s deterministicScore", (t) => {
    const actual = [...CONTENTS[t], null].map((c) => ANSWERS[t]!.map((a) => QUESTION_TYPE_REGISTRY[t].deterministicScore!(c, a)));
    expect(actual).toStrictEqual(GOLDEN[t]!.deterministicScore);
  });
});
