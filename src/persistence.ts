import type { Params } from './ui';
import type { Pill } from './pills';

const KEY     = 'realrefraction:config';
const VERSION = 1;

type Stored = {
  version: number;
  params:  Partial<Params>;
  pills:   Pill[];
};

type Loaded = {
  params: Partial<Params>;
  pills:  Pill[] | null;
};

/**
 * Read persisted config from localStorage. Returns null when storage is empty,
 * unavailable (quota/disabled/private mode), corrupt, or from an older schema.
 * Callers merge `params` into the defaults; an absent field falls back to
 * today's default.
 */
export function loadStored(): Loaded | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Stored>;
    if (parsed.version !== VERSION) return null;
    return {
      params: parsed.params ?? {},
      pills:  Array.isArray(parsed.pills) ? parsed.pills : null,
    };
  } catch {
    return null;
  }
}

export function save(params: Params, pills: readonly Pill[]): void {
  try {
    const payload: Stored = { version: VERSION, params, pills: [...pills] };
    localStorage.setItem(KEY, JSON.stringify(payload));
  } catch {
    // storage disabled, quota exceeded, private mode, etc. — not fatal
  }
}

/**
 * Debounced save. Useful for high-frequency events like pointer drags.
 * Coalesces calls within `delayMs` into a single write.
 */
export function debouncedSaver(delayMs = 250): (params: Params, pills: readonly Pill[]) => void {
  let handle: ReturnType<typeof setTimeout> | null = null;
  let latestParams: Params | null = null;
  let latestPills:  readonly Pill[] | null = null;
  return (params, pills) => {
    latestParams = params;
    latestPills  = pills;
    if (handle !== null) return;
    handle = setTimeout(() => {
      handle = null;
      if (latestParams && latestPills) save(latestParams, latestPills);
    }, delayMs);
  };
}
