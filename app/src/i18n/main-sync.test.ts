import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { createTranslator } from "use-intl/core";
import { en, messagesFor } from "./messages/index.ts";
import { BOOST_PAGE, buildPaletteGroups } from "../lib/command-palette.ts";
import { PAIR_COPY, PAIR_PRICE_KIND_LABEL, PAIR_PRICE_KINDS } from "../lib/launchpad/pairs.ts";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8").replaceAll("\r\n", "\n");
const tokenPage = read("../app/t/[chain]/[token]/page.tsx");

test("wallet UI translations retain their namespace without key-material filenames", () => {
  for (const locale of ["en", "zh-CN"] as const) {
    assert.equal(existsSync(new URL(`./messages/${locale}/wallet.json`, import.meta.url)), false);
    assert.equal(existsSync(new URL(`./messages/${locale}/wallet-ui.json`, import.meta.url)), false);
    assert.ok(existsSync(new URL(`./messages/${locale}/account-ui.json`, import.meta.url)));
    assert.ok(messagesFor(locale).wallet.connected.length > 0);
  }
});

test("Boost search stays feature-gated in both languages and matches English or Chinese", () => {
  for (const locale of ["en", "zh-CN"] as const) {
    const text = messagesFor(locale).search;
    const build = (query: string, boost: boolean) => buildPaletteGroups({ query, tokens: [], trending: [], theme: "dark", text, boost }).flatMap((g) => g.items);
    assert.ok(!build("", false).some((item) => item.id === BOOST_PAGE.id));
    for (const query of ["boost", text.pages.boosted.label]) {
      const item = build(query, true).find((item) => item.id === BOOST_PAGE.id);
      assert.ok(item?.kind === "page");
      assert.equal(item.href, "/#boosted");
      assert.equal(item.label, text.pages.boosted.label);
      assert.ok(!build(query, false).some((item) => item.id === BOOST_PAGE.id));
    }
  }
  const palette = read("../components/CommandPalette.tsx");
  assert.match(palette, /const boost = useBoostOn\(\);/);
  assert.match(palette, /theme, text, earn, boost \}\), \[query, current, trending, theme, text, earn, boost\]/);
});

test("community pair English disclosures stay identical to the canonical product copy", () => {
  const t = createTranslator({ locale: "en", messages: en, timeZone: "UTC" });
  const symbol = "TEST";
  assert.equal(t("token.badges.community", { symbol }), PAIR_COPY.badgeTitle(symbol));
  assert.equal(t("token.page.aboutTab.communityPair", { symbol }), PAIR_COPY.about(symbol));
  assert.equal(t("token.page.aboutTab.pairDelisted", { symbol }), PAIR_COPY.delisted(symbol));
  for (const reason of [null, "Liquidity below the listing floor."]) {
    assert.equal(t("token.page.aboutTab.pairSuspended", { symbol, reason: reason ? t("token.page.aboutTab.pairReason", { reason }) : "" }), PAIR_COPY.suspended(symbol, reason));
  }
  for (const kind of PAIR_PRICE_KINDS) assert.equal(t(`token.page.aboutTab.pairSources.${kind}`), PAIR_PRICE_KIND_LABEL[kind]);
});

test("community pair Chinese warnings preserve user data and the distinction between listed and suspended", () => {
  const t = createTranslator({ locale: "zh-CN", messages: messagesFor("zh-CN"), timeZone: "UTC" });
  const symbol = "TEST";
  assert.match(t("token.page.aboutTab.communityPair", { symbol }), /TEST.*不代表背书/);
  assert.match(t("token.badges.community", { symbol }), /TEST.*不代表背书/);
  const reason = "Liquidity below threshold";
  const suspended = t("token.page.aboutTab.pairSuspended", { symbol, reason: t("token.page.aboutTab.pairReason", { reason }) });
  assert.ok(suspended.includes(reason), "the public status reason is data, not translated or discarded");
  assert.match(suspended, /不显示美元价格或徽章/);
  assert.match(t("token.page.aboutTab.pairDelisted", { symbol }), /仍以未收录交易对的形式交易/);
  assert.match(tokenPage, /unlisted && pairRec && pairRec\.status !== "listed"/);
  assert.match(tokenPage, /pairRec\.status_reason \? t\("page\.aboutTab\.pairReason", \{ reason: pairRec\.status_reason \}\) : ""/);
  assert.match(tokenPage, /t\(`page\.aboutTab\.pairSources\.\$\{pairRec\.price_kind\}`\)/);
  assert.match(tokenPage, /<Link href=\{pairPath\(chain, l\.quote\)\}/);
});

test("the merge retains dynamic pair presets and the shared X intent builder", () => {
  const trade = read("../components/launchpad/TradePanel.tsx");
  assert.match(trade, /!viaEth && quote\.key === "pair" \? pairBuyPresets\(quote\.usd, quote\.decimals\) : BUY_PRESETS\[viaEth \? "eth" : quote\.key\]/);
  assert.match(trade, /aria-label=\{t\("payPreset", \{ amount: p, symbol: pay\.symbol \}\)\}/);
  assert.match(tokenPage, /intentUrl\(shareText, \{ url: `\$\{SITE_URL\}\/t\/\$\{chain\}\/\$\{l\.token\}` \}\)/);
  assert.doesNotMatch(tokenPage, /MuseworldBadge|quote\.key === "museworld"|https:\/\/x\.com\/intent/);
  assert.equal(existsSync(new URL("../components/launchpad/MuseworldBadge.tsx", import.meta.url)), false);
});

test("TWIG burn totals keep boost attribution and the rolling-deploy zero floor in both locales", () => {
  const mechanism = read("../components/launchpad/LaunchMechanism.tsx");
  assert.match(mechanism, /const twigBoosted = BigInt\(t\.twig_boost_burned \?\? "0"\);/);
  assert.match(mechanism, /const twigFees = BigInt\(twigBurned\) > twigBoosted \? BigInt\(twigBurned\) - twigBoosted : 0n;/);
  assert.match(mechanism, /title=\{twigBurnedWhy\}/);
  assert.match(mechanism, /: tr\("twigBurnedTitle"\);/);
  for (const locale of ["en", "zh-CN"] as const) {
    const t = createTranslator({ locale, messages: messagesFor(locale), namespace: "launch.totals", timeZone: "UTC" });
    const text = t("twigBoostBurnedTitle", { fees: "12 TWIG", boosts: "34 TWIG" });
    for (const value of ["Base", "0x…dEaD", "12 TWIG", "34 TWIG"]) assert.ok(text.includes(value));
  }
  const rules = read("../app/rules/page.tsx");
  assert.match(rules, /"noAdmin", "anyPair"/);
  assert.match(rules, /\{boostEnabled\(\) \? <BoostRulesEntry \/> : null\}/);
  assert.match(en.info.rules.fixed.anyPair.description, /any ERC-20.*public checks.*no USD price/);
});
