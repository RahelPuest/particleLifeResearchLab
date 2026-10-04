# Technical notes

A small browser-based Particle Life playground. Four particle types interact through a directed 4 × 4 matrix of nonlinear, distance-dependent force curves. No neural networks, training, model downloads, or backend.

## Run

Requires Node.js 22.12+ (tested on Node 24).

```sh
npm ci
npm run dev
```

## Controls

- Pause/resume, single-step, reset the current seed, or create a new arrangement.
- Select an ordered pair in the matrix to edit its force curve. Set near and far strengths (−1 repels, +1 attracts), and the switch distance (15–90% of the interaction radius).
- Use Attract → repel or Repel → attract for the selected pair, choose a global rule preset, or randomize all curves. Miniature curves in the matrix show each pair’s behavior.
- Change particle count (100–50,000), interaction radius, force strength, friction, and simulation speed.
- Select CPU or WebGPU force calculation, including exact grid/BVH, sampled, Barnes–Hut, and approximate particle mesh. For particle mesh, choose a 64², 128², or 256² field; finer fields resolve smaller structures. For Barnes–Hut, adjust the opening angle θ (0–1.2). The physics backend label reports what is actually running.
- Enable motion trails, drag to pan, zoom, enter fullscreen, or save a PNG.
- Save/load JSON settings. Settings include the seed and recreate the starting arrangement; they do not save the current particle positions. Legacy scalar settings can still be loaded: each scalar becomes equal near/far strengths under the new force law, so trajectories differ from the old version.

Rows describe the responding type and columns the influencing type. A small collision core (8% of the interaction radius) always repels to prevent collapse. Outside it, two smooth quartic lobes apply independently signed near and far strengths, meeting at zero at the switch distance. Force reaches zero again at the interaction radius and remains zero beyond it. Each lobe uses `16 t² (1−t)²`, with local `t` from 0 to 1, so transitions have zero slope. Switching signs creates either attraction followed by repulsion or the reverse. The switch is relative to the interaction radius; the editor also shows its distance as a percentage of world width. Opposite edges connect into a periodic square.

The simulation is controlled by a Web Worker with a fixed 1/60 integration step and exponential velocity damping. The exact solver uses a counting-sort grid, reusable typed arrays, contiguous cell storage, and one distance calculation per unordered pair. Both directed forces are evaluated separately. The exact grid solver does not approximate forces or change their cutoff.

For larger populations, select **Force calculation → Fast · sampled neighbors**. This opt-in solver samples a configurable 32–1,024 candidates per particle and scales the sum to estimate the full force. It introduces noise and changes trajectories; it is not equivalent to exact mode. Sampling uses a reproducible rotation based on seed, particle ID, and step. Start with 128 samples, or lower this for speed. When all candidates fit within the budget, all are evaluated. Exact work can still grow quadratically in dense populations; sampled work is bounded by particle count × sample budget.

For CPU physics and the transfer-based fallback path, WebGL draws all particles in a single point draw; Canvas 2D is the automatic fallback when WebGL is unavailable or the context is lost. Rendering resolution is capped at 2× device pixel ratio. The worker transfers only display positions using a recycled three-buffer pool; velocities remain in worker memory or GPU storage and species are sent only after initialization/reset. Frame submission is limited to 30 Hz with backpressure. Curve previews are memoized. Worker tasks yield between physics steps, accumulated time debt is bounded, and hidden tabs suspend simulation work.

The settings panel shows measured milliseconds per step and simulation steps per second. For WebGPU, step time includes submission and completion of all physics passes, but excludes display readback. These are physics metrics, not display FPS. Large populations, wide interaction radii, and dense clusters can reduce simulation speed; the 50,000-particle limit is not a real-time performance guarantee. Everything stays in the browser. Nothing is uploaded or automatically stored.

## Exact GPU optimizations

**Automatic exact · WebGPU** measures the tiled grid (32/64/128-particle workgroups), compact BVH, and tiled all-pairs solvers on the same current state, then selects the fastest measured candidate. Calibration discards trial outputs: it does not advance simulation time. It runs on the first simulation step after initialization/reset or a radius change, not continuously. The backend label identifies the selected implementation. An initial-state winner is not guaranteed to remain optimal as clusters evolve; the three explicit modes remain available for comparisons. Calibration uses wall-time medians and can briefly delay controls for large dense populations.

