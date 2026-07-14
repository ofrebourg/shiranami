// Recording placard — recordings capture the canvas only, so the DOM
// placard never appears in a take. While recording, the renderers
// composite this pre-rendered card (title + description, minus the
// "click the water" interaction hint) into the top-left of the canvas,
// and record.ts hides the DOM placard so the screen shows no doubling.

export const recOverlay = {
  on: false,
  canvas: null as HTMLCanvasElement | null,
  cssW: 560,
  cssH: 96,
  version: 0,
};

export function buildRecOverlay(dpr: number): void {
  const c = document.createElement('canvas');
  c.width = recOverlay.cssW * dpr;
  c.height = recOverlay.cssH * dpr;
  const ctx = c.getContext('2d');
  if (!ctx) return;
  ctx.scale(dpr, dpr);

  // mirror the #placard styles from ui.css
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = 'rgba(230, 224, 206, 0.62)';
  ctx.font = '400 15px Didot, "Bodoni 72", "Bodoni MT", "Playfair Display", Georgia, serif';
  try { (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = '5.4px'; } catch (e) {}
  ctx.fillText('SHIRANAMI', 28, 36);

  ctx.font = '10px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
  try { (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = '0.9px'; } catch (e) {}
  ctx.fillStyle = 'rgba(230, 224, 206, 0.30)';
  ctx.fillText('白波 shiranami — white waves on black water', 29, 56);
  ctx.fillText('after teamLab’s Black Waves', 29, 71);

  recOverlay.canvas = c;
  recOverlay.version++;
}
