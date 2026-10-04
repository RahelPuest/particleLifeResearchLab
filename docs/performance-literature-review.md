# Particle Life performance: literature review

Reviewed 2026-09-29. This is a research recommendation, not an implemented or measured speedup.

## Recommendation

Compare a spatially sorted, tiled GPU cell solver with a compact BVH for exact neighbor search. Share the same force kernel and GPU rendering path. Keep Barnes–Hut as an optional approximation, rather than assuming it should be the default.

Our forces have finite support, a common cutoff radius, species-dependent sign changes, and directed interactions. These properties make short-range molecular-simulation literature particularly relevant. A neighbor-search structure can preserve the complete nonlinear force law; aggregating particles into a center of mass generally cannot.

## Findings in the current implementation

- `src/engine/barnes-hut.wgsl` inserts particles into atomic linked lists. One invocation serially aggregates an entire leaf. Dense leaves can produce long serial loops.
- Cells are Morton ordered, but particle state remains in original index order. Adjacent invocations can therefore follow unrelated tree paths and read scattered particle data.
- The complete regular tree processes empty regions as well as occupied ones. Nonlinear acceptance checks restrict aggregation; the existing 1,800-particle CPU benchmark reports no accepted aggregates for its default-radius fixture.
- `src/engine/gpu-physics.ts` waits on `queue.onSubmittedWorkDone()` after each simulation step. It also uploads configuration and force curves each step, even when unchanged.
- Display positions travel from WebGPU through CPU readback and worker transfer to a separate WebGL renderer. Sharing a WebGPU buffer between compute and rendering would remove that round trip.

These are observed code properties, not a profile proving which dominates the user's workload. The recorded 50,000-particle GPU fixture spends about 81.3 ms per step and 0.7 ms on position readback: eliminating readback alone cannot fix that case. Existing benchmarks use short initial-state runs and do not establish end-to-end superiority over CPU on evolved clusters.

## Candidate approaches and evidence

### 1. Spatially sorted cells with tiled pair evaluation

