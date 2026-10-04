import velocitySource from "./velocity.wgsl?raw";
import source from "./gpu-mesh.wgsl?raw";
import fftSource from "./gpu-mesh-fft.wgsl?raw";
import type { Config } from "./simulation";
import type { GPUProfiler } from "./gpu-profiler";

/** Periodic CIC particle-mesh with cached directed kernels and a direct collision core. */
export class GPUMesh {
  private pipelines = new Map<string, GPUComputePipeline>();
  private fftPipeline!: GPUComputePipeline;
  private buffers: GPUBuffer[] = [];
  private groups = new Map<string, GPUBindGroup[]>();
  private fftGroups = new Map<string, GPUBindGroup[]>();
  private params!: GPUBuffer;
  private reactions!: GPUBuffer;
  private reactionKey = "";
  private allocationKey = "";
  private configKey = "";
  private kernelKey = "";
  private kernelsDirty = true;
  private dim = 128;
  private coreDim = 96;
  private constructor(private device: GPUDevice) {}

  static async create(device: GPUDevice) {
    const mesh = new GPUMesh(device);
    for (const [code, entries] of [
      [
        source + "\n" + velocitySource,
        [
          "clear",
          "deposit",
          "densityInput",
          "kernelInput",
          "convolve",
          "advance",
          "convolveEnvironment",
          "react",
        ],
      ],
      [fftSource, ["fft"]],
    ] as const) {
      const module = device.createShaderModule({
        code,
        label: "Particle mesh",
      });
      const info = await module.getCompilationInfo();
      const errors = info.messages.filter((m) => m.type === "error");
      if (errors.length)
        throw new Error(
          errors.map((m) => `${m.lineNum}: ${m.message}`).join("\n"),
        );
      for (const entryPoint of entries) {
        const pipeline = await device.createComputePipelineAsync({
          layout: "auto",
          compute: { module, entryPoint },
          label: `mesh:${entryPoint}`,
        });
        if (entryPoint === "fft") mesh.fftPipeline = pipeline;
        else mesh.pipelines.set(entryPoint, pipeline);
      }
    }
    return mesh;
  }

  private buffer(size: number, uniform = false) {
    const buffer = this.device.createBuffer({
      size,
      usage:
        (uniform ? GPUBufferUsage.UNIFORM : GPUBufferUsage.STORAGE) |
        GPUBufferUsage.COPY_DST,
    });
    this.buffers.push(buffer);
    return buffer;
  }

