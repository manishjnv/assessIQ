import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DETERMINISTIC_IDS, QUESTION_TYPES, QUESTION_TYPE_REGISTRY, getQuestionType } from "../registry.js";

const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "types");
const folders = readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
const KEYS = ["id", "label", "contentSchema", "answerSchema", "importColumns", "qtiInteraction", "generatorSkill", "scoring", "helpKey"];

describe("question type registry", () => {
  it("folder names equal definition ids and QUESTION_TYPES", async () => {
    for (const f of folders) expect((await import(`../types/${f}/index.ts`)).definition.id).toBe(f);
    expect([...folders].sort()).toEqual([...QUESTION_TYPES].sort());
    expect(Object.keys(QUESTION_TYPE_REGISTRY).sort()).toEqual([...QUESTION_TYPES].sort());
  });
  it("every definition has every key", () => {
    for (const t of QUESTION_TYPES) for (const k of KEYS) expect(getQuestionType(t), `${t}.${k}`).toHaveProperty(k);
  });
  it("deterministic ids match the legacy list; unknown id throws", () => {
    expect([...DETERMINISTIC_IDS]).toEqual(["mcq", "numeric", "multi_select", "ordering", "structured_case"]);
    expect(() => getQuestionType("nope")).toThrow("UNKNOWN_QUESTION_TYPE: nope");
  });
});
