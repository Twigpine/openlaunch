import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { en, messagesFor } from "../../i18n/messages/index.ts";

const page = readFileSync(new URL("../../app/rules/page.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("./RulesGuide.module.css", import.meta.url), "utf8");
// the guide's words are messages: English is the source text, Chinese its translation
const copy = JSON.stringify(en.info.rules);
const zh = messagesFor("zh-CN").info.rules;

// Source contracts supplement the page's responsive and keyboard browser review.
test("the rules guide retains native navigation and visible risk disclosures", () => {
  assert.match(page, /import SectionIntro from/);
  assert.match(page, /<nav aria-label=\{t\("rules\.onThisPage"\)\}>/);
  assert.equal(en.info.rules.onThisPage, "On this page");
  for (const anchor of ["launchpad", "fees", "immutable", "points", "know", "contracts"]) {
    assert.ok(page.includes(`id="${anchor}"`), `missing section: ${anchor}`);
  }
  assert.equal((page.match(/<details open>/g) ?? []).length, 9); // 4 on season points, 5 before you begin
  for (const key of ["points.intro", "know.intro", "know.price.snipers", "know.quiet.hidden", "know.twig.twig", "know.twig.gitlawb", "know.twig.prices", "know.stocks.securities"]) {
    assert.ok(page.includes(`t("rules.${key}"`), `the page shows rules.${key}`);
  }
  assert.match(copy, /no cash value, are not a token and not a promise of one/, "points are reputation, said where the rules are");
  assert.match(copy, /quiet launches/);
  assert.match(copy, /every launch stays in the New tab/i);
  assert.match(copy, /GITLAWB-quoted pool/);
  assert.match(copy, /GITLAWB fees burned when they are collected/);
  assert.match(copy, /TWIG- or GITLAWB-quoted pool/);
  assert.match(copy, /TWIG fees burned when they are collected/);
  assert.doesNotMatch(copy, /burns (TWIG|GITLAWB) on every trade/, "fees accrue and are burned when collected, not per trade");
  assert.match(copy, /one TWIG counts as one GITLAWB/);
  assert.match(copy, /a locked pool does not make a token valuable/);
  assert.match(copy, /Nothing is refundable/);
  assert.match(copy, /no anti-snipe mechanism/);
  assert.match(copy, /Regulation S/);
  assert.match(copy, /not offered to US persons/);
  assert.match(copy, /UK, Canada, Australia, Singapore and Switzerland/);
  assert.match(copy, /pause transfers or freeze wallets/);
  assert.doesNotMatch(page, /use client|useEffect|setInterval|onClick=/);
});

test("the Chinese guide keeps every risk and fee fact, and promises nothing the English does not", () => {
  assert.match(zh.points.intro, /没有现金价值，不是代币，也不是对代币的承诺，不能转让或出售/);
  assert.match(zh.know.headingBottom, /^不/, "locked liquidity is not a guarantee of value");
  assert.match(zh.know.intro, /锁定的资金池并不会让代币变得有价值/);
  assert.match(zh.know.intro, /一切均不可退款/);
  assert.match(zh.know.price.snipers, /没有防狙击机制/);
  assert.match(zh.know.twig.twig, /TWIG 手续费在领取时被销毁/);
  assert.match(zh.know.twig.gitlawb, /GITLAWB 手续费在领取时被销毁/);
  assert.match(zh.know.twig.prices, /一个 TWIG 按一个 GITLAWB 计算/);
  assert.match(zh.know.stocks.securities, /Regulation S/);
  assert.match(zh.know.stocks.securities, /不向美国人士发售/);
  assert.match(zh.know.stocks.securities, /英国、加拿大、澳大利亚、新加坡和瑞士/);
  assert.match(zh.know.stocks.securities, /暂停转账或冻结钱包/);
  assert.match(zh.launch.note, /代币仍可交易/);
  assert.doesNotMatch(JSON.stringify(zh), /最好|最佳|最安全|审计|零风险|无风险|稳赚|保本/);
});

test("the launch explanation distinguishes deposited supply, tradable tokens and fee routing", () => {
  const shown = page + copy;
  for (const fact of ["1 billion by default", "100% of the supply", "at launch", "Tokens remain tradeable", "ownerless locker", "0%, 1% or 3%", "beneficiaries", "credited to them", "claimed any time", "0x…dEaD"]) {
    assert.ok(shown.includes(fact), `missing product detail: ${fact}`);
  }
  assert.match(copy, /No pool trading fee\. Network gas still applies/);
  assert.match(copy, /no creator-reserved allocation/);
  assert.match(copy, /per unit of the quote asset/);
  assert.doesNotMatch(shown, /No rug|risk.free|only way to hold any is to buy|Trades cost only/);
});

test("the contract registry retains every configured explorer and verifier path", () => {
  assert.match(page, /CHAIN_KEYS\.map/);
  assert.match(page, /launchpad\(chain\)/);
  assert.match(page, /\["factory", "locker"\] as const/);
  assert.match(page, /explorerAddress\(chain, address\)/);
  assert.match(page, /config\.factory && config\.locker/);
  assert.match(page, /t\("rules\.contracts\.notDeployed"\)/);
  assert.equal(en.info.rules.contracts.notDeployed, "Not deployed yet");
  for (const destination of ["https://basescan.org/address/", "https://base.blockscout.com/address/", "https://robinhoodchain.blockscout.com/address/", "https://repo.sourcify.dev/8453/", "https://repo.sourcify.dev/4663/"]) {
    assert.ok(page.includes(destination), `missing verifier: ${destination}`);
  }
  assert.match(page, /verifier\.url\(config\.factory!\)/);
  assert.match(page, /verifier\.url\(config\.locker!\)/);
  assert.match(page, /href=\{BRAND_GITHUB\}/);
  assert.match(copy, /chain-specific Uniswap deployments/);
  assert.doesNotMatch(copy, /Identical bytecode/);
});

test("rules styling stays flat, theme-aware and accessible at compact widths", () => {
  assert.match(css, /:focus-visible/);
  assert.match(css, /min-height: 44px/);
  assert.match(css, /overflow-wrap: anywhere/);
  assert.match(css, /@media \(max-width: 639px\)/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.doesNotMatch(css, /box-shadow|text-shadow|gradient\(|#[\da-f]{3,8}\b/i);
  assert.doesNotMatch(css, /background(?:-color)?: var\(--color-brand\)/);
  assert.doesNotMatch(page + css, /—/);
});
