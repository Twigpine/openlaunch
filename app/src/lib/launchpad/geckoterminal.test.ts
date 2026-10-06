import assert from "node:assert/strict";
import test from "node:test";
import { CHAIN_KEYS, type ChainKey } from "../chainKeys.ts";
import { isChartPool, type ChartPool } from "./chart-pool.ts";
import { classifyGeckoPool, geckoChartUrl, lookupGeckoPool, GeckoRateLimitError } from "./geckoterminal.ts";

export const pool: ChartPool = { chain: "base", token: "0x" + "a".repeat(40), quote: "0x" + "0".repeat(40), poolId: "0x" + "b".repeat(64) };
const identityFor = (chain: ChainKey): ChartPool => ({ ...pool, chain, quote: chain === "arc" ? "0x3600000000000000000000000000000000000000" : pool.quote });
export function fixture(identity = pool, price: unknown = "0.12") {
  return { data: { type: "pool", id: identity.chain + "_" + identity.poolId, attributes: { address: identity.poolId, base_token_price_usd: price },
    relationships: { base_token: { data: { type: "token", id: identity.chain + "_" + identity.token } }, quote_token: { data: { type: "token", id: identity.chain + "_" + identity.quote } } } } };
}

test("identities reject unsupported chains, external URLs and identical assets", () => {
  assert.ok(isChartPool(pool));
  for (const change of [{chain:"ethereum"}, {poolId:"https://example.com"}, {token:pool.quote}, {quote:null}, {poolId:pool.token}]) assert.equal(isChartPool({...pool,...change}), false);
});

test("matches exact pools and both token sides on every supported chain, including Arc USDC", () => {
  for (const chain of CHAIN_KEYS) {
    const identity = identityFor(chain);
    assert.equal(classifyGeckoPool(fixture(identity), identity), "ready");
    assert.equal(classifyGeckoPool(fixture(identity), {...identity, token:identity.token.toUpperCase(), poolId:identity.poolId.toUpperCase()}), "ready");
  }
});

test("reversed listings cannot silently chart the quote token", () => {
  for (const chain of CHAIN_KEYS) {
    const identity = identityFor(chain);
    assert.equal(classifyGeckoPool(fixture({...identity, token:identity.quote, quote:identity.token}), identity), "inverted");
  }
});

test("missing or invalid USD pricing falls back without claiming there are no trades", () => {
  for (const chain of CHAIN_KEYS) {
    const identity = identityFor(chain);
    for (const value of [null, undefined, "", "0", "-1", "Infinity", "NaN", {}, true]) {
      const payload = fixture(identity);
      payload.data.attributes.base_token_price_usd = value;
      assert.equal(classifyGeckoPool(payload, identity), "unpriced");
    }
  }
});

test("malformed responses and wrong identities are errors, not missing listings", () => {
  for (const payload of [{}, {data:null}, {data:[]}, fixture({...pool,chain:"robinhood"}),fixture({...pool,poolId:"0x"+"c".repeat(64)}),fixture({...pool,quote:"0x"+"c".repeat(40)})]) assert.throws(()=>classifyGeckoPool(payload,pool));
});

test("Arc never accepts another chain's identity or substitutes native USDC for its ERC-20 quote", () => {
  const arc = identityFor("arc");
  for (const wrong of [{ ...arc, chain: "base" as const }, { ...arc, quote: pool.quote }, { ...arc, token: "0x" + "c".repeat(40) }]) {
    assert.throws(() => classifyGeckoPool(fixture(wrong), arc));
  }
});

test("embed uses official grayscale, theme, canvas, metric and resolution options with intact attribution", () => {
  for (const theme of ["dark","light"] as const) {
    const url = new URL(geckoChartUrl(pool,theme,{interval:"15m",metric:"price"}));
    assert.equal(url.origin,"https://www.geckoterminal.com");
    assert.equal(url.pathname,"/base/pools/"+pool.poolId);
    assert.equal(url.searchParams.get("bg_color"),theme==="dark"?"000000":"fafaf8");
    assert.equal(url.searchParams.get("light_chart"),theme==="dark"?"0":"1");
    assert.equal(url.searchParams.get("grayscale"),"1");
    assert.equal(url.searchParams.get("resolution"),"15m");
    assert.equal(url.searchParams.get("chart_type"),"price");
    assert.equal(url.searchParams.get("info"),"0");
    assert.equal(url.searchParams.get("swaps"),"0");
  }
  assert.equal(new URL(geckoChartUrl(pool,"dark")).search,"");
  assert.throws(()=>geckoChartUrl({...pool,poolId:"//evil.test"},"dark"));
});

test("every supported chain keeps its own Gecko URL and exact pool ID", () => {
  for (const chain of CHAIN_KEYS) {
    const identity = identityFor(chain);
    for (const theme of ["dark", "light"] as const) {
      const embed = new URL(geckoChartUrl(identity, theme, { interval: "1h", metric: "market_cap" }));
      const external = new URL(geckoChartUrl(identity, theme));
      assert.equal(embed.pathname, `/${chain}/pools/${identity.poolId}`);
      assert.equal(external.pathname, embed.pathname);
      assert.equal(external.search, "");
      assert.equal(embed.searchParams.get("chart_type"), "market_cap");
      assert.equal(embed.searchParams.get("resolution"), "1h");
    }
  }
});

test("Arc lookups use the Arc API namespace and preserve missing, unpriced and error outcomes", async () => {
  const arc = identityFor("arc");
  const request = (response: () => Response): typeof fetch => async (url) => {
    assert.equal(url, `https://api.geckoterminal.com/api/v2/networks/arc/pools/${arc.poolId}`);
    return response();
  };
  assert.equal(await lookupGeckoPool(arc, request(() => Response.json(fixture(arc)))), "ready");
  assert.equal(await lookupGeckoPool(arc, request(() => Response.json(fixture(arc, null)))), "unpriced");
  assert.equal(await lookupGeckoPool(arc, request(() => new Response(null, { status: 404 }))), "unlisted");
  await assert.rejects(lookupGeckoPool(arc, request(() => new Response(null, { status: 429 }))), GeckoRateLimitError);
  await assert.rejects(lookupGeckoPool(arc, request(() => new Response(null, { status: 503 }))));
  await assert.rejects(lookupGeckoPool(arc, request(() => new Response("not-json"))));
  await assert.rejects(lookupGeckoPool(arc, async () => { throw new DOMException("Timed out", "TimeoutError"); }));
});

test("lookup uses a fixed origin, times out, distinguishes 404, and respects throttling", async () => {
  const request = async (url: unknown, init?: RequestInit) => {
    assert.equal(url,"https://api.geckoterminal.com/api/v2/networks/base/pools/"+pool.poolId);
    assert.equal(init?.redirect,"error"); assert.equal(init?.cache,"no-store");
    assert.ok(init?.signal); return Response.json(fixture());
  };
  assert.equal(await lookupGeckoPool(pool,request as typeof fetch),"ready");
  assert.equal(await lookupGeckoPool(pool,(async()=>new Response(null,{status:404})) as typeof fetch),"unlisted");
  await assert.rejects(lookupGeckoPool(pool,(async()=>new Response(null,{status:429})) as typeof fetch),GeckoRateLimitError);
  await assert.rejects(lookupGeckoPool(pool,(async()=>new Response(null,{status:500})) as typeof fetch));
});
