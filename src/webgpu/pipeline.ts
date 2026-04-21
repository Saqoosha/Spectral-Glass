import type { GpuContext } from './device';
import type { PhotoTex } from '../photo';
import type { History } from './history';
import vsSrc from '../shaders/fullscreen.wgsl?raw';
import fsSrc from '../shaders/dispersion.wgsl?raw';

export type Pipeline = {
  readonly pipeline:   GPURenderPipeline;
  bindGroups:          [GPUBindGroup, GPUBindGroup];  // index = history read slot (1 - current)
};

export async function createPipeline(
  ctx: GpuContext,
  frameBuf: GPUBuffer,
  photo: PhotoTex,
  history: History,
): Promise<Pipeline> {
  const { device, format } = ctx;
  const module = device.createShaderModule({ label: 'dispersion', code: vsSrc + '\n' + fsSrc });

  // Surface WGSL diagnostics immediately — the default WebGPU path swallows compile
  // errors and only reports them at pipeline-creation time as opaque validation errors.
  const info = await module.getCompilationInfo();
  for (const m of info.messages) {
    const line = `[WGSL ${m.type}] line ${m.lineNum}:${m.linePos}: ${m.message}`;
    if (m.type === 'error') console.error(line);
    else if (m.type === 'warning') console.warn(line);
    else console.info(line);
  }
  if (info.messages.some((m) => m.type === 'error')) {
    throw new Error('WGSL shader compile failed — see console for diagnostics');
  }

  const pipeline = device.createRenderPipeline({
    label: 'dispersion-pipeline',
    layout: 'auto',
    vertex:   { module, entryPoint: 'vs_main' },
    fragment: {
      module,
      entryPoint: 'fs_main',
      targets: [
        { format },                 // @location(0) → swapchain
        { format: 'rgba16float' },  // @location(1) → history (linear)
      ],
    },
    primitive: { topology: 'triangle-list' },
  });

  return {
    pipeline,
    bindGroups: buildBindGroups(ctx, pipeline, frameBuf, photo, history),
  };
}

function buildBindGroups(
  ctx: GpuContext,
  pipeline: GPURenderPipeline,
  frameBuf: GPUBuffer,
  photo: PhotoTex,
  history: History,
): [GPUBindGroup, GPUBindGroup] {
  const layout = pipeline.getBindGroupLayout(0);
  const makeFor = (readIndex: 0 | 1): GPUBindGroup => ctx.device.createBindGroup({
    label: `frame-bind-${readIndex}`,
    layout,
    entries: [
      { binding: 0, resource: { buffer: frameBuf } },
      { binding: 1, resource: photo.texture.createView() },
      { binding: 2, resource: photo.sampler },
      { binding: 3, resource: history.views[readIndex] },
      { binding: 4, resource: history.sampler },
    ],
  });
  return [makeFor(0), makeFor(1)];
}

export function rebuildBindGroups(
  ctx: GpuContext,
  pl: Pipeline,
  frameBuf: GPUBuffer,
  photo: PhotoTex,
  history: History,
): void {
  pl.bindGroups = buildBindGroups(ctx, pl.pipeline, frameBuf, photo, history);
}

export function draw(ctx: GpuContext, pl: Pipeline, history: History): void {
  const readIndex: 0 | 1 = history.current === 0 ? 1 : 0;
  const writeView = history.views[history.current];
  const encoder = ctx.device.createCommandEncoder({ label: 'draw' });
  const pass = encoder.beginRenderPass({
    colorAttachments: [
      {
        view:       ctx.context.getCurrentTexture().createView(),
        loadOp:     'clear',
        storeOp:    'store',
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
      },
      {
        view:    writeView,
        loadOp:  'load',  // fragment writes every pixel; 'load' skips the clear cost
        storeOp: 'store',
      },
    ],
  });
  pass.setPipeline(pl.pipeline);
  pass.setBindGroup(0, pl.bindGroups[readIndex]);
  pass.draw(3, 1, 0, 0);
  pass.end();
  ctx.device.queue.submit([encoder.finish()]);
}
