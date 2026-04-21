const MAX_PILLS: u32 = 8u;
const MAX_N:      i32 = 64;
const HIT_EPS:    f32 = 0.25;  // hit tolerance (small — thin pills survive)
const MIN_STEP:   f32 = 0.5;   // min march step (larger — loop doesn't stall on near-zero SDF)

struct PillGpu {
  center:   vec3<f32>,
  edgeR:    f32,
  halfSize: vec3<f32>,
  _pad:     f32,
};

struct Frame {
  resolution:         vec2<f32>,
  photoSize:          vec2<f32>,
  n_d:                f32,
  V_d:                f32,
  sampleCount:        f32,
  refractionStrength: f32,
  jitter:             f32,
  refractionMode:     f32,
  pillCount:          f32,
  applySrgbOetf:      f32,  // 1.0 if canvas is non-sRGB and we must encode; 0.0 if -srgb
  shape:              f32,  // 0 = pill (stadium), 1 = prism, 2 = cube (rotates)
  time:               f32,  // seconds since start (used for cube rotation)
  _pad1:              f32,
  _pad2:              f32,
  pills:              array<PillGpu, MAX_PILLS>,
};

@group(0) @binding(0) var<uniform> frame: Frame;
@group(0) @binding(1) var photoTex: texture_2d<f32>;
@group(0) @binding(2) var photoSmp: sampler;
@group(0) @binding(3) var historyTex: texture_2d<f32>;
@group(0) @binding(4) var historySmp: sampler;

// ---------- coords ----------

fn coverUv(uv: vec2<f32>) -> vec2<f32> {
  let sA = frame.resolution.x / frame.resolution.y;
  let pA = frame.photoSize.x  / frame.photoSize.y;
  var s  = vec2<f32>(1.0);
  if (sA > pA) { s = vec2<f32>(1.0, pA / sA); } else { s = vec2<f32>(sA / pA, 1.0); }
  return (uv - vec2<f32>(0.5)) * s + vec2<f32>(0.5);
}

// World-space is top-origin pixels (matches DOM pointer coords and defaultPills).
fn screenUvFromWorld(px: vec2<f32>) -> vec2<f32> {
  return vec2<f32>(px.x / frame.resolution.x, px.y / frame.resolution.y);
}

// ---------- SDF ----------

fn sdfPill(p: vec3<f32>, halfSize: vec3<f32>, edgeR: f32) -> f32 {
  let hsXY = halfSize.xy - vec2<f32>(edgeR);
  let rXY  = min(hsXY.x, hsXY.y);
  let qXY  = abs(p.xy) - hsXY + vec2<f32>(rXY);
  let dXy  = length(max(qXY, vec2<f32>(0.0))) + min(max(qXY.x, qXY.y), 0.0) - rXY;
  let w    = vec2<f32>(dXy, abs(p.z) - halfSize.z + edgeR);
  return length(max(w, vec2<f32>(0.0))) + min(max(w.x, w.y), 0.0) - edgeR;
}

// Rounded box / cuboid. Equal halfSize = cube.
fn sdfCube(p: vec3<f32>, halfSize: vec3<f32>, edgeR: f32) -> f32 {
  let q = abs(p) - halfSize + vec3<f32>(edgeR);
  return length(max(q, vec3<f32>(0.0))) + min(max(q.x, max(q.y, q.z)), 0.0) - edgeR;
}

// Compose rotations around X and Z. Slow tumble — cube faces tip in and out
// of the viewing direction, which modulates refraction angles per frame.
fn cubeRotation(t: f32) -> mat3x3<f32> {
  let ax = t * 0.31;
  let az = t * 0.20;
  let cx = cos(ax); let sx = sin(ax);
  let cz = cos(az); let sz = sin(az);
  // WGSL mat3x3 literals fill columns. Each row of literals below is one column.
  let rx = mat3x3<f32>(
    1.0, 0.0, 0.0,
    0.0,  cx,  sx,
    0.0, -sx,  cx,
  );
  let rz = mat3x3<f32>(
     cz,  sz, 0.0,
    -sz,  cz, 0.0,
    0.0, 0.0, 1.0,
  );
  return rz * rx;
}

