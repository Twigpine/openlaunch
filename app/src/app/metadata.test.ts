import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
const layout = read("./layout.tsx");

/**
 * Next merges metadata shallowly, so a canonical on the root layout is inherited by every page
 * that does not set `alternates` itself. That once canonicalised /launch, /rules, /feed and /agents
 * to "/" and told search engines they were duplicates of the home page. Each indexable page owns
 * its canonical; the root layout must never carry one.
 */
test("root layout declares no canonical and renders the site entity JSON-LD", () => {
  assert.doesNotMatch(layout, /alternates/);
  assert.match(layout, /siteJsonLdHtml\(/);
  assert.match(layout, /verification: siteVerification\(process\.env\)/);
  assert.match(layout, /<script type="application\/ld\+json" dangerouslySetInnerHTML=\{\{ __html: siteJsonLd \}\} \/>/);
});

test("every indexable page declares its own canonical path and share card", () => {
  const pages: [string, string][] = [
    ["./(home)/page.tsx", "/"],
    ["./launch/page.tsx", "/launch"],
    ["./rules/page.tsx", "/rules"],
    ["./feed/page.tsx", "/feed"],
    ["./agents/page.tsx", "/agents"],
    ["./about/page.tsx", "/about"],
  ];
  for (const [file, path] of pages) {
    const src = read(file);
    // the home page's title, description and card are the layout's own; every other page goes through pageMetadata
    const ok = path === "/" ? src.includes(`alternates: { canonical: "/" }`) : new RegExp(`pageMetadata\\(\\{\\s*path: "${path}"`).test(src);
    assert.ok(ok, `${file} must canonicalise to ${path}`);
  }
});

test("wallet-specific and moderation pages stay out of the index", () => {
  assert.match(read("./me/page.tsx"), /robots: \{ index: false/);
  assert.match(read("./admin/page.tsx"), /robots: \{ index: false/);
});
