// WGSL for the WebGPU renderer — the GPU-resident half of the simulation.
//
// The compute pass ports sim.ts's streamline integration verbatim: same
// hash (u32 wrapping matches JS |0 / imul / >>> bit-for-bit), same value
// noise, same wave field, same section styling and quantisation as the
// CPU renderers, so all three renderers stay visually comparable. The
// occlusion silhouette is the same algorithm as the CPU mask (20 log-depth
// bins × 8 css-px columns), built with atomicMin and folded into a
// nearer-bins-min table; strokes and dots cull per-fragment against it.
//
// Screen convention: positions flow in css px, convert to device px, then
// to clip with y flipped. WebGPU framebuffer origin is top-left, so the
// accumulation texture needs no flip anywhere.

import { TAU, ZNEAR, ZFAR, CAMH, BX, BZ, K2, K3, STEPS } from '../core/sim';

export const FEATHER = 1.0;       // AA feather, device px (matches webgl)
export const CAND_CAP = 256;      // rider-foam spawn candidates per frame
export const NBINS = 20;          // occlusion depth bins (matches sim.ts)
export const MAXNC = 512;         // occlusion column capacity (4096 css px)

const PXX = 0.382, PZZ = 0.924;   // swell-perpendicular (sim.ts constants)
const INVLOGZ = (NBINS - 1) / Math.log(ZFAR / ZNEAR);

// Uniform layout — 32 f32, written by renderer.ts in this exact order:
//  0 resx  1 resy  2 dpr    3 focal
//  4 camx  5 hory  6 k0s    7 k1s
//  8 ph0   9 ph1  10 w0s   11 w1s
// 12 ph2  13 ph3  14 chaos 15 amp
// 16 bend 17 t3   18 crest 19 riderth
// 20 breakslope  21 riderrate  22 basew  23 alphamul
// 24 steps 25 solid 26 seed 27 ncols
// 28 nlines 29-31 pad
const COMMON = /* wgsl */ `
struct U {
  resx: f32, resy: f32, dpr: f32, focal: f32,
  camx: f32, hory: f32, k0s: f32, k1s: f32,
  ph0: f32, ph1: f32, w0s: f32, w1s: f32,
  ph2: f32, ph3: f32, chaos: f32, amp: f32,
  bend: f32, t3: f32, crest: f32, riderth: f32,
  breakslope: f32, riderrate: f32, basew: f32, alphamul: f32,
  steps: f32, solid: f32, seed: f32, ncols: f32,
  nlines: f32, pad0: f32, pad1: f32, pad2: f32,
}
@group(0) @binding(0) var<uniform> uni: U;

const TAUC = ${TAU};
const ZNEARC = ${ZNEAR}.0;
const ZFARC = ${ZFAR}.0;
const CAMHC = ${CAMH}.0;
const BXC = ${BX};
const BZC = ${BZ};
const PXXC = ${PXX};
const PZZC = ${PZZ};
const K2C = ${K2};
const K3C = ${K3};
const INVLOGZC = ${INVLOGZ};
const F = ${FEATHER.toFixed(1)};

// bit-identical port of sim.ts hsh(): JS (a*b)|0, imul and >>> are all
// arithmetic mod 2^32, which is exactly WGSL u32 wrapping
fn hsh(i: i32, j: i32) -> f32 {
  var n: u32 = bitcast<u32>(i) * 374761393u + bitcast<u32>(j) * 668265263u;
  n = (n ^ (n >> 13u)) * 1274126177u;
  return f32(n ^ (n >> 16u)) / 4294967296.0;
}
fn vnoise(x: f32, y: f32) -> f32 {
  let xi = floor(x); let yi = floor(y);
  let xf = x - xi; let yf = y - yi;
  let u = xf * xf * (3.0 - 2.0 * xf); let v = yf * yf * (3.0 - 2.0 * yf);
  let ii = i32(xi); let jj = i32(yi);
  let a = hsh(ii, jj); let b = hsh(ii + 1, jj);
  let c = hsh(ii, jj + 1); let d = hsh(ii + 1, jj + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
fn fbm(x: f32, y: f32) -> f32 {
  return vnoise(x, y) * 0.65 + vnoise(x * 2.13 + 11.7, y * 2.13 + 5.2) * 0.35;
}

fn surf(x: f32, z: f32, w: f32) -> f32 {
  let u1 = x * 0.92 - z * 0.38;
  let pw = w * 1.9;
  var v = (sin(uni.k0s * u1 - uni.ph0 + pw) * uni.w0s + sin(uni.k1s * u1 - uni.ph1 + pw) * uni.w1s) * 0.62
        + sin(K2C * (x * 0.57 + z * 0.72) - uni.ph2 + w * 2.7) * 0.27
        + sin(K3C * (x * 0.8 + z * 0.6) + uni.ph3) * (0.06 + 0.14 * uni.chaos);
  // asymptotic knee, matching sim.ts: never flat, no crest ceiling
  if (v > 0.8) {
    let t = v - 0.8;
    v = 0.8 + 0.32 * t / (t + 0.32);
  } else if (v < -0.8) {
    let t2 = -v - 0.8;
    v = -0.8 - 0.32 * t2 / (t2 + 0.32);
  }
  return (2.0 * pow((v + 1.0) * 0.5, 1.55) - 1.0) * uni.amp;
}

fn binOf(z: f32) -> u32 {
  return u32(clamp(i32(log(z / ZNEARC) * INVLOGZC), 0, ${NBINS - 1}));
}
// silhouette y quantised to u32 so atomicMin works; +2048 keeps it positive
fn yq(y: f32) -> u32 { return u32(clamp((y + 2048.0) * 8.0, 0.0, 4000000.0)); }
fn yuq(q: u32) -> f32 { return f32(q) / 8.0 - 2048.0; }

struct Pt {
  p: vec2f,    // device px
  n: vec2f,    // normal * (hw + F), device px
  hw: f32,     // half width, device px
  z: f32,      // world depth (for occlusion bin)
  col: u32,    // pack4x8unorm rgba, alpha already quantised to ai/14
  fl: u32,     // 1 = live point
}
`;

