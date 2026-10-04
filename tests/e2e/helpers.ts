import { expect, type Page } from "@playwright/test";

// After pausing, the worker may still deliver one last update.
// Wait until the displayed simulation time stops changing and return it.
export async function stableSimTime(page: Page): Promise<string> {
  const clock = page.locator(".simulation-bottom b");
  let time = await clock.textContent();
  await expect
    .poll(async () => {
      const previous = time;
      await page.waitForTimeout(250);
      time = await clock.textContent();
      return time === previous;
    })
    .toBe(true);
  return time!;
}
