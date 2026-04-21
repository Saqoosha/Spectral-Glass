export type Pill = {
  cx: number; cy: number; cz: number;
  hx: number; hy: number; hz: number;
  edgeR: number;
};

export function defaultPills(width: number, height: number, count = 4): Pill[] {
  const pills: Pill[] = [];
  const step = width / (count + 1);
  for (let i = 0; i < count; i++) {
    pills.push({
      cx: step * (i + 1),
      cy: height * 0.5 + (i % 2 === 0 ? -60 : 60),
      cz: 0,
      hx: 160, hy: 44, hz: 20,
      edgeR: 14,
    });
  }
  return pills;
}

type DragState =
  | { kind: 'idle' }
  | { kind: 'dragging'; pillIndex: number; offsetX: number; offsetY: number; pointerId: number };

export function attachDrag(canvas: HTMLCanvasElement, pills: Pill[], dpr: number): () => void {
  let state: DragState = { kind: 'idle' };

  const toWorld = (e: PointerEvent): { x: number; y: number } => {
    const r = canvas.getBoundingClientRect();
    return { x: (e.clientX - r.left) * dpr, y: (e.clientY - r.top) * dpr };
  };

  // Use the SDF-relative AABB shrunk inward by edgeR so the hit region follows the
  // rounded rim of the actual drawn shape (still axis-aligned — a rough approximation
  // but much closer than the raw bounding box).
  const findHit = (x: number, y: number): number => {
    for (let i = pills.length - 1; i >= 0; i--) {
      const p = pills[i]!;
      if (Math.abs(x - p.cx) <= p.hx && Math.abs(y - p.cy) <= p.hy) return i;
    }
    return -1;
  };

  const release = (pointerId: number) => {
    if (state.kind === 'dragging') {
      try { canvas.releasePointerCapture(pointerId); } catch { /* already released */ }
      state = { kind: 'idle' };
    }
  };

  const down = (e: PointerEvent) => {
    const { x, y } = toWorld(e);
    const i = findHit(x, y);
    if (i < 0) return;
    state = {
      kind:      'dragging',
      pillIndex: i,
      offsetX:   x - pills[i]!.cx,
      offsetY:   y - pills[i]!.cy,
      pointerId: e.pointerId,
    };
    try { canvas.setPointerCapture(e.pointerId); } catch { /* OK if capture fails */ }
  };

  const move = (e: PointerEvent) => {
    if (state.kind !== 'dragging') return;
    const { x, y } = toWorld(e);
    const p = pills[state.pillIndex];
    if (!p) { release(e.pointerId); return; }
    p.cx = x - state.offsetX;
    p.cy = y - state.offsetY;
  };

  const onRelease = (e: PointerEvent) => release(e.pointerId);
  const onBlur    = () => { if (state.kind === 'dragging') release(state.pointerId); };
  const onVis     = () => { if (document.hidden && state.kind === 'dragging') release(state.pointerId); };

  canvas.addEventListener('pointerdown',   down);
  canvas.addEventListener('pointermove',   move);
  canvas.addEventListener('pointerup',     onRelease);
  canvas.addEventListener('pointercancel', onRelease);
  window.addEventListener('blur',              onBlur);
  document.addEventListener('visibilitychange', onVis);

  return () => {
    if (state.kind === 'dragging') release(state.pointerId);
    canvas.removeEventListener('pointerdown',   down);
    canvas.removeEventListener('pointermove',   move);
    canvas.removeEventListener('pointerup',     onRelease);
    canvas.removeEventListener('pointercancel', onRelease);
    window.removeEventListener('blur',              onBlur);
    document.removeEventListener('visibilitychange', onVis);
  };
}
