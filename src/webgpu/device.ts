export type GpuContext = {
  readonly device:  GPUDevice;
  readonly canvas:  HTMLCanvasElement;
  readonly context: GPUCanvasContext;
  readonly format:  GPUTextureFormat;
  readonly dpr:     number;
};

export type InitFailure =
  | { kind: 'no-webgpu' }
  | { kind: 'no-adapter' }
  | { kind: 'no-context' };

export async function initGpu(
  canvasId: string,
  onFatal: (message: string) => void,
): Promise<GpuContext | InitFailure> {
  if (!('gpu' in navigator)) return { kind: 'no-webgpu' };
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) return { kind: 'no-adapter' };
  const device = await adapter.requestDevice();

  // Surface GPU errors we'd otherwise miss entirely — browsers auto-log uncaptured
  // validation errors to devtools but don't notify the page.
  device.addEventListener('uncapturederror', (ev) => {
    const err = (ev as GPUUncapturedErrorEvent).error;
    console.error('[webgpu] uncaptured error:', err.message);
  });
  device.lost.then((info) => {
    console.error('[webgpu] device lost:', info.reason, info.message);
    onFatal(`GPU device was lost (${info.reason}): ${info.message}. Please reload the page.`);
  });

  const canvas = document.getElementById(canvasId);
  if (!(canvas instanceof HTMLCanvasElement)) {
    throw new Error(`Canvas #${canvasId} not found`);
  }
  const context = canvas.getContext('webgpu');
  if (!context) return { kind: 'no-context' };

  const format = navigator.gpu.getPreferredCanvasFormat();
  const dpr    = Math.min(window.devicePixelRatio ?? 1, 2);
  resizeCanvas(canvas, dpr);
  context.configure({ device, format, alphaMode: 'opaque' });

  return { device, canvas, context, format, dpr };
}

export function resizeCanvas(canvas: HTMLCanvasElement, dpr: number): { width: number; height: number } {
  const width  = Math.floor(canvas.clientWidth * dpr);
  const height = Math.floor(canvas.clientHeight * dpr);
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width  = width;
    canvas.height = height;
  }
  return { width, height };
}

// True when the swapchain format doesn't auto-encode sRGB on write — we must
// apply the OETF ourselves in the fragment shader.
export function needsSrgbOetf(format: GPUTextureFormat): boolean {
  return !format.endsWith('-srgb');
}
