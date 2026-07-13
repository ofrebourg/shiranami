# shiranami

白波 — white waves on black water. A generative homage to teamLab's [*Black Waves*](https://www.teamlab.art/w/blackwaves/), played on a piano.

In Edo-period kabuki, *shiranami-mono* were "white-wave plays". This one is a white-wave play in the other sense: the ocean's controls are driven live by MIDI data from an instrument. When nothing is being played, the water falls to a sparse, slow, near-black calm; music raises it.

## What it is

Not a picture of a wave — a fluid simulation made visible as lines. Streamlines are integrated through a wave field (orbital drift + curl noise over a phase-warped swell) and drawn as thousands of tapered ink strokes; crests whiten, troughs recede, and breaking crests shed foam that follows the two-stage whitecap model (active foam rides the breaking front, residual foam is left behind to decay). Rendered near-monochrome on black, from a low, near-water angle.

Run with hot reload:

```sh
pnpm install
pnpm dev          # http://localhost:5173
```

## Architecture

TypeScript + Vite. The simulation and the rasteriser are split so the same
picture can be drawn by different graphics APIs:

```
src/core/sim.ts     the water: params, wave field, streamline integration,
                    spray, occlusion — fills renderer-agnostic stroke/dot
                    buckets each frame (DOM-free, runs headless)
src/canvas/         Canvas 2D rasteriser (the reference implementation)
src/webgl/          WebGL2 rasteriser (default): one triangle strip of
                    tapered ribbons, point-sprite dots, FBO ghost trails
src/webgpu/         WebGPU renderer: the simulation itself runs in a
                    compute shader — streamline integration, styling and
                    the occlusion mask on the GPU; the CPU keeps seeds,
                    spray physics and MIDI
src/core/record.ts  recording · src/core/cam.ts webcam PiP
src/midi.ts         the MIDI mapping
src/main.ts         boot, UI wiring, renderer selection
```

The panel button showing the active renderer name cycles through the
three (reloads the page — a canvas element can only hold one context
type); `?renderer=canvas|webgl|webgpu` overrides, and the choice is
remembered. Fallback chain: webgpu → webgl → canvas.

**On performance, honestly:** the bottleneck was never rasterisation
(Chrome's Canvas 2D is GPU-accelerated; swapping to WebGL2 changed frame
cost by ~1%) — it was the *simulation*: ~16 ms/frame of wave-field
JavaScript at max load, which halves a 120 Hz display to 60 fps. The
WebGPU renderer moves that integration into a compute shader: same scene
at max load runs 120 fps with ~2 ms of main-thread work (canvas/webgl:
~60 fps at ~16 ms). Measurements and design notes in
[docs/webgl2-vs-webgpu.md](docs/webgl2-vs-webgpu.md).

## Controls

| Control | What it does |
|---|---|
| Strokes | Number of streamlines (~280–2,700) |
| Chaos | Turbulence; steepens faces — the master breaking control. Low Chaos = laminar swells, no spray at all |
| Brush | Stroke width/softness: thin crisp ink ↔ soft washes |
| Detail | Curve resolution: segments per streamline (16–60). Main performance dial after Strokes |
| Body | Viscosity: damps turbulence, slows drift |
| Height | Crest amplitude |
| Swell | Wavelength of the primary rhythm (crossfaded between fixed octaves, so changes blend like a sea changing state instead of rephasing); also sets stroke length and foam travel speed |
| Spray | Quantity of detached particles where breaking happens; 0 = none |
| Foam | How aggressively crests whiten: ridge band, spawn rate, energy threshold |
| Linger | Residual foam lifetime, ×0.4–×2.5 (on top of the built-in scaling with wave height) |
| Pace | Global speed |
| Midi | Toggle live MIDI control (see below) |
| Record | Record a performance to `.webm` (see Recording) — Esc stops |
| Cam | Webcam picture-in-picture, greyscaled, drawn onto the canvas — so it appears in recordings |
| Solid | Occlusion mode: waves hide what's behind them (mask built from the drawn lines themselves) |
| webgpu / webgl / canvas | The active renderer; click to cycle (reloads) |
| Stats | `renderer · fps · ms cpu · lines · dots` readout |

