import assert from "node:assert/strict";
import test from "node:test";
import { createPublicClient, encodeFunctionData, HttpRequestError, http, parseAbi } from "viem";
import { base } from "viem/chains";
import { POST } from "./route.ts";

type RpcCall = { jsonrpc: string; id: number | string; method: string; params?: unknown[] };
const call = (id: number | string, method: string): RpcCall => ({ jsonrpc: "2.0", id, method, params: [] });
const result = (id: number | string, value = "0x2105") => ({ jsonrpc: "2.0", id, result: value });
const batchError = { jsonrpc: "2.0", id: null, error: { code: -32000, message: "batch unsupported: private upstream diagnostic" } };
const approval = {
  account: "0x1111111111111111111111111111111111111111" as const,
  to: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const,
  value: 0n,
  data: encodeFunctionData({ abi: parseAbi(["function approve(address spender, uint256 amount) returns (bool)"]), functionName: "approve", args: ["0x4cd00e387622c35bddb9b4c962c136462338bc31", 1_000_000n] }),
};
let sequence = 0;
function request(body: unknown, chain = "base") {
  return new Request(`http://localhost/api/rpc?chain=${chain}`, {
    method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": `rpc-test-${++sequence}` }, body: JSON.stringify(body),
  });
}
function upstreamBody(init?: RequestInit): RpcCall[] {
  const body = JSON.parse(String(init?.body));
  return Array.isArray(body) ? body : [body];
}

test("mixed batches reject optional/write methods without poisoning allowed reads", async (t) => {
  const forwarded: RpcCall[][] = [];
  t.mock.method(globalThis, "fetch", async (_input: unknown, init?: RequestInit) => {
    const calls = upstreamBody(init);
    forwarded.push(calls);
    return Response.json(calls.map((r) => result(r.id)).reverse());
  });
  const response = await POST(request([call(1, "eth_chainId"), call(2, "eth_fillTransaction"), call(3, "eth_estimateGas"), call(4, "eth_sendRawTransaction")]));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = await response.json();
  assert.equal(body.length, 4);
  assert.deepEqual(forwarded[0].map((r) => r.method), ["eth_chainId", "eth_estimateGas"]);
  for (const id of [1, 3]) assert.deepEqual(body.find((r: { id: number }) => r.id === id), result(id));
  for (const id of [2, 4]) assert.equal(body.find((r: { id: number }) => r.id === id).error.code, -32601);
});

test("actual viem batches the unsupported probe with a one-USDC approval gas estimate", async (t) => {
  const batches: RpcCall[][] = [];
  t.mock.method(globalThis, "fetch", async (_input: unknown, init?: RequestInit) => Response.json(
    upstreamBody(init).map((r) => result(r.id, r.method === "eth_chainId" ? "0x2105" : "0x10000")).reverse(),
  ));
  const transport = http("http://localhost/api/rpc?chain=base", {
    batch: true, retryCount: 0, fetchFn: (input, init) => {
      batches.push(upstreamBody(init));
      return POST(new Request(input, init));
    },
  });
  const client = createPublicClient({ chain: base, transport });
  const probe = transport({ chain: base, retryCount: 0 }).request({ method: "eth_fillTransaction", params: [{}] });
  const results = await Promise.allSettled([probe, client.getChainId(), client.estimateGas(approval)]);
  assert.equal(batches.length, 1);
  assert.deepEqual(batches[0].map((r) => r.method).sort(), ["eth_chainId", "eth_estimateGas", "eth_fillTransaction"]);
  assert.equal(results[0].status, "rejected");
  if (results[0].status === "rejected") {
    assert.equal(results[0].reason.code, -32601);
    assert.doesNotMatch(results[0].reason.message, /undefined|Cannot read properties/);
  }
  assert.deepEqual(results[1], { status: "fulfilled", value: 8453 });
  assert.deepEqual(results[2], { status: "fulfilled", value: 65536n });
});

test("a malformed top-level batch error becomes an HTTP error and viem retries successfully", async (t) => {
  let attempts = 0;
  const statuses: number[] = [];
  t.mock.method(globalThis, "fetch", async (_input: unknown, init?: RequestInit) => {
    attempts++;
    if (attempts === 1) return Response.json(batchError);
    return Response.json(upstreamBody(init).map((r) => result(r.id, "0x10000")));
  });
  const client = createPublicClient({ chain: base, transport: http("http://localhost/api/rpc?chain=base", {
    batch: true, retryCount: 1, retryDelay: 0,
    fetchFn: async (input, init) => {
      const response = await POST(new Request(input, init));
      statuses.push(response.status);
      if (response.status !== 200) {
        const body = await response.clone().json();
        assert.equal(typeof body.error, "string");
        assert.equal(body.jsonrpc, undefined);
        assert.doesNotMatch(JSON.stringify(body), /private upstream diagnostic/);
      }
      return response;
    },
  }) });
  assert.equal(await client.estimateGas(approval), 65536n);
  assert.equal(attempts, 2);
  assert.deepEqual(statuses, [502, 200]);
});

