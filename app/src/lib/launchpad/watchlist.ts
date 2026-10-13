import { isChainKey, type ChainKey } from "../chainKeys.ts";

/** Browser-local preferences only. No wallet, trading, or server-side identity. */
export const WATCHLIST_STORAGE_KEY = "openlaunch:watchlist:v1";
export const WATCHLIST_LIMIT = 50;
const CLOCK_SKEW_MS = 5 * 60 * 1_000;

export type WatchlistIdentity = { chain: ChainKey; token: string; name: string; symbol: string };
export type WatchlistEntry = WatchlistIdentity & { addedAt: number; seenAt: number | null; holders: number | null };
export type WatchlistSeen = Pick<WatchlistEntry, "chain" | "token" | "seenAt" | "holders">;
export type WatchlistSnapshot = { entries: WatchlistEntry[]; savedKeys: string[]; ready: boolean; storageError: boolean };
export type WatchlistToggleResult = "added" | "removed" | "limit" | "invalid";

export const WATCHLIST_SERVER_SNAPSHOT: WatchlistSnapshot = { entries: [], savedKeys: [], ready: false, storageError: false };

export function watchlistKey(identity: { chain: string; token: string }): string {
  return `${identity.chain}:${identity.token.toLowerCase()}`;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function identity(value: unknown): WatchlistIdentity | null {
  if (!record(value) || !isChainKey(value.chain) ||
    typeof value.token !== "string" || !/^0x[\da-f]{40}$/i.test(value.token) ||
    typeof value.name !== "string" || !value.name.trim() ||
    typeof value.symbol !== "string" || !value.symbol.trim()) return null;
  return { chain: value.chain, token: value.token.toLowerCase(), name: value.name.trim().slice(0, 128), symbol: value.symbol.trim().slice(0, 32) };
}

function validTime(value: unknown, now: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= now + CLOCK_SKEW_MS;
}

function validHolders(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isSafeInteger(value) && value >= 0);
}

/** Reject malformed entries; tolerate small clock differences without rewriting server checkpoints. */
export function parseWatchlist(raw: string | null, now = Date.now()): WatchlistEntry[] {
  if (!raw || raw.length > 128_000) return [];
  try {
    const payload: unknown = JSON.parse(raw);
    if (!record(payload) || payload.version !== 1 || !Array.isArray(payload.entries)) return [];
    const entries = new Map<string, WatchlistEntry>();
    for (const value of payload.entries) {
      const token = identity(value);
      if (!token || !record(value) || !validTime(value.addedAt, now) ||
        (value.seenAt !== null && !validTime(value.seenAt, now)) || !validHolders(value.holders)) continue;
      const entry: WatchlistEntry = {
        ...token, addedAt: value.addedAt,
        seenAt: value.seenAt as number | null,
        holders: value.seenAt === null ? null : value.holders,
      };
      const key = watchlistKey(entry);
      const existing = entries.get(key);
      if (existing) {
        // A duplicate must never roll a reviewed snapshot backward.
        const latest = (entry.seenAt ?? -1) > (existing.seenAt ?? -1) ? entry : existing;
        entries.set(key, { ...latest, addedAt: Math.min(entry.addedAt, existing.addedAt) });
      } else if (entries.size < WATCHLIST_LIMIT) entries.set(key, entry);
    }
    return [...entries.values()];
  } catch {
    return [];
  }
}

export function serializeWatchlist(entries: readonly WatchlistEntry[]): string {
  return JSON.stringify({ version: 1, entries });
}

export function toggleWatchlistEntry(entries: WatchlistEntry[], value: WatchlistIdentity, now = Date.now()): { entries: WatchlistEntry[]; result: WatchlistToggleResult } {
  const token = identity(value);
  if (!token) return { entries, result: "invalid" };
  const key = watchlistKey(token);
  if (entries.some((entry) => watchlistKey(entry) === key)) {
    return { entries: entries.filter((entry) => watchlistKey(entry) !== key), result: "removed" };
  }
  if (entries.length >= WATCHLIST_LIMIT) return { entries, result: "limit" };
  return { entries: [{ ...token, addedAt: now, seenAt: null, holders: null }, ...entries], result: "added" };
}

