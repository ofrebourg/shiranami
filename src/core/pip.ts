// Webcam PiP processing — one offscreen 2D canvas turns the raw video
// frame into the composited card: greyscale treatment and the edge mask
// are baked here, so the renderers (canvas/webgl/webgpu) all just draw
// the processed canvas with straight alpha and stay identical.
//
// The edge effects stop the PiP reading as a pasted rectangle. They are
// shape-only: no colour tints — the animation is near-monochrome and the
// card has to stay in its palette.
//   parchment — fine deckled tears, static
//   deckle    — soft long undulation with fine fibre fray (handmade paper)
//   bitten    — mostly calm edge with occasional deep bites (scorched paper)
//   live      — parchment whose edge slowly drifts, like paper smouldering
//   ember     — bitten whose bites slowly wander — the second living edge
//   frame     — the original: hard rectangle, hairline border

export const PIP_FX = ['parchment', 'deckle', 'bitten', 'live', 'ember', 'frame'] as const;
export type PipFx = (typeof PIP_FX)[number];

export const pip = { fx: 'parchment' as PipFx };
try {
  const saved = localStorage.getItem('shiranami-pip');
  if (saved && (PIP_FX as readonly string[]).includes(saved)) pip.fx = saved as PipFx;
} catch (e) {}

export function cyclePipFx(): PipFx {
  const i = PIP_FX.indexOf(pip.fx);
  pip.fx = PIP_FX[(i + 1) % PIP_FX.length];
  try { localStorage.setItem('shiranami-pip', pip.fx); } catch (e) {}
  return pip.fx;
}

