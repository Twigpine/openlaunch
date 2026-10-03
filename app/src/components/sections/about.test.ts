import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const page = readFileSync(new URL("../../app/about/page.tsx", import.meta.url), "utf8");
const hero = readFileSync(new URL("../launchpad/LaunchHero.tsx", import.meta.url), "utf8");
const footer = readFileSync(new URL("../Footer.tsx", import.meta.url), "utf8");
const llms = readFileSync(new URL("../../app/llms.txt/route.ts", import.meta.url), "utf8");

// The entity page: brand from brand.ts (never hard-coded), official channels from the same constants.
test("about page is the brand entity page, built from brand.ts constants", () => {
  assert.match(page, /import \{ BRAND, BRAND_DOMAIN, BRAND_GITHUB, BRAND_X, LEGACY_DOMAIN \} from "@\/lib\/brand"/);
  assert.match(page, /title=\{`What \$\{BRAND\} is`\}/);
  assert.match(page, /pageMetadata\(\{\s*path: "\/about"/);
  assert.match(page, /https:\/\/x\.com\/\$\{BRAND_X\}/);
  assert.match(page, /href=\{BRAND_GITHUB\}/);
  assert.match(page, /CHAIN_KEYS\.map/);
  // look-alike handles are never linked (brand.ts: squatted after the rename)
  assert.doesNotMatch(page, /openlaunchlol/);
});

test("about page states facts, not value claims", () => {
  assert.match(page, /created by their launchers, not by \{BRAND\}/);
  assert.doesNotMatch(page, /audited|guaranteed|safe investment|moon|profit|risk.free/i);
  assert.doesNotMatch(page, /use client|useEffect|onClick/);
});

test("the brand appears as a plain word above the fold and links to the entity page", () => {
  assert.match(hero, /<Link href="\/about"[^>]*>openlaunch<\/Link> is the free, open-source launchpad/);
  assert.ok(footer.includes('{ href: "/about", label: "About openlaunch" }'), "footer links the about page");
  assert.match(llms, /> openlaunch \(\$\{BRAND_DOMAIN\}\) is an open-source/);
  assert.match(llms, /About page: \$\{SITE_URL\}\/about/);
});
