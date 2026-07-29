// Per-page state persistence so each tab (Single Orbit / Velocity Sweep /
// Horseshoe) keeps its inputs and computed results when you navigate away
// and back. Each page owns one key; the value is whatever plain-JSON state
// blob that page chooses to store.
//
// localStorage is used (survives reloads and browser restarts). All access
// is wrapped: storage can throw (private mode, quota), and we never want a
// failed save/restore to break the page.

const PREFIX = 'tb:'; // three-body

export function saveState(page: string, state: unknown): boolean {
  try {
    localStorage.setItem(PREFIX + page, JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
}

export function loadState<T>(page: string): T | null {
  try {
    const s = localStorage.getItem(PREFIX + page);
    return s ? (JSON.parse(s) as T) : null;
  } catch {
    return null;
  }
}

export function clearState(page: string): void {
  try {
    localStorage.removeItem(PREFIX + page);
  } catch {
    /* ignore */
  }
}

// Debounce a save so high-frequency input events (slider drags) don't
// serialise on every tick. Always flush on pagehide via flushPersist().
const pendingFlush = new Map<string, () => void>();

export function debouncedSave(
  page: string,
  getState: () => unknown,
  delayMs = 250,
): void {
  pendingFlush.set(page, () => saveState(page, getState()));
  const existing = timers.get(page);
  if (existing !== undefined) clearTimeout(existing);
  timers.set(page, window.setTimeout(() => {
    timers.delete(page);
    const fn = pendingFlush.get(page);
    if (fn) { pendingFlush.delete(page); fn(); }
  }, delayMs));
}

const timers = new Map<string, number>();

// Flush any pending debounced saves immediately. Wire this to pagehide so
// in-flight state is written before the page unloads on a tab switch.
export function flushPersist(): void {
  for (const [page, t] of timers) clearTimeout(t);
  timers.clear();
  for (const [, fn] of pendingFlush) fn();
  pendingFlush.clear();
}

let flushWired = false;
export function wireFlushOnHide(): void {
  if (flushWired) return;
  flushWired = true;
  window.addEventListener('pagehide', flushPersist);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushPersist();
  });
}
