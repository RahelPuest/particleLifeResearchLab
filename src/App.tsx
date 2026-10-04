import {
  DEFAULT_METABOLISM,
  balancedRandomRules,
  type Reaction,
} from "./engine/metabolic-model";
import type { VisualSettings } from "./visuals";
import { flushSync } from "react-dom";
import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  Atom,
  Play,
  Pause,
  RotateCcw,
  Shuffle,
  SkipForward,
  Download,
  Upload,
  SlidersHorizontal,
  ArrowUpRight,
} from "lucide-react";
import Viewport from "./Viewport";
import {
  COLORS,
  Config,
  DEFAULT,
  PRESETS,
  State,
  parseConfig,
  random,
  Interaction,
  force,
  CORE,
} from "./engine/simulation";
const Curve = memo(function Curve({
  curve,
  large = false,
}: {
  curve: Interaction;
  large?: boolean;
}) {
  const points = Array.from({ length: 161 }, (_, i) => {
    const r = i / 160;
    return `${10 + r * 280},${65 - force(r, curve) * 48}`;
  }).join(" ");
  return (
    <svg
      className={large ? "force-chart" : "mini-curve"}
      viewBox="0 0 300 140"
      role="img"
      aria-label={`Force curve: near ${curve.near}, far ${curve.far}, switch at ${Math.round(curve.split * 100)} percent of radius`}
    >
      {large && (
        <>
          <rect
            x="10"
            y="12"
            width={CORE * 280}
            height="106"
            fill="#ed849d12"
          />
          <text x="12" y="10">
            + attraction
          </text>
          <text x="12" y="132">
            − repulsion
          </text>
          <text x="235" y="132">
            distance →
          </text>
          <line
            x1={10 + curve.split * 280}
            x2={10 + curve.split * 280}
            y1="15"
            y2="116"
            stroke="#748b93"
            strokeDasharray="3 4"
          />
        </>
      )}
      <line x1="10" x2="290" y1="65" y2="65" stroke="#40565e" />
      <polyline
        points={points}
        fill="none"
        stroke="#8de8c7"
        strokeWidth={large ? 2 : 6}
      />
    </svg>
  );
});
const names = ["Mint", "Amber", "Lilac", "Rose"];
function download(config: Config) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(config, null, 2)], { type: "application/json" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = "particle-life-settings.json";
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export default function App() {
  const [config, setConfig] = useState<Config>(() => ({
      ...DEFAULT,
      matrix: [...DEFAULT.matrix],
    })),
    [state, setState] = useState<
      Pick<State, "positions" | "types" | "tick" | "composition"> & {
        speeds?: Float32Array;
      }
    >(),
    [running, setRunning] = useState(true),
    [preset, setPreset] = useState("Living cells"),
    [error, setError] = useState(""),
    [selected, setSelected] = useState(1),
    [metrics, setMetrics] = useState({ stepMs: 0, stepsPerSecond: 0 }),
    [backend, setBackend] = useState("CPU · exact grid"),
    [backendNotice, setBackendNotice] = useState("");
  const [transport, setTransport] = useState<Worker>(),
    [directRendering, setDirectRendering] = useState(false);
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = config.theme;
    return () => {
      delete document.documentElement.dataset.theme;
    };
  }, [config.theme]);
  const worker = useRef<Worker>(),
    file = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const w = new Worker(new URL("./engine/worker.ts", import.meta.url), {
      type: "module",
    });
    worker.current = w;
    setTransport(w);
    let types = new Uint8Array();
    w.onmessage = (e) => {
      if (e.data.type === "image") {
        const url = URL.createObjectURL(e.data.blob),
          a = document.createElement("a");
        a.href = url;
        a.download = "particle-life.png";
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        return;
      }

      if (e.data.type === "status") {
        setBackend(e.data.backend);
        setBackendNotice(e.data.notice);
        return;
      }
      if (e.data.type === "error") {
        setError(e.data.message);
        return;
      }
      if (e.data.types) types = e.data.types;
      // Commit each transferred frame so React cannot discard a buffer before recycling it.
      flushSync(() => {
        setDirectRendering(!!e.data.direct);
        setState({
          positions: e.data.positions ?? new Float32Array(0),
          types,
          speeds: e.data.speeds,
          composition: e.data.composition,
          tick: e.data.tick,
        });
        setMetrics({
          stepMs: e.data.stepMs,
          stepsPerSecond: e.data.stepsPerSecond,
        });
        setRunning(e.data.running);
      });
    };
    w.onerror = () =>
      setError("The simulation stopped. Reload the page to restart.");
    const visibility = () =>
      w.postMessage({ type: "visibility", visible: !document.hidden });
    document.addEventListener("visibilitychange", visibility);
    visibility();
    return () => {
      document.removeEventListener("visibilitychange", visibility);
      w.terminate();
    };
  }, []);
  useEffect(() => {
    worker.current?.postMessage({ type: "config", config });
  }, [config]);
  useLayoutEffect(
    () => () => {
      if (state?.composition?.buffer.byteLength) {
        const buffer = state.composition.buffer;
        worker.current?.postMessage({ type: "recycle-composition", buffer }, [
          buffer,
        ]);
      }
      if (state?.speeds?.buffer.byteLength) {
        const buffer = state.speeds.buffer;
        worker.current?.postMessage({ type: "recycle-speed", buffer }, [
          buffer,
        ]);
      }
      if (state?.positions.buffer.byteLength) {
        const buffer = state.positions.buffer;
        worker.current?.postMessage({ type: "recycle", buffer }, [buffer]);
      }
    },
    [state],
  );
  function changeMode(mode: Config["mode"]) {
    const c: Config = {
      ...config,
      mode,
      solver: mode === "metabolic" ? "mesh-gpu" : "exact",
    };
    setConfig(c);
    reset(c);
  }
  function updateRule(index: number, patch: Partial<Reaction>) {
    setConfig((c) => ({
      ...c,
      metabolism: {
        ...c.metabolism,
        rules: c.metabolism.rules.map((rule, i) => {
          if (i !== index) return rule;
          const r = { ...rule, ...patch };
          if (r.from === r.to) {
            if (patch.from !== undefined) r.to = (r.from + 1) % 4;
            else r.from = (r.to + 1) % 4;
          }
          return r;
        }),
      },
    }));
  }
  function updateVisual<K extends keyof VisualSettings>(
    key: K,
    value: VisualSettings[K],
  ) {
    setConfig((c) => ({ ...c, visuals: { ...c.visuals, [key]: value } }));
  }
  function update(key: keyof Config, value: number) {
    setConfig((c) => ({ ...c, [key]: value }));
  }
  function reset(c = config) {
    setState(undefined);
    worker.current?.postMessage({ type: "reset", config: c });
  }
  function newSeed() {
    const c = { ...config, seed: Math.floor(Math.random() * 4294967295) };
    setConfig(c);
    reset(c);
  }
  function selectPreset(value: string) {
    setPreset(value);
    if (PRESETS[value])
      setConfig((c) => ({ ...c, matrix: [...PRESETS[value]] }));
  }
  function shuffle() {
    const rng = random(Date.now());
    setConfig((c) => ({
      ...c,
      matrix: Array.from({ length: 16 }, () => ({
        near: Math.round((rng() * 2 - 1) * 100) / 100,
        far: Math.round((rng() * 2 - 1) * 100) / 100,
        split: Math.round((0.2 + rng() * 0.6) * 100) / 100,
      })),
    }));
    setPreset("Custom");
  }
  function updateCurve(key: keyof Interaction, value: number) {
    setConfig((c) => ({
      ...c,
      matrix: c.matrix.map((curve, i) =>
        i === selected ? { ...curve, [key]: value } : curve,
      ),
    }));
    setPreset("Custom");
  }
  const curve = config.matrix[selected];
  async function importFile(f?: File) {
    if (!f) return;
    try {
      if (f.size > 20000) throw new Error("Settings file is too large.");
      const c = parseConfig(JSON.parse(await f.text()));
      setConfig(c);
      setPreset("Custom");
      reset(c);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load settings.");
    }
    if (file.current) file.current.value = "";
  }
  return (
    <div className="app">
      <header>
        <a className="brand" href="./">
          <span className="brand-icon">
            <Atom size={23} />
          </span>
          <span>
            Particle Life<small>AN INTERACTIVE PLAYGROUND</small>
          </span>
        </a>
        <div className="header-note">
          <span className="live-dot" /> A little universe, in your browser
        </div>
        <div className="header-actions">
          <label className="theme-picker">
            <span>Theme</span>
            <select
              aria-label="Interface theme"
              value={config.theme}
              onChange={(e) =>
                setConfig((c) => ({
                  ...c,
                  theme: e.target.value as Config["theme"],
                }))
              }
            >
              <option value="classic">Classic</option>
              <option value="glass-dark">Glass · Dark</option>
              <option value="glass-light">Glass · Light</option>
            </select>
          </label>
          <button className="quiet" onClick={() => download(config)}>
            <Download size={16} /> Save settings
          </button>
        </div>
      </header>
      <main>
        <div className="workspace">
          <section className="simulation panel">
            <div className="simulation-bar">
              <div>
                <span className={running ? "live-dot" : "paused-dot"} />
                <strong>
                  {state ? (running ? "Running" : "Paused") : "Starting…"}
                </strong>
                <span className="muted">
                  {(state?.types.length ?? config.count).toLocaleString()}{" "}
                  particles
                </span>
              </div>
              <div className="transport">
                <button
                  aria-label="Reset simulation"
                  title="Reset simulation with the same seed"
                  disabled={!state}
                  onClick={() => reset()}
                >
                  <RotateCcw size={17} />
                </button>
                <button
                  aria-label="Step simulation"
                  title="Advance one step"
                  disabled={running || !state}
                  onClick={() => worker.current?.postMessage({ type: "step" })}
                >
                  <SkipForward size={17} />
                </button>
                <button
                  className="primary"
                  disabled={!state}
                  onClick={() =>
                    worker.current?.postMessage({
                      type: "running",
                      running: !running,
                    })
                  }
                >
                  {running ? <Pause size={15} /> : <Play size={15} />}{" "}
                  {running ? "Pause" : "Resume"}
                </button>
              </div>
            </div>
            <Viewport
              state={state}
              trails={config.visuals.trails}
              visuals={config.visuals}
              metabolic={config.mode === "metabolic"}
              worker={transport}
              direct={directRendering}
            />
            <div className="simulation-bottom">
              <span>
                <b>{((state?.tick ?? 0) / 60).toFixed(1)}s</b> simulated
              </span>
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={config.visuals.trails}
                  onChange={(e) => updateVisual("trails", e.target.checked)}
                />{" "}
                Motion trails
              </label>
              <button className="text-button" onClick={newSeed}>
                <Shuffle size={14} /> New arrangement
              </button>
            </div>
          </section>
          <aside>
            <section className="panel settings">
              <div className="section-title">
                <h2>Simulation mode</h2>
                <span className="tag">OPTIONAL</span>
              </div>
              <label className="select-label">
                Mode
                <select
                  aria-label="Simulation mode"
                  value={config.mode}
                  onChange={(e) => changeMode(e.target.value as Config["mode"])}
                >
                  <option value="classic">Classic Particle Life</option>
                  <option value="metabolic">Metabolic · mixed species</option>
                </select>
              </label>
              <p className="performance">
                Switching mode restarts the seeded arrangement. Classic keeps
                fixed species.
              </p>
              {config.mode === "metabolic" && (
                <>
                  <p className="performance">
                    Each particle is a mixture of A–D. Nearby catalysts convert
                    one share into another without being consumed. Forces and
                    species colors blend both particles’ shares.
                  </p>
                  <label className="slider-label">
                    <span>
                      Conversion speed
                      <output>{config.metabolism.rate.toFixed(1)}×</output>
                    </span>
                    <input
                      aria-label="Conversion speed"
                      type="range"
                      min="0"
                      max="3"
                      step="0.1"
                      value={config.metabolism.rate}
                      onChange={(e) =>
                        setConfig((c) => ({
                          ...c,
                          metabolism: {
                            ...c.metabolism,
                            rate: +e.target.value,
                          },
                        }))
                      }
                    />
                  </label>
                  <label className="slider-label">
                    <span>
                      Initial mixing
                      <output>
                        {Math.round(config.metabolism.initialMix * 100)}%
                      </output>
                    </span>
                    <input
                      aria-label="Initial mixing"
                      type="range"
                      min="0"
                      max="1"
                      step="0.05"
                      value={config.metabolism.initialMix}
                      onChange={(e) =>
                        setConfig((c) => ({
                          ...c,
                          metabolism: {
                            ...c.metabolism,
                            initialMix: +e.target.value,
                          },
                        }))
                      }
                    />
                  </label>
                  <p className="performance">
                    Initial mixing applies on reset: 0% starts pure; 100% starts
                    with 25% of each species. Reaction range follows the
                    interaction radius.
                  </p>
                  <button
                    className="text-button"
                    onClick={() => {
                      const rules = balancedRandomRules();
                      setConfig((c) => ({
                        ...c,
                        metabolism: { ...c.metabolism, rules },
                      }));
                    }}
                  >
                    <Shuffle size={14} /> Randomize rules
                  </button>
                  <p className="performance">
                    Generates eight balanced rules: equal base inflow and
                    outflow for each species, with a spontaneous return cycle.
                    Local catalyst availability can still shift the balance.
                  </p>
                  <div className="reaction-list">
                    {config.metabolism.rules.map((r, i) => (
                      <div className="reaction-rule" key={i}>
                        <div className="reaction-heading">
                          Rule {i + 1}
                          <button
                            className="text-button"
                            aria-label={`Remove rule ${i + 1}`}
                            onClick={() =>
                              setConfig((c) => ({
                                ...c,
                                metabolism: {
                                  ...c.metabolism,
                                  rules: c.metabolism.rules.filter(
                                    (_, index) => index !== i,
                                  ),
                                },
                              }))
                            }
                          >
                            Remove
                          </button>
                        </div>
                        <label>
                          From
                          <select
                            aria-label={`Rule ${i + 1} source`}
                            value={r.from}
                            onChange={(e) =>
                              updateRule(i, { from: +e.target.value })
                            }
                          >
                            {["A", "B", "C", "D"].map((v, k) => (
                              <option value={k} key={v}>
                                {v}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label>
                          To
                          <select
                            aria-label={`Rule ${i + 1} target`}
                            value={r.to}
                            onChange={(e) =>
                              updateRule(i, { to: +e.target.value })
                            }
                          >
                            {["A", "B", "C", "D"].map((v, k) => (
                              <option value={k} key={v}>
                                {v}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label>
                          Triggered by
                          <select
                            aria-label={`Rule ${i + 1} catalyst`}
                            value={r.catalyst}
                            onChange={(e) =>
                              updateRule(i, { catalyst: +e.target.value })
                            }
                          >
                            <option value={-1}>Always</option>
                            {["A", "B", "C", "D"].map((v, k) => (
                              <option value={k} key={v}>
                                Nearby {v}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label>
                          Rate / second
                          <input
                            aria-label={`Rule ${i + 1} rate`}
                            type="number"
                            min="0"
                            max="3"
                            step="0.05"
                            value={r.rate}
                            onChange={(e) => {
                              const rate = +e.target.value;
                              if (
                                Number.isFinite(rate) &&
                                rate >= 0 &&
                                rate <= 3
                              )
                                updateRule(i, { rate });
                            }}
                          />
                        </label>
                      </div>
                    ))}
                  </div>
                  <button
                    className="text-button"
                    disabled={config.metabolism.rules.length >= 8}
                    onClick={() =>
                      setConfig((c) => ({
                        ...c,
                        metabolism: {
                          ...c.metabolism,
                          rules: [
                            ...c.metabolism.rules,
                            { from: 0, to: 1, catalyst: 2, rate: 0.25 },
                          ],
                        },
                      }))
                    }
                  >
                    Add conversion rule
                  </button>
                  <button
                    className="text-button"
                    onClick={() =>
                      setConfig((c) => ({
                        ...c,
                        metabolism: structuredClone(DEFAULT_METABOLISM),
                      }))
                    }
                  >
                    Reset conversion rules
                  </button>
                  <p className="performance">
                    Use Particle mesh for GPU acceleration or Exact for CPU
                    reference forces. Field-based forces and catalyst
                    neighborhoods are approximate.
                  </p>
                </>
              )}
            </section>
            <section className="panel settings">
              <div className="section-title">
                <h2>Appearance</h2>
                <span className="tag">LIVE VISUALS</span>
              </div>
              <label className="select-label">
                Visualization
                <select
                  aria-label="Visualization"
                  value={config.visuals.mode}
                  onChange={(e) =>
                    updateVisual(
                      "mode",
                      e.target.value as VisualSettings["mode"],
                    )
                  }
                >
                  <option value="dots">Particles</option>
                  <option value="glow">Neon glow</option>
                  <option value="rings">Rings</option>
                  <option value="field">Light field</option>
                </select>
              </label>
              <label className="select-label">
                Color by
                <select
                  aria-label="Color by"
                  value={config.visuals.color}
                  onChange={(e) =>
                    updateVisual(
                      "color",
                      e.target.value as VisualSettings["color"],
                    )
                  }
                >
                  <option value="species">Species</option>
                  <option value="speed">Speed</option>
                  <option value="mono">Ice monochrome</option>
                </select>
              </label>
              {config.visuals.color === "speed" && (
                <p className="performance">
                  Blue → amber as speed increases. Fixed scale in world widths
                  per second.
                </p>
              )}
              {config.visuals.mode === "field" && (
                <p className="performance">
                  Soft additive light reveals overlapping groups. Brightness is
                  a visual effect, not a calibrated density measurement.
                </p>
              )}
              <label className="slider-label">
                <span>
                  Particle size
                  <output>{config.visuals.size.toFixed(1)}×</output>
                </span>
                <input
                  aria-label="Particle size"
                  type="range"
                  min="0.5"
                  max="3"
                  step="0.1"
                  value={config.visuals.size}
                  onChange={(e) => updateVisual("size", +e.target.value)}
                />
              </label>
              {(config.visuals.mode === "glow" ||
                config.visuals.mode === "field") && (
                <label className="slider-label">
                  <span>
                    Light intensity
                    <output>{config.visuals.intensity.toFixed(1)}×</output>
                  </span>
                  <input
                    aria-label="Light intensity"
                    type="range"
                    min="0.2"
                    max="2"
                    step="0.1"
                    value={config.visuals.intensity}
                    onChange={(e) => updateVisual("intensity", +e.target.value)}
                  />
                </label>
              )}
              <label className="slider-label">
                <span>
                  Trail persistence
                  <output>
                    {Math.round(config.visuals.persistence * 100)}%
                  </output>
                </span>
                <input
                  aria-label="Trail persistence"
                  type="range"
                  min="0"
                  max="1"
                  step="0.05"
                  disabled={!config.visuals.trails}
                  value={config.visuals.persistence}
                  onChange={(e) => updateVisual("persistence", +e.target.value)}
                />
              </label>
            </section>
            <section className="panel settings">
              <div className="section-title">
                <h2>
                  <SlidersHorizontal size={16} /> Simulation
                </h2>
                <span className="tag">LIVE CONTROLS</span>
              </div>
              <label className="select-label">
                Rule preset
                <select
                  aria-label="Rule preset"
                  value={preset}
                  onChange={(e) => selectPreset(e.target.value)}
                >
                  {Object.keys(PRESETS).map((x) => (
                    <option key={x}>{x}</option>
                  ))}
                  <option>Custom</option>
                </select>
              </label>
              <label className="select-label">
                Force calculation
                <select
                  aria-label="Force calculation"
                  value={config.solver}
                  onChange={(e) =>
                    setConfig((c) => ({
                      ...c,
                      solver: e.target.value as Config["solver"],
                    }))
                  }
                >
                  <option value="exact">Exact · all neighbors</option>
                  <option
                    disabled={config.mode === "metabolic"}
                    value="auto-gpu"
                  >
                    Automatic exact · WebGPU
                  </option>
                  <option
                    disabled={config.mode === "metabolic"}
                    value="grid-gpu"
                  >
                    Exact tiled grid · WebGPU
                  </option>
                  <option
                    disabled={config.mode === "metabolic"}
                    value="bvh-gpu"
                  >
                    Exact BVH · WebGPU
                  </option>
                  <option
                    disabled={config.mode === "metabolic"}
                    value="all-pairs-gpu"
                  >
                    Exact all-pairs · WebGPU
                  </option>
                  <option value="mesh-gpu">
                    Particle mesh · approximate WebGPU
                  </option>
                  <option
                    disabled={config.mode === "metabolic"}
                    value="fast-gpu"
                  >
                    Fast · sampled WebGPU
                  </option>
                  <option disabled={config.mode === "metabolic"} value="fast">
                    Fast · sampled neighbors
                  </option>
                  <option
                    disabled={config.mode === "metabolic"}
                    value="barnes-hut"
                  >
                    Barnes–Hut · CPU
                  </option>
                  <option
                    disabled={config.mode === "metabolic"}
                    value="barnes-hut-gpu"
                  >
                    Barnes–Hut · WebGPU
                  </option>
                </select>
              </label>
              {config.solver === "mesh-gpu" && (
                <label className="select-label">
                  Field resolution
                  <select
                    aria-label="Field resolution"
                    value={config.meshResolution}
                    onChange={(e) => update("meshResolution", +e.target.value)}
                  >
                    {[64, 128, 256].map((n) => (
                      <option key={n} value={n}>
                        {n} × {n}
                      </option>
                    ))}
                  </select>
                  <p className="performance">
                    Approximate outer forces, exact collision core. Finer fields
                    preserve smaller structures but cost more. Use 256 for short
                    ranges or narrow force bands.
                  </p>
                </label>
              )}
              {config.solver.startsWith("barnes-hut") && (
                <label className="slider-label">
                  <span>
                    Opening angle θ<output>{config.theta.toFixed(2)}</output>
                  </span>
                  <input
                    aria-label="Opening angle"
                    type="range"
                    min="0"
                    max="1.2"
                    step="0.05"
                    value={config.theta}
                    onChange={(e) => update("theta", +e.target.value)}
                  />
                  <p className="performance">
                    Lower θ is more accurate; higher θ groups more particles. At
                    0, every interaction is exact. Species and force-band
                    boundaries are kept separate.
                  </p>
                </label>
              )}
              <p
                className="compute-backend"
                role="status"
                aria-label="Physics backend"
              >
                {backend}
              </p>
              {backendNotice && (
                <p className="backend-notice" role="status">
                  {backendNotice}
                </p>
              )}
              {(config.solver === "fast" || config.solver === "fast-gpu") && (
                <label className="select-label">
                  Neighbor samples
                  <select
                    aria-label="Neighbor samples"
                    value={config.neighborBudget}
                    onChange={(e) => update("neighborBudget", +e.target.value)}
                  >
                    {[32, 64, 128, 256, 512, 1024].map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </select>
                  <p className="performance">
                    Approximate forces: fewer samples run faster, but introduce
                    more noise and change the dynamics.
                  </p>
                </label>
              )}
              <label className="slider-label">
                <span>
                  Particles <output>{config.count.toLocaleString()}</output>
                </span>
                <input
                  aria-label="Particles"
                  type="range"
                  min="100"
                  max="50000"
                  step="100"
                  value={config.count}
                  onChange={(e) => {
                    const c = { ...config, count: +e.target.value };
                    setConfig(c);
                    reset(c);
                  }}
                />
              </label>
              {(
                [
                  {
                    key: "radius",
                    label: "Interaction radius",
                    min: 0.04,
                    max: 0.25,
                    step: 0.01,
                    display: `${Math.round(config.radius * 100)}%`,
                  },
                  {
                    key: "strength",
                    label: "Force strength",
                    min: 0.1,
                    max: 3,
                    step: 0.1,
                    display: config.strength.toFixed(1),
                  },
                  {
                    key: "friction",
                    label: "Friction",
                    min: 1,
                    max: 12,
                    step: 0.5,
                    display: config.friction.toFixed(1),
                  },
                  {
                    key: "speed",
                    label: "Simulation speed",
                    min: 0.25,
                    max: 3,
                    step: 0.25,
                    display: `${config.speed}×`,
                  },
                ] as const
              ).map((s) => (
                <label className="slider-label" key={s.key}>
                  <span>
                    {s.label}
                    <output>{s.display}</output>
                  </span>
                  <input
                    aria-label={s.label}
                    type="range"
                    min={s.min}
                    max={s.max}
                    step={s.step}
                    value={config[s.key]}
                    onChange={(e) => update(s.key, +e.target.value)}
                  />
                </label>
              ))}
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={config.speedLimitEnabled}
                  onChange={(e) =>
                    setConfig((c) => ({
                      ...c,
                      speedLimitEnabled: e.target.checked,
                    }))
                  }
                />
                Soft speed limit
              </label>
              <label className="slider-label">
                <span>
                  Maximum particle speed{" "}
                  <output>{config.maxSpeed.toFixed(2)} world widths/s</output>
                </span>
                <input
                  aria-label="Maximum particle speed"
                  type="range"
                  min="0.05"
                  max="5"
                  step="0.05"
                  disabled={!config.speedLimitEnabled}
                  value={config.maxSpeed}
                  onChange={(e) => update("maxSpeed", +e.target.value)}
                />
                <p className="performance">
                  Smoothly approaches the limit without reaching it. Applies to
                  particle motion, independently of simulation playback speed.
                </p>
              </label>
              <p className="performance" aria-live="off">
                {metrics.stepMs.toFixed(1)} ms / step ·{" "}
                {metrics.stepsPerSecond.toFixed(0)} steps / s<br />
                High counts and large radii can reduce simulation speed.
              </p>
            </section>
            <section className="panel interactions">
              <div className="section-title">
                <h2>Interaction matrix</h2>
                <button
                  aria-label="Randomize matrix"
                  title="Randomize matrix"
                  onClick={shuffle}
                >
                  <Shuffle size={16} />
                </button>
              </div>
              <p>Select a pair. Rows react to columns.</p>
              <div className="matrix">
                <span className="axis">
                  <ArrowUpRight size={15} />
                </span>
                {COLORS.map((c, i) => (
                  <span key={c} className="matrix-heading" title={names[i]}>
                    <i style={{ background: c }} />
                  </span>
                ))}
                {COLORS.map((c, row) => (
                  <div className="matrix-row" key={c}>
                    <span className="matrix-heading" title={names[row]}>
                      <i style={{ background: c }} />
                    </span>
                    {COLORS.map((_, col) => {
                      const pair = row * 4 + col;
                      return (
                        <button
                          key={col}
                          className="curve-cell"
                          aria-label={`${names[row]} toward ${names[col]}`}
                          aria-pressed={selected === pair}
                          onClick={() => setSelected(pair)}
                        >
                          <Curve curve={config.matrix[pair]} />
                        </button>
                      );
                    })}
                  </div>
                ))}
              </div>
              <div className="curve-editor">
                <h3>
                  {names[Math.floor(selected / 4)]} → {names[selected % 4]}
                </h3>
                <Curve curve={curve} large />
                <div className="curve-actions">
                  <button
                    onClick={() => {
                      updateCurve("near", 0.8);
                      updateCurve("far", -0.8);
                    }}
                  >
                    Attract → repel
                  </button>
                  <button
                    onClick={() => {
                      updateCurve("near", -0.8);
                      updateCurve("far", 0.8);
                    }}
                  >
                    Repel → attract
                  </button>
                </div>
                {(["near", "far"] as const).map((key) => (
                  <label className="slider-label" key={key}>
                    <span>
                      {key === "near" ? "Near force" : "Far force"}
                      <output>
                        {curve[key] > 0 ? "+" : ""}
                        {curve[key].toFixed(2)} ·{" "}
                        {curve[key] > 0
                          ? "attract"
                          : curve[key] < 0
                            ? "repel"
                            : "neutral"}
                      </output>
                    </span>
                    <input
                      aria-label={key === "near" ? "Near force" : "Far force"}
                      type="range"
                      min="-1"
                      max="1"
                      step="0.05"
                      value={curve[key]}
                      onChange={(e) => updateCurve(key, +e.target.value)}
                    />
                  </label>
                ))}
                <label className="slider-label">
                  <span>
                    Switch distance
                    <output>{Math.round(curve.split * 100)}% of radius</output>
                  </span>
                  <input
                    aria-label="Switch distance"
                    type="range"
                    min="0.15"
                    max="0.9"
                    step="0.01"
                    value={curve.split}
                    onChange={(e) => updateCurve("split", +e.target.value)}
                  />
                </label>
                <p className="curve-help">
                  Switch at {(curve.split * config.radius * 100).toFixed(1)}% of
                  world width. Positive attracts, negative repels. A tiny
                  collision core (8% of radius) always repels. Beyond the
                  interaction radius, force is zero.
                </p>
              </div>
            </section>
          </aside>
        </div>
        <footer>
          <p>
            <span className="footer-dot" /> Distance shapes every interaction.
            Opposite edges connect.
          </p>
          <div>
            <span>Seed {config.seed}</span>
            <button
              className="text-button"
              onClick={() => file.current?.click()}
            >
              <Upload size={14} /> Load settings
            </button>
            <a href="./THIRD_PARTY_NOTICES.txt">Licenses</a>
          </div>
        </footer>
        <input
          ref={file}
          type="file"
          accept=".json,application/json"
          hidden
          onChange={(e) => importFile(e.target.files?.[0])}
        />
        {error && (
          <div className="error" role="alert">
            {error}
            <button onClick={() => setError("")}>Dismiss</button>
          </div>
        )}
      </main>
    </div>
  );
}
