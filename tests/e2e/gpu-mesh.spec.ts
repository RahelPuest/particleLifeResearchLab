import { test, expect } from "@playwright/test";
import { writeFileSync } from "node:fs";

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  const available = await page.evaluate(
    async () => !!(navigator.gpu && (await navigator.gpu.requestAdapter())),
  );
  if (process.env.WEBGPU_TEST === "1") expect(available).toBe(true);
  test.skip(!available, "No WebGPU adapter");
});

test("mesh FFT preserves directed kernels on grid nodes and updates cached kernels", async ({
  page,
}, info) => {
  test.setTimeout(180000);
  const results = await page.evaluate(async () => {
    const simUrl = "/src/engine/simulation.ts",
      gpuUrl = "/src/engine/gpu-physics.ts";
    const sim = await import(simUrl),
      { GPUPhysics } = await import(gpuUrl),
      engine = await GPUPhysics.create();
    const results = [];
    try {
      for (const meshResolution of [64, 128, 256]) {
        const c = {
          ...sim.DEFAULT,
          count: 257,
          solver: "mesh-gpu",
          meshResolution,
          friction: 0,
        };
        const initial = sim.createState(c);
        for (let i = 0; i < initial.positions.length; i++)
          initial.positions[i] =
            Math.floor(initial.positions[i] * meshResolution) / meshResolution;
        // A zero-strength step leaves this snapshot intact, allowing cache invalidation without reload.
        engine.load(initial);
        await engine.step({ ...c, strength: 0 });
        for (const radius of [0.04, 0.13, 0.25]) {
          const matrix = c.matrix.map((_: unknown, i: number) => ({
            near: i % 2 ? -0.7 : 0.9,
            far: i % 3 ? 0.6 : -0.8,
            split: 0.15 + (i / 15) * 0.75,
          }));
          const next = { ...c, radius, matrix };
          // Reload identical node-aligned inputs; warm the default kernels before
          // changing the radius/matrix to exercise cache invalidation.
          if (radius !== 0.04) {
            engine.load(initial);
            await engine.step({ ...c, strength: 0 });
          }
          const cpu = structuredClone(initial),
            gpu = structuredClone(initial);
          sim.step(cpu, { ...next, solver: "exact" });
          await engine.step(next);
          await engine.downloadState(gpu);
          const error = Math.max(
            ...Array.from(gpu.velocities as Float32Array, (v, i) =>
              Math.abs(v - cpu.velocities[i]),
            ),
          );
          results.push({ meshResolution, radius, error });
        }
      }
    } finally {
      engine.destroy();
    }
    return results;
  });
  await info.attach("mesh-grid-parity.json", {
    body: JSON.stringify(results, null, 2),
    contentType: "application/json",
  });
  for (const result of results)
    expect(result.error, JSON.stringify(result)).toBeLessThan(0.00003);
});

test("mesh core is exact across seams, excludes self force, and honors the live speed limit", async ({
  page,
}) => {
  const results = await page.evaluate(async () => {
    const simUrl = "/src/engine/simulation.ts",
      gpuUrl = "/src/engine/gpu-physics.ts";
    const sim = await import(simUrl),
      { GPUPhysics } = await import(gpuUrl),
      engine = await GPUPhysics.create();
    const results = [];
    try {
      for (const count of [1, 129]) {
        const c = {
          ...sim.DEFAULT,
          count,
          solver: "mesh-gpu",
          matrix: sim.DEFAULT.matrix.map((x: any) => ({
            ...x,
            near: 0,
            far: 0,
          })),
        };
        const gpu = sim.createState(c);
        for (let i = 0; i < gpu.positions.length; i++)
          gpu.positions[i] = (0.997 + gpu.positions[i] * 0.006) % 1;
        const cpu = structuredClone(gpu);
        engine.load(gpu);
        for (const [speedLimitEnabled, maxSpeed] of [
          [false, 0.5],
          [true, 0.05],
          [true, 1],
        ] as const) {
          const next = { ...c, speedLimitEnabled, maxSpeed };
          await engine.step(next);
          sim.step(cpu, { ...next, solver: "exact" });
          await engine.downloadState(gpu);
          const error = Math.max(
            ...Array.from(gpu.velocities as Float32Array, (v, i) =>
              Math.abs(v - cpu.velocities[i]),
            ),
          );
          let maximum = 0;
          for (let i = 0; i < count; i++)
            maximum = Math.max(
              maximum,
              Math.hypot(gpu.velocities[i * 2], gpu.velocities[i * 2 + 1]),
            );
          results.push({ count, error, speedLimitEnabled, maxSpeed, maximum });
        }
      }
      // With all outer curves nonzero, a lone off-grid particle still must not accelerate itself.
      const c = { ...sim.DEFAULT, count: 1, solver: "mesh-gpu" },
        state = sim.createState(c);
      engine.load(state);
      await engine.step(c, 3);
      await engine.downloadState(state);
      results.push({
        count: 1,
        error: Math.max(
          ...Array.from(state.velocities as Float32Array, Math.abs),
        ),
        speedLimitEnabled: false,
        maxSpeed: 0,
        maximum: 0,
      });
    } finally {
      engine.destroy();
    }
    return results;
  });
  for (const r of results) {
    expect(r.error, JSON.stringify(r)).toBeLessThan(0.0001);
    if (r.speedLimitEnabled) expect(r.maximum).toBeLessThan(r.maxSpeed);
  }
});

