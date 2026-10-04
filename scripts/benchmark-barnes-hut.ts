import { performance } from "node:perf_hooks";
import { writeFileSync } from "node:fs";
import { BarnesHutTree } from "../src/engine/barnes-hut";
import { DEFAULT, PRESETS, createState, step } from "../src/engine/simulation";
const results = [];
for (const count of [1800, 5000, 10000])
  for (const distribution of ["uniform", "clustered"]) {
    const c = {
        ...DEFAULT,
        count,
        radius: 0.13,
        matrix: PRESETS["Attract then repel"],
      },
      initial = createState(c);
    if (distribution === "clustered")
      for (let k = 0; k < initial.positions.length; k++)
        initial.positions[k] = 0.35 + initial.positions[k] * 0.3;
    const tree = new BarnesHutTree(count);
    const exact = tree.calculate(initial, { ...c, theta: 0 }).slice();
    for (const theta of [0.3, 0.6, 1]) {
      const approx = tree.calculate(initial, { ...c, theta });
      let numerator = 0,
        denominator = 0,
        maxAbsError = 0;
      for (let k = 0; k < exact.length; k++) {
        numerator += (approx[k] - exact[k]) ** 2;
        denominator += exact[k] ** 2;
        maxAbsError = Math.max(maxAbsError, Math.abs(approx[k] - exact[k]));
      }
      const aggregated = tree.aggregated,
        directPairs = tree.directPairs;
      const state = structuredClone(initial),
        config = { ...c, theta, solver: "barnes-hut" as const };
      step(state, config);
      const times = [];
      for (let j = 0; j < 3; j++) {
        const start = performance.now();
        step(state, config);
        times.push(performance.now() - start);
      }
      times.sort((a, b) => a - b);
      const row = {
        count,
        distribution,
        theta,
        relativeRmsForceError: Math.sqrt(numerator / (denominator || 1)),
        maxAbsForceError: maxAbsError,
        aggregatedSpeciesNodes: aggregated,
        directPairs,
        medianCpuStepMs: times[1],
      };
      results.push(row);
      console.log(row);
    }
  }
writeFileSync(
  "reports/barnes-hut-cpu.json",
  JSON.stringify(
    {
      runtime: process.version,
      method:
        "One warmup and median of 3 CPU steps. Accuracy measured on the identical seeded initial state against theta=0 direct tree interactions. Radius 0.13, attract-then-repel curves. This is not a GPU benchmark or universal error bound.",
      results,
    },
    null,
    2,
  ),
);