- **Exact tiled grid · WebGPU:** histogram, parallel prefix scan, and scatter pack particles into variable-length cell ranges. Workgroups process receiver tiles from a single cell and cooperatively load neighboring source tiles into workgroup memory. There is no fixed cell capacity or dropped-particle overflow. Each interaction evaluates the full directed nonlinear force.
- **Exact BVH · WebGPU:** Morton-ordered cells provide a spatial permutation; fixed-size blocks of sorted particles form leaves of a compact balanced binary bounding-volume hierarchy. Bounds are reduced on the GPU. Each receiver tile traverses conservatively using periodic box-distance tests; accepted leaves are evaluated as real particle pairs. This is exact neighbor pruning, not Barnes–Hut aggregation. It uses implicit child indices and float bounds, not a quantized Karras LBVH.
- **Exact all-pairs · WebGPU:** cooperative source tiling without any neighborhood construction. It provides a useful small-population baseline; work remains quadratic.

**Fast · sampled WebGPU** bounds force work with a configurable 32–1,024 candidates per particle. It samples the sorted neighboring-cell ranges with a rotating, stratified selection and scales the force sum by candidate count / sample count. It is an approximation and changes trajectories; automatic exact mode never selects it. If every candidate fits within the budget, all are evaluated. GPU atomic scatter order means sampling is not guaranteed to reproduce the CPU sampled trajectory or be bitwise deterministic across runs. Use this mode for dense populations where exact pair evaluation remains expensive.

All modes preserve original particle identity and species while physically reordering their scratch state. Configuration uploads are cached until values change, and force-band reciprocals are precomputed outside the pair loop. The worker submits at most three steps per batch and waits once per batch, keeping queued work bounded. Direct rendering shares compute buffers, supports zoom/pan/trails and PNG export, and sends UI metadata at up to 10 Hz while drawing at up to 30 Hz. CPU modes retain the recycled position-buffer path. If a new exact GPU mode fails, it falls back to the exact CPU grid; Barnes–Hut retains its corresponding CPU fallback.

Opt-in profiling records GPU pass timestamps when the adapter supports `timestamp-query`; unsupported timestamps are reported as unavailable. Timing does not silently substitute CPU wall time for GPU execution time. Run the matched-state comparison with:

```sh
WEBGPU_TEST=1 RECORD_OPTIMIZATION_BENCHMARK=1 npx playwright test tests/e2e/gpu-benchmark.spec.ts
```

The report is `reports/gpu-optimizations.json`. It compares the same frozen uniform, evolved, and clumped states on each backend, with separate pass timings where available. Avoid changing source files during this development-server benchmark: hot reload invalidates the browser execution context. These measurements exclude rendering and are not FPS claims.

## Barnes–Hut and GPU physics

**Force calculation → Barnes–Hut · WebGPU** executes actual physics, not just rendering, on WebGPU. Its passes clear leaf heads, insert particles into Morton-ordered leaves, calculate separate position sums/counts for all four species, reduce parent moments bottom-up, traverse the tree per particle, and integrate velocities and positions. Particle state stays in ping-pong GPU storage buffers. Static tree geometry is created on the CPU once per population change; tree occupancy and moments are rebuilt on the GPU every step. The implementation uses a complete quadtree with depth 5–7 (chosen from population size) and skips empty branches. It is not an adaptive CPU-built tree uploaded every frame.

An accepted node contributes four independent species centers weighted by their particle counts. Nodes are accepted only if the opening-angle test passes, they exclude the collision core, lie fully inside the interaction radius, do not cross a relevant force-band boundary, and do not cross a periodic-image discontinuity. An additional radial-span test limits the node extent relative to the nonlinear force band's width. Otherwise traversal descends; unresolved leaf interactions are evaluated individually, excluding self-interaction. At θ = 0 there is no aggregation. Floating-point summation order still differs between GPU, CPU tree, and the grid.

**Barnes–Hut · CPU** implements the same traversal and acceptance rules as a reference and fallback. The extra tree overhead can make it slower than the exact grid, particularly at low counts or short radii. Conservative opening rules may prevent aggregation entirely in some configurations. Barnes–Hut does not guarantee a speedup or a fixed error bound for these nonlinear forces; dense near-field populations can still require quadratic work. The recorded accuracy results are fixture measurements, not guarantees for arbitrary matrices or long trajectories.

