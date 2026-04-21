import { describe, it, expect } from 'vitest';
import { cameraZForFov } from '../src/math/camera';

describe('cameraZForFov', () => {
  it('returns height/2 at fov=90° (tan(45°)=1)', () => {
    expect(cameraZForFov(90, 1000)).toBeCloseTo(500, 5);
  });

  it('returns height/2 / tan(30°) at fov=60°', () => {
    // tan(30°) ≈ 0.5774 → cameraZ ≈ 866 for height=1000
    expect(cameraZForFov(60, 1000)).toBeCloseTo(866.025, 2);
  });

  it('shrinks with wider FOV (monotone decreasing)', () => {
    const a = cameraZForFov(40, 1000);
    const b = cameraZForFov(60, 1000);
    const c = cameraZForFov(90, 1000);
    const d = cameraZForFov(120, 1000);
    expect(a).toBeGreaterThan(b);
    expect(b).toBeGreaterThan(c);
    expect(c).toBeGreaterThan(d);
  });

  it('scales linearly with height', () => {
    const a = cameraZForFov(60, 1000);
    const b = cameraZForFov(60, 2000);
    expect(b).toBeCloseTo(a * 2, 5);
  });

  it('stays finite at the documented slider bounds 20-120', () => {
    const lo = cameraZForFov(20, 1000);
    const hi = cameraZForFov(120, 1000);
    expect(Number.isFinite(lo)).toBe(true);
    expect(Number.isFinite(hi)).toBe(true);
    expect(lo).toBeGreaterThan(hi);
  });
});
