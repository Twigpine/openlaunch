import assert from "node:assert/strict";
import test from "node:test";
import { claimableFees, feeEntitlement, quoteBuy, quoteSell, tradingFee } from "../../app/packages/solana-sdk/src/math.ts";
import {
  SUPPLY, U64_MAX, U128_MAX, MIN_VIRTUAL_SOL, MAX_VIRTUAL_SOL,
  claimOracle, entitlementOracle, feeOracle, nextState, quoteBuyOracle, quoteSellOracle,
} from "./oracle.mjs";

test("SDK agrees with independently solved invariant across 108,000 state transitions", () => {
  let seed = 2_910_317n;
  const random = () => {
    seed ^= seed << 13n;
    seed ^= seed >> 7n;
    seed ^= seed << 17n;
    seed &= U64_MAX;
    return seed;
  };
  let buys = 0;
  let sells = 0;
  for (const virtualSol of [MIN_VIRTUAL_SOL, 30_000_000_000n, MAX_VIRTUAL_SOL]) {
    for (const feeBps of [0, 100, 300]) {
      let state = { tokenInventory: SUPPLY, realSolReserves: 0n, virtualSol, feeBps };
      for (let step = 0; step < 12_000; step++) {
        const circulating = SUPPLY - state.tokenInventory;
        const buy = circulating === 0n || random() % 2n === 0n;
        const input = buy ? 1_000_000n + random() % 1_000_000_000_000n : circulating * (1n + random() % 99n) / 100n;
        const oracle = (buy ? quoteBuyOracle : quoteSellOracle)(state, input);
        const actual = (buy ? quoteBuy : quoteSell)(state, input);
        assert.deepEqual(actual, oracle, `fee=${feeBps}, V=${virtualSol}, step=${step}`);
        state = nextState(state, oracle);
        if (buy) buys++;
        else sells++;
      }
    }
  }
  assert.equal(buys + sells, 108_000);
  assert(buys > 40_000 && sells > 40_000);
});

test("SDK fee ledger agrees at lifetime and tiny-value boundaries", () => {
  for (const fee of [0, 100, 300]) for (const amount of [0n, 1n, 2n, 33n, 34n, 99n, 100n, 101n, U64_MAX]) {
    assert.equal(tradingFee(amount, fee), feeOracle(amount, fee));
  }
  for (const earned of [0n, 1n, 9999n, 10000n, U64_MAX, U64_MAX + 1n, U128_MAX]) for (const weight of [1, 17, 3333, 3334, 9999, 10000]) {
    const expected = entitlementOracle(earned, weight);
    assert.equal(feeEntitlement(earned, weight), expected);
    assert.equal(claimableFees(earned, weight, expected / 2n), claimOracle(earned, weight, expected / 2n));
  }
});

test("SDK and oracle both reject invalid states and unsafe quotes", () => {
  const initial = { tokenInventory: SUPPLY, realSolReserves: 0n, virtualSol: MIN_VIRTUAL_SOL, feeBps: 0 };
  for (const patch of [
    { tokenInventory: 0n }, { tokenInventory: SUPPLY + 1n }, { tokenInventory: SUPPLY - 1n },
    { realSolReserves: -1n }, { realSolReserves: U64_MAX },
    { virtualSol: MIN_VIRTUAL_SOL - 1n }, { virtualSol: MAX_VIRTUAL_SOL + 1n }, { feeBps: 301 },
  ]) {
    const state = { ...initial, ...patch };
    assert.throws(() => quoteBuy(state, 1_000_000n));
    assert.throws(() => quoteBuyOracle(state, 1_000_000n));
  }
  for (const input of [0n, -1n, U64_MAX, U64_MAX + 1n]) {
    assert.throws(() => quoteBuy(initial, input));
    assert.throws(() => quoteBuyOracle(initial, input));
  }
  assert.throws(() => quoteBuy(initial, 1_000_000n, SUPPLY));
  assert.throws(() => quoteBuyOracle(initial, 1_000_000n, SUPPLY));
  assert.throws(() => quoteSell(initial, 1n));
  assert.throws(() => quoteSellOracle(initial, 1n));
});
