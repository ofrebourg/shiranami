// WebGL2 renderer — the same picture as src/canvas, rasterised on the GPU.
//
// The sim's per-frame cost is small; Canvas 2D dies stroking thousands of
// anti-aliased polylines on the CPU. Here those strokes become one big
// triangle strip (two vertices per point, degenerate bridges between
// polylines) drawn additively in a single call, dots become point sprites,
// and the ghost trails live in a persistent accumulation framebuffer that
// gets a translucent fade quad instead of a fillRect. Blending happens in
// the same non-linear 8-bit space as Canvas 2D 'lighter', so the two
// renderers match visually, not just structurally.

import {
  W, H, DPR, MAXN, STEPS, MAXS,
  buckets, used, dbuckets, dused, COLS, WLEV, RLEV,
} from '../core/sim';
import { cam } from '../core/cam';
import type { Renderer } from '../core/renderer';
import { FEATHER, STROKE_VS, STROKE_FS, DOT_VS, DOT_FS, QUAD_VS, QUAD_FS } from './shaders';
import './webgl.css';

// stroke vertex: x, y, dist, halfW, r, g, b, a  (8 floats)
const SVERT = 8;
// worst case: every point twice + degenerate bridges per section run
const SCAP = MAXN * (STEPS * 2 + 30);
// dot vertex: x, y, rad, r, g, b, a  (7 floats)
const DVERT = 7;
const DCAP = MAXS + 16;

const COLRGB = COLS.map((s) => s.split(',').map((n) => Number(n) / 255));
const DOTCOL = [246 / 255, 249 / 255, 252 / 255];

