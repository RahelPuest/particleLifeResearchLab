import { writeFileSync } from "node:fs";
import { test, expect } from "@playwright/test";

test("record GPU tile and sampling comparison", async ({ page }) => {
  test.skip(process.env.RECORD_GPU_TUNING !== "1", "Opt-in benchmark");
  test.setTimeout(180000);
  await page.goto("/");
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  const result = await page.evaluate(async () => {
    const simUrl = "/src/engine/simulation.ts",
      gpuUrl = "/src/engine/gpu-physics.ts";
    const sim = await import(simUrl),
      { GPUPhysics } = await import(gpuUrl),
      engine = await GPUPhysics.create(),
      rows = [];
    const adapter = await navigator.gpu.requestAdapter();
    try {
      for (const count of [1800, 10000, 50000])
        for (const distribution of ["uniform", "clump"]) {
          const c = { ...sim.DEFAULT, count, neighborBudget: 128 },
            state = sim.createState(c);
          if (distribution === "clump")
            for (let i = 0; i < state.positions.length; i++)
              state.positions[i] = 0.4 + state.positions[i] * 0.2;
          for (const [solver, tile] of [
            ["grid-gpu", 32],
            ["grid-gpu", 64],
            ["grid-gpu", 128],
            ["bvh-gpu", 64],
            ["fast-gpu", 64],
          ] as const) {
            const times = [];
            for (let k = 0; k < 4; k++) {
              engine.load(state);
              await engine.synchronize();
              const start = performance.now();
              await engine.step({ ...c, solver }, 1, false, tile);
              if (k) times.push(performance.now() - start);
            }
            times.sort((a, b) => a - b);
            engine.load(state);
            await engine.step({ ...c, solver }, 1, true, tile);
            rows.push({
              count,
              distribution,
              solver,
              tile,
              approximate: solver === "fast-gpu",
              medianMs: times[1],
              gpuPhasesMs: engine.lastProfile,
            });
          }
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
    } finally {
      engine.destroy();
    }
  });
  writeFileSync(
    "reports/gpu-tuning.json",
    JSON.stringify(
      {
        date: new Date().toISOString(),
        method:
          "Frozen seed-42 state per repetition; radius 0.13. One warmup and three measured steps; median submission/completion wall time excluding initial upload wait and rendering. Phase timestamps separately. Sampled mode uses 128 candidates and is not equivalent to exact modes.",
        ...result,
      },
      null,
      2,
    ),
  );
  expect(result.rows).toHaveLength(30);
});
