import { test } from "node:test";
import assert from "node:assert/strict";
import { getMock } from "../db-mock.ts";
import { BASE_STOCKS } from "./baseStocks.ts";
import { stockIssued } from "./stocksServer.ts";

// @/lib/chain is the test mock: its b20Client answers totalSupply() from getMock().b20Supply and counts the reads.
// The supply cache lives in the module, so this file walks it through one timeline: cold, failed, good, cached, stale.

const NVDA = "0xb20000000000000000000078ee7ce2fe4908108c";
const NFLX = "0xb20000000000000000000058b8c947e44011dfe6";
const AMD = "0xb2000000000000000000000d8ce462e99ee7a47b";
const flush = () => new Promise((r) => setImmediate(r));

test("base supply: one read for the whole list, cached 10 min, a failed read retried after a minute and never dropping a good copy", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  const warn = t.mock.method(console, "warn", () => {});
  const m = getMock();

  // cold, node down: nothing known, so nothing is marked either way
  assert.equal((await stockIssued("base")).size, 0);
  assert.equal(m.b20SupplyReads, 1);
  assert.equal(warn.mock.callCount(), 1);
  // the failure is not retried on every request...
  m.b20Supply = Object.fromEntries(BASE_STOCKS.map((s) => [s.address, 1n]));
  assert.equal((await stockIssued("base")).size, 0);
  assert.equal(m.b20SupplyReads, 1);
  // ...but a minute later: the request answers what it has, and the read runs behind it
  m.b20Supply = { ...m.b20Supply, [NFLX]: 0n, [AMD]: "fail" };
  t.mock.timers.tick(60_000);
  assert.equal((await stockIssued("base")).size, 0);
  await flush();
  assert.equal(m.b20SupplyReads, 2, "one multicall covers all 146");
  const good = await stockIssued("base");
  assert.equal(good.get(NVDA), true);
  assert.equal(good.get(NFLX), false, "listed with no supply: not issued yet");
  assert.equal(good.has(AMD), false, "a failed call says nothing about that stock");
  assert.equal(good.size, BASE_STOCKS.length - 1);

  // inside the 10 minutes: no read at all
  t.mock.timers.tick(9 * 60_000);
  await stockIssued("base");
  assert.equal(m.b20SupplyReads, 2);

  // stale, and the node is down again: the last good copy stays
  m.b20Supply = null;
  t.mock.timers.tick(2 * 60_000);
  assert.equal(await stockIssued("base"), good);
  await flush();
  assert.equal(m.b20SupplyReads, 3);
  assert.equal(await stockIssued("base"), good);
  assert.equal(warn.mock.callCount(), 2);

  // a read where every call fails counts as a failure too, not as "nothing is issued"
  m.b20Supply = {};
  t.mock.timers.tick(60_000);
  await stockIssued("base");
  await flush();
  assert.equal(m.b20SupplyReads, 4);
  assert.equal(await stockIssued("base"), good);
  assert.equal(warn.mock.callCount(), 3);

  // supply arrives for NFLX: the next good read says so
  m.b20Supply = { ...Object.fromEntries(BASE_STOCKS.map((s) => [s.address, 1n])), [NFLX]: 5n };
  t.mock.timers.tick(60_000);
  await stockIssued("base");
  await flush();
  assert.equal((await stockIssued("base")).get(NFLX), true);
  assert.equal(m.b20SupplyReads, 5);
});

test("other chains: no supply read, nothing marked", async () => {
  const m = getMock();
  const before = m.b20SupplyReads;
  assert.equal((await stockIssued("robinhood")).size, 0);
  assert.equal((await stockIssued("arc")).size, 0);
  assert.equal(m.b20SupplyReads, before);
});

test("requests that find the copy stale at the same moment start one read between them", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 10_000_000_000 }); // long past everything cached above
  const m = getMock();
  m.b20Supply = Object.fromEntries(BASE_STOCKS.map((s) => [s.address, 1n]));
  const before = m.b20SupplyReads;
  await Promise.all([stockIssued("base"), stockIssued("base"), stockIssued("base")]);
  await flush();
  assert.equal(m.b20SupplyReads, before + 1);
});
