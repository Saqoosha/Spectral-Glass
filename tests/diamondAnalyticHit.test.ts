import { describe, it, expect } from 'vitest';
import { diamondAnalyticHit, type Vec3 } from '../src/math/diamondExit';
import { DIAMOND_INTERNALS } from '../src/math/diamond';

function norm(v: Vec3): Vec3 {
  const len = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / len, v[1] / len, v[2] / len];
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

describe('diamondAnalyticHit', () => {
  it('vertical ray from above hits the table first', () => {
    const { H_TOP } = DIAMOND_INTERNALS;
    const result = diamondAnalyticHit([0, 0, H_TOP + 0.2], [0, 0, -1]);
    expect(result.facetClass).toBe('table');
    expect(result.pLocal[0]).toBeCloseTo(0, 8);
    expect(result.pLocal[1]).toBeCloseTo(0, 8);
    expect(result.pLocal[2]).toBeCloseTo(H_TOP, 8);
    expect(result.nLocal).toEqual([0, 0, 1]);
    expect(result.t).toBeGreaterThan(0);
  });

  it('horizontal ray through the girdle band hits the cylinder first', () => {
    const { R_GIRDLE } = DIAMOND_INTERNALS;
    const result = diamondAnalyticHit([-1, 0, 0], [1, 0, 0]);
    expect(result.facetClass).toBe('girdle');
    expect(result.pLocal[0]).toBeCloseTo(-R_GIRDLE, 6);
    expect(result.pLocal[1]).toBeCloseTo(0, 8);
    expect(result.pLocal[2]).toBeCloseTo(0, 8);
    expect(result.nLocal[0]).toBeCloseTo(-1, 6);
    expect(result.nLocal[1]).toBeCloseTo(0, 8);
    expect(result.nLocal[2]).toBeCloseTo(0, 8);
  });

  it('angled ray from above enters through a crown facet with an outward-facing normal', () => {
    const { H_TOP } = DIAMOND_INTERNALS;
    const ro: Vec3 = [0.28, 0.02, H_TOP + 0.25];
    const rd = norm([-0.35, 0.0, -1]);
    const result = diamondAnalyticHit(ro, rd);
    expect(result.facetClass).not.toBe('none');
    expect(result.facetClass).not.toBe('girdle');
    expect(result.nLocal[2]).toBeGreaterThan(0);
    expect(dot(result.nLocal, rd)).toBeLessThan(0);
    expect(result.t).toBeGreaterThan(0);
  });

  it('returns none for a miss ray that never intersects the diamond', () => {
    const result = diamondAnalyticHit([1.2, 1.2, 0.8], [0, 0, -1]);
    expect(result.facetClass).toBe('none');
    expect(result.t).toBe(Infinity);
  });
});