// Isosceles triangle in YZ (apex +Z, base -Z), extruded along X. Half-sizes
// match sdfPill: halfSize.x is extrusion length, halfSize.y the triangle base
// half-width, halfSize.z the apex height.
fn sdfPrism(p: vec3<f32>, halfSize: vec3<f32>, edgeR: f32) -> f32 {
  let hY = halfSize.y;
  let hZ = halfSize.z;
  let qy = abs(p.y);
  let qz = p.z;
  let lenInv = 1.0 / sqrt(hY * hY + 4.0 * hZ * hZ);
  let dSlant = (qy * 2.0 * hZ + (qz - hZ) * hY) * lenInv;
  let dBase  = -hZ - qz;
  let d2     = max(dSlant, dBase);

  let dX = abs(p.x) - halfSize.x;
  let w  = vec2<f32>(d2, dX);
  return length(max(w, vec2<f32>(0.0))) + min(max(w.x, w.y), 0.0) - edgeR;
}

fn sceneSdf(p: vec3<f32>) -> f32 {
  let count   = min(u32(frame.pillCount), MAX_PILLS);
  let shapeId = i32(frame.shape + 0.5);
  let rot     = cubeRotation(frame.time);  // unused unless shape==cube
  var d: f32 = 1e9;
  for (var i: u32 = 0u; i < count; i = i + 1u) {
    let pill  = frame.pills[i];
    let local = p - pill.center;
    var pd: f32;
    if (shapeId == 2) {
      pd = sdfCube(rot * local, pill.halfSize, pill.edgeR);
    } else if (shapeId == 1) {
      pd = sdfPrism(local, pill.halfSize, pill.edgeR);
    } else {
      pd = sdfPill(local, pill.halfSize, pill.edgeR);
    }
    d = min(d, pd);
  }
  return d;
}

fn sceneNormal(p: vec3<f32>) -> vec3<f32> {
  let e = vec2<f32>(HIT_EPS, 0.0);
  return normalize(vec3<f32>(
    sceneSdf(p + e.xyy) - sceneSdf(p - e.xyy),
    sceneSdf(p + e.yxy) - sceneSdf(p - e.yxy),
    sceneSdf(p + e.yyx) - sceneSdf(p - e.yyx),
  ));
}

// ---------- tracing ----------

struct Hit { ok: bool, p: vec3<f32>, t: f32 };

fn sphereTrace(ro: vec3<f32>, rd: vec3<f32>, maxT: f32) -> Hit {
  var t: f32 = 0.0;
  for (var i: i32 = 0; i < 64; i = i + 1) {
    let p = ro + rd * t;
    let d = sceneSdf(p);
    if (d < HIT_EPS) { return Hit(true, p, t); }
    t = t + max(d, MIN_STEP);
    if (t > maxT) { break; }
  }
  return Hit(false, vec3<f32>(0.0), 0.0);
}

// March from just inside the front surface until we reach the back surface.
// `ro` is the front-hit point; we skip a small entry band so the on-surface
// start pixel doesn't short-circuit at t=0.
fn insideTrace(ro: vec3<f32>, rd: vec3<f32>, maxT: f32) -> vec3<f32> {
  var t: f32 = 2.0;
  var p = ro + rd * t;
  for (var i: i32 = 0; i < 48; i = i + 1) {
    p = ro + rd * t;
    let d = -sceneSdf(p);
    if (abs(d) < HIT_EPS) { return p; }
    t = t + max(abs(d), MIN_STEP);
    if (t > maxT) { break; }
  }
  return p;
}

// ---------- spectral math ----------

// Cauchy + Abbe number (glTF KHR_materials_dispersion formulation).
// Clamped to 1.0 because ior<1 breaks Snell direction via refract().
fn cauchyIor(lambda: f32, n_d: f32, V_d: f32) -> f32 {
  return max(n_d + (n_d - 1.0) / V_d * (523655.0 / (lambda * lambda) - 1.5168), 1.0);
}

