# shiranami

白波 — white waves on black water. A generative homage to teamLab's [*Black Waves*](https://www.teamlab.art/w/blackwaves/), played on a piano.

In Edo-period kabuki, *shiranami-mono* were "white-wave plays". This one is a white-wave play in the other sense: the ocean's controls are driven live by MIDI data from an instrument. When nothing is being played, the water falls to a sparse, slow, near-black calm; music raises it.

## What it is

Not a picture of a wave — a fluid simulation made visible as lines. Streamlines are integrated through a wave field (orbital drift + curl noise over a phase-warped swell) and drawn as thousands of tapered ink strokes; crests whiten, troughs recede, and breaking crests shed foam that follows the two-stage whitecap model (active foam rides the breaking front, residual foam is left behind to decay). Rendered near-monochrome on black, from a low, near-water angle.

Open `index.html` in a browser. No build, no dependencies.

## Controls

| Control | What it does |
|---|---|
| Strokes | Number of streamlines (~280–2,700) |
| Chaos | Turbulence; steepens faces — the master breaking control. Low Chaos = laminar swells, no spray at all |
| Brush | Stroke width/softness: thin crisp ink ↔ soft washes |
| Detail | Curve resolution: segments per streamline (16–60). Main performance dial after Strokes |
| Body | Viscosity: damps turbulence, slows drift |
| Height | Crest amplitude |
| Swell | Wavelength of the primary rhythm; also sets stroke length and foam travel speed |
| Spray | Quantity of detached particles where breaking happens; 0 = none |
| Foam | How aggressively crests whiten: ridge band, spawn rate, energy threshold |
| Pace | Global speed |
| Midi | Toggle live MIDI control (see below) |
| Solid | Occlusion mode: waves hide what's behind them (mask built from the drawn lines themselves) |
| Stats | fps · lines · dots readout |

Click the water to hold/release. While held, every control re-renders the frozen frame — including the Solid toggle, for A/B comparison.

## MIDI

Toggle **Midi** in the panel. Two input paths:

1. **Web MIDI API** (Chrome/Edge): direct connection to the instrument.
2. **[midi-bridge](https://github.com/ofrebourg/midi-bridge)** SSE stream on `localhost:3000`: for browsers without Web MIDI, or a piano attached to another machine. Falls back automatically.

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

Not yet wired: palette/depth/direction (constants in the code), and the Solid flip on section boundaries — Solid stays a manual toggle for now.

## Credits

Visual concept: teamLab's *Black Waves* series. Foam model grounded in the whitecap literature (active vs residual foam stages; spilling vs plunging breakers). Built with Claude.
