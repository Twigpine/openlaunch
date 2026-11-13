import assert from "node:assert/strict";
import test from "node:test";
import { startUnlessRunning } from "./runOnce.ts";

test("a key that is still running is skipped, not run twice and not waited on", async () => {
  const running = new Map<string, Promise<void>>();
  let calls = 0;
  let finish!: () => void;
  const first = startUnlessRunning(running, "base", () => {
    calls++;
    return new Promise<void>((resolve) => (finish = resolve));
  });
  assert.ok(first);
  assert.equal(startUnlessRunning(running, "base", async () => { calls++; }), null, "the second caller gets null at once");
  assert.equal(calls, 1);
  finish();
  await first;
  assert.equal(running.size, 0, "the key is free once its run settles");
  await startUnlessRunning(running, "base", async () => { calls++; });
  assert.equal(calls, 2);
});

test("a run that never settles holds up neither another key nor a later caller of its own", async () => {
  const running = new Map<string, Promise<void>>();
  startUnlessRunning(running, "base", () => new Promise<void>(() => {}));
  let arc = 0;
  await startUnlessRunning(running, "arc", async () => { arc++; });
  assert.equal(arc, 1, "another key runs as usual");
  assert.equal(startUnlessRunning(running, "base", async () => {}), null, "the stuck key is skipped, and nothing awaits it");
});

test("a run that rejects frees its key and passes the rejection to its caller", async () => {
  const running = new Map<string, Promise<void>>();
  await assert.rejects(startUnlessRunning(running, "base", async () => { throw new Error("boom"); })!, /boom/);
  assert.equal(running.size, 0);
});
