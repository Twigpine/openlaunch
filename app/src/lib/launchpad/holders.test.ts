import { test } from "node:test";
import assert from "node:assert/strict";
import { DEAD_ADDR, ZERO_ADDR, applyTransfer, creatorActivity, fmtShare, holderTags, inSniperWindow, isNonHolder, shareBps, sniperSummary, trustNotes } from "./holders.ts";

const PM = "0x498581fF718922c3f8e6A244956aF099B2652b2b";
const LOCKER = "0xcd1680D26922fcd9CabFbb8a56bA40C333fD842a";
const DEV = "0x00000000000000000000000000000000000c0ffe";
const A = "0x" + "a".repeat(40);
const B = "0x" + "b".repeat(40);
const SUPPLY = 10n ** 27n;

test("applyTransfer: mint from zero, wallet-to-wallet, burn to zero", () => {
  const m = new Map<string, bigint>();
  applyTransfer(m, ZERO_ADDR, PM, SUPPLY); // launch mints all supply into the pool
  applyTransfer(m, PM, A, 100n);
  applyTransfer(m, A, B, 40n);
  applyTransfer(m, B, ZERO_ADDR, 10n);
  assert.equal(m.get(PM.toLowerCase()), SUPPLY - 100n);
  assert.equal(m.get(A), 60n);
  assert.equal(m.get(B), 30n);
  assert.equal(m.has(ZERO_ADDR), false, "zero address never tracked");
});

test("isNonHolder: pool, locker, zero and dead are excluded; wallets are not", () => {
  const ctx = { system: [PM, LOCKER] };
  for (const a of [PM, PM.toLowerCase(), LOCKER, ZERO_ADDR, DEAD_ADDR]) assert.equal(isNonHolder(a, ctx), true, a);
  assert.equal(isNonHolder(A, ctx), false);
});

test("shareBps / fmtShare", () => {
  assert.equal(shareBps(SUPPLY / 4n, SUPPLY), 2500);
  assert.equal(shareBps(0n, SUPPLY), 0);
  assert.equal(shareBps(1n, 0n), 0);
  assert.equal(fmtShare(2500), "25%");
  assert.equal(fmtShare(150), "1.5%");
  assert.equal(fmtShare(42), "0.42%");
  assert.equal(fmtShare(0), "0%");
  assert.equal(fmtShare(0.5), "<0.01%");
  assert.equal(fmtShare(NaN), "—", "non-finite never paints NaN% in the trust panel");
  assert.equal(fmtShare(Infinity), "—");
  assert.equal(fmtShare(-Infinity), "—");
});

test("holderTags: creator, pool, burn, sniper, whale (whale never on pool/burn)", () => {
  const ctx = { launcher: DEV, system: [PM, LOCKER], snipers: new Set([A]) };
  assert.deepEqual(holderTags(DEV, SUPPLY / 10n, SUPPLY, ctx), ["creator", "whale"]);
  assert.deepEqual(holderTags(PM, SUPPLY / 2n, SUPPLY, ctx), ["pool"]);
  assert.deepEqual(holderTags(DEAD_ADDR, SUPPLY / 2n, SUPPLY, ctx), ["burn"]);
  assert.deepEqual(holderTags(A, 1n, SUPPLY, ctx), ["sniper"]);
  assert.deepEqual(holderTags(B, SUPPLY / 20n, SUPPLY, ctx), ["whale"], "5% is a whale");
  assert.deepEqual(holderTags(B, SUPPLY / 21n, SUPPLY, ctx), [], "just under 5% is not");
});

test("sniper window and summary", () => {
  assert.equal(inSniperWindow(100, 100), true);
  assert.equal(inSniperWindow(100, 103), true);
  assert.equal(inSniperWindow(100, 104), false);
  assert.equal(inSniperWindow(100, 99), false);
  const swaps = [
    { trader: A, is_buy: true, block_number: 100, token_amount: -(SUPPLY / 10n) }, // pool delta negative = tokens out
    { trader: A, is_buy: true, block_number: 101, token_amount: -(SUPPLY / 20n) },
    { trader: B, is_buy: true, block_number: 103, token_amount: -(SUPPLY / 100n) },
    { trader: B, is_buy: true, block_number: 200, token_amount: -(SUPPLY / 2n) }, // too late
    { trader: A, is_buy: false, block_number: 102, token_amount: SUPPLY / 10n }, // sells don't count
    { trader: null, is_buy: true, block_number: 100, token_amount: -(SUPPLY / 5n) }, // sender unknown: no wallet to attribute
  ];
  const s = sniperSummary(swaps, 100, SUPPLY);
  assert.deepEqual(s.wallets.sort(), [A, B].sort());
  assert.equal(s.boughtBps, 1000 + 500 + 100);
});

test("creatorActivity counts only the launcher's swaps", () => {
  const swaps = [
    { trader: DEV, is_buy: true, block_number: 1, token_amount: -1000n },
    { trader: DEV, is_buy: false, block_number: 2, token_amount: 400n },
    { trader: DEV.toUpperCase().replace("0X", "0x"), is_buy: false, block_number: 3, token_amount: 100n },
    { trader: A, is_buy: false, block_number: 3, token_amount: 999n },
    { trader: null, is_buy: false, block_number: 4, token_amount: 50n }, // sender unknown is never the creator
  ];
  assert.deepEqual(creatorActivity(swaps, DEV), { bought: 1000n, sold: 500n, sells: 2 });
});

test("trustNotes: warnings first, facts only, a clean token says so", () => {
  const clean = trustNotes({ holders: 42, creatorBps: 100, creatorSells: 0, sniperBps: 200, sniperWallets: 2, top10Bps: 1200, poolBps: 8000 });
  assert.equal(clean[0].level, "good");
  assert.match(clean[0].text, /42 holders, no red flags/);
  assert.ok(clean.some((n) => /80% of supply sits in the locked pool/.test(n.text)));
  const bad = trustNotes({ holders: 3, creatorBps: 4000, creatorSells: 2, sniperBps: 3000, sniperWallets: 1, top10Bps: 9000, poolBps: 500 });
  assert.equal(bad.filter((n) => n.level === "warn").length, 4);
  assert.match(bad[0].text, /Creator holds 40%/);
  assert.match(bad[1].text, /Creator sold 2 times/);
  assert.match(bad[2].text, /1 wallet sniped 30%/);
  assert.ok(!bad.some((n) => /no red flags/.test(n.text)));
});
