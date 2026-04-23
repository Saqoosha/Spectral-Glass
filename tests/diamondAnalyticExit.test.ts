import { describe, it, expect } from 'vitest';
import {
  diamondAnalyticExit,
  DIAMOND_HIT_EPS,
  type Vec3,
  type DiamondFacetClass,
} from '../src/math/diamondExit';
import { DIAMOND_INTERNALS } from '../src/math/diamond';

// Offset lookup keyed by facet class, used for the "exit point lies on the
// reported plane" consistency check. The runtime map is derived from
// DIAMOND_INTERNALS so a future plane-offset tweak in diamond.ts is picked
// up automatically.
const CLASS_OFFSET: Record<
  Exclude<DiamondFacetClass, 'table' | 'girdle' | 'none'>,
  number
> = {
  bezel:      DIAMOND_INTERNALS.planes.bezel.offset,
  star:       DIAMOND_INTERNALS.planes.star.offset,
  upperHalf:  DIAMOND_INTERNALS.planes.upperHalf.offset,
  lowerHalf:  DIAMOND_INTERNALS.planes.lowerHalf.offset,
  pavilion:   DIAMOND_INTERNALS.planes.pavilion.offset,
};

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function norm(v: Vec3): Vec3 {
  const len = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / len, v[1] / len, v[2] / len];
}