// ---- deterministic value noise for the edge walks ---------------------------
function hash2(seed: number, i: number, j: number): number {
  const s = Math.sin(i * 127.1 + j * 269.5 + seed * 311.7) * 43758.5453;
  return s - Math.floor(s);
}
function noise1(seed: number, t: number): number {
  const i = Math.floor(t), f = t - i;
  const u = f * f * (3 - 2 * f);
  return hash2(seed, i, 0) * (1 - u) + hash2(seed, i + 1, 0) * u;
}
// smooth in both sample position and time — the 'live' edge drifts with it
function noise2(seed: number, x: number, y: number): number {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash2(seed, xi, yi), b = hash2(seed, xi + 1, yi);
  const c = hash2(seed, xi, yi + 1), d = hash2(seed, xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

// walk the four edges clockwise, displacing each sample INWARD by d(edge, t).
// Corners are single shared points pulled diagonally inward — leaving them
// on the borders makes closePath/edge joins slice a straight chamfer across
// each corner, which reads as a little cut triangle
function edgePath(ctx: CanvasRenderingContext2D, w: number, h: number,
                  perEdge: number, d: (edge: number, t: number) => number): void {
  const TL: [number, number] = [d(3, 1), d(0, 0)];
  const TR: [number, number] = [w - d(1, 0), d(0, 1)];
  const BR: [number, number] = [w - d(1, 1), h - d(2, 0)];
  const BL: [number, number] = [d(3, 0), h - d(2, 1)];
  ctx.beginPath();
  ctx.moveTo(TL[0], TL[1]);
  for (let k = 1; k < perEdge; k++) { const t = k / perEdge; ctx.lineTo(t * w, d(0, t)); }
  ctx.lineTo(TR[0], TR[1]);
  for (let k = 1; k < perEdge; k++) { const t = k / perEdge; ctx.lineTo(w - d(1, t), t * h); }
  ctx.lineTo(BR[0], BR[1]);
  for (let k = 1; k < perEdge; k++) { const t = k / perEdge; ctx.lineTo((1 - t) * w, h - d(2, t)); }
  ctx.lineTo(BL[0], BL[1]);
  for (let k = 1; k < perEdge; k++) { const t = k / perEdge; ctx.lineTo(d(3, t), (1 - t) * h); }
  ctx.closePath();
}

interface FxDef {
  dynamic?: boolean; // rebuild the mask every frame (time flows into d)
  buildMask(m: CanvasRenderingContext2D, w: number, h: number, time: number): void;
  after?(c: CanvasRenderingContext2D, w: number, h: number): void;
}

const FX: Record<PipFx, FxDef> = {
  parchment: {
    buildMask(m, w, h) {
      m.filter = 'blur(1.2px)';
      edgePath(m, w, h, 26, (e, t) => 2.5 + noise1(4.2 + e * 7.3, t * 26) * 6.5);
      m.fill();
    },
  },
  deckle: {
    buildMask(m, w, h) {
      // handmade paper: a long soft undulation carrying a fine fibre fray
      m.filter = 'blur(1.6px)';
      edgePath(m, w, h, 34, (e, t) =>
        2.5 + noise1(8.8 + e * 7.3, t * 5) * 6 + noise1(15.2 + e * 3.1, t * 40) * 2.2);
      m.fill();
    },
  },
  bitten: {
    buildMask(m, w, h) {
      // scorched paper: calm edge, then the noise cubed digs sparse deep bites
      m.filter = 'blur(1.6px)';
      edgePath(m, w, h, 34, (e, t) => {
        const n = noise1(12.6 + e * 7.3, t * 9);
        return 2.5 + n * n * n * 14 + noise1(21.9 + e * 3.1, t * 36) * 1.8;
      });
      m.fill();
    },
  },
  live: {
    dynamic: true,
    buildMask(m, w, h, time) {
      // the tear line drifts slowly, like an edge smouldering — same family
      // of shapes as parchment, never the same twice
      const tt = time * 0.35;
      m.filter = 'blur(1.4px)';
      edgePath(m, w, h, 26, (e, t) =>
        2.5 + noise2(4.2 + e * 7.3, t * 22, tt) * 7.5);
      m.fill();
    },
  },
  ember: {
    dynamic: true,
    buildMask(m, w, h, time) {
      // bitten, alive: the deep bites wander slowly, like embers eating in
      const tt = time * 0.3;
      m.filter = 'blur(1.6px)';
      edgePath(m, w, h, 34, (e, t) => {
        const n = noise2(12.6 + e * 7.3, t * 8, tt);
        return 2.5 + n * n * n * 15 + noise1(21.9 + e * 3.1, t * 36) * 1.8;
      });
      m.fill();
    },
  },
  frame: {
    buildMask(m, w, h) {
      m.fillRect(0, 0, w, h);
    },
    after(c, w, h) {
      c.strokeStyle = 'rgba(226,220,204,0.28)';
      c.lineWidth = 1;
      c.strokeRect(0.5, 0.5, w - 1, h - 1);
    },
  },
};

const BASE_FILTER = 'grayscale(1) contrast(1.06) brightness(0.95)';

// ---- processing -------------------------------------------------------------
let proc: HTMLCanvasElement | null = null;
let pctx: CanvasRenderingContext2D | null = null;
let maskC: HTMLCanvasElement | null = null;
let mctx: CanvasRenderingContext2D | null = null;
let maskKey = '';

export function processPip(video: HTMLVideoElement, pw: number, ph: number,
                           dpr: number): HTMLCanvasElement | null {
  const fx = FX[pip.fx];
  const dw = Math.max(2, Math.round(pw * dpr));
  const dh = Math.max(2, Math.round(ph * dpr));

  if (!proc || proc.width !== dw || proc.height !== dh) {
    proc = document.createElement('canvas');
    proc.width = dw; proc.height = dh;
    pctx = proc.getContext('2d');
  }
  if (!pctx) return null;

  const key = pip.fx + ':' + dw + 'x' + dh;
  if (maskKey !== key || fx.dynamic) {
    if (!maskC || maskC.width !== dw || maskC.height !== dh) {
      maskC = document.createElement('canvas');
      maskC.width = dw; maskC.height = dh;
      mctx = maskC.getContext('2d');
    }
    if (!mctx) return null;
    mctx.setTransform(1, 0, 0, 1, 0, 0);
    mctx.filter = 'none';
    mctx.clearRect(0, 0, dw, dh);
    mctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    mctx.fillStyle = '#fff';
    fx.buildMask(mctx, pw, ph, performance.now() / 1000);
    maskKey = key;
  }

  const c = pctx;
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.clearRect(0, 0, pw, ph);
  c.filter = BASE_FILTER;
  c.drawImage(video, 0, 0, pw, ph);
  c.filter = 'none';
  // carve the edge shape out of the processed frame
  c.globalCompositeOperation = 'destination-in';
  c.globalAlpha = 0.92;
  c.drawImage(maskC!, 0, 0, pw, ph);
  c.globalCompositeOperation = 'source-over';
  c.globalAlpha = 1;
  if (fx.after) fx.after(c, pw, ph);
  return proc;
}
