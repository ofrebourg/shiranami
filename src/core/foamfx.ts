// Foam rendering mode — how SURFACE foam (the riders / residual patches)
// is drawn. Airborne ballistic spray stays droplets in every mode.
//
//   dots  — soft discs (the original look)
//   lace  — noise-eroded splats: patches dissolve into filigree as they age
//   froth — world-space accumulation: foam splats into a persistent
//           top-down (x,z) map that decays on Linger's clock; the
//           composite re-projects each screen pixel onto the water, so
//           the sheets ride the swells instead of sticking to the screen
//   silk  — froth's sheet with lace dots on top
//
// Grounding: Tessendorf-Jacobian oceans treat foam as a surface field;
// production ocean renderers (e.g. Crest) keep a decaying foam sim
// texture; close up, real foam reads as noise-eroded lace.

export const FOAM_FX = ['dots', 'lace', 'froth', 'silk'] as const;
export type FoamFx = (typeof FOAM_FX)[number];

export const foamfx = { mode: 'lace' as FoamFx };
try {
  const saved = localStorage.getItem('shiranami-foamfx');
  if (saved && (FOAM_FX as readonly string[]).includes(saved)) foamfx.mode = saved as FoamFx;
} catch (e) {}

export function cycleFoamFx(): FoamFx {
  const i = FOAM_FX.indexOf(foamfx.mode);
  foamfx.mode = FOAM_FX[(i + 1) % FOAM_FX.length];
  try { localStorage.setItem('shiranami-foamfx', foamfx.mode); } catch (e) {}
  return foamfx.mode;
}
