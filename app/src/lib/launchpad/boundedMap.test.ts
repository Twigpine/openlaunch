import assert from "node:assert/strict";
import test from "node:test";
import { setBounded } from "./boundedMap.ts";

test("expired entries are dropped before an active one is evicted", () => {
  const map = new Map([
    ["expired", 1],
    ["live", 100],
  ]);
  setBounded(map, "new", 100, 2, (value, now) => value <= now, 50);
  assert.deepEqual([...map.keys()], ["live", "new"]);
});

test("a full map with nothing expired evicts the oldest insertion", () => {
  const map = new Map([
    ["a", 1],
    ["b", 2],
  ]);
  setBounded(map, "c", 3, 2, () => false, 0);
  assert.deepEqual([...map.keys()], ["b", "c"]);
});

test("refreshing an existing key moves it out of the eviction lane", () => {
  const map = new Map([
    ["a", 1],
    ["b", 2],
  ]);
  setBounded(map, "a", 3, 2, () => false, 0);
  assert.deepEqual([...map.keys()], ["b", "a"]);
  setBounded(map, "c", 4, 2, () => false, 0);
  assert.deepEqual([...map.keys()], ["a", "c"], "b was the oldest, not the refreshed a");
});

test("a burst of new keys stays at the bound", () => {
  const map = new Map<string, number>();
  for (let i = 0; i < 100; i++) setBounded(map, `k${i}`, i, 10, () => false, 0);
  assert.equal(map.size, 10);
  assert.deepEqual([...map.keys()], Array.from({ length: 10 }, (_, i) => `k${90 + i}`));
});
