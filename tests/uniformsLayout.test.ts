import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// Minimal drift detector for the host ↔ WGSL Frame uniform layout.
//
// uniforms.ts and dispersion.wgsl declare the same struct twice. WebGPU won't
// catch a host/shader mismatch — it just reads garbled bytes. Even a strict
// integration test would need a real GPU device. The compromise: pin the host
// constants here and verify the WGSL declares the matching field set in the
// matching order. If anyone reorders or adds a Frame field, at least one of
// the regex assertions below will trip and tell them to revisit uniforms.ts.

const here   = dirname(fileURLToPath(import.meta.url));
const wgsl   = readFileSync(resolve(here, '../src/shaders/dispersion.wgsl'), 'utf8');

// Pull the body of the WGSL `struct Frame { ... }` block as a single string.
const FRAME_BODY = (() => {
  const m = /struct\s+Frame\s*\{([\s\S]*?)\}/m.exec(wgsl);
  if (!m) throw new Error('Could not locate `struct Frame {...}` in dispersion.wgsl');
  return m[1] ?? '';
})();

// Extract every `<name>: <type>` declaration from the struct body and ignore
// anything that's clearly a comment line. Order matters; the host writes by
// offset so a swapped pair would silently corrupt every following field.
//
// The type string can itself contain commas (e.g. `array<PillGpu, MAX_PILLS>`)
// so we strip the trailing line-terminating comma first and only then split
// on the first `:`.
function declaredFields(body: string): { name: string; type: string }[] {
  const out: { name: string; type: string }[] = [];
  for (const raw of body.split('\n')) {
    const stripped = raw.replace(/\/\/.*$/, '').trim().replace(/,$/, '');
    if (!stripped) continue;
    const colon = stripped.indexOf(':');
    if (colon < 0) continue;
    const name = stripped.slice(0, colon).trim();
    const type = stripped.slice(colon + 1).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || !type) continue;
    out.push({ name, type });
  }
  return out;
}

describe('uniform layout drift detector', () => {
  it('Frame struct declares the fields uniforms.ts expects, in order', () => {
    const fields = declaredFields(FRAME_BODY);
    // The WGSL struct must end with `cubeRot: mat3x3<f32>` and then
    // `pills: array<PillGpu, MAX_PILLS>`. Anything else means uniforms.ts'
    // HEAD_FLOATS / CUBE_ROT_FLOATS / pillBase need to move with it.
    const names = fields.map((f) => f.name);
    expect(names).toEqual([
      'resolution', 'photoSize',
      'n_d', 'V_d', 'sampleCount', 'refractionStrength',
      'jitter', 'refractionMode', 'pillCount', 'applySrgbOetf',
      'shape', 'time', 'historyBlend', 'heroLambda',
      'cameraZ', 'projection', 'debugProxy', '_pad0',
      'cubeRot',
      'pills',
    ]);
  });

  it('cubeRot sits at the offset uniforms.ts writes via scratch.set', () => {
    // If the field order changes, the previous test fires first. This pins the
    // type so a swap to e.g. mat4x4 (which is 64 B, not 48) trips a separate
    // failure — it would otherwise pass the order test but corrupt pills.
    const fields = declaredFields(FRAME_BODY);
    const cubeRot = fields.find((f) => f.name === 'cubeRot');
    expect(cubeRot?.type).toBe('mat3x3<f32>');
  });

  it('pills is the last field (so HEAD_FLOATS+CUBE_ROT_FLOATS is the right base)', () => {
    const fields = declaredFields(FRAME_BODY);
    expect(fields[fields.length - 1]?.name).toBe('pills');
    expect(fields[fields.length - 1]?.type).toBe('array<PillGpu, MAX_PILLS>');
  });
});
