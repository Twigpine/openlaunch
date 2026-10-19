import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  SUPPLY, U64_MAX, U128_MAX, MIN_VIRTUAL_SOL, MAX_VIRTUAL_SOL,
  checkState, claimOracle, entitlementOracle, feeOracle, nextState,
  quoteBuyOracle, quoteSellOracle,
} from "./oracle.mjs";

const OFFSETS = [MIN_VIRTUAL_SOL, 30_000_000_000n, MAX_VIRTUAL_SOL];
const FEES = [0, 100, 300];
const initial = (virtualSol = OFFSETS[1], feeBps = 100) => ({
  tokenInventory: SUPPLY, realSolReserves: 0n, virtualSol, feeBps,
});
const sum = (values) => values.reduce((a, b) => a + b, 0n);
const product = (state) => state.tokenInventory * (state.realSolReserves + state.virtualSol);
function random(seed) {
  let value = seed >>> 0;
  return () => {
    value = (Math.imul(value, 1_664_525) + 1_013_904_223) >>> 0;
    return BigInt(value);
  };
}

// Independent balance sheet, including ordinary transfers, burns and donations.
// These are specification tests, not a simulation of Solana account execution.
class Ledger {
  constructor(virtualSol, feeBps) {
    this.state = initial(virtualSol, feeBps);
    this.walletSol = Array(7).fill(1_000_000_000_000_000n);
    this.walletTokens = Array(7).fill(0n);
    this.weights = [1, 3, 17, 999, 2000, 3000, 3980];
    this.paid = Array(7).fill(0n);
    this.feesEarned = 0n;
    this.reserveRent = 1_234_560n;
    this.feeRent = 987_650n;
    this.reserveBalance = this.reserveRent;
    this.feeBalance = this.feeRent;
    this.tokenBalance = SUPPLY;
    this.solDonations = 0n;
    this.feeDonations = 0n;
    this.tokenDonations = 0n;
    this.burned = 0n;
    this.initialSol = sum(this.walletSol) + this.reserveBalance + this.feeBalance;
  }
  buy(wallet, input) {
    const quote = quoteBuyOracle(this.state, input);
    assert(this.walletSol[wallet] >= input);
    const before = product(this.state);
    this.walletSol[wallet] -= input;
    this.walletTokens[wallet] += quote.amountOut;
    this.reserveBalance += quote.netInput;
    this.feeBalance += quote.fee;
    this.tokenBalance -= quote.amountOut;
    this.feesEarned += quote.fee;
    this.state = nextState(this.state, quote);
    assert(product(this.state) >= before);
    // One extra token atom would break the old product. This proves maximality.
    assert((this.state.tokenInventory - 1n) * (this.state.realSolReserves + this.state.virtualSol) < before);
  }
  sell(wallet, input) {
    const quote = quoteSellOracle(this.state, input);
    assert(this.walletTokens[wallet] >= input);
    const before = product(this.state);
    this.walletSol[wallet] += quote.amountOut;
    this.walletTokens[wallet] -= input;
    this.reserveBalance -= quote.amountOut + quote.fee;
    this.feeBalance += quote.fee;
    this.tokenBalance += input;
    this.feesEarned += quote.fee;
    this.state = nextState(this.state, quote);
    assert(product(this.state) >= before);
    assert(this.state.tokenInventory * (this.state.realSolReserves + this.state.virtualSol - 1n) < before);
  }
  claim(wallet) {
    const amount = claimOracle(this.feesEarned, this.weights[wallet], this.paid[wallet]);
    const before = { ...this.state };
    this.paid[wallet] += amount;
    this.feeBalance -= amount;
    this.walletSol[wallet] += amount;
    assert.deepEqual(this.state, before);
    assert.equal(claimOracle(this.feesEarned, this.weights[wallet], this.paid[wallet]), 0n);
  }
  donate(wallet) {
    const before = { ...this.state };
    this.walletSol[wallet] -= 123n;
    this.reserveBalance += 100n;
    this.solDonations += 100n;
    this.feeBalance += 23n;
    this.feeDonations += 23n;
    if (this.walletTokens[wallet] > 3n) {
      this.walletTokens[wallet] -= 3n;
      this.tokenBalance += 2n;
      this.tokenDonations += 2n;
      this.burned += 1n;
    }
    assert.deepEqual(this.state, before);
  }
  transfer(from, to) {
    const amount = this.walletTokens[from] / 5n;
    this.walletTokens[from] -= amount;
    this.walletTokens[to] += amount;
  }
  check() {
    checkState(this.state);
    assert.equal(sum(this.walletSol) + this.reserveBalance + this.feeBalance, this.initialSol);
    assert.equal(sum(this.walletTokens) + this.tokenBalance + this.burned, SUPPLY);
    assert.equal(this.tokenBalance, this.state.tokenInventory + this.tokenDonations);
    assert.equal(this.reserveBalance, this.reserveRent + this.state.realSolReserves + this.solDonations);
    assert.equal(this.feeBalance, this.feeRent + this.feesEarned - sum(this.paid) + this.feeDonations);
    assert(this.reserveBalance >= this.reserveRent);
    assert(this.feeBalance >= this.feeRent);
    assert(this.feesEarned <= U128_MAX);
    this.paid.forEach((paid, i) => assert(paid <= entitlementOracle(this.feesEarned, this.weights[i])));
  }
}

