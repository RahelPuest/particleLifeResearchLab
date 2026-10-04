import {
  DEFAULT_METABOLISM,
  parseMetabolism,
  initialComposition,
  type Metabolism,
} from "./metabolic-model";
import { stepMetabolic } from "./metabolism";
import { DEFAULT_VISUALS, parseVisuals, type VisualSettings } from "../visuals";
import { stepBarnesHut } from "./barnes-hut";
export const COLORS = ["#72e5bc", "#f0bd71", "#999cf6", "#ed849d"];
export type Interaction = { near: number; far: number; split: number };
export const CORE = 0.08;
export function interaction(value: number): Interaction {
  return { near: value, far: value, split: 0.55 };
}
export type Config = {
  theme: "classic" | "glass-dark" | "glass-light";
  mode: "classic" | "metabolic";
  metabolism: Metabolism;
  count: number;
  radius: number;
  strength: number;
  friction: number;
  speed: number;
  speedLimitEnabled: boolean;
  maxSpeed: number;
  seed: number;
  matrix: Interaction[];
  solver:
    | "exact"
    | "fast"
    | "barnes-hut"
    | "barnes-hut-gpu"
    | "grid-gpu"
    | "bvh-gpu"
    | "all-pairs-gpu"
    | "auto-gpu"
    | "fast-gpu"
    | "mesh-gpu";
  theta: number;
  neighborBudget: number;
  meshResolution: number;
  visuals: VisualSettings;
};
export type State = {
  positions: Float32Array;
  velocities: Float32Array;
  types: Uint8Array;
  composition?: Float32Array;
  tick: number;
};
const SCALAR_PRESETS: Record<string, number[]> = {
  "Living cells": [
    0.8, -0.45, -0.25, 0.2, -0.3, 0.75, 0.2, -0.5, -0.45, 0.15, 0.8, -0.3, 0.2,
    -0.5, -0.3, 0.75,
  ],
  Chase: [
    0.2, 0.9, -0.6, 0, -0.6, 0.2, 0.9, 0, 0.9, -0.6, 0.2, 0, 0.3, 0.3, 0.3, 0.5,
  ],
  Constellations: [
    0.9, -0.8, -0.8, -0.8, -0.8, 0.9, -0.8, -0.8, -0.8, -0.8, 0.9, -0.8, -0.8,
    -0.8, -0.8, 0.9,
  ],
};
export const PRESETS: Record<string, Interaction[]> = Object.fromEntries(
  Object.entries(SCALAR_PRESETS).map(([name, values]) => [
    name,
    values.map(interaction),
  ]),
);
PRESETS["Attract then repel"] = SCALAR_PRESETS["Living cells"].map((value) => ({
  near: Math.abs(value),
  far: -Math.abs(value),
  split: 0.55,
}));
PRESETS["Repel then attract"] = SCALAR_PRESETS["Living cells"].map((value) => ({
  near: -Math.abs(value),
  far: Math.abs(value),
  split: 0.55,
}));
export const DEFAULT: Config = {
  theme: "classic",
  mode: "classic",
  metabolism: structuredClone(DEFAULT_METABOLISM),
  solver: "exact",
  theta: 0.6,
  neighborBudget: 128,
  meshResolution: 128,
  visuals: { ...DEFAULT_VISUALS },
  count: 1800,
  radius: 0.13,
  strength: 1.5,
  friction: 4,
  speed: 1,
  speedLimitEnabled: false,
  maxSpeed: 0.5,
  seed: 42,
  matrix: [...PRESETS["Living cells"]],
};
export function random(seed: number) {
  let a = seed >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function createState(c: Config): State {
  const rng = random(c.seed),
    positions = new Float32Array(c.count * 2),
    velocities = new Float32Array(c.count * 2),
    types = new Uint8Array(c.count);
  for (let i = 0; i < c.count; i++) {
    positions[i * 2] = rng();
    positions[i * 2 + 1] = rng();
    types[i] = i % 4;
  }
  return {
    positions,
    velocities,
    types,
    tick: 0,
    ...(c.mode === "metabolic"
      ? { composition: initialComposition(types, c.metabolism.initialMix) }
      : {}),
  };
}
// Two smooth distance bands, separated by a configurable zero crossing.
// A small, fixed collision core prevents collapse; force is zero beyond the radius.
export function force(r: number, curve: Interaction) {
  if (r >= 1) return 0;
  if (r < CORE) return -((1 - r / CORE) ** 2);
  const t =
    r < curve.split
      ? (r - CORE) / (curve.split - CORE)
      : (r - curve.split) / (1 - curve.split);
  const envelope = 16 * t * t * (1 - t) * (1 - t);
  return (r < curve.split ? curve.near : curve.far) * envelope;
}
export function minimumImage(d: number) {
  return d - Math.round(d);
}
// Directed, compact-support pair forces. Grid cells are at least one interaction radius wide.
export function stepReference(state: State, c: Config, useGrid = true) {
  const { positions: p, velocities: v, types } = state,
    n = types.length;
  const cells = Math.max(3, Math.floor(1 / c.radius)),
    heads = new Int32Array(cells * cells).fill(-1),
    next = new Int32Array(n);
  if (useGrid)
    for (let i = 0; i < n; i++) {
      const cell =
        Math.min(cells - 1, Math.floor(p[i * 2] * cells)) +
        Math.min(cells - 1, Math.floor(p[i * 2 + 1] * cells)) * cells;
      next[i] = heads[cell];
      heads[cell] = i;
    }
  const dt = 1 / 60,
    damping = Math.exp(-c.friction * dt),
    radius2 = c.radius * c.radius;
  for (let i = 0; i < n; i++) {
    let fx = 0,
      fy = 0;
    const visit = (j: number) => {
      if (i === j) return;
      const dx = minimumImage(p[j * 2] - p[i * 2]),
        dy = minimumImage(p[j * 2 + 1] - p[i * 2 + 1]),
        d2 = dx * dx + dy * dy;
      if (d2 === 0 || d2 >= radius2) return;
      const d = Math.sqrt(d2),
        f = force(d / c.radius, c.matrix[types[i] * 4 + types[j]]) * c.strength;
      fx += (f * dx) / d;
      fy += (f * dy) / d;
    };
    if (useGrid) {
      const x = Math.floor(p[i * 2] * cells),
        y = Math.floor(p[i * 2 + 1] * cells);
      for (let oy = -1; oy <= 1; oy++)
        for (let ox = -1; ox <= 1; ox++) {
          const cell =
            ((x + ox + cells) % cells) + ((y + oy + cells) % cells) * cells;
          for (let j = heads[cell]; j !== -1; j = next[j]) visit(j);
        }
    } else for (let j = 0; j < n; j++) visit(j);
    integrateVelocity(v, i * 2, fx, fy, damping, c);
  }
  for (let k = 0; k < p.length; k++) {
    const position = p[k] + v[k] * dt;
    p[k] = Math.min(1 - 1e-7, position - Math.floor(position));
  }
  state.tick++;
}
// Apply impulses in unbounded coordinates, then map back into the velocity ball.
// Unlike remapping velocity every step, zero force adds no drag below the cap.
export function integrateVelocity(
  v: Float32Array,
  k: number,
  ax: number,
  ay: number,
  damping: number,
  c: Config,
) {
  if (!c.speedLimitEnabled) {
    v[k] = (v[k] + ax / 60) * damping;
    v[k + 1] = (v[k + 1] + ay / 60) * damping;
    return;
  }
  const limit = c.maxSpeed * (1 - 1e-6),
    limit2 = limit * limit;
  let x = v[k] * damping,
    y = v[k + 1] * damping;
  const speed2 = x * x + y * y;
  // Only project invalid initial states, e.g. after enabling or lowering the limit.
  if (speed2 >= limit2) {
    const scale = (limit * (1 - 1e-6)) / Math.sqrt(speed2);
    x *= scale;
    y *= scale;
  }
  if (ax !== 0 || ay !== 0) {
    const inverse =
      1 / Math.sqrt(Math.max(1e-12, 1 - (x * x + y * y) / limit2));
    const px = x * inverse + (ax / 60) * damping;
    const py = y * inverse + (ay / 60) * damping;
    const scale = 1 / Math.sqrt(1 + (px * px + py * py) / limit2);
    x = px * scale;
    y = py * scale;
  }
  v[k] = x;
  v[k + 1] = y;
}
export function parseConfig(input: unknown): Config {
  if (!input || typeof input !== "object")
    throw new Error("Invalid settings file.");
  const c = input as Config;
  const ranges: [keyof Config, number, number][] = [
    ["count", 100, 50000],
    ["radius", 0.04, 0.25],
    ["strength", 0.1, 3],
    ["friction", 1, 12],
    ["speed", 0.25, 3],
    ["seed", 0, 4294967295],
  ];
  for (const [key, min, max] of ranges)
    if (
      typeof c[key] !== "number" ||
      !Number.isFinite(c[key]) ||
      Number(c[key]) < min ||
      Number(c[key]) > max
    )
      throw new Error(`Invalid ${key}.`);
  if (
    !Number.isInteger(c.count) ||
    !Number.isInteger(c.seed) ||
    !Array.isArray(c.matrix) ||
    c.matrix.length !== 16
  )
    throw new Error("Invalid particle count, seed or interaction matrix.");
  const theme = c.theme === undefined ? "classic" : c.theme;
  if (!["classic", "glass-dark", "glass-light"].includes(theme))
    throw new Error("Invalid interface theme.");
  const mode = c.mode ?? "classic";
  if (mode !== "classic" && mode !== "metabolic")
    throw new Error("Invalid simulation mode.");
  const solver = c.solver ?? "exact",
    neighborBudget = c.neighborBudget ?? 128,
    theta = c.theta ?? 0.6;
  const meshResolution =
    c.meshResolution === undefined ? DEFAULT.meshResolution : c.meshResolution;
  if (![64, 128, 256].includes(meshResolution))
    throw new Error("Invalid mesh resolution.");
  const speedLimitEnabled =
    c.speedLimitEnabled === undefined ? false : c.speedLimitEnabled;
  const maxSpeed = c.maxSpeed === undefined ? DEFAULT.maxSpeed : c.maxSpeed;
  if (
    typeof speedLimitEnabled !== "boolean" ||
    typeof maxSpeed !== "number" ||
    !Number.isFinite(maxSpeed) ||
    maxSpeed < 0.05 ||
    maxSpeed > 5
  )
    throw new Error("Invalid speed limit settings.");
  if (
    ![
      "exact",
      "fast",
      "barnes-hut",
      "barnes-hut-gpu",
      "grid-gpu",
      "bvh-gpu",
      "all-pairs-gpu",
      "auto-gpu",
      "fast-gpu",
      "mesh-gpu",
    ].includes(solver) ||
    typeof theta !== "number" ||
    !Number.isFinite(theta) ||
    theta < 0 ||
    theta > 1.2 ||
    !Number.isInteger(neighborBudget) ||
    neighborBudget < 32 ||
    neighborBudget > 1024
  )
    throw new Error("Invalid solver settings.");
  if (mode === "metabolic" && !["exact", "mesh-gpu"].includes(solver))
    throw new Error("Metabolic mode requires exact CPU or particle mesh GPU.");
  // Previous settings files stored a scalar for each pair.
  const matrix = c.matrix.map((entry: unknown) => {
    const curve =
      typeof entry === "number" ? interaction(entry) : (entry as Interaction);
    if (
      !curve ||
      typeof curve !== "object" ||
      ![curve.near, curve.far, curve.split].every(
        (x) => typeof x === "number" && Number.isFinite(x),
      ) ||
      Math.abs(curve.near) > 1 ||
      Math.abs(curve.far) > 1 ||
      curve.split < 0.15 ||
      curve.split > 0.9
    )
      throw new Error("Invalid force curve.");
    return { near: curve.near, far: curve.far, split: curve.split };
  });
  return {
    theme,
    mode,
    metabolism: parseMetabolism(c.metabolism),
    solver,
    theta,
    neighborBudget,
    meshResolution,
    visuals: parseVisuals(c.visuals),
    count: c.count,
    radius: c.radius,
    strength: c.strength,
    friction: c.friction,
    speed: c.speed,
    speedLimitEnabled,
    maxSpeed,
    seed: c.seed,
    matrix,
  };
}

// Persistent counting-sort grid. Each unordered pair shares its distance calculation,
// but evaluates both directed curves independently (forces need not be reciprocal).
class Workspace {
  n: number;
  cells = 0;
  sampleStarts = new Int32Array(9);
  sampleEnds = new Int32Array(9);
  counts = new Int32Array(0);
  offsets = new Int32Array(0);
  cursor = new Int32Array(0);
  neighbors = new Int32Array(0);
  order: Int32Array;
  particleCells: Int32Array;
  x: Float64Array;
  y: Float64Array;
  types: Uint8Array;
  fx: Float64Array;
  fy: Float64Array;
  constructor(n: number) {
    this.n = n;
    this.order = new Int32Array(n);
    this.particleCells = new Int32Array(n);
    this.x = new Float64Array(n);
    this.y = new Float64Array(n);
    this.types = new Uint8Array(n);
    this.fx = new Float64Array(n);
    this.fy = new Float64Array(n);
  }
  build(s: State, radius: number) {
    const cells = Math.max(4, Math.floor(1 / radius)),
      size = cells * cells;
    if (cells !== this.cells) {
      this.cells = cells;
      this.counts = new Int32Array(size);
      this.offsets = new Int32Array(size + 1);
      this.cursor = new Int32Array(size);
      this.neighbors = new Int32Array(size * 4);
      for (let y = 0; y < cells; y++)
        for (let x = 0; x < cells; x++) {
          const k = (y * cells + x) * 4;
          this.neighbors[k] = y * cells + ((x + 1) % cells);
          this.neighbors[k + 1] =
            ((y + 1) % cells) * cells + ((x + cells - 1) % cells);
          this.neighbors[k + 2] = ((y + 1) % cells) * cells + x;
          this.neighbors[k + 3] = ((y + 1) % cells) * cells + ((x + 1) % cells);
        }
    }
    this.counts.fill(0);
    this.fx.fill(0);
    this.fy.fill(0);
    for (let i = 0; i < this.n; i++) {
      const cell =
        Math.min(cells - 1, Math.floor(s.positions[i * 2] * cells)) +
        Math.min(cells - 1, Math.floor(s.positions[i * 2 + 1] * cells)) * cells;
      this.particleCells[i] = cell;
      this.counts[cell]++;
    }
    this.offsets[0] = 0;
    for (let i = 0; i < size; i++) {
      this.offsets[i + 1] = this.offsets[i] + this.counts[i];
      this.cursor[i] = this.offsets[i];
    }
    for (let i = 0; i < this.n; i++) {
      const slot = this.cursor[this.particleCells[i]]++;
      this.order[slot] = i;
      this.x[slot] = s.positions[i * 2];
      this.y[slot] = s.positions[i * 2 + 1];
      this.types[slot] = s.types[i];
    }
  }
}
const workspaces = new WeakMap<State, Workspace>();
export function step(state: State, c: Config, useGrid = true) {
  if (c.mode === "metabolic") {
    stepMetabolic(state, c);
    return;
  }
  if (!useGrid) {
    stepReference(state, c, false);
    return;
  }
  if (c.solver === "barnes-hut" || c.solver === "barnes-hut-gpu") {
    stepBarnesHut(state, c);
    return;
  }
  let w = workspaces.get(state);
  if (!w || w.n !== state.types.length) {
    w = new Workspace(state.types.length);
    workspaces.set(state, w);
  }
  w.build(state, c.radius);
  if (c.solver === "fast" || c.solver === "fast-gpu") {
    sampledStep(state, c, w);
    return;
  }
  const { x, y, types, fx, fy, offsets, neighbors, order } = w;
  const radius2 = c.radius * c.radius,
    invRadius = 1 / c.radius,
    matrix = c.matrix;
  for (let cell = 0; cell < w.cells * w.cells; cell++) {
    const start = offsets[cell],
      end = offsets[cell + 1];
    if (start === end) continue;
    // Own cell plus only one half of the neighboring cells; every pair exactly once.
    for (let block = -1; block < 4; block++) {
      const other = block < 0 ? cell : neighbors[cell * 4 + block];
      const stop = offsets[other + 1];
      for (let i = start; i < end; i++) {
        const begin = block < 0 ? i + 1 : offsets[other];
        const xi = x[i],
          yi = y[i],
          ti = types[i];
        let ax = fx[i],
          ay = fy[i];
        for (let j = begin; j < stop; j++) {
          let dx = x[j] - xi,
            dy = y[j] - yi;
          if (dx > 0.5) dx--;
          else if (dx < -0.5) dx++;
          if (dy > 0.5) dy--;
          else if (dy < -0.5) dy++;
          if (
            dx >= c.radius ||
            dx <= -c.radius ||
            dy >= c.radius ||
            dy <= -c.radius
          )
            continue;
          const d2 = dx * dx + dy * dy;
          if (d2 === 0 || d2 >= radius2) continue;
          const d = Math.sqrt(d2),
            r = d * invRadius,
            scale = c.strength / d;
          const a = force(r, matrix[ti * 4 + types[j]]) * scale;
          const b = force(r, matrix[types[j] * 4 + ti]) * scale;
          ax += a * dx;
          ay += a * dy;
          fx[j] -= b * dx;
          fy[j] -= b * dy;
        }
        fx[i] = ax;
        fy[i] = ay;
      }
    }
  }
  const damping = Math.exp(-c.friction / 60),
    p = state.positions,
    v = state.velocities;
  for (let i = 0; i < order.length; i++) {
    const k = order[i] * 2;
    integrateVelocity(v, k, fx[i], fy[i], damping, c);
    const px = p[k] + v[k] / 60,
      py = p[k + 1] + v[k + 1] / 60;
    p[k] = Math.min(1 - 1e-7, px - Math.floor(px));
    p[k + 1] = Math.min(1 - 1e-7, py - Math.floor(py));
  }
  state.tick++;
}

// Systematic sampling with a seeded random rotation over all candidate slots.
// Scaling by candidateCount / sampleCount estimates the original force sum.
// This bounds work per particle but introduces force noise; it is opt-in only.
function sampledStep(state: State, c: Config, w: Workspace) {
  const { x, y, types, offsets, order } = w,
    n = order.length,
    cells = w.cells;
  const starts = w.sampleStarts,
    ends = w.sampleEnds;
  const radius2 = c.radius * c.radius,
    invRadius = 1 / c.radius,
    damping = Math.exp(-c.friction / 60),
    v = state.velocities,
    p = state.positions;
  for (let cell = 0; cell < cells * cells; cell++) {
    if (offsets[cell] === offsets[cell + 1]) continue;
    const cx = cell % cells,
      cy = Math.floor(cell / cells);
    let total = 0,
      block = 0;
    for (let oy = -1; oy <= 1; oy++)
      for (let ox = -1; ox <= 1; ox++) {
        const other =
          ((cx + ox + cells) % cells) + ((cy + oy + cells) % cells) * cells;
        starts[block] = offsets[other];
        total += offsets[other + 1] - offsets[other];
        ends[block++] = total;
      }
    const samples = Math.min(total, c.neighborBudget),
      weight = total / samples,
      stride = total / samples;
    for (let i = offsets[cell]; i < offsets[cell + 1]; i++) {
      let hash =
        Math.imul(order[i] ^ c.seed, 0x45d9f3b) ^
        Math.imul(state.tick + 1, 0x27d4eb2d);
      hash = Math.imul(hash ^ (hash >>> 16), 0x45d9f3b);
      hash ^= hash >>> 16;
      const rotation = samples === total ? 0 : (hash >>> 0) % total;
      let fx = 0,
        fy = 0,
        b = 0;
      for (let k = 0; k < samples; k++) {
        const slot = (Math.floor(k * stride) + rotation) % total;
        if (b && slot < ends[b - 1]) b = 0;
        while (slot >= ends[b]) b++;
        const j = starts[b] + slot - (b ? ends[b - 1] : 0);
        if (i === j) continue;
        let dx = x[j] - x[i],
          dy = y[j] - y[i];
        if (dx > 0.5) dx--;
        else if (dx < -0.5) dx++;
        if (dy > 0.5) dy--;
        else if (dy < -0.5) dy++;
        const d2 = dx * dx + dy * dy;
        if (d2 === 0 || d2 >= radius2) continue;
        const d = Math.sqrt(d2),
          f =
            (force(d * invRadius, c.matrix[types[i] * 4 + types[j]]) *
              c.strength) /
            d;
        fx += f * dx;
        fy += f * dy;
      }
      const k = order[i] * 2;
      integrateVelocity(v, k, fx * weight, fy * weight, damping, c);
    }
  }
  for (let k = 0; k < p.length; k++) {
    const position = p[k] + v[k] / 60;
    p[k] = Math.min(1 - 1e-7, position - Math.floor(position));
  }
  state.tick++;
}
