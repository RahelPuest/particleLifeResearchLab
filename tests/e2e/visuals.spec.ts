import { test, expect } from "@playwright/test";
import { stableSimTime } from "./helpers";

test("visual controls apply on CPU, persist, and do not advance a paused simulation", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  const time = await stableSimTime(page);
  await page.getByLabel("Visualization", { exact: true }).selectOption("glow");
  await page.getByLabel("Color by", { exact: true }).selectOption("speed");
  await page.getByLabel("Particle size", { exact: true }).fill("2");
  await page.getByLabel("Light intensity", { exact: true }).fill("1.5");
  await page.getByLabel("Motion trails", { exact: true }).check();
  await page.getByLabel("Trail persistence", { exact: true }).fill("0.9");
  const downloading = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save settings" }).click();
  const path = await (await downloading).path();
  await page.getByLabel("Visualization", { exact: true }).selectOption("rings");
  await expect(page.locator(".simulation-bottom b")).toHaveText(time);
  await page.locator("input[type=file]").setInputFiles(path!);
  await expect(page.getByLabel("Visualization", { exact: true })).toHaveValue(
    "glow",
  );
  await expect(page.getByLabel("Color by", { exact: true })).toHaveValue(
    "speed",
  );
  await expect(page.getByLabel("Particle size", { exact: true })).toHaveValue(
    "2",
  );
  await expect(
    page.getByLabel("Trail persistence", { exact: true }),
  ).toHaveValue("0.9");
  await expect(page.getByRole("alert")).toHaveCount(0);
});

for (const backend of ["webgl", "canvas", "webgpu"] as const) {
  test(`visual styles render distinct exported images on ${backend}`, async ({
    page,
  }) => {
    test.setTimeout(90000);
    if (backend === "canvas")
      await page.addInitScript(() => {
        const original = HTMLCanvasElement.prototype.getContext;
        HTMLCanvasElement.prototype.getContext = function (
          this: HTMLCanvasElement,
          kind: string,
          ...args: unknown[]
        ) {
          if (kind === "webgl" || kind === "webgl2") return null;
          return original.apply(this, [kind, ...args] as any);
        } as typeof original;
      });
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto("/");
    await page.getByRole("button", { name: "Pause", exact: true }).click();
    if (backend === "webgpu") {
      const available = await page.evaluate(
        async () => !!(navigator.gpu && (await navigator.gpu.requestAdapter())),
      );
      if (process.env.WEBGPU_TEST === "1") expect(available).toBe(true);
      test.skip(!available, "No WebGPU adapter");
      await page
        .getByLabel("Force calculation", { exact: true })
        .selectOption("mesh-gpu");
      await expect(page.locator(".field-footer")).toContainText(
        "shared particle buffer",
      );
    }
    const samples: string[] = [];
    for (const mode of ["dots", "glow", "rings", "field"]) {
      await page
        .getByLabel("Visualization", { exact: true })
        .selectOption(mode);
      await page
        .getByLabel("Color by", { exact: true })
        .selectOption(mode === "rings" ? "mono" : "species");
      // Allow the worker's bounded display cadence to apply the view before exporting.
      await page.waitForTimeout(120);
      const download = page.waitForEvent("download");
      await page
        .getByRole("button", { name: "Save image", exact: true })
        .click();
      const file = await download;
      const { readFile } = await import("node:fs/promises");
      const bytes = await readFile((await file.path())!);
      expect(bytes.length).toBeGreaterThan(2000);
      samples.push(bytes.toString("base64"));
    }
    expect(new Set(samples).size).toBe(4);
    if (backend === "webgpu") {
      await page
        .getByLabel("Visualization", { exact: true })
        .selectOption("glow");
      await page.getByLabel("Particle size", { exact: true }).fill("1.5");
      await page.locator(".viewport").scrollIntoViewIfNeeded();
      await page.waitForTimeout(150);
      await page.screenshot({ path: "reports/visual-effects.png" });
    }
    await page.getByLabel("Color by", { exact: true }).selectOption("speed");
    await page.getByLabel("Motion trails", { exact: true }).check();
    for (let i = 0; i < 6; i++)
      await page.getByRole("button", { name: "Step simulation" }).click();
    await page.waitForTimeout(150);
    const capture = async () => {
      const downloading = page.waitForEvent("download");
      await page
        .getByRole("button", { name: "Save image", exact: true })
        .click();
      const { readFile } = await import("node:fs/promises");
      return (await readFile((await (await downloading).path())!)).toString(
        "base64",
      );
    };
    const pausedImage = await capture();
    expect(await capture()).toBe(pausedImage);
    await page
      .getByRole("button", { name: "New arrangement", exact: true })
      .click();
    await page.waitForTimeout(150);
    expect(await capture()).not.toBe(pausedImage);
    await expect(page.getByRole("alert")).toHaveCount(0);
    expect(errors).toEqual([]);
  });
}
