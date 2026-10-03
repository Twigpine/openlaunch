import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { CHAIN_KEYS } from "../chainKeys.ts";
import { NATIVE, NATIVE_QUOTES, fixedUsdQuotes, quoteInfo, quoteUsdOf, quotesWithKey } from "./config.ts";

/**
 * The factory is permissionless and documents address(0) as the native asset, so a pool quoted in it can exist on
 * any chain whether or not the form offers it. It must price as THAT chain's native asset: on Arc that is USDC at a
 * fixed dollar, and pricing it at ETH would let a $10k launch rank as a multi-million-dollar one.
 */
test("every chain names its native asset, and address(0) resolves to it", () => {
  for (const k of CHAIN_KEYS) {
    assert.equal(NATIVE_QUOTES[k].address, NATIVE, k);
    assert.equal(NATIVE_QUOTES[k].decimals, 18, `${k}: native accounting is 18-dec everywhere`);
    assert.deepEqual(quoteInfo(k, NATIVE), NATIVE_QUOTES[k], `${k}: quoteInfo(address(0))`);
  }
  assert.equal(quoteInfo("base", NATIVE).key, "eth");
  assert.equal(quoteInfo("robinhood", NATIVE).key, "eth");
  const arcNative = quoteInfo("arc", NATIVE);
  assert.equal(arcNative.key, "usdc");
  assert.equal(arcNative.symbol, "USDC");
  assert.equal(arcNative.usd, 1);
});

test("USD per unit: ETH's live price on ETH chains, one dollar for Arc's native USDC, unknown for a stray ERC-20", () => {
  const ethUsd = 4_321;
  assert.equal(quoteUsdOf(quoteInfo("base", NATIVE), ethUsd), ethUsd);
  assert.equal(quoteUsdOf(quoteInfo("robinhood", NATIVE), ethUsd), ethUsd);
  assert.equal(quoteUsdOf(quoteInfo("arc", NATIVE), ethUsd), 1, "never the ETH price on Arc");
  assert.equal(quoteUsdOf(quoteInfo("arc", "0x3600000000000000000000000000000000000000"), ethUsd), 1, "the ERC-20 face of the same USDC");
  const stray = quoteInfo("arc", "0x000000000000000000000000000000000000dEaD");
  assert.equal(stray.key, "other", "an unlisted pair, never a stock and never ETH");
  assert.equal(quoteUsdOf(stray, ethUsd), null, "an unknown ERC-20 is never priced");
});

test("the SQL pricing tables carry the native stable and scope every arm by chain", () => {
  const fixed = fixedUsdQuotes();
  assert.ok(fixed.some((q) => q.chain === "arc" && q.address === NATIVE && q.usd === 1 && q.decimals === 18), "Arc native USDC prices at $1 in SQL");
  assert.ok(fixed.some((q) => q.chain === "arc" && q.address === "0x3600000000000000000000000000000000000000" && q.decimals === 6));
  assert.ok(fixed.some((q) => q.chain === "robinhood" && q.key === "usdg"));
  assert.ok(!fixed.some((q) => q.address === NATIVE && q.chain !== "arc"), "ETH is live-priced, never a fixed quote");
  assert.deepEqual(quotesWithKey("eth").map((q) => q.chain).sort(), ["base", "robinhood"]);
  assert.deepEqual(quotesWithKey("usdc").map((q) => `${q.chain}:${q.address}`).sort(), ["arc:0x0000000000000000000000000000000000000000", "arc:0x3600000000000000000000000000000000000000"]);
  // the list query has no chain-agnostic "address(0) = ETH" arm left
  const queries = readFileSync(path.join(process.cwd(), "src/lib/launchpad/queries.ts"), "utf8");
  assert.doesNotMatch(queries, /WHEN l\.quote = \$\{NATIVE_ADDR\} THEN/);
  assert.match(queries, /NATIVE_QUOTES\[k\]\.key === "eth"/);
});
