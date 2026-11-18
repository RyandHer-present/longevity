// GLSL for the voxel world. Vertex data comes straight from the Rust mesher (see crates/mesher):
// position i16 (1/64 block), uv u16 (normalized), layer u16, color u8x4 (tint + AO), extra u8x4
// (flags, sky light, block light). flags: bits 0-2 face, 3 no-shade, 4 emissive, 5 water, 6 plant, 7 leaves.

export const COMMON = /* glsl */ `
precision highp float;
precision highp int;
precision highp sampler2DArray;
precision highp sampler2DShadow;

uniform float uTime;
uniform float uTicks;
uniform float uWind;
uniform vec3 uSunDir;      // direction towards the light (sun or moon)
uniform vec3 uSunColor;    // direct light colour * intensity
uniform vec3 uSkyAmbient;  // sky light ambient
uniform vec3 uBlockColor;  // torch light colour
uniform vec3 uFogColor;
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform float uFogNear;
uniform float uFogFar;
uniform float uDaylight;
uniform float uRain;
uniform float uNether;
uniform vec3 uMinLight;

vec3 faceNormal(int f) {
  if (f == 0) return vec3(0.0, -1.0, 0.0);
  if (f == 1) return vec3(0.0, 1.0, 0.0);
  if (f == 2) return vec3(0.0, 0.0, -1.0);
  if (f == 3) return vec3(0.0, 0.0, 1.0);
  if (f == 4) return vec3(-1.0, 0.0, 0.0);
  return vec3(1.0, 0.0, 0.0);
}
float faceShade(int f) {
  if (f == 0) return 0.5;
  if (f == 1) return 1.0;
  if (f == 2 || f == 3) return 0.8;
  return 0.6;
}
// Minecraft-ish light curve, a bit brighter in the low end
float lightCurve(float l) {
  float mc = l / (4.0 - 3.0 * l);
  return mix(mc, l * l, 0.45);
}
vec3 srgbToLinear(vec3 c) { return pow(c, vec3(2.2)); }
vec3 skyColorDir(vec3 d) {
  float h = clamp(d.y, -0.2, 1.0);
  vec3 c = mix(uHorizon, uZenith, pow(max(h, 0.0), 0.55));
  return mix(c, uHorizon * 0.6, clamp(-h * 4.0, 0.0, 1.0));
}
`;

export const CHUNK_VERT = /* glsl */ `
${COMMON}
in vec2 auv;
in float alayer;
in vec4 acolor;
in vec4 aextra;
uniform sampler2D uAnim;
uniform mat4 uShadowMatrix;
out vec2 vUv;
flat out float vLayer;
out vec4 vColor;
out vec3 vWorld;
flat out int vFlags;
out float vSky;
out float vBlock;
out vec4 vShadow;

void main() {
  int flags = int(aextra.x + 0.5);
  vFlags = flags;
  vec3 local = position / 64.0;
  vec3 wp = (modelMatrix * vec4(local, 1.0)).xyz;
  float w = uWind * (1.0 + uRain * 1.5);
  if ((flags & 64) != 0) {
    float top = 1.0 - auv.y;
    float ph = uTime * 1.7 + wp.x * 0.55 + wp.z * 0.35;
    wp.x += (sin(ph) * 0.045 + sin(ph * 2.3) * 0.015) * top * w;
    wp.z += cos(uTime * 1.3 + wp.z * 0.45 + wp.x * 0.2) * 0.035 * top * w;
  } else if ((flags & 128) != 0) {
    float ph = uTime * 1.25 + wp.y * 0.7 + wp.z * 0.45 + wp.x * 0.2;
    wp.x += sin(ph) * 0.018 * w;
    wp.y += sin(uTime * 1.55 + wp.x * 0.6 + wp.z * 0.3) * 0.012 * w;
    wp.z += cos(ph * 0.8) * 0.014 * w;
  }
  // animated textures: frames follow the first layer
  int layer = int(alayer + 0.5);
  vec4 an = texelFetch(uAnim, ivec2(layer % 256, layer / 256), 0) * 255.0;
  float frames = max(an.r, 1.0);
  float ft = max(an.g, 1.0);
  vLayer = float(layer) + mod(floor(uTicks / ft), frames);
  vUv = auv;
  vColor = acolor;
  vSky = aextra.y / 255.0;
  vBlock = aextra.z / 255.0;
  vWorld = wp;
  vShadow = uShadowMatrix * vec4(wp, 1.0);
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}
`;

