import { describe, it, expect } from 'vitest';
import { createPerf } from '../src/webgpu/perf';

class FakeBuffer {
  readonly bytes = new ArrayBuffer(16);
  mapCalls = 0;
  private resolvePending: (() => void) | null = null;

  constructor(readonly usage: number) {
    const stamps = new BigUint64Array(this.bytes);
    stamps[0] = 1_000_000n;
    stamps[1] = 4_000_000n;
  }

  mapAsync(): Promise<void> {
    this.mapCalls += 1;
    return new Promise((resolve) => { this.resolvePending = resolve; });
  }

  finishMap(): void {
    this.resolvePending?.();
    this.resolvePending = null;
  }

  getMappedRange(): ArrayBuffer {
    return this.bytes;
  }

  unmap(): void {}
}

describe('createPerf', () => {
  it('does not start a second mapAsync while the latest readback is still mapping', async () => {
    const g = globalThis as unknown as Record<string, unknown>;
    const oldUsage = g.GPUBufferUsage;
    const oldMapMode = g.GPUMapMode;
    g.GPUBufferUsage = { QUERY_RESOLVE: 1, COPY_SRC: 2, COPY_DST: 4, MAP_READ: 8 };
    g.GPUMapMode = { READ: 1 };

    try {
      const readBuffers: FakeBuffer[] = [];
      const device = {
        createQuerySet: () => ({}),
        createBuffer: (desc: { usage: number }) => {
          const b = new FakeBuffer(desc.usage);
          const usage = g.GPUBufferUsage as Record<string, number>;
          if ((desc.usage & usage.MAP_READ!) !== 0) readBuffers.push(b);
          return b;
        },
      } as unknown as GPUDevice;
      const encoder = {
        resolveQuerySet: () => {},
        copyBufferToBuffer: () => {},
      } as unknown as GPUCommandEncoder;

      const perf = createPerf(device);
      perf.resolve(encoder);

      const first = perf.readMs();
      const second = await perf.readMs();
      expect(second).toBeNull();
      expect(readBuffers[0]?.mapCalls).toBe(1);

      readBuffers[0]?.finishMap();
      await expect(first).resolves.toBe(3);
    } finally {
      if (oldUsage === undefined) delete g.GPUBufferUsage;
      else g.GPUBufferUsage = oldUsage;
      if (oldMapMode === undefined) delete g.GPUMapMode;
      else g.GPUMapMode = oldMapMode;
    }
  });
});
