/**
 * Analytical back-exit for the diamond polytope (Phase B mirror).
 *
 * Given a ray that ALREADY entered the diamond (ro inside, rd unit length in
 * local coordinates), return the first facet on the back side it crosses on
 * the way out — as a (point, outward normal, t, facet class) tuple.
 *
 * This is the JS reference implementation. The WGSL version lives in
 * src/shaders/diamond.wgsl (`diamondAnalyticExit`) and mirrors this
 * function's ALGORITHM: facet-class enumeration order, girdle-cylinder
 * quadratic, the min-positive-t + denom gate, and the zero-normal miss
 * sentinel all match line-for-line. Numeric thresholds DIFFER by design
 * because the two impls run in different coordinate frames — WGSL runs
 * in pixel-scaled local space (offsets are multiplied by
 * `frame.diamondSize` at eval time), while this JS copy runs in
 * unit-diameter space. That's why `DIAMOND_HIT_EPS = 1e-6` here pairs
 * with `HIT_EPS = 0.25` pixels on the shader side — same "reject a t
 * value that looks like a self-hit" role, values tuned to each frame's
 * numeric precision. The vitest suite pins algorithmic behaviour so
 * drift in enumeration / quadratic / miss-sentinel surfaces as a test
 * failure; scale-dependent numerics are checked separately.
 *
 * Why analytical instead of the generic insideTrace + finite-diff normal:
 *   - The finite-difference sceneNormal(pExit) degenerates at facet edges
 *     (the gradient of `max(distances)` isn't differentiable there), which
 *     previously routed refraction at steep angles through the reflSrc TIR
 *     fallback — the "sudden other-face appearing" artifact users saw.
 *   - An analytical exit knows exactly WHICH plane was hit, so the normal
 *     is the plane's exact outward normal — no gradient estimate, no edge
 *     degeneracy.
 */
import {
  DIAMOND_BEZEL_N_ARR,
  DIAMOND_INTERNALS,
  DIAMOND_LOWER_HALF_N_ARR,
  DIAMOND_PAVILION_N_ARR,
  DIAMOND_STAR_N_ARR,
  DIAMOND_UPPER_HALF_N_ARR,
} from './diamond';

export type Vec3 = readonly [number, number, number];

/** Which of the diamond's facet classes the ray exited through. `'none'`
 *  is a sentinel used internally and returned only if NO facet was hit
 *  (caller's ro is degenerate — not inside the polytope). The shader's
 *  mirror uses a u32 enum; this string form is a TS debugging aid. */
export type DiamondFacetClass =
  | 'table'
  | 'bezel'
  | 'star'
  | 'upperHalf'
  | 'lowerHalf'
  | 'pavilion'
  | 'girdle'
  | 'none';

export type DiamondExit = {
  /** Exit point in diamond-local coordinates (ro + t·rd). */
  readonly pLocal: Vec3;
  /** Outward-facing unit normal at the exit. */
  readonly nLocal: Vec3;
  /** Ray parameter at exit. */
  readonly t: number;
  /** Which facet class the ray exited through. */
  readonly facetClass: DiamondFacetClass;
};

/** Minimum t accepted as a valid exit hit. Rejects self-intersections where
 *  the ray starts on a facet surface (common in the 2-bounce TIR chain
 *  where `ro` is the previous exit point).
 *
 *  Scale caveat: this is the UNIT-DIAMETER version of the threshold. The
 *  WGSL mirror uses the project-wide `HIT_EPS = 0.25` which lives in
 *  pixel-space (all offsets are multiplied by `frame.diamondSize` on the
 *  shader side). At `diamondSize = 200 px`, 0.25 px ≈ 1.25e-3 in
 *  unit-diameter space — 1000× this value. The two numbers are NOT
 *  numerically paired; they're each tuned to their own frame's floating-
 *  point precision, and share only the "reject t values small enough to
 *  look like a self-hit" semantics. */
export const DIAMOND_HIT_EPS = 1e-6;

// Cache the scalar constants needed for the ray-plane / ray-cylinder math.
// Offsets are rotation-invariant (see the DIAMOND_*_N_ARR comment in
// diamond.ts), so one scalar per class suffices.
const H_TOP         = DIAMOND_INTERNALS.H_TOP;
const H_GIRDLE_HALF = DIAMOND_INTERNALS.H_GIRDLE_HALF;
const R_GIRDLE      = DIAMOND_INTERNALS.R_GIRDLE;
const O_BEZEL       = DIAMOND_INTERNALS.planes.bezel.offset;
const O_STAR        = DIAMOND_INTERNALS.planes.star.offset;
const O_UPPER_HALF  = DIAMOND_INTERNALS.planes.upperHalf.offset;
const O_LOWER_HALF  = DIAMOND_INTERNALS.planes.lowerHalf.offset;
const O_PAVILION    = DIAMOND_INTERNALS.planes.pavilion.offset;

type State = { bestT: number; bestN: Vec3; bestClass: DiamondFacetClass };

/**
 * Ray-plane test over a rotated-copies array of one facet class. All planes
 * in a class share the same offset (rotation-invariant offset — see
 * diamond.ts). Updates `state` in place if a closer exit hit is found.
 *
 * Convention: outward normal points AWAY from the polytope interior, so a
 * ray "leaves" the half-space when dot(n, rd) > 0. Parallel rays
 * (dot(n, rd) ≈ 0) are skipped — they neither enter nor leave.
 */
