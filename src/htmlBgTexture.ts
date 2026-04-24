import type { PhotoTex } from './photo';
import { getPhotoDisplaySampler } from './photo';

const PHOTO_FORMAT: GPUTextureFormat = 'rgba8unorm-srgb';

/** `device.queue.copyElementImageToTexture` from the HTML-in-Canvas / CanvasDrawElement trial. */
export function supportsHtmlInCanvas(device: GPUDevice): boolean {
  const q = device.queue as GPUQueue;
  return typeof q.copyElementImageToTexture === 'function';
}

/** The snapshot source must be a direct child of the WebGPU `canvas` (WICG constraint). */
export function isValidHtmlBgLayer(
  canvas: HTMLCanvasElement,
  layer: HTMLElement,
): boolean {
  return layer.parentElement === canvas;
}

export function createHtmlBackgroundTexture(
  device: GPUDevice,
  width:  number,
  height: number,
): PhotoTex {
  const w = Math.max(1, Math.floor(width));
  const h = Math.max(1, Math.floor(height));
  const texture = device.createTexture({
    label:  'html-bg',
    size:   [w, h, 1],
    // Single mip: dynamic uploads every paint — no mipmap pass.
    mipLevelCount: 1,
    format: PHOTO_FORMAT,
    // COPY_DST + RENDER_ATTACHMENT: Dawn requires both for copyElementImageToTexture
    // (same pattern as copyExternalImageToTexture / photo.ts mipmap path).
    usage:  GPUTextureUsage.TEXTURE_BINDING
      | GPUTextureUsage.COPY_DST
      | GPUTextureUsage.RENDER_ATTACHMENT,
  });
  return {
    texture,
    sampler: getPhotoDisplaySampler(device),
    width:  w,
    height: h,
  };
}

export function destroyHtmlBackgroundTexture(p: PhotoTex): void {
  p.texture.destroy();
}

/**
 * Call only from a canvas `paint` event handler (or the first copy may throw).
 * Copies the element subtree raster into the destination texture.
 *
 * Returns `true` when the copy succeeded (or was skipped because the
 * browser doesn't expose the API — no work to do). Returns `false` on
 * a genuine runtime failure; callers should count consecutive failures
 * and fall back (e.g. to the Picsum photo background) so the user isn't
 * stuck staring at a frozen snapshot indefinitely.
 */
export function copyHtmlLayerToTexture(
  queue: GPUQueue,
  layer: HTMLElement,
  dest:  GPUTexture,
): boolean {
  const copy = (queue as GPUQueue).copyElementImageToTexture;
  if (typeof copy !== 'function') return true;
  const destTagged: GPUImageCopyTextureTagged = {
    texture:            dest,
    mipLevel:           0,
    origin:             { x: 0, y: 0, z: 0 },
    // Match copyExternalImageToTexture defaults for 8-bit sRGB text/UI.
    colorSpace:         'srgb',
    premultipliedAlpha: false,
  };
  try {
    copy.call(queue, layer, destTagged);
    return true;
  } catch (err) {
    // console.error (not warn) — this is a production failure, not a hint.
    console.error('[html-bg] copyElementImageToTexture failed:', err);
    return false;
  }
}