export function createRenderer(cv: HTMLCanvasElement): Renderer | null {
  const gl = cv.getContext('webgl2', {
    alpha: false, antialias: false, depth: false, stencil: false,
    preserveDrawingBuffer: false, powerPreference: 'high-performance',
  });
  if (!gl) return null;

  function compile(vsSrc: string, fsSrc: string): WebGLProgram {
    const mk = (type: number, src: string) => {
      const sh = gl!.createShader(type)!;
      gl!.shaderSource(sh, src);
      gl!.compileShader(sh);
      if (!gl!.getShaderParameter(sh, gl!.COMPILE_STATUS)) {
        throw new Error('shader: ' + gl!.getShaderInfoLog(sh));
      }
      return sh;
    };
    const prog = gl!.createProgram()!;
    gl!.attachShader(prog, mk(gl!.VERTEX_SHADER, vsSrc));
    gl!.attachShader(prog, mk(gl!.FRAGMENT_SHADER, fsSrc));
    gl!.linkProgram(prog);
    if (!gl!.getProgramParameter(prog, gl!.LINK_STATUS)) {
      throw new Error('link: ' + gl!.getProgramInfoLog(prog));
    }
    return prog;
  }

  // ---- programs + uniforms -------------------------------------------------
  const strokeProg = compile(STROKE_VS, STROKE_FS);
  const strokeURes = gl.getUniformLocation(strokeProg, 'uRes');
  const dotProg = compile(DOT_VS, DOT_FS);
  const dotURes = gl.getUniformLocation(dotProg, 'uRes');
  const quadProg = compile(QUAD_VS, QUAD_FS);
  const quadURect = gl.getUniformLocation(quadProg, 'uRect');
  const quadURes = gl.getUniformLocation(quadProg, 'uRes');
  const quadUPresent = gl.getUniformLocation(quadProg, 'uPresent');
  const quadUMode = gl.getUniformLocation(quadProg, 'uMode');
  const quadUColor = gl.getUniformLocation(quadProg, 'uColor');
  const quadUTex = gl.getUniformLocation(quadProg, 'uTex');

  // ---- geometry buffers ------------------------------------------------------
  const sData = new Float32Array(SCAP * SVERT);
  const sVao = gl.createVertexArray()!;
  const sBuf = gl.createBuffer()!;
  gl.bindVertexArray(sVao);
  gl.bindBuffer(gl.ARRAY_BUFFER, sBuf);
  gl.bufferData(gl.ARRAY_BUFFER, sData.byteLength, gl.DYNAMIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, SVERT * 4, 0);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 2, gl.FLOAT, false, SVERT * 4, 8);
  gl.enableVertexAttribArray(2);
  gl.vertexAttribPointer(2, 4, gl.FLOAT, false, SVERT * 4, 16);

  const dData = new Float32Array(DCAP * DVERT);
  const dVao = gl.createVertexArray()!;
  const dBuf = gl.createBuffer()!;
  gl.bindVertexArray(dVao);
  gl.bindBuffer(gl.ARRAY_BUFFER, dBuf);
  gl.bufferData(gl.ARRAY_BUFFER, dData.byteLength, gl.DYNAMIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, DVERT * 4, 0);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 1, gl.FLOAT, false, DVERT * 4, 8);
  gl.enableVertexAttribArray(2);
  gl.vertexAttribPointer(2, 4, gl.FLOAT, false, DVERT * 4, 12);

  const qVao = gl.createVertexArray()!;
  const qBuf = gl.createBuffer()!;
  gl.bindVertexArray(qVao);
  gl.bindBuffer(gl.ARRAY_BUFFER, qBuf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);

  // ---- accumulation framebuffer (the ghost-trail surface) -------------------
  const fbo = gl.createFramebuffer()!;
  let accumTex: WebGLTexture | null = null;
  const camTex = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, camTex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  function resize(): void {
    if (accumTex) gl!.deleteTexture(accumTex);
    accumTex = gl!.createTexture()!;
    gl!.bindTexture(gl!.TEXTURE_2D, accumTex);
    gl!.texImage2D(gl!.TEXTURE_2D, 0, gl!.RGBA, cv.width, cv.height, 0,
                   gl!.RGBA, gl!.UNSIGNED_BYTE, null);
    gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_MIN_FILTER, gl!.NEAREST);
    gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_MAG_FILTER, gl!.NEAREST);
    gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_WRAP_S, gl!.CLAMP_TO_EDGE);
    gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_WRAP_T, gl!.CLAMP_TO_EDGE);
    gl!.bindFramebuffer(gl!.FRAMEBUFFER, fbo);
    gl!.framebufferTexture2D(gl!.FRAMEBUFFER, gl!.COLOR_ATTACHMENT0,
                             gl!.TEXTURE_2D, accumTex, 0);
    gl!.viewport(0, 0, cv.width, cv.height);
    gl!.disable(gl!.BLEND);
    gl!.clearColor(3 / 255, 3 / 255, 5 / 255, 1);
    gl!.clear(gl!.COLOR_BUFFER_BIT);
    gl!.bindFramebuffer(gl!.FRAMEBUFFER, null);
  }

  // ---- stroke tessellation ---------------------------------------------------
  // Consumes the sim's polyline buckets into one triangle strip. Positions
  // come in as CSS px and leave as device px; per-vertex colour carries the
  // bucket's quantised style so the whole frame is a single draw call.
  let sCount = 0;
  function buildStrokes(): void {
    let o = 0;
    const dpr = DPR;
    for (let q = 0; q < used.length; q++) {
      const key = used[q];
      const arr = buckets[key];
      if (!arr.length) continue;
      const wi = key & 7, ai = (key >> 3) & 7, ci = key >> 6;
      const col = COLRGB[ci];
      const r = col[0], g = col[1], b = col[2], a = ai / 14;
      const hw = WLEV[wi] * dpr * 0.5;
      const ext = hw + FEATHER;
      let p = 0;
      while (p < arr.length) {
        const cnt = arr[p++];
        if (o + (cnt * 2 + 2) * SVERT > sData.length) { p += cnt * 2; continue; }
        for (let m = 0; m < cnt; m++) {
          const x = arr[p + 2 * m] * dpr;
          const y = arr[p + 2 * m + 1] * dpr;
          const mp = m > 0 ? m - 1 : 0;
          const mn = m < cnt - 1 ? m + 1 : cnt - 1;
          let dx = arr[p + 2 * mn] - arr[p + 2 * mp];
          let dy = arr[p + 2 * mn + 1] - arr[p + 2 * mp + 1];
          const len = Math.sqrt(dx * dx + dy * dy);
          if (len > 1e-6) { dx /= len; dy /= len; } else { dx = 1; dy = 0; }
          const nx = -dy * ext, ny = dx * ext;
          if (m === 0 && o > 0) {
            // degenerate bridge from the previous polyline
            sData.copyWithin(o, o - SVERT, o);
            o += SVERT;
            sData[o] = x + nx; sData[o + 1] = y + ny;
            sData[o + 2] = ext; sData[o + 3] = hw;
            sData[o + 4] = r; sData[o + 5] = g; sData[o + 6] = b; sData[o + 7] = a;
            o += SVERT;
          }
          sData[o] = x + nx; sData[o + 1] = y + ny;
          sData[o + 2] = ext; sData[o + 3] = hw;
          sData[o + 4] = r; sData[o + 5] = g; sData[o + 6] = b; sData[o + 7] = a;
          o += SVERT;
          sData[o] = x - nx; sData[o + 1] = y - ny;
          sData[o + 2] = -ext; sData[o + 3] = hw;
          sData[o + 4] = r; sData[o + 5] = g; sData[o + 6] = b; sData[o + 7] = a;
          o += SVERT;
        }
        p += cnt * 2;
      }
      arr.length = 0;
    }
    used.length = 0;
    sCount = o / SVERT;
  }

  let dCount = 0;
  function buildDots(): void {
    let o = 0;
    const dpr = DPR;
    for (let q = 0; q < dused.length; q++) {
      const key = dused[q];
      const arr = dbuckets[key];
      if (!arr.length) continue;
      const rad = RLEV[key & 7] * dpr;
      const a = ((key >> 3) & 7) / 14;
      for (let p = 0; p < arr.length; p += 2) {
        if (o + DVERT > dData.length) break;
        dData[o] = arr[p] * dpr; dData[o + 1] = arr[p + 1] * dpr;
        dData[o + 2] = rad;
        dData[o + 3] = DOTCOL[0]; dData[o + 4] = DOTCOL[1]; dData[o + 5] = DOTCOL[2];
        dData[o + 6] = a;
        o += DVERT;
      }
      arr.length = 0;
    }
    dused.length = 0;
    dCount = o / DVERT;
  }

  // ---- quad pass helper -------------------------------------------------------
  function quad(mode: number, x: number, y: number, w: number, h: number,
                color: [number, number, number, number] | null): void {
    gl!.useProgram(quadProg);
    gl!.bindVertexArray(qVao);
    gl!.uniform2f(quadURes, cv.width, cv.height);
    gl!.uniform1f(quadUPresent, 0);
    gl!.uniform1i(quadUMode, mode);
    gl!.uniform4f(quadURect, x, y, w, h);
    if (color) gl!.uniform4f(quadUColor, color[0], color[1], color[2], color[3]);
    gl!.uniform1i(quadUTex, 0);
    gl!.drawArrays(gl!.TRIANGLE_STRIP, 0, 4);
  }

  // ---- frame ------------------------------------------------------------------
  function draw(full?: boolean): void {
    const g2 = gl!;
    const dw = cv.width, dh = cv.height;
    g2.bindFramebuffer(g2.FRAMEBUFFER, fbo);
    g2.viewport(0, 0, dw, dh);
    // accumTex is still bound from last frame's present pass; rendering into
    // it while bound is a feedback loop and Chrome silently drops the draw —
    // which kills the fade pass and lets the trails saturate to white
    g2.activeTexture(g2.TEXTURE0);
    g2.bindTexture(g2.TEXTURE_2D, null);

    if (full) {
      g2.disable(g2.BLEND);
      g2.clearColor(3 / 255, 3 / 255, 5 / 255, 1);
      g2.clear(g2.COLOR_BUFFER_BIT);
    } else {
      // the fade that turns last frame into a ghost trail
      g2.enable(g2.BLEND);
      g2.blendFunc(g2.SRC_ALPHA, g2.ONE_MINUS_SRC_ALPHA);
      quad(0, 0, 0, dw, dh, [4 / 255, 4 / 255, 7 / 255, 0.5]);
    }

    buildStrokes();
    buildDots();
    g2.enable(g2.BLEND);
    g2.blendFunc(g2.ONE, g2.ONE); // Canvas 2D 'lighter'

    if (sCount > 0) {
      g2.useProgram(strokeProg);
      g2.uniform2f(strokeURes, dw, dh);
      g2.bindVertexArray(sVao);
      g2.bindBuffer(g2.ARRAY_BUFFER, sBuf);
      g2.bufferSubData(g2.ARRAY_BUFFER, 0, sData.subarray(0, sCount * SVERT));
      g2.drawArrays(g2.TRIANGLE_STRIP, 0, sCount);
    }
    if (dCount > 0) {
      g2.useProgram(dotProg);
      g2.uniform2f(dotURes, dw, dh);
      g2.bindVertexArray(dVao);
      g2.bindBuffer(g2.ARRAY_BUFFER, dBuf);
      g2.bufferSubData(g2.ARRAY_BUFFER, 0, dData.subarray(0, dCount * DVERT));
      g2.drawArrays(g2.POINTS, 0, dCount);
    }

    const v = cam.video;
    if (cam.on && v && v.readyState >= 2 && v.videoWidth) {
      const pw = Math.round(W * 0.2);
      const phh = Math.round(pw * v.videoHeight / v.videoWidth);
      const px0 = (W - pw - 24) * DPR, py0 = (H - phh - 78) * DPR;
      const pwd = pw * DPR, phd = phh * DPR;
      g2.activeTexture(g2.TEXTURE0);
      g2.bindTexture(g2.TEXTURE_2D, camTex);
      g2.texImage2D(g2.TEXTURE_2D, 0, g2.RGBA, g2.RGBA, g2.UNSIGNED_BYTE, v);
      g2.blendFunc(g2.SRC_ALPHA, g2.ONE_MINUS_SRC_ALPHA);
      quad(2, px0, py0, pwd, phd, null);
      // hairline frame, 1 CSS px
      const t = DPR, fc: [number, number, number, number] =
        [226 / 255, 220 / 255, 204 / 255, 0.28];
      quad(0, px0, py0, pwd, t, fc);
      quad(0, px0, py0 + phd - t, pwd, t, fc);
      quad(0, px0, py0, t, phd, fc);
      quad(0, px0 + pwd - t, py0, t, phd, fc);
    }

    // present the accumulation texture to the screen
    g2.bindFramebuffer(g2.FRAMEBUFFER, null);
    g2.viewport(0, 0, dw, dh);
    g2.disable(g2.BLEND);
    g2.useProgram(quadProg);
    g2.bindVertexArray(qVao);
    g2.uniform1f(quadUPresent, 1);
    g2.uniform1i(quadUMode, 1);
    g2.uniform1i(quadUTex, 0);
    g2.activeTexture(g2.TEXTURE0);
    g2.bindTexture(g2.TEXTURE_2D, accumTex);
    g2.drawArrays(g2.TRIANGLE_STRIP, 0, 4);
    g2.bindVertexArray(null);
  }

  return { name: 'webgl', resize, draw };
}
