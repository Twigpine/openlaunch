import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { CHAIN_KEYS } from "../chainKeys.ts";
import { BUY_PRESETS as TRADE_BUY_PRESETS, MCAP_PRESETS, coreQuoteNames, coreQuotes, launchpad, listedQuoteAddresses, quoteInfo, quoteUsdOf, quotesWithKey } from "./config.ts";
import { BUY_PRESETS as FIRST_BUY_PRESETS, defaultFirstBuy } from "./first-buy.ts";
import { GITLAWB_ADDRESS, GITLAWB_ADDRESS_ROBINHOOD } from "./gitlawb.ts";
import { MCAP_USD_TARGETS, capEntry, capPresets } from "./market-cap.ts";
import { quotePillOf } from "./ogcard.ts";
import { FILTERS, filterOnChain, isFilter, matchesFilter } from "./search.ts";
import { TWIG_ADDRESS, TWIG_ADDRESSES, TWIG_LOGO_PATH, gitlawbLinkedUsd, twigUsdFromGitlawb } from "./twig.ts";
import { cleanQuoteSymbol } from "./unlisted-quote.ts";
import { en, messagesFor } from "../../i18n/messages/index.ts";

/**
 * TWIG (twig.ts) is an official quote on Base: badged, priced at GITLAWB's USD price (one TWIG unwraps to one GITLAWB),
 * filterable. The Base launch form no longer offers it (the planned GITLAWB/TWIG token migration), as it stopped
 * offering GITLAWB before; launches already paired with either keep their badge and price. The Robinhood Chain form
 * dropped GITLAWB for the same migration, so no form offers either token.
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

test("the Base form offers ETH only; TWIG and GITLAWB leave the Base form but stay known, priced quotes", () => {
  assert.deepEqual(launchpad("base").quotes.map((q) => q.key), ["eth"], "ETH is the default and the only fixed quote (stocks come from the registry)");
  const tw = quoteInfo("base", TWIG_ADDRESS);
  assert.equal(tw.key, "twig", "existing TWIG-paired launches keep their key, badge and price");
  assert.ok(quotesWithKey("twig").some((q) => q.chain === "base" && q.address === TWIG_ADDRESS.toLowerCase()), "the TWIG filter chip still finds them");
  assert.ok(coreQuotes("base").some((q) => q.key === "twig"), "a community pair priced against TWIG still prices");
  const gl = quoteInfo("base", GITLAWB_ADDRESS);
  assert.equal(gl.key, "gitlawb", "existing GITLAWB-paired launches keep their key, badge and price");
  assert.equal(gl.symbol, "GITLAWB");
  assert.ok(listedQuoteAddresses("base").includes(GITLAWB_ADDRESS), "never shown as an unlisted pair");
  // Robinhood Chain: GITLAWB left its form too, and its launches keep everything else
  assert.deepEqual(launchpad("robinhood").quotes.map((q) => q.key), ["usdg", "eth"], "USDG stays the default");
  const rh = quoteInfo("robinhood", GITLAWB_ADDRESS_ROBINHOOD);
  assert.equal(rh.key, "gitlawb", "existing GITLAWB-paired Robinhood launches keep their key, badge and price");
  assert.equal(rh.symbol, "GITLAWB");
  assert.ok(listedQuoteAddresses("robinhood").includes(GITLAWB_ADDRESS_ROBINHOOD.toLowerCase()), "never shown as an unlisted pair");
  assert.ok(quotesWithKey("gitlawb").some((q) => q.chain === "robinhood" && q.address === GITLAWB_ADDRESS_ROBINHOOD.toLowerCase()), "the GITLAWB filter chip still finds them");
  assert.equal(coreQuoteNames("robinhood"), "USDG, ETH or GITLAWB", "pair price pools against GITLAWB still count, named in the same order");
  assert.equal(coreQuoteNames("base"), "ETH, TWIG, GITLAWB, USDC or WETH", "Base keeps its order too");
  for (const k of CHAIN_KEYS.filter((k) => k !== "base")) assert.ok(!launchpad(k).quotes.some((q) => q.key === "twig"), k);
});

test("TWIG's USD is exactly GITLAWB's, and unknown while GITLAWB's is", () => {
  assert.equal(twigUsdFromGitlawb(0.0000227), 0.0000227);
  for (const bad of [null, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) assert.equal(twigUsdFromGitlawb(bad), null, String(bad));
  // the one rule every caller uses: GITLAWB and TWIG take GITLAWB's price; every other quote keeps its own (undefined)
  assert.equal(gitlawbLinkedUsd("gitlawb", 0.0000227), 0.0000227);
  assert.equal(gitlawbLinkedUsd("twig", 0.0000227), 0.0000227);
  assert.equal(gitlawbLinkedUsd("twig", null), null);
  for (const k of ["eth", "usdg", "usdc", "pair", "stock", "other"]) assert.equal(gitlawbLinkedUsd(k, 0.0000227), undefined, k);
});

test("server: TWIG takes GITLAWB's price in rows, sorts and the quotes API; never its own thin pool", () => {
  const q = src("queries.ts");
  assert.match(q, /const linked = gitlawbLinkedUsd\(q\.key, st\.gitlawb\);[^\n]*\n  if \(linked !== undefined\) return \{ \.\.\.q, usd: linked \};/);
  assert.match(q, /const priceState = \(\): PriceState => \(\{ gitlawb: gitlawbUsdNow,/, "the snapshot carries the live GITLAWB price");
  assert.match(q, /const isGitlawbPriced = \(\) => db`\(\$\{isGitlawb\(\)\} OR \$\{quoteArms\("twig"\)\}\)`;/);
  assert.match(q, /WHEN \$\{isGitlawbPriced\(\)\} THEN \$\{gitlawbFactor\}::double precision/, "TWIG ranks at GITLAWB's price in the USD sorts");
  assert.match(q, /if \(opts\.filter === "twig"\) conds\.push\(db`\$\{quoteArms\("twig"\)\}`\);/);
  assert.match(q, /t\.twig_burned = add\(t\.twig_burned, r\.burned\)/);
  // the quotes API still prices TWIG and GITLAWB for outside callers; the form offers neither, so it never reads GITLAWB's price
  assert.match(src("../../app/api/quotes/route.ts"), /const linked = gitlawbLinkedUsd\(x\.key, gl\);/);
  for (const f of ["../../components/launchpad/LaunchForm.tsx", "../../app/launch/page.tsx"]) assert.doesNotMatch(src(f), /gitlawbUsd|gitlawbLinkedUsd/, f);
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
  const brand = src("../../components/launchpad/QuoteBadge.tsx");
  assert.match(brand, /if \(isTwigQuote\(quoteKey\)\) return "twig";/);
  assert.match(brand, /twig: <TwigBadge size=\{size\} className=\{className\}(?: collapse=\{collapse\})? \/>/);
  assert.match(brand, /return brandOf\(quoteKey\) !== null;/, "hasQuoteBrandBadge reads the same list QuoteBrandBadge renders from");
  for (const f of ["LaunchRow.tsx", "LaunchTape.tsx", "MeDashboard.tsx", "TrendingStrip.tsx"]) assert.match(src(`../../components/launchpad/${f}`), /<QuoteBrandBadge quoteKey=\{/, f);
  assert.match(src("../../components/launchpad/TrendingStrip.tsx"), /hasQuoteBrandBadge\(row\.quote_key\)/, "TWIG rows show the badge, not the bare symbol");
  const form = src("../../components/launchpad/LaunchForm.tsx");
  assert.doesNotMatch(form, /brandQuote|isBrandQuote|Pair with \{/, "no form nudges toward a branded quote: none is offered");
  assert.doesNotMatch(form, /QuoteBrandBadge/, "the form offers no branded quote, so it shows no quote badge (lists, token pages and share cards still do)");
  assert.match(src("../../app/t/[chain]/[token]/page.tsx"), /<TwigBadge label=\{t\("page\.pairedWith", \{ symbol: "TWIG" \}\)\} \/>/);
  assert.equal(en.token.page.pairedWith, "Paired with {symbol}");
  assert.deepEqual(quotePillOf("twig", "TWIG"), { symbol: "TWIG", ticker: "TW", kind: "twig" });
  assert.match(src("../../app/t/[chain]/[token]/opengraph-image.tsx"), /card\.quote\.kind === "twig"/);
  assert.match(src("../../components/launchpad/TradePanel.tsx"), /quote\.key === "twig"[\s\S]{0,240}t\.rich\("needTwig"/);
  assert.match(en.trade.panel.needTwig, /^Need TWIG\? Wrap GITLAWB 1:1 or buy TWIG at <link>/);
});

test("the published TWIG address is the one in config, everywhere agents read it", () => {
  for (const f of ["../../app/agents/page.tsx", "../../app/llms.txt/route.ts"]) {
    const found = src(f).match(/0x6aC18bcf4eDE02591d4917452700ea5eaAea13c1/g) ?? [];
    assert.ok(found.length >= 1, f);
    for (const a of found) assert.equal(a.toLowerCase(), TWIG_ADDRESS, f);
  }
});

test("the launch form never offers TWIG or GITLAWB: no option, no nudge, no token-only copy; the rules say why", () => {
  const gone = [TWIG_ADDRESS, GITLAWB_ADDRESS, GITLAWB_ADDRESS_ROBINHOOD].map((a) => a.toLowerCase());
  for (const k of CHAIN_KEYS) assert.ok(!launchpad(k).quotes.some((q) => q.key === "twig" || q.key === "gitlawb" || gone.includes(q.address.toLowerCase())), k);
  const form = src("../../components/launchpad/LaunchForm.tsx");
  assert.doesNotMatch(form, /"twig"|TwigMark|TWIG_WRAP_URL|wrap\.twigpine\.com/, "nothing in the form can pick, mark or explain TWIG");
  assert.doesNotMatch(form, /"gitlawb"|GitlawbMark|GITLAWB_SITE|gitlawbOrigin|gitlawbUsd|gitlawbLinkedUsd/, "nothing in the form can pick, mark, price or explain GITLAWB");
  // the form's words are messages (launch.form): no chain card, in any language, lists TWIG or GITLAWB
  for (const locale of ["en", "zh-CN"] as const) assert.doesNotMatch(JSON.stringify(messagesFor(locale).launch.form), /TWIG|GITLAWB/, locale);
  assert.equal(en.launch.form.chain.blurb.base, "Priced in ETH or a Coinbase tokenized stock. Gas ≈ cents.");
  assert.equal(en.launch.form.chain.blurb.robinhood, "Priced in USDG (dollars), ETH or a Robinhood Stock Token. Gas ≈ cents.");
  // the rules' words are messages too (info.rules): the page links the migration, the English says why
  const rules = src("../../app/rules/page.tsx");
  assert.match(rules, /t\.rich\("rules\.know\.twig\.twig", \{ link: \(chunks\) => <a href=\{TWIG_MIGRATE_URL\}/);
  const { twig, gitlawb } = en.info.rules.know.twig;
  assert.doesNotMatch(twig, /It is the quote the Base form offers/);
  assert.doesNotMatch(en.info.rules.launch.steps.market.description, /pairs your token with ETH, TWIG on Base/);
  assert.match(twig, /The Base form no longer offers it, ahead of the planned GITLAWB and TWIG token migration \(<link>migrate\.twigpine\.com<\/link>\)/);
  assert.match(twig, /Launches already paired with TWIG keep their badge, price and trading/);
  assert.doesNotMatch(`${gitlawb} ${en.info.rules.launch.steps.market.description}`, /The Robinhood Chain form offers it|ETH, GITLAWB or USDG on Robinhood Chain/);
  assert.match(gitlawb, /No launch form offers it any more, ahead of the same planned migration; pools already paired with GITLAWB, on either chain, keep their badge, price and trading/);
  for (const k of ["twig", "gitlawb"] as const) assert.match(messagesFor("zh-CN").info.rules.know.twig[k], /迁移/, `zh-CN ${k} gives the same reason`);
  assert.match(messagesFor("zh-CN").info.rules.know.twig.twig, /<link>migrate\.twigpine\.com<\/link>/);
  // every page and doc a person or an agent reads: none may say, in any wording, that a form offers TWIG or GITLAWB
  const said = /quote the (Base )?form offers there|form'?s quote|ETH, TWIG and stocks|besides ETH and TWIG|quote = ETH, TWIG on Base|GITLAWB or USDG on Robinhood|Robinhood Chain form offers it|form (also |still )?offers(?! neither)[^.;]*\b(TWIG|GITLAWB)\b|\b(TWIG|GITLAWB)\b[^.;]*\bthe (Base |Robinhood Chain )?form (also |still )?offers(?! neither)|(?<!no longer |not )offered in (the|a|its) (Base |Robinhood Chain )?(launch )?form[^.;]*\b(TWIG|GITLAWB)\b|\bpick (TWIG|GITLAWB)\b[^.;]*\bform\b/;
  const docs = ["../../../../README.md", "../../../../docs/pairs.md", "../../../../docs/boost.md"];
  // the agents page and the rules read their English from the info messages, so those are checked as well
  const messages = ["../../i18n/messages/en/info.json", "../../i18n/messages/en/launch.json"];
  for (const f of ["../../app/agents/page.tsx", "../../app/llms.txt/route.ts", "../../app/rules/page.tsx", "../../app/pairs/page.tsx", "pairs.ts", "pairApply.ts", "../../app/api/quotes/route.ts", ...messages, ...docs]) {
    assert.doesNotMatch(src(f), said, f);
  }
  // the Base landing page lists stocks beside ETH, as the form does, rather than reading as an ETH-only chain
  assert.match(src("../../components/launchpad/ChainLanding.tsx"), /\.\.\.\(STOCK_SOURCE\[chain\] \? \[t\("chain\.stocks"\)\] : \[\]\)/);
  assert.equal(en.info.chain.stocks, "Stocks");
});
