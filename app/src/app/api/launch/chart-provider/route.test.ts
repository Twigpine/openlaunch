import assert from "node:assert/strict";
import test from "node:test";
import { GET } from "./route";
const identity={chain:"base",token:"0x"+"a".repeat(40),quote:"0x"+"0".repeat(40),pool:"0x"+"b".repeat(64)};
function request(overrides: Partial<typeof identity> = {}, ip="chart-test") {
  return new Request("http://localhost/api/launch/chart-provider?"+new URLSearchParams({...identity,...overrides}),{headers:{"fly-client-ip":ip}});
}
test("route validates without network, serves classified data, and rate limits clients",async(t)=>{
  let now=Date.now();t.mock.method(Date,"now",()=>now);
  const response={data:{type:"pool",id:"base_"+identity.pool,attributes:{address:identity.pool,base_token_price_usd:"1"},
    relationships:{base_token:{data:{type:"token",id:"base_"+identity.token}},quote_token:{data:{type:"token",id:"base_"+identity.quote}}}}};
  const upstream=t.mock.method(globalThis,"fetch",async()=>Response.json(response));
  for(const bad of [{chain:"ethereum"},{pool:"https://evil.test"},{token:identity.quote}]) assert.equal((await GET(request(bad))).status,400);
  assert.equal(upstream.mock.callCount(),0);
  const result=await GET(request());assert.equal(result.status,200);assert.deepEqual(await result.json(),{status:"ready"});
  assert.equal(result.headers.get("cache-control"),"no-store");
  await GET(request());assert.equal(upstream.mock.callCount(),1);
  const mismatch=await GET(request({quote:"0x"+"c".repeat(40)}));assert.equal(mismatch.status,503);
  assert.equal(mismatch.headers.get("retry-after"),"60");
  now+=60_001;
  for(let i=0;i<60;i++) assert.equal((await GET(request({},"limited"))).status,200);
  assert.equal((await GET(request({},"limited"))).status,429);
  now+=60_001;assert.equal((await GET(request({},"limited"))).status,200);
});

test("Arc provider route preserves exact identity and recoverable listing, pricing and upstream failures", async (t) => {
  let now = Date.now() + 300_000;
  t.mock.method(Date, "now", () => now);
  const arc = { ...identity, chain: "arc", quote: "0x3600000000000000000000000000000000000000" };
  const payload = (pool: string, price: unknown = "0.00001") => ({ data: {
    type: "pool", id: `arc_${pool}`, attributes: { address: pool, base_token_price_usd: price },
    relationships: {
      base_token: { data: { type: "token", id: `arc_${arc.token}` } },
      quote_token: { data: { type: "token", id: `arc_${arc.quote}` } },
    },
  } });
  const scenarios: { name: string; response: (pool: string) => Response; status: number; lookup?: string }[] = [
    { name: "listed", response: (pool) => Response.json(payload(pool)), status: 200, lookup: "ready" },
    { name: "missing", response: () => new Response(null, { status: 404 }), status: 200, lookup: "unlisted" },
    { name: "unpriced", response: (pool) => Response.json(payload(pool, null)), status: 200, lookup: "unpriced" },
    { name: "reversed", response: (pool) => {
      const data = payload(pool);
      [data.data.relationships.base_token, data.data.relationships.quote_token] = [data.data.relationships.quote_token, data.data.relationships.base_token];
      return Response.json(data);
    }, status: 200, lookup: "inverted" },
    { name: "upstream failure", response: () => new Response(null, { status: 500 }), status: 503 },
    { name: "malformed", response: () => Response.json({ data: [] }), status: 503 },
    { name: "timeout", response: () => { throw new DOMException("Timed out", "TimeoutError"); }, status: 503 },
    { name: "wrong quote", response: (pool) => {
      const data = payload(pool);
      data.data.relationships.quote_token.data.id = `arc_${identity.quote}`;
      return Response.json(data);
    }, status: 503 },
  ];
  let upstreamResponse: (pool: string) => Response;
  const upstream = t.mock.method(globalThis, "fetch", async (url: unknown) => {
    const target = new URL(String(url));
    assert.equal(target.origin, "https://api.geckoterminal.com");
    assert.ok(target.pathname.startsWith("/api/v2/networks/arc/pools/"));
    return upstreamResponse(target.pathname.split("/").at(-1)!);
  });
  for (const [index, scenario] of scenarios.entries()) {
    now += 60_001;
    upstreamResponse = scenario.response;
    const current = { ...arc, pool: "0x" + (index + 100).toString(16).padStart(64, "0") };
    const result = await GET(request(current, "arc-chart-test"));
    assert.equal(result.status, scenario.status, scenario.name);
    assert.equal(result.headers.get("cache-control"), "no-store");
    if (scenario.lookup) assert.deepEqual(await result.json(), { status: scenario.lookup });
    else {
      assert.match((await result.json()).error, /On-chain history is still available/);
      assert.equal(result.headers.get("retry-after"), "60");
      const calls = upstream.mock.callCount();
      upstreamResponse = (pool) => Response.json(payload(pool));
      assert.deepEqual(await (await GET(request(current, "arc-chart-test"))).json(), { status: "ready" });
      assert.equal(upstream.mock.callCount(), calls + 1, "errors must not be cached as absent pools");
    }
  }
});
