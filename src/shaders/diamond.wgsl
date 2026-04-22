// Diamond-specific WGSL — split from dispersion.wgsl to keep the main shader
// focused on trace/SDF framework and isolate the brilliant-cut geometry work
// (Phase A's sdfDiamond + proxy mesh + pill picker, Phase B will add the
// multi-bounce TIR trace here too).
//
// Depends on:
//   - Plane / dimension constants injected by src/math/diamond.ts
//     (DIAMOND_H_TOP, DIAMOND_H_BOT, DIAMOND_R_GIRDLE, DIAMOND_R_TABLE_VERTEX,
//      DIAMOND_GIRDLE_R_CIRC, DIAMOND_{BEZEL,STAR,UPPER_HALF,LOWER_HALF,PAVILION}_{N,O})
//   - `struct Frame` and the `@group(0) @binding(0) var<uniform> frame`
//     binding from dispersion.wgsl
//   - `MAX_PILLS` from dispersion.wgsl
//
// Pipeline.ts concatenates `diamondWgslConstants()` first, then fullscreen.wgsl,
// then dispersion.wgsl, then this file — so every identifier referenced here
// is already in scope by the time WGSL's single-pass compile reaches these
// function bodies. WGSL resolves cross-function calls across the whole module,
// so `sceneSdf` → `sdfDiamond` works even though sceneSdf appears earlier.

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
// Pill picker for TAA reprojection
// -----------------------------------------------------------------------------
//
// Diamond doesn't use the analytical back-exit path (Phase A reuses the
// generic insideTrace), but the reprojection path still needs to know WHICH
// diamond instance we hit so the rotation reprojection pivots around the
// correct pill center. Without this, multi-instance scenes would reproject
// every diamond around pill[0]'s center, leaving diamonds at any other
// position with wrong motion vectors and visible ghost trails proportional
// to their on-screen distance from pill[0].
fn hitDiamondPillIdx(p: vec3<f32>) -> u32 {
  let count = min(u32(frame.pillCount), MAX_PILLS);
  var best:  u32 = 0u;
  var bestD: f32 = 1e9;
  for (var i: u32 = 0u; i < count; i = i + 1u) {
    let pill  = frame.pills[i];
    let local = p - pill.center;
    let d     = abs(sdfDiamond(local, frame.diamondSize));
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

// -----------------------------------------------------------------------------
// Proxy mesh — exact convex-hull synthesis
// -----------------------------------------------------------------------------
//
// Generates a local-space vertex for the 30-triangle (90-vertex) convex-hull
// proxy mesh given a WebGPU `vertex_index`. Triangles split into three groups:
//
//   0..5   Table fan (top octagon): 6 triangles rooted at table[0], fanning
//          out to table[t+1]/table[t+2]. Outward normal +Z.
//
//   6..21  Crown trapezoids: 8 kite-shaped bezel facets, each split into 2
//          triangles → 16 total. Connects each table edge (table[k]-
//          table[k+1]) down to the corresponding girdle edge (girdle[k]-
//          girdle[k+1]). Outward normal points radially + upward.
//
//   22..29 Pavilion cone: 8 triangles from girdle[k]-girdle[k+1] converging
//          to the culet apex at (0, 0, H_BOT). Outward normal points
//          radially + downward.
//
// Table vertices live at (R_TABLE_VERTEX, angle=π/8+k·π/4, z=H_TOP). Girdle
// vertices live at (R_CIRC, same angle, z=0), where R_CIRC is the
// CIRCUMSCRIBING octagon radius = R_GIRDLE/cos(π/8) so the girdle cylinder
// stays fully covered between vertex pairs. The ~8 % slack at the angle=π/8
// corners is the only over-coverage this proxy has.
//
// Callers (vs_proxy in dispersion.wgsl) are expected to bound-check `vi < 90`
// before calling — a larger `vi` reads off the end of the vertex tables and
// returns undefined garbage. The 90-vertex budget is enforced at the draw
// call (see src/webgpu/pipeline.ts) and by the maxVerts guard at the top of
// vs_proxy.
fn diamondProxyVertex(vi: u32, d: f32) -> vec3<f32> {
  let triIdx    = vi / 3u;        // 0..29
  let vertInTri = vi % 3u;        // 0..2

  // Both table and girdle vertex angles share `π/8 + k·π/4` so crown
  // trapezoids are planar — every trapezoid edge stays radially aligned.
  let kAngleStep = 0.7853981633974483;          // π/4
  let kAngleBias = 0.39269908169872414;         // π/8

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
    // Each trapezoid connects (table[k]-table[k+1]) to (girdle[k]-girdle[k+1]).
    // Triangle 0 (sub=0): (table[k], girdle[k], girdle[k+1])
    // Triangle 1 (sub=1): (table[k], girdle[k+1], table[k+1])
    // Winding picked so cross(edge1, edge2) points radially outward + up.
    let trapK = (triIdx - 6u) / 2u;    // 0..7
    let sub   = (triIdx - 6u) % 2u;    // 0 or 1
    let kNext = (trapK + 1u) % 8u;

    // Resolve (vertInTri, sub) → (onTable flag, k index).
    //   sub=0: [table[k], girdle[k], girdle[kNext]]
    //   sub=1: [table[k], girdle[kNext], table[kNext]]
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
    let z     = select(0.0, DIAMOND_H_TOP * d, onTable);
    return vec3<f32>(r * cos(angle), r * sin(angle), z);
  }

  // ----- Pavilion cone (8 triangles) -----
  // Each triangle: (culet, girdle[kNext], girdle[k]). Winding chosen so the
  // outward normal points radially + downward for pavilion faces.
  let k     = triIdx - 22u;       // 0..7
  let kNext = (k + 1u) % 8u;
  if (vertInTri == 0u) {
    return vec3<f32>(0.0, 0.0, DIAMOND_H_BOT * d);
  }
  let idx   = select(k, kNext, vertInTri == 1u);
  let angle = f32(idx) * kAngleStep + kAngleBias;
  let r     = DIAMOND_GIRDLE_R_CIRC * d;
  return vec3<f32>(r * cos(angle), r * sin(angle), 0.0);
}
