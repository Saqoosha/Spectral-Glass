// Diamond-specific WGSL — split from dispersion.wgsl to keep the main shader
// focused on trace/SDF framework and isolate the brilliant-cut geometry work
// (sdfDiamond + proxy mesh + analytic diamond intersections). Intended home for future diamond-
// only trace paths so the diamond geometry stays in one file.
//
// Depends on:
//   - Plane / dimension constants injected by src/math/diamond.ts
//     (DIAMOND_H_TOP, DIAMOND_H_BOT, DIAMOND_H_GIRDLE_HALF, DIAMOND_R_GIRDLE,
//      DIAMOND_R_TABLE_VERTEX, DIAMOND_GIRDLE_R_CIRC,
//      DIAMOND_{BEZEL,STAR,UPPER_HALF,LOWER_HALF,PAVILION}_{N,O},
//      DIAMOND_PROXY_VERT_COUNT)
//   - `struct Frame` and the `@group(0) @binding(0) var<uniform> frame`
//     binding from dispersion.wgsl
//   - `MAX_PILLS` from dispersion.wgsl
//
// See src/webgpu/pipeline.ts for the concat order — this file is last, so
// everything it references is already in scope by the time WGSL's
// single-pass compile reaches these function bodies. WGSL resolves cross-
// function calls across the whole module, so `sceneSdf` → `sdfDiamond`
// works even though sceneSdf appears earlier.

// -----------------------------------------------------------------------------
// SDF — round brilliant cut
// -----------------------------------------------------------------------------
//
// 58 facets reduced to 7 distance terms via D_8 (octagonal) symmetry folding.
// Produces a convex polytope that reads as a classic jewelry-store brilliant
// cut.
//
// Strategy:
//   1. Apply `diamondRot` (fixed tilt + Y-axis spin) to the local point.
//   2. Fold XY into the 1/16 fundamental wedge [0°, 22.5°] via three
//      reflections: abs on both components of p.xy (folds across the X
//      and Y axes → first quadrant, 4-fold), swap-if-y>x (folds across
//      the y=x line → first octant, 8-fold), and reflect across the
//      22.5° line (folds the octant's upper half onto its lower half →
//      fundamental π/8 wedge, 16-fold). Each facet class has exactly ONE
//      representative in the wedge, so evaluating its plane once gives
//      the correct distance by symmetry — no `min` over multiple rotated
//      copies.
//   3. Evaluate 7 signed-distance terms: table (+Z cap), bezel (crown
//      main), star, upper half (girdle-adjacent crown facet), girdle
//      cylinder, lower half (girdle-adjacent pavilion facet), pavilion
//      main. The pointed culet is naturally handled by the pavilion
//      planes converging at (0, 0, H_BOT) — `max()` closes the shape
//      correctly at the apex.
//   4. Return the max (intersection of half-spaces = convex polytope SDF),
//      with all offsets multiplied by `frame.diamondSize` so the runtime
//      slider scales the whole shape uniformly.
//
// Unlike cube/pill/prism this SDF has NO `edgeR` rounding — sharp facets
// are the look. Facet creases trip sceneNormal()'s degenerate-gradient
// sentinel and render as bg (thin dark seam), matching the expected
// real-diamond crease appearance.
fn sdfDiamond(pIn: vec3<f32>, diameter: f32) -> f32 {
  let p0 = frame.diamondRot * pIn;

  // 1/16 fold: abs on BOTH xy components [4-fold — folds across X and Y
  // axes], swap if y>x [8-fold — reflection across y=x], reflect across
  // θ=π/8 line [16-fold].
  var q = abs(p0.xy);
  if (q.y > q.x) { q = q.yx; }
  // π/8 ≈ 22.5°. The reflection-line normal is the vector perpendicular to
  // the π/8 line pointing into the θ>π/8 half; reflecting points with
  // dot(q, nRefl) > 0 folds them back into [0°, 22.5°].
  let nRefl = vec2<f32>(-0.3826834324, 0.9238795325);   // (-sin(π/8), cos(π/8))
  let d     = dot(q, nRefl);
  if (d > 0.0) { q = q - 2.0 * d * nRefl; }

  let p = vec3<f32>(q, p0.z);
  let r = length(q);   // radial distance — for the cylindrical girdle term

  // 7 distance terms. Offsets are in units of diameter; multiply each by
  // `diameter` so the whole shape scales with the runtime slider.
  let d_table    = p.z - DIAMOND_H_TOP * diameter;
  let d_bezel    = dot(p, DIAMOND_BEZEL_N)      - DIAMOND_BEZEL_O      * diameter;
  let d_star     = dot(p, DIAMOND_STAR_N)       - DIAMOND_STAR_O       * diameter;
  let d_uhalf    = dot(p, DIAMOND_UPPER_HALF_N) - DIAMOND_UPPER_HALF_O * diameter;
  let d_girdle   = r                            - DIAMOND_R_GIRDLE     * diameter;
  let d_lhalf    = dot(p, DIAMOND_LOWER_HALF_N) - DIAMOND_LOWER_HALF_O * diameter;
  let d_pavmain  = dot(p, DIAMOND_PAVILION_N)   - DIAMOND_PAVILION_O   * diameter;

  return max(max(max(d_table, d_bezel), max(d_star, d_uhalf)),
             max(d_girdle, max(d_lhalf, d_pavmain)));
}

