import { describe, it, expect } from 'vitest';
import { sdfCube } from '../src/math/sdfCube';

const HS  : [number, number, number] = [80, 80, 80];
const EDGE = 8;

describe('sdfCube', () => {
  it('is negative at the interior origin', () => {
    expect(sdfCube([0, 0, 0], HS, EDGE)).toBeLessThan(0);
  });

  it('is positive far outside along each axis', () => {
    expect(sdfCube([500, 0, 0], HS, EDGE)).toBeGreaterThan(0);
    expect(sdfCube([0, 500, 0], HS, EDGE)).toBeGreaterThan(0);
    expect(sdfCube([0, 0, 500], HS, EDGE)).toBeGreaterThan(0);
  });

  it('is near zero on each face (rounded box has value -edgeR + 0 at the face centroid with edgeR shrink)', () => {
    // Unrounded face position hX − edgeR + edgeR offset → distance returns 0.
    expect(sdfCube([HS[0], 0, 0], HS, EDGE)).toBeCloseTo(0, 5);
    expect(sdfCube([0, HS[1], 0], HS, EDGE)).toBeCloseTo(0, 5);
    expect(sdfCube([0, 0, HS[2]], HS, EDGE)).toBeCloseTo(0, 5);
  });

  it('is symmetric across all three planes', () => {
    const p: [number, number, number] = [30, 20, 10];
    const base = sdfCube(p, HS, EDGE);
    expect(sdfCube([-p[0],  p[1],  p[2]], HS, EDGE)).toBeCloseTo(base, 6);
    expect(sdfCube([ p[0], -p[1],  p[2]], HS, EDGE)).toBeCloseTo(base, 6);
    expect(sdfCube([ p[0],  p[1], -p[2]], HS, EDGE)).toBeCloseTo(base, 6);
  });

  it('has rounded edges: diagonal corner distance grows smoothly', () => {
    const a = sdfCube([HS[0] - EDGE,     HS[1] - EDGE,     HS[2] - EDGE],     HS, EDGE);
    const b = sdfCube([HS[0] - EDGE + 0.1, HS[1] - EDGE + 0.1, HS[2] - EDGE + 0.1], HS, EDGE);
    expect(b - a).toBeGreaterThan(0);
    // sqrt(3) * 0.1 ≈ 0.173 — matches a rounded corner.
    expect(b - a).toBeLessThan(0.3);
  });
});
