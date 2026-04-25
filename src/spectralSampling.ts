export const SPECTRAL_JITTER_DISABLED = -1;
export const FIXED_HERO_LAMBDA = 540;

export type SpectralSamplingFields = {
  readonly wavelengthJitter: number;
  readonly heroLambda: number;
};

export function spectralSamplingFields(
  temporalJitter: boolean,
  sampleCount: number,
  rand: () => number = Math.random,
): SpectralSamplingFields {
  if (!temporalJitter) {
    return {
      wavelengthJitter: SPECTRAL_JITTER_DISABLED,
      heroLambda:       FIXED_HERO_LAMBDA,
    };
  }

  const n = Math.max(1, sampleCount);
  return {
    wavelengthJitter: rand() / n,
    heroLambda:       380 + rand() * 320,
  };
}
