export type Reaction = {
  from: number;
  to: number;
  catalyst: number;
  rate: number;
};
export type Metabolism = {
  rate: number;
  initialMix: number;
  rules: Reaction[];
};
export const DEFAULT_METABOLISM: Metabolism = {
  rate: 1,
  initialMix: 0,
  rules: [
    { from: 0, to: 1, catalyst: 2, rate: 0.4 },
    { from: 1, to: 0, catalyst: -1, rate: 0.08 },
    { from: 2, to: 3, catalyst: 0, rate: 0.3 },
    { from: 3, to: 2, catalyst: -1, rate: 0.06 },
  ],
};
export function parseMetabolism(value: unknown): Metabolism {
  if (value === undefined) return structuredClone(DEFAULT_METABOLISM);
  const m = value as Metabolism;
  if (
    !m ||
    typeof m !== "object" ||
    !Number.isFinite(m.rate) ||
    m.rate < 0 ||
    m.rate > 3 ||
    !Number.isFinite(m.initialMix) ||
    m.initialMix < 0 ||
    m.initialMix > 1 ||
    !Array.isArray(m.rules) ||
    m.rules.length > 8
  )
    throw new Error("Invalid metabolism settings.");
  for (const r of m.rules)
    if (
      !r ||
      ![r.from, r.to, r.catalyst].every(Number.isInteger) ||
      r.from < 0 ||
      r.from > 3 ||
      r.to < 0 ||
      r.to > 3 ||
      r.from === r.to ||
      r.catalyst < -1 ||
      r.catalyst > 3 ||
      !Number.isFinite(r.rate) ||
      r.rate < 0 ||
      r.rate > 3
    )
      throw new Error("Invalid conversion rule.");
  return {
    rate: m.rate,
    initialMix: m.initialMix,
    rules: m.rules.map((r) => ({
      from: r.from,
      to: r.to,
      catalyst: r.catalyst,
      rate: r.rate,
    })),
  };
}
export function initialComposition(types: Uint8Array, mix = 0) {
  const result = new Float32Array(types.length * 4).fill(mix / 4);
  for (let i = 0; i < types.length; i++) result[i * 4 + types[i]] += 1 - mix;
  return result;
}
/** Competing hazards share the OLD source mass. No cascading or overdraw within a step. */
export function convert(
  weights: ArrayLike<number>,
  environment: ArrayLike<number>,
  m: Metabolism,
  dt = 1 / 60,
) {
  const next = Array.from(weights),
    outgoing = [0, 0, 0, 0];
  const rates = m.rules.map((r) => {
    const e = Math.max(0, environment[r.catalyst] ?? 0);
    const rate = r.rate * m.rate * (r.catalyst < 0 ? 1 : e / (1 + e));
    outgoing[r.from] += rate;
    return rate;
  });
  m.rules.forEach((r, i) => {
    const sum = outgoing[r.from];
    if (!sum) return;
    const transfer =
      (weights[r.from] * -Math.expm1(-sum * dt) * rates[i]) / sum;
    next[r.from] -= transfer;
    next[r.to] += transfer;
  });
  const total = next.reduce((sum, x) => sum + Math.max(0, x), 0);
  return next.map((x) => Math.max(0, x) / total);
}

/** Equal incoming/outgoing base rates; a basal return cycle prevents catalyst starvation. */
export function balancedRandomRules(
  rng: () => number = Math.random,
): Reaction[] {
  const order = [0, 1, 2, 3];
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  const forwardRate = (4 + Math.floor(rng() * 9)) / 20;
  const returnRate = (1 + Math.floor(rng() * 3)) / 20;
  const catalystOffset = rng() < 0.5 ? 2 : 3;
  const rules: Reaction[] = [];
  for (let i = 0; i < 4; i++) {
    rules.push({
      from: order[i],
      to: order[(i + 1) % 4],
      catalyst: order[(i + catalystOffset) % 4],
      rate: forwardRate,
    });
    rules.push({
      from: order[(i + 1) % 4],
      to: order[i],
      catalyst: -1,
      rate: returnRate,
    });
  }
  return rules;
}
