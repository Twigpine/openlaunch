import assert from "node:assert/strict";
import test from "node:test";
import { createPublicClient, http } from "viem";
import { base } from "viem/chains";
import { keylessHttp } from "./rpc-transport.ts";

const KEYED = "https://base-mainnet.g.alchemy.com/v2/abc123SECRET";

test("a keyed URL is requested in full but never appears in a viem error", async () => {
  const requested: string[] = [];
  const k = keylessHttp(KEYED, async (input) => {
    requested.push(String(input));
    return new Response('{"error":"throughput exceeded"}', { status: 429, headers: { "content-type": "application/json" } });
  });
  assert.match(String(k.url), /^https:\/\/base-mainnet\.g\.alchemy\.com\/upstream-\d+$/);
  const client = createPublicClient({ chain: base, transport: http(k.url, { batch: true, retryCount: 0, fetchFn: k.fetchFn }) });
  const err = await client.getBlockNumber().then(() => null, (e: unknown) => e as Error & { details?: string; cause?: unknown });
  assert.ok(err);
  assert.deepEqual(requested, [KEYED]);
  // the message, and everything hanging off the error (cause chain, meta lines, stack)
  for (const text of [err.message, String(err.stack), JSON.stringify(err, Object.getOwnPropertyNames(err)), String((err.cause as Error | undefined)?.message)]) assert.ok(!text.includes("abc123SECRET"), text);
  assert.match(err.message, /URL: https:\/\/base-mainnet\.g\.alchemy\.com\/upstream-\d+\n/);
});

test("a key in the query string is dropped from the label too", () => {
  assert.match(String(keylessHttp("https://rpc.example.test/?apikey=abc123SECRET").url), /^https:\/\/rpc\.example\.test\/upstream-\d+$/);
});

test("URLs with nothing to hide, unset and unparsable ones pass through unchanged", () => {
  for (const url of [undefined, "", "https://rpc.mainnet.arc.io", "https://rpc.mainnet.arc.io/", "https://user:pass@rpc.example.test", "not a url"]) {
    const k = keylessHttp(url);
    assert.equal(k.url, url);
    assert.equal(k.fetchFn, undefined);
  }
});

test("basic-auth credentials still reach the node as a header, with the keyed path, and neither is quoted", async () => {
  const seen: { url: string; auth: string | null }[] = [];
  const k = keylessHttp("https://user:p%40ss@rpc.example.test/v2/abc123SECRET", async (input, init) => {
    seen.push({ url: String(input), auth: new Headers(init?.headers).get("authorization") });
    return new Response("nope", { status: 500 });
  });
  const client = createPublicClient({ chain: base, transport: http(k.url, { retryCount: 0, fetchFn: k.fetchFn }) });
  const err = await client.getBlockNumber().then(() => null, (e: unknown) => e as Error);
  assert.ok(err);
  assert.deepEqual(seen, [{ url: "https://rpc.example.test/v2/abc123SECRET", auth: `Basic ${btoa("user:p@ss")}` }]);
  for (const secret of ["abc123SECRET", "p%40ss", "p@ss", "user:"]) assert.ok(!err.message.includes(secret), err.message);
});

test("only http(s) URLs are rewritten", () => {
  const k = keylessHttp("ftp://host/v2/abc123SECRET");
  assert.equal(k.url, "ftp://host/v2/abc123SECRET");
  assert.equal(k.fetchFn, undefined);
});

test("two keyed URLs on one host never share a batch: each read goes to its own upstream", async () => {
  // viem merges the requests of one tick by transport URL; with the same label for both, the second chain's reads would ride the first chain's request
  const seen: { url: string; methods: string[] }[] = [];
  const impl = async (input: string | URL | Request, init?: RequestInit) => {
    const calls = JSON.parse(String(init?.body)) as { id: number; method: string }[];
    seen.push({ url: String(input), methods: calls.map((c) => c.method) });
    return Response.json(calls.map((c) => ({ jsonrpc: "2.0", id: c.id, result: String(input).includes("/base/") ? "0xa" : "0xb" })));
  };
  const a = keylessHttp("https://gateway.example.test/base/abc123SECRET", impl);
  const b = keylessHttp("https://gateway.example.test/arc/abc123SECRET", impl);
  assert.notEqual(a.url, b.url);
  assert.equal(keylessHttp("https://gateway.example.test/base/abc123SECRET", impl).url, a.url); // the same upstream keeps one label (and one batch)
  for (const label of [a.url, b.url]) assert.ok(!String(label).includes("abc123SECRET") && !String(label).includes("/base") && !String(label).includes("/arc"), label);
  const clientA = createPublicClient({ chain: base, transport: http(a.url, { batch: true, retryCount: 0, fetchFn: a.fetchFn }) });
  const clientB = createPublicClient({ chain: base, transport: http(b.url, { batch: true, retryCount: 0, fetchFn: b.fetchFn }) });
  const [ga, gb] = await Promise.all([clientA.getGasPrice(), clientB.getGasPrice()]);
  assert.equal(ga, 10n);
  assert.equal(gb, 11n);
  assert.deepEqual(seen.map((r) => r.url).sort(), ["https://gateway.example.test/arc/abc123SECRET", "https://gateway.example.test/base/abc123SECRET"]);
});

test("a URL passed through unchanged and a keyed URL on the same host never share a batch", async () => {
  const seen: string[] = [];
  const impl = async (input: string | URL | Request, init?: RequestInit) => {
    const calls = JSON.parse(String(init?.body)) as { id: number }[];
    seen.push(String(input));
    return Response.json(calls.map((c) => ({ jsonrpc: "2.0", id: c.id, result: String(input).includes("/v2/") ? "0xb" : "0xa" })));
  };
  for (const root of ["https://shared.example.test", "https://shared.example.test/"]) {
    seen.length = 0;
    const plain = keylessHttp(root);
    const keyed = keylessHttp("https://shared.example.test/v2/abc123SECRET", impl);
    assert.equal(plain.url, root);
    assert.notEqual(keyed.url, root);
    // the unchanged URL has no fetchFn of its own: the test gives viem one, as viem would use the global fetch
    const clientPlain = createPublicClient({ chain: base, transport: http(plain.url, { batch: true, retryCount: 0, fetchFn: impl }) });
    const clientKeyed = createPublicClient({ chain: base, transport: http(keyed.url, { batch: true, retryCount: 0, fetchFn: keyed.fetchFn }) });
    const [a, b] = await Promise.all([clientPlain.getGasPrice(), clientKeyed.getGasPrice()]);
    assert.equal(a, 10n);
    assert.equal(b, 11n);
    assert.deepEqual([...seen].sort(), [new URL(root).toString(), "https://shared.example.test/v2/abc123SECRET"].sort());
  }
});
