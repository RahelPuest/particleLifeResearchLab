import { performance } from "node:perf_hooks";
import { writeFileSync } from "node:fs";
import {
  DEFAULT,
  createState,
  step,
  stepReference,
  force,
  minimumImage,
  Config,
  State,
} from "../src/engine/simulation";
// Exact quadtree comparator: no Barnes-Hut aggregation of nonlinear signed forces.
type Node = {
  x: number;
  y: number;
  size: number;
  ids: number[];
  children?: Node[];
};
function treeStep(s: State, c: Config) {
  const p = s.positions,
    root: Node = { x: 0, y: 0, size: 1, ids: [] };
  function insert(node: Node, i: number, depth = 0) {
    if (!node.children && (node.ids.length < 16 || depth === 16)) {
      node.ids.push(i);
      return;
    }
    if (!node.children) {
      const h = node.size / 2;
      node.children = Array.from({ length: 4 }, (_, k) => ({
        x: node.x + (k % 2) * h,
        y: node.y + (k >> 1) * h,
        size: h,
        ids: [],
      }));
      for (const j of node.ids)
        insert(
          node.children[
            (p[j * 2] >= node.x + h ? 1 : 0) +
              (p[j * 2 + 1] >= node.y + h ? 2 : 0)
          ],
          j,
          depth + 1,
        );
      node.ids = [];
    }
    const h = node.size / 2;
    insert(
      node.children[
        (p[i * 2] >= node.x + h ? 1 : 0) + (p[i * 2 + 1] >= node.y + h ? 2 : 0)
      ],
      i,
      depth + 1,
    );
  }
  for (let i = 0; i < s.types.length; i++) insert(root, i);
  const r2 = c.radius * c.radius,
    damping = Math.exp(-c.friction / 60);
  for (let i = 0; i < s.types.length; i++) {
    let fx = 0,
      fy = 0;
    function visit(node: Node) {
      const dx = Math.max(
          0,
          Math.abs(minimumImage(p[i * 2] - (node.x + node.size / 2))) -
            node.size / 2,
        ),
        dy = Math.max(
          0,
          Math.abs(minimumImage(p[i * 2 + 1] - (node.y + node.size / 2))) -
            node.size / 2,
        );
      if (dx * dx + dy * dy >= r2) return;
      if (node.children) {
        for (const child of node.children) visit(child);
        return;
      }
      for (const j of node.ids) {
        if (i === j) continue;
        const x = minimumImage(p[j * 2] - p[i * 2]),
          y = minimumImage(p[j * 2 + 1] - p[i * 2 + 1]),
          d2 = x * x + y * y;
        if (d2 === 0 || d2 >= r2) continue;
        const d = Math.sqrt(d2),
          f =
            (force(d / c.radius, c.matrix[s.types[i] * 4 + s.types[j]]) *
              c.strength) /
            d;
        fx += f * x;
        fy += f * y;
      }
    }
    visit(root);
    s.velocities[i * 2] = (s.velocities[i * 2] + fx / 60) * damping;
    s.velocities[i * 2 + 1] = (s.velocities[i * 2 + 1] + fy / 60) * damping;
  }
  for (let k = 0; k < p.length; k++) {
    const x = p[k] + s.velocities[k] / 60;
    p[k] = Math.min(1 - 1e-7, x - Math.floor(x));
  }
  s.tick++;
}
const verifyOnly = process.argv.includes("--verify-only");
const results = [];
for (const count of verifyOnly ? [256] : [1800, 5000, 10000, 20000])
  for (const distribution of ["uniform", "clustered"]) {
    const c = { ...DEFAULT, count };
    const initial = createState(c);
    if (distribution === "clustered")
      for (let i = 0; i < initial.positions.length; i++)
        initial.positions[i] = 0.35 + initial.positions[i] * 0.3;
    const reference = structuredClone(initial),
      tree = structuredClone(initial);
    stepReference(reference, c, false);
    treeStep(tree, c);
    for (let i = 0; i < reference.velocities.length; i++)
      if (Math.abs(reference.velocities[i] - tree.velocities[i]) > 1e-5)
        throw new Error("Quadtree comparator disagrees with direct forces");
    if (verifyOnly) {
      console.log(`Quadtree matches direct forces: ${distribution}`);
      continue;
    }
    const timings: Record<string, number> = {};
    for (const [name, run] of [
      ["previousGrid", stepReference],
      ["quadtree", treeStep],
      ["optimizedGrid", step],
    ] as const) {
      const s = structuredClone(initial);
      for (let i = 0; i < 2; i++) run(s, c);
      const samples = [];
      for (let i = 0; i < 5; i++) {
        const t = performance.now();
        run(s, c);
        samples.push(performance.now() - t);
      }
      samples.sort((a, b) => a - b);
      timings[name] = +samples[2].toFixed(2);
    }
    const entry = {
      count,
      distribution,
      radius: c.radius,
      ...timings,
      speedup: +(timings.previousGrid / timings.optimizedGrid).toFixed(2),
    };
    results.push(entry);
    console.log(entry);
  }
if (!verifyOnly)
  writeFileSync(
    "reports/performance.json",
    JSON.stringify(
      {
        runtime: process.version,
        platform: process.platform,
        method:
          "Median of 5 steps after 2 warm-up steps, fixed seed 42. CPU physics only; milliseconds per step. Clustered positions initially span 30% of world width.",
        results,
      },
      null,
      2,
    ),
  );
