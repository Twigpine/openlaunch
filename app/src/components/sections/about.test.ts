import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { en, messagesFor } from "../../i18n/messages/index.ts";

const page = readFileSync(new URL("../../app/about/page.tsx", import.meta.url), "utf8");
const hero = readFileSync(new URL("../launchpad/LaunchHero.tsx", import.meta.url), "utf8");
const footer = readFileSync(new URL("../Footer.tsx", import.meta.url), "utf8");
const llms = readFileSync(new URL("../../app/llms.txt/route.ts", import.meta.url), "utf8");

// The entity page: brand from brand.ts (never hard-coded), official channels from the same constants.
test("about page is the brand entity page, built from brand.ts constants", () => {
  assert.match(page, /import \{ BRAND, BRAND_DOMAIN, BRAND_GITHUB, BRAND_X, LEGACY_DOMAIN \} from "@\/lib\/brand"/);
  assert.match(page, /title=\{t\("about\.title", \{ brand: BRAND \}\)\}/);
  assert.equal(en.info.about.title, "What {brand} is");
  assert.match(page, /pageMetadata\(\{\s*path: "\/about"/);
  assert.match(page, /https:\/\/x\.com\/\$\{BRAND_X\}/);
  assert.match(page, /href=\{BRAND_GITHUB\}/);
  assert.match(page, /CHAIN_KEYS\.map/);
  // look-alike handles are never linked (brand.ts: squatted after the rename)
  assert.doesNotMatch(page, /openlaunchlol/);
});

test("about page states facts, not value claims", () => {
  assert.match(page, /t\.rich\("about\.who\.launchers", \{ brand: BRAND,/);
  assert.match(en.info.about.who.launchers, /created by their launchers, not by \{brand\}/);
  assert.match(messagesFor("zh-CN").info.about.who.launchers, /由各自的发行者创建，而不是 \{brand\}/);
  assert.doesNotMatch(page + JSON.stringify(en.info.about), /audited|guaranteed|safe investment|moon|profit|risk.free/i);
  assert.doesNotMatch(JSON.stringify(messagesFor("zh-CN").info.about), /审计|保证|安全投资|暴涨|收益|零风险|无风险/);
  assert.doesNotMatch(page, /use client|useEffect|onClick/);
});

test("the brand appears as a plain word above the fold and links to the entity page", () => {
  assert.match(hero, /t\.rich\("copy", \{ link: \(chunks\) => <Link href="\/about"[^>]*>\{chunks\}<\/Link> \}\)/);
  assert.match(en.hero.copy, /^<link>openlaunch<\/link> is the free, open-source launchpad/);
  assert.match(messagesFor("zh-CN").hero.copy, /^<link>openlaunch<\/link> /, "the linked brand word leads the Chinese copy too");
  assert.ok(footer.includes('{ href: "/about", key: "about" }'), "footer links the about page");
  assert.equal(en.footer.links.about, "About openlaunch");
  assert.match(llms, /> openlaunch \(\$\{BRAND_DOMAIN\}\) is an open-source/);
  assert.match(llms, /About page: \$\{SITE_URL\}\/about/);
});
