import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { SWAP_SITES } from "./config.ts";

const T = "0x" + "11".repeat(20);

test("SWAP_SITES: Base and Arc link out to Uniswap; Robinhood Chain has no outside link", () => {
  assert.equal(SWAP_SITES.base?.name, "Uniswap");
  assert.equal(SWAP_SITES.base?.url(T), `https://app.uniswap.org/swap?chain=base&outputCurrency=${T}`);
  assert.equal(SWAP_SITES.arc?.url(T), `https://app.uniswap.org/swap?chain=arc&outputCurrency=${T}`);
  assert.equal(SWAP_SITES.robinhood, undefined);
});

// Source contract: the token page renders the link only for a chain that has one.
test("the token page skips the outside swap link when the chain has none", () => {
  const page = readFileSync(new URL("../../app/t/[chain]/[token]/page.tsx", import.meta.url), "utf8");
  assert.match(page, /const swapSite = SWAP_SITES\[chain\];/);
  assert.match(page, /\{swapSite \? <a href=\{swapSite\.url\(l\.token\)\}/);
  assert.match(page, /\{l\.website \|\| l\.x_handle \|\| swapSite \? <div/, "no empty links row");
  assert.doesNotMatch(page, /pools\.trade/);
});
