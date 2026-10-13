import { test } from "node:test";
import assert from "node:assert/strict";
import { readObject } from "./imageStore.ts";

const KEY = `t/${"a".repeat(48)}.webp`;
const body = (bytes: number[]) => ({ transformToByteArray: async () => Uint8Array.from(bytes) });
const client = (send: (command: unknown, options?: { abortSignal?: AbortSignal }) => Promise<unknown>) => ({ send }) as unknown as Parameters<typeof readObject>[0];

test("a read that never answers is a miss within the timeout, and the request is aborted", async () => {
  let signal: AbortSignal | undefined;
  const hang = client((_command, options) => { signal = options?.abortSignal; return new Promise(() => {}); });
  const started = Date.now();
  assert.equal(await readObject(hang, "bucket", KEY, 40), null);
  assert.ok(Date.now() - started < 1_000, "returned about when the timeout fired");
  assert.equal(signal?.aborted, true, "the SDK call was handed a signal and it fired");
});

test("a body that stalls after the headers is also a miss", async () => {
  const stalled = client(async () => ({ Body: { transformToByteArray: () => new Promise(() => {}) } }));
  assert.equal(await readObject(stalled, "bucket", KEY, 40), null);
});

test("a rejected read is a miss, never a throw", async () => {
  assert.equal(await readObject(client(async () => { throw new Error("NoSuchKey"); }), "bucket", KEY, 40), null);
});

test("a fast read returns its bytes", async () => {
  const got = await readObject(client(async () => ({ Body: body([1, 2, 3]) })), "bucket", KEY, 1_000);
  assert.deepEqual([...got!], [1, 2, 3]);
});
