import { test } from "node:test";
import assert from "node:assert/strict";
import { CHAIN_KEYS, type ChainKey } from "../chainKeys.ts";
import {
  createWatchlistStore, markWatchlistSeen, parseWatchlist, serializeWatchlist, toggleWatchlistEntry,
  WATCHLIST_LIMIT, WATCHLIST_SERVER_SNAPSHOT, WATCHLIST_STORAGE_KEY, watchlistKey,
  type WatchlistEntry, type WatchlistIdentity,
} from "./watchlist.ts";

const NOW = 1_800_000_000_000;
const token = (n = 1, chain: ChainKey = "base"): WatchlistIdentity => ({
  chain, token: `0x${n.toString(16).padStart(40, "0")}`, name: `Token ${n}`, symbol: `T${n}`,
});
const entry = (n = 1): WatchlistEntry => ({ ...token(n), addedAt: NOW - 1_000, seenAt: null, holders: null });
const payload = (entries: unknown[], version = 1) => JSON.stringify({ version, entries });

test("normalizes identity and keeps the same address on different chains distinct", () => {
  const base = { ...entry(10), token: token(10).token.toUpperCase(), name: " Token A ", symbol: " A " };
  const robinhood = { ...base, chain: "robinhood" };
  const result = parseWatchlist(payload([base, robinhood]), NOW);
  assert.equal(result.length, 2);
  assert.equal(result[0].token, token(10).token);
  assert.equal(result[0].name, "Token A");
  assert.equal(result[0].symbol, "A");
  assert.notEqual(watchlistKey(result[0]), watchlistKey(result[1]));
});

test("the v1 store retains existing entries when Arc is added, reviewed and reloaded", () => {
  assert.equal(WATCHLIST_STORAGE_KEY, "openlaunch:watchlist:v1");
  const storage = memory();
  const oldEntries = [
    { ...entry(), seenAt: NOW - 500, holders: 7 },
    { ...entry(), chain: "robinhood" as const, seenAt: NOW - 100, holders: 3 },
  ];
  storage.write(payload(oldEntries));
  const store = createWatchlistStore(storage, () => NOW);
  store.refresh();
  assert.deepEqual(store.getSnapshot().entries, oldEntries);
  assert.equal(store.toggle(token(1, "arc")), "added");
  store.markSeen([{ ...token(1, "arc"), seenAt: NOW, holders: 0 }]);
  const reloaded = createWatchlistStore(storage, () => NOW);
  reloaded.refresh();
  assert.equal(JSON.parse(storage.read()!).version, 1);
  assert.deepEqual(reloaded.getSnapshot().entries, [
    { ...token(1, "arc"), addedAt: NOW, seenAt: NOW, holders: 0 }, ...oldEntries,
  ]);
  assert.equal(new Set(reloaded.getSnapshot().savedKeys).size, CHAIN_KEYS.length);
  assert.equal(reloaded.toggle(token(1, "arc")), "removed");
  assert.deepEqual(reloaded.getSnapshot().entries, oldEntries);
});

test("watchlist identity validation stays aligned with the shared chain registry", () => {
  const entries = CHAIN_KEYS.map((chain) => ({ ...entry(), ...token(1, chain) }));
  assert.deepEqual(parseWatchlist(payload(entries), NOW), entries);
  assert.deepEqual(markWatchlistSeen(entries, CHAIN_KEYS.map((chain) => ({ ...token(1, chain), seenAt: NOW, holders: 1 })), NOW),
    entries.map((saved) => ({ ...saved, seenAt: NOW, holders: 1 })));
});

test("corrupt and unsupported payloads are empty rather than throwing", () => {
  for (const raw of [null, "", "{", "null", "[]", payload([entry()], 2), JSON.stringify({ version: 1 }), "x".repeat(128_001)]) {
    assert.deepEqual(parseWatchlist(raw, NOW), []);
  }
});

test("rejects malformed identities, timestamps and holder counts independently", () => {
  const bad = [
    null, [], {}, { ...entry(), chain: "ethereum" }, { ...entry(), token: "0x1" },
    { ...entry(), token: `0x${"z".repeat(40)}` }, { ...entry(), name: " " }, { ...entry(), symbol: 1 },
    { ...entry(), addedAt: "123" }, { ...entry(), addedAt: -1 }, { ...entry(), addedAt: 1.5 },
    { ...entry(), seenAt: NOW + 300_001 }, { ...entry(), holders: -1 }, { ...entry(), holders: 1.5 },
    { ...entry(), holders: Number.MAX_SAFE_INTEGER + 1 },
  ];
  assert.deepEqual(parseWatchlist(payload([...bad, entry(2)]), NOW), [entry(2)]);
});

