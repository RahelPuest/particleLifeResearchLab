import velocitySource from "./velocity.wgsl?raw";
import { initialComposition } from "./metabolic-model";
import { GPUProfiler } from "./gpu-profiler";
import { GPUParticleRenderer, GPUView } from "./gpu-renderer";
import { GPUMesh } from "./gpu-mesh";
import { GPUExact } from "./gpu-exact";
import source from "./barnes-hut.wgsl?raw";
import { Config, State } from "./simulation";
import { treeLayout } from "./barnes-hut";

export class GPUPhysics {
  private profiler?: GPUProfiler;
  private profiling = false;
  lastProfile: Record<string, number> | null = null;
  private renderer?: GPUParticleRenderer;
  private canvas?: OffscreenCanvas;
  private exact!: GPUExact;
  private mesh?: GPUMesh;
  private configKey = "";
  private tuningKey = "";
  selectedSolver: Config["solver"] = "grid-gpu";
  selectedTile = 64;
  tuning: { solver: string; tile: number; medianMs: number }[] = [];
  private types!: GPUBuffer;
  private pipelines = new Map<string, GPUComputePipeline>();
  private layout: GPUBindGroupLayout;
  private buffers: GPUBuffer[] = [];
  private particles: GPUBuffer[] = [];
  private composition: GPUBuffer[] = [];
  private metabolic = false;
  private groups: GPUBindGroup[] = [];
  private params!: GPUBuffer;
  private curves!: GPUBuffer;
  private moments!: GPUBuffer;
  private readback!: GPUBuffer;
  private topology!: ReturnType<typeof treeLayout>;
  private active = 0;
  private n = 0;
  private failure = "";
  private constructor(
    private device: GPUDevice,
    layout: GPUBindGroupLayout,
  ) {
    this.layout = layout;
    device.lost.then((info) => {
      this.failure = `WebGPU device lost: ${info.message || info.reason}`;
    });
    device.addEventListener("uncapturederror", (event) => {
      this.failure = (event as GPUUncapturedErrorEvent).error.message;
    });
  }
  static async create() {
    if (!navigator.gpu)
      throw new Error("WebGPU is not available in this browser.");
    const adapter = await navigator.gpu.requestAdapter({
      powerPreference: "high-performance",
    });
    if (!adapter) throw new Error("No WebGPU adapter is available.");
    const device = await adapter.requestDevice({
      requiredFeatures: adapter.features.has("timestamp-query")
        ? ["timestamp-query"]
        : [],
    });
    device.pushErrorScope("validation");
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
            "storage",
            "storage",
            "storage",
            "read-only-storage",
            "read-only-storage",
          ] as GPUBufferBindingType[]
        ).map((type, i) => ({
          binding: i + 1,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type },
        })),
      ],
    });
    const engine = new GPUPhysics(device, layout);
    if (device.features.has("timestamp-query"))
      engine.profiler = new GPUProfiler(device);
    try {
      const module = device.createShaderModule({
        code: source + "\n" + velocitySource,
        label: "Species-aware Barnes–Hut compute",
      });
      const compilation = await module.getCompilationInfo();
      const errors = compilation.messages.filter((m) => m.type === "error");
      if (errors.length)
        throw new Error(
          errors.map((m) => `${m.lineNum}: ${m.message}`).join("\n"),
        );
      const pipelineLayout = device.createPipelineLayout({
        bindGroupLayouts: [layout],
      });
      for (const entryPoint of [
        "clear",
        "insert",
        "leaves",
        "reduce",
        "advance",
        "pack",
      ]) {
        engine.pipelines.set(
          entryPoint,
          await device.createComputePipelineAsync({
            layout: pipelineLayout,
            compute: { module, entryPoint },
            label: entryPoint,
          }),
        );
      }
      engine.exact = await GPUExact.create(device);
      const error = await device.popErrorScope();
      if (error) throw new Error(error.message);
      return engine;
    } catch (error) {
      device.destroy();
      throw error;
    }
  }
  private buffer(size: number, usage: GPUBufferUsageFlags, label: string) {
    const b = this.device.createBuffer({
      size: Math.max(16, size),
      usage,
      label,
    });
    this.buffers.push(b);
    return b;
  }
  load(s: State) {
    this.check();
    this.renderer?.destroy();
    this.renderer = undefined;
    for (const b of this.buffers) b.destroy();
    this.buffers = [];
    this.mesh?.destroy();
    this.configKey = "";
    this.tuningKey = "";
    this.n = s.types.length;
    this.active = 0;
    this.topology = treeLayout(this.n);
    const usage =
      GPUBufferUsage.STORAGE |
      GPUBufferUsage.COPY_DST |
      GPUBufferUsage.COPY_SRC;
    this.particles = [
      this.buffer(this.n * 16, usage, "Particles A"),
      this.buffer(this.n * 16, usage, "Particles B"),
    ];
    this.metabolic = !!s.composition;
    this.composition = [
      this.buffer(this.n * 16, usage, "Composition A"),
      this.buffer(this.n * 16, usage, "Composition B"),
    ];
    const mixture = s.composition ?? initialComposition(s.types);
    for (const buffer of this.composition)
      this.device.queue.writeBuffer(buffer, 0, mixture);
    const packed = new Float32Array(this.n * 4);
    for (let i = 0; i < this.n; i++)
      packed.set(
        [
          s.positions[i * 2],
          s.positions[i * 2 + 1],
          s.velocities[i * 2],
          s.velocities[i * 2 + 1],
        ],
        i * 4,
      );
    this.device.queue.writeBuffer(this.particles[0], 0, packed);
    const types = (this.types = this.buffer(this.n * 4, usage, "Species"));
    this.device.queue.writeBuffer(types, 0, Uint32Array.from(s.types));
    const heads = this.buffer(this.topology.leaves * 4, usage, "Leaf heads"),
      links = this.buffer(this.n * 4, usage, "Particle links");
    this.moments = this.buffer(
      this.topology.nodes * 64,
      usage,
      "Species moments / display scratch",
    );
    const geometry = this.buffer(
      this.topology.geometry.byteLength,
      usage,
      "Static tree geometry",
    );
    this.device.queue.writeBuffer(geometry, 0, this.topology.geometry);
    this.curves = this.buffer(
      32 * 16,
      usage | GPUBufferUsage.UNIFORM,
      "Force curves",
    );
    this.params = this.buffer(
      256 * (this.topology.depth + 1),
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      "Per-level parameters",
    );
    // A paused backend switch can request a frame before the first compute step.
    this.device.queue.writeBuffer(
      this.params,
      0,
      new Uint32Array([
        this.n,
        this.topology.depth,
        this.topology.firstLeaf,
        this.topology.leaves,
        this.topology.nodes,
        0,
        0,
        0,
      ]),
    );
    this.readback = this.buffer(
      this.n * 32,
      GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
      "Readback",
    );
    this.groups = [0, 1].map((active) =>
      this.device.createBindGroup({
        layout: this.layout,
        entries: [
          { binding: 0, resource: { buffer: this.params, size: 48 } },
          ...[
            this.particles[active],
            this.particles[1 - active],
            types,
            heads,
            links,
            this.moments,
            geometry,
            this.curves,
          ].map((buffer, i) => ({ binding: i + 1, resource: { buffer } })),
        ],
      }),
    );
    this.exact.load(this.n, this.particles, types, this.curves, s.tick);
    if (this.canvas) this.attachCanvas(this.canvas);
  }
  attachCanvas(canvas: OffscreenCanvas) {
    if (this.canvas === canvas && this.renderer) return;
    this.canvas = canvas;
    this.renderer?.destroy();
    this.renderer = new GPUParticleRenderer(
      this.device,
      canvas,
      this.particles,
      this.types,
      this.composition,
    );
  }
  render(view: GPUView, advancing: boolean) {
    this.check();
    this.renderer?.draw(this.active, this.n, view, advancing);
    return !!this.renderer;
  }
  image() {
    return this.renderer?.image();
  }
  private check() {
    if (this.failure) throw new Error(this.failure);
  }
  private configure(c: Config) {
    const key = JSON.stringify([
      c.radius,
      c.strength,
      c.friction,
      c.theta,
      c.speedLimitEnabled,
      c.maxSpeed,
      c.matrix,
    ]);
    if (key === this.configKey) return;
    this.configKey = key;
    const { depth, firstLeaf, leaves, nodes } = this.topology;
    const memory = new ArrayBuffer(256 * (depth + 1)),
      u = new Uint32Array(memory),
      f = new Float32Array(memory);
    for (let slot = 0; slot <= depth; slot++) {
      const k = slot * 64,
        level = depth - slot;
      u.set(
        [
          this.n,
          depth,
          firstLeaf,
          leaves,
          nodes,
          slot ? (4 ** level - 1) / 3 : 0,
          slot ? 4 ** level : 0,
          0,
        ],
        k,
      );
      f[k + 7] = c.speedLimitEnabled ? c.maxSpeed : 0;
      f.set([c.radius, c.strength, Math.exp(-c.friction / 60), c.theta], k + 8);
    }
    this.device.queue.writeBuffer(this.params, 0, memory);
    const curves = new Float32Array(128);
    for (let i = 0; i < 16; i++)
      curves.set(
        [
          c.matrix[i].near,
          c.matrix[i].far,
          c.matrix[i].split,
          1 / (c.matrix[i].split - 0.08),
        ],
        i * 4,
      );
    for (let i = 0; i < 16; i++)
      curves[64 + i * 4] = 1 / (1 - c.matrix[i].split);
    this.device.queue.writeBuffer(this.curves, 0, curves);
  }
  private dispatch(
    encoder: GPUCommandEncoder,
    name: string,
    count: number,
    slot = 0,
  ) {
    const pass = encoder.beginComputePass({
      label: name,
      timestampWrites: this.profiling ? this.profiler?.pass(name) : undefined,
    });
    pass.setPipeline(this.pipelines.get(name)!);
    pass.setBindGroup(0, this.groups[this.active], [slot * 256]);
    pass.dispatchWorkgroups(Math.ceil(count / 64));
    pass.end();
  }
  synchronize() {
    return this.device.queue.onSubmittedWorkDone();
  }
  async step(c: Config, steps = 1, profile = false, tile = 64) {
    this.check();
    if (c.mode === "metabolic" && c.solver !== "mesh-gpu")
      throw new Error("Metabolic GPU mode requires particle mesh.");
    this.metabolic = c.mode === "metabolic";
    if (c.solver === "auto-gpu") {
      const key = [this.n, c.radius].join(",");
      if (key !== this.tuningKey) {
        const active = this.active;
        this.tuning = [];
        // All candidates read the same input buffer; one-step output is discarded.
        // No particle advances during calibration, and approximation is never selected.
        for (const [solver, tile] of [
          ["grid-gpu", 32],
          ["grid-gpu", 64],
          ["grid-gpu", 128],
          ["bvh-gpu", 64],
          ["all-pairs-gpu", 64],
        ] as const) {
          const times: number[] = [];
          for (let rep = 0; rep < 4; rep++) {
            this.active = active;
            const start = performance.now();
            await this.step({ ...c, solver }, 1, false, tile);
            if (rep) times.push(performance.now() - start);
          }
          times.sort((a, b) => a - b);
          this.tuning.push({ solver, tile, medianMs: times[1] });
        }
        this.active = active;
        this.tuning.sort((a, b) => a.medianMs - b.medianMs);
        this.selectedSolver = this.tuning[0].solver as Config["solver"];
        this.selectedTile = this.tuning[0].tile;
        this.tuningKey = key;
      }
      c = { ...c, solver: this.selectedSolver };
      tile = this.selectedTile;
    }

    this.exact.tileSize = tile;
    this.profiling = profile && !!this.profiler;
    this.lastProfile = null;
    if (this.profiling) this.profiler!.begin();
    this.configure(c);
    this.exact.configure(c);
    if (c.solver === "mesh-gpu") {
      this.mesh ??= await GPUMesh.create(this.device);
      this.mesh.configure(
        c,
        this.particles,
        this.types,
        this.curves,
        this.composition,
      );
    }
    const encoder = this.device.createCommandEncoder();
    for (let k = 0; k < steps; k++) {
      if (c.solver === "mesh-gpu") {
        this.mesh!.encode(
          encoder,
          c,
          this.active,
          this.profiling ? this.profiler : undefined,
        );
      } else if (c.solver.endsWith("-gpu") && c.solver !== "barnes-hut-gpu") {
        this.exact.encode(
          encoder,
          c,
          this.active,
          this.profiling ? this.profiler : undefined,
        );
      } else {
        this.dispatch(encoder, "clear", this.topology.leaves);
        this.dispatch(encoder, "insert", this.n);
        this.dispatch(encoder, "leaves", this.topology.leaves);
        for (let slot = 1; slot <= this.topology.depth; slot++)
          this.dispatch(
            encoder,
            "reduce",
            4 ** (this.topology.depth - slot),
            slot,
          );
        this.dispatch(encoder, "advance", this.n);
      }
      this.active = 1 - this.active;
    }
    if (this.profiling) this.profiler!.finish(encoder);
    this.device.queue.submit([encoder.finish()]);
    // One fence per bounded batch, never an unbounded GPU queue.
    await this.device.queue.onSubmittedWorkDone();
    this.check();
    if (this.profiling) this.lastProfile = await this.profiler!.read();
    this.profiling = false;
  }
  async readPositions(destination: Float32Array) {
    this.check();
    const encoder = this.device.createCommandEncoder();
    this.dispatch(encoder, "pack", Math.ceil(this.n / 2));
    const size = Math.ceil(this.n / 2) * 16;
    encoder.copyBufferToBuffer(this.moments, 0, this.readback, 0, size);
    this.device.queue.submit([encoder.finish()]);
    await this.readback.mapAsync(GPUMapMode.READ, 0, size);
    try {
      this.check();
      destination.set(
        new Float32Array(this.readback.getMappedRange(0, size), 0, this.n * 2),
      );
    } finally {
      this.readback.unmap();
    }
  }
  async downloadState(s: State) {
    this.check();
    const encoder = this.device.createCommandEncoder();
    encoder.copyBufferToBuffer(
      this.particles[this.active],
      0,
      this.readback,
      0,
      this.n * 16,
    );
    if (this.metabolic)
      encoder.copyBufferToBuffer(
        this.composition[this.active],
        0,
        this.readback,
        this.n * 16,
        this.n * 16,
      );
    this.device.queue.submit([encoder.finish()]);
    await this.readback.mapAsync(GPUMapMode.READ);
    try {
      this.check();
      const packed = new Float32Array(this.readback.getMappedRange());
      if (this.metabolic) {
        s.composition ??= new Float32Array(this.n * 4);
        s.composition.set(packed.subarray(this.n * 4, this.n * 8));
      }
      for (let i = 0; i < this.n; i++) {
        s.positions[i * 2] = packed[i * 4];
        s.positions[i * 2 + 1] = packed[i * 4 + 1];
        s.velocities[i * 2] = packed[i * 4 + 2];
        s.velocities[i * 2 + 1] = packed[i * 4 + 3];
      }
    } finally {
      this.readback.unmap();
    }
  }
  destroy() {
    this.renderer?.destroy();
    for (const buffer of this.buffers) buffer.destroy();
    this.exact.destroy();
    this.mesh?.destroy();
    this.profiler?.destroy();
    this.device.destroy();
  }
}
