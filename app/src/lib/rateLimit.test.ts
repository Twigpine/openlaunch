import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_RATE_BUCKETS,
  MAX_TOKEN_BUCKETS,
  pruneRateBuckets,
  pruneTokenBuckets,
  rateLimitedKeysForTests,
  rateLimitSizesForTests,
  rateLimited,
  resetRateLimitsForTests,
  takeToken,
} from "./rateLimit.ts";

test("fixed-window limiter isolates keys and blocks past the limit", () => {
  resetRateLimitsForTests();
  assert.equal(rateLimited("a", 2), false);
  assert.equal(rateLimited("a", 2), false);
  assert.equal(rateLimited("a", 2), true);
  assert.equal(rateLimited("b", 2), false, "another key is unaffected");
});

test("fixed buckets are pruned by expiry, then oldest first, never cleared wholesale", () => {
  const map = new Map<string, { n: number; at: number; windowMs: number }>([
    ["expired", { n: 1, at: 0, windowMs: 100 }],
    ["oldest", { n: 1, at: 900, windowMs: 1_000 }],
    ["middle", { n: 1, at: 910, windowMs: 1_000 }],
    ["newest", { n: 1, at: 920, windowMs: 1_000 }],
  ]);
  pruneRateBuckets(map, 1_000, 2);
  assert.deepEqual([...map.keys()], ["middle", "newest"]);
  assert.equal(map.has("expired"), false);
  assert.equal(map.has("oldest"), false);
});

test("the fixed map stays bounded under a burst of one-shot keys", () => {
  resetRateLimitsForTests();
  for (let i = 0; i < MAX_RATE_BUCKETS + 50; i++) rateLimited(`burst-${i}`, 1);
  assert.equal(rateLimitSizesForTests().fixed, MAX_RATE_BUCKETS);
});

test("a reset bucket keeps its entry and moves to the back of the eviction order", () => {
  resetRateLimitsForTests();
  for (let i = 0; i < MAX_RATE_BUCKETS; i++) rateLimited(`full-${i}`, 1);
  // a different window resets the bucket instead of counting it, and the reinsert does not grow the map
  rateLimited("full-1", 1, 30_000);
  const keys = rateLimitedKeysForTests();
  assert.equal(keys.length, MAX_RATE_BUCKETS, "no live bucket may be dropped to make room that was never needed");
  assert.equal(keys[0], "full-0", "the untouched oldest bucket holds its place");
  assert.equal(keys.at(-1), "full-1", "the reset bucket is the newest, not the oldest");
  // so a burst of one-shot keys evicts the bucket that really is stale, not the one that just reset
  rateLimited("extra", 1);
  const after = rateLimitedKeysForTests();
  assert.equal(after.length, MAX_RATE_BUCKETS, "the map stays at its cap");
  assert.equal(after.includes("full-1"), true, "the just-reset bucket outlives the burst");
  assert.equal(after.includes("full-0"), false, "the oldest live bucket is the one that goes");
});

test("token bucket refills at the configured rate", () => {
  resetRateLimitsForTests();
  assert.equal(takeToken("ip", 2, 1, 1_000), true);
  assert.equal(takeToken("ip", 2, 1, 1_000), true);
  assert.equal(takeToken("ip", 2, 1, 1_000), false);
  assert.equal(takeToken("ip", 2, 1, 2_000), true, "one second refills one token");
  assert.equal(takeToken("ip", 2, 1, 2_000), false);
});

test("a take of several tokens is all or none", () => {
  resetRateLimitsForTests();
  assert.equal(takeToken("batch", 10, 1, 1_000, 6), true);
  assert.equal(takeToken("batch", 10, 1, 1_000, 6), false, "4 left: a 6-token take is refused");
  assert.equal(takeToken("batch", 10, 1, 1_000, 4), true, "and the refusal spent nothing");
  assert.equal(takeToken("batch", 10, 1, 1_000, 1), false);
});

test("a clock that steps back neither drains nor refills a bucket", () => {
  resetRateLimitsForTests();
  assert.equal(takeToken("clock", 2, 1, 10_000, 2), true);
  assert.equal(takeToken("clock", 2, 1, 5_000), false, "an earlier time refills nothing");
  assert.equal(takeToken("clock", 2, 1, 10_500), false, "and refill still counts from the latest time seen");
  assert.equal(takeToken("clock", 2, 1, 11_000), true);
  resetRateLimitsForTests();
  assert.equal(takeToken("back", 5, 1, 10_000), true);
  assert.equal(takeToken("back", 5, 1, 0, 4), true, "4 tokens were left: a step back must not take them away");
});

test("token buckets are pruned after a full refill, then oldest first", () => {
  const map = new Map<string, { tokens: number; at: number; cap: number; refillPerSecond: number }>([
    ["full", { tokens: 0, at: 0, cap: 2, refillPerSecond: 1 }],
    ["oldest", { tokens: 0, at: 9_000, cap: 2, refillPerSecond: 1 }],
    ["middle", { tokens: 0, at: 9_100, cap: 2, refillPerSecond: 1 }],
  ]);
  pruneTokenBuckets(map, 10_000, 1);
  assert.deepEqual([...map.keys()], ["middle"], "full refills go first, then the oldest live bucket");
});

test("a token bucket is full once its deficit refills, not a whole cap's worth", () => {
  const map = new Map<string, { tokens: number; at: number; cap: number; refillPerSecond: number }>([
    ["one-down", { tokens: 9, at: 100, cap: 10, refillPerSecond: 1 }], // full at 1_100
    ["drained", { tokens: 0, at: 100, cap: 10, refillPerSecond: 1 }], // full at 10_100
    ["frozen", { tokens: 9, at: 100, cap: 10, refillPerSecond: 0 }], // never refills
  ]);
  pruneTokenBuckets(map, 1_100, 10);
  assert.deepEqual([...map.keys()], ["drained", "frozen"], "only the bucket that is already full carries no state");
});

test("the token map stays bounded under a burst of one-shot keys", () => {
  resetRateLimitsForTests();
  for (let i = 0; i < MAX_TOKEN_BUCKETS + 50; i++) takeToken(`burst-${i}`, 1, 0.001, 1_000);
  assert.equal(rateLimitSizesForTests().tokens, MAX_TOKEN_BUCKETS);
});

test("refused takes on new keys keep the token map bounded too", () => {
  resetRateLimitsForTests();
  // a cost over the cap is refused on a brand-new key
  for (let i = 0; i < MAX_TOKEN_BUCKETS + 50; i++) assert.equal(takeToken(`refused-${i}`, 1, 0.001, 1_000, 2), false);
  assert.ok(rateLimitSizesForTests().tokens <= MAX_TOKEN_BUCKETS);
});
