// Mipmap generation via fullscreen-triangle blit. Each mip level is
// rendered from the previous one using linear bilinear downsampling — the
// standard WebGPU approach since the API has no built-in `generateMipmap`
// command. Pipeline + sampler are cached per format so repeat calls (e.g.
// every photo reload) cost only the render passes.
//
// sRGB handling: when `format` is an -srgb variant, the sampler auto-decodes
// on read and the render target auto-encodes on write, so the intermediate
// linear math is correct. No manual conversion needed.

const pipelineCache = new Map<GPUTextureFormat, GPURenderPipeline>();
let cachedSampler: GPUSampler | null = null;

const MIPMAP_WGSL = /* wgsl */ `
struct Vout {
  @builtin(position) pos: vec4<f32>,
  @location(0)       uv:  vec2<f32>,
};

@vertex
fn vs(@builtin(vertex_index) i: u32) -> Vout {
  // Fullscreen triangle covering [-1,1]^2 in NDC / [0,1]^2 in UV.
  let x = f32((i << 1u) & 2u);
  let y = f32(i & 2u);
  var o: Vout;
  o.uv  = vec2<f32>(x, y);
  o.pos = vec4<f32>(x * 2.0 - 1.0, 1.0 - y * 2.0, 0.0, 1.0);
  return o;
}

@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var tex:  texture_2d<f32>;

@fragment
fn fs(v: Vout) -> @location(0) vec4<f32> {
  return textureSample(tex, samp, v.uv);
}
`;

function getPipeline(device: GPUDevice, format: GPUTextureFormat): GPURenderPipeline {
  const cached = pipelineCache.get(format);
  if (cached) return cached;
  const module = device.createShaderModule({ label: 'mipmap-blit', code: MIPMAP_WGSL });
  const pipeline = device.createRenderPipeline({
    label:     `mipmap-blit-${format}`,
    layout:    'auto',
    vertex:    { module, entryPoint: 'vs' },
    fragment:  { module, entryPoint: 'fs', targets: [{ format }] },
    primitive: { topology: 'triangle-list' },
  });
  pipelineCache.set(format, pipeline);
  return pipeline;
}

function getSampler(device: GPUDevice): GPUSampler {
  if (cachedSampler) return cachedSampler;
  cachedSampler = device.createSampler({
    label:     'mipmap-blit',
    magFilter: 'linear',
    minFilter: 'linear',
  });
  return cachedSampler;
}

export function mipLevelsFor(width: number, height: number): number {
  return Math.floor(Math.log2(Math.max(width, height))) + 1;
}

// Renders each level [1..mipLevelCount-1] by linearly downsampling from
// level-1. Texture must have TEXTURE_BINDING and RENDER_ATTACHMENT usage.
export function generateMipmaps(
  device:        GPUDevice,
  texture:       GPUTexture,
  format:        GPUTextureFormat,
  mipLevelCount: number,
): void {
  if (mipLevelCount <= 1) return;
  const pipeline = getPipeline(device, format);
  const sampler  = getSampler(device);
  const encoder  = device.createCommandEncoder({ label: 'mipmap-gen' });

  for (let level = 1; level < mipLevelCount; level++) {
    const srcView = texture.createView({ baseMipLevel: level - 1, mipLevelCount: 1 });
    const dstView = texture.createView({ baseMipLevel: level,     mipLevelCount: 1 });
    const bindGroup = device.createBindGroup({
      layout:  pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: sampler },
        { binding: 1, resource: srcView },
      ],
    });
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view:       dstView,
        loadOp:     'clear',
        storeOp:    'store',
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
      }],
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(3);
    pass.end();
  }

  device.queue.submit([encoder.finish()]);
}