// -----------------------------------------------------------------------------
// Facet-edge weight — debug overlay
// -----------------------------------------------------------------------------
//
// Returns an edge intensity in [0, 1] for a local-space surface point.
// 1.0 at facet boundaries (two plane SDFs equidistant, i.e. the point sits
// on the edge between two facets); 0.0 in facet interiors. Used by fs_main
// to draw a wireframe overlay when `frame.diamondWireframe` is on —
// useful for cross-checking that the cut geometry matches a real round
// brilliant reference.
//
// Strategy: evaluate the same 7 plane distances as sdfDiamond, find the
// MAX (= the "outer" facet at this point — the surface plane) and the
// SECOND-MAX (= the facet that would take over if you stepped outward).
// The smaller the gap, the closer to the edge between them. Smoothstep
// the gap against a pixel-scale threshold so edges render ~1 px wide at
// typical diamond sizes.
fn sdfDiamondEdgeWeight(pIn: vec3<f32>, diameter: f32) -> f32 {
  // Same fold as sdfDiamond — keep them in sync if the fold ever changes.
  let p0 = frame.diamondRot * pIn;
  var q = abs(p0.xy);
  if (q.y > q.x) { q = q.yx; }
  let nRefl = vec2<f32>(-0.3826834324, 0.9238795325);
  let d     = dot(q, nRefl);
  if (d > 0.0) { q = q - 2.0 * d * nRefl; }
  let p = vec3<f32>(q, p0.z);
  let r = length(q);

  let d_table    = p.z - DIAMOND_H_TOP * diameter;
  let d_bezel    = dot(p, DIAMOND_BEZEL_N)      - DIAMOND_BEZEL_O      * diameter;
  let d_star     = dot(p, DIAMOND_STAR_N)       - DIAMOND_STAR_O       * diameter;
  let d_uhalf    = dot(p, DIAMOND_UPPER_HALF_N) - DIAMOND_UPPER_HALF_O * diameter;
  let d_girdle   = r                            - DIAMOND_R_GIRDLE     * diameter;
  let d_lhalf    = dot(p, DIAMOND_LOWER_HALF_N) - DIAMOND_LOWER_HALF_O * diameter;
  let d_pavmain  = dot(p, DIAMOND_PAVILION_N)   - DIAMOND_PAVILION_O   * diameter;

  let maxD = max(max(max(d_table, d_bezel), max(d_star, d_uhalf)),
                 max(d_girdle, max(d_lhalf, d_pavmain)));

  // Second-max: replace any value equal to maxD with a very negative
  // sentinel, then re-max. The ">= maxD" comparison tolerates the single
  // tied value but correctly excludes only the true maximum.
  let NEG: f32 = -1e9;
  let d2_table   = select(d_table,   NEG, d_table   >= maxD);
  let d2_bezel   = select(d_bezel,   NEG, d_bezel   >= maxD);
  let d2_star    = select(d_star,    NEG, d_star    >= maxD);
  let d2_uhalf   = select(d_uhalf,   NEG, d_uhalf   >= maxD);
  let d2_girdle  = select(d_girdle,  NEG, d_girdle  >= maxD);
  let d2_lhalf   = select(d_lhalf,   NEG, d_lhalf   >= maxD);
  let d2_pavmain = select(d_pavmain, NEG, d_pavmain >= maxD);
  let secondD = max(max(max(d2_table, d2_bezel), max(d2_star, d2_uhalf)),
                    max(d2_girdle, max(d2_lhalf, d2_pavmain)));

  // Gap in world-space units (pixels since the diamond is sized in pixels).
  // 1.5 px smoothstep gives a crisp single-pixel line with soft anti-alias.
  let gap = maxD - secondD;
  return 1.0 - smoothstep(0.0, 1.5, gap);
}

