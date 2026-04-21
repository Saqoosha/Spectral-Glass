export type PhotoTex = {
  readonly texture: GPUTexture;
  readonly sampler: GPUSampler;
  readonly width:   number;
  readonly height:  number;
};

export async function loadPhoto(device: GPUDevice, seed = Date.now()): Promise<PhotoTex> {
  const url = `https://picsum.photos/seed/${seed}/1920/1080`;
  try {
    const res = await fetch(url, { mode: 'cors' });
    if (!res.ok) throw new Error(`Photo fetch failed: ${res.status} ${res.statusText} (${url})`);
    const blob = await res.blob();
    const bitmap = await createImageBitmap(blob, { colorSpaceConversion: 'none' });
    return uploadBitmap(device, bitmap);
  } catch (err) {
    console.error('[photo] fetch/decode failed, using gradient fallback:', err);
    return createGradientTexture(device);
  }
}

function uploadBitmap(device: GPUDevice, bitmap: ImageBitmap): PhotoTex {
  const width  = bitmap.width;
  const height = bitmap.height;
  const texture = device.createTexture({
    label:  'photo',
    size:   [width, height, 1],
    format: 'rgba8unorm-srgb',
    // copyExternalImageToTexture / writeTexture both require RENDER_ATTACHMENT
    // in current Dawn/Chrome despite only sampling from the texture afterward.
    usage:  GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
  });
  device.queue.copyExternalImageToTexture({ source: bitmap }, { texture }, [width, height, 1]);
  bitmap.close();
  return { texture, sampler: sharedSampler(device), width, height };
}

// Fallback: a 256×256 vertical gradient that still exercises refraction/dispersion
// when the photo fetch fails.
function createGradientTexture(device: GPUDevice): PhotoTex {
  const W = 256;
  const H = 256;
  const bytes = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) {
    const t = y / (H - 1);
    const r = Math.round(60 + 180 * (1 - t));
    const g = Math.round(80 + 140 * Math.abs(0.5 - t) * 2);
    const b = Math.round(180 - 120 * (1 - t));
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      bytes[i + 0] = r;
      bytes[i + 1] = g;
      bytes[i + 2] = b;
      bytes[i + 3] = 255;
    }
  }
  const texture = device.createTexture({
    label:  'photo-fallback',
    size:   [W, H, 1],
    format: 'rgba8unorm-srgb',
    // copyExternalImageToTexture / writeTexture both require RENDER_ATTACHMENT
    // in current Dawn/Chrome despite only sampling from the texture afterward.
    usage:  GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
  });
  device.queue.writeTexture({ texture }, bytes, { bytesPerRow: W * 4 }, [W, H, 1]);
  return { texture, sampler: sharedSampler(device), width: W, height: H };
}

let cachedSampler: GPUSampler | null = null;
function sharedSampler(device: GPUDevice): GPUSampler {
  if (cachedSampler) return cachedSampler;
  cachedSampler = device.createSampler({
    magFilter:    'linear',
    minFilter:    'linear',
    // Strong refraction pushes sampled UVs well past [0,1]. `mirror-repeat`
    // folds the content back seamlessly — no visible tile seam (like `repeat`)
    // and no edge smear (like `clamp-to-edge`).
    addressModeU: 'mirror-repeat',
    addressModeV: 'mirror-repeat',
  });
  return cachedSampler;
}

export function destroyPhoto(p: PhotoTex): void {
  p.texture.destroy();
}