test("preserves timestamps within clock-skew tolerance and rejects far-future timestamps", () => {
  const result = parseWatchlist(payload([
    { ...entry(), addedAt: NOW + 1, seenAt: NOW + 300_000, holders: 0 },
    { ...entry(2), addedAt: NOW + 300_001 },
  ]), NOW);
  assert.deepEqual(result, [{ ...entry(), addedAt: NOW + 1, seenAt: NOW + 300_000, holders: 0 }]);
});

test("a server clock one minute ahead keeps the reviewed cutoff through reload", () => {
  const storage = memory();
  const store = createWatchlistStore(storage, () => NOW);
  const serverAt = NOW + 60_000;
  store.toggle(token());
  store.markSeen([{ ...token(), seenAt: serverAt, holders: 0 }]);
  assert.equal(store.getSnapshot().entries[0].seenAt, serverAt);
  const reloaded = createWatchlistStore(storage, () => NOW);
  reloaded.refresh();
  const cutoff = reloaded.getSnapshot().entries[0].seenAt!;
  assert.equal(cutoff, serverAt);
  // API counts strictly after the cutoff: none of this reviewed minute may reappear.
  const reviewedTrades = [NOW + 1, NOW + 30_000, serverAt];
  assert.deepEqual(reviewedTrades.filter((time) => time > cutoff), []);
});

test("deduplicates a token without rolling its baseline back", () => {
  const fresh = { ...entry(), seenAt: NOW - 10, holders: 2 };
  const old = { ...entry(), addedAt: NOW - 2_000, seenAt: NOW - 50, holders: 9 };
  for (const entries of [[fresh, old], [old, fresh]]) {
    assert.deepEqual(parseWatchlist(payload(entries), NOW), [{ ...fresh, addedAt: old.addedAt }]);
  }
});

test("limits stored entries to 50, caps metadata and clears holders with no baseline", () => {
  const entries = Array.from({ length: 55 }, (_, i) => entry(i));
  const result = parseWatchlist(payload(entries), NOW);
  assert.equal(result.length, WATCHLIST_LIMIT);
  const [bounded] = parseWatchlist(payload([{ ...entry(), name: "a".repeat(200), symbol: "b".repeat(60), holders: 100 }]), NOW);
  assert.equal(bounded.name.length, 128);
  assert.equal(bounded.symbol.length, 32);
  assert.equal(bounded.holders, null);
  assert.deepEqual(parseWatchlist(serializeWatchlist(result), NOW), result);
});

test("toggle adds unreviewed entries, removes by normalized address, and never silently evicts at the cap", () => {
  const added = toggleWatchlistEntry([], token(10), NOW);
  assert.equal(added.result, "added");
  assert.deepEqual(added.entries, [{ ...token(10), addedAt: NOW, seenAt: null, holders: null }]);
  assert.deepEqual(toggleWatchlistEntry(added.entries, { ...token(10), token: token(10).token.toUpperCase() }, NOW), { entries: [], result: "removed" });
  const full = Array.from({ length: 50 }, (_, i) => entry(i));
  assert.deepEqual(toggleWatchlistEntry(full, token(100), NOW), { entries: full, result: "limit" });
  assert.equal(toggleWatchlistEntry(full, token(1), NOW).result, "removed");
  assert.equal(toggleWatchlistEntry([], { ...token(), token: "invalid" }, NOW).result, "invalid");
});

test("mark seen updates only supplied saved tokens and distinguishes null from zero", () => {
  const entries = [entry(1), entry(2), entry(3)];
  const next = markWatchlistSeen(entries, [
    { ...token(1), seenAt: NOW, holders: 0 },
    { ...token(2), seenAt: NOW, holders: null },
    { ...token(99), seenAt: NOW, holders: 10 },
  ], NOW);
  assert.deepEqual(next, [{ ...entries[0], seenAt: NOW, holders: 0 }, { ...entries[1], seenAt: NOW, holders: null }, entries[2]]);
  assert.equal(next[2], entries[2]);
  assert.deepEqual(entries, [entry(1), entry(2), entry(3)]);
});

test("older or repeated responses cannot overwrite a reviewed baseline", () => {
  const entries = [{ ...entry(), seenAt: NOW, holders: 12 }];
  for (const seenAt of [NOW - 1, NOW, null, NOW + 300_001]) {
    assert.equal(markWatchlistSeen(entries, [{ ...token(), seenAt, holders: 0 }], NOW), entries);
  }
});

