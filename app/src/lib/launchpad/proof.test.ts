import { test } from "node:test";
import assert from "node:assert/strict";
import { proofFacts } from "./proof.ts";

const LAUNCHER = "0x6b2b000000000000000000000000000000c051d3";
const base = { symbol: "PANCHU", launcher: LAUNCHER, lpFee: 10_000, mode: "creator" as const, recipients: 1 };
const holders = (o: Partial<{ holders: number; top10Bps: number; poolBps: number; bps: number; sells: number; bought: string; sniperWallets: number; sniperBps: number }> = {}) => ({
  synced: true,
  holders: o.holders ?? 1_480,
  top10Bps: o.top10Bps ?? 1_150,
  poolBps: o.poolBps ?? 5_020,
  creator: { address: LAUNCHER, bps: o.bps ?? 0, bought: o.bought ?? "0", sold: "0", sells: o.sells ?? 0 },
  sniper: { wallets: o.sniperWallets ?? 0, bps: o.sniperBps ?? 0 },
});
const fact = (facts: { key: string }[], key: string) => facts.find((f) => f.key === key) as { tone: string; title: string; detail: string };

test("all five facts, in order, for an indexed token", () => {
  const { facts, holdersReady } = proofFacts({ ...base, holders: holders() });
  assert.equal(holdersReady, true);
  assert.deepEqual(facts.map((f) => f.key), ["lock", "creator", "spread", "launch", "fees"]);
  assert.match(fact(facts, "lock").detail, /^50% of the supply is in the locked Uniswap v4 pool\./);
  assert.equal(fact(facts, "creator").title, "The creator holds none");
  assert.equal(fact(facts, "creator").detail, "0x6b2b…51d3 has never bought or sold PANCHU.");
  assert.equal(fact(facts, "spread").title, "1,480 holders");
  assert.equal(fact(facts, "spread").detail, "The ten largest hold 12% of the supply between them.");
  assert.equal(fact(facts, "launch").title, "Nobody bought at launch");
  assert.equal(fact(facts, "launch").detail, "No wallet bought in the launch block or the 3 blocks after it.");
  assert.equal(fact(facts, "fees").title, "1% trading fee, to the recipient set at launch");
});

test("missing holder history leaves the holder facts out instead of guessing", () => {
  for (const h of [null, { ...holders(), synced: false }]) {
    const { facts, holdersReady } = proofFacts({ ...base, holders: h });
    assert.equal(holdersReady, false);
    assert.deepEqual(facts.map((f) => f.key), ["lock", "fees"]);
    assert.doesNotMatch(fact(facts, "lock").detail, /%/, "no share without the index");
  }
});

test("a creator with a profile is named by username instead of the short address", () => {
  const detail = fact(proofFacts({ ...base, launcherName: "basedbuilder", holders: holders({ bps: 350, sells: 2 }) }).facts, "creator").detail;
  assert.equal(detail, "basedbuilder has sold twice.");
});

test("the creator's holdings and sells read as facts, flagged at the holders panel's thresholds", () => {
  const holds = (o: Parameters<typeof holders>[0]) => fact(proofFacts({ ...base, holders: holders(o) }).facts, "creator");
  assert.deepEqual([holds({ bps: 350 }).title, holds({ bps: 350 }).tone, holds({ bps: 350 }).detail], ["The creator holds 3.5%", "info", "0x6b2b…51d3 has not sold any."]);
  assert.equal(holds({ bps: 2_500 }).tone, "warn");
  assert.deepEqual([holds({ bps: 350, sells: 2 }).tone, holds({ bps: 350, sells: 2 }).detail], ["warn", "0x6b2b…51d3 has sold twice."]);
  assert.deepEqual([holds({ sells: 3, bought: "100" }).title, holds({ sells: 3, bought: "100" }).detail], ["The creator holds none now", "0x6b2b…51d3 sold 3 times and holds no PANCHU."]);
  assert.equal(holds({ bought: "100" }).tone, "info");
});

test("concentration and launch-window buyers are flagged only past their thresholds", () => {
  const f = (o: Parameters<typeof holders>[0]) => proofFacts({ ...base, holders: holders(o) }).facts;
  assert.equal(fact(f({ top10Bps: 6_000 }), "spread").tone, "warn");
  assert.equal(fact(f({ holders: 4, top10Bps: 900 }), "spread").detail, "Together they hold 9.0% of the supply.");
  assert.equal(fact(f({ holders: 0, top10Bps: 0 }), "spread").detail, "Nobody holds PANCHU outside the pool yet.");
  const one = fact(f({ sniperWallets: 1, sniperBps: 400 }), "launch");
  assert.deepEqual([one.title, one.tone, one.detail], ["1 wallet bought at launch", "info", "It took 4.0% of the supply in the launch block or the 3 blocks after it."]);
  assert.equal(fact(f({ sniperWallets: 5, sniperBps: 1_200 }), "launch").tone, "warn");
});

test("fee routing says where every fee goes and that it cannot change", () => {
  const fees = (o: Partial<typeof base>) => fact(proofFacts({ ...base, ...o, holders: null }).facts, "fees");
  assert.equal(fees({ lpFee: 0, mode: "free" as never }).title, "No trading fee");
  assert.equal(fees({ lpFee: 30_000, mode: "burn" as never }).title, "3% trading fee, burned");
  assert.match(fees({ lpFee: 30_000, mode: "burn" as never }).detail, /0x…dEaD/);
  assert.equal(fees({ mode: "split" as never, recipients: 3 }).title, "1% trading fee, to the recipients set at launch");
  assert.match(fees({ mode: "split" as never, recipients: 3 }).detail, /^3 wallets share it\. openlaunch takes 0%\. .*can never change\.$/);
});
