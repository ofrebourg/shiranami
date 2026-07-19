# The MIDI → water mapping, fully specified

This is the complete definition of how piano input becomes water, written
to be self-sufficient: a person or a model can propose changes from this
document alone. The implementation is `src/midi.ts` (~150 lines of logic);
every constant here appears literally there. The design brief behind it is
§4c of the Black Waves brief; the tuning protocol is
[tuning-workflow.md](tuning-workflow.md).

## Pipeline

```
NOTE_ON / NOTE_OFF  (from midi-bridge SSE, Web MIDI, or a replayed take)
        │
        ▼
  feature extraction        rolling windows over the note stream
        │                   (features(), ~33 ms cadence)
        ▼
  target computation        musical features → target values 0..1
        │                   (targets())
        ▼
  smoothing                 per-parameter attack/release time constants
        │
        ▼
  P.strokes … P.pace        the renderer's dials (see README controls)
```

Everything is smoothed except where noted — snapping per note makes the
water strobe. Silence decays every feature to zero: no music = sparse,
slow, near-black calm.

## Feature extraction

State kept: `onsets` = last 6 s of note-on events `{t, note, vel01}`;
`held` = currently sounding notes; a few EMAs.

| feature | definition | notes |
|---|---|---|
| `density` | note-ons in the last 2 s ÷ 2 ÷ 6, clamped ≤ 1 | 6 notes/s = full scale |
| `rate` | `0.14 / medianIOI`, clamped ≤ 1; 0 if no IOIs | tempo proxy. IOIs (inter-onset intervals) are collected only when **0.09 s < IOI < 2 s** — anything under 90 ms is the same chord, not tempo (the lesson that chords are not fast playing). Buffer keeps the last 24; median resists outliers |
| `vel` | EMA of onset velocity/127, α = 0.25 | |
| `spread` | (highest − lowest note in last 4 s) / 40, clamped ≤ 1 | ~3.3 octaves = full |
| `tension` | mean interval-class tension over all pairs of sounding + last-1 s pitch classes, × 1.4, clamped ≤ 1. Table (ic 0–6): `[0, .9, .55, .25, .2, .1, 1.0]` | semitone .9, tritone 1.0, fifth .1 — dissonance, not chord names |
| `legato` | `(gateEMA − 0.15) / 0.9` clamped 0..1, where gate = note duration ÷ current median IOI (≤ 1.2), EMA α = 0.15, **initialised 0.15** | staccato ↔ legato. Initialised low so lines start thin (a 0.5 start made the first phrase thick) |
| `rel` | release envelope: 1 while < 1.2 s since last onset, linear to 0 at 2.5 s | multiplies every target — the phrase ends, the sea calms fast. At rel = 0 the IOI buffer clears (next phrase sets its own tempo) and velEMA decays ×0.9/tick |

Derived inside `targets()`:

- `dyn` — perceived dynamics from `vel`: 0 below the **knee 0.22**, then
  `((vel − 0.22)/0.55)^1.35` clamped ≤ 1. MIDI velocity is not loudness:
  quiet playing sits at 0.3–0.4 and mapped linearly kept the sea half-tall
  all evening; below ~mp stays near-flat, mf→ff opens steeply.
- `surgeEnv` — crescendo surge: when `dyn` rises faster than 0.5/s,
  `surge = max(surge, min(1, rise × 0.7))`; decays `exp(−dt/1.8)`. A sea
  that *rises* fast is a sea that breaks — sudden quiet→loud drives
  foam/spray directly, matching the wave-age/whitecap link in the
  oceanography literature.
- `sprayBump` — transient: a velocity spike (v > 0.55 **and** > 1.3 × the
  running average) sets `sprayBump = max(sprayBump, v)`; decays
  `exp(−dt/1.5)`. Deliberately **unsmoothed on attack** — a hit must land
  on the transient.

## Targets

All multiplied by `rel` before smoothing.

| parameter | target | why |
|---|---|---|
| `strokes` | `density` | busier passages → denser line-work |
| `pace` | `rate × 0.9` | faster music → quicker water |
| `swell` | playing ? `max(0.15, 1 − rate × 0.8)` : 0 | fast music → **short** swell: tempo reshapes the drawing (choppy strokes) not just the clock |
| `height` | `dyn` | loudness → amplitude |
| `foam` | `max(dyn × 0.9, surgeEnv × 0.9)` | sustained loudness whitens crests; a crescendo whitens them immediately |
| `chaos` | `max(tension, sprayBump × 0.6, surgeEnv × 0.7)` | dissonance → turbulence. The spike/surge terms exist because Chaos is the master breaking gate: without steepening the water, a hard hit shows nothing |
| `brush` | `legato × 0.5` | legato washes, staccato ink — capped at half range so playing never drowns the thin strokes |
| `body` | `spread` | wide register → heavy, cohesive water |
| `spray` | `max(sprayBump, surgeEnv)` | quantity of thrown droplets |

Not MIDI-driven by design: `detail` (performance dial), `linger` (stays
the performer's), `solid` (structural toggle, awaiting section detection).

## Smoothing

Per tick (~33 ms): `value += (target − value) × (1 − exp(−dt/τ))`, with
values < 0.004 clamped to 0.

| parameter | τ attack (rising) | τ release (falling) |
|---|---|---|
| default | 0.5 s | 1.3 s |
| `pace`, `swell` | 1.4 s | 1.3 s — tempo estimates jitter; slow attack stops chord bursts yanking the clock |
| `spray` | **0.08 s** | 1.2 s — hits must land |

## Known lessons (do not relearn these)

1. **Chords are not tempo** — the < 90 ms IOI filter is the fix; removing
   it maxes Pace on every chord.
2. **Velocity is not loudness** — the dyn knee/exponent is the fix;
   linear velocity keeps the sea tall under quiet playing.
3. **Nothing that multiplies inside `sin(k·x − ωt)` may be driven raw**
   (renderer-side, but tuning proposals sometimes reach for it):
  wavelength, bend, heading must crossfade or ease — see the Swell
  octave-crossfade note in the brief §6.
4. Raw feature → parameter lines are almost always wrong on first
   guess; propose changes with the take-replay protocol, not by feel.

## Hooks for experiments

- `window.shiranami.set/get(param)` — direct parameter access.
- `window.shiranami.midi.inject({type:'NOTE_ON', note, velocity})` —
  synthetic events into the full pipeline.
- `window.shiranami.loadTake(json)` / `takePlay(fromMs)` / `takeStop()` /
  `takeClock()` — scripted replay of recorded performances (see
  tuning-workflow.md; pre-roll ≥ 8 s before any studied moment).