test("duplicate observations use the newest valid observation", () => {
  const next = markWatchlistSeen([entry()], [
    { ...token(), seenAt: NOW, holders: 0 }, { ...token(), seenAt: NOW - 1, holders: 1 },
    { ...token(), seenAt: NOW + 300_001, holders: 2 },
  ], NOW);
  assert.deepEqual(next, [{ ...entry(), seenAt: NOW, holders: 0 }]);
});

function memory() {
  let raw: string | null = null;
  return { read: () => raw, write: (value: string) => { raw = value; } };
}

test("store is SSR-safe and snapshots stay referentially stable until a real update", () => {
  let reads = 0;
  const store = createWatchlistStore({ read: () => { reads++; return null; }, write: () => {} }, () => NOW);
  assert.equal(store.getSnapshot(), WATCHLIST_SERVER_SNAPSHOT);
  assert.equal(reads, 0);
  let notifications = 0;
  const unsubscribe = store.subscribe(() => { notifications++; });
  store.refresh();
  const hydrated = store.getSnapshot();
  assert.deepEqual(hydrated, { entries: [], savedKeys: [], ready: true, storageError: false });
  store.refresh();
  assert.equal(store.getSnapshot(), hydrated);
  assert.equal(notifications, 1);
  unsubscribe();
  store.toggle(token());
  assert.equal(notifications, 1);
});

test("same-store subscribers observe changes and reload restores the saved list", () => {
  const storage = memory();
  const store = createWatchlistStore(storage, () => NOW);
  let first = 0, second = 0;
  store.subscribe(() => { first++; });
  store.subscribe(() => { second++; });
  store.toggle(token());
  store.markSeen([{ ...token(), seenAt: NOW, holders: 0 }]);
  assert.ok(first > 0);
  assert.equal(first, second);
  const reloaded = createWatchlistStore(storage, () => NOW);
  reloaded.refresh();
  assert.deepEqual(reloaded.getSnapshot(), store.getSnapshot());
});

test("stale tabs read latest storage before mutating and refresh handles removals", () => {
  const storage = memory();
  const a = createWatchlistStore(storage, () => NOW);
  const b = createWatchlistStore(storage, () => NOW);
  a.refresh(); b.refresh();
  a.toggle(token(1));
  b.toggle(token(2));
  assert.equal(b.getSnapshot().entries.length, 2);
  a.refresh();
  assert.deepEqual(a.getSnapshot(), b.getSnapshot());
  b.toggle(token(1));
  a.refresh();
  assert.deepEqual(a.getSnapshot().entries.map(watchlistKey), [watchlistKey(token(2))]);
});

test("storage read and write failures leave an ephemeral usable list", () => {
  const store = createWatchlistStore({ read: () => { throw new Error("denied"); }, write: () => { throw new Error("denied"); } }, () => NOW);
  store.refresh();
  assert.deepEqual(store.getSnapshot(), { entries: [], savedKeys: [], ready: true, storageError: true });
  store.toggle(token());
  store.markSeen([{ ...token(), seenAt: NOW, holders: 0 }]);
  assert.equal(store.getSnapshot().entries[0].holders, 0);
  store.refresh();
  assert.equal(store.getSnapshot().entries.length, 1);
  store.toggle(token());
  assert.equal(store.getSnapshot().entries.length, 0);
});

test("quota failures preserve pending additions and removals across refresh and recover on next write", () => {
  const disk = memory();
  disk.write(serializeWatchlist([entry(1)]));
  let blocked = true;
  const store = createWatchlistStore({ read: disk.read, write: (raw) => { if (blocked) throw new Error("quota"); disk.write(raw); } }, () => NOW);
  store.toggle(token(1)); // Local removal must not reappear from the old disk snapshot.
  store.toggle(token(2));
  store.refresh();
  assert.deepEqual(store.getSnapshot().entries.map(watchlistKey), [watchlistKey(token(2))]);
  disk.write(serializeWatchlist([entry(1), entry(3)])); // Another tab's unrelated addition survives.
  store.refresh();
  assert.deepEqual(new Set(store.getSnapshot().entries.map(watchlistKey)), new Set([watchlistKey(token(2)), watchlistKey(token(3))]));
  assert.equal(store.getSnapshot().storageError, true);
  blocked = false;
  store.markSeen([{ ...token(2), seenAt: NOW, holders: 0 }]);
  assert.equal(store.getSnapshot().storageError, false);
  assert.deepEqual(parseWatchlist(disk.read(), NOW), store.getSnapshot().entries);
});

