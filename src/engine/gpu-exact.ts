import velocitySource from "./velocity.wgsl?raw";
import type { GPUProfiler } from "./gpu-profiler";
import source from "./gpu-exact.wgsl?raw";
import type { Config } from "./simulation";

/** Exact directed forces, with interchangeable neighborhood search. */
export class GPUExact {
  tileSize = 64;
  private pipelines = new Map<string, GPUComputePipeline>();
  private buffers: GPUBuffer[] = [];
  private groups: GPUBindGroup[] = [];
  private indirect!: GPUBuffer;
  private indirectGroup!: GPUBindGroup;
  private params!: GPUBuffer;
  private leafBase = 1;
  private key = "";
  private constructor(
    private device: GPUDevice,
    private layout: GPUBindGroupLayout,
    private extra: GPUBindGroupLayout,
  ) {}
  static async create(device: GPUDevice) {
    const layout = device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.COMPUTE,
          buffer: {
            type: "uniform",
            hasDynamicOffset: true,
            minBindingSize: 48,
          },
        },
        ...(
          [
            "read-only-storage",
            "storage",
            "read-only-storage",
            "uniform",
            "storage",
            "storage",
            "storage",
            "storage",
          ] as GPUBufferBindingType[]
        ).map((type, i) => ({
          binding: i + 1,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type },
        })),
      ],
    });
    const extra = device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: "storage" },
        },
      ],
    });
    const e = new GPUExact(device, layout, extra);
    const module = device.createShaderModule({
      code: source + "\n" + velocitySource,
      label: "Exact tiled forces",
    });
    const info = await module.getCompilationInfo();
    const errors = info.messages.filter((m) => m.type === "error");
    if (errors.length)
      throw new Error(
        errors.map((m) => `${m.lineNum}: ${m.message}`).join("\n"),
      );
    const pl = device.createPipelineLayout({ bindGroupLayouts: [layout] });
    const prefixLayout = device.createPipelineLayout({
      bindGroupLayouts: [layout, extra],
    });
    await Promise.all(
      [
        "clear",
        "histogram",
        "prefix",
        "scatter",
        "grid",
        "leafBounds",
        "reduceBounds",
        "bvh",
        "allPairs",
        "sampled",
      ].map(async (entryPoint) =>
        e.pipelines.set(
          entryPoint,
          await device.createComputePipelineAsync({
            layout: entryPoint === "prefix" ? prefixLayout : pl,
            compute: { module, entryPoint },
            label: entryPoint,
          }),
        ),
      ),
    );
    for (const tile of [32, 128])
      for (const entryPoint of ["prefix", "grid"]) {
        e.pipelines.set(
          `${entryPoint}${tile}`,
          await device.createComputePipelineAsync({
            layout: entryPoint === "prefix" ? prefixLayout : pl,
            compute: { module, entryPoint, constants: { TILE: tile } },
            label: `${entryPoint}${tile}`,
          }),
        );
      }
    return e;
  }
  load(
    n: number,
    particles: GPUBuffer[],
    types: GPUBuffer,
    curves: GPUBuffer,
    tick = 0,
  ) {
    this.destroy();
    this.key = "";
    this.leafBase = 2 ** Math.ceil(Math.log2(Math.ceil(n / 64)));
    const buffer = (
      size: number,
      usage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    ) => {
      const b = this.device.createBuffer({ size, usage });
      this.buffers.push(b);
      return b;
    };
    this.params = buffer(
      256 * (1 + Math.log2(this.leafBase)),
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    );
    const counts = buffer(1025 * 4),
      ranges = buffer((2048 + Math.ceil(n / 32)) * 16),
      sorted = buffer(n * 32),
      bounds = buffer(this.leafBase * 2 * 16);
    this.device.queue.writeBuffer(counts, 1024 * 4, new Uint32Array([tick]));
    this.indirect = buffer(
      16,
      GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT,
    );
    this.indirectGroup = this.device.createBindGroup({
      layout: this.extra,
      entries: [{ binding: 0, resource: { buffer: this.indirect } }],
    });
    this.groups = [0, 1].map((active) =>
      this.device.createBindGroup({
        layout: this.layout,
        entries: [
          { binding: 0, resource: { buffer: this.params, size: 48 } },
          ...[
            particles[active],
            particles[1 - active],
            types,
            curves,
            counts,
            ranges,
            sorted,
            bounds,
          ].map((buffer, i) => ({ binding: i + 1, resource: { buffer } })),
        ],
      }),
    );
  }
  configure(c: Config) {
    const mode = c.solver === "bvh-gpu" ? 1 : 0,
      dim = mode ? 32 : Math.floor(1 / c.radius);
    const key = [
      c.count,
      c.radius,
      c.strength,
      c.friction,
      mode,
      c.seed,
      c.neighborBudget,
      c.speedLimitEnabled,
      c.maxSpeed,
    ].join(",");
    if (key === this.key) return;
    this.key = key;
    const memory = new ArrayBuffer(256 * (1 + Math.log2(this.leafBase))),
      u = new Uint32Array(memory),
      f = new Float32Array(memory);
    for (let slot = 0; slot <= Math.log2(this.leafBase); slot++) {
      const k = slot * 64;
      u.set([c.count, dim, dim * dim, mode], k);
      f.set([c.radius, c.strength, Math.exp(-c.friction / 60), 0], k + 4);
      u[k + 7] = c.seed;
      u.set(
        [this.leafBase, slot ? this.leafBase >> slot : 0, c.neighborBudget, 0],
        k + 8,
      );
      f[k + 11] = c.speedLimitEnabled ? c.maxSpeed : 0;
    }
    this.device.queue.writeBuffer(this.params, 0, memory);
  }
  encode(
    encoder: GPUCommandEncoder,
    c: Config,
    active: number,
    profiler?: GPUProfiler,
  ) {
    const dispatch = (
      name: string,
      groups: number,
      slot = 0,
      indirect = false,
    ) => {
      const pass = encoder.beginComputePass({
        label: `exact:${name}`,
        timestampWrites: profiler?.pass(name),
      });
      pass.setPipeline(this.pipelines.get(name)!);
      pass.setBindGroup(0, this.groups[active], [slot * 256]);
      if (name.startsWith("prefix")) pass.setBindGroup(1, this.indirectGroup);
      if (indirect) pass.dispatchWorkgroupsIndirect(this.indirect, 0);
      else pass.dispatchWorkgroups(groups);
      pass.end();
    };
    if (c.solver === "all-pairs-gpu") {
      dispatch("allPairs", Math.ceil(c.count / 64));
      return;
    }
    dispatch("clear", 16);
    dispatch("histogram", Math.ceil(c.count / 64));
    dispatch(this.tileSize === 64 ? "prefix" : `prefix${this.tileSize}`, 1);
    dispatch("scatter", Math.ceil(c.count / 64));
    if (c.solver === "bvh-gpu") {
      dispatch("leafBounds", this.leafBase);
      for (let slot = 1; slot <= Math.log2(this.leafBase); slot++)
        dispatch("reduceBounds", Math.ceil((this.leafBase >> slot) / 64), slot);
      dispatch("bvh", Math.ceil(c.count / 64));
    } else if (c.solver === "fast-gpu")
      dispatch("sampled", Math.ceil(c.count / 64));
    else
      dispatch(
        this.tileSize === 64 ? "grid" : `grid${this.tileSize}`,
        0,
        0,
        true,
      );
  }
  destroy() {
    for (const b of this.buffers) b.destroy();
    this.buffers = [];
  }
}
