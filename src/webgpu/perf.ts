// GPU timestamp-query harness. Captures start/end timestamps around the draw
// pass via `timestampWrites`, resolves to a staging buffer, and maps a separate
// readback buffer on demand. `record()` uses a double-buffered ping-pong so the
// CPU can read frame N-1 while frame N is still in flight.
//
// The timestamp period is reported by the spec as "nanoseconds per tick" on
// most implementations; we convert to milliseconds on read.

export type Perf = {
  readonly querySet: GPUQuerySet;
  readonly writes:   GPURenderPassTimestampWrites;
  /** Copy query results into the readback chain. Call after the render pass ends. */
  resolve(encoder: GPUCommandEncoder): void;
  /** Asynchronously read the most recently resolved pair. Returns null while busy. */
  readMs(): Promise<number | null>;
};

type Slot = {
  resolveBuf:  GPUBuffer;  // GPU-visible, QUERY_RESOLVE | COPY_SRC
  readBuf:     GPUBuffer;  // MAP_READ | COPY_DST
  inFlight:    boolean;
};

export function createPerf(device: GPUDevice): Perf {
  const querySet = device.createQuerySet({
    label: 'perf-timestamps',
    type:  'timestamp',
    count: 2,
  });

  const slots: Slot[] = [0, 1].map(() => ({
    resolveBuf: device.createBuffer({
      label: 'perf-resolve',
      size:  2 * 8,  // 2 u64 timestamps
      usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
    }),
    readBuf: device.createBuffer({
      label: 'perf-read',
      size:  2 * 8,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    }),
    inFlight: false,
  }));
  let writeSlot = 0;

  const writes: GPURenderPassTimestampWrites = {
    querySet,
    beginningOfPassWriteIndex: 0,
    endOfPassWriteIndex:       1,
  };

  return {
    querySet,
    writes,
    resolve(encoder) {
      const slot = slots[writeSlot]!;
      if (slot.inFlight) return;  // previous readback hasn't completed; skip this frame
      encoder.resolveQuerySet(querySet, 0, 2, slot.resolveBuf, 0);
      encoder.copyBufferToBuffer(slot.resolveBuf, 0, slot.readBuf, 0, 16);
      slot.inFlight = true;
      writeSlot = 1 - writeSlot;
    },
    async readMs() {
      const slot = slots[1 - writeSlot]!;  // the one we just wrote to
      if (!slot.inFlight) return null;
      await slot.readBuf.mapAsync(GPUMapMode.READ);
      const view = new BigUint64Array(slot.readBuf.getMappedRange().slice(0));
      slot.readBuf.unmap();
      slot.inFlight = false;
      const deltaNs = view[1]! - view[0]!;
      return Number(deltaNs) / 1e6;  // ns → ms
    },
  };
}