fn gLobe(lambda: f32, mu: f32, s1: f32, s2: f32) -> f32 {
  let sigma = select(s2, s1, lambda < mu);
  let t = (lambda - mu) / sigma;
  return exp(-0.5 * t * t);
}

// Wyman-Sloan-Shirley (JCGT 2013) analytic CIE 1931 2° XYZ matching functions.
fn cieXyz(lambda: f32) -> vec3<f32> {
  let x =  0.362 * gLobe(lambda, 442.0, 16.0, 26.7)
        +  1.056 * gLobe(lambda, 599.8, 37.9, 31.0)
        -  0.065 * gLobe(lambda, 501.1, 20.4, 26.2);
  let y =  0.821 * gLobe(lambda, 568.8, 46.9, 40.5)
        +  0.286 * gLobe(lambda, 530.9, 16.3, 31.1);
  let z =  1.217 * gLobe(lambda, 437.0, 11.8, 36.0)
        +  0.681 * gLobe(lambda, 459.0, 26.0, 13.8);
  return vec3<f32>(x, y, z);
}

// D65 XYZ → linear sRGB. WGSL mat3x3 is column-major, so each row of literals
// below is the column of the textbook matrix.
fn xyzToSrgb(c: vec3<f32>) -> vec3<f32> {
  let m = mat3x3<f32>(
     3.2404542, -0.9692660,  0.0556434,
    -1.5371385,  1.8760108, -0.2040259,
    -0.4985314,  0.0415560,  1.0572252,
  );
  return m * c;
}

fn schlickFresnel(cosT: f32, n_d: f32) -> f32 {
  let f0 = pow((n_d - 1.0) / (n_d + 1.0), 2.0);
  let k  = 1.0 - clamp(cosT, 0.0, 1.0);
  return f0 + (1.0 - f0) * k * k * k * k * k;
}

// sRGB OETF (linear → gamma-encoded). Applied iff `frame.applySrgbOetf == 1`,
// i.e. when the canvas format is non-sRGB (getPreferredCanvasFormat typically
// returns bgra8unorm) and the hardware won't auto-encode.
fn linearToSrgb(c: vec3<f32>) -> vec3<f32> {
  let cutoff = vec3<f32>(0.0031308);
  let low    = c * 12.92;
  let high   = 1.055 * pow(max(c, vec3<f32>(0.0)), vec3<f32>(1.0 / 2.4)) - 0.055;
  return select(high, low, c <= cutoff);
}

fn encodeDisplay(c: vec3<f32>) -> vec3<f32> {
  if (frame.applySrgbOetf > 0.5) { return linearToSrgb(c); }
  return c;
}

// ---------- fragment ----------

struct FsOut {
  @location(0) color:   vec4<f32>,
  @location(1) history: vec4<f32>,
};