test("independent golden vectors remain stable", async () => {
  const vectors = JSON.parse(await readFile(new URL("./golden-vectors.json", import.meta.url), "utf8"));
  for (const vector of vectors) {
    const state = Object.fromEntries(Object.entries(vector.state).map(([key, value]) =>
      [key, key === "feeBps" ? value : BigInt(value)]));
    const quote = (vector.side === "buy" ? quoteBuyOracle : quoteSellOracle)(state, BigInt(vector.input), BigInt(vector.minOutput));
    for (const [key, value] of Object.entries(vector.expected)) assert.equal(quote[key], BigInt(value), `${vector.name}: ${key}`);
  }
});

test("90,000 deterministic mixed trades conserve balances with fees, donations, burns and transfers", () => {
  let accepted = 0;
  let buys = 0;
  let sells = 0;
  for (const offset of OFFSETS) for (const fee of FEES) for (let scenario = 0; scenario < 40; scenario++) {
    const rng = random(29_103 + scenario * 7_919 + fee);
    const ledger = new Ledger(offset, fee);
    for (let step = 0; step < 250; step++) {
      const wallet = Number(rng() % 7n);
      if ((rng() >> 16n) % 2n === 0n || ledger.walletTokens[wallet] === 0n) {
        ledger.buy(wallet, 1_000_000n + rng() * 29n);
        buys++;
      } else {
        const input = ledger.walletTokens[wallet] * (1n + rng() % 99n) / 100n;
        // Generated positions comfortably exceed one lamport at every offset.
        ledger.sell(wallet, input);
        sells++;
      }
      accepted++;
      if (step % 11 === 0) ledger.claim(Number(rng() % 7n));
      if (step % 17 === 0) ledger.donate(wallet);
      if (step % 23 === 0) ledger.transfer(wallet, (wallet + 1) % 7);
      if (step % 10 === 0) ledger.check();
    }
    for (let i = 6; i >= 0; i--) ledger.claim(i);
    ledger.check();
    assert(ledger.feesEarned - sum(ledger.paid) < 7n);
  }
  assert.equal(accepted, 90_000);
  assert(buys > 30_000 && sells > 30_000, "exercise both sides rather than PRNG low-bit alternation");
});

test("3,600 isolated round trips cannot create SOL or tokens", () => {
  let directions = 0;
  const rng = random(91_337);
  for (const offset of OFFSETS) for (const fee of FEES) for (let sample = 0; sample < 200; sample++) {
    const state = initial(offset, fee);
    const input = 10_000_000n + rng() * 1_001n;
    const buy = quoteBuyOracle(state, input);
    const sell = quoteSellOracle(nextState(state, buy), buy.amountOut);
    assert(sell.amountOut <= input);
    checkState(nextState(nextState(state, buy), sell));
    directions++;

    const acquired = nextState(state, buy);
    const tokens = buy.amountOut / 3n;
    const sold = quoteSellOracle(acquired, tokens);
    const boughtBack = quoteBuyOracle(nextState(acquired, sold), sold.amountOut);
    assert(boughtBack.amountOut <= tokens);
    directions++;
  }
  assert.equal(directions, 3_600);
});

