import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { CHAIN_KEYS, CHAIN_LABELS } from "./chainKeys.ts";
import { BRAND_DOMAIN } from "./brand.ts";
import { CHAIN_LANDING, chainLandingPath } from "./chainLanding.ts";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

test("every chain has a landing page route wired to its own key", () => {
  for (const chain of CHAIN_KEYS) {
    const file = new URL(`../app/${chain}/page.tsx`, import.meta.url);
    assert.ok(existsSync(file), `src/app/${chain}/page.tsx is missing`);
    const src = readFileSync(file, "utf8");
    assert.ok(src.includes(`chainLandingMetadata("${chain}")`), `${chain} page must use its own metadata`);
    assert.ok(src.includes(`<ChainLanding chain="${chain}" />`), `${chain} page must render its own chain`);
    assert.equal(chainLandingPath(chain), `/${chain}`);
  }
});

test("landing copy fits search snippets and names its chain", () => {
  for (const chain of CHAIN_KEYS) {
    const c = CHAIN_LANDING[chain];
    // the root layout template appends " · openlaunch.lol"
    assert.ok(`${c.title} · ${BRAND_DOMAIN}`.length <= 60, `${chain} title too long for Google`);
    assert.ok(c.description.length <= 155, `${chain} description too long for the snippet`);
    for (const text of [c.title, c.description, c.heading, c.intro]) assert.ok(text.includes(CHAIN_LABELS[chain]), `${chain}: "${text}" must name the chain`);
    assert.doesNotMatch(JSON.stringify(c), /audited|guaranteed|safe investment|moon|profit|risk.free|best/i);
  }
});

test("landing pages canonicalise to themselves, not to / or ?chain=", () => {
  const comp = read("../components/launchpad/ChainLanding.tsx");
  assert.match(comp, /pageMetadata\(\{ path: chainLandingPath\(chain\)/);
  assert.doesNotMatch(comp, /id="launches-heading"/, "LaunchList already owns that id");
  assert.match(comp, /if \(!hasChainPage\(chain\)\) notFound\(\);/, "a chain without contracts 404s instead of rendering an empty list");
  assert.match(comp, /hasChainPage\(k\)/, "\"Also on\" links only chains that have a page");
  assert.doesNotMatch(comp, /VISIBLE_CHAINS/, "VISIBLE_CHAINS falls back to every chain in development; pages follow CONFIGURED_CHAINS");
});

test("/t/<chain> moves permanently to the landing page", () => {
  const legacy = read("../app/t/[chain]/page.tsx");
  assert.match(legacy, /if \(!hasChainPage\(chain\)\) notFound\(\);\s*permanentRedirect\(chainLandingPath\(chain\)\);/, "no cached 308 to a 404");
  assert.doesNotMatch(legacy, /\/\?chain=/);
});

test("footer and about page link a chain's landing page only when it has one", () => {
  for (const file of ["../components/Footer.tsx", "../app/about/page.tsx"]) {
    assert.match(read(file), /hasChainPage\(chain\) \? <Link href=\{chainLandingPath\(chain\)\}[^>]*>\{CHAIN_LABELS\[chain\]\}<\/Link> : CHAIN_LABELS\[chain\]/, file);
  }
  assert.match(read("../app/sitemap.ts"), /staticSitemapEntries\(SITE_URL, undefined, CONFIGURED_CHAINS\)/);
});

test("the chain page shares the layout's totals query instead of running it again", () => {
  const layout = read("../app/layout.tsx");
  const comp = read("../components/launchpad/ChainLanding.tsx");
  assert.match(read("./launchpad/queries.ts"), /export const getLaunchTotalsForRequest = cache\(getLaunchTotals\);/);
  for (const [name, src] of [["layout", layout], ["ChainLanding", comp]] as const) {
    assert.match(src, /getLaunchTotalsForRequest\(usd\)/, `${name} uses the request-scoped getter`);
    assert.doesNotMatch(src, /[^A-Za-z]getLaunchTotals\(/, `${name} must not call the uncached query`);
  }
});