// -----------------------------------------------------------------------------
// Facet-type flat-shade colour — debug fill
// -----------------------------------------------------------------------------
//
// Returns a distinct flat colour per facet class at a local-space surface
// point. Used when `frame.diamondFacetColor` is on so the user can see
// which parts of the SDF surface belong to which facet without refraction
// muddying the signal. Colours:
//   table        → red
//   bezel        → green
//   star         → blue
//   upper half   → yellow
//   girdle       → cyan
//   lower half   → magenta
//   pavilion     → orange
fn sdfDiamondFacetColor(pIn: vec3<f32>, diameter: f32) -> vec3<f32> {
  let p0 = frame.diamondRot * pIn;
  var q = abs(p0.xy);
  if (q.y > q.x) { q = q.yx; }
  let nRefl = vec2<f32>(-0.3826834324, 0.9238795325);
  let d     = dot(q, nRefl);
  if (d > 0.0) { q = q - 2.0 * d * nRefl; }
  let p = vec3<f32>(q, p0.z);
  let r = length(q);

  let d_table    = p.z - DIAMOND_H_TOP * diameter;
  let d_bezel    = dot(p, DIAMOND_BEZEL_N)      - DIAMOND_BEZEL_O      * diameter;
  let d_star     = dot(p, DIAMOND_STAR_N)       - DIAMOND_STAR_O       * diameter;
  let d_uhalf    = dot(p, DIAMOND_UPPER_HALF_N) - DIAMOND_UPPER_HALF_O * diameter;
  let d_girdle   = r                            - DIAMOND_R_GIRDLE     * diameter;
  let d_lhalf    = dot(p, DIAMOND_LOWER_HALF_N) - DIAMOND_LOWER_HALF_O * diameter;
  let d_pavmain  = dot(p, DIAMOND_PAVILION_N)   - DIAMOND_PAVILION_O   * diameter;

  let dMax = max(max(max(d_table, d_bezel), max(d_star, d_uhalf)),
                 max(d_girdle, max(d_lhalf, d_pavmain)));

  // Classify by which plane is the outermost (equal to dMax).
  if (d_table  >= dMax) { return vec3<f32>(1.0, 0.25, 0.25); }   // red    — table
  if (d_bezel  >= dMax) { return vec3<f32>(0.25, 1.0, 0.25); }   // green  — bezel
  if (d_star   >= dMax) { return vec3<f32>(0.25, 0.4, 1.0);  }   // blue   — star
  if (d_uhalf  >= dMax) { return vec3<f32>(1.0, 0.95, 0.2);  }   // yellow — upper half
  if (d_girdle >= dMax) { return vec3<f32>(0.25, 1.0, 1.0);  }   // cyan   — girdle
  if (d_lhalf  >= dMax) { return vec3<f32>(1.0, 0.3, 1.0);   }   // magenta — lower half
  return                   vec3<f32>(1.0, 0.6, 0.15);            // orange — pavilion main
}