// ---- simulation compute: integrate + style, then fold the mask -------------
export const SIM_WGSL = /* wgsl */ `
${COMMON}

@group(1) @binding(0) var<storage, read> lines: array<vec4f>;
@group(1) @binding(1) var<storage, read_write> pts: array<Pt>;
@group(1) @binding(2) var<storage, read_write> sil: array<atomic<u32>>;
@group(1) @binding(3) var<storage, read_write> mask: array<u32>;
struct Cand { x: f32, y: f32, z: f32, u: f32, vis: f32, dx: f32, dz: f32, pad: f32 }
@group(1) @binding(4) var<storage, read_write> candCnt: atomic<u32>;
@group(1) @binding(5) var<storage, read_write> cands: array<Cand>;

const WLEVC = array<f32, 7>(0.35, 0.55, 0.9, 1.5, 2.4, 3.9, 6.3);
const LOGINVC = ${(1 / Math.log(1.62)).toFixed(8)};
// COLS from sim.ts, /255
const COLSC = array<vec3f, 4>(
  vec3f(0.3372549, 0.4627451, 0.57254905),
  vec3f(0.5882353, 0.627451, 0.6745098),
  vec3f(0.8392157, 0.87058824, 0.9019608),
  vec3f(0.95686275, 0.96862745, 0.98039216),
);

@compute @workgroup_size(64)
fn integrate(@builtin(global_invocation_id) gid: vec3u) {
  let li = gid.x;
  if (li >= u32(uni.nlines)) { return; }
  let base = li * ${STEPS}u;
  let la = lines[li * 2u];
  let lb = lines[li * 2u + 1u];
  var cx = la.x; var cz = la.y;
  let w = la.z; let u = la.w;
  let stepLen = lb.x; let idx = lb.y; let spd = lb.z;
  let steps = u32(uni.steps);
  let cssw = uni.resx / uni.dpr;
  let cssh = uni.resy / uni.dpr;

  var pxs: array<f32, ${STEPS}>;
  var pys: array<f32, ${STEPS}>;
  var hn: array<f32, ${STEPS}>;
  var zz: array<f32, ${STEPS}>;
  var cnt = 0u;
  const nb = 0.0035;

  for (var k = 0u; k < steps; k++) {
    if (cz < ZNEARC * 0.72 || cz > ZFARC * 1.05) { break; }
    let yv = surf(cx, cz, w);
    let nv = fbm(cx * nb + idx * 0.7, cz * nb + uni.t3) * 2.0 - 1.0;
    let scp = uni.focal / cz;
    let gx = cssw * 0.5 + (cx - uni.camx) * scp;
    let gy = uni.hory + (CAMHC - (yv + nv * 2.0)) * scp;
    pxs[cnt] = gx; pys[cnt] = gy; hn[cnt] = yv / uni.amp; zz[cnt] = cz;
    cnt++;

    let bend = nv * uni.bend;
    var dX = BXC + PXXC * bend;
    var dZ = BZC + PZZC * bend;
    let inrm = inverseSqrt(dX * dX + dZ * dZ);
    dX *= inrm; dZ *= inrm;

    // rider-foam gate, as the CPU path: on-screen ridge points near
    // breaking. The winners go to a candidate list the CPU spawns from
    // next frame (foam can be a frame late; droplet physics stays CPU)
    if (uni.riderrate > 0.0 && yv > uni.amp * uni.crest &&
        gx > -20.0 && gx < cssw + 20.0 && gy > -40.0 && gy < cssh + 20.0 &&
        hsh(i32(li * 128u + k), i32(uni.seed)) < uni.riderrate) {
      let faceS = (surf(cx + 12.0 * BXC, cz + 12.0 * BZC, w) - yv) / 12.0;
      let en = (-faceS / uni.breakslope) * (0.4 + 0.7 * yv / uni.amp);
      if (en > uni.riderth) {
        let rvis = min((en - uni.riderth) / 0.7, 1.0);
        let ci = atomicAdd(&candCnt, 1u);
        if (ci < ${CAND_CAP}u) {
          cands[ci] = Cand(cx, yv, cz, u, rvis * rvis, dX, dZ, 0.0);
        }
      }
    }

    cx += dX * stepLen;
    cz += dZ * stepLen;
  }

  var valid = cnt >= 6u;
  if (valid) {
    let lastp = cnt - 1u;
    if ((pxs[0] < -80.0 && pxs[lastp] < -80.0) ||
        (pxs[0] > cssw + 80.0 && pxs[lastp] > cssw + 80.0) ||
        (pys[0] > cssh + 60.0 && pys[lastp] > cssh + 60.0)) { valid = false; }
  }
  if (!valid) {
    for (var k = 0u; k < ${STEPS}u; k++) { pts[base + k].fl = 0u; }
    return;
  }

  let nc = u32(uni.ncols);
  if (uni.solid > 0.5) {
    for (var k = 0u; k < cnt; k++) {
      let bin = binOf(zz[k]);
      let col = min(u32(max(pxs[k], 0.0) / 8.0), nc - 1u);
      atomicMin(&sil[bin * nc + col], yq(pys[k]));
    }
  }

  // style per 5-point section — the same math and the same colour/alpha/
  // width quantisation as the CPU renderers, so the picture matches
  let last = cnt - 1u;
  let nSec = (last + 4u) / 5u;
  for (var s = 0u; s < nSec; s++) {
    let sfrom = s * 5u;
    var sto = sfrom + 5u;
    if (sto > last) { sto = last; }
    let mid = (sfrom + sto) >> 1u;
    let nH = hn[mid];
    let steep = min(abs((hn[sto] - hn[sfrom]) * uni.amp / (f32(sto - sfrom) * stepLen)) * 1.4, 1.0);
    var bright = 0.3 + 0.5 * max(nH, 0.0) + 0.3 * steep + 0.2 * spd;
    var cIdx = 1;
    if (nH < -0.35 && bright < 0.55) { cIdx = 0; }
    else if (bright > 0.86) { cIdx = 3; }
    else if (bright > 0.52) { cIdx = 2; }
    bright = min(bright, 1.0);

    let zMid = zz[mid];
    let scm = uni.focal / zMid;
    let tzm = clamp((zMid - ZNEARC) / (ZFARC - ZNEARC), 0.0, 1.0);
    let da = 0.06 + 0.94 * pow(1.0 - tzm, 1.8);
    var alpha = bright * 0.42 * uni.alphamul * da;
    alpha *= 0.4 + 0.6 * min(1.0, nH + 1.05);
    var wid = clamp(uni.basew * scm * 0.42, 0.3, 5.0);
    if (scm > 3.6) {
      let ex = scm / 3.6;
      wid *= 1.0 + 0.55 * (ex - 1.0);
      alpha /= 1.0 + 0.5 * (ex - 1.0);
    }
    if (s == 0u || s == nSec - 1u) { alpha *= 0.45; }
    else if (s == 1u || s == nSec - 2u) { alpha *= 0.8; }

    var ai = round(alpha * 14.0);
    ai = min(ai, 7.0);
    let a = select(ai / 14.0, 0.0, ai < 1.0); // ai<1: invisible, like pushPoly
    let wi = clamp(i32(round(log(wid / 0.35) * LOGINVC)), 0, 6);
    let hwd = WLEVC[wi] * uni.dpr * 0.5;
    let packed = pack4x8unorm(vec4f(COLSC[cIdx], a));
    let ext = hwd + F;

    for (var k = sfrom; k <= sto; k++) {
      let kp = select(k - 1u, 0u, k == 0u);
      let kn = select(k + 1u, last, k == last);
      var dx2 = pxs[kn] - pxs[kp];
      var dy2 = pys[kn] - pys[kp];
      let l2 = sqrt(dx2 * dx2 + dy2 * dy2);
      if (l2 > 1e-6) { dx2 /= l2; dy2 /= l2; } else { dx2 = 1.0; dy2 = 0.0; }
      pts[base + k] = Pt(
        vec2f(pxs[k], pys[k]) * uni.dpr,
        vec2f(-dy2, dx2) * ext,
        hwd, zz[k], packed, 1u
      );
    }
  }
  for (var k = cnt; k < ${STEPS}u; k++) { pts[base + k].fl = 0u; }
}

// mask[b][c] = min silhouette of all bins strictly nearer than b
@compute @workgroup_size(64)
fn foldmask(@builtin(global_invocation_id) gid: vec3u) {
  let c = gid.x;
  let nc = u32(uni.ncols);
  if (c >= nc) { return; }
  var m = 0xFFFFFFFFu;
  for (var b = 0u; b < ${NBINS}u; b++) {
    mask[b * nc + c] = m;
    m = min(m, atomicLoad(&sil[b * nc + c]));
  }
}
`;

