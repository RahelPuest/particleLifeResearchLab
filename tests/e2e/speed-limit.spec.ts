import { test, expect } from "@playwright/test";

test("speed limit controls persist through settings export and import", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  const toggle = page.getByRole("checkbox", { name: "Soft speed limit" }),
    slider = page.getByLabel("Maximum particle speed", { exact: true });
  await expect(slider).toBeDisabled();
  await toggle.check();
  await expect(slider).toBeEnabled();
  await slider.fill("1.25");
  const downloading = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save settings" }).click();
  const path = await (await downloading).path();
  await toggle.uncheck();
  await expect(slider).toBeDisabled();
  await page.locator("input[type=file]").setInputFiles(path!);
  await expect(toggle).toBeChecked();
  await expect(slider).toHaveValue("1.25");
  await page.getByRole("button", { name: "Step simulation" }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("all GPU integrations apply the same live asymptotic limit as CPU", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  const available = await page.evaluate(
    async () => !!(navigator.gpu && (await navigator.gpu.requestAdapter())),
  );
  if (process.env.WEBGPU_TEST === "1") expect(available).toBe(true);
  test.skip(!available, "No WebGPU adapter");
  const cases = await page.evaluate(async () => {
    const simUrl = "/src/engine/simulation.ts",
      gpuUrl = "/src/engine/gpu-physics.ts";
    const sim = await import(simUrl),
      { GPUPhysics } = await import(gpuUrl),
      engine = await GPUPhysics.create(),
      results = [];
    try {
      for (const solver of [
        "grid-gpu",
        "bvh-gpu",
        "all-pairs-gpu",
        "auto-gpu",
        "fast-gpu",
        "barnes-hut-gpu",
      ]) {
        const base = {
          ...sim.DEFAULT,
          count: 129,
          solver,
          theta: 0,
          neighborBudget: 1024,
        };
        const cpu = sim.createState(base);
        cpu.velocities.fill(3);
        const gpu = structuredClone(cpu);
        engine.load(gpu);
        for (const [enabled, maximum] of [
          [true, 0.5],
          [false, 0.05],
          [true, 0.05],
          [true, 1],
        ] as const) {
          const c = { ...base, speedLimitEnabled: enabled, maxSpeed: maximum };
          await engine.step(c);
          sim.step(cpu, { ...c, solver: "exact" });
          await engine.downloadState(gpu);
          let maxSpeed = 0,
            error = 0;
          for (let i = 0; i < c.count; i++) {
            maxSpeed = Math.max(
              maxSpeed,
              Math.hypot(gpu.velocities[i * 2], gpu.velocities[i * 2 + 1]),
            );
            for (let axis = 0; axis < 2; axis++)
              error = Math.max(
                error,
                Math.abs(
                  cpu.velocities[i * 2 + axis] - gpu.velocities[i * 2 + axis],
                ),
              );
          }
          results.push({ solver, enabled, maximum, maxSpeed, error });
        }
      }
      return results;
    } finally {
      engine.destroy();
    }
  });
  for (const c of cases) {
    expect(c.error, JSON.stringify(c)).toBeLessThan(0.0001);
    if (c.enabled)
      expect(c.maxSpeed, JSON.stringify(c)).toBeLessThan(c.maximum);
    else expect(c.maxSpeed).toBeGreaterThan(c.maximum);
  }
});

test("speed cap adds no force-free drag on any GPU integration", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  const available = await page.evaluate(
    async () => !!(navigator.gpu && (await navigator.gpu.requestAdapter())),
  );
  if (process.env.WEBGPU_TEST === "1") expect(available).toBe(true);
  test.skip(!available, "No WebGPU adapter");
  const rows = await page.evaluate(async () => {
    const simUrl = "/src/engine/simulation.ts",
      gpuUrl = "/src/engine/gpu-physics.ts";
    const sim = await import(simUrl),
      { GPUPhysics } = await import(gpuUrl),
      engine = await GPUPhysics.create(),
      rows = [];
    try {
      for (const solver of [
        "grid-gpu",
        "bvh-gpu",
        "all-pairs-gpu",
        "auto-gpu",
        "fast-gpu",
        "barnes-hut-gpu",
        "mesh-gpu",
      ])
        for (const friction of [0, 4]) {
          const c = {
            ...sim.DEFAULT,
            count: 1,
            solver,
            friction,
            strength: 0,
            speedLimitEnabled: true,
            maxSpeed: 0.5,
          };
          const expected = sim.createState(c);
          expected.velocities.set([0.24, 0.32]);
          const actual = structuredClone(expected);
          engine.load(actual);
          for (let k = 0; k < 20; k++) {
            await engine.step(c, 3);
            for (let j = 0; j < 3; j++)
              sim.step(expected, { ...c, solver: "exact" });
          }
          await engine.downloadState(actual);
          rows.push({
            solver,
            friction,
            error: Math.max(
              ...Array.from(actual.velocities as Float32Array, (v, i) =>
                Math.abs(v - expected.velocities[i]),
              ),
            ),
            speed: Math.hypot(...actual.velocities),
          });
        }
    } finally {
      engine.destroy();
    }
    return rows;
  });
  for (const row of rows) {
    expect(row.error, JSON.stringify(row)).toBeLessThan(0.000001);
    if (row.friction === 0) expect(row.speed).toBeCloseTo(0.4, 6);
  }
});