// -----------------------------------------------------------------------------
// Proxy mesh — exact convex-hull synthesis
// -----------------------------------------------------------------------------
//
// Generates a local-space vertex for the 46-triangle (138-vertex) convex-hull
// proxy mesh given a WebGPU `vertex_index`. Triangles split into four groups:
//
//   0..5   Table fan (top octagon): 6 triangles rooted at table[0], fanning
//          out to table[t+1]/table[t+2]. Outward normal +Z.
//
//   6..21  Crown trapezoids: 8 kite-shaped bezel facets, each split into 2
//          triangles → 16 total. Connects each table edge (table[k]-
//          table[k+1]) down to the corresponding GIRDLE-TOP edge
//          (girdleTop[k]-girdleTop[k+1]) at z=+H_GIRDLE_HALF. Outward
//          normal points radially + upward.
//
//   22..37 Girdle band: 8 rectangular faces wrapping the cylindrical
//          girdle, each split into 2 triangles → 16 total. Connects
//          girdleTop[k]-girdleTop[k+1] (z=+H_GIRDLE_HALF) to
//          girdleBot[k]-girdleBot[k+1] (z=-H_GIRDLE_HALF). Outward normal
//          points radially (no vertical component). Without this ring the
//          proxy would pinch inward toward z=0 at octagon edge midpoints
//          and fail to cover the true cylindrical girdle — visible as
//          8 thin dark seams at the equator of a rendered diamond.
//
//   38..45 Pavilion cone: 8 triangles from girdleBot[k]-girdleBot[k+1]
//          converging to the culet apex at (0, 0, H_BOT). Outward normal
//          points radially + downward.
//
// Table vertices live at (R_TABLE_VERTEX, angle=π/8+k·π/4, z=H_TOP). Girdle
// vertices live at (R_CIRC, same angle, z=±H_GIRDLE_HALF), where R_CIRC is
// the CIRCUMSCRIBING octagon radius = R_GIRDLE/cos(π/8) so the girdle
// cylinder stays fully covered between vertex pairs at every z in the band.
// The ~8 % radial slack at the angle=π/8 corners is the only over-coverage
// this proxy has.
//
// Callers (vs_proxy in dispersion.wgsl) are expected to bound-check
// `vi < DIAMOND_PROXY_VERT_COUNT` (138) before calling. The vertex budget
// is enforced at the draw call (pipeline.ts) and by the maxVerts guard at
// the top of vs_proxy — both read the same DIAMOND_PROXY_VERT_COUNT
// constant injected by src/math/diamond.ts. A mesh-topology change
// touches this function here AND `DIAMOND_PROXY_TRI_COUNT` in
// src/math/diamond.ts; the draw count + maxVerts guard follow automatically.
fn diamondProxyVertex(vi: u32, d: f32) -> vec3<f32> {
  let triIdx    = vi / 3u;        // 0..45
  let vertInTri = vi % 3u;        // 0..2

  // Table vertices sit at φ = k·π/4 (= bezel / pavilion-main azimuths, see
  // src/math/diamond.ts PHI_BEZEL doc). Girdle vertices share the same
  // azimuths so each crown trapezoid + girdle-band quad stays planar.
  let kAngleStep = 0.7853981633974483;          // π/4
  let kAngleBias = 0.0;                         // vertex 0 at φ = 0 (on the +X axis)

  if (triIdx < 6u) {
    // ----- Table fan ----- verts: (table[0], table[t+1], table[t+2]).
    // Fan-triangulation of the table octagon. Outward normal = +Z.
    let tk = select(0u, triIdx + vertInTri, vertInTri > 0u);
    let angle = f32(tk) * kAngleStep + kAngleBias;
    let r = DIAMOND_R_TABLE_VERTEX * d;
    return vec3<f32>(r * cos(angle), r * sin(angle), DIAMOND_H_TOP * d);
  }

  if (triIdx < 22u) {
    // ----- Crown trapezoids (8 kites, 16 triangles) -----
    // Each trapezoid connects (table[k]-table[k+1]) at z=H_TOP to the
    // GIRDLE-TOP ring (girdleTop[k]-girdleTop[k+1]) at z=+H_GIRDLE_HALF.
    // Triangle 0 (sub=0): (table[k], girdleTop[k], girdleTop[kNext])
    // Triangle 1 (sub=1): (table[k], girdleTop[kNext], table[kNext])
    // Winding picked so cross(edge1, edge2) points radially outward + up.
    let trapK = (triIdx - 6u) / 2u;    // 0..7
    let sub   = (triIdx - 6u) % 2u;    // 0 or 1
    let kNext = (trapK + 1u) % 8u;

    // Resolve (vertInTri, sub) → (onTable flag, k index).
    //   sub=0: [table[k], girdleTop[k], girdleTop[kNext]]
    //   sub=1: [table[k], girdleTop[kNext], table[kNext]]
    var onTable: bool;
    var kIdx:    u32;
    if (sub == 0u) {
      if      (vertInTri == 0u) { onTable = true;  kIdx = trapK; }
      else if (vertInTri == 1u) { onTable = false; kIdx = trapK; }
      else                      { onTable = false; kIdx = kNext; }
    } else {
      if      (vertInTri == 0u) { onTable = true;  kIdx = trapK; }
      else if (vertInTri == 1u) { onTable = false; kIdx = kNext; }
      else                      { onTable = true;  kIdx = kNext; }
    }
    let angle = f32(kIdx) * kAngleStep + kAngleBias;
    let r     = select(DIAMOND_GIRDLE_R_CIRC, DIAMOND_R_TABLE_VERTEX, onTable) * d;
    let z     = select(DIAMOND_H_GIRDLE_HALF * d, DIAMOND_H_TOP * d, onTable);
    return vec3<f32>(r * cos(angle), r * sin(angle), z);
  }

  if (triIdx < 38u) {
    // ----- Girdle band (8 quads, 16 triangles) -----
    // Each quad wraps the cylindrical girdle between its octagon corners.
    // Triangle 0 (sub=0): (girdleTop[k], girdleBot[k], girdleBot[kNext])
    // Triangle 1 (sub=1): (girdleTop[k], girdleBot[kNext], girdleTop[kNext])
    // Winding: radial-outward normal, no vertical component (cylinder band).
    let bandK = (triIdx - 22u) / 2u;    // 0..7
    let sub   = (triIdx - 22u) % 2u;    // 0 or 1
    let kNext = (bandK + 1u) % 8u;

    // (top vs bot ring, k index).
    //   sub=0: [top[k], bot[k], bot[kNext]]
    //   sub=1: [top[k], bot[kNext], top[kNext]]
    var onTop: bool;
    var kIdx:  u32;
    if (sub == 0u) {
      if      (vertInTri == 0u) { onTop = true;  kIdx = bandK; }
      else if (vertInTri == 1u) { onTop = false; kIdx = bandK; }
      else                      { onTop = false; kIdx = kNext; }
    } else {
      if      (vertInTri == 0u) { onTop = true;  kIdx = bandK; }
      else if (vertInTri == 1u) { onTop = false; kIdx = kNext; }
      else                      { onTop = true;  kIdx = kNext; }
    }
    let angle = f32(kIdx) * kAngleStep + kAngleBias;
    let r     = DIAMOND_GIRDLE_R_CIRC * d;
    let z     = select(-DIAMOND_H_GIRDLE_HALF * d, DIAMOND_H_GIRDLE_HALF * d, onTop);
    return vec3<f32>(r * cos(angle), r * sin(angle), z);
  }

  // ----- Pavilion cone (8 triangles) -----
  // Each triangle: (culet, girdleBot[kNext], girdleBot[k]). Winding chosen so
  // the outward normal points radially + downward for pavilion faces.
  let k     = triIdx - 38u;       // 0..7
  let kNext = (k + 1u) % 8u;
  if (vertInTri == 0u) {
    return vec3<f32>(0.0, 0.0, DIAMOND_H_BOT * d);
  }
  let idx   = select(k, kNext, vertInTri == 1u);
  let angle = f32(idx) * kAngleStep + kAngleBias;
  let r     = DIAMOND_GIRDLE_R_CIRC * d;
  return vec3<f32>(r * cos(angle), r * sin(angle), -DIAMOND_H_GIRDLE_HALF * d);
}

