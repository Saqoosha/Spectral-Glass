/**
 * Wavelength-dependent IOR using the glTF KHR_materials_dispersion formulation:
 *   n(λ) = n_d + (n_d - 1) / V_d * (523655 / λ² − 1.5168)
 *
 * - λ in nm (visible: 380–700)
 * - n_d: refractive index at the sodium d-line (≈587.56 nm)
 * - V_d: Abbe number (lower = more dispersion)
 *
 * Reference: https://github.com/KhronosGroup/glTF/blob/main/extensions/2.0/Khronos/KHR_materials_dispersion/README.md
 */
export function cauchyIor(lambdaNm: number, n_d: number, V_d: number): number {
  const offset = (n_d - 1) / V_d * (523655 / (lambdaNm * lambdaNm) - 1.5168);
  // Clamp to vacuum; values below 1 would invert Snell direction in refract().
  return Math.max(n_d + offset, 1.0);
}
