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
  const elysiumNative = quoteInfo("elysium", NATIVE);
  assert.equal(elysiumNative.key, "hype");
  assert.equal(elysiumNative.symbol, "HYPE");
  assert.equal(elysiumNative.usd, null, "live-priced by the server (hypePrice.ts), never a fixed figure");
});

test("Elysium's native HYPE is never priced as ETH, and WHYPE shares HYPE's key", () => {
  const ethUsd = 4_321;
  assert.equal(quoteUsdOf(quoteInfo("elysium", NATIVE), ethUsd), null, "the static HYPE quote has no price until the server fills HYPE's");
  assert.equal(quoteUsdOf({ ...quoteInfo("elysium", NATIVE), usd: 74.5 }, ethUsd), 74.5);
  const whype = quoteInfo("elysium", "0xbA876237B0F021A6c6D852d6c26E107997cC5E81");
  assert.equal(whype.key, "hype");
  assert.equal(whype.symbol, "WHYPE");
  assert.deepEqual(quotesWithKey("hype").map((q) => `${q.chain}:${q.address}`).sort(), ["elysium:0x0000000000000000000000000000000000000000", "elysium:0xba876237b0f021a6c6d852d6c26e107997cc5e81"]);
  const usdc = quoteInfo("elysium", "0xb47c4C8F73F009CC0C0d3f92B388d13E293F0B65");
  assert.equal(usdc.key, "usdc");
  assert.equal(usdc.decimals, 6);
  assert.equal(quoteUsdOf(usdc, ethUsd), 1);
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
  assert.deepEqual(quotesWithKey("eth").map((q) => `${q.chain}:${q.address}`).sort(), ["base:0x0000000000000000000000000000000000000000", "base:0x4200000000000000000000000000000000000006", "robinhood:0x0000000000000000000000000000000000000000"], "native ETH where it is native, and WETH on Base; never Arc's address(0)");
  assert.deepEqual(quotesWithKey("usdc").map((q) => `${q.chain}:${q.address}`).sort(), ["arc:0x0000000000000000000000000000000000000000", "arc:0x3600000000000000000000000000000000000000", "base:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", "elysium:0xb47c4c8f73f009cc0c0d3f92b388d13e293f0b65"]);
  assert.ok(!fixed.some((q) => q.chain === "elysium" && q.address === NATIVE), "HYPE is live-priced, never a fixed quote");
  // the list query has no chain-agnostic "address(0) = ETH" arm: ETH's price goes to the chain-scoped "eth" quotes only
  const queries = readFileSync(path.join(process.cwd(), "src/lib/launchpad/queries.ts"), "utf8");
  assert.doesNotMatch(queries, /WHEN l\.quote = \$\{NATIVE_ADDR\} THEN/);
  assert.match(queries, /const ethArms = quotesWithKey\("eth"\)\.map\(\(\{ chain, address \}\) => db`WHEN \(l\.chain_id = \$\{chainIdOf\(chain\)\} AND l\.quote = \$\{address\}\) THEN \$\{ethFactor\}/);
  // HYPE's price goes to the chain-scoped "hype" quotes only, the way ETH's goes to the "eth" ones
  assert.match(queries, /const hypeArms = quotesWithKey\("hype"\)\.map\(\(\{ chain, address \}\) => db`WHEN \(l\.chain_id = \$\{chainIdOf\(chain\)\} AND l\.quote = \$\{address\}\) THEN \$\{hypeFactor\}/);
});