// -----------------------------------------------------------------------------
// Analytical back-exit — Phase B
// -----------------------------------------------------------------------------
//
// Mirror of src/math/diamondExit.ts (see that file for the motivation).
// Returns a CubeExit { pWorld, nBack } where `nBack` is the INWARD normal
// (i.e. `-nOut`) matching cubeAnalyticExit / plateAnalyticExit so backExit()
// can dispatch uniformly. Any drift between this function and the JS mirror
// surfaces as a failed `tests/diamondAnalyticExit.test.ts` case — the JS
// impl is the regression pin.
//
// Algorithm:
//   1. Rotate ray into the diamond's local frame (around pill.center).
//   2. Test all 57 unfolded facet planes (1 table + 8 bezel + 8 star +
//      16 upper half + 16 lower half + 8 pavilion) and the girdle
//      cylinder. Keep the MIN positive t. The exit normal is the winning
//      facet's outward normal (exact — no finite-diff degeneracy at facet
//      edges, which was the root cause of the "other facets suddenly
//      appearing" artifact during tumble).
//   3. Rotate the exit point back to world space; return with the normal
//      negated (convention: `nBack = -nOut`).
//
// DIAMOND_BOUNCE_EPS is the facet-to-facet self-hit tolerance used here,
// NOT the project-wide sphere-tracer `HIT_EPS = 0.25 px`. The sphere
// tracer's threshold is too loose for bounce-chain exits — adjacent
// diamond facets can be within 0.1 px of each other at the default size,
// and a 0.25 px floor would silently discard legitimate nearby hits
// (e.g. upper-half→girdle second bounces that complete in ~0.08 px), so
// the min-t search would roll through to a wrong far facet. 0.01 px
// clears the floating-point noise around the previous facet's plane
// (where dot(n_prev, ro_bounce) ≈ offset_prev) while still admitting any
// real next-facet hit. The JS mirror uses `DIAMOND_HIT_EPS = 1e-6` in
// unit-diameter space (~2e-4 px at d=200), even tighter because f64 has
// the headroom; see src/math/diamondExit.ts.
const DIAMOND_BOUNCE_EPS: f32 = 0.01;
fn diamondAnalyticExit(roWorld: vec3<f32>, rdWorld: vec3<f32>, pillIdx: u32) -> CubeExit {
  let pill = frame.pills[pillIdx];
  let d    = frame.diamondSize;

  // World → local. Rotation is orthonormal, so rdL stays unit length if
  // rdWorld was. No translation for rdL (direction is translation-invariant).
  let roL = frame.diamondRot * (roWorld - pill.center);
  let rdL = frame.diamondRot * rdWorld;

  // Running min-t tracker. The initial normal is ZERO (not a unit vector)
  // so that "nothing was hit" is distinguishable at the caller: after the
  // facet/cylinder sweep, `dot(bestN, bestN) < 0.5` means the ray missed
  // every surface and the exit is a sentinel, not a real intersection.
  // This shouldn't fire for an interior ray but DOES fire in degenerate
  // bounce-chain conditions (e.g. ro on a shared vertex with rd exiting
  // through multiple coincident planes).
  //
  // How this sentinel propagates safely: the wavelength loop calls
  // `refract(bouncedR1, exN.nBack, ior)` on the returned struct. For
  // ior = n_d > 1 (glass → vacuum exit), `refract` with a zero N hits
  // the `k = 1 - eta² * (1 - dot² = 0) = 1 - ior² < 0` branch and
  // returns the zero vector. The downstream `trialDot < 1e-4` TIR gate
  // then routes into the chain's exhaustion fallback (bg or hot pink).
  // It does NOT propagate a bogus unit-normal as if a real facet had
  // been hit. A future caller that consumes `nBack` WITHOUT going
  // through refract (e.g. direct Fresnel evaluation) must add an
  // explicit `dot(nBack, nBack) > 0.5` guard.
  var bestT: f32            = 1.0e30;
  var bestN: vec3<f32>      = vec3<f32>(0.0, 0.0, 0.0);

  // ---- Table cap (+Z plane at z = H_TOP · d) ----
  if (rdL.z > 0.0) {
    let tTable = (DIAMOND_H_TOP * d - roL.z) / rdL.z;
    if (tTable > DIAMOND_BOUNCE_EPS && tTable < bestT) {
      bestT = tTable;
      bestN = vec3<f32>(0.0, 0.0, 1.0);
    }
  }

  // ---- Bezel (8) ----
  let oBezel = DIAMOND_BEZEL_O * d;
  for (var i: u32 = 0u; i < 8u; i = i + 1u) {
    let n = DIAMOND_BEZEL_N_ARR[i];
    let denom = dot(n, rdL);
    if (denom > 0.0) {
      let t = (oBezel - dot(n, roL)) / denom;
      if (t > DIAMOND_BOUNCE_EPS && t < bestT) {
        bestT = t; bestN = n;
      }
    }
  }

  // ---- Star (8) ----
  let oStar = DIAMOND_STAR_O * d;
  for (var i: u32 = 0u; i < 8u; i = i + 1u) {
    let n = DIAMOND_STAR_N_ARR[i];
    let denom = dot(n, rdL);
    if (denom > 0.0) {
      let t = (oStar - dot(n, roL)) / denom;
      if (t > DIAMOND_BOUNCE_EPS && t < bestT) {
        bestT = t; bestN = n;
      }
    }
  }

  // ---- Upper half (16) ----
  let oUhalf = DIAMOND_UPPER_HALF_O * d;
  for (var i: u32 = 0u; i < 16u; i = i + 1u) {
    let n = DIAMOND_UPPER_HALF_N_ARR[i];
    let denom = dot(n, rdL);
    if (denom > 0.0) {
      let t = (oUhalf - dot(n, roL)) / denom;
      if (t > DIAMOND_BOUNCE_EPS && t < bestT) {
        bestT = t; bestN = n;
      }
    }
  }

  // ---- Lower half (16) ----
  let oLhalf = DIAMOND_LOWER_HALF_O * d;
  for (var i: u32 = 0u; i < 16u; i = i + 1u) {
    let n = DIAMOND_LOWER_HALF_N_ARR[i];
    let denom = dot(n, rdL);
    if (denom > 0.0) {
      let t = (oLhalf - dot(n, roL)) / denom;
      if (t > DIAMOND_BOUNCE_EPS && t < bestT) {
        bestT = t; bestN = n;
      }
    }
  }

  // ---- Pavilion mains (8) ----
  let oPav = DIAMOND_PAVILION_O * d;
  for (var i: u32 = 0u; i < 8u; i = i + 1u) {
    let n = DIAMOND_PAVILION_N_ARR[i];
    let denom = dot(n, rdL);
    if (denom > 0.0) {
      let t = (oPav - dot(n, roL)) / denom;
      if (t > DIAMOND_BOUNCE_EPS && t < bestT) {
        bestT = t; bestN = n;
      }
    }
  }

  // ---- Girdle cylinder ----
  // Radius R_GIRDLE · d in the XY plane; z-band [-H_GIRDLE_HALF · d, +].
  // Interior ray ⇒ c < 0 ⇒ the OUTGOING root is (-b + √disc)/(2a). The
  // a > 1e-6 guard skips near-vertical rays (no cylinder contribution).
  let a = rdL.x * rdL.x + rdL.y * rdL.y;
  if (a > 1.0e-6) {
    let b = 2.0 * (roL.x * rdL.x + roL.y * rdL.y);
    let rG = DIAMOND_R_GIRDLE * d;
    let c  = roL.x * roL.x + roL.y * roL.y - rG * rG;
    let disc = b * b - 4.0 * a * c;
    if (disc >= 0.0) {
      let t = (-b + sqrt(disc)) / (2.0 * a);
      if (t > DIAMOND_BOUNCE_EPS && t < bestT) {
        let z  = roL.z + t * rdL.z;
        let gh = DIAMOND_H_GIRDLE_HALF * d;
        // Slack the band check by DIAMOND_BOUNCE_EPS on each side —
        // floating-point near-misses at the exact girdle/facet
        // transition should still register. Same spirit as the
        // DIAMOND_BOUNCE_EPS guard on the plane tests above.
        if (z >= -gh - DIAMOND_BOUNCE_EPS && z <= gh + DIAMOND_BOUNCE_EPS) {
          let px = roL.x + t * rdL.x;
          let py = roL.y + t * rdL.y;
          let invLen = inverseSqrt(px * px + py * py);
          bestT = t;
          bestN = vec3<f32>(px * invLen, py * invLen, 0.0);
        }
      }
    }
  }

  // Miss every facet (e.g. ro on a bad boundary, parallel/degenerate rd).
  // Do NOT build pL with bestT still at the sentinels: would poison the TIR
  // chain with an enormous `pWorld` and a bogus nBack. Zero `nBack` makes
  // `refract` fail; callers must not advance `curP` from a miss.
  if (dot(bestN, bestN) < 0.5) {
    return CubeExit(roWorld, vec3<f32>(0.0, 0.0, 0.0));
  }

  // Local exit point, then local → world (inverse rotation = transpose).
  let pL     = roL + rdL * bestT;
  let rotT   = transpose(frame.diamondRot);
  let pWorld = rotT * pL + pill.center;
  let nOut   = rotT * bestN;
  // CubeExit's `nBack` convention is the INWARD normal (same sign as
  // -sceneNormal). Caller uses it in refract() where the inside-facing
  // form is what the Snell math expects.
  return CubeExit(pWorld, -nOut);
}