// ---- render: strokes (vertex pulling) + dots (instanced quads) -------------
export const DRAW_WGSL = /* wgsl */ `
${COMMON}

@group(1) @binding(0) var<storage, read> pts: array<Pt>;
@group(1) @binding(1) var<storage, read> mask: array<u32>;

// occlusion happens at SEGMENT granularity in the vertex stage — the same
// per-point culling the CPU renderers do. Testing per fragment instead
// exposes the mask's raw 8px-column cells as rectangular holes
fn occludedPt(pDev: vec2f, z: f32) -> bool {
  if (uni.solid < 0.5) { return false; }
  let nc = u32(uni.ncols);
  let c = min(u32(max(pDev.x / uni.dpr, 0.0) / 8.0), nc - 1u);
  let m = yuq(mask[binOf(z) * nc + c]);
  return pDev.y / uni.dpr > m + 3.0;
}

struct SOut {
  @builtin(position) pos: vec4f,
  @location(0) dist: f32,
  @location(1) hw: f32,
  @location(2) @interpolate(flat) col: u32,
  @location(3) @interpolate(flat) z: f32,
}

// 6 vertices per segment; segment colour/width come from its lower point,
// which keeps the CPU renderers' hard section boundaries
@vertex fn strokeVS(@builtin(vertex_index) vi: u32) -> SOut {
  let seg = vi / 6u;
  let corner = vi % 6u;
  let li = seg / ${STEPS - 1}u;
  let s = seg % ${STEPS - 1}u;
  let ia = li * ${STEPS}u + s;
  let pa = pts[ia];
  let pb = pts[ia + 1u];
  var o: SOut;
  if (pa.fl == 0u || pb.fl == 0u ||
      occludedPt(pa.p, pa.z) || occludedPt(pb.p, pb.z)) {
    o.pos = vec4f(2.0, 2.0, 0.0, 1.0); // off-clip, degenerate
    o.dist = 0.0; o.hw = 1.0; o.col = 0u; o.z = ZNEARC;
    return o;
  }
  let useB = corner == 2u || corner == 3u || corner == 5u;
  let side = select(1.0, -1.0, corner == 1u || corner == 4u || corner == 5u);
  var pp: vec2f;
  var nn: vec2f;
  if (useB) { pp = pb.p; nn = pb.n; } else { pp = pa.p; nn = pa.n; }
  let pos = pp + nn * side;
  o.pos = vec4f(pos.x / uni.resx * 2.0 - 1.0, 1.0 - pos.y / uni.resy * 2.0, 0.0, 1.0);
  o.dist = side * (pa.hw + F);
  o.hw = pa.hw;
  o.col = pa.col;
  o.z = pa.z;
  return o;
}

@fragment fn strokeFS(in: SOut) -> @location(0) vec4f {
  let col = unpack4x8unorm(in.col);
  if (col.a == 0.0) { discard; }
  var cov = clamp((in.hw + F - abs(in.dist)) / F, 0.0, 1.0);
  cov *= (2.0 * in.hw) / (2.0 * in.hw + F);
  return vec4f(col.rgb * (col.a * cov), 1.0);
}

// dots: instance attrs are raw sim spray state; projection + styling here,
// with the same formulas and quantisation as the CPU dot path
struct DOut {
  @builtin(position) pos: vec4f,
  @location(0) local: vec2f,   // device px from centre
  @location(1) rad: f32,       // device px
  @location(2) alpha: f32,
  @location(3) @interpolate(flat) z: f32,
}

const CORNERS = array<vec2f, 6>(
  vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0),
  vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0),
);

@vertex fn dotVS(@builtin(vertex_index) vi: u32,
                 @location(0) wp: vec3f,      // world x, y, z
                 @location(1) fade: f32,      // 1 - age/life
                 @location(2) size: f32,
                 @location(3) vis: f32,
                 @location(4) typ: f32) -> DOut {
  var o: DOut;
  o.pos = vec4f(2.0, 2.0, 0.0, 1.0);
  o.local = vec2f(0.0); o.rad = 1.0; o.alpha = 0.0; o.z = ZNEARC;

  let cssw = uni.resx / uni.dpr;
  let cssh = uni.resy / uni.dpr;
  let ssc = uni.focal / wp.z;
  let sxs = cssw * 0.5 + (wp.x - uni.camx) * ssc;
  let sys = uni.hory + (CAMHC - wp.y) * ssc;
  if (sxs < -20.0 || sxs > cssw + 20.0 || sys > cssh + 20.0 || sys < -40.0) { return o; }
  if (occludedPt(vec2f(sxs, sys) * uni.dpr, wp.z)) { return o; }

  let fd = select(pow(max(fade, 0.0), 1.25), fade * fade, typ > 0.5);
  let sda = 0.15 + 0.85 * pow(1.0 - (wp.z - ZNEARC) / (ZFARC - ZNEARC), 1.6);
  let rad = clamp(size * ssc * 0.55 * (0.7 + 0.3 * fade), 0.5, 5.0);
  var a = fd * select(0.55, 0.42, typ > 0.5) * sda * (0.15 + 0.85 * vis * vis);
  let ai = min(round(a * 14.0), 7.0);
  if (ai < 1.0) { return o; }

  let radd = rad * uni.dpr;
  let extd = radd + F;
  let corner = CORNERS[vi];
  let centre = vec2f(sxs, sys) * uni.dpr;
  let p = centre + corner * extd;
  o.pos = vec4f(p.x / uni.resx * 2.0 - 1.0, 1.0 - p.y / uni.resy * 2.0, 0.0, 1.0);
  o.local = corner * extd;
  o.rad = radd;
  o.alpha = ai / 14.0;
  o.z = wp.z;
  return o;
}

@fragment fn dotFS(in: DOut) -> @location(0) vec4f {
  if (in.alpha == 0.0) { discard; }
  let r = length(in.local);
  var cov = clamp((in.rad + F - r) / F, 0.0, 1.0);
  cov *= (in.rad * in.rad) / (in.rad * in.rad + in.rad * F + F * F / 3.0);
  // dot colour: rgba(246,249,252)
  return vec4f(vec3f(0.9647059, 0.9764706, 0.9882353) * (in.alpha * cov), 1.0);
}
`;

