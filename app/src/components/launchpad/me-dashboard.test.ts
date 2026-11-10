import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { en, messagesFor } from "../../i18n/messages/index.ts";

const source = readFileSync(new URL("./MeDashboard.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("./MeDashboard.module.css", import.meta.url), "utf8");
const page = readFileSync(new URL("../../app/me/page.tsx", import.meta.url), "utf8");
const edit = readFileSync(new URL("./EditTokenSheet.tsx", import.meta.url), "utf8");
// the dashboard's words (`tr` in the source, since `t` is the token in its lists)
const words = en.account.dashboard;

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
  assert.match(disconnected, /tr\("welcome\.after"\)/);
  assert.equal(words.welcome.after, "After you connect");
  // connecting goes through the shared picker, which owns wallet choice and connect errors
  assert.match(disconnected, /<ConnectWallet className=\{styles.connectButton\}>/);
  assert.doesNotMatch(disconnected, /useConnect|connect\(\{ connector/);
  assert.match(disconnected, /tr\("welcome\.readOnly"\)/);
  assert.match(words.welcome.readOnly, /Transactions and edits need your signature/);
  assert.doesNotMatch(disconnected, /<Stat\b|\$[0-9]|Connected wallet|writeContract|signMessage/);
});

test("dashboard tabs preserve launches, holdings, trades and recoverable failures", () => {
  assert.match(source, /@\/components\/vendor\/tabs/);
  assert.match(source, /aria-label=\{tr\("tabs\.label"\)\}/);
  assert.equal(words.tabs.label, "Your wallet activity");
  for (const name of ["launches", "holdings", "trades"]) {
    assert.ok(source.includes(`<TabsTab value="${name}">`));
    assert.ok(source.includes(`<TabsPanel value="${name}">`));
    assert.ok(source.includes(`icon="${name}"`));
  }
  assert.match(source, /<h2>\{tr\("loadError"\)\}<\/h2>/);
  assert.equal(words.loadError, "We couldn’t load your dashboard.");
  assert.match(source, /\{tr\("tryAgain"\)\}/);
  assert.equal(words.tryAgain, "Try again");
  assert.match(source, /tr\("refreshFailed", \{ error: err \}\)/);
  assert.match(words.refreshFailed, /Showing the last loaded data/);
  assert.match(source, /aria-busy="true"/);
});

test("unavailable RPC values remain distinct from a zero balance or zero pending fees", () => {
  assert.match(source, /b\[key\(t\)\] = null/);
  assert.match(source, /holdings\.reading \? tr\("reading"\) : holdings\.unknown \? "—" : fmtUsd\(holdings\.usd, \{ compact: true \}\)/);
  assert.equal(words.reading, "Reading…");
  // the total comes from the tested helper, fed each token's balance, price and whether anything prices its quote
  assert.match(source, /const holdings = holdingsValue\(\(me\?\.tokens \?\? \[\]\)\.map\(\(t\) => \(\{ balance: balances\[key\(t\)\], priceQuote: t\.price_quote, quoteUsd: t\.quote_usd, priced: t\.quote_priced \}\)\)\);/);
  assert.match(source, /holdings\.unknown \? tr\("stats\.holdingsUnknown"\) : holdings\.unpriced \? tr\("stats\.holdingsUnpriced", \{ count: holdings\.unpriced \}\) : tr\("stats\.holdingsHint"\)/);
  assert.equal(words.stats.holdingsUnknown, "A balance or price is unavailable");
  assert.equal(words.stats.holdingsUnpriced, "Excludes {count} with no USD price");
  assert.equal(words.stats.holdingsHint, "Current estimated USD value");
  assert.match(source, /feesReading \? tr\("reading"\) : feesUnknown \? "—"/);
  assert.match(source, /bal === undefined \? tr\("reading"\) : bal === null \? "—"/);
  assert.match(source, /hint=\{tr\("stats\.earnedHint"\)\}/);
  assert.equal(words.stats.earnedHint, "Your share, USD-priced launches");
  // in either language the holdings value is an estimate, never a quote anyone guarantees
  assert.match(source, /\{tr\("holdings\.note"\)\}/);
  assert.match(words.holdings.note, /not a guaranteed trade quote/);
  assert.match(messagesFor("zh-CN").account.dashboard.holdings.note, /估算，并非保证成交的报价/);
});

test("fee collection and full signed metadata editing keep their existing transaction paths", () => {
  assert.match(source, /functionName: "collect", args: \[BigInt\(l\.token_id\)\], account: address, dataSuffix: BUILDER_DATA_SUFFIX/);
  assert.match(source, /wallet\.writeContract\(request\)/);
  assert.match(source, /waitForTransactionReceipt\(\{ hash \}\)/);
  assert.match(source, /\/api\/launch\/sync\?chain=\$\{l\.chain\}&tx=\$\{hash\}/);
  assert.match(source, /if \(hasFees\(pending\[key\(l\)\]\)\) await collect\(l\)/);
  assert.match(source, /<EditTokenSheet/);
  for (const field of ["description", "image_url", "website", "x_handle"]) {
    assert.ok(source.includes(`${field}: editing.${field}`));
    assert.ok(edit.includes(`f.${field}`));
  }
  assert.match(edit, /buildEditMessage/);
  assert.match(edit, /wallet\.signMessage\(\{ message \}\)/);
  assert.match(source, /\{tr\("launches\.note"\)\}/);
  assert.match(words.launches.note, /Name, symbol, fee and beneficiaries cannot change/);
});

test("dashboard controls, tables and responsive styling remain accessible and theme-native", () => {
  assert.match(source, /scope="col"/);
  assert.match(source, /aria-label=\{tr\("trades\.table"\)\} tabIndex=\{0\}/);
  assert.equal(words.trades.table, "Your trades table");
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
  assert.match(source, /disabled=\{busy !== null \|\| !hasFees\(p\)\}/);
  // earned (total and per row) prices the token share too, and marks it as an estimate
  assert.match(source, /feeSidesUsd\(earnedSides\(l, feeShareBps\(l\.recipients, address\)\), l\.quote_decimals, l\.price_quote, l\.quote_usd\)/);
  assert.match(source, /earned\.token > 0n \? "≈ " : ""/);
  assert.match(source, /fmtTokens\(p\.token\)/);
  assert.doesNotMatch(source, /earnedRaw\(l\.fees_quote_collected/);
});