struct DiamondFrontHit {
  ok:     bool,
  pWorld: vec3<f32>,
  nFront: vec3<f32>,
  pillIdx: u32,
};

struct DiamondCandidateWindow {
  mode:      i32,         // 0 = all, 1 = filtered, 2 = none
  centerDir: vec2<f32>,
  cosMin:    f32,
};

const DIAMOND_STEP_PI_4: f32 = 0.7853981633974483;
const DIAMOND_STEP_PI_8: f32 = 0.39269908169872414;

fn diamondCandidateWindow(
  rdL: vec3<f32>,
  normalXYLen: f32,
  nz: f32,
  stepRad: f32,
  wantsPositiveDenom: bool,
) -> DiamondCandidateWindow {
  let rho = length(rdL.xy);
  if (rho < 1.0e-6 || normalXYLen < 1.0e-6) {
    return DiamondCandidateWindow(0, vec2<f32>(1.0, 0.0), -1.0);
  }

  let threshold = -(nz * rdL.z) / (normalXYLen * rho);
  let k         = select(-threshold, threshold, wantsPositiveDenom);
  if (k >= 1.0) {
    return DiamondCandidateWindow(2, vec2<f32>(1.0, 0.0), 2.0);
  }
  if (k <= -1.0) {
    return DiamondCandidateWindow(0, vec2<f32>(1.0, 0.0), -1.0);
  }

  let dir       = rdL.xy / rho;
  let centerDir = select(-dir, dir, wantsPositiveDenom);
  let cosMin    = cos(acos(clamp(k, -1.0, 1.0)) + stepRad * 0.5 + 1.0e-3);
  return DiamondCandidateWindow(1, centerDir, cosMin);
}

