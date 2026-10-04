import { test, expect } from "@playwright/test";

test("glass themes switch live, fit mobile and round-trip settings", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/");
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  // The worker may deliver one last update after pausing; wait until the time is stable.
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
  const theme = page.getByLabel("Interface theme", { exact: true });
  await expect(theme).toHaveValue("classic");
  for (const value of ["glass-dark", "glass-light"]) {
    await theme.selectOption(value);
    await expect(page.locator("html")).toHaveAttribute("data-theme", value);
    await expect(page.locator(".simulation-bottom b")).toHaveText(time!);
    expect(
      await page
        .locator(".panel")
        .first()
        .evaluate((el) => getComputedStyle(el).backdropFilter),
    ).toContain("blur");
    await expect(
      page.getByRole("button", { name: "Resume", exact: true }),
    ).toHaveCSS(
      "color",
      value === "glass-light" ? "rgb(255, 255, 255)" : "rgb(18, 57, 46)",
    );
    await page.mouse.move(0, 0);
    await page.evaluate(() => scrollTo(0, 0));
    await page.screenshot({ path: `reports/${value}.png` });
  }
  expect(
    await page
      .locator("html")
      .evaluate((el) => getComputedStyle(el).colorScheme),
  ).toBe("light");
  const downloading = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Save settings", exact: true })
    .click();
  const path = await (await downloading).path();
  await theme.selectOption("classic");
  await page.locator("input[type=file]").setInputFiles(path!);
  await expect(theme).toHaveValue("glass-light");
  await expect(page.locator("html")).toHaveAttribute(
    "data-theme",
    "glass-light",
  );
  await page.setViewportSize({ width: 390, height: 844 });
  for (const value of ["glass-light", "glass-dark", "classic"]) {
    await theme.selectOption(value);
    await expect(theme).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  }
  await theme.selectOption("glass-light");
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({ path: "reports/glass-light-mobile.png" });
  await expect(page.getByRole("alert")).toHaveCount(0);
});