test("a stale tab cannot restore a removed token by marking it reviewed", () => {
  const storage = memory();
  const a = createWatchlistStore(storage, () => NOW);
  const b = createWatchlistStore(storage, () => NOW);
  a.toggle(token()); b.refresh(); a.toggle(token());
  b.markSeen([{ ...token(), seenAt: NOW, holders: 10 }]);
  assert.deepEqual(b.getSnapshot().entries, []);
});

test("quota conflicts at capacity keep the local addition and never persist a clipped remote list", () => {
  const disk = memory();
  const original = Array.from({ length: 49 }, (_, i) => entry(i));
  disk.write(serializeWatchlist(original));
  let blocked = true;
  let writes = 0;
  const store = createWatchlistStore({ read: disk.read, write: (raw) => {
    writes++;
    if (blocked) throw new Error("quota");
    disk.write(raw);
  } }, () => NOW);
  store.toggle(token(49)); // Local 50th addition is pending.
  const remote = serializeWatchlist([...original, entry(50)]);
  disk.write(remote); // A different tab successfully adds a different 50th token.
  store.refresh();
  assert.equal(store.getSnapshot().entries.length, 50);
  assert.ok(store.getSnapshot().entries.some((item) => watchlistKey(item) === watchlistKey(token(49))));

  blocked = false;
  const writesBeforeReview = writes;
  store.markSeen([{ ...token(49), seenAt: NOW, holders: 0 }]);
  assert.equal(writes, writesBeforeReview, "review must not write while merged preferences exceed capacity");
  assert.equal(disk.read(), remote, "remote preferences remain untouched");
  assert.equal(store.getSnapshot().storageError, true);
  store.refresh();
  assert.ok(store.getSnapshot().entries.some((item) => watchlistKey(item) === watchlistKey(token(49))));

  store.toggle(token(1)); // An explicit removal makes room for both pending and remote additions.
  const persisted = parseWatchlist(disk.read(), NOW);
  assert.equal(persisted.length, 50);
  assert.ok(persisted.some((item) => item.token === token(49).token));
  assert.ok(persisted.some((item) => item.token === token(50).token));
  assert.ok(!persisted.some((item) => item.token === token(1).token));
  assert.equal(store.getSnapshot().storageError, false);
});

test("membership remains accurate for a persisted token hidden by the conflict display cap", () => {
  const disk = memory();
  const original = Array.from({ length: 49 }, (_, i) => entry(i));
  disk.write(serializeWatchlist(original));
  let blocked = true;
  const store = createWatchlistStore({ read: disk.read, write: (raw) => {
    if (blocked) throw new Error("quota");
    disk.write(raw);
  } }, () => NOW);
  store.toggle(token(49));
  disk.write(serializeWatchlist([...original, entry(50)]));
  store.refresh();
  const snapshot = store.getSnapshot();
  assert.equal(snapshot.entries.length, 50);
  assert.ok(!snapshot.entries.some((item) => item.token === token(50).token));
  assert.ok(snapshot.savedKeys.includes(watchlistKey(token(50))), "the star must still present the Remove action");
  assert.equal(snapshot.savedKeys.length, 51);
  store.refresh();
  assert.equal(store.getSnapshot(), snapshot, "unchanged membership keeps a stable external-store snapshot");

  let notifications = 0;
  store.subscribe(() => { notifications++; });
  disk.write(serializeWatchlist([...original, entry(51)]));
  store.refresh();
  assert.deepEqual(store.getSnapshot().entries, snapshot.entries, "the capped display rows have not changed");
  assert.ok(!store.getSnapshot().savedKeys.includes(watchlistKey(token(50))));
  assert.ok(store.getSnapshot().savedKeys.includes(watchlistKey(token(51))));
  assert.equal(notifications, 1, "membership-only changes must notify stars outside the watchlist panel");
  disk.write(serializeWatchlist([...original, entry(50)]));
  store.refresh();

  blocked = false;
  assert.equal(store.toggle(token(50)), "removed");
  assert.ok(!store.getSnapshot().savedKeys.includes(watchlistKey(token(50))));
  assert.ok(store.getSnapshot().savedKeys.includes(watchlistKey(token(49))));
  assert.ok(!parseWatchlist(disk.read(), NOW).some((item) => item.token === token(50).token));
});
