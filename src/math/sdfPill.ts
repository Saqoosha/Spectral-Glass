type Vec3 = readonly [number, number, number];

/**
 * 3D pill SDF. Two-stage construction (mirrored in `dispersion.wgsl`):
 *   1. A 2D stadium silhouette in XY (rounded box shrunk by edgeR, then rounded
 *      by the shortest shrunk half-axis → always a full stadium).
 *   2. That 2D distance extruded into Z with edgeR-rounded top/bottom corners.
 *
 * Result: stadium from the top, rounded slab from the side, smooth everywhere.
 */
export function sdfPill3d(p: Vec3, halfSize: Vec3, edgeR: number): number {
  const hsX = halfSize[0] - edgeR;
  const hsY = halfSize[1] - edgeR;
  const rXy = Math.min(hsX, hsY);

  const qX    = Math.abs(p[0]) - hsX + rXy;
  const qY    = Math.abs(p[1]) - hsY + rXy;
  const dXy   = Math.hypot(Math.max(qX, 0), Math.max(qY, 0))
              + Math.min(Math.max(qX, qY), 0) - rXy;

  const wx = dXy;
  const wy = Math.abs(p[2]) - halfSize[2] + edgeR;
  return Math.hypot(Math.max(wx, 0), Math.max(wy, 0))
       + Math.min(Math.max(wx, wy), 0) - edgeR;
}
