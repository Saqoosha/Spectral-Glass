type Vec3 = readonly [number, number, number];

/**
 * Rounded box (cuboid) SDF — the classic iq formulation. With equal halfSize
 * components it's a cube; with unequal it's a rectangular slab.
 *
 * Mirrored in `dispersion.wgsl`. Rotation is applied by rotating `p` BEFORE
 * calling this function (we don't store rotation per-shape).
 */
export function sdfCube(p: Vec3, halfSize: Vec3, edgeR: number): number {
  const qx = Math.abs(p[0]) - halfSize[0] + edgeR;
  const qy = Math.abs(p[1]) - halfSize[1] + edgeR;
  const qz = Math.abs(p[2]) - halfSize[2] + edgeR;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0), Math.max(qz, 0))
       + Math.min(Math.max(qx, qy, qz), 0) - edgeR;
}
