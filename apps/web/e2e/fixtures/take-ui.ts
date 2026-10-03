// Candidate-runner UI helpers shared by the take-* and ordering/structured_case specs.
// Real backend (see ../local-stack.sh); the candidate session cookie comes from the dev minter.
import { expect, type BrowserContext, type Page } from '@playwright/test';

/** Put the candidate's session cookie in the browser and open the runner for `attemptId`. */
export async function openAttempt(page: Page, context: BrowserContext, cookie: string, attemptId: string): Promise<void> {
  const eq = cookie.indexOf('=');
  await context.addCookies([
    { name: cookie.slice(0, eq), value: cookie.slice(eq + 1), domain: 'localhost', path: '/', httpOnly: true, secure: false, sameSite: 'Lax' },
  ]);
  await page.goto(`/take/attempt/${attemptId}`);
  await expect(page.getByText(/Question 1 of/)).toBeVisible({ timeout: 20_000 });
}

/** Submit through the confirmation dialog and wait for the submitted page. */
export async function submitViaUi(page: Page, attemptId: string): Promise<void> {
  await page.getByRole('button', { name: 'Submit', exact: true }).click();
  await page.getByRole('button', { name: 'Submit test' }).click();
  await expect(page).toHaveURL(new RegExp(`/take/attempt/${attemptId}/submitted`), { timeout: 20_000 });
}

/** Reorder the shown ordering question into `wanted` (item texts, first to last) with the Up buttons. */
export async function arrangeOrdering(page: Page, wanted: string[]): Promise<void> {
  const items = page.getByRole('listitem').filter({ has: page.getByRole('button', { name: /^Move item \d+ up$/ }) });
  await expect(items).toHaveCount(wanted.length);
  for (let target = 0; target < wanted.length - 1; target++) {
    // find where wanted[target] sits now, then bubble it up to `target`
    const texts = (await items.allTextContents()).map((t) => t.trim());
    let at = texts.findIndex((t) => t.includes(wanted[target]!));
    expect(at, `item "${wanted[target]}" not shown`).toBeGreaterThanOrEqual(0);
    while (at > target) {
      await page.getByRole('button', { name: `Move item ${at + 1} up` }).click();
      at--;
    }
  }
  await expect(items).toHaveText(wanted.map((w) => new RegExp(w)));
}
