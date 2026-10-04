import { writeFileSync } from "node:fs";
import { test, expect } from "@playwright/test";

test("Barnes–Hut controls and exact CPU mode survive export/import", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await page
    .getByLabel("Force calculation", { exact: true })
    .selectOption("barnes-hut");
  await expect(page.getByLabel("Physics backend", { exact: true })).toHaveText(
    "CPU · Barnes–Hut",
  );
  await page.getByLabel("Opening angle", { exact: true }).fill("0");
  await page.getByRole("button", { name: "Reset simulation" }).click();
  for (let i = 0; i < 6; i++)
    await page.getByRole("button", { name: "Step simulation" }).click();
  await expect(page.locator(".simulation-bottom b")).not.toHaveText("0.0s");
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save settings" }).click();
  const path = await (await download).path();
  await page
    .getByLabel("Force calculation", { exact: true })
    .selectOption("exact");
  await page.locator("input[type=file]").setInputFiles(path!);
  await expect(
    page.getByLabel("Force calculation", { exact: true }),
  ).toHaveValue("barnes-hut");
  await expect(page.getByLabel("Opening angle", { exact: true })).toHaveValue(
    "0",
  );
});

test("WebGPU runs real tree construction, forces and integration", async ({
  page,
}, testInfo) => {
  await page.goto("/");
  const available = await page.evaluate(
    async () => !!(navigator.gpu && (await navigator.gpu.requestAdapter())),
  );
  if (process.env.WEBGPU_TEST === "1") expect(available).toBe(true);
  test.skip(!available, "No WebGPU adapter on this test host");
  const result = await page.evaluate(async () => {
    const simUrl = "/src/engine/simulation.ts",
      gpuUrl = "/src/engine/gpu-physics.ts",
      treeUrl = "/src/engine/barnes-hut.ts";
    const sim = await import(simUrl),
      { GPUPhysics } = await import(gpuUrl),
      { BarnesHutTree } = await import(treeUrl);
    const engine = await GPUPhysics.create();
    const cases = [];
    try {
      for (const theta of [0, 0.6])
        for (const distribution of ["uniform", "seams", "clustered"]) {
          const c = {
            ...sim.DEFAULT,
            count: distribution === "seams" ? 1001 : 1000,
            solver: "barnes-hut",
            theta,
            radius: 0.25,
            matrix: sim.PRESETS["Attract then repel"],
          };
          const cpu = sim.createState(c);
          if (distribution === "seams")
            for (let i = 0; i < 100; i++) {
              cpu.positions[i * 2] = i % 2 ? 0.999 : 0.001;
              cpu.positions[i * 2 + 1] = 0.3 + i * 0.003;
            }
          if (distribution === "clustered")
            for (let i = 0; i < cpu.positions.length; i++)
              cpu.positions[i] = 0.4 + cpu.positions[i] * 0.2;
          const gpu = structuredClone(cpu);
          engine.load(gpu);
          const initialDisplay = new Float32Array(c.count * 2);
          await engine.readPositions(initialDisplay);
          for (let i = 0; i < initialDisplay.length; i++)
            if (initialDisplay[i] !== gpu.positions[i])
              throw new Error(
                "Paused GPU initialization changed particle positions",
              );
          const start = performance.now();
          await engine.step(c);
          const elapsed = performance.now() - start;
          const display = new Float32Array(c.count * 2);
          await engine.readPositions(display);
          await engine.downloadState(gpu);
          sim.step(cpu, c);
          let positionError = 0,
            velocityError = 0,
            displayError = 0;
          for (let i = 0; i < display.length; i++) {
            positionError = Math.max(
              positionError,
              Math.abs(cpu.positions[i] - gpu.positions[i]),
            );
            velocityError = Math.max(
              velocityError,
              Math.abs(cpu.velocities[i] - gpu.velocities[i]),
            );
            displayError = Math.max(
              displayError,
              Math.abs(display[i] - gpu.positions[i]),
            );
          }
          const tree = new BarnesHutTree(c.count);
          tree.calculate(cpu, c);
          cases.push({
            theta,
            distribution,
            positionError,
            velocityError,
            displayError,
            gpuStepMs: elapsed,
            aggregated: tree.aggregated,
          });
          // A second step proves the display scratch has not corrupted the next tree rebuild.
          await engine.step(c);
          await engine.downloadState(gpu);
          for (const x of gpu.positions)
            if (!Number.isFinite(x) || x < 0 || x >= 1)
              throw new Error("Invalid GPU position");
        }
      const c = { ...sim.DEFAULT, count: 50000, theta: 0.6 };
      const s = sim.createState(c);
      engine.load(s);
      const start = performance.now();
      await engine.step(c);
      await engine.downloadState(s);
      const largeStepAndReadbackMs = performance.now() - start;
      const timings = [];
      for (const count of [1800, 5000, 10000, 50000]) {
        const config = { ...sim.DEFAULT, count, theta: 0.6 };
        engine.load(sim.createState(config));
        await engine.step(config);
        await engine.step(config);
        const times = [];
        for (let k = 0; k < 5; k++) {
          const start = performance.now();
          await engine.step(config);
          times.push(performance.now() - start);
        }
        times.sort((a, b) => a - b);
        const positions = new Float32Array(count * 2),
          start = performance.now();
        await engine.readPositions(positions);
        timings.push({
          count,
          medianStepMs: times[2],
          displayReadbackMs: performance.now() - start,
        });
      }
      const adapter = await navigator.gpu.requestAdapter();
      return {
        adapter: adapter
          ? {
              vendor: adapter.info.vendor,
              architecture: adapter.info.architecture,
              description: adapter.info.description,
            }
          : null,
        timings,
        cases,
        largeStepAndReadbackMs,
        largeFinite: Array.from(s.positions as Float32Array).every(
          (x) => Number.isFinite(x) && x >= 0 && x < 1,
        ),
      };
    } finally {
      engine.destroy();
    }
  });
  if (process.env.RECORD_GPU_BENCHMARK === "1")
    writeFileSync(
      "reports/barnes-hut-gpu.json",
      JSON.stringify(
        {
          date: new Date().toISOString(),
          method:
            "Chromium WebGPU/Metal test run. CPU wall time includes GPU submission and completion; median of 5 physics steps after 2 warmups. Separate display-only readback timing. Fixed seed, theta 0.6, radius 0.13. Not browser FPS.",
          ...result,
        },
        null,
        2,
      ),
    );
  await testInfo.attach("gpu-numerical-comparison.json", {
    body: JSON.stringify(result, null, 2),
    contentType: "application/json",
  });
  for (const c of result.cases) {
    expect(c.positionError).toBeLessThan(0.0001);
    expect(c.velocityError).toBeLessThan(0.005);
    expect(c.displayError).toBe(0);
  }
  expect(result.cases.some((c) => c.theta > 0 && c.aggregated > 0)).toBe(true);
  expect(result.largeFinite).toBe(true);
  await page
    .getByLabel("Force calculation", { exact: true })
    .selectOption("barnes-hut-gpu");
  await expect(page.getByLabel("Physics backend", { exact: true })).toHaveText(
    "WebGPU · Barnes–Hut",
    { timeout: 30000 },
  );
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await page.getByRole("button", { name: "Reset simulation" }).click();
  for (let i = 0; i < 6; i++)
    await page.getByRole("button", { name: "Step simulation" }).click();
  await expect(page.locator(".simulation-bottom b")).not.toHaveText("0.0s");
  await page
    .getByLabel("Force calculation", { exact: true })
    .selectOption("exact");
  await expect(page.getByLabel("Physics backend", { exact: true })).toHaveText(
    "CPU · exact grid",
  );
  await page.getByRole("button", { name: "Resume", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Pause", exact: true }),
  ).toBeVisible();
});

test("unavailable WebGPU visibly falls back to CPU Barnes–Hut", async ({
  page,
}) => {
  await page.route("**/src/engine/gpu-physics.ts", (route) =>
    route.fulfill({
      contentType: "application/javascript",
      body: 'export class GPUPhysics { static async create(){ throw new Error("WebGPU unavailable in fallback test."); } }',
    }),
  );
  await page.goto("/");
  await page
    .getByLabel("Force calculation", { exact: true })
    .selectOption("barnes-hut-gpu");
  await expect(page.getByLabel("Physics backend", { exact: true })).toHaveText(
    "CPU · Barnes–Hut",
  );
  await expect(page.locator(".backend-notice")).toContainText(
    "Using CPU Barnes–Hut",
  );
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await page.getByRole("button", { name: "Reset simulation" }).click();
  for (let i = 0; i < 6; i++)
    await page.getByRole("button", { name: "Step simulation" }).click();
  await expect(page.locator(".simulation-bottom b")).not.toHaveText("0.0s");
});

test("WebGPU device loss falls back without freezing controls", async ({
  page,
}) => {
  await page.route("**/src/engine/gpu-physics.ts", async (route) => {
    const response = await route.fetch();
    const original = await response.text();
    await route.fulfill({
      response,
      body:
        original +
        "\nconst savedStep=GPUPhysics.prototype.step; GPUPhysics.prototype.step=async function(c){this.testStepCount=(this.testStepCount||0)+1;if(this.testStepCount===2){this.destroy();await Promise.resolve();}return savedStep.call(this,c);};",
    });
  });
  await page.goto("/");
  const available = await page.evaluate(
    async () => !!(navigator.gpu && (await navigator.gpu.requestAdapter())),
  );
  test.skip(!available, "No WebGPU adapter on this test host");
  await page
    .getByLabel("Force calculation", { exact: true })
    .selectOption("barnes-hut-gpu");
  await expect(page.locator(".backend-notice")).toContainText(
    "velocities reset",
    { timeout: 30000 },
  );
  await expect(page.getByLabel("Physics backend", { exact: true })).toHaveText(
    "CPU · Barnes–Hut",
  );
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Step simulation" }),
  ).toBeEnabled();
});
