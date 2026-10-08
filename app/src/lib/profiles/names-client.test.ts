import { test, mock } from "node:test";
import assert from "node:assert/strict";

// the store is browser code: give it the few globals it touches, and a names API that counts its calls
const A = "0x" + "a".repeat(40);
let calls = 0;
let answer: "ok" | "fail" = "ok";
let name = "alice";
Object.assign(globalThis, { window: {}, document: { visibilityState: "visible" } });
globalThis.fetch = (async () => {
  calls++;
  if (answer === "fail") return new Response("", { status: 503 });
  return Response.json({ names: { [A]: { u: name, d: "Alice", a: null, v: true } } });
}) as typeof fetch;

test("a watched name is refreshed after the TTL, retried with backoff on failure, and released", async () => {
  mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 1_000_000 });
  const { watchName, cachedName } = await import("./names-client.ts");
  const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
  // step the clock a second at a time until the names API has been called `n` times; returns the seconds it took
  const until = async (n: number, maxS: number) => {
    for (let s = 1; s <= maxS; s++) {
      mock.timers.tick(1_000);
      await settle();
      if (calls >= n) return s;
    }
    return Infinity;
  };

  const release = watchName(A);
  assert.ok((await until(1, 2)) <= 1, "asked once on mount");
  assert.equal(cachedName(A)?.u, "alice");

  name = "alice2"; // renamed meanwhile
  const refreshed = await until(2, 300);
  assert.ok(refreshed >= 120 && refreshed <= 151, `asked again once the answer is past the 2-minute TTL (${refreshed} s)`);
  assert.equal(cachedName(A)?.u, "alice2", "an open page picks up the rename");

  answer = "fail";
  assert.ok((await until(3, 300)) <= 151, "stale again: asked, and the API failed");
  const retry1 = await until(4, 300);
  assert.ok(retry1 >= 30 && retry1 <= 61, `first retry after about 30 s (${retry1} s)`);
  const retry2 = await until(5, 300);
  assert.ok(retry2 >= 60 && retry2 <= 91, `then about a minute (${retry2} s)`);
  answer = "ok";
  name = "alice3";
  const retry3 = await until(6, 400);
  assert.ok(retry3 >= 120 && retry3 <= 151, `then about two minutes (${retry3} s), and answered`);
  assert.equal(cachedName(A)?.u, "alice3");

  release();
  const after = calls;
  await until(after + 1, 600);
  assert.equal(calls, after, "released: no more lookups");
  mock.timers.reset();
});

test("an answer asked before a seed or a save never replaces the newer name", async () => {
  mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 50_000_000 });
  const { watchName, cachedName, seedNames, forgetCachedName } = await import("./names-client.ts");
  const B = "0x" + "b".repeat(40);
  // a names API whose answers are released by hand, in any order
  const pending: { name: string; resolve: () => void }[] = [];
  let served = "old";
  globalThis.fetch = (async () => {
    const name = served;
    await new Promise<void>((resolve) => pending.push({ name, resolve }));
    return Response.json({ names: { [B]: { u: name, d: name, a: null, v: false } } });
  }) as typeof fetch;
  const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
  const step = async (ms: number) => { mock.timers.tick(ms); await settle(); };

  const release = watchName(B);
  await step(50);
  assert.equal(pending.length, 1, "lookup in flight");
  seedNames({ [B]: { u: "seeded", d: "seeded", a: null, v: true } }); // a page render brings a newer answer
  pending[0].resolve();
  await settle();
  assert.equal(cachedName(B)?.u, "seeded", "the older in-flight answer is dropped, the seed stays");

  // a save invalidates while a lookup is in flight: the new lookup's answer wins whatever order they arrive in
  mock.timers.tick(200_000); // past the TTL
  await settle();
  served = "before-save";
  watchName(B)(); // nudge (watch + release) so a refresh is asked now
  await step(50);
  const stale = pending.length - 1;
  served = "after-save";
  forgetCachedName(B);
  await step(50);
  assert.equal(pending.length, stale + 2, "the save asked again although a lookup was in flight");
  pending[stale + 1].resolve(); // the new answer first…
  await settle();
  pending[stale].resolve(); // …then the stale one
  await settle();
  assert.equal(cachedName(B)?.u, "after-save", "the answer asked before the save never lands");

  // no duplicate lookups while one asked at the current generation is in flight
  mock.timers.tick(200_000);
  await settle();
  const before = pending.length;
  watchName(B)();
  watchName(B)();
  await step(50);
  assert.equal(pending.length, before + 1, "one lookup, not two");
  pending.at(-1)!.resolve();
  await settle();
  release();
  mock.timers.reset();
});