function testPlaneClass(
  state: State,
  ro: Vec3,
  rd: Vec3,
  normals: readonly Vec3[],
  offset: number,
  facetClass: DiamondFacetClass,
): void {
  for (const n of normals) {
    const denom = n[0] * rd[0] + n[1] * rd[1] + n[2] * rd[2];
    // Skip parallel and inward-facing cases. A tiny positive denominator
    // blows t up → the min-t filter naturally rejects it, but skipping
    // early avoids floating-point edge cases.
    if (denom <= 0) continue;
    const num = offset - (n[0] * ro[0] + n[1] * ro[1] + n[2] * ro[2]);
    const t   = num / denom;
    if (t > DIAMOND_HIT_EPS && t < state.bestT) {
      state.bestT     = t;
      state.bestN     = n;
      state.bestClass = facetClass;
    }
  }
}

/**
 * Analytical back-exit: given a ray starting inside the diamond polytope,
 * returns the point at which it exits, the outward normal there, and the
 * facet class the exit belongs to.
 *
 * Algorithm (mirrored by diamond.wgsl):
 *   1. For each of the 6 plane facet classes (table, bezel×8, star×8,
 *      UH×16, LH×16, pavilion×8), solve the plane equation for t. Keep
 *      the minimum positive t.
 *   2. Test the girdle cylinder (quadratic in t) with a z-band gate.
 *   3. Return whichever hit has the smallest t.
 *
 * Caller contract: `rd` should be unit length. `ro` should be strictly
 * inside the polytope (not on a facet). HIT_EPS tolerates being slightly
 * on-surface but doesn't guarantee correctness for far-outside rays.
 */
export function diamondAnalyticExit(ro: Vec3, rd: Vec3): DiamondExit {
  // bestN starts at [0, 0, 0] (not a unit vector) so callers can detect
  // "ray missed every surface" via `facetClass === 'none'` AND a
  // zero-magnitude normal. A non-zero default would mask misses as a
  // plausible-but-wrong table hit. The shader mirror uses the same
  // convention.
  const state: State = { bestT: Infinity, bestN: [0, 0, 0], bestClass: 'none' };

  // Table cap at z = H_TOP, outward normal +Z. Hand-rolled rather than
  // passed through testPlaneClass because it's a single plane and the
  // inlined code is clearer than a 1-element array literal.
  {
    const denom = rd[2];
    if (denom > 0) {
      const t = (H_TOP - ro[2]) / denom;
      if (t > DIAMOND_HIT_EPS && t < state.bestT) {
        state.bestT     = t;
        state.bestN     = [0, 0, 1];
        state.bestClass = 'table';
      }
    }
  }

  // Crown + pavilion facet classes (5 classes × 8–16 rotated copies each).
  testPlaneClass(state, ro, rd, DIAMOND_BEZEL_N_ARR,      O_BEZEL,      'bezel');
  testPlaneClass(state, ro, rd, DIAMOND_STAR_N_ARR,       O_STAR,       'star');
  testPlaneClass(state, ro, rd, DIAMOND_UPPER_HALF_N_ARR, O_UPPER_HALF, 'upperHalf');
  testPlaneClass(state, ro, rd, DIAMOND_LOWER_HALF_N_ARR, O_LOWER_HALF, 'lowerHalf');
  testPlaneClass(state, ro, rd, DIAMOND_PAVILION_N_ARR,   O_PAVILION,   'pavilion');

  // Girdle cylinder: radius R_GIRDLE, z-band [-H_GIRDLE_HALF, +H_GIRDLE_HALF].
  // Quadratic in t: let p = ro + t·rd; solve p.x² + p.y² = R_GIRDLE².
  //   a·t² + b·t + c = 0
  //   a = |rd.xy|²     (can be 0 for a vertical ray → no cylinder hit)
  //   b = 2·(ro.xy · rd.xy)
  //   c = |ro.xy|² − R²
  // For an interior ray c < 0, so the discriminant is positive and the
  // roots straddle zero; the OUTGOING root is (-b + √disc) / (2a).
  const a = rd[0] * rd[0] + rd[1] * rd[1];
  // `a = |rd.xy|²` is dimensionless (rd is unit length), so the threshold
  // is scale-invariant — same literal here and in the WGSL mirror. 1e-6
  // matches f32's precision budget on the shader side; this JS copy uses
  // the same number so a "line-for-line" regression test can pin both
  // branches of the quadratic/no-quadratic split with one threshold.
  if (a > 1.0e-6) {
    const b = 2 * (ro[0] * rd[0] + ro[1] * rd[1]);
    const c = ro[0] * ro[0] + ro[1] * ro[1] - R_GIRDLE * R_GIRDLE;
    const disc = b * b - 4 * a * c;
    if (disc >= 0) {
      const sqrtDisc = Math.sqrt(disc);
      const t = (-b + sqrtDisc) / (2 * a);   // outgoing root
      if (t > DIAMOND_HIT_EPS && t < state.bestT) {
        const z = ro[2] + t * rd[2];
        // Only accept if the hit lands on the actual cylindrical band,
        // NOT extrapolated above/below (where crown / pavilion facets
        // take over). A tiny slack allows the crown/girdle transition
        // point to still register on either side.
        if (z >= -H_GIRDLE_HALF - DIAMOND_HIT_EPS && z <= H_GIRDLE_HALF + DIAMOND_HIT_EPS) {
          const px = ro[0] + t * rd[0];
          const py = ro[1] + t * rd[1];
          const invLen = 1 / Math.hypot(px, py);
          state.bestT     = t;
          state.bestN     = [px * invLen, py * invLen, 0];
          state.bestClass = 'girdle';
        }
      }
    }
  }

  const pLocal: Vec3 = [
    ro[0] + state.bestT * rd[0],
    ro[1] + state.bestT * rd[1],
    ro[2] + state.bestT * rd[2],
  ];
  return {
    pLocal,
    nLocal:     state.bestN,
    t:          state.bestT,
    facetClass: state.bestClass,
  };
}