Páll and Hess describe fixed-size spatial clusters and cluster-pair evaluation to improve SIMD utilization and data reuse. Their work supports testing cooperative loading of source particles followed by multiple pair evaluations per load. [Páll & Hess, 2013, *A flexible algorithm for calculating pair interactions on SIMD architectures*](https://arxiv.org/abs/1306.1737).

Application proposal: GPU histogram, prefix sum, and scatter into contiguous variable-length cell ranges; physically reorder positions and species together; process neighboring ranges in workgroup-memory tiles. Preserve particle identity where needed. Use overflow-safe ranges rather than fixed-capacity cells that drop particles. Benchmark several cell widths and tile sizes. Our common cutoff makes a cell baseline attractive, but does not prove it wins on every distribution.

Each pair still evaluates the existing curve and periodic displacement. A receiver-owned accumulation avoids floating-point atomics. Do not assume equal-and-opposite pair forces: A→B and B→A can differ. Reusing a distance for both directions requires separately evaluating both laws and safely reducing their outputs.

### 2. Compact BVH / LBVH for exact neighbor search

Howard et al. report quantized BVH neighbor search outperforming their equivalent grid baseline by roughly 2–4× in their benchmarks. This concerns neighbor search, not total simulation time. Their paper also notes that its compact sorting-based grid was slower than HOOMD's optimized atomic grid in selected comparisons; the headline factor is not a universal advantage over every cell implementation. [Howard et al., 2019, *Quantized bounding volume hierarchies for neighbor search in molecular simulations on graphics processing units*](https://arxiv.org/abs/1901.08088).

Application proposal: benchmark a compact hierarchy as the second exact backend, including construction cost and periodic queries. Reject nonintersecting nodes, then evaluate real particle pairs at leaves. This uses no center-of-mass force approximation. It is worth testing on strongly nonuniform states. Quantized bounding boxes must conservatively enclose their particles; CUDA rounding intrinsics cannot simply be copied into WGSL.

Karras provides a parallel radix-tree construction method using sorted Morton codes, applicable to LBVH construction. This is a possible implementation basis, not evidence that replacing our current fixed topology will necessarily be faster. [Karras, 2012, *Maximizing Parallelism in the Construction of BVHs, Octrees, and k-d Trees*](https://research.nvidia.com/publication/2012-06_maximizing-parallelism-construction-bvhs-octrees-and-k-d-trees).

### 3. Keep compute and rendering on the same GPU device

GROMACS describes GPU-resident execution as a way to reduce repeated transfers and synchronization. [GROMACS, *Heterogeneous parallelization and GPU acceleration*](https://www.gromacs.org/topic/heterogeneous_parallelization.html).

Application proposal: render directly from the compute particle buffer using WebGPU. Submit bounded batches of simulation steps instead of awaiting completion after every step; preserve responsiveness and cap queued work. Read back only for exports, backend switching, or infrequent diagnostics. Upload uniforms and curves only when changed. Measure this independently from neighbor-search changes so gains can be attributed correctly.

### 4. Reuse buffered neighbor or cluster lists

Buffered Verlet lists amortize neighbor searching while particles move little. The usual safe rebuild condition is that no particle has moved more than half the added buffer distance since construction. [HOOMD-blue, *Neighbor lists*](https://hoomd-blue.readthedocs.io/en/v2.9.6/nlist.html).

Application proposal: track displacement with periodic crossings accounted for and rebuild before evaluating a step that violates the bound. Radius changes and resets invalidate adjacency. Prefer bounded-memory cluster lists or an explicit memory budget over an unconditional full particle list.

Our own estimate: in the unit square, a uniform population of 50,000 particles with cutoff 0.13 has about N²πR² ≈ 133 million directed neighbor entries. At four bytes each, indices alone need about 531 MB, before any buffer distance or metadata. Dense clumps can require much more. Reuse therefore needs a measured memory/performance tradeoff.

### 5. Improve Barnes–Hut only if it remains competitive

Burtscher and Pingali identify spatial ordering, coherent traversal, and memory access as important GPU tree optimizations. [Burtscher & Pingali, 2011, *An Efficient CUDA Implementation of the Tree-Based Barnes Hut n-Body Algorithm*](https://iss.oden.utexas.edu/Publications/Papers/burtscher11.pdf).

Application proposal: spatially reorder particles, investigate cooperative traversal, and avoid serial leaf bottlenecks. However, faster traversal does not remove the limited aggregation opportunities imposed by our short-range, sign-changing force bands. CUDA warp-size assumptions and synchronization techniques need deliberate WebGPU adaptation.

## Benchmark and implementation order

1. Add phase measurements: construction, force evaluation, integration, submission/wait, readback, and rendering. Use GPU timestamps when available; wall time around queue completion is not a pure GPU kernel timer.
2. Implement the sorted tiled exact GPU cell baseline. Include a simple tiled all-pairs control for small populations, where indexing overhead may outweigh pruning.
3. Remove per-step CPU synchronization and render from the GPU particle buffer. Measure separately and in combination.
4. Compare compact BVH against the optimized cell implementation on identical saved states. Add buffered cluster lists only if neighbor-search time and available memory justify them.
5. Retain the winning backend by measured workload; tune workgroup and tile sizes on the actual adapter. Do not assume NVIDIA CUDA results transfer numerically to Apple/WebGPU.

Use 1,800, 5,000, 10,000, and 50,000 particles; uniform states, evolved clusters, extreme clumps, and periodic seams; identical radius, force curves, time step, and initial state. Report median and p95 step times, simulation steps per second, visible FPS, and memory. Compare exact solvers separately from approximations, and compare approximations at matched force-error targets. Validate one-step forces/velocities against the exact CPU reference; long trajectories can diverge from floating-point ordering alone.

Because the world stays fixed as particle count grows, average neighbor count also grows. Exact local pair evaluation is not automatically O(N) in this app. Spatial indexing eliminates irrelevant candidates; it cannot eliminate all genuinely interacting pairs in a dense clump.


## Implementation follow-up — 2026-09-30

Implemented: sorted GPU cell ranges; cooperative 32/64/128-particle grid tiles; exact compact balanced Morton BVH; tiled all-pairs reference; per-adapter/current-state automatic exact solver and tile selection; cached parameter uploads and precomputed force-band reciprocals; bounded three-step submissions; direct OffscreenCanvas WebGPU rendering from compute buffers; persistent trails and screenshot targets; optional GPU pass timestamps; lower-frequency UI metadata and recovery checkpoints. An explicit sampled GPU mode bounds candidate work for dense populations. Exact automatic mode never selects sampling.

The implemented BVH uses implicit binary child indices and float bounds. It is not the quantized Karras LBVH described in the cited papers. Full Verlet lists, quantized bounds, and further legacy Barnes–Hut traversal changes were not added: the measured large-population bottleneck is pair-force evaluation, and the current exact grid/BVH alternatives already outperform the prior GPU tree in the recorded comparisons. These remain possible experiments, not claimed completed work.

See `reports/gpu-optimizations.json` for the matched-state CPU/GPU comparison and `reports/gpu-tuning.json` for the later tile-size and sampling comparison. The first report predates tile tuning and reciprocal precomputation. Both separate physics timings from rendering and label approximation explicitly. README documents operation, validation, and limits.
