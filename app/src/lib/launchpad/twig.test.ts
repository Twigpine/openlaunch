import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { CHAIN_KEYS } from "../chainKeys.ts";
import { BUY_PRESETS as TRADE_BUY_PRESETS, MCAP_PRESETS, launchpad, listedQuoteAddresses, quoteInfo, quoteUsdOf } from "./config.ts";
import { BUY_PRESETS as FIRST_BUY_PRESETS, defaultFirstBuy } from "./first-buy.ts";
import { GITLAWB_ADDRESS, GITLAWB_ADDRESS_ROBINHOOD } from "./gitlawb.ts";
import { MCAP_USD_TARGETS, capEntry, capPresets } from "./market-cap.ts";
import { quotePillOf } from "./ogcard.ts";
import { FILTERS, filterOnChain, isFilter, matchesFilter } from "./search.ts";
import { TWIG_ADDRESS, TWIG_ADDRESSES, TWIG_LOGO_PATH, gitlawbLinkedUsd, twigUsdFromGitlawb } from "./twig.ts";
import { cleanQuoteSymbol } from "./unlisted-quote.ts";

/**
 * TWIG (twig.ts) is the quote the Base launch form offers in GITLAWB's place: badged, priced at GITLAWB's USD price
 * (one TWIG unwraps to one GITLAWB), filterable. GITLAWB stays a known quote on Base, so its launches keep their
 * badge and price, and the Robinhood Chain form keeps offering it.
 */
const src = (rel: string) => readFileSync(path.join(import.meta.dirname, rel), "utf8");

test("TWIG resolves on Base by address, with its logo; nowhere else", () => {
  const q = quoteInfo("base", "0x6aC18bcf4eDE02591d4917452700ea5eaAea13c1");
  assert.equal(q.key, "twig");
  assert.equal(q.symbol, "TWIG");
  assert.equal(q.name, "Twigpine");
  assert.equal(q.decimals, 18, "on-chain decimals() = 18; the SQL sorts assume 18 for it");
  assert.equal(q.logo, TWIG_LOGO_PATH);
  assert.equal(quoteUsdOf(q, 4_000), null, "client-safe static: the server fills the price, never the ETH price");
  for (const k of CHAIN_KEYS.filter((k) => k !== "base")) {
    assert.equal(TWIG_ADDRESSES[k], null, `${k}: TWIG is not bridged`);
    assert.equal(quoteInfo(k, TWIG_ADDRESS).key, "other", `${k}: the same address is some other token`);
  }
  assert.ok(listedQuoteAddresses("base").includes(TWIG_ADDRESS), "known, so the indexer does not treat it as unlisted");
});

test("the Base form offers ETH then TWIG; GITLAWB leaves the Base form but stays a known, priced quote", () => {
  assert.deepEqual(launchpad("base").quotes.map((q) => q.key), ["eth", "twig"], "ETH stays the default");
  const gl = quoteInfo("base", GITLAWB_ADDRESS);
  assert.equal(gl.key, "gitlawb", "existing GITLAWB-paired launches keep their key, badge and price");
  assert.equal(gl.symbol, "GITLAWB");
  assert.ok(listedQuoteAddresses("base").includes(GITLAWB_ADDRESS), "never shown as an unlisted pair");
  // Robinhood Chain has no TWIG: its form keeps GITLAWB
  assert.deepEqual(launchpad("robinhood").quotes.map((q) => q.key), ["usdg", "eth", "gitlawb"]);
  assert.equal(quoteInfo("robinhood", GITLAWB_ADDRESS_ROBINHOOD).key, "gitlawb");
  for (const k of CHAIN_KEYS.filter((k) => k !== "base")) assert.ok(!launchpad(k).quotes.some((q) => q.key === "twig"), k);
});

