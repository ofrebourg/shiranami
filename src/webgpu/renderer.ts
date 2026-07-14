// WebGPU renderer — the GPU-resident simulation experiment.
//
// Division of labour (see docs/webgl2-vs-webgpu.md): the CPU keeps the
// cheap, stateful parts — seed advection, spray physics, MIDI/UI (~1 ms) —
// and a compute shader does the part that cost ~18 ms in JavaScript:
// integrating every streamline through the wave field, styling its
// sections, and writing ribbon geometry straight into a storage buffer
// that the stroke pipeline pulls from. Per frame the CPU uploads ~100 KB
// of launch state instead of megabytes of tessellated vertices.
//
// Solid-mode occlusion is the sim's exact algorithm, GPU-side: the
// compute pass atomicMin's line points into the depth-binned silhouette,
// a fold pass builds the nearer-bins-min table, and stroke/dot fragments
// cull against it. Rider foam closes the loop the other way: the compute
// pass appends breaking-point candidates to a small buffer the CPU reads
// back asynchronously and spawns one frame later.

import {
  P, D, W, H, DPR, FOCAL, MAXN, MAXS, STEPS,
  camX, horizonY, simT, solid, lastN,
  K0s, K1s, PH0, PH1, W0s, W1s, ph2, ph3, TAU,
  sx, sy, sz, sage, slife, ssize, svis, styp, sprayN,
  fillLineInputs, spawnRider,
} from '../core/sim';
import { cam } from '../core/cam';
import { recOverlay } from '../core/overlay';
import { processPip } from '../core/pip';
import type { Renderer } from '../core/renderer';
import { SIM_WGSL, DRAW_WGSL, QUAD_WGSL, CAND_CAP, NBINS, MAXNC } from './shaders';
import './webgpu.css';

const UNI_F = 32;                  // floats in the shared uniform (see shaders.ts)
const QUNI_B = 48;                 // bytes in a quad-pass uniform
const PT_B = 32;                   // bytes per stroke point record
const CAND_B = 32;                 // bytes per rider candidate

