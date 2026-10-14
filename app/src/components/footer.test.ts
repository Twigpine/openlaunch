import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { en, messagesFor } from "../i18n/messages/index.ts";

const footer = readFileSync(new URL("./Footer.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("./Footer.module.css", import.meta.url), "utf8");
const layout = readFileSync(new URL("../app/layout.tsx", import.meta.url), "utf8");
const globals = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");

// Source contracts supplement the responsive and keyboard browser review.
test("the shared footer preserves navigation and existing public destinations", () => {
  assert.match(layout, /<Footer\s*\/>/);
  assert.doesNotMatch(layout, /<footer\b/);
  for (const route of ["/", "/launch", "/rules", "/feed", "/me", "/agents", "/llms.txt", "/rules#contracts"]) {
    assert.ok(footer.includes(`"${route}"`), `missing footer route: ${route}`);
  }
  assert.match(footer, /BRAND_GITHUB/);
  assert.match(footer, /blob\/main\/LICENSE/);
  assert.match(footer, /https:\/\/x\.com\/\$\{BRAND_X\}/);
  assert.match(footer, /aria-label=\{t\("navigation"\)\}/);
  assert.equal(en.footer.navigation, "Footer navigation");
});

test("footer proofs use configured chain addresses without invented status claims", () => {
  assert.match(footer, /CHAIN_KEYS\.map/);
  assert.match(footer, /\{ factory, locker \} = launchpad\(chain\)/);
  assert.match(footer, /factory \? <a href=\{explorerAddress\(chain, factory\)\}/);
  assert.match(footer, /locker \? <a href=\{explorerAddress\(chain, locker\)\}/);
  assert.match(footer, /t\("factoryMissing"\)/);
  assert.match(footer, /t\("lockerMissing"\)/);
  assert.equal(en.footer.factoryMissing, "Factory not configured");
  assert.equal(en.footer.lockerMissing, "Locker not configured");
  // in either language: the footer states what is deployed, nothing about health, audits or risk
  assert.doesNotMatch(footer + JSON.stringify(en.footer), /all systems operational|audited by|uptime|risk.free/i);
  assert.doesNotMatch(JSON.stringify(messagesFor("zh-CN").footer), /审计|零风险|无风险|正常运行时间/);
});

test("footer stays server-rendered with native top navigation and mobile trade clearance", () => {
  assert.doesNotMatch(footer, /use client|useEffect|onClick|setInterval|addEventListener/);
  assert.match(footer, /href="#site-top"/);
  assert.match(layout, /<body id="site-top" tabIndex=\{-1\}/);
  assert.match(footer, /bb-footer/);
  assert.match(globals, /body:has\(\.bb-action-bar\) \.bb-footer/);
  assert.match(globals, /@media \(max-width: 1023px\)\s*\{\s*body:has\(\.bb-action-bar\) \.bb-footer/);
  assert.match(css, /@media \(max-width: 767px\)/);
});

test("footer uses theme tokens and reduced-motion-safe focus without another blue CTA", () => {
  assert.match(css, /\.footer a:focus-visible/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /transition: none !important/);
  assert.match(css, /transform: none !important/);
  assert.doesNotMatch(css, /box-shadow|text-shadow|gradient\(|animation:|#[\da-f]{3,8}\b/i);
  assert.doesNotMatch(css, /background(?:-color)?: var\(--color-brand\)/);
  assert.doesNotMatch(footer + css, /font-display|font-unbounded|\u2014/);
});
