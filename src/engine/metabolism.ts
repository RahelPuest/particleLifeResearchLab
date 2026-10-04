import {
  CORE,
  force,
  integrateVelocity,
  minimumImage,
  type Config,
  type State,
} from "./simulation";
import { initialComposition, convert } from "./metabolic-model";
export * from "./metabolic-model";
export function mixedForce(
  r: number,
  a: ArrayLike<number>,
  b: ArrayLike<number>,
  c: Config,
) {
  if (r < CORE) return force(r, c.matrix[0]);
  let result = 0;
  for (let i = 0; i < 4; i++)
    if (a[i])
      for (let j = 0; j < 4; j++)
        if (b[j]) result += a[i] * b[j] * force(r, c.matrix[i * 4 + j]);
  return result;
}
const scratch = new WeakMap<
  State,
  {
    heads: Int32Array;
    next: Int32Array;
    forces: Float64Array;
    weights: Float32Array;
  }
>();
export function stepMetabolic(s: State, c: Config) {
  const n = s.types.length,
    dim = Math.floor(1 / c.radius);
  const weights = (s.composition ??= initialComposition(
    s.types,
    c.metabolism.initialMix,
  ));
  let w = scratch.get(s);
  if (!w || w.heads.length !== dim * dim || w.next.length !== n) {
    w = {
      heads: new Int32Array(dim * dim),
      next: new Int32Array(n),
      forces: new Float64Array(n * 2),
      weights: new Float32Array(n * 4),
    };
    scratch.set(s, w);
  }
  w.heads.fill(-1);
  w.forces.fill(0);
  for (let i = 0; i < n; i++) {
    const cell =
      Math.min(dim - 1, Math.floor(s.positions[i * 2] * dim)) +
      Math.min(dim - 1, Math.floor(s.positions[i * 2 + 1] * dim)) * dim;
    w.next[i] = w.heads[cell];
    w.heads[cell] = i;
  }
  for (let i = 0; i < n; i++) {
    const x = s.positions[i * 2],
      y = s.positions[i * 2 + 1],
      cx = Math.floor(x * dim),
      cy = Math.floor(y * dim),
      a = weights.subarray(i * 4, i * 4 + 4),
      env = [0, 0, 0, 0];
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const cell = ((cy + dy + dim) % dim) * dim + ((cx + dx + dim) % dim);
        for (let j = w.heads[cell]; j !== -1; j = w.next[j]) {
          if (i === j) continue;
          const dx = minimumImage(s.positions[j * 2] - x),
            dy = minimumImage(s.positions[j * 2 + 1] - y),
            d = Math.hypot(dx, dy);
          if (d >= c.radius) continue;
          const r = d / c.radius,
            b = weights.subarray(j * 4, j * 4 + 4),
            proximity = (1 - r) ** 2;
          for (let k = 0; k < 4; k++) env[k] += b[k] * proximity;
          if (d > 0) {
            const f = (mixedForce(r, a, b, c) * c.strength) / d;
            w.forces[i * 2] += dx * f;
            w.forces[i * 2 + 1] += dy * f;
          }
        }
      }
    w.weights.set(convert(a, env, c.metabolism), i * 4);
  }
  const damping = Math.exp(-c.friction / 60);
  for (let i = 0; i < n * 2; i += 2) {
    integrateVelocity(
      s.velocities,
      i,
      w.forces[i],
      w.forces[i + 1],
      damping,
      c,
    );
    for (let k = i; k < i + 2; k++) {
      const p = s.positions[k] + s.velocities[k] / 60;
      s.positions[k] = Math.min(0.99999988, p - Math.floor(p));
    }
  }
  weights.set(w.weights);
  s.tick++;
}