  configure(
    c: Config,
    particles: GPUBuffer[],
    types: GPUBuffer,
    curves: GPUBuffer,
    composition: GPUBuffer[],
  ) {
    this.dim = c.meshResolution;
    this.coreDim = Math.floor(1 / (c.radius * 0.08));
    const allocation = [c.count, this.dim, this.coreDim].join(",");
    if (allocation !== this.allocationKey) {
      this.destroy();
      this.allocationKey = allocation;
      const cells = this.dim * this.dim;
      this.params = this.buffer(32, true);
      this.reactions = this.buffer(144, true);
      const density = this.buffer(cells * 4 * 4),
        heads = this.buffer(this.coreDim ** 2 * 4),
        links = this.buffer(c.count * 4);
      const spectrum = [
        this.buffer(cells * 4 * 16),
        this.buffer(cells * 4 * 16),
      ];
      const kernels = [
        this.buffer(cells * 17 * 16),
        this.buffer(cells * 17 * 16),
      ];
      const field = [this.buffer(cells * 4 * 16), this.buffer(cells * 4 * 16)];
      const environment = [
        this.buffer(cells * 4 * 16),
        this.buffer(cells * 4 * 16),
      ];
      const indices: Record<string, number[]> = {
        clear: [0, 5, 6],
        deposit: [0, 1, 3, 5, 6, 7, 11],
        densityInput: [0, 5, 8],
        kernelInput: [0, 4, 9],
        convolve: [0, 8, 9, 10],
        advance: [0, 1, 2, 3, 6, 7, 10, 11],
        convolveEnvironment: [0, 8, 9, 13],
        react: [0, 1, 11, 12, 13, 14],
      };
      for (const [name, bindings] of Object.entries(indices)) {
        this.groups.set(
          name,
          [0, 1].map((active) => {
            const resources = [
              this.params,
              particles[active],
              particles[1 - active],
              types,
              curves,
              density,
              heads,
              links,
              spectrum[0],
              kernels[0],
              field[0],
              composition[active],
              composition[1 - active],
              environment[0],
              this.reactions,
            ];
            return this.device.createBindGroup({
              layout: this.pipelines.get(name)!.getBindGroupLayout(0),
              entries: bindings.map((binding) => ({
                binding,
                resource: { buffer: resources[binding] },
              })),
            });
          }),
        );
      }
      for (const [name, buffers, inverse] of [
        ["density", spectrum, 0],
        ["kernel", kernels, 0],
        ["field", field, 1],
        ["environment", environment, 1],
      ] as const) {
        this.fftGroups.set(
          name,
          [0, 1].map((axis) => {
            const params = this.buffer(16, true);
            this.device.queue.writeBuffer(
              params,
              0,
              new Uint32Array([this.dim, Math.log2(this.dim), axis, inverse]),
            );
            return this.device.createBindGroup({
              layout: this.fftPipeline.getBindGroupLayout(0),
              entries: [params, buffers[axis], buffers[1 - axis]].map(
                (buffer, binding) => ({ binding, resource: { buffer } }),
              ),
            });
          }),
        );
      }
    }
    const key = [
      c.mode,
      c.count,
      this.dim,
      this.coreDim,
      c.radius,
      c.strength,
      c.friction,
      c.speedLimitEnabled,
      c.maxSpeed,
    ].join(",");
    if (key !== this.configKey) {
      const memory = new ArrayBuffer(32);
      new Uint32Array(memory).set([
        c.count,
        this.dim,
        this.coreDim,
        c.mode === "metabolic" ? 1 : 0,
      ]);
      new Float32Array(memory).set(
        [
          c.radius,
          c.strength,
          Math.exp(-c.friction / 60),
          c.speedLimitEnabled ? c.maxSpeed : 0,
        ],
        4,
      );
      this.device.queue.writeBuffer(this.params, 0, memory);
      this.configKey = key;
    }
    const reactionKey = JSON.stringify(c.metabolism);
    if (reactionKey !== this.reactionKey) {
      const values = new Float32Array(36);
      values.set([c.metabolism.rules.length, c.metabolism.rate, 0, 0]);
      c.metabolism.rules.forEach((r, i) =>
        values.set([r.from, r.to, r.catalyst, r.rate], 4 + i * 4),
      );
      this.device.queue.writeBuffer(this.reactions, 0, values);
      this.reactionKey = reactionKey;
    }
    const kernelKey = JSON.stringify([this.dim, c.radius, c.matrix]);
    if (kernelKey !== this.kernelKey) {
      this.kernelKey = kernelKey;
      this.kernelsDirty = true;
    }
  }

  encode(
    encoder: GPUCommandEncoder,
    c: Config,
    active: number,
    profiler?: GPUProfiler,
  ) {
    const dispatch = (name: string, n: number) => {
      const pass = encoder.beginComputePass({
        label: `mesh:${name}`,
        timestampWrites: profiler?.pass(`mesh:${name}`),
      });
      pass.setPipeline(this.pipelines.get(name)!);
      pass.setBindGroup(0, this.groups.get(name)![active]);
      pass.dispatchWorkgroups(Math.ceil(n / 64));
      pass.end();
    };
    const fft = (name: string, layers: number) => {
      for (let axis = 0; axis < 2; axis++) {
        const pass = encoder.beginComputePass({
          label: `mesh:${name}FFT`,
          timestampWrites: profiler?.pass(`mesh:${name}FFT`),
        });
        pass.setPipeline(this.fftPipeline);
        pass.setBindGroup(0, this.fftGroups.get(name)![axis]);
        pass.dispatchWorkgroups(this.dim, layers);
        pass.end();
      }
    };
    const cells = this.dim * this.dim;
    if (this.kernelsDirty) {
      dispatch("kernelInput", cells * 17);
      fft("kernel", 17);
      this.kernelsDirty = false;
    }
    dispatch("clear", Math.max(cells * 4, this.coreDim ** 2));
    dispatch("deposit", c.count);
    dispatch("densityInput", cells * 4);
    fft("density", 4);
    if (c.mode === "metabolic") {
      dispatch("convolveEnvironment", cells * 4);
      fft("environment", 4);
      dispatch("react", c.count);
    }
    dispatch("convolve", cells * 4);
    fft("field", 4);
    dispatch("advance", c.count);
  }

  destroy() {
    for (const buffer of this.buffers) buffer.destroy();
    this.buffers = [];
    this.groups.clear();
    this.fftGroups.clear();
    this.allocationKey =
      this.configKey =
      this.kernelKey =
      this.reactionKey =
        "";
    this.kernelsDirty = true;
  }
}
