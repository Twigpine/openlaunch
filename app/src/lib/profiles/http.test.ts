import assert from "node:assert/strict";
import test from "node:test";
import { readBody, readJson } from "./http.ts";

function streamed(chunks: Uint8Array[], contentLength?: string, cancel?: () => void | Promise<void>) {
  const state = { pulled: 0, cancelled: 0 };
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (state.pulled === chunks.length) { controller.close(); return; }
      controller.enqueue(chunks[state.pulled++]);
    },
    cancel() { state.cancelled++; return cancel?.(); },
  }, { highWaterMark: 0 });
  const request = new Request("http://localhost/", {
    method: "POST", body, duplex: "half", ...(contentLength === undefined ? {} : { headers: { "content-length": contentLength } }),
  } as RequestInit);
  return { request, state };
}

test("readBody accepts exactly the byte limit and releases its reader", async () => {
  const { request, state } = streamed([Uint8Array.of(1, 2), Uint8Array.of(3, 4)]);
  assert.deepEqual(await readBody(request, 4), { ok: true, bytes: Uint8Array.of(1, 2, 3, 4) });
  assert.equal(state.cancelled, 0);
  assert.equal(request.body?.locked, false);
  assert.deepEqual(await readBody(new Request("http://localhost/"), 4), { ok: true, bytes: new Uint8Array(0) });
});

test("readBody rejects declared oversize without pulling any bytes", async () => {
  const { request, state } = streamed([Uint8Array.of(1), Uint8Array.of(2)], "999999999999999999999999999999");
  assert.deepEqual(await readBody(request, 4), { ok: false, reason: "too_large" });
  assert.deepEqual(state, { pulled: 0, cancelled: 1 });
  assert.equal(request.body?.locked, false);
});

test("readBody stops at the first overflowing chunk despite absent or misleading lengths", async () => {
  for (const length of [undefined, "1", "-1", "invalid", "Infinity"]) {
    const { request, state } = streamed(Array.from({ length: 10 }, () => Uint8Array.of(1, 2, 3)), length);
    assert.deepEqual(await readBody(request, 4), { ok: false, reason: "too_large" }, String(length));
    assert.deepEqual(state, { pulled: 2, cancelled: 1 }, "the rest of the finite stream is never read");
    assert.equal(request.body?.locked, false);
  }
});

test("readBody rejects oversize even if cancellation rejects or never resolves", { timeout: 1_000 }, async () => {
  for (const cancel of [() => Promise.reject(new Error("synthetic cancel failure")), () => new Promise<void>(() => {})]) {
    const { request, state } = streamed([Uint8Array.of(1, 2), Uint8Array.of(3, 4)], undefined, cancel);
    assert.deepEqual(await readBody(request, 1), { ok: false, reason: "too_large" });
    assert.equal(state.cancelled, 1);
    assert.equal(request.body?.locked, false);
  }
});

test("readBody reports failed or locked streams without retaining its own lock", async () => {
  const body = new ReadableStream<Uint8Array>({ pull(controller) { controller.error(new Error("synthetic body failure")); } }, { highWaterMark: 0 });
  const request = new Request("http://localhost/", { method: "POST", body, duplex: "half" } as RequestInit);
  assert.deepEqual(await readBody(request, 4), { ok: false, reason: "invalid" });
  assert.equal(request.body?.locked, false);
  const locked = streamed([Uint8Array.of(1)]).request;
  const owner = locked.body!.getReader();
  assert.deepEqual(await readBody(locked, 4), { ok: false, reason: "invalid" });
  owner.releaseLock();
});

test("readJson keeps object-only semantics and counts UTF-8 bytes rather than characters", async () => {
  const json = JSON.stringify({ message: "🌲" });
  const bytes = new TextEncoder().encode(json);
  const good = streamed([bytes.slice(0, 14), bytes.slice(14)]).request;
  assert.deepEqual(await readJson(good, bytes.length), { message: "🌲" });
  assert.equal(await readJson(streamed([bytes]).request, json.length), null);
  for (const body of ["[]", "null", "1", "true", '"text"', "{invalid", ""]) {
    assert.equal(await readJson(new Request("http://localhost/", { method: "POST", body })), null, body);
  }
});