test("mesh refinement reduces off-grid force error, including nonreciprocal seam interactions", async ({
  page,
}, info) => {
  test.setTimeout(180000);
  const rows = await page.evaluate(async () => {
    const simUrl = "/src/engine/simulation.ts",
      gpuUrl = "/src/engine/gpu-physics.ts";
    const sim = await import(simUrl),
      { GPUPhysics } = await import(gpuUrl),
      engine = await GPUPhysics.create(),
      rows = [];
    try {
      for (const distribution of ["uniform", "seam-clump"]) {
        const c = {
          ...sim.DEFAULT,
          count: 2049,
          matrix: sim.DEFAULT.matrix.map((_: unknown, i: number) => ({
            near: i % 2 ? -0.7 : 0.9,
            far: i % 3 ? 0.6 : -0.8,
            split: 0.15 + (i / 15) * 0.75,
          })),
        };
        const initial = sim.createState(c);
        if (distribution === "seam-clump")
          for (let i = 0; i < initial.positions.length; i++)
            initial.positions[i] = (0.9 + initial.positions[i] * 0.2) % 1;
        const cpu = structuredClone(initial);
        sim.step(cpu, { ...c, solver: "exact" });
        for (const meshResolution of [64, 128, 256]) {
          const gpu = structuredClone(initial);
          engine.load(gpu);
          await engine.step({ ...c, solver: "mesh-gpu", meshResolution });
          await engine.downloadState(gpu);
          let error2 = 0,
            signal2 = 0;
          for (let i = 0; i < gpu.velocities.length; i++) {
            error2 += (gpu.velocities[i] - cpu.velocities[i]) ** 2;
            signal2 += cpu.velocities[i] ** 2;
          }
          rows.push({
            distribution,
            meshResolution,
            relativeRms: Math.sqrt(error2 / signal2),
          });
        }
      }
    } finally {
      engine.destroy();
    }
    return rows;
  });
  await info.attach("mesh-refinement.json", {
    body: JSON.stringify(rows, null, 2),
    contentType: "application/json",
  });
  for (const distribution of ["uniform", "seam-clump"]) {
    const r = rows.filter((r) => r.distribution === distribution);
    expect(r[1].relativeRms).toBeLessThan(r[0].relativeRms);
    expect(r[2].relativeRms).toBeLessThan(r[1].relativeRms);
    expect(r[2].relativeRms).toBeLessThan(0.07);
  }
});

