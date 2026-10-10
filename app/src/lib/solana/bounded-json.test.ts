import { strict as assert } from "node:assert";
import { test } from "node:test";
import { boundedJson } from "./bounded-json";

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