export const CHUNK_FRAG = /* glsl */ `
${COMMON}
uniform sampler2DArray uTex;
uniform sampler2DArray uTex2; // a resource pack being previewed
uniform float uSplit; // screen x (px) from where the pack is shown; huge = no pack
uniform sampler2DShadow uShadowMap;
uniform float uShadowOn;
uniform float uShadowTexel;
uniform int uPass; // 0 = opaque/cutout, 1 = translucent
uniform float uFlash;
in vec2 vUv;
flat in float vLayer;
in vec4 vColor;
in vec3 vWorld;
flat in int vFlags;
in float vSky;
in float vBlock;
in vec4 vShadow;

float shadowAt(vec3 n) {
  if (uShadowOn < 0.5) return 1.0;
  vec3 p = vShadow.xyz / vShadow.w * 0.5 + 0.5;
  if (p.x <= 0.0 || p.x >= 1.0 || p.y <= 0.0 || p.y >= 1.0 || p.z >= 1.0) return 1.0;
  float ndl = max(dot(n, uSunDir), 0.0);
  float bias = 0.0006 + 0.0018 * (1.0 - ndl);
  float s = 0.0;
  float t = uShadowTexel;
  for (int y = -1; y <= 1; y++)
    for (int x = -1; x <= 1; x++)
      s += texture(uShadowMap, vec3(p.xy + vec2(float(x), float(y)) * t, p.z - bias));
  s /= 9.0;
  // fade out at the edge of the shadow map
  vec2 e = smoothstep(0.0, 0.06, p.xy) * smoothstep(1.0, 0.94, p.xy);
  return mix(1.0, s, e.x * e.y);
}

void main() {
  vec4 tex = texture(uTex, vec3(vUv, vLayer));
  if (uSplit < 1e8) {
    vec4 packTex = texture(uTex2, vec3(vUv, vLayer));
    if (gl_FragCoord.x >= uSplit) tex = packTex;
  }
  int face = vFlags & 7;
  bool noShade = (vFlags & 8) != 0;
  bool emissive = (vFlags & 16) != 0;
  bool water = (vFlags & 32) != 0;
  if (uPass == 0) {
    if (tex.a < 0.5) discard;
  } else {
    if (tex.a < 0.02) discard;
  }
  vec3 albedo = tex.rgb * srgbToLinear(vColor.rgb);
  float ao = vColor.a;
  vec3 n = faceNormal(face);
  vec3 V = normalize(cameraPosition - vWorld);
  float shade = noShade ? 0.92 : faceShade(face);
  float sky = lightCurve(vSky);
  float blk = lightCurve(vBlock);
  float ndl = noShade ? 0.6 : max(dot(n, uSunDir), 0.0);
  float sh = (vSky > 0.05 && ndl > 0.0) ? shadowAt(n) : 1.0;
  // deeper shadow only where sky light reaches (open air); interiors are lit by sky light already
  float direct = ndl * sh * smoothstep(0.35, 0.95, vSky);
  vec3 skyL = sky * (uSkyAmbient * shade + uSunColor * direct);
  vec3 blkL = uBlockColor * blk * mix(shade, 1.0, 0.35);
  vec3 light = skyL + blkL * (1.0 - 0.55 * sky * uDaylight);
  light = light * mix(0.35, 1.0, ao) + uMinLight * mix(0.5, 1.0, ao);
  vec3 col = albedo * light;
  float alpha = uPass == 0 ? 1.0 : tex.a;
  if (emissive) {
    col = albedo * (1.25 + 0.6 * (1.0 - uDaylight));
  }
  if (water) {
    // rippled normal for the surface
    vec3 wn = n;
    if (face == 1) {
      vec2 q = vWorld.xz;
      float t = uTime;
      float dx = cos(q.x * 1.7 + t * 1.4) * 0.5 + cos(q.x * 0.9 - q.y * 1.3 + t * 0.9) * 0.35 + cos((q.x + q.y) * 3.1 + t * 2.3) * 0.15;
      float dz = cos(q.y * 1.5 - t * 1.2) * 0.5 + cos(q.y * 1.1 + q.x * 0.7 + t * 1.1) * 0.35 + cos((q.y - q.x) * 2.8 - t * 2.0) * 0.15;
      wn = normalize(vec3(dx * 0.06, 1.0, dz * 0.06));
    }
    vec3 R = reflect(-V, wn);
    float fres = 0.04 + 0.96 * pow(1.0 - max(dot(V, wn), 0.0), 5.0);
    vec3 refl = skyColorDir(R) * (0.35 + 0.65 * sky);
    float spec = pow(max(dot(R, uSunDir), 0.0), 420.0) * 6.0 * sh * sky;
    col = mix(col, refl, fres * 0.85) + uSunColor * spec;
    alpha = mix(tex.a * 0.9, 0.97, fres);
  }
  // fog
  float d = length(vWorld - cameraPosition);
  float fog = smoothstep(uFogNear, uFogFar, d);
  vec3 fogCol = uFogColor;
  col = mix(col, fogCol, fog);
  col += uFlash * 0.4;
  gl_FragColor = vec4(col, alpha);
}
`;

