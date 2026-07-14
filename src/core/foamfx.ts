// Foam rendering mode — how SURFACE foam (the riders / residual patches)
// is drawn. Airborne ballistic spray stays droplets in every mode.
// webgpu-only: the canvas/webgl renderers always draw dots.
//
//   dots  — soft discs (the original look)
//   lace  — noise-eroded splats: patches dissolve into filigree as they age
//   froth — Crest-style accumulation: foam splats into a persistent
//           half-res texture that decays on Linger's clock and composites
//           through animated lace erosion — lingering sheets, not points
//
// Grounding: Tessendorf-Jacobian oceans treat foam as a surface field;
// production ocean renderers (e.g. Crest) keep a decaying foam sim
// texture; close up, real foam reads as noise-eroded lace.

export const FOAM_FX = ['dots', 'lace', 'froth'] as const;
export type FoamFx = (typeof FOAM_FX)[number];

export const foamfx = { mode: 'dots' as FoamFx };
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
