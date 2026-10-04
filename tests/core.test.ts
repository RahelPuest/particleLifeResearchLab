import { describe, it, expect } from "vitest";
import {
  DEFAULT,
  CORE,
  PRESETS,
  createState,
  force,
  minimumImage,
  parseConfig,
  step,
} from "../src/engine/simulation";
describe("Particle Life", () => {
  it("reproduces a seeded arrangement", () =>
    expect(createState(DEFAULT)).toEqual(createState(DEFAULT)));
  it.each([1, -1])(
    "supports both distance-dependent sign orders (%s)",
    (sign) => {
      const curve = { near: sign, far: -sign, split: 0.55 };
      expect(force(0.03, curve)).toBeLessThan(0);
      expect(force(0.3, curve) * sign).toBeGreaterThan(0);
      expect(force(0.8, curve) * sign).toBeLessThan(0);
      expect(force(curve.split, curve)).toBeCloseTo(0, 12);
      expect(force(1, curve)).toBe(0);
      expect(force(1.1, curve)).toBe(0);
    },
  );
  it("moves the sign change and joins force bands continuously", () => {
    const curve = { near: 1, far: -1, split: 0.7 };
    expect(force(0.6, curve)).toBeGreaterThan(0);
    expect(force(0.6, { ...curve, split: 0.4 })).toBeLessThan(0);
    for (const boundary of [CORE, curve.split, 1]) {
      expect(force(boundary - 1e-6, curve)).toBeCloseTo(
        force(boundary + 1e-6, curve),
        8,
      );
    }
  });
  it("applies directed near and far forces to actual particles", () => {
    for (const distance of [0.03, 0.09]) {
      const c = {
        ...DEFAULT,
        matrix: Array.from({ length: 16 }, () => ({
          near: 0,
          far: 0,
          split: 0.55,
        })),
      };
      c.matrix[1] = { near: 1, far: -1, split: 0.55 };
      const s = {
        positions: new Float32Array([0.3, 0.5, 0.3 + distance, 0.5]),
        velocities: new Float32Array(4),
        types: new Uint8Array([0, 1]),
        tick: 0,
      };
      step(s, c);
      expect(s.velocities[0] * (distance < 0.05 ? 1 : -1)).toBeGreaterThan(0);
      expect(s.velocities[2]).toBe(0);
    }
  });
  it("imports legacy scalars and rejects malformed curve parameters", () => {
    const legacy = { ...DEFAULT, matrix: Array(16).fill(0.6) };
    expect(parseConfig(legacy).matrix[0]).toEqual({
      near: 0.6,
      far: 0.6,
      split: 0.55,
    });
    for (const bad of [
      null,
      { near: 1, far: -1, split: 1 },
      { near: NaN, far: 1, split: 0.5 },
      { near: 2, far: 0, split: 0.5 },
      { near: 0, far: 0, split: ".5" },
    ]) {
      expect(() =>
        parseConfig({ ...DEFAULT, matrix: Array(16).fill(bad) }),
      ).toThrow();
    }
  });
  it("uses the shortest displacement across wrapping edges", () => {
    expect(minimumImage(0.96)).toBeCloseTo(-0.04);
    expect(minimumImage(-0.96)).toBeCloseTo(0.04);
  });
  it.each([0.04, 0.13, 0.25])(
    "matches all-pairs forces at radius %s",
    (radius) => {
      const c = {
        ...DEFAULT,
        count: 180,
        radius,
        matrix: PRESETS["Attract then repel"],
      };
      const grid = createState(c),
        direct = createState(c);
      for (let i = 0; i < 5; i++) {
        step(grid, c);
        step(direct, c, false);
      }
      for (let i = 0; i < grid.positions.length; i++) {
        expect(grid.positions[i]).toBeCloseTo(direct.positions[i], 5);
        expect(grid.velocities[i]).toBeCloseTo(direct.velocities[i], 5);
      }
    },
  );
  it("remains finite and wrapped with coincident particles", () => {
    const c = { ...DEFAULT, count: 100 },
      s = createState(c);
    s.positions.fill(0.5);
    s.velocities.fill(100);
    for (let i = 0; i < 10; i++) step(s, c);
    for (const p of s.positions) {
      expect(Number.isFinite(p)).toBe(true);
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThan(1);
    }
  });
  it("validates imported settings", () => {
    const { theme: _, ...legacyTheme } = DEFAULT;
    expect(parseConfig(legacyTheme).theme).toBe("classic");
    expect(parseConfig({ ...DEFAULT, theme: "glass-light" }).theme).toBe(
      "glass-light",
    );
    expect(() => parseConfig({ ...DEFAULT, theme: "invalid" })).toThrow(
      "Invalid interface theme",
    );
    expect(parseConfig(JSON.parse(JSON.stringify(DEFAULT)))).toEqual(DEFAULT);
    expect(() => parseConfig({ ...DEFAULT, count: 1e6 })).toThrow();
    expect(() => parseConfig({ ...DEFAULT, matrix: [NaN] })).toThrow();
    expect(() => parseConfig({ ...DEFAULT, radius: 0 })).toThrow();
  });
});

describe("optimized solver", () => {
  it("preserves asymmetric forces across seams, dense cells and changing radii", () => {
    for (const radius of [0.04, 0.13, 0.25]) {
      const c = { ...DEFAULT, count: 100, radius };
      const a = createState(c);
      for (let i = 0; i < 20; i++) {
        a.positions[i * 2] = i % 2 ? 0.999 : 0.001;
        a.positions[i * 2 + 1] = 0.48 + i * 0.001;
      }
      const b = structuredClone(a);
      for (let i = 0; i < 4; i++) {
        step(a, c);
        step(b, c, false);
      }
      for (let k = 0; k < a.positions.length; k++) {
        expect(a.positions[k]).toBeCloseTo(b.positions[k], 5);
        expect(a.velocities[k]).toBeCloseTo(b.velocities[k], 5);
      }
    }
  });
  it("matches exact forces when the sample budget covers all candidates", () => {
    const c = {
      ...DEFAULT,
      count: 100,
      solver: "fast" as const,
      neighborBudget: 1024,
    };
    const a = createState(c),
      b = structuredClone(a);
    for (let i = 0; i < 4; i++) {
      step(a, c);
      step(b, c, false);
    }
    for (let k = 0; k < a.positions.length; k++)
      expect(a.positions[k]).toBeCloseTo(b.positions[k], 5);
  });
  it("keeps sampled dense runs deterministic, finite and wrapped", () => {
    const c = {
      ...DEFAULT,
      count: 600,
      solver: "fast" as const,
      neighborBudget: 32,
    };
    const a = createState(c);
    for (let k = 0; k < a.positions.length; k++)
      a.positions[k] = 0.4 + a.positions[k] * 0.1;
    const b = structuredClone(a);
    for (let i = 0; i < 12; i++) {
      step(a, c);
      step(b, c);
    }
    expect(a).toEqual(b);
    for (const value of a.positions) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });
  it("accepts large counts and migrates old settings to exact mode", () => {
    const { solver, neighborBudget, ...legacy } = DEFAULT;
    expect(parseConfig({ ...legacy, count: 50000 }).solver).toBe("exact");
    expect(() => parseConfig({ ...DEFAULT, solver: "unknown" })).toThrow();
    expect(() => parseConfig({ ...DEFAULT, neighborBudget: 0 })).toThrow();
  });
});
