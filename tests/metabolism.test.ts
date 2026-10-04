import { expect, it } from "vitest";
import {
  DEFAULT,
  random,
  createState,
  force,
  parseConfig,
  step,
  stepReference,
} from "../src/engine/simulation";
import {
  convert,
  mixedForce,
  DEFAULT_METABOLISM,
  balancedRandomRules,
} from "../src/engine/metabolism";
it("mixes both source and receiver force curves, including the common core", () => {
  const c = {
    ...DEFAULT,
    matrix: DEFAULT.matrix.map((_, i) => ({
      near: i / 15,
      far: -i / 15,
      split: 0.15 + i * 0.05,
    })),
  };
  for (const r of [0.03, 0.2, 0.5, 0.9]) {
    const expected =
      (force(r, c.matrix[2]) +
        force(r, c.matrix[3]) +
        force(r, c.matrix[6]) +
        force(r, c.matrix[7])) /
      4;
    expect(mixedForce(r, [0.5, 0.5, 0, 0], [0, 0, 0.5, 0.5], c)).toBeCloseTo(
      expected,
      10,
    );
  }
});
it("competing conversions preserve mass, are nonnegative, and do not cascade within a step", () => {
  const m = {
    rate: 3,
    initialMix: 0,
    rules: [
      { from: 0, to: 1, catalyst: -1, rate: 3 },
      { from: 0, to: 2, catalyst: -1, rate: 3 },
      { from: 1, to: 3, catalyst: -1, rate: 3 },
    ],
  };
  const a = convert([1, 0, 0, 0], [0, 0, 0, 0], m, 10);
  expect(a[1]).toBeCloseTo(0.5);
  expect(a[2]).toBeCloseTo(0.5);
  expect(a[3]).toBe(0);
  expect(a.reduce((s, x) => s + x, 0)).toBeCloseTo(1, 12);
  expect(a.every((x) => x >= 0)).toBe(true);
  expect(
    convert(
      [1, 0, 0, 0],
      [0, 0, 0, 0],
      { ...m, rules: [...m.rules].reverse() },
      10,
    ),
  ).toEqual(a);
});
it("reaction rate depends on catalyst share and vanishes without catalysts", () => {
  const m = {
    ...DEFAULT_METABOLISM,
    rules: [{ from: 0, to: 1, catalyst: 2, rate: 1 }],
  };
  expect(convert([1, 0, 0, 0], [0, 0, 0, 0], m)).toEqual([1, 0, 0, 0]);
  const half = convert([1, 0, 0, 0], [0, 0, 0.5, 0], m)[1],
    full = convert([1, 0, 0, 0], [0, 0, 1, 0], m)[1];
  expect(full).toBeGreaterThan(half);
  expect(half).toBeGreaterThan(0);
});
it("pure static metabolic particles match classic exact forces", () => {
  const c = {
    ...DEFAULT,
    count: 129,
    mode: "metabolic" as const,
    metabolism: { ...DEFAULT_METABOLISM, rules: [] },
  };
  const mixed = createState(c),
    classic = structuredClone(mixed);
  step(mixed, c);
  stepReference(classic, DEFAULT);
  for (let i = 0; i < mixed.velocities.length; i++)
    expect(mixed.velocities[i]).toBeCloseTo(classic.velocities[i], 5);
});
it("CPU conversion excludes self, detects wrapped neighbors, and uses old composition", () => {
  const c = {
    ...DEFAULT,
    count: 2,
    mode: "metabolic" as const,
    strength: 0,
    metabolism: {
      ...DEFAULT_METABOLISM,
      rules: [{ from: 0, to: 1, catalyst: 2, rate: 1 }],
    },
  };
  const s = createState(c);
  s.positions.set([0.999, 0.5, 0.001, 0.5]);
  s.composition!.set([1, 0, 0, 0, 0, 0, 1, 0]);
  step(s, c);
  expect(s.composition![1]).toBeGreaterThan(0);
  expect(s.composition![6]).toBe(1);
  const alone = createState({ ...c, count: 1 });
  alone.composition!.set([0.5, 0, 0.5, 0]);
  step(alone, { ...c, count: 1 });
  expect(Array.from(alone.composition!)).toEqual([0.5, 0, 0.5, 0]);
});
it("metabolic settings are optional, validated, and round-trip", () => {
  const { mode: _, metabolism: __, ...legacy } = DEFAULT;
  expect(parseConfig(legacy).mode).toBe("classic");
  const c = { ...DEFAULT, mode: "metabolic", solver: "mesh-gpu" };
  expect(parseConfig(JSON.parse(JSON.stringify(c)))).toEqual(c);
  for (const patch of [
    { mode: "bad" },
    { mode: "metabolic", solver: "bvh-gpu" },
    { metabolism: { ...DEFAULT_METABOLISM, rate: NaN } },
    {
      metabolism: {
        ...DEFAULT_METABOLISM,
        rules: [{ from: 0, to: 0, catalyst: 2, rate: 1 }],
      },
    },
  ])
    expect(() => parseConfig({ ...DEFAULT, ...patch })).toThrow();
});

it("randomized rules give every species balanced rates, catalysts and reachable returns", () => {
  const distinct = new Set<string>();
  for (let seed = 0; seed < 128; seed++) {
    const rules = balancedRandomRules(random(seed));
    distinct.add(JSON.stringify(rules));
    expect(rules).toHaveLength(8);
    expect(
      parseConfig({ ...DEFAULT, metabolism: { ...DEFAULT_METABOLISM, rules } })
        .metabolism.rules,
    ).toEqual(rules);
    for (let type = 0; type < 4; type++) {
      const outgoing = rules.filter((r) => r.from === type),
        incoming = rules.filter((r) => r.to === type);
      expect(outgoing).toHaveLength(2);
      expect(incoming).toHaveLength(2);
      expect(outgoing.reduce((s, r) => s + r.rate, 0)).toBeCloseTo(
        incoming.reduce((s, r) => s + r.rate, 0),
        12,
      );
      expect(rules.filter((r) => r.catalyst === type)).toHaveLength(1);
      const reachable = new Set([type]);
      for (let i = 0; i < 4; i++)
        for (const r of rules)
          if (r.catalyst === -1 && reachable.has(r.from)) reachable.add(r.to);
      expect(reachable.size).toBe(4);
    }
    for (const r of rules) {
      expect(r.from).not.toBe(r.to);
      expect(r.rate).toBeGreaterThan(0);
      if (r.catalyst >= 0) {
        expect(r.catalyst).not.toBe(r.from);
        expect(r.catalyst).not.toBe(r.to);
      }
    }
    for (const exposure of [0, 0.1, 1, 100]) {
      const next = convert([0.25, 0.25, 0.25, 0.25], Array(4).fill(exposure), {
        ...DEFAULT_METABOLISM,
        rules,
      });
      for (const share of next) expect(share).toBeCloseTo(0.25, 12);
    }
  }
  expect(distinct.size).toBeGreaterThan(100);
});
