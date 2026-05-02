import { test, expect } from "@playwright/test";

// TODO(session-4b): unskip once POST /api/take/start mints candidate sessions.
// Until then this test cannot run because it needs a real magic-link token
// resolved server-side into an aiq_sess cookie + attempt row.
test.skip("candidate happy path: magic-link → start → answer → submit", async ({ page }) => {
  const token = process.env.E2E_CANDIDATE_TOKEN;
  if (!token) test.skip(true, "Set E2E_CANDIDATE_TOKEN to a fresh magic-link token from the admin invite flow.");

  // 1. Land on magic-link
  await page.goto(`/take/${token}`);
  await expect(page.getByRole("heading", { name: /begin/i })).toBeVisible({ timeout: 10_000 });

  // 2. Click Begin
  await page.getByRole("button", { name: /begin/i }).click();
  await expect(page.url()).toContain("/take/attempt/");

  // 3. Answer the first MCQ question (assumes test fixture has MCQs first)
  await expect(page.getByRole("heading", { name: /question 1/i })).toBeVisible();
  await page.getByRole("radio").first().click();
  await page.getByRole("button", { name: /next/i }).click();

  // 4. Submit (fast-forward to last question via the navigator)
  // Skip ahead — click last navigator square
  const navSquares = page.locator("nav[aria-label='Question navigator'] button");
  await navSquares.last().click();
  await page.getByRole("button", { name: /submit/i }).click();

  // 5. Confirm submission
  await page.getByRole("button", { name: /confirm/i }).click();
  await expect(page.url()).toContain("/submitted");
  await expect(page.getByText(/grading pending|under review|submitted/i)).toBeVisible();
});
