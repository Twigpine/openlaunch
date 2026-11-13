import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Connection, PublicKey } from "@solana/web3.js";
import { boundedJson, boundedText } from "./bounded-json";
import { allowedSolanaRpc } from "./rpc-policy";

test("bounded JSON accepts a complete bounded response", async () => {
  assert.deepEqual(await boundedJson(new Response('{"result":1}').body, 12), {
    result: 1,
  });
});
test("bounded JSON rejects oversized chunked input and cancels the stream", async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("12345"));
    },
    cancel() {
      cancelled = true;
    },
  });
  await assert.rejects(boundedJson(body, 4), /size limit/);
  assert.equal(cancelled, true);
});
test("bounded JSON rejects missing and malformed input", async () => {
  await assert.rejects(boundedJson(null, 10));
  await assert.rejects(boundedJson(new Response("invalid").body, 10));
});

test("bounded raw RPC forwarding preserves u64 balances for the v3 lossless parser", async () => {
  const key = new PublicKey(new Uint8Array(32).fill(7));
  const values = [9007199254740993n, 18446744073709551615n];
  for (const value of values) {
    const connection = new Connection("https://offline.invalid", {
      commitment: "confirmed",
      fetch: async (_input, init) => {
        const request = JSON.parse(String(init?.body));
        assert.equal(request.method, "getBalance");
        assert.notEqual(await allowedSolanaRpc(request, key.toBase58()), null);
        // Same bounded text/envelope-validation/raw forwarding used by the proxy. No network request.
        const upstream = new Response(`{"jsonrpc":"2.0","id":${JSON.stringify(request.id)},"result":{"context":{"slot":50},"value":${value}}}`);
        const raw = await boundedText(upstream.body, 4 * 1024 * 1024);
        const envelope = JSON.parse(raw);
        assert.equal(envelope.id, request.id);
        assert.equal(envelope.jsonrpc, "2.0");
        return new Response(raw, { headers: { "content-type": "application/json" } });
      },
    });
    assert.equal(await connection.getBalance(key, { commitment: "confirmed", minContextSlot: 50n }), value);
  }
});

test("bounded text keeps the same byte limit and cancels oversized upstream streams", async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode("12345")); },
    cancel() { cancelled = true; },
  });
  await assert.rejects(boundedText(body, 4), /size limit/);
  assert.equal(cancelled, true);
});
