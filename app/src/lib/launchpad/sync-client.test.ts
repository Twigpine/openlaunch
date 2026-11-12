import assert from "node:assert/strict";
import test from "node:test";
import { syncTransaction } from "./sync-client.ts";

const hash = `0x${"ab".repeat(32)}` as const;
const token = `0x${"12".repeat(20)}`;
for (const [body, expected] of [
  [{ status: "applied", tokens: [token, "bad", null] }, { status: "applied", tokens: [token] }],
  [{ status: "not_found" }, { status: "pending" }],
  [{ status: "pending" }, { status: "pending" }],
  [{ status: "skipped", reason: "rebuilding" }, { status: "pending" }],
  [{ status: "reverted" }, { status: "reverted" }],
  [{ status: "unexpected" }, { status: "error" }],
  [null, { status: "error" }],
] as const) test(`receipt sync classifies ${JSON.stringify(body)} without wallet side effects`, async (t) => {
  const requests: unknown[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, options: RequestInit) => { requests.push([url, options.method]); return Response.json(body); });
  assert.deepEqual(await syncTransaction("base", hash), expected);
  assert.deepEqual(requests, [[`/api/launch/sync?chain=base&tx=${hash}`, "POST"]]);
});
for (const status of [429, 502]) test(`HTTP ${status} cannot throw a sent transaction into a wallet retry`, async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response("unavailable", { status }));
  assert.deepEqual(await syncTransaction("base", hash), { status: "error" });
});
test("network and malformed JSON failures remain recoverable", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", async () => { throw new Error("offline"); });
  assert.deepEqual(await syncTransaction("base", hash), { status: "error" });
  fetch.mock.mockImplementation(async () => new Response("not JSON"));
  assert.deepEqual(await syncTransaction("base", hash), { status: "error" });
});

test("an unmounted recovery check aborts its request without changing the sent outcome", async (t) => {
  t.mock.method(globalThis, "fetch", async (_url: string, options: RequestInit) => new Promise<Response>((_resolve, reject) => {
    options.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  }));
  const controller = new AbortController();
  const pending = syncTransaction("base", hash, controller.signal);
  controller.abort();
  assert.deepEqual(await pending, { status: "error" });
});