fn diamondWindowAccept(n: vec3<f32>, window: DiamondCandidateWindow) -> bool {
  if (window.mode == 0) { return true; }
  if (window.mode == 2) { return false; }
  let nxyLen2 = max(dot(n.xy, n.xy), 1.0e-8);
  let nxyDir  = n.xy * inverseSqrt(nxyLen2);
  return dot(nxyDir, window.centerDir) >= window.cosMin;
}

fn pointInsideDiamondLocal(p: vec3<f32>, d: f32, eps: f32) -> bool {
  if (p.z > DIAMOND_H_TOP * d + eps) { return false; }
  if (length(p.xy) > DIAMOND_R_GIRDLE * d + eps) { return false; }

  let oBezel = DIAMOND_BEZEL_O * d;
  for (var i: u32 = 0u; i < 8u; i = i + 1u) {
    let n = DIAMOND_BEZEL_N_ARR[i];
    if (dot(n, p) - oBezel > eps) { return false; }
  }

  let oStar = DIAMOND_STAR_O * d;
  for (var i: u32 = 0u; i < 8u; i = i + 1u) {
    let n = DIAMOND_STAR_N_ARR[i];
    if (dot(n, p) - oStar > eps) { return false; }
  }

  let oUhalf = DIAMOND_UPPER_HALF_O * d;
  for (var i: u32 = 0u; i < 16u; i = i + 1u) {
    let n = DIAMOND_UPPER_HALF_N_ARR[i];
    if (dot(n, p) - oUhalf > eps) { return false; }
  }

  let oLhalf = DIAMOND_LOWER_HALF_O * d;
  for (var i: u32 = 0u; i < 16u; i = i + 1u) {
    let n = DIAMOND_LOWER_HALF_N_ARR[i];
    if (dot(n, p) - oLhalf > eps) { return false; }
  }

  let oPav = DIAMOND_PAVILION_O * d;
  for (var i: u32 = 0u; i < 8u; i = i + 1u) {
    let n = DIAMOND_PAVILION_N_ARR[i];
    if (dot(n, p) - oPav > eps) { return false; }
  }

  return true;
}