test("cumulative u128 fee entitlements are solvent and claim-order independent", () => {
  const weights = [1, 2, 3, 4, 5, 6, 9979];
  for (const earned of [0n, 1n, 6n, 9999n, 10000n, U64_MAX, U64_MAX + 1n, U128_MAX - 1n, U128_MAX]) {
    const amounts = weights.map((weight) => entitlementOracle(earned, weight));
    assert(sum(amounts) <= earned);
    assert(earned - sum(amounts) < BigInt(weights.length));
    assert.equal(sum([...amounts].reverse()), sum(amounts));
    for (let i = 0; i < weights.length; i++) {
      assert.equal(claimOracle(earned, weights[i], amounts[i]), 0n);
      assert.throws(() => claimOracle(earned, weights[i], amounts[i] + 1n), /overpaid/);
    }
  }
  assert.equal(entitlementOracle(U128_MAX, 10000), U128_MAX);
  assert.throws(() => entitlementOracle(U128_MAX + 1n, 10000), /out of bounds/);
});

test("fee ceilings charge the smallest satisfying integer, even at u64 max", () => {
  for (const fee of FEES) for (const amount of [0n, 1n, 2n, 33n, 34n, 99n, 100n, 101n, U64_MAX]) {
    const charged = feeOracle(amount, fee);
    assert(charged * 10000n >= amount * BigInt(fee));
    if (charged > 0n) assert((charged - 1n) * 10000n < amount * BigInt(fee));
  }
});

test("unsafe states, zero/dust output, slippage and integer boundaries reject", () => {
  const state = initial();
  for (const patch of [
    { tokenInventory: 0n }, { tokenInventory: SUPPLY + 1n },
    { virtualSol: MIN_VIRTUAL_SOL - 1n }, { virtualSol: MAX_VIRTUAL_SOL + 1n },
    { realSolReserves: U64_MAX }, { feeBps: 1 }, { tokenInventory: SUPPLY - 1n },
  ]) assert.throws(() => checkState({ ...state, ...patch }));
  assert.throws(() => quoteBuyOracle(state, 0n), /zero input/);
  assert.throws(() => quoteBuyOracle(state, 1n), /zero effective input/);
  assert.throws(() => quoteBuyOracle({ ...state, feeBps: 0 }, U64_MAX), /overflow/);
  assert.throws(() => quoteBuyOracle(state, 1000n, SUPPLY), /slippage/);
  assert.throws(() => quoteSellOracle(state, 1n), /circulating/);
  const buy = quoteBuyOracle(state, 1_000_000_000n);
  const after = nextState(state, buy);
  assert.throws(() => quoteSellOracle(after, buy.amountOut + 1n), /circulating/);
  assert.throws(() => quoteSellOracle(after, 1n), /zero output/);
  assert.throws(() => quoteSellOracle(after, buy.amountOut, U64_MAX), /slippage/);
  assert.throws(() => quoteBuyOracle(state, Number.MAX_SAFE_INTEGER), /bigint/);
});

test("near-empty inventory and large real reserves never pay virtual SOL", () => {
  for (const offset of OFFSETS) for (const fee of FEES) {
    const state = initial(offset, fee);
    // A large but u64-safe buy approaches the last atom without exhausting it.
    const buy = quoteBuyOracle(state, (U64_MAX - offset) / 2n);
    assert(buy.nextTokenInventory > 0n);
    const after = nextState(state, buy);
    const sell = quoteSellOracle(after, buy.amountOut);
    assert(sell.amountOut + sell.fee <= after.realSolReserves);
    assert.equal(sell.nextTokenInventory, SUPPLY);
    assert(sell.nextRealSolReserves >= 0n);
  }
});
