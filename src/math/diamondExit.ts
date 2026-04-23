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

type PlaneClassSpec = {
  readonly normals: readonly Vec3[];
  readonly offset: number;
  readonly facetClass: Exclude<DiamondFacetClass, 'table' | 'girdle' | 'none'>;
  readonly stepRad: number;
};

const OCTANT_STEP = Math.PI / 4;
const HALF_OCTANT_STEP = Math.PI / 8;
const ANGLE_EPS = 1e-6;
const POINT_INSIDE_EPS = DIAMOND_HIT_EPS * 8;

const PLANE_CLASS_SPECS: readonly PlaneClassSpec[] = [
  { normals: DIAMOND_BEZEL_N_ARR,      offset: O_BEZEL,      facetClass: 'bezel',     stepRad: OCTANT_STEP },
  { normals: DIAMOND_STAR_N_ARR,       offset: O_STAR,       facetClass: 'star',      stepRad: OCTANT_STEP },
  { normals: DIAMOND_UPPER_HALF_N_ARR, offset: O_UPPER_HALF, facetClass: 'upperHalf', stepRad: HALF_OCTANT_STEP },
  { normals: DIAMOND_LOWER_HALF_N_ARR, offset: O_LOWER_HALF, facetClass: 'lowerHalf', stepRad: HALF_OCTANT_STEP },
  { normals: DIAMOND_PAVILION_N_ARR,   offset: O_PAVILION,   facetClass: 'pavilion',  stepRad: OCTANT_STEP },
] as const;

function wrapAnglePi(angle: number): number {
  let a = (angle + Math.PI) % (2 * Math.PI);
  if (a < 0) a += 2 * Math.PI;
  return a - Math.PI;
}

function eachCandidateNormal(
  normals: readonly Vec3[],
  stepRad: number,
  rd: Vec3,
  wantsPositiveDenom: boolean,
  visit: (n: Vec3) => void,
): void {
  const rho = Math.hypot(rd[0], rd[1]);
  const normalXY = Math.hypot(normals[0]?.[0] ?? 0, normals[0]?.[1] ?? 0);
  if (rho < 1e-9 || normalXY < 1e-9) {
    for (const n of normals) visit(n);
    return;
  }

  const phiRd = Math.atan2(rd[1], rd[0]);
  const nz = normals[0]?.[2] ?? 0;
  const threshold = -(nz * rd[2]) / (normalXY * rho);
  const centerPhi = wantsPositiveDenom ? phiRd : phiRd + Math.PI;
  const k = wantsPositiveDenom ? threshold : -threshold;
  if (k >= 1) return;
  if (k <= -1) {
    for (const n of normals) visit(n);
    return;
  }

  const window = Math.acos(Math.max(-1, Math.min(1, k))) + stepRad * 0.5 + ANGLE_EPS;
  for (const n of normals) {
    const phiN = Math.atan2(n[1], n[0]);
    const delta = Math.abs(wrapAnglePi(phiN - centerPhi));
    if (delta <= window) visit(n);
  }
}

function pointInsideDiamond(p: Vec3, eps: number): boolean {
  if (p[2] > H_TOP + eps) return false;
  if (Math.hypot(p[0], p[1]) > R_GIRDLE + eps) return false;
  for (const spec of PLANE_CLASS_SPECS) {
    for (const n of spec.normals) {
      const d = n[0] * p[0] + n[1] * p[1] + n[2] * p[2] - spec.offset;
      if (d > eps) return false;
    }
  }
  return true;
}

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
  stepRad: number,
): void {
  eachCandidateNormal(normals, stepRad, rd, /* wantsPositiveDenom */ true, (n) => {
    const denom = n[0] * rd[0] + n[1] * rd[1] + n[2] * rd[2];
    // Skip parallel and inward-facing cases. A tiny positive denominator
    // blows t up → the min-t filter naturally rejects it, but skipping
    // early avoids floating-point edge cases.
    if (denom <= 0) return;
    const num = offset - (n[0] * ro[0] + n[1] * ro[1] + n[2] * ro[2]);
    const t   = num / denom;
    if (t > DIAMOND_HIT_EPS && t < state.bestT) {
      state.bestT     = t;
      state.bestN     = n;
      state.bestClass = facetClass;
    }
  });
}

