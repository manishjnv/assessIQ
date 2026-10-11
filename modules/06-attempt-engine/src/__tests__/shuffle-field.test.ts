import { describe, expect, it } from "vitest";
import { shuffleFieldOf } from "../option-shuffle.js";

describe("shuffleFieldOf", () => {
  it("reads the registry shuffle field; unknown types are never shuffled", () => {
    expect(shuffleFieldOf("mcq")).toBe("options");
    expect(shuffleFieldOf("multi_select")).toBe("options");
    expect(shuffleFieldOf("ordering")).toBe("items");
    expect(shuffleFieldOf("subjective")).toBeNull();
    expect(shuffleFieldOf("nope")).toBeNull();
  });
});
