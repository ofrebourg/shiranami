// GLSL ES 3.00 shaders for the WebGL2 renderer.
//
// Strokes are CPU-tessellated ribbons: two vertices per polyline point,
// pre-expanded along the 2D normal to halfWidth + feather. The fragment
// shader turns the interpolated signed distance into an anti-aliased
// coverage value, energy-conserved so sub-pixel strokes carry the same
// additive light as Canvas 2D's coverage-based AA.
//
// All positions are DEVICE pixels, y-down (CSS convention); the vertex
// shaders flip to clip space. Additive passes write premultiplied light.

export const FEATHER = 1.0; // AA feather in device px — keep in sync with F below

export const STROKE_VS = `#version 300 es
layout(location=0) in vec2 aPos;   // device px, pre-expanded to the ribbon edge
layout(location=1) in vec2 aLine;  // x: signed distance from the spine, y: half-width
layout(location=2) in vec4 aCol;   // straight rgb + stroke alpha
uniform vec2 uRes;
out float vDist;
out float vHw;
out vec4 vCol;
void main() {
  vec2 clip = vec2(aPos.x / uRes.x * 2.0 - 1.0, 1.0 - aPos.y / uRes.y * 2.0);
  gl_Position = vec4(clip, 0.0, 1.0);
  vDist = aLine.x;
  vHw = aLine.y;
  vCol = aCol;
}`;

export const STROKE_FS = `#version 300 es
precision mediump float;
in float vDist;
in float vHw;
in vec4 vCol;
out vec4 o;
void main() {
  const float F = ${FEATHER.toFixed(1)};
  float cov = clamp((vHw + F - abs(vDist)) / F, 0.0, 1.0);
  // energy conservation: integrated coverage across the ribbon is 2hw + F,
  // the stroke owes 2hw — without this, thin lines glow brighter than 2D
  cov *= (2.0 * vHw) / (2.0 * vHw + F);
  o = vec4(vCol.rgb * (vCol.a * cov), 1.0);
}`;

export const DOT_VS = `#version 300 es
layout(location=0) in vec2 aPos;  // device px
layout(location=1) in float aRad; // device px
layout(location=2) in vec4 aCol;
uniform vec2 uRes;
out float vRad;
out float vSize;
out vec4 vCol;
void main() {
  vec2 clip = vec2(aPos.x / uRes.x * 2.0 - 1.0, 1.0 - aPos.y / uRes.y * 2.0);
  gl_Position = vec4(clip, 0.0, 1.0);
  vSize = 2.0 * (aRad + ${FEATHER.toFixed(1)});
  gl_PointSize = vSize;
  vRad = aRad;
  vCol = aCol;
}`;

export const DOT_FS = `#version 300 es
precision mediump float;
in float vRad;
in float vSize;
in vec4 vCol;
out vec4 o;
void main() {
  const float F = ${FEATHER.toFixed(1)};
  float r = length((gl_PointCoord - 0.5) * vSize);
  float cov = clamp((vRad + F - r) / F, 0.0, 1.0);
  // same energy conservation, radial: cone integral vs the crisp disc
  cov *= (vRad * vRad) / (vRad * vRad + vRad * F + F * F / 3.0);
  o = vec4(vCol.rgb * (vCol.a * cov), 1.0);
}`;

// One quad program covers the fade pass (solid colour), the present blit
// (texture) and the webcam PiP (texture, greyscaled like the 2D filter).
export const QUAD_VS = `#version 300 es
layout(location=0) in vec2 aUnit;  // 0..1
uniform vec4 uRect;     // x, y, w, h in device px (y-down)
uniform vec2 uRes;
uniform float uPresent; // 1 = fullscreen NDC blit, uv straight from aUnit
out vec2 vUv;
void main() {
  if (uPresent > 0.5) {
    gl_Position = vec4(aUnit * 2.0 - 1.0, 0.0, 1.0);
    vUv = aUnit;
  } else {
    vec2 p = uRect.xy + aUnit * uRect.zw;
    gl_Position = vec4(p.x / uRes.x * 2.0 - 1.0, 1.0 - p.y / uRes.y * 2.0, 0.0, 1.0);
    vUv = aUnit;
  }
}`;

export const QUAD_FS = `#version 300 es
precision mediump float;
in vec2 vUv;
uniform int uMode;      // 0 solid colour, 1 texture, 2 texture greyscale (PiP)
uniform vec4 uColor;
uniform sampler2D uTex;
out vec4 o;
void main() {
  if (uMode == 0) {
    o = uColor;
  } else if (uMode == 1) {
    o = vec4(texture(uTex, vUv).rgb, 1.0);
  } else {
    // grayscale(1) contrast(1.06) brightness(0.95), alpha 0.92 — the same
    // look the 2D renderer gets from ctx.filter
    vec3 c = texture(uTex, vUv).rgb;
    float g = dot(c, vec3(0.2126, 0.7152, 0.0722));
    g = clamp(((g - 0.5) * 1.06 + 0.5) * 0.95, 0.0, 1.0);
    o = vec4(g, g, g, 0.92);
  }
}`;