fn diamondAnalyticHit(roWorld: vec3<f32>, rdWorld: vec3<f32>, pillIdx: u32) -> DiamondFrontHit {
  let pill = frame.pills[pillIdx];
  let d    = frame.diamondSize;
  let roL  = frame.diamondRot * (roWorld - pill.center);
  let rdL  = frame.diamondRot * rdWorld;

  var bestT: f32       = 1.0e30;
  var bestN: vec3<f32> = vec3<f32>(0.0);

  if (rdL.z < 0.0) {
    let tTable = (DIAMOND_H_TOP * d - roL.z) / rdL.z;
    if (tTable > DIAMOND_BOUNCE_EPS && tTable < bestT) {
      let pL = roL + rdL * tTable;
      if (pointInsideDiamondLocal(pL, d, HIT_EPS)) {
        bestT = tTable;
        bestN = vec3<f32>(0.0, 0.0, 1.0);
      }
    }
  }

  let bezelWindow = diamondCandidateWindow(
    rdL,
    length(DIAMOND_BEZEL_N_ARR[0].xy),
    DIAMOND_BEZEL_N_ARR[0].z,
    DIAMOND_STEP_PI_4,
    false,
  );
  let oBezel = DIAMOND_BEZEL_O * d;
  for (var i: u32 = 0u; i < 8u; i = i + 1u) {
    let n = DIAMOND_BEZEL_N_ARR[i];
    if (!diamondWindowAccept(n, bezelWindow)) { continue; }
    let denom = dot(n, rdL);
    if (denom >= 0.0) { continue; }
    let t = (oBezel - dot(n, roL)) / denom;
    if (t > DIAMOND_BOUNCE_EPS && t < bestT) {
      let pL = roL + rdL * t;
      if (pointInsideDiamondLocal(pL, d, HIT_EPS)) {
        bestT = t;
        bestN = n;
      }
    }
  }

  let starWindow = diamondCandidateWindow(
    rdL,
    length(DIAMOND_STAR_N_ARR[0].xy),
    DIAMOND_STAR_N_ARR[0].z,
    DIAMOND_STEP_PI_4,
    false,
  );
  let oStar = DIAMOND_STAR_O * d;
  for (var i: u32 = 0u; i < 8u; i = i + 1u) {
    let n = DIAMOND_STAR_N_ARR[i];
    if (!diamondWindowAccept(n, starWindow)) { continue; }
    let denom = dot(n, rdL);
    if (denom >= 0.0) { continue; }
    let t = (oStar - dot(n, roL)) / denom;
    if (t > DIAMOND_BOUNCE_EPS && t < bestT) {
      let pL = roL + rdL * t;
      if (pointInsideDiamondLocal(pL, d, HIT_EPS)) {
        bestT = t;
        bestN = n;
      }
    }
  }

  let uhalfWindow = diamondCandidateWindow(
    rdL,
    length(DIAMOND_UPPER_HALF_N_ARR[0].xy),
    DIAMOND_UPPER_HALF_N_ARR[0].z,
    DIAMOND_STEP_PI_8,
    false,
  );
  let oUhalf = DIAMOND_UPPER_HALF_O * d;
  for (var i: u32 = 0u; i < 16u; i = i + 1u) {
    let n = DIAMOND_UPPER_HALF_N_ARR[i];
    if (!diamondWindowAccept(n, uhalfWindow)) { continue; }
    let denom = dot(n, rdL);
    if (denom >= 0.0) { continue; }
    let t = (oUhalf - dot(n, roL)) / denom;
    if (t > DIAMOND_BOUNCE_EPS && t < bestT) {
      let pL = roL + rdL * t;
      if (pointInsideDiamondLocal(pL, d, HIT_EPS)) {
        bestT = t;
        bestN = n;
      }
    }
  }

  let lhalfWindow = diamondCandidateWindow(
    rdL,
    length(DIAMOND_LOWER_HALF_N_ARR[0].xy),
    DIAMOND_LOWER_HALF_N_ARR[0].z,
    DIAMOND_STEP_PI_8,
    false,
  );
  let oLhalf = DIAMOND_LOWER_HALF_O * d;
  for (var i: u32 = 0u; i < 16u; i = i + 1u) {
    let n = DIAMOND_LOWER_HALF_N_ARR[i];
    if (!diamondWindowAccept(n, lhalfWindow)) { continue; }
    let denom = dot(n, rdL);
    if (denom >= 0.0) { continue; }
    let t = (oLhalf - dot(n, roL)) / denom;
    if (t > DIAMOND_BOUNCE_EPS && t < bestT) {
      let pL = roL + rdL * t;
      if (pointInsideDiamondLocal(pL, d, HIT_EPS)) {
        bestT = t;
        bestN = n;
      }
    }
  }

  let pavWindow = diamondCandidateWindow(
    rdL,
    length(DIAMOND_PAVILION_N_ARR[0].xy),
    DIAMOND_PAVILION_N_ARR[0].z,
    DIAMOND_STEP_PI_4,
    false,
  );
  let oPav = DIAMOND_PAVILION_O * d;
  for (var i: u32 = 0u; i < 8u; i = i + 1u) {
    let n = DIAMOND_PAVILION_N_ARR[i];
    if (!diamondWindowAccept(n, pavWindow)) { continue; }
    let denom = dot(n, rdL);
    if (denom >= 0.0) { continue; }
    let t = (oPav - dot(n, roL)) / denom;
    if (t > DIAMOND_BOUNCE_EPS && t < bestT) {
      let pL = roL + rdL * t;
      if (pointInsideDiamondLocal(pL, d, HIT_EPS)) {
        bestT = t;
        bestN = n;
      }
    }
  }

  let a = rdL.x * rdL.x + rdL.y * rdL.y;
  if (a > 1.0e-6) {
    let b = 2.0 * (roL.x * rdL.x + roL.y * rdL.y);
    let rG = DIAMOND_R_GIRDLE * d;
    let c  = roL.x * roL.x + roL.y * roL.y - rG * rG;
    let disc = b * b - 4.0 * a * c;
    if (disc >= 0.0) {
      let sqrtDisc = sqrt(disc);
      let t0 = (-b - sqrtDisc) / (2.0 * a);
      let t1 = (-b + sqrtDisc) / (2.0 * a);
      for (var rootIdx: u32 = 0u; rootIdx < 2u; rootIdx = rootIdx + 1u) {
        let t = select(t1, t0, rootIdx == 0u);
        if (t > DIAMOND_BOUNCE_EPS && t < bestT) {
          let pL = roL + rdL * t;
          if (pointInsideDiamondLocal(pL, d, HIT_EPS)) {
            let invLen = inverseSqrt(max(dot(pL.xy, pL.xy), 1.0e-8));
            bestT = t;
            bestN = vec3<f32>(pL.x * invLen, pL.y * invLen, 0.0);
          }
        }
      }
    }
  }

  if (dot(bestN, bestN) < 0.5) {
    return DiamondFrontHit(false, roWorld, vec3<f32>(0.0), pillIdx);
  }

  let pL     = roL + rdL * bestT;
  let rotT   = transpose(frame.diamondRot);
  let pWorld = rotT * pL + pill.center;
  let nWorld = rotT * bestN;
  return DiamondFrontHit(true, pWorld, nWorld, pillIdx);
}

fn diamondAnalyticHitScene(roWorld: vec3<f32>, rdWorld: vec3<f32>) -> DiamondFrontHit {
  var bestT   = 1.0e30;
  var bestHit = DiamondFrontHit(false, roWorld, vec3<f32>(0.0), 0u);
  for (var pillIdx: u32 = 0u; pillIdx < u32(frame.pillCount); pillIdx = pillIdx + 1u) {
    let hit = diamondAnalyticHit(roWorld, rdWorld, pillIdx);
    if (!hit.ok) { continue; }
    let t = dot(hit.pWorld - roWorld, rdWorld);
    if (t > DIAMOND_BOUNCE_EPS && t < bestT) {
      bestT   = t;
      bestHit = hit;
    }
  }
  return bestHit;
}
