# Further Particle Life optimization research

Reviewed 2026-09-30, after implementing exact GPU tiling/BVH, sampling, direct rendering, and the optional speed limit. These are proposed experiments; no new runtime optimization was implemented during this review.

## What the measurements actually show

In `reports/gpu-tuning.json`, the 50,000-particle, 64-wide grid's recorded GPU force pass accounts for about 99.75% of pass time in the uniform fixture and 98.94% in the clump fixture. These are individual timestamp profiles, not proof that arithmetic alone is the bottleneck. That pass also includes candidate rejection, source loads, workgroup barriers, and integration. Reducing rejected candidates or synchronization can therefore help even though histogram/scan/scatter are already cheap.

The current shader visits nine coarse cells, uses two workgroup barriers per source tile, and bins particles without ordering them inside a cell. Its sampled kernel can miss the repulsive core because it samples all neighboring-cell candidates uniformly. The following proposals target these remaining properties.

## 1. Tighter spatial tiles and cluster-pair pruning — exact

GROMACS uses cluster pair lists and a separate pruning mechanism to remove noninteracting cluster pairs. This targets work inside the interaction kernel, not only the cost of rebuilding a spatial index. [Páll et al., 2020, Heterogeneous Parallelization and Acceleration of Molecular Dynamics Simulations in GROMACS](https://arxiv.org/abs/2006.09167).

Proposal for this app:

- Test cell widths near R/2 and R/3 against the current width of at least R. Generate conservative periodic search stencils rather than retaining the fixed 3×3 loop.
- Spatially order particles within coarse cells, then form tight tiles with bounds. Random atomic ordering inside a large cell currently makes many tile boxes almost as wide as the entire cell.
- Reject whole source tiles using conservative box-distance tests before loading their particles. Keep the final per-particle distance and nonlinear-force checks.
- Optionally retain a buffered list of tile pairs, with cheaper pruning between rebuilds. A dense bitset for 782 fixed 64-particle tiles is approximately 76 KB before metadata, much smaller than a full per-particle neighbor list. This is our storage estimate, not a claim about GROMACS's representation; capacity grows quadratically with tile count and must be bounded.

Our geometric estimate for uniformly distributed particles: at R=0.13, the current 7×7 grid examines an area of 9/49 for every receiver, but the interaction disk has area πR². Only about 29% of candidates fall inside the disk on average. This estimates rejection opportunity, not an expected speedup. Dense clumps containing mostly true neighbors have much less to prune. Smaller cells also increase traversal overhead and may require a larger, multipass prefix scan.

A related exact option is projection sorting / pseudo-Verlet traversal, which rejects pairs through one-dimensional separation before the full distance calculation. The published SIMD implementation concerns CPU hardware; a WebGPU adaptation needs its own benchmark. [Willis et al., 2018, An Efficient SIMD Implementation of Pseudo-Verlet Lists](https://arxiv.org/abs/1804.06231).

## 2. Subgroup exchange and GPU memory experiments — exact up to rounding

WGSL provides optional subgroup operations, including shuffle operations. Subgroup width and lane mapping must not be assumed from a CUDA warp or from local invocation indices. [WGSL specification](https://gpuweb.github.io/gpuweb/wgsl/).

Proposal: compare the current shared-memory tile with a subgroup implementation in which each lane loads a source particle into registers and exchanges it within the subgroup. This can remove workgroup-wide synchronization from parts of the inner loop. Keep the existing kernel as the fallback and explicitly check/request subgroup support. Handle inactive lanes and partial tiles correctly; do not infer subgroup lane IDs from local IDs.

Also test direct, spatially coherent storage-buffer loads against explicit workgroup copies. Apple notes that on Apple Family 9 hardware, threadgroup and buffer accesses can have similar characteristics when their working set fits the shared cache hierarchy. Shared-memory copying is therefore not automatically optimal. [Apple, Learn performance best practices for Metal shaders](https://developer.apple.com/videos/play/tech-talks/111373/).

Further low-cost candidates from inspecting our shader: precompute inverse radius; evaluate inverse-square-root normalization with an explicit error tolerance; compare a branchless force-band evaluation with the current branches; and test species grouping within spatial tiles. These are hypotheses, not measured bottlenecks. Sorting by species can improve branch coherence while worsening spatial packing. Avoid converting positions or accumulated forces wholesale to f16 without a numerical error study.

## 3. Exact core plus sampled shells — approximate, with a stronger near-field treatment

The random-batch list method evaluates a core region directly and samples the outer shell. It specifically targets short-range interactions without constructing a full Verlet list. [Liang, Xu & Zhao, 2021, Random-batch list algorithm for short-range molecular dynamics simulations](https://arxiv.org/abs/2105.04884).

Our adaptation would evaluate every neighbor in the repulsive core (r < 0.08R), then sample the near/far force bands separately, ideally stratified by source species. Each stratum needs its correct population/probability weight, and core particles must not be double-counted. A finer grid or hierarchy is needed to find the core without scanning the entire large-radius neighborhood.

The objective is lower force variance or better core behavior at a comparable budget, potentially allowing fewer outer samples. It is not guaranteed to be faster than the current sampler, because exact core work is additional and can itself become quadratic in extreme clumps. Published Lennard-Jones accuracy claims and momentum-correction procedures do not transfer automatically to our directed, nonreciprocal forces. Test core misses, force error, and emergent patterns at matched cost. Speed saturation is nonlinear, so an unbiased acceleration estimate does not imply an unbiased limited velocity.

## 4. Fourier particle-mesh / NFFT summation — larger approximate experiment

Fast Fourier-based summation methods exist for kernels beyond inverse-square gravity. Potts, Steidl and Nieslony study convolution with radial kernels at nonuniform particle locations. [Fast Convolution with Radial Kernels at Nonequispaced Knots](https://www-user.tu-chemnitz.de/~potts/paper/nfftrad.pdf).

Our proposed adaptation uses four species density fields on the periodic square. For each receiver species, convolve these with its directed two-component force kernels, then interpolate the resulting vector field at particle positions. The mathematical target is

`F_a(x) = sum_b integral K_ab(y - x) rho_b(y) dy`.

The kernel orientation must match this convention when translated to an FFT convolution. Different A→B and B→A kernels remain independent. A grid approach has work of roughly O(N + M log M) at fixed species count and grid resolution M, plus any exact near-field correction. This is an application-specific complexity estimate, not a result demonstrated for this app by the cited paper.

Treat the repulsive core directly and use a consistently split smooth outer kernel on the mesh, without double counting. Validate self-force, periodic seams, deposition/interpolation error, and convergence across resolutions. Narrow force bands can require fine meshes; dense core corrections can still be expensive. Kernel spectra can be cached until matrix/radius changes. This is the most substantial alternative for very large populations, but requires a WebGPU FFT implementation and a controlled spatial-accuracy setting. It is not an exact-mode replacement or a reason to add machine learning.

## 5. Exploit the speed bound when reusing tile lists — conditional

The new cap provides a deterministic displacement bound when enabled and applied before every position update. A conservative buffered list with skin distance δ remains valid over k integration steps if

`2 * vmax * k * dt <= δ`, with `dt = 1/60`.

This follows from the maximum relative displacement of two particles; it is our derivation. At vmax=0.1 and δ=0.02, the bound permits six steps. At the default vmax=0.5, the same skin permits only one whole step. Larger skins cost more candidates, so the cap does not automatically make caching profitable.

Keep membership identities stable while reusing a tile list and account for periodic crossings. Rebuild or invalidate on changes to the cap, radius, population, or state. With the cap disabled, measure displacement instead of assuming a safe interval. Reuse should serve tighter force pruning, not merely save the already-cheap histogram pass.

## 6. Retune for evolving distributions — scheduling improvement

Current automatic mode selects once after load or a radius change. A uniform state's winner or tile size need not remain best after clustering; the recorded 50,000-particle run favored 64-wide grid tiles for uniform data and 128-wide tiles for the clump.

Proposal: use occupancy statistics and recent step times to trigger an occasional bounded reevaluation. Compare unchanged snapshots, exclude warmups, apply hysteresis, and retain the existing solver unless a repeatable improvement exceeds noise. Do not benchmark all expensive candidates on every frame, and never switch an exact mode silently to sampling. This recommendation follows from this app's implementation and reports, not a new literature speedup claim.

## Recommended order and validation

1. Compare tighter tiles/stencils and subgroup-versus-buffer-loading kernels in exact mode.
2. Add exact-core, stratified-shell sampling; compare error at equal time and time at equal error.
3. Add bounded retuning when occupancy changes; evaluate buffered tile reuse only where the displacement bound and profiling justify it.
4. Prototype a particle-mesh backend separately for larger populations and measure resolution/error tradeoffs.

Use identical saved uniform, evolved, seam-crossing, and dense states; multiple radii and force splits; cap enabled and disabled. Record candidate/accepted pairs and pruned tiles in a diagnostic variant, then time the normal variant without counter overhead. Separate CPU submission, GPU pass time, and end-to-end rendering. Report distributions over enough samples rather than treating a three-sample maximum as p95. No new speedup factor is established by this research alone.

## SDF follow-up: useful geometry, insufficient information for pair forces

A particle SDF typically describes the boundary of a shape formed from particle spheres. For example, Houdini's particle-to-SDF node uses each particle's radius to define the occupied region. [SideFX, Gas Particle to SDF](https://www.sidefx.com/docs/houdini/nodes/dop/gasparticletosdf.html).

A distance-to-surface field loses the multiplicity information needed by our force sum. One source particle and 100 coincident source particles with the same radius produce the same union geometry and distance field, but can exert 100 times the force on a separate receiver. One SDF per species does not recover this lost density. Taking its gradient would produce an attraction/repulsion field toward a surface, which is a different interaction model.

SDFs would be useful for future obstacle collisions, walls, or surface-guided motion. This use is demonstrated in particle systems such as Notch's mesh-distance-field affector. [Notch, Mesh Distance Field Affector](https://manual.notch.one/2026.2/en/docs/reference/nodes/particles/affectors/mesh-distance-field-affector/).

A distance transform could also help reject empty space, but dynamic rebuilding must earn its cost, and exact force pruning requires conservative distance bounds. Jump flooding efficiently approximates distance transforms on the GPU; its approximation errors cannot be treated as certified no-neighbor bounds without additional handling. [Rong & Tan, 2006, Jump Flooding in GPU with Applications to Voronoi Diagram and Distance Transform](https://www.comp.nus.edu.sg/~tants/jfa/i3d06-submitted.pdf).

For the user's broader field-based idea, the particle-mesh proposal in section 4 is the better fit: retain species density, convolve it with the directed force kernels, and sample resulting vector fields. Keep the close repulsive contribution direct. This is a proposed approximation with a resolution/error tradeoff, not an implemented SDF optimization or a measured speedup.

## Particle-mesh implementation follow-up

The particle-mesh proposal is now available as the opt-in `mesh-gpu` backend. It uses fixed-point cloud-in-cell species density, cached directed vector kernels, GPU row/column FFTs, matching field interpolation, and a separate exact core grid. Supported fields are 64², 128², and 256²; the default is 128². The existing automatic exact solver does not select it. SDF geometry, tile pruning, subgroup kernels, core-shell sampling, buffered lists, and adaptive retuning remain proposals from this memo, not newly implemented features.

See the README particle-mesh section and `reports/gpu-mesh.json` for the matched local benchmark, approximation error, and remaining dense-core limitation. The original proposal's statement that no particle-mesh speedup had yet been measured describes the pre-implementation research; the new report supplies measurements for the implemented backend.
