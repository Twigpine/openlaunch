import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./MeDashboard.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("./MeDashboard.module.css", import.meta.url), "utf8");
const page = readFileSync(new URL("../../app/me/page.tsx", import.meta.url), "utf8");
const edit = readFileSync(new URL("./EditTokenSheet.tsx", import.meta.url), "utf8");

// Source contracts complement the disconnected responsive browser review.
// They do not simulate a connected wallet or sign transactions.
test("Me keeps a server page shell and isolates dashboard state by wallet", () => {
  assert.match(page, /<SectionIntro\s/);
  assert.doesNotMatch(page, /use client/);
  assert.match(source, /<WalletDashboard key=\{address\?\.toLowerCase\(\) \?\? "disconnected"\}/);
  assert.match(source, /fetch\(`\/api\/me\?wallet=\$\{address\}`, \{ cache: "no-store" \}\)/);
});

test("the disconnected wallet view is a capability outline, not invented account data", () => {
  const disconnected = source.slice(source.indexOf("if (!isConnected || !address)"), source.indexOf("const collectable"));
  assert.match(disconnected, /After you connect/);
  // connecting goes through the shared picker, which owns wallet choice and connect errors
  assert.match(disconnected, /<ConnectWallet className=\{styles.connectButton\}>/);
  assert.doesNotMatch(disconnected, /useConnect|connect\(\{ connector/);
  assert.match(disconnected, /Transactions and edits need your signature/);
  assert.doesNotMatch(disconnected, /<Stat\b|\$[0-9]|Connected wallet|writeContract|signMessage/);
});

test("dashboard tabs preserve launches, holdings, trades and recoverable failures", () => {
  assert.match(source, /@\/components\/vendor\/tabs/);
  assert.match(source, /aria-label="Your wallet activity"/);
  for (const name of ["launches", "holdings", "trades"]) {
    assert.ok(source.includes(`<TabsTab value="${name}">`));
    assert.ok(source.includes(`<TabsPanel value="${name}">`));
    assert.ok(source.includes(`icon="${name}"`));
  }
  assert.match(source, /We couldn’t load your dashboard/);
  assert.match(source, /Try again/);
  assert.match(source, /Showing the last loaded data/);
  assert.match(source, /aria-busy="true"/);
});

test("unavailable RPC values remain distinct from a zero balance or zero pending fees", () => {
  assert.match(source, /b\[key\(t\)\] = null/);
  assert.match(source, /holdingsReading \? "Reading…" : holdingsUnknown \? "—"/);
  assert.match(source, /feesReading \? "Reading…" : feesUnknown \? "—"/);
  assert.match(source, /bal === undefined \? "Reading…" : bal === null \? "—"/);
  assert.match(source, /Your share, USD-priced launches/);
  assert.match(source, /not a guaranteed trade quote/);
});

test("fee collection and full signed metadata editing keep their existing transaction paths", () => {
  assert.match(source, /functionName: "collect", args: \[BigInt\(l\.token_id\)\], account: address, dataSuffix: BUILDER_DATA_SUFFIX/);
  assert.match(source, /wallet\.writeContract\(request\)/);
  assert.match(source, /waitForTransactionReceipt\(\{ hash \}\)/);
  assert.match(source, /\/api\/launch\/sync\?chain=\$\{l\.chain\}&tx=\$\{hash\}/);
  assert.match(source, /const targets = me\.launches\.filter\(\(l\) => hasFees\(pending\[key\(l\)\]\)\)/);
  assert.match(source, /if \(!mounted\.current \|\| !await collect\(l\)\) break/);
  assert.match(source, /<EditTokenSheet/);
  for (const field of ["description", "image_url", "website", "x_handle"]) {
    assert.ok(source.includes(`${field}: editing.${field}`));
    assert.ok(edit.includes(`f.${field}`));
  }
  assert.match(edit, /buildEditMessage/);
  assert.match(edit, /wallet\.signMessage\(\{ message \}\)/);
  assert.match(source, /Name, symbol, fee and beneficiaries cannot change/);
});

test("wallet identity and finite feedback do not replace receipt-based collection success", () => {
  assert.match(source, /<WalletAvatar address=\{address\} size=\{40\}/);
  assert.match(source, /collecting\.current \|\| collectingBatch\.current/);
  assert.match(source, /if \(!mounted\.current\) return false/);
  const receiptGuard = source.indexOf('if (receipt.status !== "success")');
  const confirmedFeedback = source.indexOf('stage: "confirmed", message:');
  assert.ok(receiptGuard >= 0, "collection must check the receipt status");
  assert.ok(confirmedFeedback >= 0, "collection must provide confirmed feedback");
  assert.ok(receiptGuard < confirmedFeedback, "the receipt check must precede confirmed feedback");
  assert.match(source, /setCollection\(\{ symbol: l\.symbol, stage: "signing" \}\)/);
  assert.match(source, /setCollection\(\{ symbol: l\.symbol, stage: "confirming" \}\)/);
  assert.match(source, /Indexed totals may take a moment to update/);
  assert.match(source, /Each collection needs your approval/);
  assert.match(source, /setTimeout\(\(\) => setRefreshed\(false\), 3000\)/);
  assert.match(source, /setTimeout\(\(\) => setCollection\(null\), 6000\)/);
  assert.match(source, /role="status" aria-live="polite" aria-atomic="true"/);
  assert.match(source, /collection\.stage === "failed" \? <CircleAlert size=\{16\}/);
  assert.doesNotMatch(source, /setInterval|setTimeout\([^\n]*stage: "confirmed"/);
});

test("dashboard controls, tables and responsive styling remain accessible and theme-native", () => {
  assert.match(source, /scope="col"/);
  assert.match(source, /aria-label="Your trades table" tabIndex=\{0\}/);
  assert.match(source, /explorerTx\(t\.chain, t\.tx_hash\)/);
  assert.match(css, /min-height: 44px/);
  assert.match(css, /:focus-visible/);
  assert.match(css, /@media \(max-width: 399px\)/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.doesNotMatch(css, /gradient\(|box-shadow|text-shadow|#[\da-f]{3,8}\b|animation:/i);
  assert.doesNotMatch(css, /background(?:-color)?: var\(--color-brand\)/);
  assert.doesNotMatch(source + css + page, /font-display/);
});

test("dashboard fees cover both pool sides: quote and the launched token", () => {
  // collect() returns (quoteOut, tokenOut); a sells-only pool must still count as collectable.
  assert.match(source, /p\[key\(l\)\] = \{ quote: result\[0\], token: result\[1\] \}/);
  assert.match(source, /filter\(\(l\) => hasFees\(pending\[key\(l\)\]\)\)/);
  assert.match(source, /disabled=\{busy !== null \|\| batch !== null \|\| !hasFees\(p\)\}/);
  // earned (total and per row) prices the token share too, and marks it as an estimate
  assert.match(source, /feeSidesUsd\(earnedSides\(l, feeShareBps\(l\.recipients, address\)\), l\.quote_decimals, l\.price_quote, l\.quote_usd\)/);
  assert.match(source, /earned\.token > 0n \? "≈ " : ""/);
  assert.match(source, /fmtTokens\(p\.token\)/);
  assert.doesNotMatch(source, /earnedRaw\(l\.fees_quote_collected/);
});