export const DEPTH_VERT = /* glsl */ `
${COMMON}
in vec2 auv;
in float alayer;
in vec4 aextra;
uniform sampler2D uAnim;
out vec2 vUv;
flat out float vLayer;
void main() {
  int flags = int(aextra.x + 0.5);
  vec3 wp = (modelMatrix * vec4(position / 64.0, 1.0)).xyz;
  if ((flags & 64) != 0) {
    float top = 1.0 - auv.y;
    float ph = uTime * 1.7 + wp.x * 0.55 + wp.z * 0.35;
    wp.x += (sin(ph) * 0.045 + sin(ph * 2.3) * 0.015) * top * uWind;
  }
  vUv = auv;
  vLayer = alayer;
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}
`;

export const DEPTH_FRAG = /* glsl */ `
${COMMON}
uniform sampler2DArray uTex;
in vec2 vUv;
flat in float vLayer;
void main() {
  if (texture(uTex, vec3(vUv, vLayer)).a < 0.5) discard;
  gl_FragColor = vec4(1.0);
}
`;

export const SKY_VERT = /* glsl */ `
out vec3 vDir;
void main() {
  vDir = normalize(position);
  vec4 p = projectionMatrix * mat4(mat3(viewMatrix)) * vec4(position, 1.0);
  gl_Position = p.xyww;
}
`;

