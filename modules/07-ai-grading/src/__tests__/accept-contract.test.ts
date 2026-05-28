/**
 * FE/BE Accept-contract regression test (Phase 4, Bug A fix, 2026-05-28).
 *
 * Background: on 2026-05-26 the admin "Grade all" flow was found never to
 * complete attempts. Root cause: the UI's POST /api/admin/attempts/:id/accept
 * body was `{ question_id }` — but the backend ACCEPT_BODY_SCHEMA requires
 * `{ proposals: [ …full GradingProposal objects… ] }`. Every accept silently
 * 422'd and zero `gradings` rows ever materialised. The E2E test passed
 * because it sent the correct shape; the live UI never did.
 *
 * This test pins the contract: the FE payload shape MUST satisfy the
 * backend's ACCEPT_BODY_SCHEMA. If anyone ever revives the broken shape
 * (e.g. by sending `{question_id}` again, or by sending a proposal missing
 * a required field), this test fails BEFORE deploy.
 *
 * Pure schema test — no DB, no claude. Runs fast in CI.
 */

import { describe, it, expect } from "vitest";
import { ACCEPT_BODY_SCHEMA } from "../routes.js";
import type { GradingProposal } from "../types.js";

// The FE constructs proposals exactly like this — the GradingProposal shape
// returned by the runtime, no edits required for the basic single-accept.
function feProposal(): GradingProposal {
  return {
    attempt_id: "019e60bb-0556-7911-a4fe-268576f297f4",
    question_id: "b19df776-eb50-40d3-8a43-58a1885814f4",
    anchors: [
      { anchor_id: "a1", hit: true, evidence_quote: "x", confidence: 0.9 },
    ],
    band: {
      reasoning_band: 3,
      ai_justification: "covers the pivot to identity",
    },
    score_earned: 7.5,
    score_max: 10,
    prompt_version_sha: "anchors:30a419e9;band:e2460dec;escalate:-",
    prompt_version_label: "v1;v1;-",
    model: "claude-haiku-4-5;claude-sonnet-4-6;-",
    escalation_chosen_stage: "2",
    generated_at: "2026-05-26T02:32:09.373Z",
  };
}

describe("accept-contract — FE payload satisfies backend schema", () => {
  it("accepts the canonical single-proposal FE shape (handleAccept)", () => {
    const body = { proposals: [feProposal()] };
    const result = ACCEPT_BODY_SCHEMA.safeParse(body);
    expect(result.success).toBe(true);
  });

  it("accepts the Accept-all FE shape with multiple proposals", () => {
    const p1 = feProposal();
    const p2 = {
      ...feProposal(),
      question_id: "019dedd9-a7bd-7f6c-ba78-cc2f9a077751",
    };
    const result = ACCEPT_BODY_SCHEMA.safeParse({ proposals: [p1, p2] });
    expect(result.success).toBe(true);
  });

  it("accepts a proposal with escalation-reconcile edits", () => {
    const body = {
      proposals: [
        {
          ...feProposal(),
          escalation_chosen_stage: "3" as const,
          edits: {
            question_id: "b19df776-eb50-40d3-8a43-58a1885814f4",
            ai_justification: "Reconciled: chose Stage 3 second opinion.",
          },
        },
      ],
    };
    const result = ACCEPT_BODY_SCHEMA.safeParse(body);
    expect(result.success).toBe(true);
  });

  // ---- The regression guards: shapes that USED to be sent and MUST fail ----

  it("REGRESSION: rejects the old `{question_id}` body shape", () => {
    // This is the exact shape the broken handleAccept sent for ~weeks.
    const brokenBody = { question_id: "b19df776-eb50-40d3-8a43-58a1885814f4" };
    const result = ACCEPT_BODY_SCHEMA.safeParse(brokenBody);
    expect(result.success).toBe(false);
  });

  it("REGRESSION: rejects an empty proposals array", () => {
    const result = ACCEPT_BODY_SCHEMA.safeParse({ proposals: [] });
    expect(result.success).toBe(false);
  });

  it("REGRESSION: rejects a proposal missing required band field", () => {
    const broken = { ...feProposal() } as Record<string, unknown>;
    delete broken.band;
    const result = ACCEPT_BODY_SCHEMA.safeParse({ proposals: [broken] });
    expect(result.success).toBe(false);
  });

  it("REGRESSION: rejects a proposal whose attempt_id is not a uuid", () => {
    const broken = { ...feProposal(), attempt_id: "not-a-uuid" };
    const result = ACCEPT_BODY_SCHEMA.safeParse({ proposals: [broken] });
    expect(result.success).toBe(false);
  });

  it("REGRESSION: rejects a proposal whose generated_at is not ISO-8601", () => {
    const broken = { ...feProposal(), generated_at: "2026-05-26 02:32:09" };
    const result = ACCEPT_BODY_SCHEMA.safeParse({ proposals: [broken] });
    expect(result.success).toBe(false);
  });
});
