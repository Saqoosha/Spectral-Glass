type Vec3 = readonly [number, number, number];

const L4_VISUAL_RADIUS_SCALE = (1 - Math.SQRT1_2) / (1 - Math.SQRT1_2 ** 0.5);
const ADAPTIVE_ROUND_START = 0.65;

/**
 * Rounded box (cuboid) distance estimator. The rim uses an L4
 * superellipsoid/squircle norm instead of a circular L2 fillet, so the
 * face-to-rim curvature eases in from zero instead of jumping suddenly.
 * With equal halfSize components it's a cube; with unequal it's a rectangular
 * slab.
 *
 * Mirrored in `dispersion.wgsl`. Rotation is applied by rotating `p` BEFORE
 * calling this function (we don't store rotation per-shape).
 */
function superellipsoidLength3(x: number, y: number, z: number): number {
  const x2 = x * x;
  const y2 = y * y;
  const z2 = z * z;
  return Math.sqrt(Math.sqrt(x2 * x2 + y2 * y2 + z2 * z2));
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

function roundedLength3(x: number, y: number, z: number, blend: number): number {
  const l4 = superellipsoidLength3(x, y, z);
  const l2 = Math.hypot(x, y, z);
  return l4 + (l2 - l4) * blend;
}

export function sdfCube(p: Vec3, halfSize: Vec3, edgeR: number, smoothCurvature = true): number {
  // L4 corners cut much less than circular L2 corners at the same radius.
  // Scale the smooth radius so the 45-degree cross-section matches L2's
  // visible inset while keeping axis-aligned faces in the same place. Near the
  // maximum possible radius, blend back to L2 so thin shapes can become true
  // half-circular caps.
  const limit = Math.min(halfSize[0], halfSize[1], halfSize[2]);
  const blend = smoothCurvature ? adaptiveRoundBlend(edgeR, limit) : 1;
  const r = smoothCurvature
    ? visualRoundRadius(edgeR, limit, blend)
    : Math.min(edgeR, limit);
  const qx = Math.abs(p[0]) - halfSize[0] + r;
  const qy = Math.abs(p[1]) - halfSize[1] + r;
  const qz = Math.abs(p[2]) - halfSize[2] + r;
  const ax = Math.max(qx, 0);
  const ay = Math.max(qy, 0);
  const az = Math.max(qz, 0);
  const rim = smoothCurvature ? roundedLength3(ax, ay, az, blend) : Math.hypot(ax, ay, az);
  return rim
       + Math.min(Math.max(qx, qy, qz), 0) - r;
}