test("mesh controls switch live and round-trip settings", async ({ page }) => {
  await page
    .getByLabel("Force calculation", { exact: true })
    .selectOption("mesh-gpu");
  await expect(page.getByLabel("Physics backend")).toContainText(
    "particle mesh",
  );
  await page
    .getByLabel("Field resolution", { exact: true })
    .selectOption("256");
  await page.getByRole("button", { name: "Step simulation" }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  const downloading = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save settings" }).click();
  const path = await (await downloading).path();
  await page
    .getByLabel("Force calculation", { exact: true })
    .selectOption("exact");
  await page.locator("input[type=file]").setInputFiles(path!);
  await expect(
    page.getByLabel("Force calculation", { exact: true }),
  ).toHaveValue("mesh-gpu");
  await expect(
    page.getByLabel("Field resolution", { exact: true }),
  ).toHaveValue("256");
  await page.getByLabel("Field resolution", { exact: true }).selectOption("64");
  await page.getByRole("button", { name: "Step simulation" }).click();
  await expect(page.getByLabel("Physics backend")).toContainText(
    "particle mesh",
  );
});

test("record matched particle mesh timings and error", async ({ page }) => {
  test.skip(process.env.RECORD_MESH !== "1", "Opt-in benchmark");
  test.setTimeout(240000);
  const result = await page.evaluate(async () => {
    const simUrl = "/src/engine/simulation.ts",
      gpuUrl = "/src/engine/gpu-physics.ts";
    const sim = await import(simUrl),
      { GPUPhysics } = await import(gpuUrl),
      engine = await GPUPhysics.create(),
      rows = [];
    const adapter = await navigator.gpu.requestAdapter();
    try {
      for (const count of [10000, 50000])
        for (const distribution of ["uniform", "clump"]) {
          const c = { ...sim.DEFAULT, count },
            state = sim.createState(c);
          if (distribution === "clump")
            for (let i = 0; i < state.positions.length; i++)
              state.positions[i] = 0.4 + state.positions[i] * 0.2;
          let reference: Float32Array | undefined;
          for (const [solver, meshResolution] of [
            ["grid-gpu", 128],
            ["mesh-gpu", 64],
            ["mesh-gpu", 128],
            ["mesh-gpu", 256],
          ] as const) {
            const next = { ...c, solver, meshResolution },
              times = [];
            const out = structuredClone(state);
            for (let repeat = 0; repeat < 6; repeat++) {
              engine.load(state);
              // Cache kernels and warm pipelines without moving the identical initial state.
              await engine.step({ ...next, strength: 0 });
              const start = performance.now();
              await engine.step(next);
              const elapsed = performance.now() - start;
              if (repeat) times.push(elapsed);
            }
            await engine.downloadState(out);
            if (!reference) reference = out.velocities.slice();
            let error2 = 0,
              signal2 = 0;
            for (let i = 0; i < out.velocities.length; i++) {
              error2 += (out.velocities[i] - reference![i]) ** 2;
              signal2 += reference![i] ** 2;
            }
            engine.load(state);
            await engine.step({ ...next, strength: 0 });
            await engine.step(next, 1, true);
            times.sort((a, b) => a - b);
            rows.push({
              count,
              distribution,
              solver,
              meshResolution,
              medianMs: times[2],
              samplesMs: times,
              relativeRms: Math.sqrt(error2 / signal2),
              gpuPhasesMs: engine.lastProfile,
            });
          }
        }
    } finally {
      engine.destroy();
    }
    return {
      adapter: adapter
        ? {
            vendor: adapter.info.vendor,
            architecture: adapter.info.architecture,
          }
        : null,
      rows,
    };
  });
  writeFileSync(
    "reports/gpu-mesh.json",
    JSON.stringify(
      {
        note: "Frozen identical seeded inputs. Warm pipelines and cached kernels. Five wall-time samples, GPU compute plus submission/fence, excludes rendering and readback. One-step velocity RMS relative to exact GPU grid; not a long-term trajectory bound.",
        ...result,
      },
      null,
      2,
    ),
  );
  for (const row of result.rows)
    expect(Number.isFinite(row.relativeRms)).toBe(true);
});

test("mesh initialization failure visibly falls back to the exact CPU grid", async ({
  page,
}) => {
  await page.route("**/src/engine/gpu-physics.ts", (route) =>
    route.fulfill({
      contentType: "application/javascript",
      body: 'export class GPUPhysics { static async create(){ throw new Error("WebGPU unavailable in mesh test."); } }',
    }),
  );
  await page.goto("/");
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await page
    .getByLabel("Force calculation", { exact: true })
    .selectOption("mesh-gpu");
  await expect(page.getByLabel("Physics backend")).toHaveText(
    "CPU · exact grid",
  );
  await expect(page.locator(".backend-notice")).toContainText(
    "Using CPU exact grid",
  );
  await page.getByRole("button", { name: "Reset simulation" }).click();
  for (let k = 0; k < 6; k++)
    await page.getByRole("button", { name: "Step simulation" }).click();
  await expect(page.locator(".simulation-bottom b")).not.toHaveText("0.0s");
});
