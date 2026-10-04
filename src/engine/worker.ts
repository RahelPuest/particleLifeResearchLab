import { Config, DEFAULT, createState, step } from "./simulation";
import type { GPUView } from "./gpu-renderer";
import { GPUPhysics } from "./gpu-physics";
let config: Config = { ...DEFAULT },
  state = createState(config),
  running = true,
  visible = true,
  credit = 0;
let pool = Array.from({ length: 3 }, () => new Float32Array(config.count * 2));
let compositionPool: Float32Array[] = [];
let speedPool: Float32Array[] = [];
let last = performance.now(),
  lastFrame = 0,
  lastMeasure = last,
  measuredSteps = 0,
  stepMs = 0,
  stepsPerSecond = 0;
let frameWanted = true,
  typesWanted = true,
  lastDisplayTick = 0;
let gpu: GPUPhysics | undefined,
  usingGPU = false,
  gpuFailed = false,
  notice = "";
let renderCanvas: OffscreenCanvas | undefined,
  view: GPUView | undefined,
  lastRenderedTick = -1,
  lastCheckpoint = 0,
  lastMetadata = 0;
type Command = {
  type: string;
  config?: Config;
  running?: boolean;
  canvas?: OffscreenCanvas;
  view?: GPUView;
};
const commands: Command[] = [];
function status() {
  const solver =
    config.solver === "auto-gpu"
      ? (gpu?.selectedSolver ?? "grid-gpu")
      : config.solver;
  const backend = usingGPU
    ? config.mode === "metabolic"
      ? "WebGPU · metabolic particle mesh (approximate)"
      : solver === "barnes-hut-gpu"
        ? "WebGPU · Barnes–Hut"
        : solver === "bvh-gpu"
          ? "WebGPU · exact BVH"
          : solver === "all-pairs-gpu"
            ? "WebGPU · exact all-pairs"
            : solver === "mesh-gpu"
              ? "WebGPU · particle mesh (approximate)"
              : solver === "fast-gpu"
                ? "WebGPU · sampled"
                : "WebGPU · exact tiled grid"
    : config.mode === "metabolic"
      ? "CPU · exact mixed forces"
      : config.solver.startsWith("barnes-hut")
        ? "CPU · Barnes–Hut"
        : config.solver === "fast" || config.solver === "fast-gpu"
          ? "CPU · sampled"
          : "CPU · exact grid";
  postMessage({ type: "status", backend, notice });
}
function failGPU(error: unknown) {
  const wasRunning = usingGPU;
  usingGPU = false;
  gpuFailed = true;
  gpu?.destroy();
  gpu = undefined;
  if (wasRunning) {
    state.velocities.fill(0);
    state.tick = lastDisplayTick;
  }
  notice = `${error instanceof Error ? error.message : "WebGPU failed."} Using CPU ${config.mode === "metabolic" ? "exact mixed forces" : config.solver === "barnes-hut-gpu" ? "Barnes–Hut" : config.solver === "fast-gpu" ? "sampled" : "exact grid"}.${wasRunning ? " Continued from the latest recovery checkpoint with velocities reset." : ""}`;
  status();
}
async function selectSolver(reset = false) {
  const wantsGPU = config.solver.endsWith("-gpu");
  if (usingGPU && !wantsGPU && !reset) {
    try {
      await gpu!.downloadState(state);
    } catch (error) {
      failGPU(error);
    }
    usingGPU = false;
  }
  if (reset) usingGPU = false;
  if (wantsGPU && !usingGPU && !gpuFailed) {
    postMessage({
      type: "status",
      backend: "Initializing WebGPU…",
      notice: "",
    });
    try {
      gpu ??= await GPUPhysics.create();
      gpu.load(state);
      if (renderCanvas) gpu.attachCanvas(renderCanvas);
      usingGPU = true;
      notice = "";
    } catch (error) {
      failGPU(error);
    }
  }
  if (!wantsGPU) notice = "";
  status();
}
async function snapshot() {
  if (usingGPU && view && renderCanvas) {
    try {
      if (gpu!.render(view, state.tick > lastRenderedTick)) {
        lastRenderedTick = state.tick;
        // A low-frequency recovery checkpoint replaces per-frame readback.
        if (performance.now() - lastCheckpoint > 1000) {
          if (config.mode === "metabolic") await gpu!.downloadState(state);
          else await gpu!.readPositions(state.positions);
          lastDisplayTick = state.tick;
          lastCheckpoint = performance.now();
        }
        if (
          frameWanted ||
          typesWanted ||
          performance.now() - lastMetadata >= 100
        ) {
          postMessage({
            type: "frame",
            direct: true,
            tick: state.tick,
            types: typesWanted ? state.types : undefined,
            running,
            stepMs,
            stepsPerSecond,
          });
          lastMetadata = performance.now();
        }
        typesWanted = false;
        frameWanted = false;
        lastFrame = performance.now();
        return;
      }
    } catch (error) {
      failGPU(error);
    }
  }

  const positions = pool.pop();
  if (!positions) {
    frameWanted = true;
    return;
  }
  if (usingGPU) {
    try {
      if (view?.visuals?.color === "speed" || config.mode === "metabolic")
        await gpu!.downloadState(state);
      else await gpu!.readPositions(state.positions);
    } catch (error) {
      failGPU(error);
    }
  }
  let speeds: Float32Array | undefined;
  if (view?.visuals?.color === "speed") {
    speeds = speedPool.pop() ?? new Float32Array(config.count);
    for (let i = 0; i < config.count; i++)
      speeds[i] = Math.hypot(
        state.velocities[i * 2],
        state.velocities[i * 2 + 1],
      );
  }
  let composition: Float32Array | undefined;
  if (state.composition) {
    composition = compositionPool.pop() ?? new Float32Array(config.count * 4);
    composition.set(state.composition);
  }
  positions.set(state.positions);
  lastDisplayTick = state.tick;
  postMessage(
    {
      type: "frame",
      positions,
      speeds,
      composition,
      tick: state.tick,
      types: typesWanted ? state.types : undefined,
      running,
      stepMs,
      stepsPerSecond,
    },
    [
      positions.buffer,
      ...(speeds ? [speeds.buffer] : []),
      ...(composition ? [composition.buffer] : []),
    ],
  );
  typesWanted = false;
  frameWanted = false;
  lastFrame = performance.now();
}
async function advance(steps = 1) {
  const start = performance.now();
  if (usingGPU) {
    try {
      const oldSolver = gpu!.selectedSolver;
      await gpu!.step(config, steps);
      if (config.solver === "auto-gpu" && gpu!.selectedSolver !== oldSolver)
        status();
      state.tick += steps;
    } catch (error) {
      failGPU(error);
      step(state, config);
    }
  } else step(state, config);
  const elapsed = (performance.now() - start) / steps;
  stepMs = stepMs ? stepMs * 0.9 + elapsed * 0.1 : elapsed;
  measuredSteps += steps;
}
onmessage = (event: MessageEvent) => {
  const m = event.data;
  if (m.type === "recycle-composition") {
    if (m.buffer.byteLength === config.count * 16 && compositionPool.length < 3)
      compositionPool.push(new Float32Array(m.buffer));
    return;
  }
  if (m.type === "recycle-speed") {
    if (m.buffer.byteLength === config.count * 4 && speedPool.length < 3)
      speedPool.push(new Float32Array(m.buffer));
    return;
  }
  if (m.type === "recycle") {
    if (m.buffer.byteLength === state.positions.byteLength && pool.length < 3)
      pool.push(new Float32Array(m.buffer));
    return;
  }
  if (m.type === "visibility") {
    visible = m.visible;
    last = performance.now();
    credit = 0;
    return;
  }
  commands.push(m);
};
async function handle(m: Command) {
  if (m.type === "canvas") {
    renderCanvas = m.canvas;
    if (gpu && renderCanvas) gpu.attachCanvas(renderCanvas);
  }
  if (m.type === "view") {
    view = m.view;
    lastRenderedTick = -1;
  }
  if (m.type === "image") {
    if (usingGPU && view) {
      gpu!.render(view, false);
      const blob = await gpu!.image();
      if (blob) postMessage({ type: "image", blob });
    }
    return;
  }

  if (m.type === "config") {
    const changed = config.solver !== m.config!.solver;
    config = m.config!;
    if (changed) {
      gpuFailed = false;
      await selectSolver();
      credit = 0;
      last = performance.now();
    }
  }
  if (m.type === "reset") {
    config = m.config!;
    state = createState(config);
    credit = 0;
    stepMs = 0;
    stepsPerSecond = 0;
    measuredSteps = 0;
    lastDisplayTick = 0;
    lastMeasure = performance.now();
    pool = Array.from({ length: 3 }, () => new Float32Array(config.count * 2));
    speedPool = [];
    compositionPool = [];
    typesWanted = true;
    await selectSolver(true);
  }
  if (m.type === "running") {
    running = m.running!;
    credit = 0;
    last = performance.now();
    if (!running) stepsPerSecond = 0;
  }
  if (m.type === "step" && !running) await advance();
  frameWanted = true;
}
async function loop() {
  const started = performance.now();
  try {
    while (commands.length) await handle(commands.shift()!);
    const now = performance.now(),
      elapsed = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (running && visible) {
      credit = Math.min(6, credit + elapsed * 60 * config.speed);
      const start = performance.now();
      while (credit >= 1 && !commands.length) {
        const steps = usingGPU ? Math.min(3, Math.floor(credit)) : 1;
        await advance(steps);
        credit -= steps;
        if (performance.now() - start >= 8) break;
      }
    }
    if (
      frameWanted ||
      (running && visible && performance.now() - lastFrame >= 1000 / 30)
    )
      await snapshot();
    if (now - lastMeasure >= 500) {
      stepsPerSecond = (measuredSteps * 1000) / (now - lastMeasure);
      measuredSteps = 0;
      lastMeasure = now;
    }
  } catch (error) {
    running = false;
    postMessage({
      type: "error",
      message: error instanceof Error ? error.message : "Simulation failed.",
    });
  }
  setTimeout(
    loop,
    visible ? Math.max(1, 8 - (performance.now() - started)) : 100,
  );
}
status();
void loop();
