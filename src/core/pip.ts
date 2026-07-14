// Webcam PiP processing — one offscreen 2D canvas turns the raw video
// frame into the composited card: greyscale treatment and the edge mask
// are baked here, so the renderers (canvas/webgl/webgpu) all just draw
// the processed canvas with straight alpha and stay identical.
//
// The edge effects stop the PiP reading as a pasted rectangle. They are
// shape-only: no colour tints — the animation is near-monochrome and the
// card has to stay in its palette.
//   parchment — fine deckled tears, static
//   torn      — deeper, coarser tears
//   live      — parchment whose edge slowly evolves, like paper smouldering
//   brush     — ragged swept left/right edges, calm top/bottom
//   waves     — scalloped edge echoing the water
//   frame     — the original: hard rectangle, hairline border

export const PIP_FX = ['parchment', 'torn', 'live', 'brush', 'waves', 'frame'] as const;
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

// walk the four edges clockwise, displacing each sample INWARD by d(edge, t)
function edgePath(ctx: CanvasRenderingContext2D, w: number, h: number,
                  perEdge: number, d: (edge: number, t: number) => number): void {
  ctx.beginPath();
  for (let k = 0; k <= perEdge; k++) { const t = k / perEdge; ctx.lineTo(t * w, d(0, t)); }
  for (let k = 0; k <= perEdge; k++) { const t = k / perEdge; ctx.lineTo(w - d(1, t), t * h); }
  for (let k = 0; k <= perEdge; k++) { const t = k / perEdge; ctx.lineTo((1 - t) * w, h - d(2, t)); }
  for (let k = 0; k <= perEdge; k++) { const t = k / perEdge; ctx.lineTo(d(3, t), (1 - t) * h); }
  ctx.closePath();
}

const TAU = Math.PI * 2;

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
  torn: {
    buildMask(m, w, h) {
      m.filter = 'blur(1.8px)';
      edgePath(m, w, h, 30, (e, t) =>
        3 + noise1(9.1 + e * 7.3, t * 11) * 12 + noise1(17.4 + e * 3.1, t * 31) * 3);
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
  brush: {
    buildMask(m, w, h) {
      // like the water's strokes: rough sweeps on the sides, calm above and
      // below — reads as a band brushed across the card
      m.filter = 'blur(2.2px)';
      edgePath(m, w, h, 26, (e, t) =>
        e === 1 || e === 3
          ? 3 + noise1(6.6 + e * 7.3, t * 7) * 13
          : 2 + noise1(6.6 + e * 7.3, t * 20) * 3);
      m.fill();
    },
  },
  waves: {
    buildMask(m, w, h) {
      m.filter = 'blur(1.2px)';
      edgePath(m, w, h, 40, (e, t) => {
        const n = e === 0 || e === 2 ? 7 : 4;
        return 2 + (0.5 + 0.5 * Math.sin(t * TAU * n + e * 1.7)) * 4.5
             + noise1(3.3 + e * 7.3, t * 18) * 1.5;
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