test("persistent malformed batch errors yield HTTP errors, never viem's undefined-error crash", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json(batchError));
  const client = createPublicClient({ chain: base, transport: http("http://localhost/api/rpc?chain=base", {
    batch: true, retryCount: 0, fetchFn: (input, init) => POST(new Request(input, init)),
  }) });
  const outcomes = await Promise.allSettled([client.getChainId(), client.estimateGas(approval)]);
  for (const outcome of outcomes) {
    assert.equal(outcome.status, "rejected");
    if (outcome.status !== "rejected") continue;
    const cause = outcome.reason.walk((error: unknown) => error instanceof HttpRequestError);
    assert.ok(cause instanceof HttpRequestError);
    assert.equal(cause.status, 502);
    assert.doesNotMatch(outcome.reason.message, /Cannot read properties|reading 'error'|private upstream diagnostic/);
  }
});

test("all-denied requests never reach the upstream and retain Kevin's normal JSON-RPC response", async (t) => {
  const upstream = t.mock.method(globalThis, "fetch", async () => { throw new Error("must not forward"); });
  const response = await POST(request([call(1, "eth_sendTransaction"), call(2, "personal_sign")]));
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).map((r: { id: number; error: { code: number } }) => [r.id, r.error.code]), [[1, -32601], [2, -32601]]);
  const single = await POST(request(call(3, "eth_fillTransaction")));
  assert.equal(single.status, 200);
  assert.equal((await single.json()).error.code, -32601);
  assert.equal(upstream.mock.callCount(), 0);
});

test("out-of-order valid responses retain each request's ID and value", async (t) => {
  const replies = [result("second", "0x2"), result("first", "0x1")];
  t.mock.method(globalThis, "fetch", async () => Response.json(replies));
  const response = await POST(request([call("first", "eth_chainId"), call("second", "eth_blockNumber")]));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), replies);
});

test("wrong, duplicate, missing and malformed response items fail closed with non-RPC 502 bodies", async (t) => {
  for (const value of [
    batchError, [], [result(2)], [result(1), result(99)], [result(1), result(1)],
    [{ jsonrpc: "2.0", id: 1 }, result(2)],
    [{ ...result(1), error: { code: -32603, message: "contradictory" } }, result(2)],
    [{ jsonrpc: "2.0", id: 1, error: { code: "-32603", message: "wrong type" } }, result(2)],
    [{ ...result(1), jsonrpc: "1.0" }, result(2)],
  ]) {
    const upstream = t.mock.method(globalThis, "fetch", async () => Response.json(value));
    const response = await POST(request([call(1, "eth_estimateGas"), call(2, "eth_getBalance")]));
    assert.equal(response.status, 502);
    const body = await response.json();
    assert.equal(typeof body.error, "string");
    assert.equal(body.jsonrpc, undefined);
    assert.doesNotMatch(JSON.stringify(body), /private upstream diagnostic/);
    upstream.mock.restore();
  }
});

test("upstream 429 and non-200 JSON-RPC objects keep retryable HTTP semantics", async (t) => {
  for (const status of [429, 502, 503]) {
    const upstream = t.mock.method(globalThis, "fetch", async () => Response.json(batchError, { status }));
    const response = await POST(request([call(1, "eth_chainId"), call(2, "eth_fillTransaction")]));
    assert.equal(response.status, status);
    assert.equal(typeof (await response.json()).error, "string");
    if (status === 429) assert.equal(response.headers.get("retry-after"), "1");
    upstream.mock.restore();
  }
  t.mock.method(globalThis, "fetch", async () => Response.json([{ jsonrpc: "2.0", id: 1, error: { code: -32016, message: "over rate limit" } }]));
  const limited = await POST(request([call(1, "eth_chainId")]));
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("retry-after"), "1");
  assert.equal(typeof (await limited.json()).error, "string");
});

test("upstream fetch failures remain retryable non-RPC HTTP errors", async (t) => {
  t.mock.method(globalThis, "fetch", async () => { throw new Error("RPC unavailable"); });
  const response = await POST(request([call(1, "eth_chainId"), call(2, "eth_fillTransaction")]));
  assert.equal(response.status, 502);
  const body = await response.json();
  assert.equal(typeof body.error, "string");
  assert.equal(body.jsonrpc, undefined);
});

