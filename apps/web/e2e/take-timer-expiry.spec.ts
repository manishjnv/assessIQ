import { test, expect } from "@playwright/test";

test.skip("candidate auto-submits when timer hits zero", async ({ page }) => {
  // TODO(session-4b): unskip once POST /api/take/start mints candidate sessions
  // AND once a test fixture provides a 60-second-duration assessment.
  //
  // Sketch:
  //   1. Land on a short-duration magic-link (E2E_CANDIDATE_TOKEN pointing at a
  //      fixture assessment with a 60-second time limit)
  //   2. Wait until the timer pill text reads "0:00" (or just past — 70s buffer)
  //   3. Page should redirect to /take/attempt/<id>/submitted automatically
  //   4. Server marks attempt as auto_submitted — verifiable via:
  //        GET /api/me/attempts/:id/result  →  HTTP 202 with status "auto_submitted"
  //
  // The auto-submit is driven by the client-side timer reaching zero and calling
  // the same submit endpoint as a manual submit; the server must handle duplicate
  // submit calls idempotently (second call returns 409 or 200, never 500).
  void page; // suppress unused-variable lint until test is implemented
  void expect; // suppress unused-variable lint until test is implemented
});