Click the water to hold/release. While held, every control re-renders the frozen frame — including the Solid toggle, for A/B comparison.

## MIDI

Toggle **Midi** in the panel. Two input paths:

1. **[midi-bridge](https://github.com/ofrebourg/midi-bridge)** SSE stream on `localhost:3000` — preferred when the bridge is running. Override the URL with `?bridge=http://host:port`.
2. **Web MIDI API** (Chrome/Edge) as automatic fallback — direct connection to the instrument.

Exactly one source is active at a time (both at once would double-count every note). Every received event is logged to the console as `[shiranami midi] …`, and with **Stats** on, the readout shows the live source and note rate (`midi bridge · 3.5 n/s`).

The mapping (from the design brief, smoothed with fast attack / slow release so the water never strobes):

| Musical feature | Drives |
|---|---|
| Note density | Strokes |
| Tempo (inter-onset intervals) | Pace up, Swell down |
| Average velocity | Height, Foam |
| Velocity spikes | Spray — transient bump, ~1.5 s decay (the one unsmoothed mapping) |
| Dissonance of sounding pitch classes | Chaos |
| Articulation (staccato ↔ legato) | Brush |
| Pitch spread | Body |
| Silence | Everything decays to minimum |

Not yet wired: palette/depth/direction (constants in the code), and the Solid flip on section boundaries — Solid stays a manual toggle for now. Linger is deliberately not MIDI-driven — it stays yours while the music drives the rest.

## Recording

**Record** in the panel captures the animation *and* the piano into a single `.webm` — audio and video share one clock inside one file, so nothing ever needs aligning. **Esc** (or clicking again) stops and downloads `shiranami-YYYYMMDD-HHMMSS.webm`. The capture is canvas-only: the title, panel and stats never appear in the file, so every recording is automatically a clean stage.

Details worth knowing:

- Video is 60 fps at full retina resolution, 14 Mbps VP9 — thin bright lines on black are the worst case for compression, so the bitrate is deliberately high.
- Audio comes from the **system-default input** via `getUserMedia`, with echo cancellation, noise suppression and auto-gain all disabled (they are speech features and they mangle a piano — but it also means nothing protects against clipping: do a fortissimo level check before a real take).
- If mic permission is denied or no input exists, it degrades to video-only; hover the button while recording to see which ("recording with audio" / "recording video only").
- Keep the tab visible and the Mac awake — browsers throttle hidden tabs, which freezes the capture.
- Fullscreen note: Esc exits fullscreen *and* stops the recording in one press.
- **Cam** adds a webcam picture-in-picture (bottom-right, greyscale, hairline frame). It is composited onto the canvas itself, so it appears in recordings automatically and stays in sync; toggle it off to release the camera. With several cameras, **shift-click cycles between them** (the tooltip names the active one) and the choice is remembered.

### Piano audio chain (Kawai CA-701)

The CA-701's **USB to Host is MIDI-only** (no USB audio), and its Bluetooth Audio is a receiver — it plays the computer's sound, never sends the piano's. The clean sound path is the rear **LINE OUT L/MONO + R** jacks (speakers keep sounding, no headphone muting):

```
piano LINE OUT (2× 6.3mm TS) → USB audio interface → Mac
```

- Cable: 2× 6.3mm TS → 2× RCA for a Behringer UCA202-class interface, or 2× TS → TS for a Focusrite-class one. Use both jacks — the stereo image is worth keeping.
- Set the interface as input in System Settings → Sound; the Record button picks up whatever the system default is.
- Check whether master volume affects line-out level on your unit; if so, fix a volume position and keep it consistent between takes so the interface gain stays valid.
- While cabling: MIDI over the same USB to Host beats Bluetooth MIDI on latency and dropouts. The bridge opens the first MIDI port it finds — check its startup log, and disconnect Bluetooth MIDI if the wrong port wins.

For archival takes, consider also recording the interface to a lossless WAV (QuickTime) alongside — the in-sync webm for immediate use, a master for later.

## Credits

Visual concept: teamLab's *Black Waves* series. Foam model grounded in the whitecap literature (active vs residual foam stages; spilling vs plunging breakers). Built with Claude.
