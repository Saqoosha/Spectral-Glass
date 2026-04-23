import { describe, it, expect, beforeEach, vi } from 'vitest';
import { loadStored, save } from '../src/persistence';
import type { Params } from '../src/ui';

// localStorage doesn't exist in Node's vitest env by default. We install a
// minimal in-memory mock on globalThis before each test so
// persistence.ts' `localStorage.getItem`/`.setItem`/`.removeItem` calls
// work. Each test gets a fresh mock so one test's payload can't leak into
// the next.
class MemoryStorage {
  private store = new Map<string, string>();
  getItem(key: string): string | null { return this.store.get(key) ?? null; }
  setItem(key: string, value: string): void { this.store.set(key, value); }
  removeItem(key: string): void { this.store.delete(key); }
  clear(): void { this.store.clear(); }
  get length(): number { return this.store.size; }
  key(i: number): string | null { return Array.from(this.store.keys())[i] ?? null; }
}

function installStorage(): MemoryStorage {
  const mem = new MemoryStorage();
  (globalThis as unknown as { localStorage: Storage }).localStorage = mem as unknown as Storage;
  return mem;
}

const KEY = 'realrefraction:config';
const VERSION = 1;

function writeRaw(mem: MemoryStorage, params: Record<string, unknown>): void {
  mem.setItem(KEY, JSON.stringify({ version: VERSION, params, pills: [] }));
}

// Minimal defaults — loadStored only validates fields that are present in
// the payload, so tests that poke at a single field don't need a complete
// Params object.
function defaultParamsForSave(): Params {
  return {
    sampleCount: 8,
    shape: 'diamond',
    n_d: 2.418,
    V_d: 55,
    pillLen: 200,
    pillShort: 200,
    pillThick: 200,
    edgeR: 10,
    refractionStrength: 0.2,
    refractionMode: 'exact',
    temporalJitter: true,
    projection: 'perspective',
    fov: 60,
    debugProxy: false,
    aaMode: 'taa',
    paused: false,
    historyAlpha: 0.2,
    waveAmp: 20,
    waveWavelength: 300,
    diamondSize: 200,
    diamondWireframe: false,
    diamondFacetColor: false,
    diamondView: 'free',
  };
}

describe('persistence — diamondView allow-list validation', () => {
  beforeEach(() => {
    installStorage();
  });

  for (const view of ['free', 'top', 'side', 'bottom'] as const) {
    it(`accepts the canonical view "${view}"`, () => {
      const mem = installStorage();
      writeRaw(mem, { diamondView: view });
      const loaded = loadStored();
      expect(loaded?.params.diamondView).toBe(view);
    });
  }

  it('rejects a non-canonical view string — silently drops to default path', () => {
    const mem = installStorage();
    writeRaw(mem, { diamondView: 'isometric' });
    const loaded = loadStored();
    // Field should be absent from returned params so the caller's merge
    // with defaultParams() re-seeds it to 'free'. Dropping-to-default is
    // the documented failure mode for unknown enum strings — same as how
    // `shape` / `aaMode` / `projection` behave.
    expect(loaded?.params.diamondView).toBeUndefined();
  });

  it('rejects non-string types for diamondView', () => {
    const mem = installStorage();
    // Test a representative set of type-confused inputs. A boolean would
    // slip through a naive truthy check; null would slip through a
    // `typeof === 'object'` check; a number would slip through an
    // in-keyword check.
    for (const bogus of [null, 123, true, { view: 'top' }, ['top']]) {
      mem.clear();
      writeRaw(mem, { diamondView: bogus as unknown });
      const loaded = loadStored();
      expect(loaded?.params.diamondView).toBeUndefined();
    }
  });

  it('round-trips diamondView through save() + loadStored()', () => {
    // End-to-end: save() writes JSON, loadStored() parses + validates. A
    // regression in EITHER the allow-list set OR the JSON shape is caught.
    installStorage();
    const params = defaultParamsForSave();
    for (const view of ['free', 'top', 'side', 'bottom'] as const) {
      save({ ...params, diamondView: view }, []);
      const loaded = loadStored();
      expect(loaded?.params.diamondView).toBe(view);
    }
  });
});

describe('persistence — diamondFacetColor boolean guard', () => {
  beforeEach(() => {
    installStorage();
  });

  it('accepts true and false', () => {
    for (const val of [true, false]) {
      const mem = installStorage();
      writeRaw(mem, { diamondFacetColor: val });
      const loaded = loadStored();
      expect(loaded?.params.diamondFacetColor).toBe(val);
    }
  });

  it('rejects truthy non-boolean values (strict boolean check)', () => {
    // A regression where someone swapped `typeof === 'boolean'` for a
    // truthy check would let these through and corrupt the uniform write
    // (scratch[base+2] = p.diamondFacetColor ? 1 : 0 already exists but
    // downstream readers treat the value as strictly boolean). The
    // current implementation uses `typeof === 'boolean'` — this test pins
    // it against the "truthy" refactor.
    for (const bogus of ['true', 1, 0, 'yes', null, {}, []]) {
      const mem = installStorage();
      writeRaw(mem, { diamondFacetColor: bogus as unknown });
      const loaded = loadStored();
      expect(loaded?.params.diamondFacetColor).toBeUndefined();
    }
  });

  it('round-trips diamondFacetColor through save() + loadStored()', () => {
    installStorage();
    const params = defaultParamsForSave();
    for (const val of [true, false]) {
      save({ ...params, diamondFacetColor: val }, []);
      const loaded = loadStored();
      expect(loaded?.params.diamondFacetColor).toBe(val);
    }
  });
});

describe('persistence — unavailable / corrupt storage', () => {
  it('returns null when localStorage.getItem throws', () => {
    const fail: Storage = {
      getItem: vi.fn(() => { throw new Error('SecurityError'); }),
      setItem: vi.fn(),
      removeItem: vi.fn(),
      clear: vi.fn(),
      key: vi.fn(() => null),
      length: 0,
    };
    (globalThis as unknown as { localStorage: Storage }).localStorage = fail;
    expect(loadStored()).toBeNull();
  });

  it('returns null AND clears storage when JSON is corrupt', () => {
    const mem = installStorage();
    mem.setItem(KEY, '{{ not valid json');
    expect(loadStored()).toBeNull();
    // Corrupt payload should have been removed so the next load doesn't
    // hit the same trap.
    expect(mem.getItem(KEY)).toBeNull();
  });

  it('returns null when schema version mismatches', () => {
    const mem = installStorage();
    mem.setItem(KEY, JSON.stringify({ version: 999, params: {}, pills: [] }));
    expect(loadStored()).toBeNull();
  });
});
