import { describe, it, expect } from 'vitest';
import {
  FIXED_HERO_LAMBDA,
  SPECTRAL_JITTER_DISABLED,
  spectralSamplingFields,
} from '../src/spectralSampling';

describe('spectralSamplingFields', () => {
  it('uses sentinel jitter and fixed hero wavelength when temporal jitter is disabled', () => {
    const fields = spectralSamplingFields(false, 16, () => {
      throw new Error('disabled temporal jitter must not consume random numbers');
    });

    expect(fields.wavelengthJitter).toBe(SPECTRAL_JITTER_DISABLED);
    expect(fields.heroLambda).toBe(FIXED_HERO_LAMBDA);
  });

  it('uses per-frame random wavelength jitter and hero wavelength when enabled', () => {
    const draws = [0.25, 0.75];
    let i = 0;
    const fields = spectralSamplingFields(true, 16, () => draws[i++] ?? 0);

    expect(fields.wavelengthJitter).toBeCloseTo(0.25 / 16);
    expect(fields.heroLambda).toBeCloseTo(380 + 0.75 * 320);
    expect(i).toBe(2);
  });
});
