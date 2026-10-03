import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const page = readFileSync(new URL("../../app/rules/page.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("./RulesGuide.module.css", import.meta.url), "utf8");
const contents = readFileSync(new URL("./DocumentationContents.tsx", import.meta.url), "utf8");
const contentsCss = readFileSync(new URL("./DocumentationContents.module.css", import.meta.url), "utf8");

// Source contracts supplement the page's responsive and keyboard browser review.
test("the rules guide retains native navigation and visible risk disclosures", () => {
  assert.match(page, /import SectionIntro from/);
  assert.match(page, /aria-label="On this page"/);
  for (const anchor of ["launchpad", "fees", "immutable", "know", "contracts"]) {
    assert.ok(page.includes(`id="${anchor}"`), `missing section: ${anchor}`);
  }
  assert.equal((page.match(/<details open>/g) ?? []).length, 5);
  assert.match(page, /quiet launches/);
  assert.match(page, /every launch stays in the New tab/i);
  assert.match(page, /GITLAWB-quoted pool/);
  assert.match(page, /burns GITLAWB on every trade/);
  assert.match(page, /a locked pool does not make a token valuable/);
  assert.match(page, /Nothing is refundable/);
  assert.match(page, /no anti-snipe mechanism/);
  assert.match(page, /Regulation S/);
  assert.match(page, /not offered to US persons/);
  assert.match(page, /UK, Canada, Australia, Singapore and Switzerland/);
  assert.match(page, /pause transfers or freeze wallets/);
  assert.doesNotMatch(page, /use client|useEffect|setInterval|onClick=/);
});

test("the active documentation marker enhances native anchors without scrolling or stealing focus", () => {
  assert.match(page, /<DocumentationContents sections=\{CONTENT_LINKS\}/);
  assert.match(contents, /href=\{`#\$\{id\}`\}/);
  assert.match(contents, /aria-current=\{active === id \? "location" : undefined\}/);
  assert.match(contents, /addEventListener\("scroll", queue, \{ passive: true \}\)/);
  assert.match(contents, /removeEventListener\("scroll", queue\)/);
  assert.match(contents, /cancelAnimationFrame\(frame\)/);
  assert.doesNotMatch(contents, /\.focus\(|scrollIntoView|preventDefault|setInterval/);
  assert.match(contentsCss, /prefers-reduced-motion/);
  assert.match(contentsCss, /min-height: 44px/);
});

test("the launch explanation distinguishes deposited supply, tradable tokens and fee routing", () => {
  for (const fact of ["1 billion by default", "100% of the supply", "at launch", "Tokens remain tradeable", "ownerless locker", "0%, 1% or 3%", "beneficiaries", "credited to them", "claimed any time", "0x…dEaD"]) {
    assert.ok(page.includes(fact), `missing product detail: ${fact}`);
  }
  assert.match(page, /No pool trading fee\. Network gas still applies/);
  assert.match(page, /no creator-reserved allocation/);
  assert.match(page, /per unit of the quote asset/);
  assert.doesNotMatch(page, /No rug|risk.free|only way to hold any is to buy|Trades cost only/);
});

test("the contract registry retains every configured explorer and verifier path", () => {
  assert.match(page, /CHAIN_KEYS\.map/);
  assert.match(page, /launchpad\(chain\)/);
  assert.match(page, /\["factory", "locker"\] as const/);
  assert.match(page, /explorerAddress\(chain, address\)/);
  assert.match(page, /config\.factory && config\.locker/);
  assert.match(page, /Not deployed yet/);
  for (const destination of ["https://basescan.org/address/", "https://base.blockscout.com/address/", "https://robinhoodchain.blockscout.com/address/", "https://repo.sourcify.dev/8453/", "https://repo.sourcify.dev/4663/"]) {
    assert.ok(page.includes(destination), `missing verifier: ${destination}`);
  }
  assert.match(page, /verifier\.url\(config\.factory!\)/);
  assert.match(page, /verifier\.url\(config\.locker!\)/);
  assert.match(page, /href=\{BRAND_GITHUB\}/);
  assert.match(page, /chain-specific Uniswap deployments/);
  assert.doesNotMatch(page, /Identical bytecode/);
});

test("rules styling stays flat, theme-aware and accessible at compact widths", () => {
  assert.match(css, /:focus-visible/);
  assert.match(css, /min-height: 44px/);
  assert.match(css, /overflow-wrap: anywhere/);
  assert.match(css, /@media \(max-width: 639px\)/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.doesNotMatch(css, /box-shadow|text-shadow|gradient\(|#[\da-f]{3,8}\b/i);
  assert.doesNotMatch(css, /background(?:-color)?: var\(--color-brand\)/);
  assert.doesNotMatch(page + css, /\u2014/);
});