test("Base B20 fallback still receives only allowed reads", async (t) => {
  const forwarded: RpcCall[][] = [];
  t.mock.method(globalThis, "fetch", async (_input: unknown, init?: RequestInit) => {
    const calls = upstreamBody(init);
    forwarded.push(calls);
    return Response.json(forwarded.length === 1 ? [{ jsonrpc: "2.0", id: 1, error: { code: -32603, message: "EVM error OpcodeNotFound" } }] : [result(1, "0x42")]);
  });
  const response = await POST(request([call(1, "eth_call"), call(2, "eth_fillTransaction")]));
  assert.equal(forwarded.length, 2);
  for (const calls of forwarded) assert.deepEqual(calls.map((r) => r.method), ["eth_call"]);
  assert.deepEqual((await response.json()).find((r: { id: number }) => r.id === 1), result(1, "0x42"));
});

test("Arc routing uses its configured server upstream with the same read-only allowlist", async (t) => {
  const previous = process.env.ARC_RPC_URL;
  process.env.ARC_RPC_URL = "https://arc-rpc.example.test/private-test-key";
  t.after(() => { if (previous === undefined) delete process.env.ARC_RPC_URL; else process.env.ARC_RPC_URL = previous; });
  t.mock.method(globalThis, "fetch", async (input: unknown, init?: RequestInit) => {
    assert.equal(input, process.env.ARC_RPC_URL);
    const calls = upstreamBody(init);
    assert.deepEqual(calls.map((r) => r.method), ["eth_chainId"]);
    return Response.json(calls.map((r) => result(r.id, "0x13b2")));
  });
  const response = await POST(request([call(1, "eth_chainId"), call(2, "eth_sendRawTransaction")], "arc"));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body[0], result(1, "0x13b2"));
  assert.equal(body[1].error.code, -32601);
});

test("bridge funding networks read through public nodes by default, a keyed URL when set, with the same allowlist", async (t) => {
  const envs = ["ETHEREUM_RPC_URL", "ARBITRUM_RPC_URL", "OPTIMISM_RPC_URL"] as const;
  const previous = Object.fromEntries(envs.map((name) => [name, process.env[name]]));
  t.after(() => { for (const name of envs) { if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name]; } });
  for (const name of envs) delete process.env[name];
  const seen: unknown[] = [];
  t.mock.method(globalThis, "fetch", async (input: unknown, init?: RequestInit) => {
    seen.push(input);
    const calls = upstreamBody(init);
    assert.deepEqual(calls.map((r) => r.method), ["eth_getBalance"]);
    return Response.json(calls.map((r) => result(r.id, "0x1")));
  });
  for (const chain of ["ethereum", "arbitrum", "optimism"]) {
    const response = await POST(request([call(1, "eth_getBalance"), call(2, "eth_sendRawTransaction")], chain));
    assert.equal(response.status, 200, chain);
    const body = await response.json();
    assert.deepEqual(body[0], result(1, "0x1"));
    assert.equal(body[1].error.code, -32601, chain);
  }
  assert.deepEqual(seen, ["https://ethereum-rpc.publicnode.com", "https://arb1.arbitrum.io/rpc", "https://mainnet.optimism.io"]);
  process.env.ARBITRUM_RPC_URL = "https://arb-rpc.example.test/private-test-key";
  await POST(request([call(1, "eth_getBalance")], "arbitrum"));
  assert.equal(seen.at(-1), "https://arb-rpc.example.test/private-test-key");
});

test("an unknown chain key is refused before any upstream call", async (t) => {
  const upstream = t.mock.method(globalThis, "fetch", async () => Response.json(result(1)));
  for (const chain of ["polygon", "mainnet", "__proto__", "constructor", "1", "ETHEREUM"]) {
    const response = await POST(request(call(1, "eth_chainId"), chain));
    assert.equal(response.status, 400, chain);
  }
  assert.equal(upstream.mock.callCount(), 0);
});

test("single allowed reads keep their response shape; empty and oversized batches are rejected", async (t) => {
  const upstream = t.mock.method(globalThis, "fetch", async () => Response.json(result(1)));
  const single = await POST(request(call(1, "eth_chainId")));
  assert.deepEqual(await single.json(), result(1));
  assert.equal((await POST(request([]))).status, 400);
  assert.equal((await POST(request(Array.from({ length: 21 }, (_, id) => call(id, "eth_chainId"))))).status, 400);
  assert.equal(upstream.mock.callCount(), 1);
});
