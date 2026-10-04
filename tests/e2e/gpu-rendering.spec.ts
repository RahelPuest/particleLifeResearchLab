import { test, expect } from "@playwright/test";

test("GPU resident rendering supports controls, trails, export and CPU switches", async ({
  page,
}) => {
  await page.goto("/");
  const available = await page.evaluate(
    async () => !!(navigator.gpu && (await navigator.gpu.requestAdapter())),
  );
  if (process.env.WEBGPU_TEST === "1") expect(available).toBe(true);
  test.skip(!available, "No GPU adapter");
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  for (const [solver, label] of [
    ["grid-gpu", "WebGPU · exact tiled grid"],
    ["bvh-gpu", "WebGPU · exact BVH"],
    ["all-pairs-gpu", "WebGPU · exact all-pairs"],
    ["fast-gpu", "WebGPU · sampled"],
    ["mesh-gpu", "WebGPU · particle mesh (approximate)"],
  ]) {
    await page
      .getByLabel("Force calculation", { exact: true })
      .selectOption(solver);
    await expect(
      page.getByLabel("Physics backend", { exact: true }),
    ).toHaveText(label, { timeout: 30000 });
    await expect(page.locator(".field-footer")).toContainText(
      "shared particle buffer",
    );
    await page.getByRole("button", { name: "Step simulation" }).click();
    await page.getByRole("button", { name: "Zoom in", exact: true }).click();
    await page.getByRole("button", { name: "Reset view" }).click();
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "Save image", exact: true }).click();
    const file = await download;
    expect(file.suggestedFilename()).toBe("particle-life.png");
    await page.getByRole("button", { name: "Reset simulation" }).click();
  }
  await page
    .getByLabel("Force calculation", { exact: true })
    .selectOption("exact");
  await expect(page.getByLabel("Physics backend", { exact: true })).toHaveText(
    "CPU · exact grid",
  );
  await expect(page.locator(".field-footer")).not.toContainText(
    "shared particle buffer",
  );
  expect(errors).toEqual([]);
});

test("direct GPU buffer renderer produces colored particles and a valid screenshot", async ({
  page,
}) => {
  await page.goto("/");
  const available = await page.evaluate(
    async () => !!(navigator.gpu && (await navigator.gpu.requestAdapter())),
  );
  test.skip(!available, "No GPU adapter");
  const result = await page.evaluate(async () => {
    const gpuUrl = "/src/engine/gpu-physics.ts",
      simUrl = "/src/engine/simulation.ts";
    const { GPUPhysics } = await import(gpuUrl),
      sim = await import(simUrl),
      engine = await GPUPhysics.create();
    try {
      const c = { ...sim.DEFAULT, count: 100, solver: "grid-gpu" };
      engine.load(sim.createState(c));
      engine.attachCanvas(new OffscreenCanvas(512, 512));
      const view = {
        width: 512,
        height: 512,
        dpr: 1,
        side: 440,
        left: 36,
        top: 36,
        zoom: 1,
        trails: false,
      };
      engine.render(view, false);
      const blob = await engine.image();
      const image = await createImageBitmap(blob);
      const canvas = new OffscreenCanvas(512, 512),
        ctx = canvas.getContext("2d")!;
      ctx.drawImage(image, 0, 0);
      image.close();
      const data = ctx.getImageData(0, 0, 512, 512).data;
      let colored = 0;
      for (let i = 0; i < data.length; i += 4)
        if (Math.max(data[i], data[i + 1], data[i + 2]) > 100) colored++;
      await engine.step(c, 2, true);
      engine.render({ ...view, trails: true }, true);
      await engine.image();
      return { colored, size: blob.size, profile: engine.lastProfile };
    } finally {
      engine.destroy();
    }
  });
  expect(result.colored).toBeGreaterThan(100);
  expect(result.size).toBeGreaterThan(1000);
  if (result.profile) {
    expect(result.profile.grid).toBeGreaterThanOrEqual(0);
    expect(Object.keys(result.profile)).toContain("scatter");
  }
});
