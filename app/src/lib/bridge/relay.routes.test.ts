import assert from "node:assert/strict";
import { test } from "node:test";
import { POST } from "../../app/api/bridge/quote/route.ts";
import { GET } from "../../app/api/bridge/status/route.ts";
import { BASE_USDC } from "./types.ts";
import { FIXTURE_INPUT, FIXTURE_NOW, addApprovalFixture, relayChainsFixture, relayRouteFixture } from "./relay.fixture.ts";
// these requests stand for ones Fly Proxy delivered: clientIp reads fly-client-ip only on a Fly Machine
process.env.FLY_APP_NAME ??= "openlaunch-test";

function quoteRequest(body: string, ip: string, headers: Record<string, string> = {}) {
  return new Request("https://openlaunch.example/api/bridge/quote", { method: "POST", body, headers: { "Content-Type": "application/json", "fly-client-ip": ip, ...headers } });
}

test("HTTP quote boundary rejects declared and streamed oversized bodies and unsupported content types", async () => {
  assert.equal((await POST(quoteRequest("{}", "bridge-limit-header", { "Content-Length": "5000" }))).status, 413);
  assert.equal((await POST(quoteRequest(" ".repeat(3000), "bridge-limit-stream"))).status, 413);
  assert.equal((await POST(quoteRequest("{}", "bridge-content-type", { "Content-Type": "text/plain" }))).status, 415);
  const invalid = await POST(quoteRequest("null", "bridge-null-json"));
  assert.equal(invalid.status, 400);
  assert.match(invalid.headers.get("cache-control")!, /private, no-store/);
});

test("HTTP quote rate limit runs before malformed body parsing", async () => {
  for (let i = 0; i < 20; i++) assert.equal((await POST(quoteRequest("{", "bridge-rate-test"))).status, 400);
  const limited = await POST(quoteRequest("{", "bridge-rate-test"));
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("retry-after"), "5");
  assert.match(limited.headers.get("cache-control")!, /no-store/);
});

test("HTTP status boundary rejects malformed and duplicate IDs with private responses", async () => {
  for (const query of ["", "requestId=https%3A%2F%2Fattacker.example", "requestId=bad&requestId=bad", "url=https%3A%2F%2Fattacker.example"]) {
    const response = await GET(new Request(`https://openlaunch.example/api/bridge/status?${query}`, { headers: { "fly-client-ip": "bridge-status-invalid" } }));
    assert.equal(response.status, 400);
    assert.match(response.headers.get("cache-control")!, /private, no-store/);
  }
});

test("HTTP quote accepts explicit Base USDC and preserves exact asset selection", async (t) => {
  const { input, quote } = relayRouteFixture(8453, 5042, "USDC", "USDC");
  addApprovalFixture(quote, input);
  t.mock.method(Date, "now", () => FIXTURE_NOW);
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    if (url.endsWith("/chains")) return Response.json(relayChainsFixture());
    const request = JSON.parse(String(init.body));
    assert.equal(request.originCurrency, BASE_USDC);
    assert.equal(request.amount, "25000000");
    return Response.json(quote);
  });
  const response = await POST(quoteRequest(JSON.stringify(input), "bridge-base-usdc-valid"));
  assert.equal(response.status, 200);
  assert.match(response.headers.get("cache-control")!, /private, no-store/);
  const body = await response.json();
  assert.equal(body.originAsset, "USDC");
  assert.equal(body.destinationAsset, "USDC");
  assert.equal(body.approval.token, BASE_USDC);
  assert.equal(body.transaction.value, "0");
});

test("HTTP quote rejects unsupported assets and injected fields before contacting Relay", async (t) => {
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => { requests++; return Response.json({}); });
  for (const [index, mutation] of [
    { destinationAsset: "USDC" }, { originAsset: "USDT" }, { originAsset: null },
    { originChainId: 5042, originAsset: "ETH" }, { originCurrency: BASE_USDC },
  ].entries()) {
    const response = await POST(quoteRequest(JSON.stringify({ ...FIXTURE_INPUT, ...mutation }), `bridge-assets-invalid-${index}`));
    assert.equal(response.status, 400);
  }
  assert.equal(requests, 0);
});

test("HTTP quote rejects ERC20 unlimited-approval amounts before contacting Relay", async (t) => {
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => { requests++; return Response.json({}); });
  for (const originChainId of [8453, 5042]) {
    const input = { ...FIXTURE_INPUT, originChainId, originAsset: "USDC", amount: ((1n << 256n) - 1n).toString() };
    const response = await POST(quoteRequest(JSON.stringify(input), `bridge-unlimited-${originChainId}`));
    assert.equal(response.status, 400);
  }
  assert.equal(requests, 0);
});
