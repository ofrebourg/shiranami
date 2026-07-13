# WebGL2 vs WebGPU in shiranami — design notes and measurements

Written as the GPU renderers landed. Three questions: why raw WebGL2 and
not three.js, what the measurements actually showed, and what the WebGPU
implementation changed. All three renderers are live behind the panel's
switcher (`?renderer=canvas|webgl|webgpu`).

## What the workload is

Per frame the simulation produces ~3,000 streamlines (up to 62 points
each, tapered, additively blended), up to 2,600 spray dots, a translucent
fade quad (ghost trails), a present blit, and optionally a webcam
texture. A handful of draw calls — no scene graph, no thousands of
objects.

The frame cost splits into:

1. **Integrating the streamlines** — ~160k evaluations of the analytic
   wave field per frame at max load. This is arithmetic, not rendering.
2. **Rasterising the strokes** — additive anti-aliased ribbons over the
   whole screen.

## Measurements (M-series Mac, Chrome, 120 Hz display, July 2026)

`ms cpu` is the Stats readout: main-thread cost of `tick()` + `draw()`.

| renderer | sim runs on | defaults (1,451 lines) | max load (2,680 lines × 60 steps) |
|---|---|---|---|
| canvas | CPU | — | **61 fps** · 16.0 ms cpu |
| webgl | CPU | 120 fps · 7.0 ms cpu | **63 fps** · 15.8 ms cpu |
| webgpu | GPU (compute) | 120 fps · 1.9 ms cpu | **120 fps** · 2.2 ms cpu |

Findings, in the order they corrected our assumptions:

1. **Canvas 2D was never the bottleneck.** Chrome's 2D canvas is
   GPU-accelerated (Skia); swapping the rasteriser to WebGL2 changed the
   frame cost by ~1%. The folklore "Canvas 2D dies rasterising on the
   CPU" is a decade stale.
2. **The simulation was the bottleneck.** ~16 ms of JavaScript wave-field
   math at max load — which on a 120 Hz panel means the CPU renderers
   run at *half* refresh (16 ms > 8.3 ms budget). They weren't
   vsync-limited at "60 fps"; they were sim-bound.
3. **Moving the sim into a compute shader doubled the frame rate** and
   cut main-thread cost ~7×: 2,680 lines at a locked 120 Hz with 2.2 ms
   of CPU. That headroom is exactly what recording needs — the VP9
   encoder now gets almost the whole main thread.

## Why not three.js

three.js earns its keep managing many heterogeneous objects: scenes,
cameras, materials, lights, model loading. This is one bespoke effect
with its own 2.5D projection, and three.js's line primitives (`Line` =
1px GL lines, `Line2`/`LineMaterial` = uniform width per material) can't
draw the tapered, per-section-styled strokes anyway — it would be the
same custom shaders plus ~170 KB of library. Revisit only for real 3D
camera moves; bloom-style post-processing is one extra pass over the
accumulation texture in any of these renderers.

## WebGL2 vs WebGPU, honestly

| | WebGL2 (GL ES 3.0 model, 2011) | WebGPU (Metal/Vulkan/D3D12 model, 2023+) |
|---|---|---|
| Programming model | Global state machine; driver validates at draw time | Pipelines + bind groups baked up front; command encoders |
| Shaders | GLSL ES 3.00 | WGSL |
| Draw-call overhead | High — matters with *thousands* of calls | Low |
| **Compute shaders** | **None** | First-class: storage buffers, atomics, workgroups |
| Blending / fill rate | Same silicon, same speed | Same silicon, same speed |
| Availability (mid-2026) | Effectively universal | Chrome/Edge/Safari/Firefox shipped; older devices patchier |
| Tooling | Mature | Younger, improving |

WebGPU's headline advantages are draw-call throughput and compute. With
four draw calls we don't care about the first; the measurements showed
the second was the whole game. A WebGPU renderer that kept the CPU sim
would have benchmarked within noise of WebGL2 — the win came from
`@compute`, not from the raster API.

## How the WebGPU renderer is built (src/webgpu/)

Division of labour:

- **CPU (~1 ms):** seed advection, spray physics, ballistic spawning,
  MIDI/UI — the cheap stateful parts (`tick(dt, false)`).
- **GPU compute pass 1 (`integrate`):** one thread per streamline
  integrates up to 62 steps through the wave field (WGSL port of
  `surf`/`fbm`/`hsh` — the hash is bit-identical, JS `|0`/`imul`/`>>>`
  being exactly u32 wrapping), styles each 5-point section with the same
  quantisation as the CPU renderers, and writes expanded ribbon points
  straight into a storage buffer. Per frame the CPU uploads ~100 KB of
  launch state instead of megabytes of tessellated vertices.
- **GPU compute pass 2 (`foldmask`):** Solid-mode occlusion, same
  algorithm as the CPU mask — pass 1 `atomicMin`s every drawn line point
  into a depth-binned silhouette; this pass folds it into a
  nearer-bins-min table.
- **Render:** strokes are vertex-pulled from the point buffer (6
  vertices per segment), dots are instanced quads projected in the
  vertex shader from the raw spray pool, trails/fade/present as in the
  WebGL renderer.
- **Rider foam feedback:** the compute pass appends breaking-point
  candidates to a small buffer; the CPU maps it back asynchronously and
  spawns the foam one frame later (invisible at 120 Hz), so spray
  physics stays CPU-side and identical across renderers.

Two porting lessons worth keeping:

- Occlusion must cull at **segment granularity in the vertex stage**,
  like the CPU renderers cull points. Testing per fragment exposes the
  mask's raw 8px-column cells as rectangular holes in the strokes.
- Phases accumulate in f64 on the CPU and are wrapped mod 2π before
  entering f32 uniforms, or long sessions drift.

## What's still on the table

- The stroke ceiling (2,680 lines, 62 steps) is now a CPU-renderer
  limit, not a GPU one — the compute path has room for tens of
  thousands of streamlines, where the visual language itself changes
  (denser ink, finer combing). Raising it means either a webgpu-only
  cap or accepting that the canvas/webgl settings crawl.
- Post-processing (crest bloom) is one extra pass over the accumulation
  texture in either GPU renderer.
- A GPU-resident spray pool (spawn/age in compute) would remove the
  last per-frame CPU work, at the cost of splitting the spray behaviour
  between renderers.
