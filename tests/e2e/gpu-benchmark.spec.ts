import { writeFileSync } from "node:fs";
import { test, expect } from "@playwright/test";

test("record matched-state GPU optimization benchmarks", async ({ page }) => {
  test.skip(
    process.env.RECORD_OPTIMIZATION_BENCHMARK !== "1",
    "Opt-in performance experiment",
  );
  test.setTimeout(240000);
  await page.goto("/");
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  const result = await page.evaluate(async () => {
    const simUrl = "/src/engine/simulation.ts",
      gpuUrl = "/src/engine/gpu-physics.ts";
    const sim = await import(simUrl),
      { GPUPhysics } = await import(gpuUrl),
      engine = await GPUPhysics.create();
    const rows = [];
    const adapter = await navigator.gpu.requestAdapter();
    try {
      for (const count of [1800, 5000, 10000, 50000]) {
        const config = { ...sim.DEFAULT, count, radius: 0.13 };
        const uniform = sim.createState(config);
        // One shared, evolved snapshot for every backend, not independent trajectories.
        engine.load(uniform);
        for (let k = 0; k < 60; k++)
          await engine.step({ ...config, solver: "grid-gpu" }, 3);
        const evolved = structuredClone(uniform);
        await engine.downloadState(evolved);
        const clump = structuredClone(uniform);
        for (let i = 0; i < clump.positions.length; i++)
          clump.positions[i] = 0.4 + clump.positions[i] * 0.2;
        for (const [distribution, snapshot] of [
          ["uniform", uniform],
          ["evolved-180-steps", evolved],
          ["clump", clump],
        ] as const) {
          for (const solver of [
            "exact",
            "grid-gpu",
            "bvh-gpu",
            "all-pairs-gpu",
            "barnes-hut-gpu",
          ]) {
            const c = { ...config, solver },
              times = [];
            let phases = null;
            for (let rep = 0; rep < 4; rep++) {
              const s = structuredClone(snapshot);
              if (solver === "exact") {
                const start = performance.now();
                sim.step(s, c);
                if (rep) times.push(performance.now() - start);
              } else {
                engine.load(s);
                await engine.synchronize();
                const start = performance.now();
                await engine.step(c);
                if (rep) times.push(performance.now() - start);
              }
            }
            if (solver !== "exact") {
              engine.load(snapshot);
              await engine.step(c, 1, true);
              phases = engine.lastProfile;
            }
            times.sort((a, b) => a - b);
            rows.push({
              count,
              distribution,
              solver,
              medianMs: times[1],
              maxMs: times[2],
              gpuPhasesMs: phases,
            });
          }
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
    "reports/gpu-optimizations.json",
    JSON.stringify(
      {
        date: new Date().toISOString(),
        method:
          "Same frozen state per backend and repetition. One warmup and three wall-time samples, excluding initial upload completion. Includes submission/completion, excludes rendering. GPU pass timestamps recorded separately if supported. Evolved snapshot uses 180 exact GPU steps. Barnes–Hut theta=0.6 is approximate; other modes exact. Maximum of three samples is not p95.",
        ...result,
      },
      null,
      2,
    ),
  );
  expect(result.rows).toHaveLength(60);
});
