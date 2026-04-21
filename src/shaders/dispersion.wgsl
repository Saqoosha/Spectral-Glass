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
  historyBlend:       f32,  // 0.2 steady state, 1.0 when the scene changed this frame
  heroLambda:         f32,  // jittered each frame in [380,700]; Hero mode uses this
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
  var d: f32 = 1e9;
  for (var i: u32 = 0u; i < count; i = i + 1u) {
    let pill  = frame.pills[i];
    let local = p - pill.center;
    var pd: f32;
    if (shapeId == 2) {
      // Cube is rotated in local space before SDF evaluation. `frame.time` is
      // constant per fragment so the rotation matrix is consistent across all
      // sceneSdf calls within one pixel (sphere trace + normal finite diffs).
      pd = sdfCube(cubeRotation(frame.time) * local, pill.halfSize, pill.edgeR);
    } else if (shapeId == 1) {
      pd = sdfPrism(local, pill.halfSize, pill.edgeR);
    } else {
      pd = sdfPill(local, pill.halfSize, pill.edgeR);
    }
    d = min(d, pd);
  }
  return d;
}

// Upper bound on the internal path length a ray can take inside any pill in
// the scene. Used to cap insideTrace. For a rotated cube the diagonal (√3
// times the max half-side, doubled) is the longest possible chord; for pill
// and prism the 3D diagonal of the AABB is an upper bound too.
fn maxInternalPath() -> f32 {
  let count = min(u32(frame.pillCount), MAX_PILLS);
  var m: f32 = 0.0;
  for (var i: u32 = 0u; i < count; i = i + 1u) {
    let hs = frame.pills[i].halfSize;
    m = max(m, length(hs) * 2.0);
  }
  return max(m, 32.0);  // floor so degenerate zero-size pills don't stop march
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

// Hash a 2D input to [0,1). Dave Hoskins' hash12, small-footprint + low bias
// enough for variance reduction (we're not doing security here).
fn hash21(p: vec2<f32>) -> f32 {
  var p3 = fract(vec3<f32>(p.xyx) * 0.1031);
  p3 = p3 + vec3<f32>(dot(p3, p3.yzx + vec3<f32>(33.33)));
  return fract((p3.x + p3.y) * p3.z);
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

// ---------- proxy vertex shader ----------
//
// Draws a per-pill 2D screen-space quad instead of a fullscreen triangle.
// Only pixels covered by the quad run the heavy refraction shader. Pixels
// outside run only the cheap `fs_bg` in the preceding pass.

// 2 triangles = 6 vertices forming a unit quad in [-1, 1]^2.
const QUAD_CORNERS: array<vec2<f32>, 6> = array<vec2<f32>, 6>(
  vec2<f32>(-1.0, -1.0), vec2<f32>( 1.0, -1.0), vec2<f32>(-1.0,  1.0),
  vec2<f32>( 1.0, -1.0), vec2<f32>( 1.0,  1.0), vec2<f32>(-1.0,  1.0),
);

struct VsOutProxy {
  @builtin(position) pos: vec4<f32>,
  @location(0)       uv : vec2<f32>,
};

@vertex
fn vs_proxy(
  @builtin(vertex_index)   vi: u32,
  @builtin(instance_index) ii: u32,
) -> VsOutProxy {
  var out: VsOutProxy;
  if (ii >= u32(frame.pillCount)) {
    // Degenerate instance (over pillCount) — push off-screen so fragment skips.
    out.pos = vec4<f32>(2.0, 2.0, 0.5, 1.0);
    out.uv  = vec2<f32>(0.0);
    return out;
  }
  let pill    = frame.pills[ii];
  let shapeId = i32(frame.shape + 0.5);

  // Screen-space XY extent of the shape (tight enough to cover silhouette,
  // loose enough to be simple). Pill / prism don't rotate so halfSize.xy is
  // exact. Cube rotates — use the 3D-diagonal upper bound so any orientation
  // stays covered.
  var extent: vec2<f32>;
  if (shapeId == 2) {
    let m = max(pill.halfSize.x, max(pill.halfSize.y, pill.halfSize.z)) + pill.edgeR;
    extent = vec2<f32>(m * 1.7321);  // √3 upper bound
  } else {
    extent = pill.halfSize.xy + vec2<f32>(pill.edgeR);
  }

  let worldXY = pill.center.xy + QUAD_CORNERS[vi] * extent;
  // World pixels (top-origin) → NDC. Flip Y because DOM is top-origin but NDC
  // is bottom-origin.
  let clipX = (worldXY.x / frame.resolution.x) * 2.0 - 1.0;
  let clipY = 1.0 - (worldXY.y / frame.resolution.y) * 2.0;
  out.pos = vec4<f32>(clipX, clipY, 0.5, 1.0);
  out.uv  = worldXY / frame.resolution;
  return out;
}

// ---------- fragment ----------

struct FsOut {
  @location(0) color:   vec4<f32>,
  @location(1) history: vec4<f32>,
};

// Cheap background pass: sample photo, blend history, done. No sphere-trace,
// no refraction, no per-wavelength loop. Runs for the whole screen; the proxy
// pass then overrides covered pixels with the heavy shader's output.
@fragment
fn fs_bg(@location(0) uv: vec2<f32>) -> FsOut {
  let bg    = textureSampleLevel(photoTex, photoSmp, coverUv(uv), 0.0).rgb;
  let prev  = textureSampleLevel(historyTex, historySmp, uv, 0.0).rgb;
  let blend = mix(prev, bg, frame.historyBlend);
  var o: FsOut;
  o.color   = vec4<f32>(encodeDisplay(blend), 1.0);
  o.history = vec4<f32>(blend, 1.0);
  return o;
}

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
  let useHero  = frame.refractionMode > 0.5;

  // Cap the inside-trace at the longest possible chord through the largest
  // pill in the scene. Thick configurations would otherwise bail out mid-body.
  let internalMax = maxInternalPath();

  // Hero mode: one back-face trace at a PER-FRAME-RANDOMIZED wavelength
  // (Wilkie 2014). Unlike plain "approx" fixed at 540 nm, the randomization +
  // temporal history accumulation averages out the single-trace error across
  // ~5 frames — so 4–8 samples in Hero mode look like 16–32 samples in Exact.
  var sharedExit  = h.p;
  var sharedNBack = -nFront;
  if (useHero) {
    let iorHero = cauchyIor(frame.heroLambda, n_d, V_d);
    let r1hero  = refract(rd, nFront, 1.0 / iorHero);
    sharedExit  = insideTrace(h.p, r1hero, internalMax);
    sharedNBack = -sceneNormal(sharedExit);
  }

  // External front-face reflection — used BOTH as TIR fallback and as the
  // per-wavelength reflection color (mixed via per-λ Fresnel below).
  let refl     = reflect(rd, nFront);
  let reflUv   = screenUvFromWorld(h.p.xy) + refl.xy * 0.2;
  let reflSrc  = textureSampleLevel(photoTex, photoSmp, coverUv(reflUv), 0.0).rgb
              * vec3<f32>(0.85, 0.9, 1.0);

  // Front-face cosine (angle of incidence). Identical for every wavelength at
  // the front face, so compute once.
  let cosT = max(dot(-rd, nFront), 0.0);

  // Per-pixel stratified jitter: each pixel gets its own wavelength phase so
  // adjacent pixels sample DIFFERENT λ. The eye (and post-process history
  // accumulation) averages the spatial noise, so the rainbow looks smooth at
  // a given N — effectively 2-4× more samples worth of quality for free.
  // `jitter` (frame counter) breaks temporal coherence so history accumulates
  // new choices each frame instead of locking onto one stratum.
  let pxJit = hash21(px + vec2<f32>(jitter * 1000.0, frame.time * 37.0));

  // For each wavelength λ:
  //   1. compute per-λ IOR via Cauchy
  //   2. refract into the glass
  //   3. insideTrace to the back face (skipped in Approx mode — reuses sharedExit)
  //   4. refract out
  //   5. sample photo at the exit UV; TIR → reflection color instead
  //   6. PER-WAVELENGTH Fresnel mix between refract and reflect (blue λ has
  //      higher IOR → higher Fresnel → more reflective at rim, produces the
  //      visible blue-tinged rim we see in real prisms and diamonds)
  //   7. weight by xyzToSrgb(cmf(λ)) and accumulate
  var rgbAccum  = vec3<f32>(0.0);
  var rgbWeight = vec3<f32>(0.0);

  for (var i: i32 = 0; i < N; i = i + 1) {
    let t      = (f32(i) + 0.5 + pxJit) / f32(N);
    let lambda = mix(380.0, 700.0, t);
    let ior    = cauchyIor(lambda, n_d, V_d);
    let r1     = refract(rd, nFront, 1.0 / ior);
    if (dot(r1, r1) < 1e-4) { continue; }  // TIR on entry (shouldn't fire for vacuum→denser)

    var pExit = sharedExit;
    var nBack = sharedNBack;
    if (!useHero) {
      pExit = insideTrace(h.p, r1, internalMax);
      nBack = -sceneNormal(pExit);
    }
    let r2 = refract(r1, nBack, ior);

    var refractL: vec3<f32>;
    if (dot(r2, r2) < 1e-4) {
      refractL = reflSrc;  // exit TIR → take the external reflection
    } else {
      let uvOff = screenUvFromWorld(pExit.xy) + r2.xy * strength;
      refractL  = textureSampleLevel(photoTex, photoSmp, coverUv(uvOff), 0.0).rgb;
    }

    // Per-wavelength Schlick Fresnel: short λ (blue) has higher IOR → higher F.
    let F_lambda = schlickFresnel(cosT, ior);
    let L        = mix(refractL, reflSrc, F_lambda);

    let lambdaRgb = max(xyzToSrgb(cieXyz(lambda)), vec3<f32>(0.0));
    rgbAccum  = rgbAccum  + L * lambdaRgb;
    rgbWeight = rgbWeight + lambdaRgb;
  }

  // Normalize against the per-wavelength primary sum — keeps a flat white
  // spectrum neutral for any N.
  let outRgb = max(rgbAccum / max(rgbWeight, vec3<f32>(1e-4)), vec3<f32>(0.0));

  // History is stored in rgba16float (linear). Blend in linear space; encode
  // for display only on the swapchain write. `historyBlend` is normally 0.2 —
  // host bumps it to 1.0 for one frame on any scene change (photo reload,
  // preset click, shape switch) so the previous scene doesn't ghost in.
  let prev  = textureSampleLevel(historyTex, historySmp, uv, 0.0).rgb;
  let blend = mix(prev, outRgb, frame.historyBlend);

  var o: FsOut;
  o.color   = vec4<f32>(encodeDisplay(blend), 1.0);
  o.history = vec4<f32>(blend, 1.0);
  return o;
}