/** Only explicit, successful observations advance a baseline. Null holders mean unavailable, not zero. */
export function markWatchlistSeen(entries: WatchlistEntry[], observations: readonly WatchlistSeen[], now = Date.now()): WatchlistEntry[] {
  const updates = new Map<string, WatchlistSeen>();
  for (const observation of observations) {
    if (!record(observation) || !isChainKey(observation.chain) ||
      typeof observation.token !== "string" || !/^0x[\da-f]{40}$/i.test(observation.token) ||
      !validTime(observation.seenAt, now) || !validHolders(observation.holders)) continue;
    const key = watchlistKey(observation);
    const previous = updates.get(key);
    if (!previous || observation.seenAt > (previous.seenAt ?? -1)) {
      updates.set(key, observation);
    }
  }
  let changed = false;
  const next = entries.map((entry) => {
    const update = updates.get(watchlistKey(entry));
    if (!update || (update.seenAt ?? -1) <= (entry.seenAt ?? -1)) return entry;
    changed = true;
    return { ...entry, seenAt: update.seenAt, holders: update.holders };
  });
  return changed ? next : entries;
}

/** Injectable storage keeps quota failures and stale-tab merges testable without a browser. */
export function createWatchlistStore(storage: { read: () => string | null; write: (value: string) => void }, now = Date.now) {
  let snapshot = WATCHLIST_SERVER_SNAPSHOT;
  // Keep a full conflict set internally even when the UI is capped at 50. Otherwise a later
  // review could persist the clipped list and silently delete another tab's saved token.
  let workingEntries: WatchlistEntry[] = [];
  const listeners = new Set<() => void>();
  // Retain explicit local edits after a failed write while still accepting other tabs' unrelated edits.
  const pending = new Map<string, WatchlistEntry | null>();

  function publish(entries: WatchlistEntry[], storageError: boolean) {
    workingEntries = entries;
    // Membership is not a display concern: a remote token hidden by the conflict cap must
    // still render as watched everywhere, and its action must remain "Remove", not "Save".
    const savedKeys = entries.map(watchlistKey);
    const visible = entries.length > WATCHLIST_LIMIT
      ? [...entries].sort((a, b) => Number(pending.has(watchlistKey(b))) - Number(pending.has(watchlistKey(a)))).slice(0, WATCHLIST_LIMIT)
      : entries;
    if (snapshot.ready && snapshot.storageError === storageError && serializeWatchlist(snapshot.entries) === serializeWatchlist(visible) && JSON.stringify(snapshot.savedKeys) === JSON.stringify(savedKeys)) return;
    snapshot = { entries: visible, savedKeys, ready: true, storageError };
    for (const listener of listeners) listener();
  }

  function refresh() {
    try {
      const latest = parseWatchlist(storage.read(), now());
      const merged = new Map(latest.map((entry) => [watchlistKey(entry), entry]));
      for (const [key, local] of pending) {
        const remote = merged.get(key);
        if (local === null) merged.delete(key);
        else if (!remote || (local.seenAt ?? -1) >= (remote.seenAt ?? -1)) merged.set(key, local);
      }
      publish([...merged.values()], pending.size > 0);
    } catch {
      publish(workingEntries, true);
    }
  }

  function save(entries: WatchlistEntry[]) {
    if (entries.length > WATCHLIST_LIMIT) {
      // A failed local save plus another tab's addition can exceed the limit. Preserve both
      // intents in memory and leave disk untouched until an explicit removal resolves it.
      publish(entries, true);
      return;
    }
    try {
      storage.write(serializeWatchlist(entries));
      pending.clear();
      publish(entries, false);
    } catch {
      publish(entries, true);
    }
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    refresh,
    toggle(value: WatchlistIdentity): WatchlistToggleResult {
      refresh(); // Read latest immediately before applying a local intent; localStorage has no atomic CAS.
      const next = toggleWatchlistEntry(workingEntries, value, now());
      if (next.result === "added" || next.result === "removed") {
        const key = watchlistKey(value);
        pending.set(key, next.entries.find((entry) => watchlistKey(entry) === key) ?? null);
        save(next.entries);
      }
      return next.result;
    },
    markSeen(observations: readonly WatchlistSeen[]) {
      refresh();
      const next = markWatchlistSeen(workingEntries, observations, now());
      if (next === workingEntries) return;
      for (let i = 0; i < next.length; i++) {
        if (next[i] !== workingEntries[i]) pending.set(watchlistKey(next[i]), next[i]);
      }
      save(next);
    },
  };
}
