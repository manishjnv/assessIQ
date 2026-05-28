/**
 * Stage-1 tolerant coercion unit tests (Phase 3, Bug B fix, 2026-05-28).
 *
 * Pure unit tests of coerceSubmitAnchorsPayload — no DB, no claude. Covers
 * the drift classes the coercion is designed to repair:
 *   1. Top-level array instead of {findings: [...]}
 *   2. findings as numeric-keyed object instead of array
 *   3. hit as string "true"/"false"
 *   4. confidence as string "0.8"
 *   5. anchor_id as number
 *   6. Already-valid payload passes through unchanged
 *   7. Unrecognised shape returns as-is (caller's degrade path handles it)
 *
 * The contract is: after coercion, SubmitAnchorsInputSchema.safeParse should
 * succeed for any of the above drift classes. If it doesn't, the runtime
 * degrades to anchors=[] and proceeds to Stage 2 (degrade test below).
 */

import { describe, it, expect } from "vitest";
import { z } from "zod";
import { coerceSubmitAnchorsPayload } from "../runtimes/claude-code-vps.js";
import { AnchorFindingSchema } from "../types.js";

const SubmitAnchorsInputSchema = z.object({
  findings: z.array(AnchorFindingSchema),
});

function parseable(raw: unknown): boolean {
  return SubmitAnchorsInputSchema.safeParse(coerceSubmitAnchorsPayload(raw)).success;
}

describe("coerceSubmitAnchorsPayload — drift repair", () => {
  it("repairs top-level array of findings into {findings: [...]}", () => {
    const drifted = [
      { anchor_id: "a1", hit: true, evidence_quote: "x", confidence: 0.8 },
      { anchor_id: "a2", hit: false },
    ];
    expect(parseable(drifted)).toBe(true);
  });

  it("repairs findings as numeric-keyed object into array", () => {
    const drifted = {
      findings: {
        "0": { anchor_id: "a1", hit: true },
        "1": { anchor_id: "a2", hit: false },
      },
    };
    expect(parseable(drifted)).toBe(true);
  });

  it('coerces hit emitted as string "true"/"false" to boolean', () => {
    const drifted = {
      findings: [
        { anchor_id: "a1", hit: "true" },
        { anchor_id: "a2", hit: "False" },
      ],
    };
    const out = coerceSubmitAnchorsPayload(drifted) as { findings: Array<{ hit: unknown }> };
    expect(out.findings[0]?.hit).toBe(true);
    expect(out.findings[1]?.hit).toBe(false);
    expect(parseable(drifted)).toBe(true);
  });

  it('coerces confidence emitted as string "0.8" to number', () => {
    const drifted = {
      findings: [{ anchor_id: "a1", hit: true, confidence: "0.83" }],
    };
    const out = coerceSubmitAnchorsPayload(drifted) as { findings: Array<{ confidence: unknown }> };
    expect(out.findings[0]?.confidence).toBeCloseTo(0.83);
    expect(parseable(drifted)).toBe(true);
  });

  it("coerces anchor_id emitted as number into string", () => {
    const drifted = {
      findings: [{ anchor_id: 7, hit: true }],
    };
    const out = coerceSubmitAnchorsPayload(drifted) as { findings: Array<{ anchor_id: unknown }> };
    expect(out.findings[0]?.anchor_id).toBe("7");
    expect(parseable(drifted)).toBe(true);
  });

  it("repairs mixed drift in a single payload", () => {
    const drifted = [
      { anchor_id: 1, hit: "true", confidence: "0.9", evidence_quote: "q1" },
      { anchor_id: 2, hit: "false" },
    ];
    expect(parseable(drifted)).toBe(true);
  });

  it("passes through an already-valid payload unchanged-equivalent", () => {
    const ok = {
      findings: [
        { anchor_id: "a1", hit: true, evidence_quote: "x", confidence: 0.5 },
      ],
    };
    expect(parseable(ok)).toBe(true);
  });

  it("passes through an empty findings array", () => {
    expect(parseable({ findings: [] })).toBe(true);
  });

  it("returns non-object input unchanged (caller degrade path handles it)", () => {
    expect(coerceSubmitAnchorsPayload(null)).toBe(null);
    expect(coerceSubmitAnchorsPayload(undefined)).toBe(undefined);
    expect(coerceSubmitAnchorsPayload("not-an-object")).toBe("not-an-object");
  });

  it("leaves invalid string confidence unchanged so degrade fires", () => {
    const drifted = {
      findings: [{ anchor_id: "a1", hit: true, confidence: "not-a-number" }],
    };
    const out = coerceSubmitAnchorsPayload(drifted) as { findings: Array<{ confidence: unknown }> };
    expect(out.findings[0]?.confidence).toBe("not-a-number");
    // Coercion gave up → safeParse fails → caller will degrade.
    expect(parseable(drifted)).toBe(false);
  });

  it("caps findings array at 500 items (memory-bomb defense)", () => {
    // Sonnet adversarial revision: an unbounded findings array would let a
    // malformed or hostile model emit an arbitrary-size payload before zod
    // rejects it. The coercer slices to MAX_FINDINGS=500 before per-item
    // coercion to bound allocation.
    const huge = {
      findings: Array.from({ length: 5000 }, (_, i) => ({
        anchor_id: `a${i}`,
        hit: true,
      })),
    };
    const out = coerceSubmitAnchorsPayload(huge) as { findings: unknown[] };
    expect(out.findings.length).toBe(500);
  });

  it("does not array-ify object findings with non-numeric keys", () => {
    const drifted = {
      findings: { a: { anchor_id: "a1", hit: true } },
    };
    const out = coerceSubmitAnchorsPayload(drifted) as { findings: unknown };
    // Preserves the original — caller degrade path handles it.
    expect(Array.isArray(out.findings)).toBe(false);
  });
});
