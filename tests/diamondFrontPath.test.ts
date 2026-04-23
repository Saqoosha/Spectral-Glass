import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(__dirname, '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

describe('diamond front path (WGSL source)', () => {
  it('exports dedicated diamond front-hit helpers in diamond.wgsl', () => {
    const d = read('src/shaders/diamond.wgsl');
    expect(d).toContain('fn diamondAnalyticHit(');
    expect(d).toContain('fn diamondAnalyticHitScene(');
  });

  it('diamond fragment path uses a scene-wide front-hit so overlapping diamonds resolve nearest-first', () => {
    const f = read('src/shaders/dispersion/fragment.wgsl');
    expect(f).toContain('let front       = diamondAnalyticHitScene(ro, rd);');
    expect(f).toContain('let analyticIdx = front.pillIdx;');
  });

  it('diamond fragment path reuses the smoothed scene normal at the analytic front-hit point', () => {
    const f = read('src/shaders/dispersion/fragment.wgsl');
    expect(f).toContain('let nFront = sceneNormal(front.pWorld);');
  });

  it('pipeline routes diamond proxies to the dedicated fragment entry', () => {
    const p = read('src/webgpu/pipeline.ts');
    expect(p).toContain("fragment: { module, entryPoint: 'fs_main_diamond', targets }");
  });
});
