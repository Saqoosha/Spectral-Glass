import { describe, it, expect } from 'vitest';
import {
  attachDrag,
  defaultPills,
  ensurePillInstanceCount,
  setPillInstanceCount,
  DEFAULT_PILL_COUNT,
} from '../src/pills';

describe('ensurePillInstanceCount', () => {
  it('pads a single pill up to DEFAULT_PILL_COUNT using default layout slots', () => {
    const w = 800;
    const h = 600;
    const one = [{ cx: 100, cy: 200, cz: 0, hx: 1, hy: 1, hz: 1, edgeR: 5 }];
    const out = ensurePillInstanceCount(one, w, h);
    expect(out).toHaveLength(DEFAULT_PILL_COUNT);
    expect(out[0]).toEqual(one[0]);
    const d = defaultPills(w, h);
    for (let i = 1; i < DEFAULT_PILL_COUNT; i++) {
      expect(out[i]?.cx).toBe(d[i]!.cx);
      expect(out[i]?.cy).toBe(d[i]!.cy);
    }
  });

  it('leaves four or more pills unchanged (aside from cloning)', () => {
    const w = 400;
    const h = 300;
    const d = defaultPills(w, h);
    const out = ensurePillInstanceCount(d, w, h);
    expect(out).toHaveLength(4);
    expect(out[0]?.cx).toBe(d[0]!.cx);
  });
});

describe('setPillInstanceCount', () => {
  it('trims to one pill for single-object presets', () => {
    const d = defaultPills(800, 600);
    const out = setPillInstanceCount(d, 800, 600, 1);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual(d[0]);
    expect(out[0]).not.toBe(d[0]);
  });

  it('pads back to four pills for multi-object presets', () => {
    const one = [{ cx: 100, cy: 200, cz: 0, hx: 1, hy: 1, hz: 1, edgeR: 5 }];
    const out = setPillInstanceCount(one, 800, 600, DEFAULT_PILL_COUNT);
    expect(out).toHaveLength(DEFAULT_PILL_COUNT);
    expect(out[0]).toEqual(one[0]);
    expect(out[1]?.cx).toBe(defaultPills(800, 600)[1]!.cx);
  });
});

describe('attachDrag', () => {
  it('calls onDragMove whenever a dragged pill position changes', () => {
    const listeners = new Map<string, EventListener[]>();
    const add = (type: string, fn: EventListener) => {
      const arr = listeners.get(type) ?? [];
      arr.push(fn);
      listeners.set(type, arr);
    };
    const remove = (type: string, fn: EventListener) => {
      listeners.set(type, (listeners.get(type) ?? []).filter((f) => f !== fn));
    };
    const canvas = {
      getBoundingClientRect: () => ({ left: 0, top: 0 }),
      addEventListener: add,
      removeEventListener: remove,
      setPointerCapture: () => {},
      releasePointerCapture: () => {},
    } as unknown as HTMLCanvasElement;

    const g = globalThis as unknown as Record<string, unknown>;
    const oldWindow = g.window;
    const oldDocument = g.document;
    g.window = { addEventListener: () => {}, removeEventListener: () => {} };
    g.document = {
      hidden: false,
      addEventListener: () => {},
      removeEventListener: () => {},
    };

    try {
      const pills = [{ cx: 0, cy: 0, cz: 0, hx: 20, hy: 20, hz: 20, edgeR: 0 }];
      let moves = 0;
      const detach = attachDrag(canvas, pills, 1, () => 0, () => 0, () => { moves += 1; });
      const down = listeners.get('pointerdown')?.[0];
      const move = listeners.get('pointermove')?.[0];
      expect(down).toBeDefined();
      expect(move).toBeDefined();

      down?.({ clientX: 5, clientY: 5, pointerId: 1 } as unknown as Event);
      move?.({ clientX: 15, clientY: 25, pointerId: 1 } as unknown as Event);
      expect(pills[0]?.cx).toBe(10);
      expect(pills[0]?.cy).toBe(20);
      expect(moves).toBe(1);

      move?.({ clientX: 15, clientY: 25, pointerId: 1 } as unknown as Event);
      expect(moves).toBe(1);
      detach();
    } finally {
      if (oldWindow === undefined) delete g.window;
      else g.window = oldWindow;
      if (oldDocument === undefined) delete g.document;
      else g.document = oldDocument;
    }
  });
});
