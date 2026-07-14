// Webcam PiP processing — one offscreen 2D canvas turns the raw video
// frame into the composited card: greyscale treatment, edge mask and any
// border are baked here, so the renderers (canvas/webgl/webgpu) all just
// draw the processed canvas with straight alpha and stay identical.
//
// The edge effects exist to stop the PiP reading as a pasted rectangle:
//   frame     — the original look: hard rectangle, hairline border
//   fade      — feathered rounded edges, melts into the black
//   parchment — warm paper tint, edge darkening, deckled/torn edges
//   ink       — coarse ink-wash bleed edge, stronger vignette

export const PIP_FX = ['parchment', 'ink', 'fade', 'frame'] as const;
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

// ---- deterministic 1D value noise for the edge walks -----------------------
function hash1(seed: number, i: number): number {
  const s = Math.sin(i * 127.1 + seed * 311.7) * 43758.5453;
  return s - Math.floor(s);
}
function noise1(seed: number, t: number): number {
  const i = Math.floor(t), f = t - i;
  const u = f * f * (3 - 2 * f);
  const a = hash1(seed, i), b = hash1(seed, i + 1);
  return a + (b - a) * u;
}

// walk the four edges clockwise, displacing each sample INWARD by
// base + noise*amp — the fill of this path is the visible region
function edgePath(ctx: CanvasRenderingContext2D, w: number, h: number,
                  perEdge: number, base: number, amp: number, seed: number): void {
  const d = (edge: number, t: number) => base + noise1(seed + edge * 7.3, t * perEdge) * amp;
  ctx.beginPath();
  for (let k = 0; k <= perEdge; k++) { const t = k / perEdge; ctx.lineTo(t * w, d(0, t)); }
  for (let k = 0; k <= perEdge; k++) { const t = k / perEdge; ctx.lineTo(w - d(1, t), t * h); }
  for (let k = 0; k <= perEdge; k++) { const t = k / perEdge; ctx.lineTo((1 - t) * w, h - d(2, t)); }
  for (let k = 0; k <= perEdge; k++) { const t = k / perEdge; ctx.lineTo(d(3, t), (1 - t) * h); }
  ctx.closePath();
}

interface FxDef {
  filter: string;
  buildMask(m: CanvasRenderingContext2D, w: number, h: number): void;
  tint?(c: CanvasRenderingContext2D, w: number, h: number): void;
  after?(c: CanvasRenderingContext2D, w: number, h: number): void;
}

const BASE_FILTER = 'grayscale(1) contrast(1.06) brightness(0.95)';

const FX: Record<PipFx, FxDef> = {
  frame: {
    filter: BASE_FILTER,
    buildMask(m, w, h) {
      m.fillRect(0, 0, w, h);
    },
    after(c, w, h) {
      c.strokeStyle = 'rgba(226,220,204,0.28)';
      c.lineWidth = 1;
      c.strokeRect(0.5, 0.5, w - 1, h - 1);
    },
  },
  fade: {
    filter: BASE_FILTER,
    buildMask(m, w, h) {
      m.filter = 'blur(9px)';
      m.beginPath();
      m.roundRect(12, 12, w - 24, h - 24, 14);
      m.fill();
    },
  },
  parchment: {
    filter: BASE_FILTER,
    buildMask(m, w, h) {
      // deckled edge: fine, mostly crisp tears
      m.filter = 'blur(1.2px)';
      edgePath(m, w, h, 26, 2.5, 6.5, 4.2);
      m.fill();
    },
    tint(c, w, h) {
      c.globalCompositeOperation = 'multiply';
      c.fillStyle = 'rgb(235, 220, 186)'; // warm paper over the greys
      c.fillRect(0, 0, w, h);
      // aged edges: darken toward the borders, slightly brown
      const g = c.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.28,
                                       w / 2, h / 2, Math.max(w, h) * 0.62);
      g.addColorStop(0, 'rgb(255,255,255)');
      g.addColorStop(1, 'rgb(168, 148, 116)');
      c.fillStyle = g;
      c.fillRect(0, 0, w, h);
      c.globalCompositeOperation = 'source-over';
    },
  },
  ink: {
    filter: 'grayscale(1) contrast(1.18) brightness(0.92)',
    buildMask(m, w, h) {
      // coarse wash: big soft bleeds, like a wet brush edge
      m.filter = 'blur(5px)';
      edgePath(m, w, h, 7, 4, 13, 11.7);
      m.fill();
    },
    tint(c, w, h) {
      const g = c.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.2,
                                       w / 2, h / 2, Math.max(w, h) * 0.66);
      g.addColorStop(0, 'rgb(255,255,255)');
      g.addColorStop(1, 'rgb(126,130,138)');
      c.globalCompositeOperation = 'multiply';
      c.fillStyle = g;
      c.fillRect(0, 0, w, h);
      c.globalCompositeOperation = 'source-over';
    },
  },
};

// ---- processing -------------------------------------------------------------
let proc: HTMLCanvasElement | null = null;
let pctx: CanvasRenderingContext2D | null = null;
let maskC: HTMLCanvasElement | null = null;
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
  if (maskKey !== key) {
    maskC = document.createElement('canvas');
    maskC.width = dw; maskC.height = dh;
    const m = maskC.getContext('2d');
    if (!m) return null;
    m.setTransform(dpr, 0, 0, dpr, 0, 0);
    m.fillStyle = '#fff';
    fx.buildMask(m, pw, ph);
    maskKey = key;
  }

  const c = pctx;
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.clearRect(0, 0, pw, ph);
  c.filter = fx.filter;
  c.drawImage(video, 0, 0, pw, ph);
  c.filter = 'none';
  if (fx.tint) fx.tint(c, pw, ph);
  // carve the edge shape out of the processed frame
  c.globalCompositeOperation = 'destination-in';
  c.globalAlpha = 0.92;
  c.drawImage(maskC!, 0, 0, pw, ph);
  c.globalCompositeOperation = 'source-over';
  c.globalAlpha = 1;
  if (fx.after) fx.after(c, pw, ph);
  return proc;
}