export async function createRenderer(cv: HTMLCanvasElement): Promise<Renderer | null> {
  if (!navigator.gpu) return null;
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) return null;
  const device = await adapter.requestDevice();
  device.lost.then((info) => {
    console.warn('[shiranami] WebGPU device lost:', info.message);
  });

  const context = cv.getContext('webgpu');
  if (!context) return null;
  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: 'opaque' });

  const simMod = device.createShaderModule({ code: SIM_WGSL });
  const drawMod = device.createShaderModule({ code: DRAW_WGSL });
  const quadMod = device.createShaderModule({ code: QUAD_WGSL });

  // ---- pipelines -------------------------------------------------------------
  const integratePipe = device.createComputePipeline({
    layout: 'auto', compute: { module: simMod, entryPoint: 'integrate' },
  });
  const foldPipe = device.createComputePipeline({
    layout: 'auto', compute: { module: simMod, entryPoint: 'foldmask' },
  });

  const additive: GPUBlendState = {
    color: { srcFactor: 'one', dstFactor: 'one' },        // Canvas 2D 'lighter'
    alpha: { srcFactor: 'one', dstFactor: 'one' },
  };
  const alphaBlend: GPUBlendState = {
    color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' },
    alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
  };

  const strokePipe = device.createRenderPipeline({
    layout: 'auto',
    vertex: { module: drawMod, entryPoint: 'strokeVS' },
    fragment: {
      module: drawMod, entryPoint: 'strokeFS',
      targets: [{ format: 'rgba8unorm', blend: additive }],
    },
    primitive: { topology: 'triangle-list' },
  });
  const dotPipe = device.createRenderPipeline({
    layout: 'auto',
    vertex: {
      module: drawMod, entryPoint: 'dotVS',
      buffers: [{
        arrayStride: 28, stepMode: 'instance',
        attributes: [
          { shaderLocation: 0, offset: 0, format: 'float32x3' },   // world pos
          { shaderLocation: 1, offset: 12, format: 'float32' },    // fade
          { shaderLocation: 2, offset: 16, format: 'float32' },    // size
          { shaderLocation: 3, offset: 20, format: 'float32' },    // vis
          { shaderLocation: 4, offset: 24, format: 'float32' },    // type
        ],
      }],
    },
    fragment: {
      module: drawMod, entryPoint: 'dotFS',
      targets: [{ format: 'rgba8unorm', blend: additive }],
    },
    primitive: { topology: 'triangle-list' },
  });
  const accumQuadPipe = device.createRenderPipeline({
    layout: 'auto',
    vertex: { module: quadMod, entryPoint: 'quadVS' },
    fragment: {
      module: quadMod, entryPoint: 'quadFS',
      targets: [{ format: 'rgba8unorm', blend: alphaBlend }],
    },
    primitive: { topology: 'triangle-strip' },
  });
  const presentPipe = device.createRenderPipeline({
    layout: 'auto',
    vertex: { module: quadMod, entryPoint: 'quadVS' },
    fragment: { module: quadMod, entryPoint: 'quadFS', targets: [{ format }] },
    primitive: { topology: 'triangle-strip' },
  });

  // ---- buffers ----------------------------------------------------------------
  const uniBuf = device.createBuffer({ size: UNI_F * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const linesBuf = device.createBuffer({ size: MAXN * 32, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  const ptsBuf = device.createBuffer({ size: MAXN * STEPS * PT_B, usage: GPUBufferUsage.STORAGE });
  const silBuf = device.createBuffer({ size: NBINS * MAXNC * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  const silCntBuf = device.createBuffer({ size: NBINS * MAXNC * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  const maskBuf = device.createBuffer({ size: NBINS * MAXNC * 4, usage: GPUBufferUsage.STORAGE });
  const candCntBuf = device.createBuffer({ size: 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC });
  const candBuf = device.createBuffer({ size: CAND_CAP * CAND_B, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
  const dotVB = device.createBuffer({ size: MAXS * 28, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });

  const lineData = new Float32Array(MAXN * 8);
  const dotData = new Float32Array(MAXS * 7);
  const uniData = new Float32Array(UNI_F);
  const silClear = new Uint32Array(NBINS * MAXNC).fill(0xffffffff);
  const cntClear = new Uint32Array(NBINS * MAXNC);
  const zero4 = new Uint32Array(1);

  // rider readback: two staging buffers rotate so mapAsync never stalls a frame
  const stages = [0, 1].map(() => ({
    buf: device.createBuffer({ size: 256 + CAND_CAP * CAND_B, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }),
    pending: false,
  }));

  // ---- bind groups --------------------------------------------------------------
  const bgIntegrate0 = device.createBindGroup({
    layout: integratePipe.getBindGroupLayout(0),
    entries: [{ binding: 0, resource: { buffer: uniBuf } }],
  });
  const bgIntegrate1 = device.createBindGroup({
    layout: integratePipe.getBindGroupLayout(1),
    entries: [
      { binding: 0, resource: { buffer: linesBuf } },
      { binding: 1, resource: { buffer: ptsBuf } },
      { binding: 2, resource: { buffer: silBuf } },
      { binding: 4, resource: { buffer: candCntBuf } },
      { binding: 5, resource: { buffer: candBuf } },
      { binding: 6, resource: { buffer: silCntBuf } },
    ],
  });
  const bgFold0 = device.createBindGroup({
    layout: foldPipe.getBindGroupLayout(0),
    entries: [{ binding: 0, resource: { buffer: uniBuf } }],
  });
  const bgFold1 = device.createBindGroup({
    layout: foldPipe.getBindGroupLayout(1),
    entries: [
      { binding: 2, resource: { buffer: silBuf } },
      { binding: 3, resource: { buffer: maskBuf } },
      { binding: 6, resource: { buffer: silCntBuf } },
    ],
  });
  const bgStroke0 = device.createBindGroup({
    layout: strokePipe.getBindGroupLayout(0),
    entries: [{ binding: 0, resource: { buffer: uniBuf } }],
  });
  const bgStroke1 = device.createBindGroup({
    layout: strokePipe.getBindGroupLayout(1),
    entries: [
      { binding: 0, resource: { buffer: ptsBuf } },
      { binding: 1, resource: { buffer: maskBuf } },
    ],
  });
  const bgDot0 = device.createBindGroup({
    layout: dotPipe.getBindGroupLayout(0),
    entries: [{ binding: 0, resource: { buffer: uniBuf } }],
  });
  const bgDot1 = device.createBindGroup({
    layout: dotPipe.getBindGroupLayout(1),
    entries: [{ binding: 1, resource: { buffer: maskBuf } }],
  });

  // ---- quad-pass plumbing ---------------------------------------------------------
  const sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
  const dummyTex = device.createTexture({
    size: [1, 1], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING,
  });

  function mkQuad(pipe: GPURenderPipeline, view: GPUTextureView) {
    const buf = device.createBuffer({ size: QUNI_B, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const bg = device.createBindGroup({
      layout: pipe.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: buf } },
        { binding: 1, resource: view },
        { binding: 2, resource: sampler },
      ],
    });
    return { buf, bg };
  }
  function setQuad(q: { buf: GPUBuffer }, rect: [number, number, number, number],
                   color: [number, number, number, number], mode: number): void {
    const d = new Float32Array(12);
    d.set(rect, 0);
    d.set(color, 4);
    d[8] = mode; d[9] = cv.width; d[10] = cv.height;
    device.queue.writeBuffer(q.buf, 0, d);
  }

  const fadeQ = mkQuad(accumQuadPipe, dummyTex.createView());
  let camQ: { buf: GPUBuffer; bg: GPUBindGroup } | null = null;
  let presentQ: { buf: GPUBuffer; bg: GPUBindGroup } | null = null;

  // ---- accumulation target -------------------------------------------------------
  let accumTex: GPUTexture | null = null;
  let accumView: GPUTextureView | null = null;
  let needClear = true;

  function resize(): void {
    if (accumTex) accumTex.destroy();
    accumTex = device.createTexture({
      size: [cv.width, cv.height],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    accumView = accumTex.createView();
    presentQ = mkQuad(presentPipe, accumView);
    setQuad(presentQ, [0, 0, 0, 0], [0, 0, 0, 0], 3);
    needClear = true;
  }

  // ---- recording placard texture ---------------------------------------------------
  let ovTex: GPUTexture | null = null;
  let ovQ: { buf: GPUBuffer; bg: GPUBindGroup } | null = null;
  let ovVersion = -1;

  function ovUpload(c: HTMLCanvasElement): void {
    if (ovVersion !== recOverlay.version) {
      if (ovTex) ovTex.destroy();
      ovTex = device.createTexture({
        size: [c.width, c.height], format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
      });
      ovQ = mkQuad(accumQuadPipe, ovTex.createView());
      device.queue.copyExternalImageToTexture({ source: c }, { texture: ovTex }, [c.width, c.height]);
      ovVersion = recOverlay.version;
    }
  }

  // ---- webcam texture --------------------------------------------------------------
  let camTex: GPUTexture | null = null;
  let camW = 0, camH = 0;

  function camUpload(c: HTMLCanvasElement): void {
    if (!camTex || camW !== c.width || camH !== c.height) {
      if (camTex) camTex.destroy();
      camW = c.width; camH = c.height;
      camTex = device.createTexture({
        size: [camW, camH], format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
      });
      camQ = mkQuad(accumQuadPipe, camTex.createView());
    }
    device.queue.copyExternalImageToTexture({ source: c }, { texture: camTex! }, [camW, camH]);
  }

  // ---- rider readback ---------------------------------------------------------------
  function collectRiders(stage: { buf: GPUBuffer; pending: boolean }): void {
    stage.pending = true;
    stage.buf.mapAsync(GPUMapMode.READ).then(() => {
      const cnt = Math.min(new Uint32Array(stage.buf.getMappedRange(0, 4))[0], CAND_CAP);
      if (cnt > 0) {
        const budget = 46 + Math.round(44 * P.foam);
        const rec = new Float32Array(stage.buf.getMappedRange(256, CAND_CAP * CAND_B));
        for (let i = 0; i < Math.min(cnt, budget); i++) {
          const o = i * 8;
          spawnRider(rec[o], rec[o + 1], rec[o + 2], rec[o + 3], rec[o + 4], rec[o + 5], rec[o + 6]);
        }
      }
      stage.buf.unmap();
      stage.pending = false;
    }, () => { stage.pending = false; });
  }

  // ---- frame ---------------------------------------------------------------------------
  let frameNo = 0;

  function draw(full?: boolean): void {
    frameNo++;
    const dpr = DPR;
    const clear = !!full || needClear;
    needClear = false;
    const still = !!full;
    const nc = Math.min(Math.ceil(W / 8), MAXNC);

    // launch state for the compute pass + raw spray pool for the dot pass
    const nLines = fillLineInputs(lineData);
    for (let j = 0; j < sprayN; j++) {
      const o = j * 7;
      dotData[o] = sx[j]; dotData[o + 1] = sy[j]; dotData[o + 2] = sz[j];
      const fade = 1 - sage[j] / slife[j];
      dotData[o + 3] = fade > 0 ? fade : 0;
      dotData[o + 4] = ssize[j]; dotData[o + 5] = svis[j]; dotData[o + 6] = styp[j];
    }

    const u = uniData;
    u[0] = cv.width; u[1] = cv.height; u[2] = dpr; u[3] = FOCAL;
    u[4] = camX; u[5] = horizonY; u[6] = K0s; u[7] = K1s;
    // phases wrapped so f32 keeps precision on long runs (sim keeps f64)
    u[8] = PH0 % TAU; u[9] = PH1 % TAU; u[10] = W0s; u[11] = W1s;
    u[12] = ph2 % TAU; u[13] = ph3 % TAU; u[14] = P.chaos; u[15] = D.amp;
    u[16] = D.bend; u[17] = simT * 0.045; u[18] = D.crest; u[19] = D.riderTh;
    u[20] = D.breakSlope;
    u[21] = still ? 0 : (0.03 + 0.15 * P.chaos) * D.sprayAmt * D.foamRate * D.stepScale;
    u[22] = D.baseW; u[23] = D.alphaMul;
    u[24] = D.steps; u[25] = solid ? 1 : 0; u[26] = frameNo % 100000; u[27] = nc;
    u[28] = nLines;

    device.queue.writeBuffer(uniBuf, 0, u);
    device.queue.writeBuffer(linesBuf, 0, lineData, 0, nLines * 8);
    if (sprayN > 0) device.queue.writeBuffer(dotVB, 0, dotData, 0, sprayN * 7);
    if (solid) {
      device.queue.writeBuffer(silBuf, 0, silClear, 0, NBINS * nc);
      device.queue.writeBuffer(silCntBuf, 0, cntClear, 0, NBINS * nc);
    }
    device.queue.writeBuffer(candCntBuf, 0, zero4);
    setQuad(fadeQ, [0, 0, cv.width, cv.height], [4 / 255, 4 / 255, 7 / 255, 0.5], 0);

    const enc = device.createCommandEncoder();

    const cp = enc.beginComputePass();
    cp.setPipeline(integratePipe);
    cp.setBindGroup(0, bgIntegrate0);
    cp.setBindGroup(1, bgIntegrate1);
    cp.dispatchWorkgroups(Math.ceil(nLines / 64));
    if (solid) {
      cp.setPipeline(foldPipe);
      cp.setBindGroup(0, bgFold0);
      cp.setBindGroup(1, bgFold1);
      cp.dispatchWorkgroups(Math.ceil(nc / 64));
    }
    cp.end();

    const rp = enc.beginRenderPass({
      colorAttachments: [{
        view: accumView!,
        loadOp: clear ? 'clear' : 'load',
        clearValue: { r: 3 / 255, g: 3 / 255, b: 5 / 255, a: 1 },
        storeOp: 'store',
      }],
    });
    if (!clear) {
      rp.setPipeline(accumQuadPipe);
      rp.setBindGroup(0, fadeQ.bg);
      rp.draw(4);
    }
    rp.setPipeline(strokePipe);
    rp.setBindGroup(0, bgStroke0);
    rp.setBindGroup(1, bgStroke1);
    rp.draw(nLines * (STEPS - 1) * 6);
    if (sprayN > 0) {
      rp.setPipeline(dotPipe);
      rp.setBindGroup(0, bgDot0);
      rp.setBindGroup(1, bgDot1);
      rp.setVertexBuffer(0, dotVB);
      rp.draw(6, sprayN);
    }
    const v = cam.video;
    if (cam.on && v && v.readyState >= 2 && v.videoWidth) {
      const pw = Math.round(W * 0.2);
      const phh = Math.round(pw * v.videoHeight / v.videoWidth);
      const pc = processPip(v, pw, phh, dpr);
      if (pc) {
        camUpload(pc);
        const px0 = (W - pw - 24) * dpr, py0 = (H - phh - 24) * dpr;
        setQuad(camQ!, [px0, py0, pw * dpr, phh * dpr], [0, 0, 0, 0], 4);
        rp.setPipeline(accumQuadPipe);
        rp.setBindGroup(0, camQ!.bg);
        rp.draw(4);
      }
    }
    if (recOverlay.on && recOverlay.canvas) {
      ovUpload(recOverlay.canvas);
      setQuad(ovQ!, [0, 0, recOverlay.cssW * dpr, recOverlay.cssH * dpr], [0, 0, 0, 0], 4);
      rp.setPipeline(accumQuadPipe);
      rp.setBindGroup(0, ovQ!.bg);
      rp.draw(4);
    }
    rp.end();

    const pp = enc.beginRenderPass({
      colorAttachments: [{
        view: context!.getCurrentTexture().createView(),
        loadOp: 'clear',
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
        storeOp: 'store',
      }],
    });
    pp.setPipeline(presentPipe);
    pp.setBindGroup(0, presentQ!.bg);
    pp.draw(4);
    pp.end();

    // rider candidates → CPU, one frame late
    const stage = stages.find((s) => !s.pending);
    if (stage && !still) {
      enc.copyBufferToBuffer(candCntBuf, 0, stage.buf, 0, 4);
      enc.copyBufferToBuffer(candBuf, 0, stage.buf, 256, CAND_CAP * CAND_B);
    }
    device.queue.submit([enc.finish()]);
    if (stage && !still) collectRiders(stage);
  }

  void lastN; // lastN is refreshed by fillLineInputs for the Stats readout
  return { name: 'webgpu', gpuSim: true, resize, draw };
}
