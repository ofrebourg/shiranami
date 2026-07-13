// Canvas 2D renderer — the original rasteriser, kept as the reference
// implementation. Strokes each bucket the sim collected; additive
// 'lighter' compositing over a translucent fade gives the ghost trails.
// All coordinates in the buckets are CSS pixels; ctx is DPR-scaled.

import { W, H, DPR, TAU, buckets, used, dbuckets, dused, COLS, WLEV, RLEV } from '../core/sim';
import { cam } from '../core/cam';
import type { Renderer } from '../core/renderer';
import './canvas.css';

export function createRenderer(cv: HTMLCanvasElement): Renderer | null {
  const ctx = cv.getContext('2d');
  if (!ctx) return null;

  function resize(): void {
    ctx!.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx!.fillStyle = '#030305';
    ctx!.fillRect(0, 0, W, H);
  }

  function draw(full?: boolean): void {
    const c = ctx!;
    c.globalCompositeOperation = 'source-over';
    c.fillStyle = full ? '#030305' : 'rgba(4,4,7,0.5)';
    c.fillRect(0, 0, W, H);
    c.globalCompositeOperation = 'lighter';
    c.lineCap = 'round';
    c.lineJoin = 'round';
    let q: number, key: number, arr: number[], p: number;
    for (q = 0; q < used.length; q++) {
      key = used[q];
      arr = buckets[key];
      if (!arr.length) continue;
      const wi = key & 7, ai = (key >> 3) & 7, ci = key >> 6;
      c.strokeStyle = 'rgba(' + COLS[ci] + ',' + (ai / 14).toFixed(3) + ')';
      c.lineWidth = WLEV[wi];
      c.beginPath();
      p = 0;
      while (p < arr.length) {
        const cnt = arr[p++];
        c.moveTo(arr[p], arr[p + 1]);
        p += 2;
        for (let m = 1; m < cnt; m++) { c.lineTo(arr[p], arr[p + 1]); p += 2; }
      }
      c.stroke();
      arr.length = 0;
    }
    used.length = 0;
    for (q = 0; q < dused.length; q++) {
      key = dused[q];
      arr = dbuckets[key];
      if (!arr.length) continue;
      const rad = RLEV[key & 7];
      c.fillStyle = 'rgba(246,249,252,' + (((key >> 3) & 7) / 14).toFixed(3) + ')';
      c.beginPath();
      for (p = 0; p < arr.length; p += 2) {
        c.moveTo(arr[p] + rad, arr[p + 1]);
        c.arc(arr[p], arr[p + 1], rad, 0, TAU);
      }
      c.fill();
      arr.length = 0;
    }
    dused.length = 0;
    c.globalCompositeOperation = 'source-over';

    const v = cam.video;
    if (cam.on && v && v.readyState >= 2 && v.videoWidth) {
      const pw = Math.round(W * 0.2);
      const phh = Math.round(pw * v.videoHeight / v.videoWidth);
      const px0 = W - pw - 24, py0 = H - phh - 78;
      c.save();
      c.filter = 'grayscale(1) contrast(1.06) brightness(0.95)';
      c.globalAlpha = 0.92;
      c.drawImage(v, px0, py0, pw, phh);
      c.restore();
      c.filter = 'none';
      c.strokeStyle = 'rgba(226,220,204,0.28)';
      c.lineWidth = 1;
      c.strokeRect(px0 + 0.5, py0 + 0.5, pw - 1, phh - 1);
    }
  }

  return { name: 'canvas', resize, draw };
}
