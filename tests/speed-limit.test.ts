import { describe, it, expect } from "vitest";
import {
  DEFAULT,
  createState,
  integrateVelocity,
  parseConfig,
  step,
} from "../src/engine/simulation";

describe("asymptotic particle speed", () => {
  it("preserves direction and smoothly approaches a strict bound", () => {
    const c = { ...DEFAULT, speedLimitEnabled: true, maxSpeed: 0.5 };
    let previous = 0;
    for (const speed of [0.001, 0.1, 1, 10, 1000, 1e6]) {
      const v = new Float32Array(2);
      integrateVelocity(v, 0, speed * 0.6 * 60, speed * 0.8 * 60, 1, c);
      const actual = Math.hypot(...v);
      expect(actual).toBeGreaterThan(previous);
      expect(actual).toBeLessThan(c.maxSpeed);
      expect(v[0] / v[1]).toBeCloseTo(0.75, 6);
      previous = actual;
    }
    expect(previous).toBeGreaterThan(c.maxSpeed * 0.999);
    const zero = new Float32Array(2);
    integrateVelocity(zero, 0, 0, 0, 1, c);
    expect([...zero]).toEqual([0, 0]);
  });
  it("does not alter velocities when disabled", () => {
    const v = new Float32Array([3, -4]);
    integrateVelocity(v, 0, 0, 0, 1, DEFAULT);
    expect([...v]).toEqual([3, -4]);
  });
  it.each(["exact", "fast", "barnes-hut"] as const)(
    "limits %s before integrating positions",
    (solver) => {
      const c = {
        ...DEFAULT,
        count: 100,
        solver,
        theta: 0,
        speedLimitEnabled: true,
        maxSpeed: 0.2,
      };
      const state = createState(c);
      state.positions.fill(0.5);
      for (let i = 0; i < 100; i++) {
        state.velocities[i * 2] = 3;
        state.velocities[i * 2 + 1] = 4;
      }
      step(state, c);
      for (let i = 0; i < 100; i++) {
        expect(
          Math.hypot(state.velocities[i * 2], state.velocities[i * 2 + 1]),
        ).toBeLessThan(c.maxSpeed);
        expect(state.positions[i * 2]).toBeCloseTo(
          0.5 + state.velocities[i * 2] / 60,
          6,
        );
        expect(state.positions[i * 2 + 1]).toBeCloseTo(
          0.5 + state.velocities[i * 2 + 1] / 60,
          6,
        );
      }
    },
  );
  it("does not repeatedly brake a force-free particle below the cap", () => {
    const c = { ...DEFAULT, speedLimitEnabled: true, maxSpeed: 0.5 };
    const v = new Float32Array([0.24, 0.32]),
      initial = [...v];
    for (let i = 0; i < 600; i++) integrateVelocity(v, 0, 0, 0, 1, c);
    expect([...v]).toEqual(initial);
    const damped = new Float32Array(initial),
      expected = new Float32Array(initial);
    for (let i = 0; i < 60; i++) {
      integrateVelocity(damped, 0, 0, 0, Math.exp(-4 / 60), c);
      integrateVelocity(expected, 0, 0, 0, Math.exp(-4 / 60), {
        ...c,
        speedLimitEnabled: false,
      });
    }
    expect([...damped]).toEqual([...expected]);
  });
  it("approaches the bound smoothly under sustained acceleration and accepts braking", () => {
    const c = { ...DEFAULT, speedLimitEnabled: true, maxSpeed: 0.5 },
      v = new Float32Array(2);
    let previous = 0;
    for (let i = 0; i < 600; i++) {
      integrateVelocity(v, 0, 1, 0, 1, c);
      expect(v[0]).toBeGreaterThanOrEqual(previous);
      expect(v[0]).toBeLessThan(c.maxSpeed);
      previous = v[0];
    }
    expect(v[0]).toBeGreaterThan(0.49);
    integrateVelocity(v, 0, -1, 0, 1, c);
    expect(v[0]).toBeLessThan(previous);
  });
  it("imports legacy files and validates new settings", () => {
    const { speedLimitEnabled, maxSpeed, ...legacy } = DEFAULT;
    expect(parseConfig(legacy).speedLimitEnabled).toBe(false);
    expect(parseConfig(legacy).maxSpeed).toBe(DEFAULT.maxSpeed);
    const c = { ...DEFAULT, speedLimitEnabled: true, maxSpeed: 1.25 };
    expect(parseConfig(JSON.parse(JSON.stringify(c)))).toEqual(c);
    for (const value of [0, -1, Infinity, NaN, "1", null, 5.1])
      expect(() => parseConfig({ ...DEFAULT, maxSpeed: value })).toThrow();
    for (const value of [1, "true", null])
      expect(() =>
        parseConfig({ ...DEFAULT, speedLimitEnabled: value }),
      ).toThrow();
  });
});
