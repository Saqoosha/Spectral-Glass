/**
 * For a vertical full-FOV `fovDeg` (degrees) to fit exactly the canvas height
 * in the z=0 world plane, the camera must sit at this distance above z=0.
 *
 *   tan(fov/2) = (height/2) / cameraZ  →  cameraZ = (height/2) / tan(fov/2)
 */
export function cameraZForFov(fovDeg: number, heightPx: number): number {
  const fovRad = fovDeg * (Math.PI / 180);
  return (heightPx * 0.5) / Math.tan(fovRad * 0.5);
}