describe('diamondAnalyticExit', () => {
  it('axis-aligned ray down through center exits at the culet with a pavilion normal', () => {
    // Every pavilion plane is satisfied at the culet simultaneously (they
    // converge there). Any of the 8 pavilion normals is a valid return —
    // invariant asserted here: (1) exit on the culet apex, (2) pavilion
    // class, (3) outward normal has -Z component.
    const { H_BOT } = DIAMOND_INTERNALS;
    const result = diamondAnalyticExit([0, 0, 0.1], [0, 0, -1]);
    expect(result.pLocal[0]).toBeCloseTo(0, 6);
    expect(result.pLocal[1]).toBeCloseTo(0, 6);
    expect(result.pLocal[2]).toBeCloseTo(H_BOT, 6);
    expect(result.facetClass).toBe('pavilion');
    expect(result.nLocal[2]).toBeLessThan(0);
  });

  it('axis-aligned ray up through center exits through the table', () => {
    // Table cap is a single plane (no rotated copies), normal exactly (0,0,1).
    const { H_TOP } = DIAMOND_INTERNALS;
    const result = diamondAnalyticExit([0, 0, -0.1], [0, 0, 1]);
    expect(result.pLocal[0]).toBeCloseTo(0, 8);
    expect(result.pLocal[1]).toBeCloseTo(0, 8);
    expect(result.pLocal[2]).toBeCloseTo(H_TOP, 8);
    expect(result.facetClass).toBe('table');
    expect(result.nLocal[0]).toBeCloseTo(0, 10);
    expect(result.nLocal[1]).toBeCloseTo(0, 10);
    expect(result.nLocal[2]).toBeCloseTo(1, 10);
  });

  it('horizontal ray at z=0 through center exits through the girdle cylinder', () => {
    // At z=0 (mid-girdle-band) the ray leaves through the cylindrical side,
    // not a facet. Normal should be radial (no Z component).
    const { R_GIRDLE } = DIAMOND_INTERNALS;
    const result = diamondAnalyticExit([0, 0, 0], [1, 0, 0]);
    expect(result.pLocal[0]).toBeCloseTo(R_GIRDLE, 6);
    expect(result.pLocal[1]).toBeCloseTo(0, 8);
    expect(result.pLocal[2]).toBeCloseTo(0, 10);
    expect(result.facetClass).toBe('girdle');
    expect(result.nLocal[0]).toBeCloseTo(1, 6);
    expect(result.nLocal[1]).toBeCloseTo(0, 8);
    expect(result.nLocal[2]).toBeCloseTo(0, 10);
  });

  it('horizontal ray slightly above girdle exits through a crown facet (not the cylinder)', () => {
    // Above the girdle band (z > H_GIRDLE_HALF) the cylinder's z-band gate
    // rejects the hit — the ray must exit through an upper facet instead.
    // Using z = H_GIRDLE_HALF + 0.02 places it in the UH/bezel tilt region.
    const { H_GIRDLE_HALF } = DIAMOND_INTERNALS;
    const result = diamondAnalyticExit([0, 0, H_GIRDLE_HALF + 0.02], [1, 0, 0]);
    expect(result.facetClass).not.toBe('girdle');
    expect(result.facetClass).not.toBe('none');
    expect(result.nLocal[2]).toBeGreaterThan(0);  // crown-side (+Z normal)
  });

  it('horizontal ray slightly below girdle exits through a pavilion facet', () => {
    // Mirror of the above on the pavilion side.
    const { H_GIRDLE_HALF } = DIAMOND_INTERNALS;
    const result = diamondAnalyticExit([0, 0, -H_GIRDLE_HALF - 0.02], [1, 0, 0]);
    expect(result.facetClass).not.toBe('girdle');
    expect(result.facetClass).not.toBe('none');
    expect(result.nLocal[2]).toBeLessThan(0);
  });

  it('returns a unit-length outward normal for diverse rays', () => {
    const ros: Vec3[] = [
      [0, 0, 0.05], [0, 0, -0.05], [0.05, 0, 0], [0, 0.05, 0],
      [0.1, 0.1, 0.05], [-0.1, 0.05, -0.05],
    ];
    const rds: Vec3[] = [
      [0, 0, -1], [0, 0, 1], [1, 0, 0], [0, 1, 0],
      norm([1, 1, 1]),
      norm([1, -2, 0.5]),
      norm([-0.3, 0.4, -0.8]),
    ];
    for (const ro of ros) {
      for (const rd of rds) {
        const result = diamondAnalyticExit(ro, rd);
        expect(result.facetClass).not.toBe('none');
        const len = Math.hypot(...result.nLocal);
        expect(len).toBeCloseTo(1, 6);
        expect(result.t).toBeGreaterThan(0);
        expect(Number.isFinite(result.t)).toBe(true);
      }
    }
  });

  it('exit normal leaves the half-space (dot(n, rd) > 0)', () => {
    // A ray must cross the exit plane FROM inside TO outside. Translated
    // to plane-space: rd projected onto the outward normal must be
    // positive. If this fails, the ray is entering the half-space, which
    // means we picked the wrong facet (an internal plane, not the exit).
    const ro: Vec3 = [0.02, 0.01, 0.04];
    for (const rd of [
      [1, 0, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1],
      [0.5, 0.5, -0.5], [0.3, -0.2, 0.5],
    ] as Vec3[]) {
      const rdN = norm(rd);
      const result = diamondAnalyticExit(ro, rdN);
      expect(dot(result.nLocal, rdN)).toBeGreaterThan(0);
    }
  });

  it('t respects HIT_EPS threshold (no spurious near-zero self-hits)', () => {
    // Ray inside the polytope — the exit t should always clear the
    // self-hit threshold, never return a value smaller than HIT_EPS.
    const result = diamondAnalyticExit([0, 0, 0], [1, 0, 0]);
    expect(result.t).toBeGreaterThan(DIAMOND_HIT_EPS);
  });

  it('exit point satisfies the reported plane equation / cylinder equation', () => {
    // Consistency: whichever facet class won, the returned pLocal must
    // satisfy that surface's equation. Catches a bug where the facet
    // index and the exit point get out of sync (e.g. cylinder hit
    // recorded as pavilion class).
    const { R_GIRDLE, H_GIRDLE_HALF, H_TOP } = DIAMOND_INTERNALS;
    const testCases: [Vec3, Vec3][] = [
      [[0, 0, 0.1], [0, 0, -1]],
      [[0, 0, -0.1], [0, 0, 1]],
      [[0, 0, 0], [1, 0, 0]],
      [[0, 0, 0.05], norm([1, 0.5, 0.2])],
      [[0.1, 0, 0], norm([-0.3, 0.1, -0.8])],
    ];
    for (const [ro, rd] of testCases) {
      const result = diamondAnalyticExit(ro, rd);
      const p = result.pLocal;
      switch (result.facetClass) {
        case 'table':
          expect(p[2]).toBeCloseTo(H_TOP, 6);
          break;
        case 'girdle':
          expect(Math.hypot(p[0], p[1])).toBeCloseTo(R_GIRDLE, 6);
          expect(p[2]).toBeGreaterThanOrEqual(-H_GIRDLE_HALF - 1e-6);
          expect(p[2]).toBeLessThanOrEqual(H_GIRDLE_HALF + 1e-6);
          break;
        case 'bezel':
        case 'star':
        case 'upperHalf':
        case 'lowerHalf':
        case 'pavilion': {
          const expected = CLASS_OFFSET[result.facetClass];
          expect(dot(result.nLocal, p)).toBeCloseTo(expected, 6);
          break;
        }
        case 'none':
          throw new Error(`diamondAnalyticExit returned 'none' for ${JSON.stringify({ ro, rd })}`);
      }
    }
  });

  it('a vertical ray along +Z axis (|rd.xy|² = 0) still finds a hit via the table', () => {
    // Pure vertical ray: the a > 1e-6 guard in the girdle cylinder test
    // short-circuits the quadratic. Make sure the facet-plane tests still
    // catch the table.
    const result = diamondAnalyticExit([0, 0, 0], [0, 0, 1]);
    expect(result.facetClass).toBe('table');
  });

  it('off-axis ray toward the pavilion exits through a pavilion main, not the cylinder', () => {
    // Ray starting slightly off-center, pointing down-and-out: it should
    // exit through a pavilion facet (the rays responsible for the
    // diamond's diagonal sparkle), not through the girdle cylinder.
    const result = diamondAnalyticExit([0, 0, 0.05], norm([0.2, 0, -1]));
    expect(result.facetClass).toBe('pavilion');
  });

  it('ray exactly parallel to one facet plane returns the next facet, not NaN', () => {
    // Phase B spec checklist item 2.iii: "Ray parallel to a plane
    // (dot(n, rd) = 0) returns the next plane's exit, not NaN." Construct
    // a direction that is orthogonal to bezel_0's normal (so dot = 0
    // exactly) and verify the analytical exit routes to some other facet
    // with a finite t + unit normal. Catches a regression where the
    // `denom <= 0` skip turns into `denom < 0` (missing the equality case),
    // which would divide by zero and poison t with Infinity.
    const { planes } = DIAMOND_INTERNALS;
    const b0 = planes.bezel;
    // A vector in the plane orthogonal to (nx, ny, nz): take (nz, 0, -nx)
    // — this has zero dot with (nx, ny, nz) when ny = 0 (which is true for
    // bezel_0 since PHI_BEZEL = 0). Normalize for safety.
    const rdRaw: Vec3 = [b0.nz, 0, -b0.nx];
    const rd = norm(rdRaw);
    // Sanity: verify the constructed direction really is tangent.
    expect(b0.nx * rd[0] + b0.ny * rd[1] + b0.nz * rd[2]).toBeCloseTo(0, 10);

    const result = diamondAnalyticExit([0, 0, 0.05], rd);
    expect(result.facetClass).not.toBe('none');
    expect(Number.isFinite(result.t)).toBe(true);
    expect(result.t).toBeGreaterThan(0);
    // Unit-length normal, not NaN.
    expect(Math.hypot(...result.nLocal)).toBeCloseTo(1, 6);
  });

  it('ray starting exactly on a facet surface does not self-hit (bounce-origin case)', () => {
    // The 2-bounce TIR chain calls diamondAnalyticExit with `ro` on the
    // previous facet surface. The HIT_EPS guard must reject t ≈ 0 for the
    // original facet and find the genuine next-facet exit instead.
    //
    // Drive it deterministically: first exit is the girdle cylinder at
    // (R_GIRDLE, 0, 0) with outward normal (1, 0, 0). Then "reflect"
    // inward (flip the x component) and trace again — it should exit the
    // opposite side of the girdle, NOT return a self-hit.
    const { R_GIRDLE } = DIAMOND_INTERNALS;
    const ex1 = diamondAnalyticExit([0, 0, 0], [1, 0, 0]);
    expect(ex1.facetClass).toBe('girdle');
    expect(ex1.pLocal[0]).toBeCloseTo(R_GIRDLE, 6);

    // Inside-bounced direction: toward the opposite side of the girdle.
    const rdBack: Vec3 = [-1, 0, 0];
    const ex2 = diamondAnalyticExit(ex1.pLocal, rdBack);
    expect(ex2.facetClass).not.toBe('none');
    expect(ex2.t).toBeGreaterThan(DIAMOND_HIT_EPS);
    // Exit should land on the opposite girdle point (approximately).
    expect(ex2.pLocal[0]).toBeCloseTo(-R_GIRDLE, 4);
  });

});