export const SKY_FRAG = /* glsl */ `
${COMMON}
uniform vec3 uRealSun;
uniform float uStars;
in vec3 vDir;
float hash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
void main() {
  vec3 d = normalize(vDir);
  vec3 col = skyColorDir(d);
  if (uNether < 0.5) {
    // sun: soft square-ish disc with glow
    vec3 s = normalize(uRealSun);
    float cs = dot(d, s);
    float glow = pow(max(cs, 0.0), 12.0) * 0.35 + pow(max(cs, 0.0), 160.0) * 0.8;
    vec3 sunTint = mix(vec3(1.0, 0.55, 0.25), vec3(1.0, 0.92, 0.75), clamp(s.y * 3.0, 0.0, 1.0));
    col += sunTint * glow * (1.0 - uRain * 0.8) * smoothstep(-0.15, 0.05, s.y);
    // square sun disc like the game, but anti-aliased
    vec3 up = abs(s.y) > 0.99 ? vec3(1, 0, 0) : vec3(0, 1, 0);
    vec3 sx = normalize(cross(up, s));
    vec3 sy = cross(s, sx);
    vec2 q = vec2(dot(d, sx), dot(d, sy)) / max(cs, 0.001);
    float disc = cs > 0.0 ? (1.0 - smoothstep(0.045, 0.05, max(abs(q.x), abs(q.y)))) : 0.0;
    col += sunTint * disc * 6.0 * (1.0 - uRain);
    // moon opposite the sun
    vec3 m = -s;
    float cm = dot(d, m);
    vec3 mx = normalize(cross(up, m));
    vec3 my = cross(m, mx);
    vec2 mq = vec2(dot(d, mx), dot(d, my)) / max(cm, 0.001);
    float mdisc = cm > 0.0 ? (1.0 - smoothstep(0.03, 0.034, max(abs(mq.x), abs(mq.y)))) : 0.0;
    col += vec3(0.75, 0.8, 0.95) * mdisc * 1.4 * (1.0 - uRain);
    col += vec3(0.4, 0.45, 0.6) * pow(max(cm, 0.0), 40.0) * 0.12;
    // stars
    if (uStars > 0.01 && d.y > 0.0) {
      vec3 g = floor(d * 380.0);
      float h = hash(g);
      float star = step(0.9965, h) * (0.5 + 0.5 * sin(uTime * (1.0 + h * 3.0) + h * 40.0));
      col += vec3(0.9, 0.92, 1.0) * star * uStars * smoothstep(0.0, 0.25, d.y) * (1.0 - uRain);
    }
  }
  gl_FragColor = vec4(col, 1.0);
}
`;

export const CLOUD_VERT = /* glsl */ `
out vec2 vUv;
out vec3 vWorld;
uniform float uTime;
uniform vec2 uOffset;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  vUv = (wp.xz + uOffset) / (256.0 * 12.0) + vec2(uTime * 0.00009, 0.0);
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

export const CLOUD_FRAG = /* glsl */ `
${COMMON}
uniform sampler2D uClouds;
in vec2 vUv;
in vec3 vWorld;
void main() {
  vec4 c = texture(uClouds, vUv);
  if (c.a < 0.5) discard;
  float d = length(vWorld.xz - cameraPosition.xz);
  float fade = 1.0 - smoothstep(600.0, 1400.0, d);
  vec3 lit = mix(vec3(0.08, 0.09, 0.13), vec3(1.0, 0.99, 0.97), uDaylight);
  lit = mix(lit, lit * vec3(1.0, 0.8, 0.7), (1.0 - abs(uSunDir.y)) * uDaylight * 0.6);
  lit *= mix(1.0, 0.55, uRain);
  gl_FragColor = vec4(lit, 0.78 * fade);
}
`;

// LOD terrain beyond the meshed chunks: vertex colours, flat shading by face, sky light only.
export const LOD_VERT = /* glsl */ `
${COMMON}
in vec3 acol;
in float aface;
out vec3 vCol;
out vec3 vWorld;
flat out int vFace;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  vCol = acol;
  vFace = int(aface + 0.5);
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

export const LOD_FRAG = /* glsl */ `
${COMMON}
uniform vec2 uHoleCenter;
uniform float uHoleRadius;
in vec3 vCol;
in vec3 vWorld;
flat in int vFace;
void main() {
  vec2 dd = abs(vWorld.xz - uHoleCenter);
  if (max(dd.x, dd.y) < uHoleRadius) discard;
  vec3 n = faceNormal(vFace);
  float ndl = max(dot(n, uSunDir), 0.0);
  vec3 albedo = srgbToLinear(vCol);
  vec3 col = albedo * (uSkyAmbient * faceShade(vFace) + uSunColor * ndl * 0.85);
  float d = length(vWorld - cameraPosition);
  col = mix(col, uFogColor, smoothstep(uFogNear, uFogFar, d));
  gl_FragColor = vec4(col, 1.0);
}
`;

