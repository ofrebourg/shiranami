// Shiranami simulation core — the CPU half of the simulation: seed
// advection, spray/foam physics, swell state and the derived parameters.
// The WebGPU renderer integrates and draws the streamlines itself
// (src/webgpu); this module hands it per-line launch state via
// fillLineInputs(). DOM-free by design, so it runs headless.

export const TAU = Math.PI * 2;

// ---- world constants ------------------------------------------------
export const ZNEAR = 90, ZFAR = 1500; // depth range of the water sheet
export const CAMH = 64;               // camera height above mean water level
export const MAXN = 8000;             // streamline seed capacity
export const STEPS = 122;             // step CAPACITY; live count comes from Detail
export const MAXS = 15000;            // spray dot capacity
export const GRAV = 300;              // spray gravity (world units / s^2)

// swell propagation direction (toward the viewer) and its perpendicular
export const BX = 0.924, BZ = -0.382;
const PXX = 0.382, PZZ = 0.924;

// ---- viewport --------------------------------------------------------
export let W = 0, H = 0, DPR = 1, FOCAL = 600;
let horizonBase = 0;

// ---- live parameters (0..1) -------------------------------------------
export type ParamKey =
  | 'strokes' | 'chaos' | 'brush' | 'detail' | 'body' | 'height'
  | 'swell' | 'spray' | 'foam' | 'linger' | 'pace';

export const P: Record<ParamKey, number> = {
  strokes: 0.21, chaos: 0.45, brush: 0, detail: 0.25, body: 0.5,
  height: 0.55, swell: 0.5, spray: 0.5, foam: 0.5, linger: 0.5, pace: 0.5,
};

interface Derived {
  N: number; amp: number;
  bendT: number; turbT: number; bend: number; turb: number;
  drift: number; breakSlope: number; crest: number; foamRate: number;
  linger: number; baseW: number; alphaMul: number;
  steps: number; stepScale: number; sprayAmt: number; riderTh: number; pace: number;
  k1: number; om: number; phaseC: number; step: number;
}

export const D = {} as Derived;
let bendInit = false;

export function derive(): void {
  D.N = Math.round(280 + 7720 * Math.pow(P.strokes, 1.2));
  D.amp = 8 + 72 * Math.pow(P.height, 1.25);
  // k1/om/phaseC/step are swell-derived and updated per-frame in
  // updateSwell(), eased so Swell morphs instead of rephasing the ocean
  // combing/turbulence are TARGETS, eased per-frame in updateSwell():
  // bend applies to the whole field at once, so a fast Chaos change
  // (MIDI velocity spikes) visibly re-combs the ocean if applied raw
  D.bendT = 0.35 + 1.35 * P.chaos;
  D.turbT = Math.pow(P.chaos, 1.4) * 2600 * (1.25 - 0.6 * P.body);
  if (!bendInit) { D.bend = D.bendT; D.turb = D.turbT; bendInit = true; }
  D.drift = 0.55 + 0.75 * (1 - P.body);                 // seed advection
  D.breakSlope = 0.9 - 0.62 * P.chaos;                  // face slope that breaks
  D.crest = 0.86 - 0.10 * P.chaos - 0.30 * P.foam;      // ridge band that can foam
  D.foamRate = 0.3 + 2.1 * P.foam;
  D.linger = Math.pow(2.5, 2 * P.linger - 1);           // foam lifetime x0.4..x2.5
  D.baseW = 0.35 + 0.46 * P.brush;    // capped low: thick washes drowned the ink
  D.alphaMul = 1.02 - 0.1 * P.brush;
  // curve resolution: more, shorter segments over the SAME world length
  D.steps = Math.round(16 + 104 * P.detail);
  D.stepScale = 30 / D.steps;
  D.sprayAmt = P.spray * 2;                             // 0 = purist calm
  D.riderTh = 0.62 - 0.5 * P.foam;                      // energy where crests shed foam
  D.pace = 0.15 + 2.0 * Math.pow(P.pace, 1.1);
}
derive();

// ---- streamline seeds --------------------------------------------------
const px = new Float32Array(MAXN);
const pz = new Float32Array(MAXN);
const age = new Float32Array(MAXN);
const life = new Float32Array(MAXN);
let activeN = 0;

