import { test, expect } from "@playwright/test";

test("exact GPU solvers preserve directed nonlinear forces across seams and dense cells", async ({
  page,
}, info) => {
  test.setTimeout(180000);
  await page.goto("/");
  const available = await page.evaluate(
    async () => !!(navigator.gpu && (await navigator.gpu.requestAdapter())),
  );
  if (process.env.WEBGPU_TEST === "1") expect(available).toBe(true);
  test.skip(!available, "WebGPU adapter unavailable");
  const results = await page.evaluate(async () => {
    const simUrl = "/src/engine/simulation.ts",
      gpuUrl = "/src/engine/gpu-physics.ts";
    const sim = await import(simUrl);
    const { GPUPhysics } = await import(gpuUrl);
    const engine = await GPUPhysics.create();
    const results = [];
    try {
      for (const solver of [
        "grid-gpu",
        "bvh-gpu",
        "all-pairs-gpu",
        "auto-gpu",
      ]) {
        for (const distribution of ["uniform", "seams", "clump"]) {
          for (const radius of [0.04, 0.13, 0.25]) {
            const c = {
              ...sim.DEFAULT,
              solver,
              count: 257,
              radius,
              matrix: sim.PRESETS["Attract then repel"],
            };
            // Make direction and split asymmetry explicit.
            c.matrix = c.matrix.map((x: any, i: number) => ({
              ...x,
              near: i % 2 ? -0.7 : 0.9,
              far: i % 3 ? 0.6 : -0.8,
              split: 0.15 + (i / 15) * 0.75,
            }));
            const cpu = sim.createState(c);
            if (distribution === "seams")
              for (let i = 0; i < c.count; i++) {
                cpu.positions[i * 2] = i % 2 ? 0.999 : 0.001;
                cpu.positions[i * 2 + 1] = (i % 7) / 7;
              }
            if (distribution === "clump")
              for (let i = 0; i < cpu.positions.length; i++)
                cpu.positions[i] = 0.49 + cpu.positions[i] * 0.02;
            const gpu = structuredClone(cpu);
            engine.load(gpu);
            await engine.step(c, 3);
            for (let k = 0; k < 3; k++)
              sim.step(cpu, { ...c, solver: "exact" });
            await engine.downloadState(gpu);
            let positionError = 0,
              velocityError = 0;
            for (let i = 0; i < gpu.positions.length; i++) {
              const d = Math.abs(cpu.positions[i] - gpu.positions[i]);
              positionError = Math.max(positionError, Math.min(d, 1 - d));
              velocityError = Math.max(
                velocityError,
                Math.abs(cpu.velocities[i] - gpu.velocities[i]),
              );
            }
            results.push({
              solver,
              distribution,
              radius,
              positionError,
              velocityError,
            });
          }
        }
      }
    } finally {
      engine.destroy();
    }
    return results;
  });
  await info.attach("exact-gpu-parity.json", {
    body: JSON.stringify(results, null, 2),
    contentType: "application/json",
  });
  for (const r of results) {
    expect(r.positionError, JSON.stringify(r)).toBeLessThan(0.00005);
    expect(r.velocityError, JSON.stringify(r)).toBeLessThan(0.003);
  }
});

test("GPU parameter updates and backend switches preserve state without reload", async ({
  page,
}) => {
  await page.goto("/");
  const available = await page.evaluate(
    async () => !!(navigator.gpu && (await navigator.gpu.requestAdapter())),
  );
  test.skip(!available, "No GPU adapter");
  const result = await page.evaluate(async () => {
    const simUrl = "/src/engine/simulation.ts",
      gpuUrl = "/src/engine/gpu-physics.ts";
    const sim = await import(simUrl),
      { GPUPhysics } = await import(gpuUrl),
      engine = await GPUPhysics.create();
    try {
      const c = {
        ...sim.DEFAULT,
        count: 4097,
        solver: "grid-gpu",
        strength: 0.5,
      };
      const cpu = sim.createState(c),
        gpu = structuredClone(cpu);
      engine.load(gpu);
      for (const [solver, radius, friction] of [
        ["grid-gpu", 0.04, 8],
        ["bvh-gpu", 0.25, 2],
        ["all-pairs-gpu", 0.13, 4],
        ["auto-gpu", 0.13, 4],
      ] as const) {
        const next = {
          ...c,
          solver,
          radius,
          friction,
          matrix: sim.PRESETS["Repel then attract"],
        };
        await engine.step(next);
        sim.step(cpu, { ...next, solver: "exact" });
      }
      await engine.downloadState(gpu);
      let error = 0;
      for (let i = 0; i < gpu.velocities.length; i++)
        error = Math.max(
          error,
          Math.abs(cpu.velocities[i] - gpu.velocities[i]),
        );
      return { error, tuning: engine.tuning };
    } finally {
      engine.destroy();
    }
  });
  expect(result.error).toBeLessThan(0.003);
  expect(result.tuning.length).toBeGreaterThanOrEqual(3);
});

test("GPU sampling is exact when its budget covers candidates and scales to 50000", async ({
  page,
}) => {
  await page.goto("/");
  const available = await page.evaluate(
    async () => !!(navigator.gpu && (await navigator.gpu.requestAdapter())),
  );
  test.skip(!available, "No GPU adapter");
  const result = await page.evaluate(async () => {
    const simUrl = "/src/engine/simulation.ts",
      gpuUrl = "/src/engine/gpu-physics.ts";
    const sim = await import(simUrl),
      { GPUPhysics } = await import(gpuUrl),
      engine = await GPUPhysics.create();
    try {
      const c = {
          ...sim.DEFAULT,
          count: 257,
          solver: "fast-gpu",
          neighborBudget: 1024,
          radius: 0.25,
        },
        cpu = sim.createState(c),
        gpu = structuredClone(cpu);
      engine.load(gpu);
      await engine.step(c, 3);
      for (let k = 0; k < 3; k++) sim.step(cpu, { ...c, solver: "exact" });
      await engine.downloadState(gpu);
      let error = 0;
      for (let i = 0; i < gpu.velocities.length; i++)
        error = Math.max(
          error,
          Math.abs(cpu.velocities[i] - gpu.velocities[i]),
        );
      const large = { ...c, count: 50000, neighborBudget: 128 },
        state = sim.createState(large);
      for (let i = 0; i < state.positions.length; i++)
        state.positions[i] = 0.4 + state.positions[i] * 0.2;
      engine.load(state);
      const start = performance.now();
      await engine.step(large, 3);
      await engine.downloadState(state);
      return {
        error,
        largeBatchAndReadbackMs: performance.now() - start,
        finite: Array.from(state.positions as Float32Array).every(
          (x) => Number.isFinite(x) && x >= 0 && x < 1,
        ),
        moving: Array.from(state.velocities as Float32Array).some(
          (x) => Math.abs(x) > 0.001,
        ),
      };
    } finally {
      engine.destroy();
    }
  });
  expect(result.error).toBeLessThan(0.003);
  expect(result.finite).toBe(true);
  expect(result.moving).toBe(true);
});
