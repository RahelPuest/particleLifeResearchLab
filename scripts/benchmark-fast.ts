import { performance } from "node:perf_hooks";
import { writeFileSync } from "node:fs";
import { DEFAULT, createState, step } from "../src/engine/simulation";
const results = [];
for (const count of [5000, 10000, 20000, 50000])
  for (const distribution of ["uniform", "clustered"]) {
    const c = {
        ...DEFAULT,
        count,
        solver: "fast" as const,
        neighborBudget: 128,
      },
      s = createState(c);
    if (distribution === "clustered")
      for (let i = 0; i < s.positions.length; i++)
        s.positions[i] = 0.35 + s.positions[i] * 0.3;
    for (let i = 0; i < 3; i++) step(s, c);
    const times = [];
    for (let i = 0; i < 7; i++) {
      const t = performance.now();
      step(s, c);
      times.push(performance.now() - t);
    }
    times.sort((a, b) => a - b);
    const result = {
      count,
      distribution,
      samples: c.neighborBudget,
      medianStepMs: +times[3].toFixed(2),
    };
    results.push(result);
    console.log(result);
  }
writeFileSync(
  "reports/performance-fast.json",
  JSON.stringify(
    {
      runtime: process.version,
      method:
        "Opt-in approximate solver; median of 7 CPU physics steps after 3 warm-up steps. Radius 0.13, seed 42. Not equivalent trajectories to exact solver.",
      results,
    },
    null,
    2,
  ),
);
