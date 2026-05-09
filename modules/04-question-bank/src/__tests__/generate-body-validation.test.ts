/**
 * Unit tests for parseGenerateBody — the route-layer validator for
 * POST /admin/packs/:id/levels/:levelId/generate.
 *
 * Tests run without a database (no testcontainer needed): parseGenerateBody is
 * a pure function that only throws ValidationError on bad input and returns
 * the parsed shape otherwise.
 */

import { describe, it, expect } from "vitest";
import { parseGenerateBody } from "../routes.js";
import { ValidationError } from "@assessiq/core";

// ---------------------------------------------------------------------------
// Helper — assert ValidationError with a specific details.code
// ---------------------------------------------------------------------------

function expectValidationCode(
  fn: () => unknown,
  expectedCode: string,
): ValidationError {
  let caught: unknown;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(ValidationError);
  const ve = caught as ValidationError;
  expect(ve.details?.["code"]).toBe(expectedCode);
  return ve;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("parseGenerateBody — existing behaviour (no type_counts)", () => {
  it("count only — returns parsed count, no typeCounts", () => {
    const result = parseGenerateBody({ count: 10 });
    expect(result.count).toBe(10);
    expect(result.typeCounts).toBeUndefined();
    expect(result.topicFocus).toBeUndefined();
  });

  it("count + topic_focus — returns both, no typeCounts", () => {
    const result = parseGenerateBody({ count: 5, topic_focus: "triage" });
    expect(result.count).toBe(5);
    expect(result.topicFocus).toBe("triage");
    expect(result.typeCounts).toBeUndefined();
  });

  it("count below minimum — throws INVALID_PARAM", () => {
    expectValidationCode(() => parseGenerateBody({ count: 0 }), "INVALID_PARAM");
  });

  it("count above maximum — throws INVALID_PARAM", () => {
    expectValidationCode(() => parseGenerateBody({ count: 31 }), "INVALID_PARAM");
  });
});

describe("parseGenerateBody — type_counts sum validation", () => {
  it("type_counts sum mismatch returns INVALID_TYPE_COUNTS_SUM with correct details", () => {
    const ve = expectValidationCode(
      () => parseGenerateBody({ count: 10, type_counts: { mcq: 5, log_analysis: 4 } }),
      "INVALID_TYPE_COUNTS_SUM",
    );
    // sum of provided keys: 5 + 4 = 9, count = 10
    expect(ve.details?.["sum"]).toBe(9);
    expect(ve.details?.["count"]).toBe(10);
  });

  it("type_counts sum exceeds count — INVALID_TYPE_COUNTS_SUM", () => {
    const ve = expectValidationCode(
      () => parseGenerateBody({ count: 5, type_counts: { mcq: 4, log_analysis: 3 } }),
      "INVALID_TYPE_COUNTS_SUM",
    );
    expect(ve.details?.["sum"]).toBe(7);
    expect(ve.details?.["count"]).toBe(5);
  });
});

describe("parseGenerateBody — type_counts valid cases", () => {
  it("all-zero except one type (sum === count) passes through cleanly", () => {
    const result = parseGenerateBody({
      count: 5,
      type_counts: { mcq: 5, log_analysis: 0, scenario: 0, kql: 0, subjective: 0 },
    });
    expect(result.count).toBe(5);
    expect(result.typeCounts).toEqual({
      mcq: 5,
      log_analysis: 0,
      scenario: 0,
      kql: 0,
      subjective: 0,
    });
  });

  it("partial type_counts (only provided keys included) passes when sum === count", () => {
    const result = parseGenerateBody({
      count: 5,
      type_counts: { mcq: 5 },
    });
    expect(result.typeCounts?.mcq).toBe(5);
    // Keys not provided are absent from result
    expect(result.typeCounts?.log_analysis).toBeUndefined();
  });

  it("full allocation matching count passes", () => {
    const result = parseGenerateBody({
      count: 10,
      type_counts: { mcq: 4, log_analysis: 3, scenario: 2, kql: 1, subjective: 0 },
    });
    expect(result.typeCounts?.mcq).toBe(4);
    expect(result.typeCounts?.log_analysis).toBe(3);
    expect(result.typeCounts?.scenario).toBe(2);
    expect(result.typeCounts?.kql).toBe(1);
    expect(result.typeCounts?.subjective).toBe(0);
  });

  it("type_counts=null treated as absent (no typeCounts returned)", () => {
    const result = parseGenerateBody({ count: 5, type_counts: null });
    expect(result.typeCounts).toBeUndefined();
  });
});

describe("parseGenerateBody — type_counts shape validation", () => {
  it("non-object type_counts throws INVALID_PARAM", () => {
    expectValidationCode(
      () => parseGenerateBody({ count: 5, type_counts: "mcq:5" }),
      "INVALID_PARAM",
    );
  });

  it("array type_counts throws INVALID_PARAM", () => {
    expectValidationCode(
      () => parseGenerateBody({ count: 5, type_counts: [5, 0, 0, 0, 0] }),
      "INVALID_PARAM",
    );
  });

  it("non-integer type count throws INVALID_PARAM", () => {
    expectValidationCode(
      () => parseGenerateBody({ count: 5, type_counts: { mcq: 2.5, log_analysis: 2 } }),
      "INVALID_PARAM",
    );
  });

  it("negative type count throws INVALID_PARAM", () => {
    expectValidationCode(
      () => parseGenerateBody({ count: 5, type_counts: { mcq: -1, log_analysis: 6 } }),
      "INVALID_PARAM",
    );
  });
});
