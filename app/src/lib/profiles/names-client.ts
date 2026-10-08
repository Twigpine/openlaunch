/**
 * Browser-side names store. Any component that shows a wallet asks for its name; requests made in the same tick
 * go out as one GET /api/profile/names call (≤100 wallets), answers are kept two minutes, and a wallet without a
 * profile is remembered as null so it is not asked again. Server pages can seed it (NamesProvider) so the first
 * paint already shows names. Wallets on screen are watched: one shared timer re-asks for the ones whose answer is
 * older than the TTL (a rename or a lost ✓ reaches an open page) and retries failed lookups, backing off while the
 * names API keeps failing. Pure data, no React: Who.tsx subscribes with useSyncExternalStore.
 */
export type NameEntry = { u: string; d: string; a: string | null; v: boolean };

const TTL_MS = 120_000;
const BATCH_MAX = 100;
const REFRESH_EVERY_MS = 30_000; // how often watched wallets are looked at (only stale or missing ones are asked)
const BACKOFF_MAX_MS = 5 * 60_000;
const cache = new Map<string, { v: NameEntry | null; at: number }>();
const listeners = new Set<() => void>();
const watched = new Map<string, number>(); // wallet → how many mounted components show it
let queued = new Set<string>();
let timer: ReturnType<typeof setTimeout> | null = null;
let refresher: ReturnType<typeof setInterval> | null = null;
let failures = 0; // consecutive failed lookups
let retryAfter = 0; // no refresh before this (backoff)

/** Tell every subscribed component the store changed. */
function notify() {
  for (const l of listeners) l();
}

/** Subscribe to name changes (useSyncExternalStore); returns the unsubscribe. */
export function subscribeNames(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * The cached entry, null for "no profile", undefined for "not known yet". Never expires on read (a render must see
 * one stable value); a stale entry keeps showing while requestName refreshes it in the background.
 */
export function cachedName(wallet: string): NameEntry | null | undefined {
  return cache.get(wallet.toLowerCase())?.v;
}

/** Whether the store holds an answer for this wallet younger than the TTL. */
function fresh(k: string): boolean {
  const hit = cache.get(k);
  return Boolean(hit && Date.now() - hit.at < TTL_MS);
}

/** Put server-known names into the store (and refresh their age) without a request. */
export function seedNames(names: Record<string, NameEntry | null>): void {
  const at = Date.now();
  let changed = false;
  for (const [w, v] of Object.entries(names)) {
    const k = w.toLowerCase();
    const cur = cache.get(k);
    if (cur && JSON.stringify(cur.v) === JSON.stringify(v)) {
      cur.at = at;
      continue;
    }
    cache.set(k, { v, at });
    changed = true;
  }
  if (changed) notify();
}

/** Drop one wallet (after its owner saves) so the next render asks again. */
export function forgetCachedName(wallet: string): void {
  cache.delete(wallet.toLowerCase());
  requestName(wallet);
}

/** Queue a wallet for the next batched lookup unless a fresh answer is already held. */
export function requestName(wallet: string): void {
  if (typeof window === "undefined") return;
  const k = wallet.toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(k) || fresh(k) || queued.has(k)) return;
  queued.add(k);
  if (!timer) timer = setTimeout(() => void flush(), 40);
}

/**
 * Keep a wallet's name current while something on screen shows it; returns the release. The first watcher asks right
 * away; afterwards the shared refresher re-asks whenever the answer is older than the TTL or missing (a failed
 * lookup), so an open feed never keeps an old name or ✓ for long.
 */
export function watchName(wallet: string): () => void {
  const k = wallet.toLowerCase();
  if (typeof window === "undefined" || !/^0x[0-9a-f]{40}$/.test(k)) return () => {};
  watched.set(k, (watched.get(k) ?? 0) + 1);
  requestName(k);
  if (!refresher) refresher = setInterval(refreshWatched, REFRESH_EVERY_MS);
  return () => {
    const n = (watched.get(k) ?? 1) - 1;
    if (n > 0) watched.set(k, n);
    else watched.delete(k);
    if (watched.size === 0 && refresher) {
      clearInterval(refresher);
      refresher = null;
    }
  };
}

/** One refresher tick: re-ask for every watched wallet that is stale or unknown (skipped in hidden tabs and while backing off). */
function refreshWatched() {
  if (document.visibilityState === "hidden" || Date.now() < retryAfter) return;
  for (const k of watched.keys()) requestName(k);
}

/** A failed lookup: the next refreshes wait 30 s, 1 min, 2 min, … up to 5 min; a success resets it. */
function noteFailure() {
  failures++;
  retryAfter = Date.now() + Math.min(REFRESH_EVERY_MS * 2 ** (failures - 1), BACKOFF_MAX_MS);
}

/** Send the queued wallets as batched /api/profile/names requests and store every answer, misses included. */
async function flush() {
  timer = null;
  // a provider may have seeded some of these since they were queued (child effects run before the parent's)
  const all = [...queued].filter((k) => !fresh(k));
  queued = new Set();
  for (let i = 0; i < all.length; i += BATCH_MAX) {
    const part = all.slice(i, i + BATCH_MAX);
    try {
      const r = await fetch(`/api/profile/names?w=${part.join(",")}`, { cache: "no-store" });
      if (!r.ok) {
        noteFailure(); // the refresher asks again after the backoff
        continue;
      }
      const d = (await r.json()) as { names?: Record<string, NameEntry> };
      const at = Date.now();
      for (const w of part) cache.set(w, { v: d.names?.[w] ?? null, at });
      failures = 0;
      retryAfter = 0;
    } catch {
      noteFailure(); // offline: the address stays as it is until a retry answers
    }
  }
  if (cache.size > 20_000) cache.clear();
  notify();
}