// Final grade: vignette, gentle film curve, optional "drawn" ink-and-wash look for Lore Book plates.
export const GRADE_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D tDiffuse;
uniform vec2 uRes;
uniform float uVignette;
uniform float uMode; // 0 normal, 1 warm film, 2 mono, 3 drawn, 4 cool
uniform float uTime;
uniform float uGrain;
in vec2 vUv;
float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  float a = hash(i), b = hash(i + vec2(1, 0)), c = hash(i + vec2(0, 1)), d = hash(i + vec2(1, 1));
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
void main() {
  vec3 c = texture(tDiffuse, vUv).rgb;
  vec2 px = 1.0 / uRes;
  if (uMode > 2.5 && uMode < 3.5) {
    // ink lines from colour edges + paper and watercolour wash
    float l00 = luma(texture(tDiffuse, vUv + px * vec2(-1, -1)).rgb);
    float l10 = luma(texture(tDiffuse, vUv + px * vec2(0, -1)).rgb);
    float l20 = luma(texture(tDiffuse, vUv + px * vec2(1, -1)).rgb);
    float l01 = luma(texture(tDiffuse, vUv + px * vec2(-1, 0)).rgb);
    float l21 = luma(texture(tDiffuse, vUv + px * vec2(1, 0)).rgb);
    float l02 = luma(texture(tDiffuse, vUv + px * vec2(-1, 1)).rgb);
    float l12 = luma(texture(tDiffuse, vUv + px * vec2(0, 1)).rgb);
    float l22 = luma(texture(tDiffuse, vUv + px * vec2(1, 1)).rgb);
    float gx = -l00 - 2.0 * l01 - l02 + l20 + 2.0 * l21 + l22;
    float gy = -l00 - 2.0 * l10 - l20 + l02 + 2.0 * l12 + l22;
    float edge = smoothstep(0.08, 0.32, sqrt(gx * gx + gy * gy));
    vec2 p = vUv * uRes;
    float paper = noise(p * 0.9) * 0.5 + noise(p * 0.21) * 0.35 + noise(p * 0.05) * 0.15;
    vec3 paperCol = vec3(0.93, 0.88, 0.77) * (0.92 + paper * 0.1);
    // posterised, desaturated wash, bleeding a little
    vec3 wash = c;
    float L = luma(wash);
    wash = mix(vec3(L), wash, 0.55);
    wash = floor(wash * 5.0 + noise(p * 0.08) * 0.6) / 5.0;
    vec3 col = paperCol * mix(vec3(1.0), wash * 1.15 + 0.08, 0.72);
    float hatch = step(0.5, fract((p.x + p.y) * 0.18)) * smoothstep(0.42, 0.15, L) * 0.18;
    col *= 1.0 - hatch;
    col = mix(col, vec3(0.16, 0.12, 0.09), edge * 0.85);
    float v = smoothstep(0.95, 0.35, length(vUv - 0.5));
    col *= mix(0.82, 1.0, v);
    gl_FragColor = vec4(col, 1.0);
    return;
  }
  if (uMode > 0.5 && uMode < 1.5) {
    c = pow(c, vec3(0.95, 1.0, 1.08));
    c = mix(c, c * vec3(1.06, 0.98, 0.86), 0.7);
    c = (c - 0.5) * 1.06 + 0.5;
  } else if (uMode > 1.5 && uMode < 2.5) {
    float L = luma(c);
    c = vec3(pow(L, 1.05)) * vec3(1.02, 1.0, 0.97);
    c = (c - 0.5) * 1.15 + 0.5;
  } else if (uMode > 3.5) {
    c = mix(c, c * vec3(0.9, 1.0, 1.1), 0.8);
  }
  float d = length((vUv - 0.5) * vec2(uRes.x / uRes.y, 1.0));
  c *= mix(1.0, smoothstep(1.15, 0.35, d), uVignette);
  c += (hash(vUv * uRes + fract(uTime) * 100.0) - 0.5) * uGrain;
  gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}
`;
