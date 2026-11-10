import { test } from "node:test";
import assert from "node:assert/strict";
import {
  HYPERLIQUID_INFO_URL,
  HYPE_PRICE_TTL_MS,
  HYPE_SPOT_URL,
  HYPE_STALE_MAX_MS,
  hypePriceSource,
  hypeUsd,
  parseHyperliquidMid,
  parseHypeSpot,
  resetHypePriceCache,
} from "./hypePrice.ts";

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => void (t += ms) };
}

/** Routes by URL: Coinbase answers `cb`, Hyperliquid answers `hl` (a Response, or a throw when null). */
function upstreams(cb: (() => Response) | null, hl: (() => Response) | null, seen: { cb: number; hl: number; hlInit?: RequestInit }) {
  return async (input: string, init?: RequestInit) => {
    if (input === HYPE_SPOT_URL) {
      seen.cb += 1;
      if (!cb) throw new Error("coinbase down");
      return cb();
    }
    if (input === HYPERLIQUID_INFO_URL) {
      seen.hl += 1;
      seen.hlInit = init;
      if (!hl) throw new Error("hyperliquid down");
      return hl();
    }
    throw new Error(`unexpected url ${input}`);
  };
}
const spot = (amount: string) => () => new Response(JSON.stringify({ data: { amount, base: "HYPE", currency: "USD" } }), { status: 200 });
const mids = (hype: string) => () => new Response(JSON.stringify({ BTC: "100000.5", HYPE: hype, ETH: "2100.1" }), { status: 200 });

test("parseHypeSpot takes Coinbase's shape and rejects everything else", () => {
  assert.equal(parseHypeSpot({ data: { amount: "74.545" } }), 74.545);
  for (const bad of [null, undefined, "74", {}, { data: {} }, { data: { amount: 74 } }, { data: { amount: "0" } }, { data: { amount: "-1" } }, { data: { amount: "NaN" } }, { data: { amount: "abc" } }]) {
    assert.equal(parseHypeSpot(bad), null, JSON.stringify(bad));
  }
});

test("parseHyperliquidMid reads HYPE out of allMids and nothing else", () => {
  assert.equal(parseHyperliquidMid({ BTC: "1", HYPE: "74.546" }), 74.546);
  for (const bad of [null, undefined, [], { BTC: "1" }, { HYPE: 74.5 }, { HYPE: "0" }, { HYPE: "-3" }, { HYPE: "Infinity" }, { hype: "74" }]) {
    assert.equal(parseHyperliquidMid(bad), null, JSON.stringify(bad));
  }
});

test("Coinbase first; Hyperliquid is not called while Coinbase answers", async () => {
  resetHypePriceCache();
  const seen = { cb: 0, hl: 0 };
  const c = clock();
  assert.equal(await hypeUsd({ fetchFn: upstreams(spot("74.5"), mids("70"), seen), now: c.now }), 74.5);
  assert.equal(hypePriceSource(), "coinbase");
  assert.deepEqual([seen.cb, seen.hl], [1, 0]);
});

test("Hyperliquid's mid is the fallback when Coinbase fails, sent as a POST for allMids", async () => {
  resetHypePriceCache();
  for (const cb of [null, () => new Response("rate limited", { status: 429 }), () => new Response("not json", { status: 200 })]) {
    resetHypePriceCache();
    const seen: { cb: number; hl: number; hlInit?: RequestInit } = { cb: 0, hl: 0 };
    assert.equal(await hypeUsd({ fetchFn: upstreams(cb, mids("74.546"), seen), now: clock().now }), 74.546);
    assert.equal(hypePriceSource(), "hyperliquid");
    assert.equal(seen.hlInit?.method, "POST");
    assert.deepEqual(JSON.parse(String(seen.hlInit?.body)), { type: "allMids" });
  }
});

test("memoized for the TTL, then refreshed", async () => {
  resetHypePriceCache();
  const seen = { cb: 0, hl: 0 };
  const c = clock();
  const f = upstreams(spot("74.5"), null, seen);
  await hypeUsd({ fetchFn: f, now: c.now });
  c.advance(HYPE_PRICE_TTL_MS - 1);
  await hypeUsd({ fetchFn: f, now: c.now });
  assert.equal(seen.cb, 1, "inside the TTL: no new fetch");
  c.advance(1);
  await hypeUsd({ fetchFn: f, now: c.now });
  assert.equal(seen.cb, 2, "TTL over: refreshed");
});

test("both down: the last good value for a bounded time, then null (never a day-old price)", async () => {
  resetHypePriceCache();
  const c = clock();
  const seen = { cb: 0, hl: 0 };
  assert.equal(await hypeUsd({ fetchFn: upstreams(spot("74.5"), null, seen), now: c.now }), 74.5);
  const down = upstreams(null, null, seen);
  c.advance(HYPE_PRICE_TTL_MS);
  assert.equal(await hypeUsd({ fetchFn: down, now: c.now }), 74.5, "stale but within the bound");
  c.advance(HYPE_STALE_MAX_MS);
  assert.equal(await hypeUsd({ fetchFn: down, now: c.now }), null, "past the bound: unknown");
  assert.equal(hypePriceSource(), null);
});

test("concurrent callers share one refresh", async () => {
  resetHypePriceCache();
  const seen = { cb: 0, hl: 0 };
  const c = clock();
  const f = upstreams(spot("74.5"), null, seen);
  const all = await Promise.all([hypeUsd({ fetchFn: f, now: c.now }), hypeUsd({ fetchFn: f, now: c.now }), hypeUsd({ fetchFn: f, now: c.now })]);
  assert.deepEqual(all, [74.5, 74.5, 74.5]);
  assert.equal(seen.cb, 1);
});

test("past the TTL a caller never waits on the refresh: the last good value comes back at once", async () => {
  resetHypePriceCache();
  const c = clock();
  const seen = { cb: 0, hl: 0 };
  assert.equal(await hypeUsd({ fetchFn: upstreams(spot("74.5"), null, seen), now: c.now }), 74.5);
  c.advance(HYPE_PRICE_TTL_MS);
  let release: (r: Response) => void = () => {};
  const slow = async () => new Promise<Response>((resolve) => { release = resolve; });
  const t0 = Date.now();
  assert.equal(await hypeUsd({ fetchFn: slow, now: c.now }), 74.5, "served from the memo while the refresh hangs");
  assert.ok(Date.now() - t0 < 1_000);
  release(spot("80")());
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(await hypeUsd({ fetchFn: slow, now: c.now }), 80, "the background refresh replaced it");
});

test("both upstreams bypass Next's data cache: this memo is the only cache", async () => {
  resetHypePriceCache();
  const inits: (RequestInit | undefined)[] = [];
  const f = async (input: string, init?: RequestInit) => { inits.push(init); return input === HYPE_SPOT_URL ? new Response("down", { status: 503 }) : mids("74.5")(); };
  assert.equal(await hypeUsd({ fetchFn: f, now: clock().now }), 74.5);
  assert.equal(inits.length, 2);
  for (const init of inits) {
    assert.equal(init?.cache, "no-store");
    assert.equal((init as { next?: unknown } | undefined)?.next, undefined);
  }
});