When OffscreenCanvas WebGPU is available, rendering consumes the compute particle buffers directly on the same device. A persistent render target supports trails and screenshots. Positions are read back about once per second for device-loss recovery, rather than for every displayed frame. Without direct rendering, the existing position-transfer/WebGL path remains available. Switching back to a CPU solver explicitly downloads positions **and velocities**, preserving state. If WebGPU initialization fails, the interface reports CPU Barnes–Hut and the reason. If the device is lost while running, the worker continues on CPU from the latest recovery checkpoint with velocities reset; this recovery is explicitly reported. Select another solver and reselect WebGPU to retry.

WebGPU requires a browser/adapter that exposes it in a secure context; localhost is suitable for development. No application flags are required or changed by the app. Implementation references: [WebGPU specification](https://www.w3.org/TR/webgpu/) and [WGSL specification](https://www.w3.org/TR/WGSL/).

## Verify and build

```sh
npm test
npm run build
npx playwright install chromium
npm run test:e2e
```

Unit tests compare the neighbor grid and θ = 0 tree with direct all-pairs forces, validate per-species moments and tree traversal, measure approximation error on a fixture, validate imports, and check wrapping, force signs, finite states, and seed reproducibility. Browser tests cover controls, settings and image downloads, mobile layout, a production build under a nested URL path, a 50,000-particle sampled run with resets, Canvas fallback, GPU pixel output, WebGPU numerical parity (including periodic seams and odd population sizes), 50,000-particle GPU computation, initialization failure, and device-loss recovery. GPU-specific checks skip when the default test browser has no appropriate adapter.

For a real WebGPU test run on this Mac, `WEBGPU_TEST=1 npm run test:e2e` enables Chromium test flags and requires an adapter for the numerical test. These flags are restricted to the test browser; they are not part of the application. `RECORD_GPU_BENCHMARK=1 WEBGPU_TEST=1 npm run test:e2e -- tests/e2e/gpu-physics.spec.ts` also records `reports/barnes-hut-gpu.json`.

Deploy `dist/` to any static host. Relative asset paths support subdirectory hosting. The included GitHub Pages workflow deploys on every push to `main` (and can also be triggered manually).

Third-party runtime licenses are included in `THIRD_PARTY_NOTICES.md` and `public/THIRD_PARTY_NOTICES.txt`.

## Performance measurements

Run `npm run benchmark` for an exact CPU comparison against the previous linked-list grid and an exact quadtree (bucket size 16), and `node --import tsx scripts/benchmark-fast.ts` for sampled-mode measurements. Results are recorded in `reports/performance.json` and `reports/performance-fast.json`. These are local Node.js microbenchmarks of physics steps, not end-to-end browser FPS or universal hardware estimates.

At 5,000 initially uniform particles and radius 0.13, the recorded median step was 90.91 ms for the previous grid, 64.03 ms for the tested quadtree, and 22.51 ms for the new exact grid (~4× faster than the old implementation). The measured exact speedup across the tested counts/distributions was about 3.2–6×. The tested quadtree was slower than the optimized grid in every scenario; other tree implementations or different workloads may differ. The quadtree comparator performs exact leaf interactions, not Barnes–Hut force aggregation.

The sampled solver at 128 candidates measured 29.33 ms for 10,000 uniform particles and 154.59 ms for 50,000. Dense initial distributions measured 30.02 ms and 159.42 ms respectively. Approximate and exact trajectories differ, so these numbers describe computational cost rather than equivalent simulation outcomes.

## Barnes–Hut measurements

`node --import tsx scripts/benchmark-barnes-hut.ts` records CPU tree timing and force error in `reports/barnes-hut-cpu.json`. For the tested 5,000–10,000-particle initial distributions, θ = 0.6 produced approximately 0.59–1.70% relative RMS force error against the exact tree. θ = 1 produced about 2.48–3.87%. At 1,800 particles with the tested short radius, the conservative criteria accepted no groups. CPU tree timings are recorded separately and can be slower than the exact grid.

The latest recorded Apple/Metal WebGPU run measured median physics-step times of about 1.0 ms (1,800 particles), 3.2 ms (5,000), 5.3 ms (10,000), and 81.3 ms (50,000), plus 0.4–1.4 ms for a display-position readback. These are seeded, initially uniform fixtures at radius 0.13 and θ = 0.6, with two warmups and five measured steps. They include GPU completion latency and are not display FPS or a promise for evolved/dense populations. The JSON report is the source of truth for subsequent recorded runs.

## Optimization measurements and limits

`reports/gpu-optimizations.json` records the matched-state CPU/GPU comparison, including evolved snapshots. In that Apple/Metal run, 50,000 initially uniform particles took 46.6 ms per exact tiled-grid step versus 311.6 ms with GPU Barnes–Hut. At 10,000 evolved particles the exact BVH measured 5.3 ms versus 27.0 ms for Barnes–Hut. These are local physics timings; background load, adapter, distribution and matrix matter. Barnes–Hut is approximate at the tested theta, while grid and BVH are exact.

Run `WEBGPU_TEST=1 RECORD_GPU_TUNING=1 npx playwright test tests/e2e/gpu-tuning.spec.ts` to record the latest grid tile sizes, exact BVH and approximate GPU sampling in `reports/gpu-tuning.json`. The earlier broad comparison predates the added tile tuning and precomputed force-band reciprocals; use the newer report for those variants.

Full per-particle Verlet lists are intentionally not allocated. At 50,000 uniform particles and radius 0.13, directed neighbor indices alone would need roughly 531 MB before a skin buffer. In the broad GPU profile, neighborhood construction usually consumed only a small fraction of force time at this population; caching it cannot eliminate the dominant exact pair work. The compact BVH uses implicit child links and float bounds. Quantized bounds and further Barnes–Hut traversal changes remain unimplemented experiments, not advertised optimizations. Exact dense interactions can still become quadratic.

The later tile/sampling run measured 43.7 ms for 50,000 uniform particles with the exact 64-particle grid, versus 4.9 ms with 128 GPU samples. In its dense clump, the fastest measured exact grid tile size was 128 (281.4 ms), while GPU sampling measured 4.6 ms. Sampling changes the force estimate and is not an accuracy-equivalent speedup. These are separate-run medians, not end-to-end frame rates or guarantees.

Validation after the optimization changes: 24 unit tests and 16 browser tests passed with a real Apple/Metal WebGPU adapter. The full suite includes numerical parity, runtime coefficient changes, automatic calibration without advancing the state, sampled-mode exact coverage, a 50,000-particle sampled run, direct-render pixel checks, exports, backend switching, and device-loss recovery. The opt-in long CPU/GPU benchmark also completed separately.

## Optional asymptotic speed limit

Enable **Soft speed limit** and set **Maximum particle speed** (0.05–5 world widths per simulated second, default 0.5). It is off by default and independent of simulation playback speed. Changes take effect on the next physics step on every CPU/GPU solver; settings exports preserve both fields and older files import with the limit disabled.

The limiter now acts on acceleration rather than repeatedly compressing the current velocity. After applying the configured friction to velocity, it transforms that velocity into unbounded coordinates, adds the damped force impulse, and maps back inside the speed bound. With effective bound `L = maximum × (1 − 1e−6)`, the mappings are `u = v / sqrt(1 − |v|²/L²)` and `v = u / sqrt(1 + |u|²/L²)`. This gives diminishing acceleration near the limit. A force-free particle below the limit receives only the configured friction, with no extra limiter braking. Zero-force updates skip the transform round trip entirely.

Enabling or lowering the limit while a particle already exceeds it projects that velocity just inside the bound once. The same integration is used by all CPU backends and a shared WGSL helper for all GPU backends, including metabolic mode. It changes the response to forces near the cap; it is not a claim of relativistic dynamics. The previous repeated velocity saturation introduced additional nonlinear drag every step, which could reinforce oscillations. Removing that drag does not guarantee that genuine oscillations from attraction/repulsion and changing composition disappear.

Validation for this control: 30 unit tests and 17 browser tests passed, including CPU/GPU agreement, live toggling, changed limits, and settings round trips. The two opt-in performance benchmarks were skipped in this correctness run.

## Particle mesh · approximate WebGPU

Select **Force calculation → Particle mesh · approximate WebGPU**, then choose **Field resolution** (64 × 64, 128 × 128 default, or 256 × 256). This is a density-field method, not a signed distance field: overlapping particles retain their separate contributions. Automatic exact mode never selects this approximation. The CPU exact default remains unchanged.

Each step deposits particle mass into four periodic species grids using cloud-in-cell (bilinear) weights. Fixed-point atomic deposits conserve each particle's mass exactly and cannot overflow at the supported 50,000-particle limit, even if all particles occupy one node. The same quantized weights interpolate the resulting force back to the particles; matched assignment/interpolation and odd vector kernels suppress self force.

A GPU 2D radix-2 FFT transforms the density grids. Sixteen directed vector-kernel spectra combine them into four responding-species force fields; inverse FFTs recover the fields. Each row/column transform stays in workgroup memory. Kernel spectra are cached between steps and regenerated after radius, matrix, resolution, or buffer initialization changes. The force direction accounts for convolution's receiver-minus-source convention. Strength, damping, and the optional speed limit are applied during integration. Physics and rendering share the existing GPU particle buffers; there is no per-step CPU field readback.

The mesh contains only the two outer force bands. A separate fine spatial grid evaluates the repulsive core (`r < 0.08 × interaction radius`) directly, including periodic seams, without a fixed cell capacity. These exact core forces are added to the interpolated outer field; no full core force is also deposited in the field. Interpolation can still spread nearby outer-kernel contributions across the core boundary. Field work scales approximately as `O(N + M log M)` for four species and M grid nodes, **plus direct core-neighbor work**. Extremely concentrated clusters can still make the core quadratic.

This changes trajectories. Coarse grids smooth small structures, narrow force bands, and sharp spatial density changes. A finer field reduces discretization error but does not establish a universal accuracy bound. Prefer 256² for short radii or narrow force bands, and compare with an exact backend when the dynamics matter. Settings exports include the solver and resolution; older files default to 128². Unavailable/failed WebGPU visibly falls back to the exact CPU grid.

`WEBGPU_TEST=1 RECORD_MESH=1 npx playwright test tests/e2e/gpu-mesh.spec.ts` records matched frozen-state timings and one-step velocity error in `reports/gpu-mesh.json`. With zero initial velocity and identical strength/damping, that relative velocity error is also the relative force error. Timings exclude rendering, readback, initial compilation, and kernel preparation. Each median uses five measured samples after warming the same snapshot.

In the recorded Apple/Metal run at radius 0.13:

| Population | Distribution | Exact GPU grid | Mesh 128² | Relative RMS error | Mesh 256² | Relative RMS error |
| ---------- | ------------ | -------------: | --------: | -----------------: | --------: | -----------------: |
| 10,000     | Uniform      |         3.1 ms |    2.0 ms |              6.18% |    2.3 ms |              1.66% |
| 10,000     | Clump        |        13.4 ms |    2.6 ms |              1.70% |    4.1 ms |              0.46% |
| 50,000     | Uniform      |        91.3 ms |    4.3 ms |              6.03% |    7.4 ms |              1.63% |
| 50,000     | Clump        |       477.7 ms |   54.9 ms |              1.08% |   68.3 ms |              0.28% |

The clump spans a 0.2 × 0.2 square. The grid comparator uses 64-particle tiles; the report's meshResolution field is ignored by that solver. These are local physics-step measurements, not display FPS, comparisons against every exact implementation, or long-term trajectory guarantees. Coarse 64² fields had roughly 20% relative RMS error in the uniform fixtures, so their lower cost comes with a substantial accuracy tradeoff.

Tests check FFT parity with exact forces at grid-aligned positions across all resolutions, directed asymmetric curves, cached-kernel invalidation, off-grid refinement, periodic seams, exact core dynamics, lone-particle self force, the live speed limit, settings import/export, rendering and CPU fallback.

## Visual effects

The **Appearance** panel offers **Particles**, **Neon glow**, **Rings**, and **Light field**. Choose species colors, a fixed blue-to-amber speed palette, or ice monochrome. Adjust particle size and, for glow/light-field modes, light intensity. Enable **Motion trails** below the viewport, then adjust **Trail persistence** in Appearance. Trails remain visible when paused and are cleared when the camera or visual style changes. PNG export captures the selected appearance, including existing trails.

Light field uses soft additive particle sprites to reveal overlapping groups; it is not a calibrated density plot. Larger sprites, additive overlap, and long trails can increase rendering cost, especially in dense populations. These controls affect display only and never change forces or advance a paused simulation. Visual settings are included in settings exports; older files retain the original particle appearance.

All styles work with direct WebGPU rendering, WebGL, and the Canvas 2D fallback. Direct WebGPU reads speed from the existing velocity buffer without CPU readback. The transfer-based renderer requests a recycled per-particle speed buffer only when speed coloring is selected; a GPU backend without direct rendering downloads velocities only for that display mode. Canvas reuses a small sprite palette for effects and quantizes speed colors into 32 levels.

## Optional metabolic mode

Choose **Simulation mode → Metabolic · mixed species** to enable the second mode. **Classic Particle Life** remains the default with fixed species and the existing solvers. Switching modes restarts the arrangement from the current seed. Metabolic mode starts with Particle mesh WebGPU; Exact CPU is also available and is the automatic fallback if WebGPU fails. Other solver options are disabled in this mode because they assume one discrete species per particle.

Every particle carries four nonnegative fractions that sum to one. A pair's force is the weighted sum of all directed source/receiver force curves, `Σa,b wi[a] wj[b] Fab(r)`. The common repulsive core is evaluated once. Species colors interpolate the same fractions; WebGPU and WebGL use the full composition, while Canvas uses a bounded quantized mixture palette. Speed and monochrome coloring remain available.

Edit up to eight conversion rules: source share, destination share, nearby catalyst (A–D) or **Always**, and rate per simulated second. **Conversion speed** multiplies all rates; zero freezes composition but keeps mixed forces. Catalysts are not consumed, and the receiving particle does not catalyze itself. A neighbor contributes its catalyst fraction times `(1 - distance / radius)²` inside the interaction radius. Local exposure `e` gives activation `e/(1+e)`; Always uses activation 1. More/fuller/closer catalysts accelerate conversion up to the configured rate.

Competing rules draw from the old source share simultaneously. For total outgoing rate λ, the removed share is `w × (1 - exp(-λ dt))`, distributed in proportion to each rule's rate. This avoids negative shares or exceeding 100%, even with several outgoing rules. Reactions and forces both use the old composition, preventing order-dependent cascades within a step. The integrator remains 1/60 second, with the same friction and optional speed limit.

Default rules demonstrate two catalyst-driven changes with spontaneous returns: A → B near C, B → A always, C → D near A, and D → C always. **Initial mixing** applies on the next reset: 0% starts with pure species; 100% starts every particle at 25% A/B/C/D. These are catalytic state changes, not resource consumption, birth, death, or an energy-conserving ecosystem.

The GPU backend deposits fractional species mass, blends the four resulting response fields, and uses an additional scalar FFT convolution for catalyst exposure. It subtracts each particle's own quantized cloud-in-cell contribution. Force and catalyst fields are approximations controlled by field resolution; the collision core remains direct. Composition stays on the GPU for direct rendering and is included in recovery checkpoints and explicit CPU switches. Exact CPU sums neighboring mixed pair forces and catalyst exposure directly and can be expensive at high populations.

Settings exports include mode, initial mixing, and rules; they recreate an initial arrangement, not the current composition or positions. Older files load Classic mode. Tests cover mixed-force algebra, competing reactions, conservation, periodic neighbors, self exclusion, CPU/GPU parity on grid-aligned fixtures, live rate/rule updates, and mode/settings controls.

**Randomize rules** replaces the metabolic rules with eight balanced conversions without resetting particles, initial mixing, or conversion speed. A shuffled four-species cycle uses a shared random catalytic rate (0.20–0.60/s), and its reverse cycle a shared spontaneous rate (0.05–0.15/s). Each species has two incoming and two outgoing rules with equal total base rates and appears as a catalyst once. Catalysts are distinct from the source and target. Spontaneous returns keep every species reachable even without catalysts. Equal composition is stationary when all species have equal catalyst exposure; different local exposure and particle motion can still produce imbalances. This is structural balance, not a guarantee of ecological stability.

## Optional glass themes

Use **Theme** in the header to select **Classic**, **Glass · Dark**, or **Glass · Light**. The glass themes use translucent panels, backdrop blur, soft colored backgrounds, and matching controls. The particle canvas retains its dark display palette for contrast, with a glass camera toolbar. Switching themes takes effect immediately without resetting or advancing the simulation. The selected theme is included in settings exports; older files use Classic. Browsers without backdrop-filter support and reduced-transparency preferences receive solid panel backgrounds.
