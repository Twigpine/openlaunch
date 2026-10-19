import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { zeroAddress, type Address } from "viem";
import { clearMemo } from "@/lib/launchpad/memo";
import { BASE_USDC } from "../bridge/types.ts";
import { earnEnabled, earnInfo, earnSnapshot, readSnapshot } from "./server.ts";
import { EARN_VAULTS } from "./vaults.ts";

const vault = EARN_VAULTS.base!;
const LATEST = 52_576_486n;
const NOW = 1_791_942_319;
const THEN = 1_789_350_319;

/** A chain reader answering like the real vault did on 2026-10-14 (share prices for 1e24 shares). */
function reader(o: { priceThen?: bigint | Error; perf?: bigint; gate?: Address; down?: boolean } = {}) {
  const asked: bigint[] = [];
  const client = {
    async getBlock(args?: { blockNumber?: bigint }) {
      if (o.down) throw new Error("rpc down");
      if (args?.blockNumber === undefined) return { number: LATEST, timestamp: BigInt(NOW) };
      asked.push(args.blockNumber);
      return { number: args.blockNumber, timestamp: BigInt(THEN) };
    },
    async readContract({ functionName, blockNumber }: { functionName: string; blockNumber?: bigint }) {
      if (o.down) throw new Error("rpc down");
      switch (functionName) {
        case "asset": return BASE_USDC;
        case "totalAssets": return 182_619_001_080_731n;
        case "performanceFee": return o.perf ?? 0n;
        case "managementFee": return 0n;
        case "convertToAssets":
          if (blockNumber === LATEST) return 1_044_155_000_000n;
          if (o.priceThen instanceof Error) throw o.priceThen;
          return o.priceThen ?? 1_040_432_000_000n;
        default: return o.gate ?? zeroAddress;
      }
    },
  };
  return { client: client as unknown as Parameters<typeof readSnapshot>[1], asked };
}

beforeEach(() => clearMemo());

test("the snapshot measures what a share gained over the last 30 days, from two blocks' real timestamps", async () => {
  const { client, asked } = reader();
  const s = await readSnapshot(vault, client);
  assert.deepEqual(asked, [LATEST - 1_296_000n]); // 30 days of 2-second Base blocks back
  assert.ok(s.rate !== null && Math.abs(s.rate - 0.043536) < 0.00001, String(s.rate));
  assert.equal(s.rateFrom, new Date(THEN * 1000).toISOString());
  assert.equal(s.rateTo, new Date(NOW * 1000).toISOString());
  assert.equal(s.totalAssets, "182619001080731");
  assert.deepEqual([s.performanceFeePct, s.managementFeeYearPct], [0, 0]);
  assert.deepEqual(s.terms, { ok: true });
  assert.doesNotThrow(() => JSON.stringify(s));
});

test("a node without historical state gives no rate, not an error", async () => {
  const s = await readSnapshot(vault, reader({ priceThen: new Error("missing trie node") }).client);
  assert.equal(s.rate, null);
  assert.equal(s.rateFrom, null);
  assert.deepEqual(s.terms, { ok: true });
});

test("a raised fee or a gate shows up as changed terms", async () => {
  const fee = await readSnapshot(vault, reader({ perf: 50_000_000_000_000_000n }).client);
  assert.deepEqual(fee.terms, { ok: false, reason: "The vault now keeps 5% of the interest it earns." });
  const gated = await readSnapshot(vault, reader({ gate: "0x00000000000000000000000000000000000000aa" }).client);
  assert.equal(gated.terms.ok, false);
});

test("an unreadable chain gives a null snapshot and is not remembered", async () => {
  assert.equal(await earnSnapshot("base", reader({ down: true }).client), null);
  const s = await earnSnapshot("base", reader().client);
  assert.ok(s && s.rate !== null);
});

test("figures are memoised per vault, and chains without a vault have none", async () => {
  const first = await earnSnapshot("base", reader().client);
  const second = await earnSnapshot("base", reader({ perf: 1n }).client);
  assert.deepEqual(second, first);
  assert.equal(await earnSnapshot("arc", reader().client), null);
  assert.equal(await earnSnapshot("robinhood", reader().client), null);
});

test("the API's on answer lists the Base vault with its figures", async () => {
  const info = await earnInfo(reader().client);
  assert.equal(info.enabled, true);
  assert.ok(info.enabled);
  assert.deepEqual(info.vaults.map((v) => [v.chain, v.address]), [["base", vault.address]]);
  assert.ok(info.vaults[0].snapshot);
});

test("the feature is off unless EARN=on", () => {
  const before = process.env.EARN;
  try {
    delete process.env.EARN;
    assert.equal(earnEnabled(), false);
    for (const v of ["off", "1", "true", "yes", ""]) {
      process.env.EARN = v;
      assert.equal(earnEnabled(), false, v);
    }
    for (const v of ["on", "ON", " on "]) {
      process.env.EARN = v;
      assert.equal(earnEnabled(), true, v);
    }
  } finally {
    if (before === undefined) delete process.env.EARN;
    else process.env.EARN = before;
  }
});
