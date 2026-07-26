// Debug HUD — draws the live control values onto the canvas, the same
// way overlay.ts draws the recording placard, so a "with controls"
// recording can show how chaos/height/swell/etc. are actually moving
// (driven by hand or by MIDI) without needing the DOM panel, which
// recordings never capture (captureStream sits on the canvas only).
// Gated by hudOverlay.on; record.ts rebuilds it on a timer while active.

import { P, solid, type ParamKey } from './sim';
import { foamfx } from './foamfx';
import { pip } from './pip';

export const hudOverlay = {
  on: false,
  canvas: null as HTMLCanvasElement | null,
  cssW: 168,
  cssH: 268,
  version: 0,
};

const ROWS: { k: ParamKey; label: string }[] = [
  { k: 'strokes', label: 'Strokes' },
  { k: 'chaos', label: 'Chaos' },
  { k: 'brush', label: 'Brush' },
  { k: 'detail', label: 'Detail' },
  { k: 'body', label: 'Body' },
  { k: 'height', label: 'Height' },
  { k: 'swell', label: 'Swell' },
  { k: 'spray', label: 'Spray' },
  { k: 'foam', label: 'Foam' },
  { k: 'linger', label: 'Linger' },
  { k: 'pace', label: 'Pace' },
];

let hudCanvas: HTMLCanvasElement | null = null;
let hudCtx: CanvasRenderingContext2D | null = null;
let hudDpr = 0;

export function buildHud(dpr: number, midiOn: boolean): void {
  if (!hudCanvas || hudDpr !== dpr) {
    hudCanvas = document.createElement('canvas');
    hudCanvas.width = Math.round(hudOverlay.cssW * dpr);
    hudCanvas.height = Math.round(hudOverlay.cssH * dpr);
    hudCtx = hudCanvas.getContext('2d');
    hudDpr = dpr;
  }
  const ctx = hudCtx;
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, hudOverlay.cssW, hudOverlay.cssH);
  ctx.fillStyle = 'rgba(4, 5, 8, 0.4)';
  ctx.fillRect(0, 0, hudOverlay.cssW, hudOverlay.cssH);

  ctx.textBaseline = 'alphabetic';
  ctx.font = '9px ui-monospace, "SF Mono", Menlo, Consolas, monospace';
  try { (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = '0.06em'; } catch (e) {}

  const rowH = 16;
  let y = 20;
  for (const r of ROWS) {
    ctx.textAlign = 'left';
    ctx.fillStyle = 'rgba(226, 220, 204, 0.42)';
    ctx.fillText(r.label.toUpperCase(), 14, y);
    ctx.textAlign = 'right';
    ctx.fillStyle = 'rgba(226, 220, 204, 0.78)';
    ctx.fillText(String(Math.round(P[r.k] * 100)), hudOverlay.cssW - 14, y);
    y += rowH;
  }
  y += 6;
  ctx.textAlign = 'left';
  ctx.fillStyle = 'rgba(226, 220, 204, 0.3)';
  ctx.fillText('solid ' + (solid ? 'on' : 'off'), 14, y); y += rowH;
  ctx.fillText('foam  ' + foamfx.mode, 14, y); y += rowH;
  ctx.fillText('pip   ' + pip.fx, 14, y); y += rowH;
  ctx.fillText('midi  ' + (midiOn ? 'on' : 'off'), 14, y);

  hudOverlay.canvas = hudCanvas;
  hudOverlay.version++;
}
