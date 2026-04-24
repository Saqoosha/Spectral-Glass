type Vec3 = readonly [number, number, number];

const L4_VISUAL_RADIUS_SCALE = (1 - Math.SQRT1_2) / (1 - Math.SQRT1_2 ** 0.5);
const ADAPTIVE_ROUND_START = 0.65;

/**
 * 3D pill distance estimator. Two-stage construction (mirrored in
 * `dispersion.wgsl`):
 *   1. A 2D rounded-rectangle/stadium silhouette in XY. This stays circular
 *      even in smooth-curvature mode so large `edgeR` values remain a true pill.
 *   2. That 2D distance extruded into Z with separately clamped rounded
 *      top/bottom corners. Z remains rounded even when the XY radius is larger
 *      than the glass thickness.
 *
 * The Z extrusion roundover can use an L4 superellipse/squircle norm. Compared
 * with a circular L2 fillet, curvature starts at zero where the flat face meets
 * the rim, which avoids a hard refraction line at the join.
 */
function superellipseLength2(x: number, y: number): number {
  const x2 = x * x;
  const y2 = y * y;
  return Math.sqrt(Math.sqrt(x2 * x2 + y2 * y2));
}

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

function adaptiveRoundBlend(edgeR: number, limit: number): number {
  if (limit <= 0) return 1;
  return smoothstep(ADAPTIVE_ROUND_START, 1, edgeR / limit);
}

function visualRoundRadius(edgeR: number, limit: number, blend: number): number {
  const scale = L4_VISUAL_RADIUS_SCALE + (1 - L4_VISUAL_RADIUS_SCALE) * blend;
  return Math.min(edgeR * scale, limit);
}

function roundedLength2(x: number, y: number, blend: number): number {
  const l4 = superellipseLength2(x, y);
  const l2 = Math.hypot(x, y);
  return l4 + (l2 - l4) * blend;
}

export function sdfPill3d(p: Vec3, halfSize: Vec3, edgeR: number, smoothCurvature = true): number {
  const xyR = Math.min(edgeR, halfSize[0], halfSize[1]);
  // XY must remain a true circular pill. Only the Z roundover gets the L4
  // visual compensation so smooth/legacy modes look like the same radius.
  // Near the thickness limit, fade the smooth rim back to L2 so it can become
  // a true half-circle.
  const zBlend = smoothCurvature ? adaptiveRoundBlend(edgeR, halfSize[2]) : 1;
  const zR = smoothCurvature
    ? visualRoundRadius(edgeR, halfSize[2], zBlend)
    : Math.min(edgeR, halfSize[2]);
  const hsX = halfSize[0] - xyR;
  const hsY = halfSize[1] - xyR;

  const qX    = Math.abs(p[0]) - hsX;
  const qY    = Math.abs(p[1]) - hsY;
  const dXy   = Math.hypot(Math.max(qX, 0), Math.max(qY, 0))
              + Math.min(Math.max(qX, qY), 0) - xyR;

  const wx = dXy + zR;
  const wy = Math.abs(p[2]) - halfSize[2] + zR;
  const roundover = smoothCurvature
    ? roundedLength2(Math.max(wx, 0), Math.max(wy, 0), zBlend)
    : Math.hypot(Math.max(wx, 0), Math.max(wy, 0));
  return roundover
       + Math.min(Math.max(wx, wy), 0) - zR;
}
