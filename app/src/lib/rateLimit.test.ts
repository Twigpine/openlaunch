import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_RATE_BUCKETS,
  MAX_TOKEN_BUCKETS,
  pruneRateBuckets,
  pruneTokenBuckets,
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

test("token bucket refills at the configured rate", () => {
  resetRateLimitsForTests();
  assert.equal(takeToken("ip", 2, 1, 1_000), true);
  assert.equal(takeToken("ip", 2, 1, 1_000), true);
  assert.equal(takeToken("ip", 2, 1, 1_000), false);
  assert.equal(takeToken("ip", 2, 1, 2_000), true, "one second refills one token");
  assert.equal(takeToken("ip", 2, 1, 2_000), false);
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

test("the token map stays bounded under a burst of one-shot keys", () => {
  resetRateLimitsForTests();
  for (let i = 0; i < MAX_TOKEN_BUCKETS + 50; i++) takeToken(`burst-${i}`, 1, 0.001, 1_000);
  assert.equal(rateLimitSizesForTests().tokens, MAX_TOKEN_BUCKETS);
});
