// Boot + UI wiring. Picks a renderer (WebGPU by default — GPU-resident
// sim; Canvas 2D remains the reference implementation), runs the shared
// sim, and hands control to whichever renderer is active. Switching renderers reloads the page: a
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

// ---- renderer selection -----------------------------------------------------
// ?renderer=canvas|webgl|webgpu wins, then the remembered choice, then webgpu.
// Fallback chain on unavailability: webgpu → webgl → canvas.
const RENDS = ['webgpu', 'webgl', 'canvas'];
const REND_KEY = 'shiranami-renderer';
const qsChoice = new URLSearchParams(location.search).get('renderer');
let stored = '';
try { stored = localStorage.getItem(REND_KEY) || ''; } catch (e) {}
const choice = (qsChoice && RENDS.includes(qsChoice)) ? qsChoice
             : RENDS.includes(stored) ? stored
             : 'webgpu';

let renderer: Renderer | null = null;
if (choice === 'webgpu') {
  renderer = await (await import('./webgpu/renderer')).createRenderer(cv);
  if (!renderer) console.warn('[shiranami] WebGPU unavailable — falling back to WebGL2');
}
if (!renderer && choice !== 'canvas') {
  renderer = (await import('./webgl/renderer')).createRenderer(cv);
  if (!renderer) console.warn('[shiranami] WebGL2 unavailable — falling back to Canvas 2D');
}
if (!renderer) {
  renderer = (await import('./canvas/renderer')).createRenderer(cv);
}
if (!renderer) throw new Error('no rendering context available');
console.log('[shiranami] renderer:', renderer.name);
// gpuSim renderers integrate the streamlines on the GPU; the CPU tick then
// only advects seeds and moves spray
const simRender = !renderer.gpuSim;

const rendBtn = document.getElementById('rend-btn') as HTMLButtonElement;
const next = RENDS[(RENDS.indexOf(renderer.name) + 1) % RENDS.length];
rendBtn.textContent = renderer.name;
rendBtn.title = 'renderer: ' + renderer.name + ' — click for ' + next + ' (reloads)';
rendBtn.addEventListener('click', function () {
  try { localStorage.setItem(REND_KEY, next); } catch (e) {}
  // drop a stale ?renderer= so the stored choice actually applies
  const url = new URL(location.href);
  url.searchParams.delete('renderer');
  location.href = url.toString();
});

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
for (let wu = 0; wu < 30; wu++) tick(1 / 30, false);

// re-render the held frame at the same instant: zero-dt tick, full clear
function renderStill(): void {
  tick(0, simRender);
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

initRecording(cv, document.getElementById('rec-btn') as HTMLButtonElement);
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
    tick(dt, simRender);
    renderer!.draw();
    // main-thread cost per frame: fps saturates at vsync, this shows the
    // real headroom (and what recording's encoder will have to fight for)
    frameMs += (performance.now() - t0 - frameMs) * 0.08;
    if (statsOn) {
      fpsFrames++;
      fpsClock += rawDt;
      if (fpsClock >= 0.5) {
        statsEl.textContent = renderer!.name + ' · ' +
          Math.round(fpsFrames / fpsClock) + ' fps · ' +
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
