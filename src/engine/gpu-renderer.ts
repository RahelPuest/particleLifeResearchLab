import {
  DEFAULT_VISUALS,
  visualMode,
  colorMode,
  particleRadius,
  trailOpacity,
  type VisualSettings,
} from "../visuals";
export type GPUView = {
  width: number;
  height: number;
  dpr: number;
  side: number;
  left: number;
  top: number;
  zoom: number;
  trails: boolean;
  visuals?: VisualSettings;
  metabolic?: boolean;
};
const source = `
struct View { rect:vec4<f32>, style:vec4<f32>, effects:vec4<f32> }
@group(0) @binding(0) var<storage,read> particles:array<vec4<f32>>;
@group(0) @binding(1) var<storage,read> species:array<u32>;
@group(0) @binding(2) var<uniform> view:View;
@group(0) @binding(3) var<storage,read> composition:array<vec4<f32>>;
struct Vertex { @builtin(position) position:vec4<f32>, @location(0) uv:vec2<f32>, @location(1) @interpolate(flat) color:vec3<f32> }
@vertex fn background(@builtin(vertex_index) i:u32)->Vertex{
 let uv=vec2<f32>(f32((i<<1u)&2u),f32(i&2u));return Vertex(vec4<f32>(uv*2.-1.,0.,1.),uv,vec3<f32>(0.));
}
@fragment fn fade(v:Vertex)->@location(0) vec4<f32>{
 let pixel=v.position.xy/view.style.w;let lo=view.rect.zw;let hi=lo+vec2<f32>(view.style.x);
 let inside=all(pixel>=lo-vec2<f32>(.5))&&all(pixel<=hi+vec2<f32>(.5));
 let edge=any(abs(pixel-lo)<vec2<f32>(.65))||any(abs(pixel-hi)<vec2<f32>(.65));
 if(inside&&edge){return vec4<f32>(.125,.188,.216,1.);}return vec4<f32>(.03137,.06275,.07843,view.style.z);
}
@vertex fn particle(@builtin(vertex_index) vi:u32,@builtin(instance_index) i:u32)->Vertex{
 let corners=array<vec2<f32>,6>(vec2<f32>(-1.,-1.),vec2<f32>(1.,-1.),vec2<f32>(-1.,1.),vec2<f32>(-1.,1.),vec2<f32>(1.,-1.),vec2<f32>(1.,1.));let uv=corners[vi];
 let pos=view.rect.zw+particles[i].xy*view.style.x+uv*view.style.y;
 let clip=pos/view.rect.xy*2.-1.;let colors=array<vec3<f32>,4>(vec3<f32>(.447,.898,.737),vec3<f32>(.941,.741,.443),vec3<f32>(.6,.612,.965),vec3<f32>(.929,.518,.616));
 var color=colors[species[i]];
 if(view.effects.w>.5){color=vec3<f32>(0.);let mix=composition[i];for(var k=0u;k<4u;k++){color+=mix[k]*colors[k];}}
 if(view.effects.y>1.5){color=vec3<f32>(.82,.93,1.);}else if(view.effects.y>.5){let speed=length(particles[i].zw);let t=speed/(1.+speed);color=vec3<f32>(.15+.85*t,.55+.2*t,1.-.9*t);}
 return Vertex(vec4<f32>(clip.x,-clip.y,0.,1.),uv,color);
}
@fragment fn dot(v:Vertex)->@location(0) vec4<f32>{let d=length(v.uv);if(d>1.){discard;}var alpha=1.-smoothstep(.6,1.,d);
 if(view.effects.x>2.5){alpha=exp(-4.*d*d)*(1.-smoothstep(.8,1.,d))*.09*view.effects.z;}
 else if(view.effects.x>1.5){alpha=smoothstep(.48,.65,d)*(1.-smoothstep(.8,1.,d));}
 else if(view.effects.x>.5){alpha=(exp(-7.*d*d)+.4*(1.-smoothstep(.05,.22,d)))*(1.-smoothstep(.8,1.,d))*view.effects.z;}
 return vec4<f32>(v.color,clamp(alpha,0.,1.));}
`;
export class GPUParticleRenderer {
  private context: GPUCanvasContext;
  private texture?: GPUTexture;
  private uniform: GPUBuffer;
  private groups: GPUBindGroup[];
  private dots: GPURenderPipeline;
  private fade: GPURenderPipeline;
  private additive: GPURenderPipeline;
  private viewKey = "";
  private width = 0;
  private height = 0;
  constructor(
    private device: GPUDevice,
    private canvas: OffscreenCanvas,
    particles: GPUBuffer[],
    types: GPUBuffer,
    composition: GPUBuffer[] = particles,
  ) {
    const context = canvas.getContext("webgpu");
    if (!context) throw new Error("Offscreen WebGPU rendering unavailable");
    this.context = context;
    const format = navigator.gpu.getPreferredCanvasFormat();
    context.configure({
      device,
      format,
      alphaMode: "opaque",
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_DST,
    });
    const module = device.createShaderModule({
      code: source,
      label: "GPU resident particle rendering",
    });
    const layout = device.createBindGroupLayout({
      entries: [
        {
          binding: 3,
          visibility: GPUShaderStage.VERTEX,
          buffer: { type: "read-only-storage" },
        },
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX,
          buffer: { type: "read-only-storage" },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.VERTEX,
          buffer: { type: "read-only-storage" },
        },
        {
          binding: 2,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: "uniform" },
        },
      ],
    });
    const pipelineLayout = device.createPipelineLayout({
      bindGroupLayouts: [layout],
    });
    const make = (vertex: string, fragment: string, additive = false) =>
      device.createRenderPipeline({
        layout: pipelineLayout,
        vertex: { module, entryPoint: vertex },
        fragment: {
          module,
          entryPoint: fragment,
          targets: [
            {
              format,
              blend: {
                color: {
                  srcFactor: "src-alpha",
                  dstFactor: additive ? "one" : "one-minus-src-alpha",
                },
                alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
              },
            },
          ],
        },
        primitive: { topology: "triangle-list" },
      });
    this.dots = make("particle", "dot");
    this.additive = make("particle", "dot", true);
    this.fade = make("background", "fade");
    this.uniform = device.createBuffer({
      size: 48,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.groups = particles.map((buffer, index) =>
      device.createBindGroup({
        layout,
        entries: [
          { binding: 0, resource: { buffer } },
          { binding: 1, resource: { buffer: types } },
          { binding: 2, resource: { buffer: this.uniform } },
          { binding: 3, resource: { buffer: composition[index] } },
        ],
      }),
    );
  }
  draw(active: number, count: number, v: GPUView, advancing: boolean) {
    const width = Math.max(1, Math.round(v.width * v.dpr)),
      height = Math.max(1, Math.round(v.height * v.dpr));
    const visuals = v.visuals ?? DEFAULT_VISUALS;
    const key = JSON.stringify([v.left, v.top, v.side, visuals, v.metabolic]);
    let reset = !v.trails || key !== this.viewKey;
    this.viewKey = key;
    if (width !== this.width || height !== this.height) {
      this.texture?.destroy();
      this.canvas.width = width;
      this.canvas.height = height;
      this.width = width;
      this.height = height;
      this.texture = this.device.createTexture({
        size: [width, height],
        format: navigator.gpu.getPreferredCanvasFormat(),
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
      });
      reset = true;
    }
    this.device.queue.writeBuffer(
      this.uniform,
      0,
      new Float32Array([
        v.width,
        v.height,
        v.left,
        v.top,
        v.side,
        particleRadius(v.zoom, visuals),
        reset ? 1 : advancing ? trailOpacity(visuals) : 0,
        v.dpr,
        visualMode(visuals),
        colorMode(visuals),
        visuals.intensity,
        v.metabolic ? 1 : 0,
      ]),
    );
    const encoder = this.device.createCommandEncoder({
      label: "GPU resident display",
    });
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: this.texture!.createView(),
          loadOp: reset ? "clear" : "load",
          storeOp: "store",
          clearValue: { r: 0.03137, g: 0.06275, b: 0.07843, a: 1 },
        },
      ],
    });
    pass.setBindGroup(0, this.groups[active]);
    pass.setPipeline(this.fade);
    pass.draw(3);
    pass.setPipeline(
      visuals.mode === "glow" || visuals.mode === "field"
        ? this.additive
        : this.dots,
    );
    if (reset || advancing) pass.draw(6, count);
    pass.end();
    encoder.copyTextureToTexture(
      { texture: this.texture! },
      { texture: this.context.getCurrentTexture() },
      [width, height],
    );
    this.device.queue.submit([encoder.finish()]);
  }
  async image() {
    // Read the persistent render target; presented offscreen swapchain images may
    // already be recycled when convertToBlob runs in a worker.
    if (!this.texture) throw new Error("No rendered frame is available");
    const bytesPerRow = Math.ceil((this.width * 4) / 256) * 256;
    const buffer = this.device.createBuffer({
      size: bytesPerRow * this.height,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    try {
      const encoder = this.device.createCommandEncoder();
      encoder.copyTextureToBuffer(
        { texture: this.texture },
        { buffer, bytesPerRow },
        [this.width, this.height],
      );
      this.device.queue.submit([encoder.finish()]);
      await buffer.mapAsync(GPUMapMode.READ);
      const source = new Uint8Array(buffer.getMappedRange()),
        pixels = new Uint8ClampedArray(this.width * this.height * 4),
        bgra = navigator.gpu.getPreferredCanvasFormat() === "bgra8unorm";
      for (let y = 0; y < this.height; y++)
        for (let x = 0; x < this.width; x++) {
          const a = y * bytesPerRow + x * 4,
            b = (y * this.width + x) * 4;
          pixels[b] = source[a + (bgra ? 2 : 0)];
          pixels[b + 1] = source[a + 1];
          pixels[b + 2] = source[a + (bgra ? 0 : 2)];
          pixels[b + 3] = 255;
        }
      buffer.unmap();
      const canvas = new OffscreenCanvas(this.width, this.height);
      canvas
        .getContext("2d")!
        .putImageData(new ImageData(pixels, this.width, this.height), 0, 0);
      return await canvas.convertToBlob({ type: "image/png" });
    } finally {
      buffer.destroy();
    }
  }
  destroy() {
    this.texture?.destroy();
    this.uniform.destroy();
    this.context.unconfigure();
  }
}
