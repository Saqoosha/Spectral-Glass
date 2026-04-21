type Vec3 = readonly [number, number, number];

/**
 * Triangular prism SDF. Isosceles triangle cross-section in the YZ plane
 * (apex at +Z, base at -Z), extruded along X with rounded 3D edges.
 *
 * halfSize semantics match `sdfPill3d`:
 *   halfSize.x = extrusion length  (long axis of the visible top-down silhouette)
 *   halfSize.y = triangle base half-width
 *   halfSize.z = triangle apex height (top face edge)
 *
 * Designed for top-down orthographic viewing: the slanted YZ faces bend rays
 * laterally, producing the classic prism rainbow. Mirrored in
 * `dispersion.wgsl`.
 */
export function sdfPrism(p: Vec3, halfSize: Vec3, edgeR: number): number {
  const hX = halfSize[0];
  const hY = halfSize[1];
  const hZ = halfSize[2];

  const qy = Math.abs(p[1]);
  const qz = p[2];
  const lenInv = 1 / Math.hypot(hY, 2 * hZ);
  const dSlant = (qy * 2 * hZ + (qz - hZ) * hY) * lenInv;
  const dBase  = -hZ - qz;
  const d2     = Math.max(dSlant, dBase);

  const dX = Math.abs(p[0]) - hX;
  const wx = d2;
  const wy = dX;
  return Math.hypot(Math.max(wx, 0), Math.max(wy, 0))
       + Math.min(Math.max(wx, wy), 0) - edgeR;
}
