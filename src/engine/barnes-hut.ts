import {
  Config,
  CORE,
  force,
  minimumImage,
  State,
  integrateVelocity,
} from "./simulation";

// A complete Morton-ordered quadtree with empty branches skipped during traversal.
// Geometry is fixed; occupancy and four separate species moments are rebuilt each step.
export function treeLayout(count: number) {
  const depth = Math.max(
    5,
    Math.min(7, Math.ceil(Math.log(Math.max(1, count / 4)) / Math.log(4))),
  );
  const leaves = 4 ** depth,
    firstLeaf = (leaves - 1) / 3,
    nodes = firstLeaf + leaves;
  const geometry = new Float32Array(nodes * 4);
  function fill(
    node: number,
    x: number,
    y: number,
    size: number,
    escape: number,
  ) {
    geometry.set([x + size / 2, y + size / 2, size, escape], node * 4);
    if (node >= firstLeaf) return;
    for (let q = 0; q < 4; q++)
      fill(
        node * 4 + 1 + q,
        x + ((q % 2) * size) / 2,
        y + ((q >> 1) * size) / 2,
        size / 2,
        q === 3 ? escape : node * 4 + 2 + q,
      );
  }
  fill(0, 0, 0, 1, nodes);
  return { depth, leaves, firstLeaf, nodes, geometry };
}
export function morton(x: number, y: number, depth: number) {
  const dim = 1 << depth,
    ix = Math.min(dim - 1, Math.floor(x * dim)),
    iy = Math.min(dim - 1, Math.floor(y * dim));
  let code = 0;
  for (let b = 0; b < depth; b++)
    code |= (((ix >> b) & 1) << (2 * b)) | (((iy >> b) & 1) << (2 * b + 1));
  return code;
}
export class BarnesHutTree {
  layout: ReturnType<typeof treeLayout>;
  heads: Int32Array;
  next: Int32Array;
  moments: Float64Array;
  forces: Float64Array;
  aggregated = 0;
  directPairs = 0;
  constructor(public count: number) {
    this.layout = treeLayout(count);
    this.heads = new Int32Array(this.layout.leaves);
    this.next = new Int32Array(count);
    this.moments = new Float64Array(this.layout.nodes * 16);
    this.forces = new Float64Array(count * 2);
  }
  build(s: State) {
    const { firstLeaf, depth } = this.layout;
    this.heads.fill(-1);
    this.moments.fill(0);
    for (let i = 0; i < this.count; i++) {
      const leaf = morton(s.positions[i * 2], s.positions[i * 2 + 1], depth);
      this.next[i] = this.heads[leaf];
      this.heads[leaf] = i;
      const k = (firstLeaf + leaf) * 16 + s.types[i] * 4;
      this.moments[k] += s.positions[i * 2];
      this.moments[k + 1] += s.positions[i * 2 + 1];
      this.moments[k + 2]++;
    }
    for (let node = firstLeaf - 1; node >= 0; node--)
      for (let q = 0; q < 4; q++)
        for (let t = 0; t < 4; t++) {
          const k = node * 16 + t * 4,
            j = (node * 4 + 1 + q) * 16 + t * 4;
          this.moments[k] += this.moments[j];
          this.moments[k + 1] += this.moments[j + 1];
          this.moments[k + 2] += this.moments[j + 2];
        }
  }
  calculate(s: State, c: Config) {
    this.build(s);
    this.aggregated = 0;
    this.directPairs = 0;
    const { geometry: g, nodes, firstLeaf } = this.layout,
      m = this.moments,
      p = s.positions,
      r2 = c.radius * c.radius;
    for (let i = 0; i < this.count; i++) {
      let fx = 0,
        fy = 0,
        node = 0;
      const px = p[i * 2],
        py = p[i * 2 + 1],
        type = s.types[i];
      while (node < nodes) {
        const k = node * 4,
          base = node * 16,
          escape = g[k + 3],
          size = g[k + 2],
          half = size / 2;
        if (m[base + 2] + m[base + 6] + m[base + 10] + m[base + 14] === 0) {
          node = escape;
          continue;
        }
        const dx = Math.abs(minimumImage(g[k] - px)),
          dy = Math.abs(minimumImage(g[k + 1] - py));
        const nx = Math.max(0, dx - half),
          ny = Math.max(0, dy - half),
          min2 = nx * nx + ny * ny;
        if (min2 >= r2) {
          node = escape;
          continue;
        }
        const farX = dx + half,
          farY = dy + half,
          max2 = farX * farX + farY * farY;
        let accept =
          c.theta > 0 &&
          size * size < c.theta * c.theta * (dx * dx + dy * dy) &&
          min2 > (CORE * c.radius) ** 2 &&
          max2 < r2 &&
          farX < 0.5 &&
          farY < 0.5;
        if (accept)
          for (let t = 0; t < 4; t++)
            if (m[base + t * 4 + 2]) {
              const split2 = (c.matrix[type * 4 + t].split * c.radius) ** 2;
              const curve = c.matrix[type * 4 + t];
              const bandWidth =
                (max2 < split2 ? curve.split - CORE : 1 - curve.split) *
                c.radius;
              if (
                (min2 <= split2 && max2 >= split2) ||
                Math.sqrt(max2) - Math.sqrt(min2) > c.theta * 0.5 * bandWidth
              ) {
                accept = false;
                break;
              }
            }
        if (accept) {
          for (let t = 0; t < 4; t++) {
            const a = base + t * 4,
              n = m[a + 2];
            if (!n) continue;
            const x = minimumImage(m[a] / n - px),
              y = minimumImage(m[a + 1] / n - py),
              d = Math.hypot(x, y);
            if (!d) continue;
            const f =
              (force(d / c.radius, c.matrix[type * 4 + t]) * c.strength * n) /
              d;
            fx += f * x;
            fy += f * y;
            this.aggregated++;
          }
          node = escape;
        } else if (node < firstLeaf) node = node * 4 + 1;
        else {
          for (
            let j = this.heads[node - firstLeaf];
            j !== -1;
            j = this.next[j]
          ) {
            if (j === i) continue;
            const x = minimumImage(p[j * 2] - px),
              y = minimumImage(p[j * 2 + 1] - py),
              d2 = x * x + y * y;
            if (d2 === 0 || d2 >= r2) continue;
            const d = Math.sqrt(d2),
              f =
                (force(d / c.radius, c.matrix[type * 4 + s.types[j]]) *
                  c.strength) /
                d;
            fx += f * x;
            fy += f * y;
            this.directPairs++;
          }
          node = escape;
        }
      }
      this.forces[i * 2] = fx;
      this.forces[i * 2 + 1] = fy;
    }
    return this.forces;
  }
}
const trees = new WeakMap<State, BarnesHutTree>();
export function stepBarnesHut(s: State, c: Config) {
  let tree = trees.get(s);
  if (!tree || tree.count !== s.types.length) {
    tree = new BarnesHutTree(s.types.length);
    trees.set(s, tree);
  }
  const f = tree.calculate(s, c),
    damping = Math.exp(-c.friction / 60);
  for (let k = 0; k < s.positions.length; k += 2) {
    integrateVelocity(s.velocities, k, f[k], f[k + 1], damping, c);
    for (let axis = 0; axis < 2; axis++) {
      const p = s.positions[k + axis] + s.velocities[k + axis] / 60;
      s.positions[k + axis] = Math.min(1 - 1e-7, p - Math.floor(p));
    }
  }
  s.tick++;
}