function testPlaneClassHit(
  state: State,
  ro: Vec3,
  rd: Vec3,
  normals: readonly Vec3[],
  offset: number,
  facetClass: DiamondFacetClass,
  stepRad: number,
): void {
  eachCandidateNormal(normals, stepRad, rd, /* wantsPositiveDenom */ false, (n) => {
    const denom = n[0] * rd[0] + n[1] * rd[1] + n[2] * rd[2];
    if (denom >= 0) return;
    const num = offset - (n[0] * ro[0] + n[1] * ro[1] + n[2] * ro[2]);
    const t = num / denom;
    if (t <= DIAMOND_HIT_EPS || t >= state.bestT) return;
    const p: Vec3 = [
      ro[0] + t * rd[0],
      ro[1] + t * rd[1],
      ro[2] + t * rd[2],
    ];
    if (!pointInsideDiamond(p, POINT_INSIDE_EPS)) return;
    state.bestT     = t;
    state.bestN     = n;
    state.bestClass = facetClass;
  });
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
  for (const spec of PLANE_CLASS_SPECS) {
    testPlaneClass(state, ro, rd, spec.normals, spec.offset, spec.facetClass, spec.stepRad);
  }

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

/**
 * Analytical front-hit for the convex diamond surface. Mirrors the back-exit
 * path but solves the "outside -> first surface" case instead of
 * "inside -> first exit". Returns the exact outward normal of the hit facet.
 */
export function diamondAnalyticHit(ro: Vec3, rd: Vec3): DiamondExit {
  const state: State = { bestT: Infinity, bestN: [0, 0, 0], bestClass: 'none' };

  if (rd[2] < 0) {
    const t = (H_TOP - ro[2]) / rd[2];
    if (t > DIAMOND_HIT_EPS) {
      const p: Vec3 = [ro[0] + t * rd[0], ro[1] + t * rd[1], ro[2] + t * rd[2]];
      if (pointInsideDiamond(p, POINT_INSIDE_EPS)) {
        state.bestT = t;
        state.bestN = [0, 0, 1];
        state.bestClass = 'table';
      }
    }
  }

  for (const spec of PLANE_CLASS_SPECS) {
    testPlaneClassHit(state, ro, rd, spec.normals, spec.offset, spec.facetClass, spec.stepRad);
  }

  const a = rd[0] * rd[0] + rd[1] * rd[1];
  if (a > 1.0e-6) {
    const b = 2 * (ro[0] * rd[0] + ro[1] * rd[1]);
    const c = ro[0] * ro[0] + ro[1] * ro[1] - R_GIRDLE * R_GIRDLE;
    const disc = b * b - 4 * a * c;
    if (disc >= 0) {
      const sqrtDisc = Math.sqrt(disc);
      const roots = [(-b - sqrtDisc) / (2 * a), (-b + sqrtDisc) / (2 * a)];
      for (const t of roots) {
        if (t <= DIAMOND_HIT_EPS || t >= state.bestT) continue;
        const p: Vec3 = [ro[0] + t * rd[0], ro[1] + t * rd[1], ro[2] + t * rd[2]];
        if (!pointInsideDiamond(p, POINT_INSIDE_EPS)) continue;
        const invLen = 1 / Math.hypot(p[0], p[1]);
        state.bestT = t;
        state.bestN = [p[0] * invLen, p[1] * invLen, 0];
        state.bestClass = 'girdle';
        break;
      }
    }
  }

  if (state.bestClass === 'none') {
    return { pLocal: ro, nLocal: [0, 0, 0], t: Infinity, facetClass: 'none' };
  }

  return {
    pLocal: [
      ro[0] + state.bestT * rd[0],
      ro[1] + state.bestT * rd[1],
      ro[2] + state.bestT * rd[2],
    ],
    nLocal: state.bestN,
    t: state.bestT,
    facetClass: state.bestClass,
  };
}
