import { particleSprites, mixtureKey, mixtureColor } from "./canvas-particles";
import { particleRadius, trailOpacity, type VisualSettings } from "./visuals";
import { useEffect, useRef, useState } from "react";
import { Camera, Maximize, Minus, Plus, Focus } from "lucide-react";
import { ParticleRenderer } from "./particle-renderer";
import { State } from "./engine/simulation";
export default function Viewport({
  state,
  trails,
  visuals,
  metabolic,
  worker,
  direct,
}: {
  state?: Pick<State, "positions" | "types" | "tick" | "composition"> & {
    speeds?: Float32Array;
  };
  trails: boolean;
  visuals: VisualSettings;
  metabolic: boolean;
  worker?: Worker;
  direct: boolean;
}) {
  const directCanvas = useRef<HTMLCanvasElement>(),
    directHolder = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!worker || !HTMLCanvasElement.prototype.transferControlToOffscreen)
      return;
    // A transferred canvas cannot be reused after worker replacement or HMR.
    const canvas = document.createElement("canvas");
    canvas.dataset.renderer = "webgpu";
    canvas.setAttribute("aria-hidden", "true");
    canvas.style.pointerEvents = "none";
    canvas.style.visibility = "hidden";
    directHolder.current!.appendChild(canvas);
    directCanvas.current = canvas;
    const offscreen = canvas.transferControlToOffscreen();
    worker.postMessage({ type: "canvas", canvas: offscreen }, [offscreen]);
    return () => {
      canvas.remove();
      directCanvas.current = undefined;
    };
  }, [worker]);
  useEffect(() => {
    if (directCanvas.current)
      directCanvas.current.style.visibility = direct ? "visible" : "hidden";
  }, [direct, worker]);
  const gpuCanvas = useRef<HTMLCanvasElement>(null),
    renderer = useRef<ParticleRenderer>(),
    [gpu, setGpu] = useState(false);
  const canvas = useRef<HTMLCanvasElement>(null),
    holder = useRef<HTMLDivElement>(null),
    last = useRef(-1);
  const [zoom, setZoom] = useState(1),
    [pan, setPan] = useState({ x: 0, y: 0 }),
    [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    if (!worker || !size.width || !size.height) return;
    const side = Math.min(size.width, size.height) * 0.86 * zoom;
    worker.postMessage({
      type: "view",
      view: {
        ...size,
        dpr: Math.min(devicePixelRatio || 1, 2),
        side,
        left: (size.width - side) / 2 + pan.x,
        top: (size.height - side) / 2 + pan.y,
        zoom,
        trails,
        visuals,
        metabolic,
      },
    });
  }, [worker, size, pan, zoom, trails, visuals, metabolic]);
  const spriteCache = useRef<{ key: string; sprites: HTMLCanvasElement[] }>();
  const drawKey = useRef("");
  const mixedSprites = useRef(new Map<string, HTMLCanvasElement>());
  const mixedStyle = useRef("");
  const drag = useRef<{ x: number; y: number; px: number; py: number }>();
  useEffect(() => {
    try {
      renderer.current = new ParticleRenderer(gpuCanvas.current!);
      setGpu(true);
    } catch (error) {
      console.warn(
        "Using Canvas 2D renderer:",
        error instanceof Error ? error.message : error,
      );
      setGpu(false);
    }
    const lost = (event: Event) => {
      event.preventDefault();
      renderer.current = undefined;
      setGpu(false);
    };
    const el = gpuCanvas.current!;
    el.addEventListener("webglcontextlost", lost);
    return () => {
      el.removeEventListener("webglcontextlost", lost);
      renderer.current?.destroy();
    };
  }, []);
  useEffect(() => {
    const ro = new ResizeObserver(([e]) =>
      setSize({ width: e.contentRect.width, height: e.contentRect.height }),
    );
    ro.observe(holder.current!);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    const c = canvas.current;
    if (!c || !size.width) return;
    const dpr = Math.min(devicePixelRatio || 1, 2);
    c.width = size.width * dpr;
    c.height = size.height * dpr;
    last.current = -1;
  }, [size]);
  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    if (direct || !state) {
      drawKey.current = "";
      last.current = -1;
      return;
    }
    const { width: w, height: h } = size;
    const advancing = state && state.tick > last.current;
    const side = Math.min(w, h) * 0.86 * zoom,
      left = (w - side) / 2 + pan.x,
      top = (h - side) / 2 + pan.y;
    const key = JSON.stringify([size, zoom, pan, visuals, gpu, metabolic]);
    const reset =
      key !== drawKey.current ||
      (state && state.tick < last.current) ||
      !trails;
    drawKey.current = key;
    if (visuals.color === "speed" && state && !state.speeds) {
      drawKey.current = "";
      return;
    }
    if (gpu && renderer.current && state && w && h) {
      renderer.current.draw(
        state.positions,
        state.types,
        w,
        h,
        side,
        left,
        top,
        zoom,
        !reset,
        visuals,
        state.speeds,
        !!advancing,
        state.composition,
      );
      last.current = state.tick;
      return;
    }
    if (!reset && !advancing) return;
    const ctx = c.getContext("2d")!;
    const dpr = Math.min(devicePixelRatio || 1, 2);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = !reset
      ? `rgba(8,16,20,${trailOpacity(visuals)})`
      : "#081014";
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = "#203037";
    ctx.lineWidth = 1;
    ctx.strokeRect(left, top, side, side);
    if (state) {
      const spriteKey = JSON.stringify([
        visuals.mode,
        visuals.color,
        visuals.intensity,
      ]);
      if (spriteCache.current?.key !== spriteKey)
        spriteCache.current = {
          key: spriteKey,
          sprites: particleSprites(visuals),
        };
      if (mixedStyle.current !== spriteKey) {
        mixedSprites.current.clear();
        mixedStyle.current = spriteKey;
      }
      const sprites = spriteCache.current.sprites,
        radius = particleRadius(zoom, visuals);
      if (visuals.mode === "glow" || visuals.mode === "field")
        ctx.globalCompositeOperation = "lighter";
      for (let i = 0; i < state.types.length; i++) {
        const x = left + state.positions[i * 2] * side,
          y = top + state.positions[i * 2 + 1] * side;
        if (x < -radius || y < -radius || x > w + radius || y > h + radius)
          continue;
        const speed = state.speeds?.[i] ?? 0;
        const color =
          visuals.color === "species"
            ? state.types[i]
            : visuals.color === "mono"
              ? 0
              : Math.round((31 * speed) / (1 + speed));
        let sprite = sprites[color];
        if (visuals.color === "species" && state.composition) {
          const key = mixtureKey(state.composition, i);
          if (!mixedSprites.current.has(key))
            mixedSprites.current.set(
              key,
              particleSprites(visuals, [mixtureColor(key)])[0],
            );
          sprite = mixedSprites.current.get(key)!;
        }
        ctx.drawImage(sprite, x - radius, y - radius, radius * 2, radius * 2);
      }
      ctx.globalCompositeOperation = "source-over";
      last.current = state.tick;
    }
  }, [state, trails, visuals, zoom, pan, size, gpu, direct, metabolic]);
  const changeZoom = (factor: number) =>
    setZoom((z) => Math.max(0.5, Math.min(5, z * factor)));
  function saveImage() {
    if (direct) {
      worker?.postMessage({ type: "image" });
      return;
    }
    const link = document.createElement("a");
    link.download = "particle-life.png";
    link.href = (gpu ? gpuCanvas.current! : canvas.current!).toDataURL();
    link.click();
  }
  return (
    <div className="viewport" ref={holder}>
      <div ref={directHolder} style={{ display: "contents" }} />
      <canvas
        data-renderer="webgl"
        ref={gpuCanvas}
        style={{
          visibility: gpu && !direct ? "visible" : "hidden",
          pointerEvents: "none",
        }}
        aria-hidden="true"
      />
      <canvas
        style={{ opacity: gpu || direct ? 0 : 1 }}
        ref={canvas}
        aria-label="Live particle simulation. Drag to pan and use the zoom controls."
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          drag.current = { x: e.clientX, y: e.clientY, px: pan.x, py: pan.y };
        }}
        onPointerMove={(e) => {
          if (drag.current)
            setPan({
              x: drag.current.px + e.clientX - drag.current.x,
              y: drag.current.py + e.clientY - drag.current.y,
            });
        }}
        onPointerUp={() => {
          drag.current = undefined;
        }}
        onPointerCancel={() => {
          drag.current = undefined;
        }}
        onWheel={(e) => changeZoom(e.deltaY > 0 ? 0.92 : 1.08)}
      />
      <div className="field-label">
        <span className="live-dot" /> PARTICLE FIELD{" "}
        <small>2D · Wrapping edges</small>
      </div>
      <div className="camera-tools">
        <button
          title="Zoom out"
          aria-label="Zoom out"
          onClick={() => changeZoom(0.8)}
        >
          <Minus size={16} />
        </button>
        <span>{Math.round(zoom * 100)}%</span>
        <button
          title="Zoom in"
          aria-label="Zoom in"
          onClick={() => changeZoom(1.25)}
        >
          <Plus size={16} />
        </button>
        <button
          title="Reset view"
          aria-label="Reset view"
          onClick={() => {
            setZoom(1);
            setPan({ x: 0, y: 0 });
          }}
        >
          <Focus size={16} />
        </button>
        <button title="Save image" aria-label="Save image" onClick={saveImage}>
          <Camera size={16} />
        </button>
        <button
          title="Fullscreen"
          aria-label="Fullscreen"
          onClick={() =>
            document.fullscreenElement
              ? document.exitFullscreen()
              : holder.current?.requestFullscreen()
          }
        >
          <Maximize size={16} />
        </button>
      </div>
      <div className="field-footer">
        Drag to explore{" "}
        <span>
          {direct
            ? "WebGPU · shared particle buffer"
            : gpu
              ? "GPU rendering"
              : "Canvas 2D"}{" "}
          · All particles
        </span>
      </div>
    </div>
  );
}
