# Tuning the MIDI mapping against recordings

The conversation protocol for adjusting the MIDI→parameter algorithm
using recorded performances, designed to be cheap in both piano time and
analysis effort.

## The artefacts

Recording live with **Midi on** produces a pair sharing one basename:

- `shiranami-YYYYMMDD-HHMMSS.webm` — what the piece looked and sounded like
- `shiranami-YYYYMMDD-HHMMSS.shiranami.json` — the inputs: timestamped
  MIDI, reference audio, webcam; its `video` field names the webm

Keep pairs in `shiranami/takes/` (gitignored) so tuning sessions can find
them.

## The protocol

1. **Reference a moment**: "in `shiranami-20260719-2101`, between 0:30
   and 0:40, I expected Y because Z."
2. **Analysis** (assistant): extract a handful of frames from the webm
   around the timestamps (`ffmpeg -ss 0:30 -i x.webm -vf fps=1 -frames:v
   10 …` — stills, not video, to keep it light); compute the mapping's
   input features over that window straight from the json (note density,
   IOIs, velocity curve, pitch spread, dissonance — the same formulas as
   `src/midi.ts`); compare what the mapping *would* do against the
   expectation.
3. **Cross-checking**: scan the whole take's feature curves for moments
   with the same signature ("this pattern also occurs at 2:38 — same
   expectation there?") before changing constants — one moment is an
   anecdote, recurrences are the behaviour.
4. **Try it**: adjust `src/midi.ts`, then re-render just the discussed
   section in the running app:
   ```js
   shiranami.loadTake(json)            // or import via the Take button
   shiranami.takePlay(22000)           // start ~8s BEFORE the moment —
                                       // envelopes carry state, a cold
                                       // start at 0:30 is not the truth
   // hit Record when takeClock() reaches the section, stop after it
   shiranami.takeStop()
   ```
   The partial webm re-export carries the take's own audio, so A/B
   comparison is watch-and-listen against the original.
5. **Decide**: keep, adjust, or revert; the constants live in
   `src/midi.ts` (`targets()` and `features()`), documented in the brief's
   §4c.

## Ground rules

- Always pre-roll ≥ 8 s before a studied moment (smoothing time-constants
  reach ~zero influence there); state the pre-roll used.
- Replays reproduce control trajectories, not pixels — compare water
  *behaviour*, not exact strokes.
- `ffmpeg` is required for frame extraction (`brew install ffmpeg`).
