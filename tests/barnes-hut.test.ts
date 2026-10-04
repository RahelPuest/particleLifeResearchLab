import { describe, it, expect } from "vitest";
import { BarnesHutTree, morton, treeLayout } from "../src/engine/barnes-hut";
import {
  DEFAULT,
  PRESETS,
  createState,
  parseConfig,
  step,
  stepReference,
} from "../src/engine/simulation";
describe("species-aware Barnes–Hut", () => {
  it("lays out all leaves with valid stackless escape links", () => {
    const tree = treeLayout(1000);
    let node = 0,
      visited = 0;
    while (node < tree.nodes) {
      visited++;
      node = node < tree.firstLeaf ? node * 4 + 1 : tree.geometry[node * 4 + 3];
      expect(visited).toBeLessThanOrEqual(tree.nodes);
    }
    expect(visited).toBe(tree.nodes);
    for (let i = 0; i < tree.leaves; i++) {
      const k = (tree.firstLeaf + i) * 4;
      expect(morton(tree.geometry[k], tree.geometry[k + 1], tree.depth)).toBe(
        i,
      );
    }
  });
  it("stores independent counts and moments for every species", () => {
    const s = createState({ ...DEFAULT, count: 401 }),
      tree = new BarnesHutTree(401);
    tree.build(s);
    for (let t = 0; t < 4; t++) {
      let x = 0,
        y = 0,
        n = 0;
      for (let i = 0; i < 401; i++)
        if (s.types[i] === t) {
          x += s.positions[i * 2];
          y += s.positions[i * 2 + 1];
          n++;
        }
      expect(tree.moments[t * 4]).toBeCloseTo(x, 8);
      expect(tree.moments[t * 4 + 1]).toBeCloseTo(y, 8);
      expect(tree.moments[t * 4 + 2]).toBe(n);
    }
  });
  it.each([0.04, 0.13, 0.25])(
    "theta zero matches direct forces with periodic seams at radius %s",
    (radius) => {
      const c = {
        ...DEFAULT,
        count: 300,
        radius,
        theta: 0,
        solver: "barnes-hut" as const,
        matrix: PRESETS["Attract then repel"],
      };
      const a = createState(c);
      for (let i = 0; i < 20; i++) {
        a.positions[i * 2] = i % 2 ? 0.999 : 0.001;
        a.positions[i * 2 + 1] = 0.45 + i * 0.002;
      }
      const b = structuredClone(a);
      for (let j = 0; j < 3; j++) {
        step(a, c);
        stepReference(b, c, false);
      }
      for (let i = 0; i < a.positions.length; i++) {
        expect(a.positions[i]).toBeCloseTo(b.positions[i], 5);
        expect(a.velocities[i]).toBeCloseTo(b.velocities[i], 5);
      }
    },
  );
  it("approximates groups with bounded fixture error and improves with tighter theta", () => {
    const c = {
        ...DEFAULT,
        count: 2000,
        radius: 0.25,
        theta: 0.8,
        matrix: PRESETS["Attract then repel"],
      },
      s = createState(c),
      tree = new BarnesHutTree(c.count);
    const exact = tree.calculate(s, { ...c, theta: 0 }).slice();
    const broad = tree.calculate(s, c).slice();
    expect(tree.aggregated).toBeGreaterThan(0);
    const tight = tree.calculate(s, { ...c, theta: 0.25 });
    let denom = 0,
      broadError = 0,
      tightError = 0;
    for (let i = 0; i < exact.length; i++) {
      denom += exact[i] ** 2;
      broadError += (broad[i] - exact[i]) ** 2;
      tightError += (tight[i] - exact[i]) ** 2;
    }
    expect(Math.sqrt(broadError / denom)).toBeLessThan(0.12);
    expect(tightError).toBeLessThan(broadError);
    expect(Math.sqrt(tightError / denom)).toBeLessThan(0.025);
  });
  it("does not approximate the collision core or self-force", () => {
    const c = {
      ...DEFAULT,
      count: 100,
      solver: "barnes-hut" as const,
      theta: 1.2,
    };
    const s = createState(c);
    s.positions.fill(0.5);
    const tree = new BarnesHutTree(100);
    expect(Array.from(tree.calculate(s, c))).toEqual(Array(200).fill(0));
    expect(tree.aggregated).toBe(0);
  });
  it("validates theta and migrates old settings", () => {
    const { theta, ...old } = DEFAULT;
    expect(parseConfig(old).theta).toBe(0.6);
    for (const theta of [-1, NaN, Infinity, 2, "0.6"])
      expect(() => parseConfig({ ...DEFAULT, theta })).toThrow();
    expect(
      parseConfig({ ...DEFAULT, solver: "barnes-hut-gpu", theta: 0 }).theta,
    ).toBe(0);
  });
});
