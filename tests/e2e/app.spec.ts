import { test, expect } from "@playwright/test";
test("basic controls, matrix, settings and image exports", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "Pause", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(page.getByText("Paused", { exact: true })).toBeVisible();
  const before = await page.locator(".simulation-bottom b").innerText();
  for (let i = 0; i < 6; i++)
    await page.getByRole("button", { name: "Step simulation" }).click();
  await expect(page.locator(".simulation-bottom b")).not.toHaveText(before);
  await page
    .getByRole("button", { name: "Mint toward Amber", exact: true })
    .click();
  await page.getByLabel("Near force", { exact: true }).fill("0.7");
  await page.getByLabel("Far force", { exact: true }).fill("-0.6");
  await page.getByLabel("Switch distance", { exact: true }).fill("0.65");
  await expect(page.getByLabel("Rule preset")).toHaveValue("Custom");
  await page
    .getByRole("button", { name: "Amber toward Mint", exact: true })
    .click();
  await expect(page.getByLabel("Near force", { exact: true })).toHaveValue(
    "-0.3",
  );
  await page
    .getByRole("button", { name: "Mint toward Amber", exact: true })
    .click();
  await expect(page.getByLabel("Near force", { exact: true })).toHaveValue(
    "0.7",
  );
  await expect(page.getByLabel("Far force", { exact: true })).toHaveValue(
    "-0.6",
  );
  await expect(page.getByLabel("Switch distance", { exact: true })).toHaveValue(
    "0.65",
  );
  await page
    .getByRole("button", { name: "Repel → attract", exact: true })
    .click();
  await expect(page.getByLabel("Near force", { exact: true })).toHaveValue(
    "-0.8",
  );
  await expect(page.getByLabel("Far force", { exact: true })).toHaveValue(
    "0.8",
  );
  await page.getByLabel("Particles", { exact: true }).fill("500");
  await expect(page.getByText("500 particles", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Zoom in", exact: true }).click();
  await expect(page.getByText("125%", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Reset view", exact: true }).click();
  await expect(page.getByText("100%", { exact: true })).toBeVisible();
  const settingsPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save settings" }).click();
  const settings = await settingsPromise;
  expect(settings.suggestedFilename()).toBe("particle-life-settings.json");
  const path = await settings.path();
  await page.getByLabel("Rule preset").selectOption("Chase");
  await expect(page.getByLabel("Near force", { exact: true })).toHaveValue(
    "0.9",
  );
  await page.locator("input[type=file]").setInputFiles(path!);
  await expect(page.getByLabel("Rule preset")).toHaveValue("Custom");
  await expect(page.getByLabel("Near force", { exact: true })).toHaveValue(
    "-0.8",
  );
  await expect(page.getByLabel("Far force", { exact: true })).toHaveValue(
    "0.8",
  );
  await expect(page.getByLabel("Switch distance", { exact: true })).toHaveValue(
    "0.65",
  );
  const imagePromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save image", exact: true }).click();
  expect((await imagePromise).suggestedFilename()).toBe("particle-life.png");
  await page.locator("input[type=file]").setInputFiles({
    name: "bad.json",
    mimeType: "application/json",
    buffer: Buffer.from('{"count":900000}'),
  });
  await expect(page.getByRole("alert")).toBeVisible();
  await page.getByRole("button", { name: "Resume", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Pause", exact: true }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});
test("mobile layout fits the viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "Pause", exact: true }),
  ).toBeEnabled();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await expect(
    page.getByLabel("Mint toward Mint", { exact: true }),
  ).toBeVisible();
});
test("production build works from a nested path", async ({ page }) => {
  await page.goto("http://127.0.0.1:4180/repository-test/");
  await expect(
    page.getByRole("button", { name: "Pause", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Step simulation" }),
  ).toBeEnabled();
});

test("large sampled simulation remains interactive and survives resets", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "Pause", exact: true }),
  ).toBeEnabled();
  await page
    .getByLabel("Force calculation", { exact: true })
    .selectOption("fast");
  await page.getByLabel("Neighbor samples", { exact: true }).selectOption("64");
  await page.getByLabel("Particles", { exact: true }).fill("50000");
  await expect(page.locator(".simulation-bar .muted")).toContainText("50,000");
  await expect(page.locator(".simulation-bottom b")).not.toHaveText("0.0s", {
    timeout: 20000,
  });
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Resume", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Reset simulation", exact: true })
    .click();
  await expect(page.locator(".simulation-bottom b")).toHaveText("0.0s");
  for (let i = 0; i < 8; i++)
    await page
      .getByRole("button", { name: "Step simulation", exact: true })
      .click();
  await expect(page.locator(".simulation-bottom b")).not.toHaveText("0.0s");
  await page.getByLabel("Particles", { exact: true }).fill("1000");
  await page
    .getByLabel("Force calculation", { exact: true })
    .selectOption("exact");
  await page.getByRole("button", { name: "Resume", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Pause", exact: true }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});
test("Canvas fallback renders when GPU contexts are unavailable", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (
      this: HTMLCanvasElement,
      kind: string,
      ...args: unknown[]
    ) {
      if (kind === "webgl" || kind === "webgl2") return null;
      return original.apply(this, [kind, ...args] as Parameters<
        typeof original
      >);
    } as typeof original;
  });
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "Pause", exact: true }),
  ).toBeEnabled();
  await expect(page.locator(".field-footer")).toContainText("Canvas 2D");
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  const bright = await page
    .locator("canvas[aria-label]")
    .evaluate((canvas: HTMLCanvasElement) => {
      const p = canvas
        .getContext("2d")!
        .getImageData(0, 0, canvas.width, canvas.height).data;
      let count = 0;
      for (let i = 0; i < p.length; i += 4) if (p[i + 1] > 100) count++;
      return count;
    });
  expect(bright).toBeGreaterThan(1000);
});

test("GPU draws particle pixels and recovers with Canvas after context loss", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "Pause", exact: true }),
  ).toBeEnabled();
  const footer = page.locator(".field-footer");
  test.skip(
    !(await footer.innerText()).includes("GPU rendering"),
    "WebGL unavailable on this test host",
  );
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  const pixels = await page
    .locator("canvas[data-renderer=webgl]")
    .evaluate((canvas: HTMLCanvasElement) => {
      const gl = canvas.getContext("webgl")!,
        p = new Uint8Array(canvas.width * canvas.height * 4);
      gl.readPixels(
        0,
        0,
        canvas.width,
        canvas.height,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        p,
      );
      let count = 0;
      for (let i = 0; i < p.length; i += 4) if (p[i + 1] > 100) count++;
      return count;
    });
  expect(pixels).toBeGreaterThan(1000);
  await page
    .locator("canvas[data-renderer=webgl]")
    .evaluate((canvas: HTMLCanvasElement) =>
      canvas
        .getContext("webgl")!
        .getExtension("WEBGL_lose_context")!
        .loseContext(),
    );
  await expect(footer).toContainText("Canvas 2D");
  const pixelsAfter = await page
    .locator("canvas[aria-label]")
    .evaluate((canvas: HTMLCanvasElement) => {
      const p = canvas
        .getContext("2d")!
        .getImageData(0, 0, canvas.width, canvas.height).data;
      let count = 0;
      for (let i = 0; i < p.length; i += 4) if (p[i + 1] > 100) count++;
      return count;
    });
  expect(pixelsAfter).toBeGreaterThan(1000);
});
