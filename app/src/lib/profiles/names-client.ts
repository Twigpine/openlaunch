/**
 * Browser-side names store. Any component that shows a wallet asks for its name; requests made in the same tick
 * go out as one GET /api/profile/names call (≤100 wallets), answers are kept two minutes, and a wallet without a
 * profile is remembered as null so it is not asked again. Server pages can seed it (NamesProvider) so the first
 * paint already shows names. Pure data, no React: Who.tsx subscribes with useSyncExternalStore.
 */
export type NameEntry = { u: string; d: string; a: string | null; v: boolean };

const TTL_MS = 120_000;
const BATCH_MAX = 100;
const cache = new Map<string, { v: NameEntry | null; at: number }>();
const listeners = new Set<() => void>();
let queued = new Set<string>();
let timer: ReturnType<typeof setTimeout> | null = null;

function notify() {
  for (const l of listeners) l();
}

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

function fresh(k: string): boolean {
  const hit = cache.get(k);
  return Boolean(hit && Date.now() - hit.at < TTL_MS);
}

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

export function requestName(wallet: string): void {
  if (typeof window === "undefined") return;
  const k = wallet.toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(k) || fresh(k) || queued.has(k)) return;
  queued.add(k);
  if (!timer) timer = setTimeout(() => void flush(), 40);
}

async function flush() {
  timer = null;
  // a provider may have seeded some of these since they were queued (child effects run before the parent's)
  const all = [...queued].filter((k) => !fresh(k));
  queued = new Set();
  for (let i = 0; i < all.length; i += BATCH_MAX) {
    const part = all.slice(i, i + BATCH_MAX);
    try {
      const r = await fetch(`/api/profile/names?w=${part.join(",")}`, { cache: "no-store" });
      if (!r.ok) continue; // try again on the next render that asks
      const d = (await r.json()) as { names?: Record<string, NameEntry> };
      const at = Date.now();
      for (const w of part) cache.set(w, { v: d.names?.[w] ?? null, at });
    } catch {
      /* offline: the address stays as it is */
    }
  }
  if (cache.size > 20_000) cache.clear();
  notify();
}
