# WebGL2 vs WebGPU — and what the GPU actually buys shiranami

Written when the WebGL2 renderer landed, to answer three questions: why
raw WebGL2 and not three.js, what the measurements actually showed about
performance, and what WebGPU would buy if we build the comparison
renderer later.

## What our workload actually is

Per frame, the shared simulation (`src/core/sim.ts`, CPU) produces:

- ~3,000 stroke runs → tens of thousands of ribbon vertices, all drawn
  **additively**
- up to 2,600 spray dots
- one translucent fade quad (the ghost trails) + one present blit
- optionally one video texture upload (webcam PiP)

Under WebGL2 that is three or four draw calls. No meshes, no materials,
no scene graph, no thousands of independent objects.

## What we measured (M-series Mac, Chrome, July 2026)

At maximum load (2,680 lines × 60 segments, spray pool saturated):

| | Canvas 2D | WebGL2 |
|---|---|---|
| fps | ~60 (vsync-capped) | ~60 (vsync-capped) |
| main-thread ms/frame | ~16.0 | ~15.8 |
| of which simulation alone (headless) | ~18* | ~18* |

\* headless Node run of `sim.ts` at the same settings; slightly above the
in-browser figure because the browser run interleaves GC differently, but
the shape is unambiguous.

Two findings that contradict the folklore:

1. **The bottleneck is the simulation, not the rasteriser.** Integrating
   2,680 streamlines through the wave field is ~160k `surf()`/`fbm()`
   evaluations per frame of plain JavaScript trigonometry. That is where
   the 16 ms goes; both renderers pay it identically because they share
   the sim.
2. **Canvas 2D was never CPU-rasterising.** Chrome's 2D canvas has been
   GPU-accelerated (Skia) for years. The strokes were already drawn by
   the GPU before this project had a single line of GLSL.

So on this hardware, at the current 2,680-line cap, **WebGL2 does not
raise the frame rate** — both renderers sit at vsync with the same
headroom. What WebGL2 actually buys today:

- an explicit pipeline (own shaders, own blending) — the hook for the
  post-processing we've talked about (bloom on the crests is one extra
  pass over the accumulation texture, no library needed)
- independence from Canvas 2D API semantics (`ctx.filter`, dash-array
  quirks, per-browser stroke AA differences)
- the architecture for the *real* speedup, which is below.

To raise the actual ceiling (more strokes, higher Detail, recording
headroom), the sim itself has to get cheaper or move off the main thread
— that is a compute problem, not a raster problem.

## Why not three.js

three.js earns its keep managing *many heterogeneous objects*: scenes,
cameras, materials, lights, model loading. We have one bespoke effect
with its own 2.5D projection. Its line primitives don't fit either —
`Line` is 1-pixel GL lines, `Line2`/`LineMaterial` is uniform width per
material — so the tapered, per-section-styled ink strokes would need
custom `BufferGeometry` + `ShaderMaterial` anyway. That is the same
shader work as raw WebGL2, plus ~170 KB of library and a scene graph
wrapped around three draw calls. Worth revisiting only for real 3D
camera moves or its `EffectComposer` post chain — and the latter is one
shader pass we can write ourselves.

## WebGL2 vs WebGPU, honestly

| | WebGL2 (2011-era GL ES 3.0 model) | WebGPU (2023+, Metal/Vulkan/D3D12 model) |
|---|---|---|
| Programming model | Global state machine; the driver validates every call at draw time | Pipelines + bind groups baked up front; command encoders; validation mostly at creation time |
| Shaders | GLSL ES 3.00 | WGSL |
| CPU overhead per draw call | High — the cost shows with *thousands* of draw calls | Low — that's the headline win |
| **Compute shaders** | **None** (the big gap) | First-class: storage buffers, workgroups, GPU-driven pipelines |
| Blending, fill rate, raster | Same silicon, same speed | Same silicon, same speed |
| Availability (mid-2026) | Effectively universal, a decade of driver hardening | Chrome/Edge stable, Safari and Firefox shipped — solid on current browsers, patchier on older devices |
| Debugging / tooling | Mature (Spector.js, browser devtools) | Improving, still younger |

WebGPU's two headline advantages are draw-call throughput and compute.
We use four draw calls, so the first is irrelevant here — but after the
measurements above, the second is exactly the one that matters.

## What WebGPU would buy us — the interesting version

A WebGPU renderer that keeps the CPU sim would benchmark within noise of
the WebGL2 one (same four draw calls, same silicon). The honest case for
`src/webgpu/` is moving the **simulation itself** into compute shaders —
which the measurements above show is where all the time goes:

- advect all seeds and integrate all streamlines in a compute pass (the
  wave field is analytic — perfect for massively parallel evaluation;
  the ~160k `surf()` calls that cost 16 ms in JavaScript are trivial
  work for a GPU)
- spawn/age spray in a storage buffer, fully GPU-resident
- tessellate ribbons in compute (or a vertex shader reading storage
  buffers) so the per-frame CPU→GPU vertex upload disappears entirely

That version could raise the ceiling from ~3,000 streamlines to tens of
thousands, at which point the *visual* language changes (denser ink,
finer combing). It is a rewrite of the sim, not a rasteriser swap —
which is why it makes a fair head-to-head experiment: `webgl` (CPU sim +
GPU raster) vs `webgpu` (GPU sim + GPU raster), same controls, Stats
showing fps and ms for both.

The occlusion mask ("Solid") would also change shape there: today it is
a CPU byproduct of the shared sim; a GPU-resident sim would replace it
with a real depth buffer, which is arguably the more correct tool.

## Current architecture (so the comparison stays fair)

`src/core/sim.ts` fills renderer-agnostic stroke/dot buckets;
`src/canvas/` and `src/webgl/` are pure rasterisers over the same data.
A future `src/webgpu/` renderer can slot in at either level: as a third
rasteriser (cheap, expect parity), or as the GPU-sim experiment above
(expensive, expect a different ceiling). The renderer switcher in the
panel and the `?renderer=` query parameter already accommodate a third
entry.

## Implementation notes from the WebGL2 build

- Strokes are CPU-tessellated ribbons: two vertices per polyline point,
  pre-expanded to half-width + 1 px feather; the fragment shader turns
  the interpolated signed distance into anti-aliased coverage,
  energy-conserved so sub-pixel strokes carry the same additive light as
  Canvas 2D's coverage AA. All polylines of a frame go out as **one**
  triangle strip with degenerate bridges.
- Ghost trails live in a persistent RGBA8 accumulation framebuffer: fade
  quad (α 0.5) → additive strokes/dots (`ONE, ONE` — Canvas 2D
  'lighter') → present blit. Blending stays in the same non-linear 8-bit
  space as Canvas 2D, so the renderers match visually.
- The one real bug of the port: leaving the accumulation texture bound
  to a sampler unit while rendering into its framebuffer is a **feedback
  loop** — Chrome silently drops those draw calls. The fade pass never
  ran and the trails saturated to white over ~a minute. Unbind the
  texture before drawing into the FBO.
