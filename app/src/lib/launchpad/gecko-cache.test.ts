import assert from "node:assert/strict";
import test from "node:test";
import { createGeckoCache } from "./gecko-cache.ts";
import { GeckoRateLimitError, type GeckoStatus } from "./geckoterminal.ts";
import type { ChartPool } from "./chart-pool.ts";

const pool: ChartPool = { chain:"base", token:"0x"+"a".repeat(40), quote:"0x"+"0".repeat(40), poolId:"0x"+"b".repeat(64) };
test("cache deduplicates, includes all identities, and expires positive/negative entries separately", async () => {
  let now=1, calls=0;
  let status: GeckoStatus="ready";
  const get=createGeckoCache(async()=>{calls++;return status;},()=>now);
  assert.deepEqual(await Promise.all([get(pool),get({...pool,token:pool.token.toUpperCase()})]),["ready","ready"]);
  assert.equal(calls,1);
  now+=60_001; await get(pool); assert.equal(calls,1);
  await get({...pool,quote:"0x"+"c".repeat(40)}); assert.equal(calls,2);
  now+=900_001; status="unpriced"; assert.equal(await get(pool),"unpriced"); assert.equal(calls,3);
  now+=60_001; status="ready"; assert.equal(await get(pool),"ready"); assert.equal(calls,4);
});
test("provider errors are retryable and 429 cooldown does not block cached pools", async () => {
  let now=1, fail=false, calls=0;
  const get=createGeckoCache(async()=>{calls++;if(fail)throw new GeckoRateLimitError();return "ready";},()=>now);
  await get(pool); fail=true;
  const other={...pool,poolId:"0x"+"c".repeat(64)};
  await assert.rejects(get(other));
  fail=false; await assert.rejects(get(other)); assert.equal(calls,2);
  assert.equal(await get(pool),"ready");
  now+=60_001; assert.equal(await get(other),"ready"); assert.equal(calls,3);
});
test("uncached lookups are bounded to ten a minute while cache hits still work", async () => {
  let now=1,calls=0;
  const get=createGeckoCache(async()=>{calls++;return "unlisted";},()=>now);
  for(let i=0;i<10;i++) await get({...pool,poolId:"0x"+i.toString(16).padStart(64,"0")});
  await assert.rejects(get(pool)); assert.equal(calls,10);
  await get({...pool,poolId:"0x"+"0".repeat(64)}); assert.equal(calls,10);
  now+=60_001; await get(pool); assert.equal(calls,11);
});
test("only two distinct upstream requests can be in flight", async () => {
  let finish!: (value: GeckoStatus)=>void;
  const get=createGeckoCache(()=>new Promise(resolve=>{finish=resolve;}));
  const first=get(pool);
  await Promise.resolve(); const finishFirst=finish;
  const second=get({...pool,poolId:"0x"+"c".repeat(64)});
  await Promise.resolve();
  await assert.rejects(get({...pool,poolId:"0x"+"d".repeat(64)}));
  finishFirst("ready");finish("ready"); await Promise.all([first,second]);
});

test("Arc metadata never inherits a same-address Base or Robinhood listing", async () => {
  const seen: string[] = [];
  const get = createGeckoCache(async (identity) => {
    seen.push(identity.chain);
    return identity.chain === "arc" ? "unpriced" : "ready";
  });
  assert.equal(await get(pool), "ready");
  assert.equal(await get({ ...pool, chain: "robinhood" }), "ready");
  assert.equal(await get({ ...pool, chain: "arc" }), "unpriced");
  assert.equal(await get({ ...pool, chain: "arc" }), "unpriced");
  assert.deepEqual(seen, ["base", "robinhood", "arc"]);
});