@fragment
fn fs_main(@location(0) uv: vec2<f32>) -> FsOut {
  // DOM-top-origin pixel coords so they match pointer events and defaultPills.
  let px = vec2<f32>(uv.x * frame.resolution.x, uv.y * frame.resolution.y);
  let ro = vec3<f32>(px, 400.0);
  let rd = vec3<f32>(0.0, 0.0, -1.0);
  let h  = sphereTrace(ro, rd, 800.0);
  let bg = textureSampleLevel(photoTex, photoSmp, coverUv(uv), 0.0).rgb;

  if (!h.ok) {
    var bgOut: FsOut;
    bgOut.color   = vec4<f32>(encodeDisplay(bg), 1.0);
    bgOut.history = vec4<f32>(bg, 1.0);  // history lives in linear space
    return bgOut;
  }

  let nFront   = sceneNormal(h.p);
  let n_d      = frame.n_d;
  let V_d      = frame.V_d;
  let N        = clamp(i32(frame.sampleCount), 1, MAX_N);
  let strength = frame.refractionStrength;
  let jitter   = frame.jitter;
  let approx   = frame.refractionMode > 0.5;

  // Approx mode does one shared back-face trace at the central wavelength.
  var sharedExit  = h.p;
  var sharedNBack = -nFront;
  if (approx) {
    let iorMid  = cauchyIor(540.0, n_d, V_d);
    let r1mid   = refract(rd, nFront, 1.0 / iorMid);
    sharedExit  = insideTrace(h.p, r1mid, 300.0);
    sharedNBack = -sceneNormal(sharedExit);
  }

  // Pre-compute the external front-face reflection — used both by the final
  // Fresnel mix AND as a TIR fallback inside the per-wavelength loop.
  let refl     = reflect(rd, nFront);
  let reflUv   = screenUvFromWorld(h.p.xy) + refl.xy * 0.2;
  let reflSrc  = textureSampleLevel(photoTex, photoSmp, coverUv(reflUv), 0.0).rgb;

  // For each wavelength λ, weight the refracted photo sample (a linear RGB
  // triplet interpreted as a per-channel reflectance proxy) by that wavelength's
  // own sRGB primary color — xyzToSrgb(cmf(λ)). Short-wavelength samples then
  // contribute to the blue channel, long to red, producing real chromatic
  // dispersion where uv_i diverges per wavelength. On TIR at the back face we
  // fall back to the external reflection (physically: total reflection), which
  // keeps the wavelength's contribution rather than leaving a black hole.
  var rgbAccum  = vec3<f32>(0.0);
  var rgbWeight = vec3<f32>(0.0);

  for (var i: i32 = 0; i < N; i = i + 1) {
    let t      = (f32(i) + 0.5 + jitter) / f32(N);
    let lambda = mix(380.0, 700.0, t);
    let ior    = cauchyIor(lambda, n_d, V_d);
    let r1     = refract(rd, nFront, 1.0 / ior);
    if (dot(r1, r1) < 1e-4) { continue; }  // TIR on entry (vacuum→denser; shouldn't fire)

    var pExit = sharedExit;
    var nBack = sharedNBack;
    if (!approx) {
      pExit = insideTrace(h.p, r1, 300.0);
      nBack = -sceneNormal(pExit);
    }
    let r2 = refract(r1, nBack, ior);

    var L: vec3<f32>;
    if (dot(r2, r2) < 1e-4) {
      // TIR on exit — light cannot leave. Use the external reflection so this
      // wavelength's slot still participates in the spectral sum.
      L = reflSrc;
    } else {
      let uvOff = screenUvFromWorld(pExit.xy) + r2.xy * strength;
      L = textureSampleLevel(photoTex, photoSmp, coverUv(uvOff), 0.0).rgb;
    }
    let lambdaRgb = max(xyzToSrgb(cieXyz(lambda)), vec3<f32>(0.0));
    rgbAccum  = rgbAccum  + L * lambdaRgb;
    rgbWeight = rgbWeight + lambdaRgb;
  }

  // Normalize against the sum of per-wavelength sRGB weights so a flat white
  // spectrum → neutral output (independent of N).
  let rgb = max(rgbAccum / max(rgbWeight, vec3<f32>(1e-4)), vec3<f32>(0.0));

  let cosT    = max(dot(-rd, nFront), 0.0);
  let F       = schlickFresnel(cosT, n_d);
  let reflRgb = reflSrc * vec3<f32>(0.85, 0.9, 1.0);

  let outRgb = mix(rgb, reflRgb, F);

  // History is stored in rgba16float (linear). Blend in linear space; encode
  // for display only on the swapchain write.
  let prev  = textureSampleLevel(historyTex, historySmp, uv, 0.0).rgb;
  let blend = mix(prev, outRgb, 0.2);

  var o: FsOut;
  o.color   = vec4<f32>(encodeDisplay(blend), 1.0);
  o.history = vec4<f32>(blend, 1.0);
  return o;
}
