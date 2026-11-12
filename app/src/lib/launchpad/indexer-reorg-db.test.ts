import assert from "node:assert/strict";
import test from "node:test";
import { getMock, maybeDb, resetMock } from "@/lib/db-mock";
import { replayPayloadMatches, replayValue, type ReplayKind, type ReplayPayload } from "./indexer-reorg-db";

const identities: Record<ReplayKind, ReplayPayload> = {
  swap: { token: "0xtoken", pool_id: "0xpool", amount0: "-1000000000000000000000001", amount1: "2000000000000000000000003", sqrt_price_x96: "79228162514264337593543950337", tick: 4, is_buy: true },
  fee: { kind: "collected", token_id: "9007199254740993", token: "0xtoken", quote: "0xquote", currency: null, account: null, amount: null, quote_amount: "1000000000000000000000001", token_amount: "2000000000000000000000003" },
  pair: { application_id: "9007199254740993", sender: "0xsender", twig: "1000000000000000000000001" },
};

for (const kind of ["swap", "fee", "pair"] as const) {
  test(`replay valuation: ${kind} requires every event field, including explicit nulls`, () => {
    const original = identities[kind];
    assert.equal(replayPayloadMatches(kind, { ...original, usd: 7, trader: "an enrichment" }, original), true);
    for (const key of Object.keys(original)) {
      const missing = { ...original };
      delete missing[key];
      assert.equal(replayPayloadMatches(kind, original, missing), false, `missing ${key}`);
      assert.equal(replayPayloadMatches(kind, original, { ...original, [key]: original[key] === null ? "changed" : null }), false, `changed ${key}`);
    }
  });
}

test("replay identity preserves integers beyond JS precision and accepts exact bigint/string equivalents", () => {
  const pair = identities.pair;
  assert.equal(replayPayloadMatches("pair", pair, { ...pair, application_id: 9007199254740993n, twig: BigInt(String(pair.twig)) }), true);
  assert.equal(replayPayloadMatches("pair", pair, { ...pair, application_id: Number(pair.application_id) }), false);
  assert.equal(replayPayloadMatches("swap", identities.swap, { ...identities.swap, sqrt_price_x96: Number(identities.swap.sqrt_price_x96) }), false);
});

test("replaying an already pending pair valuation preserves the reconciliation requirement", async () => {
  resetMock();
  getMock().query = async () => [{ payload: { ...identities.pair, valuation_pending: true }, usd: null, priced_by: null }];
  const replayed = await replayValue(maybeDb()!, "base", "pair", "0xtx", 1, 100n, "2026-11-12T00:00:00Z", "0xblock", identities.pair);
  assert.deepEqual(replayed, { usd: null, priced_by: null, valuation_pending: true });
});