test("TWIG's USD is exactly GITLAWB's, and unknown while GITLAWB's is", () => {
  assert.equal(twigUsdFromGitlawb(0.0000227), 0.0000227);
  for (const bad of [null, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) assert.equal(twigUsdFromGitlawb(bad), null, String(bad));
  // the one rule every caller uses: GITLAWB and TWIG take GITLAWB's price; every other quote keeps its own (undefined)
  assert.equal(gitlawbLinkedUsd("gitlawb", 0.0000227), 0.0000227);
  assert.equal(gitlawbLinkedUsd("twig", 0.0000227), 0.0000227);
  assert.equal(gitlawbLinkedUsd("twig", null), null);
  for (const k of ["eth", "usdg", "usdc", "museworld", "stock", "other"]) assert.equal(gitlawbLinkedUsd(k, 0.0000227), undefined, k);
});

test("server: TWIG takes GITLAWB's price in rows, sorts and the quotes API; never its own thin pool", () => {
  const q = src("queries.ts");
  assert.match(q, /const linked = gitlawbLinkedUsd\(q\.key, gitlawbUsdNow\);[^\n]*\n  if \(linked !== undefined\) return \{ \.\.\.q, usd: linked \};/);
  assert.match(q, /const isGitlawbPriced = \(\) => db`\(\$\{isGitlawb\(\)\} OR \$\{quoteArms\("twig"\)\}\)`;/);
  assert.match(q, /WHEN \$\{isGitlawbPriced\(\)\} THEN \$\{gitlawbFactor\}::double precision/, "TWIG ranks at GITLAWB's price in the USD sorts");
  assert.match(q, /if \(opts\.filter === "twig"\) conds\.push\(db`\$\{quoteArms\("twig"\)\}`\);/);
  assert.match(q, /t\.twig_burned = add\(t\.twig_burned, r\.burned\)/);
  assert.match(src("../../app/api/quotes/route.ts"), /gitlawbLinkedUsd\(x\.key, gl\)/);
  assert.match(src("../../components/launchpad/LaunchForm.tsx"), /const linkedUsd = gitlawbLinkedUsd\(staticQuote\.key, gitlawbUsd\);/);
  assert.doesNotMatch(src("twig.ts"), /getSlot0|StateView|readContract/, "no price read of its own");
});

test("a fake TWIG at another address shows by address, not as ours", () => {
  for (const fake of ["TWIG", "twig", "$TWIG", "TWIGPINE", "Twigpine", "TWIG2", "Twig.v2", "ＴＷＩＧ"]) assert.equal(cleanQuoteSymbol(fake), null, fake);
  assert.equal(cleanQuoteSymbol("PINE"), "PINE", "a different name stays readable");
});

test("TWIG filter: Base only, matches the TWIG key", () => {
  assert.ok(isFilter("twig"));
  const f = FILTERS.find((x) => x.key === "twig");
  assert.ok(f);
  assert.equal(f.label, "TWIG");
  assert.ok(filterOnChain(f, "base") && filterOnChain(f, null));
  assert.ok(!filterOnChain(f, "robinhood") && !filterOnChain(f, "arc"));
  const row = { name: "x", symbol: "X", token: "0x1", lp_fee: 10_000, quote_key: "twig", block_time: new Date().toISOString(), recipients: [] };
  assert.ok(matchesFilter(row, "twig"));
  assert.ok(!matchesFilter({ ...row, quote_key: "gitlawb" }, "twig"));
  assert.ok(!matchesFilter(row, "gitlawb"));
});

test("presets: dollar caps from the live price, TWIG-unit buys like GITLAWB's", () => {
  assert.deepEqual(MCAP_PRESETS.twig, [], "no quote-unit caps: the dollar targets apply once priced");
  assert.deepEqual(capPresets(capEntry(0.0000227), "twig"), MCAP_USD_TARGETS);
  assert.deepEqual(TRADE_BUY_PRESETS.twig, TRADE_BUY_PRESETS.gitlawb, "one TWIG = one GITLAWB");
  assert.equal(defaultFirstBuy({ key: "twig", decimals: 18, usd: 0.0000227 }), FIRST_BUY_PRESETS.twig[0]);
  assert.equal(FIRST_BUY_PRESETS.twig[0], "1000000", "about $25 at GITLAWB's price when this was written");
});

test("badge: Twigpine tile in every list, the form, the token page and the share card", () => {
  assert.ok(existsSync(path.join(import.meta.dirname, "../../../public", TWIG_LOGO_PATH)));
  const brand = src("../../components/launchpad/MuseworldBadge.tsx");
  assert.match(brand, /if \(isTwigQuote\(quoteKey\)\) return "twig";/);
  assert.match(brand, /twig: <TwigBadge size=\{size\} className=\{className\} \/>/);
  assert.match(brand, /return brandOf\(quoteKey\) !== null;/, "hasQuoteBrandBadge reads the same list QuoteBrandBadge renders from");
  for (const f of ["LaunchRow.tsx", "LaunchTape.tsx", "MeDashboard.tsx", "TrendingStrip.tsx"]) assert.match(src(`../../components/launchpad/${f}`), /<QuoteBrandBadge quoteKey=\{/, f);
  assert.match(src("../../components/launchpad/TrendingStrip.tsx"), /hasQuoteBrandBadge\(row\.quote_key\)/, "TWIG rows show the badge, not the bare symbol");
  const form = src("../../components/launchpad/LaunchForm.tsx");
  assert.match(form, /const brandQuote = cfg\.quotes\.find\(\(q\) => q\.key === "twig"\) \?\? cfg\.quotes\.find\(\(q\) => q\.key === "gitlawb"\) \?\? null;/, "TWIG is the nudge wherever the form offers it");
  assert.match(form, /Pair with \{brandQuote\.symbol\}, get the <QuoteBrandBadge quoteKey=\{brandQuote\.key\} \/> badge/);
  assert.match(form, /<QuoteBrandBadge quoteKey=\{quote\.key\} size="md" \/>/);
  assert.match(src("../../app/t/[chain]/[token]/page.tsx"), /<TwigBadge label="Paired with TWIG" \/>/);
  assert.deepEqual(quotePillOf("twig", "TWIG"), { symbol: "TWIG", ticker: "TW", kind: "twig" });
  assert.match(src("../../app/t/[chain]/[token]/opengraph-image.tsx"), /card\.quote\.kind === "twig"/);
  assert.match(src("../../components/launchpad/TradePanel.tsx"), /quote\.key === "twig"[\s\S]{0,240}Need TWIG\? Wrap GITLAWB 1:1 or buy TWIG at/);
});

test("the published TWIG address is the one in config, everywhere agents read it", () => {
  for (const f of ["../../app/agents/page.tsx", "../../app/llms.txt/route.ts"]) {
    const found = src(f).match(/0x6aC18bcf4eDE02591d4917452700ea5eaAea13c1/g) ?? [];
    assert.ok(found.length >= 1, f);
    for (const a of found) assert.equal(a.toLowerCase(), TWIG_ADDRESS, f);
  }
});