// ---- quad passes: fade, webcam PiP, hairline, present -----------------------
export const QUAD_WGSL = /* wgsl */ `
struct QU {
  rect: vec4f,   // x, y, w, h in device px (ignored when mode == 3)
  color: vec4f,
  mode: f32,     // 0 solid, 1 texture, 2 texture greyscale (PiP), 3 present
  resx: f32, resy: f32, pad: f32,
}
@group(0) @binding(0) var<uniform> qu: QU;
@group(0) @binding(1) var tex: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;

struct QOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
}

const UNIT = array<vec2f, 4>(vec2f(0.0, 0.0), vec2f(1.0, 0.0), vec2f(0.0, 1.0), vec2f(1.0, 1.0));

@vertex fn quadVS(@builtin(vertex_index) vi: u32) -> QOut {
  let un = UNIT[vi];
  var o: QOut;
  if (qu.mode > 2.5) {
    // present: fullscreen; WebGPU framebuffer origin is top-left, so the
    // accum texture is already the right way up — uv follows the corner
    o.pos = vec4f(un.x * 2.0 - 1.0, 1.0 - un.y * 2.0, 0.0, 1.0);
  } else {
    let p = qu.rect.xy + un * qu.rect.zw;
    o.pos = vec4f(p.x / qu.resx * 2.0 - 1.0, 1.0 - p.y / qu.resy * 2.0, 0.0, 1.0);
  }
  o.uv = un;
  return o;
}

@fragment fn quadFS(in: QOut) -> @location(0) vec4f {
  if (qu.mode < 0.5) { return qu.color; }
  if (qu.mode < 1.5 || qu.mode > 2.5) {
    return vec4f(textureSample(tex, samp, in.uv).rgb, 1.0);
  }
  // grayscale(1) contrast(1.06) brightness(0.95), alpha 0.92 — matches the
  // ctx.filter the Canvas 2D renderer uses for the PiP
  let c = textureSample(tex, samp, in.uv).rgb;
  var g = dot(c, vec3f(0.2126, 0.7152, 0.0722));
  g = clamp(((g - 0.5) * 1.06 + 0.5) * 0.95, 0.0, 1.0);
  return vec4f(g, g, g, 0.92);
}
`;
