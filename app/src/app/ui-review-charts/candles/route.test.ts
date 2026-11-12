import assert from "node:assert/strict";
import test from "node:test";
import { GET } from "./route";
import { REVIEW_POOLS } from "../pools";
import { CHAIN_KEYS } from "@/lib/chainKeys";

test("preview is production-disabled and forwards only allowlisted public candle parameters", async (t) => {
  const original = process.env.NODE_ENV;
  try {
    const pool = REVIEW_POOLS[0];
    const query = new URLSearchParams({ chain: pool.chain, token: pool.token, interval: "15m", wallet: "must-not-leak" });
    const request = () => new Request("http://localhost/ui-review-charts/candles?" + query, { headers: { cookie: "private=must-not-leak" } });
    const upstream = t.mock.method(globalThis, "fetch", async (url: unknown, init?: RequestInit) => {
      const target = new URL(String(url));
      assert.equal(target.origin, "https://openlaunch.lol");
      assert.equal(target.pathname, "/api/launch/candles");
      assert.equal(target.searchParams.get("chain"), query.get("chain"));
      assert.equal(target.searchParams.get("token"), query.get("token"));
      assert.equal(target.searchParams.has("wallet"), false);
      assert.deepEqual(init?.headers, { accept: "application/json" });
      assert.equal(init?.redirect, "error");
      return Response.json({ candles: [] });
    });
    Object.assign(process.env, { NODE_ENV: "production" });
    assert.equal((await GET(request())).status, 404);
    assert.equal(upstream.mock.callCount(), 0);
    Object.assign(process.env, { NODE_ENV: "development" });
    query.set("token", "0x" + "f".repeat(40));
    assert.equal((await GET(request())).status, 400);
    assert.equal(upstream.mock.callCount(), 0);
    for (const chain of CHAIN_KEYS) {
      const example = REVIEW_POOLS.find((candidate) => candidate.chain === chain);
      assert.ok(example, `missing a public ${chain} preview`);
      query.set("chain", chain);
      query.set("token", example.token);
      assert.equal((await GET(request())).status, 200);
    }
    assert.equal(upstream.mock.callCount(), CHAIN_KEYS.length);
  } finally {
    if (original === undefined) delete process.env.NODE_ENV;
    else Object.assign(process.env, { NODE_ENV: original });
  }
});