// ---- spray dots -----------------------------------------------------------
// exported: the GPU renderer projects and styles the dots in a shader, so
// it reads the raw pool instead of the CPU-projected dot buckets
export const sx = new Float32Array(MAXS), sy = new Float32Array(MAXS), sz = new Float32Array(MAXS);
const svx = new Float32Array(MAXS), svy = new Float32Array(MAXS), svz = new Float32Array(MAXS);
export const sage = new Float32Array(MAXS), slife = new Float32Array(MAXS), ssize = new Float32Array(MAXS);
export const svis = new Float32Array(MAXS); // visibility from breaking energy at spawn
export const styp = new Uint8Array(MAXS);   // 0 = rider (foam on the ridge), 1 = ballistic

let frame = 0;
export let simT = 0, camX = 0, horizonY = 0;
export let lastN = 0;
export let sprayN = 0;
export let solid = true;
export function setSolid(v: boolean): void { solid = v; }

// ---- noise -----------------------------------------------------------
function hsh(i: number, j: number): number {
  let n = (i * 374761393 + j * 668265263) | 0;
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}
function vnoise(x: number, y: number): number {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hsh(xi, yi), b = hsh(xi + 1, yi), c = hsh(xi, yi + 1), d = hsh(xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
function fbm(x: number, y: number): number {
  return vnoise(x, y) * 0.65 + vnoise(x * 2.13 + 11.7, y * 2.13 + 5.2) * 0.35;
}

// ---- wave field ------------------------------------------------------
function surf(x: number, z: number, w: number): number {
  const u1 = x * 0.92 - z * 0.38;
  const pw = w * 1.9;
  let v = (Math.sin(K0s * u1 - PH0 + pw) * W0s + Math.sin(K1s * u1 - PH1 + pw) * W1s) * 0.62
        + Math.sin(K2 * (x * 0.57 + z * 0.72) - ph2 + w * 2.7) * 0.27
        + Math.sin(K3 * (x * 0.8 + z * 0.6) + ph3) * (0.06 + 0.14 * P.chaos);
  // asymptotic knee: compresses toward ±1.12 but never goes flat — the
  // previous knee still hard-capped at 0.96, which sliced aligned crests
  // into level plateaus (the "ceiling" visible at maxed Height)
  if (v > 0.8) {
    const t = v - 0.8;
    v = 0.8 + 0.32 * t / (t + 0.32);
  } else if (v < -0.8) {
    const t2 = -v - 0.8;
    v = -0.8 - 0.32 * t2 / (t2 + 0.32);
  }
  // the asymptotic knee can graze past -1 when every component aligns
  // negative; a negative base with a fractional exponent is NaN
  return (2 * Math.pow(Math.max((v + 1) * 0.5, 0), 1.55) - 1) * D.amp;
}

function xSpan(z: number): number { return (W * 0.62 + 80) * z / FOCAL; }

function respawn(i: number): void {
  const z = ZNEAR + (ZFAR - ZNEAR) * Math.pow(Math.random(), 1.5);
  pz[i] = z;
  px[i] = camX + (Math.random() * 2 - 1) * xSpan(z);
  age[i] = 0;
  life[i] = 5 + 9 * Math.random();
}

// vis (0..1) comes from the local breaking energy: weak crests barely
// register, only a true break reads as spray.
// ux/uz is the local streamline direction at the spawn point — spray must
// travel with the combing around it, not the global swell heading
function spawnDot(x: number, y: number, z: number, u: number, type: number,
                  vis: number, ux: number, uz: number): void {
  if (sprayN >= MAXS) return;
  const i = sprayN++;
  sx[i] = x; sy[i] = y; sz[i] = z;
  if (type === 0) { // rider: stage-A whitecap foam, born riding the
    // breaking front at ~phase speed; the update loop decays it into
    // stage-B residual foam that the wave leaves behind.
    // Larger waves keep their foam longer (Callaghan 2012)
    const rf = D.phaseC * (0.8 + 0.25 * Math.random());
    svx[i] = rf * ux + (Math.random() - 0.5) * 30;
    svy[i] = 0;
    svz[i] = rf * uz + (Math.random() - 0.5) * 30;
    // stage-B outlasts stage-A: long enough to linger between waves
    slife[i] = (1.5 + Math.random() * 2.4) * (0.7 + D.amp / 160) * D.linger;
  } else {          // ballistic: flung forward off a breaking face.
    // Water at a plunging crest moves forward near phase speed — faster
    // than it rises — so the arc leans with the wave instead of fountaining.
    // Depth component flattened: toward-viewer motion above camera height
    // projects UPWARD on screen and reads as a vertical fountain
    let puz = uz * 0.45;
    const pn = Math.sqrt(ux * ux + puz * puz);
    const pux = ux / pn;
    puz /= pn;
    const th = 0.5 + 0.9 * vis;
    const fwd = D.phaseC * (0.5 + 0.4 * Math.random()) * (0.7 + 0.6 * vis);
    svx[i] = fwd * pux + (Math.random() - 0.5) * (50 + 120 * P.chaos) * th;
    svy[i] = (20 + Math.random() * (35 + 85 * P.chaos)) * th;
    svz[i] = fwd * puz + (Math.random() - 0.5) * 60 * th;
    slife[i] = 0.4 + Math.random() * 0.8;
  }
  sage[i] = 0;
  ssize[i] = (0.6 + Math.random()) * (0.5 + 0.5 * vis) * (1 + 0.5 * P.foam);
  svis[i] = vis;
  styp[i] = type;
}

// Swell CROSSFADES between fixed wavelength octaves instead of morphing
// one wavelength. Phase = k*position, so changing k rephases the whole
// field — at ANY easing speed, far crests sweep through cycles (a 160
// units/s capped glide still lurched). With fixed octaves only their
// amplitudes change: the old swell fades as the new one grows, which is
// how a real sea changes state. Chop and ripple keep fixed mid-scale
// wavelengths for the same reason. Each octave runs its own phase at its
// own frequency — real dispersion, long waves genuinely travel slower.
const SW_LEN = [240, 420, 700, 1120];
const SW_K: number[] = [], SW_OM: number[] = [];
const swPh = [0, 0, 0, 0];
for (let so = 0; so < 4; so++) {
  SW_K.push(TAU / SW_LEN[so]);
  SW_OM.push(2.0 / Math.sqrt(SW_LEN[so] / 320));
}
let swIdx = P.swell * 3;
// exported live: the GPU sim (src/webgpu) evaluates the same wave field in
// WGSL and needs the swell state as uniforms every frame
export let W0s = 1, W1s = 0, K0s = SW_K[0], K1s = SW_K[1], PH0 = 0, PH1 = 0;
export let ph2 = 0, ph3 = 0;
export const K2 = 2.6 * TAU / 560;
export const K3 = 6.2 * TAU / 560;
const OM2 = 1.55 * 2.0 / Math.sqrt(560 / 320);
const OM3 = 0.9 + 0.5 * 2.0 / Math.sqrt(560 / 320);

function updateSwell(sdt: number): void {
  const idxT = P.swell * 3;
  if (sdt > 0) swIdx += (idxT - swIdx) * (1 - Math.exp(-sdt / 1.1));
  else swIdx = idxT; // paused still-render: snap, like every other control
  let i0 = Math.floor(swIdx);
  if (i0 > 2) i0 = 2; else if (i0 < 0) i0 = 0;
  let f = swIdx - i0;
  if (f < 0) f = 0; else if (f > 1) f = 1;
  const t = f * f * (3 - 2 * f);
  // energy-normalised weights: the sea keeps its mass mid-blend instead
  // of deflating while two half-strength swells coexist
  const nrm = 1 / Math.sqrt((1 - t) * (1 - t) + t * t);
  W0s = (1 - t) * nrm; W1s = t * nrm;
  K0s = SW_K[i0]; K1s = SW_K[i0 + 1];

  const lenB = SW_LEN[i0] * (1 - f) + SW_LEN[i0 + 1] * f;
  D.k1 = TAU / lenB;
  D.om = 2.0 / Math.sqrt(lenB / 320);
  D.phaseC = D.om / D.k1;
  D.step = lenB / 34;

  for (let i = 0; i < 4; i++) swPh[i] += SW_OM[i] * sdt;
  PH0 = swPh[i0]; PH1 = swPh[i0 + 1];
  ph2 += OM2 * sdt;
  ph3 += OM3 * sdt;

  const eb = sdt > 0 ? 1 - Math.exp(-sdt / 1.2) : 1;
  D.bend += (D.bendT - D.bend) * eb;
  D.turb += (D.turbT - D.turb) * eb;
}

// ---- simulation + collection ---------------------------------------------
export function tick(dt: number): void {
  const sdt = dt * D.pace;
  simT += sdt;
  frame++;
  camX = 46 * Math.sin(simT * 0.037) + 22 * Math.sin(simT * 0.013 + 2);
  horizonY = horizonBase + 6 * Math.sin(simT * 0.09);
  updateSwell(sdt);

  while (activeN < D.N && activeN < MAXN) { respawn(activeN); activeN++; }
  const n = Math.min(activeN, D.N);
  lastN = n;
  // no spawning on a zero-dt re-render (paused stills), or dots multiply
  let budget = sdt > 0 ? 46 + Math.round(44 * P.foam) : 0;
  const tt = simT * 0.055, ns = 0.0055, e = 7;
  const nb = 0.0035, t3 = simT * 0.045;

  for (let i = 0; i < n; i++) {
    age[i] += sdt;
    if (age[i] > life[i]) respawn(i);

    let x = px[i], z = pz[i];
    const w = vnoise(x * 0.0016 + 3.7, z * 0.0016 - simT * 0.01) * 2 - 1;
    const hc = surf(x, z, w);

    // advect the seed: orbital drift along the swell + curl-noise turbulence
    const ps0 = fbm(x * ns, z * ns + tt);
    const tvx = (fbm(x * ns, (z + e) * ns + tt) - ps0) / e * D.turb;
    const tvz = -(fbm((x + e) * ns, z * ns + tt) - ps0) / e * D.turb;
    const u = hc * D.om * 0.9;
    x += (u * BX * D.drift + tvx) * sdt;
    z += (u * BZ * D.drift + tvz) * 0.8 * sdt;

    if (z < ZNEAR * 0.8 || z > ZFAR) { respawn(i); continue; }
    const span = xSpan(z), dxc = x - camX;
    if (dxc > span) x -= span * 2;
    else if (dxc < -span) x += span * 2;
    px[i] = x; pz[i] = z;

    // breaking check at the seed: steep forward face near a crest.
    // "over" is how far past the breaking slope the face is — only a real
    // break (over > 1) throws droplets, and harder breaks throw brighter ones
    const faceSlope = (surf(x + 12 * BX, z + 12 * BZ, w) - hc) / 12;
    const over = -faceSlope / D.breakSlope;
    const seedSx = W * 0.5 + (x - camX) * FOCAL / z;
    if (over > 1 && hc > D.amp * 0.45 && budget > 0 &&
        seedSx > -20 && seedSx < W + 20 &&
        Math.random() < (0.03 + 0.14 * P.chaos) * D.sprayAmt * Math.min(1, over - 0.7)) {
      let bvis = (over - 1) * 2.2;
      if (bvis > 1) bvis = 1;
      // local combing direction at the seed, matching the streamline's
      // first step, so the throw follows the lines around it
      const bendS = (fbm(x * nb + i * 0.7, z * nb + t3) * 2 - 1) * D.bend;
      const dsX = BX + PXX * bendS, dsZ = BZ + PZZ * bendS;
      const nrmS = Math.sqrt(dsX * dsX + dsZ * dsZ);
      spawnDot(x, hc + 2, z, u, 1, 0.35 + 0.65 * bvis, dsX / nrmS, dsZ / nrmS);
      budget--;
    }
  }

  // ---- spray dots ---------------------------------------------------------
  for (let j = 0; j < sprayN; j++) {
    sage[j] += sdt;
    const dead = sage[j] > slife[j] || sz[j] < ZNEAR * 0.7 || sz[j] > ZFAR;
    if (!dead) {
      if (styp[j] === 1) {
        svy[j] -= GRAV * sdt;
        svx[j] += (Math.random() - 0.5) * 500 * P.chaos * sdt;
        sx[j] += svx[j] * sdt;
        sy[j] += svy[j] * sdt;
        sz[j] += svz[j] * sdt;
        if (svy[j] < 0) {
          const wv1 = vnoise(sx[j] * 0.0016 + 3.7, sz[j] * 0.0016 - simT * 0.01) * 2 - 1;
          const hs1 = surf(sx[j], sz[j], wv1);
          if (sy[j] < hs1) {
            // splash-down: the jet impact injects a bubble plume, so the
            // droplet becomes a passive residual foam patch, not nothing
            styp[j] = 0;
            sage[j] = 0;
            slife[j] = (0.9 + Math.random() * 1.6) * D.linger;
            svx[j] *= 0.15; svz[j] *= 0.15; svy[j] = 0;
            svis[j] *= 0.75;
            sy[j] = hs1 + 2;
          }
        }
      } else {
        // stage-A -> stage-B: the breaking front outruns its foam.
        // Horizontal speed decays toward passive advection (~zero drift),
        // so the wave moves on and leaves the residual patch behind
        const rlx = Math.min(1, 1.8 * sdt);
        svx[j] -= svx[j] * rlx;
        svz[j] -= svz[j] * rlx;
        const wv2 = vnoise(sx[j] * 0.0016 + 3.7, sz[j] * 0.0016 - simT * 0.01) * 2 - 1;
        const hs = surf(sx[j], sz[j], wv2);
        // downslope slide: passing crests shed their residue, hollows
        // keep it — the drag above sets the terminal drift speed
        const gsx = (surf(sx[j] + 10, sz[j], wv2) - hs) * 0.1;
        const gsz = (surf(sx[j], sz[j] + 10, wv2) - hs) * 0.1;
        svx[j] -= gsx * 240 * sdt;
        svz[j] -= gsz * 240 * sdt;
        sx[j] += svx[j] * sdt;
        sz[j] += svz[j] * sdt;
        // foam is passive: vertical follow capped near orbital speed,
        // so it cannot draw steep vertical strings on a passing face
        let want = (hs + 3 - sy[j]) * 8;
        const vmax = D.amp * D.om * 1.6;
        if (want > vmax) want = vmax; else if (want < -vmax) want = -vmax;
        sy[j] += want * sdt;
      }
    }
    if (dead) {
      sprayN--;
      if (j < sprayN) {
        sx[j] = sx[sprayN]; sy[j] = sy[sprayN]; sz[j] = sz[sprayN];
        svx[j] = svx[sprayN]; svy[j] = svy[sprayN]; svz[j] = svz[sprayN];
        sage[j] = sage[sprayN]; slife[j] = slife[sprayN];
        ssize[j] = ssize[sprayN]; styp[j] = styp[sprayN];
        svis[j] = svis[sprayN];
        j--;
      }
      continue;
    }
  }
}

// ---- viewport --------------------------------------------------------------
export function resizeSim(w: number, h: number, dpr: number): void {
  W = w;
  H = h;
  DPR = dpr;
  FOCAL = H * 0.95;
  horizonBase = H * 0.36;
}

// ---- GPU-sim support --------------------------------------------------------
// The renderer integrates the streamlines in a compute shader. These are
// the two bridges it needs: the per-line launch state, and a way to hand
// back the rider-foam spawn points its compute pass detected (one frame
// late, which foam cannot show).

/** per line, 8 floats: x, z, w, u, stepLen, seedIdx, spd, 0. Returns count. */
export function fillLineInputs(out: Float32Array): number {
  const n = Math.min(activeN, D.N);
  lastN = n;
  for (let i = 0; i < n; i++) {
    const x = px[i], z = pz[i];
    const w = vnoise(x * 0.0016 + 3.7, z * 0.0016 - simT * 0.01) * 2 - 1;
    const hc = surf(x, z, w);
    const u = hc * D.om * 0.9;
    const tz0 = (z - ZNEAR) / (ZFAR - ZNEAR);
    let stepLen = D.step * (0.6 + 0.8 * tz0);
    if (stepLen < 7) stepLen = 7; else if (stepLen > 34) stepLen = 34;
    stepLen *= D.stepScale;
    const spd0 = (u < 0 ? -u : u) / (D.amp * D.om + 20);
    const o = i * 8;
    out[o] = x; out[o + 1] = z; out[o + 2] = w; out[o + 3] = u;
    out[o + 4] = stepLen; out[o + 5] = i; out[o + 6] = spd0 > 1 ? 1 : spd0; out[o + 7] = 0;
  }
  return n;
}

/** rider foam from a GPU-detected breaking point (vis already squared) */
export function spawnRider(x: number, yv: number, z: number, u: number,
                           vis: number, ux: number, uz: number): void {
  spawnDot(x, yv + 2 + Math.random() * 3, z, u, 0, vis, ux, uz);
}
