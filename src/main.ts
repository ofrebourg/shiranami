// Boot + UI wiring around the WebGPU renderer. Switching renderers reloads the page: a
// canvas element can only ever hold one context type.

import './ui.css';
import {
  P, D, derive, tick, resizeSim, lastN, sprayN, solid, setSolid,
  type ParamKey,
} from './core/sim';
import type { Renderer } from './core/renderer';
import { initRecording } from './core/record';
import { initCam } from './core/cam';
import { pip, cyclePipFx } from './core/pip';
import { foamfx, cycleFoamFx } from './core/foamfx';
import { initMidi, type ShiranamiApi } from './midi';
import { initTake } from './core/take';

const cv = document.getElementById('cv') as HTMLCanvasElement;
const panel = document.getElementById('panel')!;

// ---- renderer ----------------------------------------------------------------
// WebGPU only: the simulation itself runs in compute shaders. The Canvas 2D
// and WebGL2 rasterisers that bootstrapped this project were removed once
// webgpu proved out — see docs/webgl2-vs-webgpu.md for that history.
const renderer: Renderer | null = await (await import('./webgpu/renderer')).createRenderer(cv);
if (!renderer) {
  document.getElementById('caption')!.innerHTML =
    '白波 shiranami &mdash; this piece renders with WebGPU<br>please use a current Chrome, Edge or Safari';
  throw new Error('[shiranami] WebGPU unavailable');
}

// ---- boot ---------------------------------------------------------------------
let running = true;

function resize(): void {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = window.innerWidth, h = window.innerHeight;
  cv.width = Math.round(w * dpr);
  cv.height = Math.round(h * dpr);
  resizeSim(w, h, dpr);
  renderer!.resize();
}
window.addEventListener('resize', resize);
resize();

// settle the field (grow some foam) before first paint
for (let wu = 0; wu < 30; wu++) tick(1 / 30);

// re-render the held frame at the same instant: zero-dt tick, full clear
function renderStill(): void {
  tick(0);
  renderer!.draw(true);
}

panel.addEventListener('input', function (ev) {
  const k = (ev.target as HTMLElement).getAttribute('data-k') as ParamKey | null;
  if (k) {
    P[k] = Number((ev.target as HTMLInputElement).value) / 100;
    derive();
    if (!running) renderStill();
  }
});

// ---- external control (used by the MIDI mapping in midi.ts) --------------
const api: ShiranamiApi = {
  set: function (k, v) {
    if (!(k in P) || typeof v !== 'number' || !isFinite(v)) return;
    P[k as ParamKey] = v < 0 ? 0 : v > 1 ? 1 : v;
    derive();
    const inp = panel.querySelector<HTMLInputElement>('input[data-k="' + k + '"]');
    if (inp) inp.value = String(Math.round(P[k as ParamKey] * 100));
    if (!running) renderStill();
  },
  get: function (k) { return P[k as ParamKey]; },
  midiStatus: '',
};
declare global { interface Window { shiranami: ShiranamiApi } }
window.shiranami = api;

cv.addEventListener('click', function () {
  running = !running;
  if (running) { last = performance.now(); requestAnimationFrame(loop); }
});

const modeBtn = document.getElementById('mode-btn')!;
modeBtn.addEventListener('click', function () {
  setSolid(!solid);
  modeBtn.setAttribute('aria-pressed', String(solid));
  if (!running) renderStill();
});

initCam(document.getElementById('cam-btn') as HTMLButtonElement);
const pipBtn = document.getElementById('pip-btn') as HTMLButtonElement;
pipBtn.textContent = pip.fx;
pipBtn.addEventListener('click', function () {
  pipBtn.textContent = cyclePipFx();
  if (!running) renderStill();
});
const foamBtn = document.getElementById('foam-btn') as HTMLButtonElement;
foamBtn.textContent = foamfx.mode;
foamBtn.addEventListener('click', function () {
  foamBtn.textContent = cycleFoamFx();
  if (!running) renderStill();
});
const midiCtl = initMidi(api);
const takeCtl = initTake(document.getElementById('take-btn') as HTMLButtonElement, midiCtl);
initRecording(cv, document.getElementById('rec-btn') as HTMLButtonElement, midiCtl, takeCtl);
api.midi = midiCtl;
api.loadTake = takeCtl.load;

// ---- stats + main loop ----------------------------------------------------
const statsEl = document.getElementById('stats')!;
const statsBtn = document.getElementById('stats-btn')!;
let statsOn = false;
statsBtn.addEventListener('click', function () {
  statsOn = !statsOn;
  statsBtn.setAttribute('aria-pressed', String(statsOn));
  statsEl.style.display = statsOn ? 'block' : 'none';
});
let fpsFrames = 0, fpsClock = 0, frameMs = 0;

const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
let rmFrames = 0;
let last = performance.now();

function loop(now: number): void {
  if (!running) return;
  let dt = (now - last) / 1000;
  last = now;
  const rawDt = dt;
  if (dt > 0.05) dt = 0.05;
  if (dt > 0) {
    const t0 = performance.now();
    tick(dt);
    renderer!.draw();
    // main-thread cost per frame: fps saturates at vsync, this shows the
    // real headroom (and what recording's encoder will have to fight for)
    frameMs += (performance.now() - t0 - frameMs) * 0.08;
    if (statsOn) {
      fpsFrames++;
      fpsClock += rawDt;
      if (fpsClock >= 0.5) {
        statsEl.textContent = Math.round(fpsFrames / fpsClock) + ' fps · ' +
          frameMs.toFixed(1) + ' ms cpu · ' +
          lastN + ' lines · ' + sprayN + ' dots' +
          (api.midiStatus ? ' · ' + api.midiStatus : '');
        fpsFrames = 0;
        fpsClock = 0;
      }
    }
  }
  if (reduced && ++rmFrames > 90) {
    running = false;
    document.getElementById('caption')!.innerHTML =
      '白波 shiranami &mdash; white waves on black water<br>held still (reduced motion) &mdash; click the water to flow';
    return;
  }
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
