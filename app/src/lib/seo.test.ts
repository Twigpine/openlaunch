import { test } from "node:test";
import assert from "node:assert/strict";
import {
  STATIC_SITEMAP_ROUTES,
  canonicalUrl,
  isCanonicalTokenPath,
  jsonLdHtml,
  jsonLdScript,
  pageMetadata,
  siteJsonLd,
  siteJsonLdHtml,
  siteVerification,
  staticSitemapEntries,
  tokenCanonical,
  tokenJsonLd,
  tokenPath,
  tokenSitemapEntries,
} from "./seo.ts";

const SITE = "https://openlaunch.lol";
const TOKEN = "0x1234567890abcdef1234567890abcdef12345678";

test("canonicalUrl joins base + path without double slashes", () => {
  assert.equal(canonicalUrl(SITE, "/"), `${SITE}/`);
  assert.equal(canonicalUrl(`${SITE}/`, "/launch"), `${SITE}/launch`);
  assert.equal(canonicalUrl(SITE, "feed"), `${SITE}/feed`);
});

test("token path helpers lowercase the address", () => {
  assert.equal(tokenPath("base", TOKEN.toUpperCase()), `/t/base/${TOKEN}`);
  assert.equal(tokenCanonical(SITE, "base", TOKEN), `${SITE}/t/base/${TOKEN}`);
});

test("isCanonicalTokenPath rejects bad chains and addresses", () => {
  assert.equal(isCanonicalTokenPath("base", TOKEN), true);
  assert.equal(isCanonicalTokenPath("robinhood", TOKEN), true);
  assert.equal(isCanonicalTokenPath("ethereum", TOKEN), false);
  assert.equal(isCanonicalTokenPath("base", "not-an-address"), false);
  assert.equal(isCanonicalTokenPath("base", "0x123"), false);
});

test("static sitemap covers every indexable route and skips /admin and /me", () => {
  const paths = STATIC_SITEMAP_ROUTES.map((r) => r.path);
  for (const p of ["/", "/launch", "/base", "/robinhood", "/arc", "/feed", "/rules", "/about", "/agents"]) {
    assert.ok(paths.includes(p), `missing ${p}`);
  }
  assert.ok(!paths.includes("/admin"), "/admin must stay out of the sitemap");
  assert.ok(!paths.includes("/me"), "/me is wallet-specific (noindex) and must stay out of the sitemap");
  const entries = staticSitemapEntries(SITE, "2026-09-06T00:00:00.000Z");
  assert.equal(entries.length, STATIC_SITEMAP_ROUTES.length);
  for (const entry of entries) {
    assert.equal(new URL(entry.url).origin, new URL(SITE).origin);
  }
  assert.equal(entries[0].url, `${SITE}/`);
});

test("static sitemap lists only the chain landing pages that are live on this deployment", () => {
  const paths = staticSitemapEntries(SITE, undefined, ["base", "robinhood"]).map((e) => new URL(e.url).pathname);
  assert.ok(paths.includes("/base") && paths.includes("/robinhood"));
  assert.ok(!paths.includes("/arc"), "a chain without contracts 404s, so it stays out of the sitemap");
  assert.ok(paths.includes("/about"), "non-chain routes are unaffected");
});

test("token sitemap skips invalid rows and keeps block_time", () => {
  const entries = tokenSitemapEntries(SITE, [
    { chain: "base", token: TOKEN, block_time: "2026-09-06T00:00:00.000Z" },
    { chain: "base", token: "junk", block_time: null },
    { chain: "ethereum" as never, token: TOKEN, block_time: null },
  ]);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].url, `${SITE}/t/base/${TOKEN}`);
  assert.equal(entries[0].lastModified, "2026-09-06T00:00:00.000Z");
  assert.equal(entries[0].priority, 0.9);
});

test("token JSON-LD is facts-only: identifiers, no scores", () => {
  const ld = tokenJsonLd({
    name: "Trend Coin",
    symbol: "TREND",
    chain: "base",
    chainId: 8453,
    token: TOKEN,
    launcher: "0xAbC0000000000000000000000000000000000001",
    quoteSymbol: "ETH",
    supply: "1000000000000000000000000000",
    poolId: "0xpool",
    startTick: 184200,
    lpFee: 10000,
    blockTime: "2026-09-06T00:00:00.000Z",
    description: null,
    siteUrl: SITE,
  });
  assert.equal(ld["@type"], "WebPage");
  assert.equal(ld["url"], `${SITE}/t/base/${TOKEN}`);
  const about = ld["about"] as Record<string, unknown>;
  assert.equal(about["identifier"], TOKEN);
  const text = JSON.stringify(ld).toLowerCase();
  assert.ok(!text.includes("score"), "no scores");
  assert.ok(!text.includes("trust"), "no trust flags");
  assert.ok(!text.includes("rank"), "no rankings");
});

test("jsonLdHtml escapes < so creator input cannot break out of the script tag", () => {
  const input = {
    name: "</script><script>alert(1)</script>",
    symbol: "XSS",
    chain: "base" as const,
    chainId: 8453,
    token: TOKEN,
    launcher: "0xAbC0000000000000000000000000000000000001",
    quoteSymbol: "ETH",
    supply: "1000000000000000000000000000",
    poolId: "0xpool",
    startTick: 184200,
    lpFee: 10000,
    blockTime: "2026-09-06T00:00:00.000Z",
    description: "a < b",
    siteUrl: SITE,
  };
  const html = jsonLdHtml(input);
  assert.ok(!html.includes("<"), "no literal angle brackets remain");
  assert.ok(html.includes("\\u003c/script>"), "closing tag is unicode-escaped");
  assert.deepEqual(JSON.parse(html.replace(/\\u003c/g, "<")), JSON.parse(JSON.stringify(tokenJsonLd(input))), "escapes round-trip");
});

const SITE_INPUT = {
  siteUrl: `${SITE}/`,
  brand: "openlaunch",
  domain: "openlaunch.lol",
  description: "Launch a token in one transaction.",
  sameAs: ["https://x.com/openlaunch_lol", "https://github.com/Gitlawb/openlaunch"],
};

test("site JSON-LD is an Organization + WebSite + WebApplication graph keyed on the brand word", () => {
  const ld = siteJsonLd(SITE_INPUT);
  const graph = ld["@graph"] as Record<string, unknown>[];
  assert.deepEqual(graph.map((n) => n["@type"]), ["Organization", "WebSite", "WebApplication"]);
  const [org, site, app] = graph;
  assert.equal(org["name"], "openlaunch");
  assert.equal(org["alternateName"], "openlaunch.lol");
  assert.equal(org["url"], `${SITE}/`, "trailing slash on siteUrl is normalised");
  assert.equal(org["@id"], `${SITE}/#organization`);
  assert.deepEqual(org["sameAs"], SITE_INPUT.sameAs);
  assert.deepEqual(site["publisher"], { "@id": `${SITE}/#organization` });
  assert.equal(app["isAccessibleForFree"], true);
  assert.deepEqual(app["offers"], { "@type": "Offer", price: "0", priceCurrency: "USD" });
  const text = JSON.stringify(ld).toLowerCase();
  assert.ok(!text.includes("openlaunchlol"), "never the squatted look-alike");
  // Word-boundary match: "operatingSystem" contains "rating" but is not a rating.
  for (const banned of ["rating", "review", "score", "audited"]) assert.ok(!new RegExp(`\\b${banned}`).test(text), `no ${banned}`);
});

test("jsonLdScript escapes < for every payload, site graph included", () => {
  assert.equal(jsonLdScript({ a: "</script>" }), '{"a":"\\u003c/script>"}');
  const html = siteJsonLdHtml({ ...SITE_INPUT, description: "a <b> c" });
  assert.ok(!html.includes("<"));
  assert.deepEqual(JSON.parse(html), siteJsonLd({ ...SITE_INPUT, description: "a <b> c" }));
});

test("siteVerification renders only the tags that are configured", () => {
  assert.equal(siteVerification({}), undefined);
  assert.equal(siteVerification({ GOOGLE_SITE_VERIFICATION: "  " }), undefined);
  assert.deepEqual(siteVerification({ GOOGLE_SITE_VERIFICATION: "g123 " }), { google: "g123" });
  assert.deepEqual(siteVerification({ BING_SITE_VERIFICATION: "b456" }), { other: { "msvalidate.01": "b456" } });
  assert.deepEqual(siteVerification({ GOOGLE_SITE_VERIFICATION: "g", BING_SITE_VERIFICATION: "b" }), { google: "g", other: { "msvalidate.01": "b" } });
});

test("pageMetadata gives a page its own canonical and share card, never the home page's", () => {
  const long = "Deploy a token on Base, Robinhood Chain or Arc with 100% of supply locked as Uniswap v4 liquidity. No platform fee. Gas only.";
  const m = pageMetadata({ path: "/launch", title: "Launch a token for free", description: long });
  assert.equal(m.description, long, "the search snippet keeps the full description");
  assert.deepEqual(m.alternates, { canonical: "/launch" });
  assert.equal(m.openGraph.url, "/launch");
  assert.equal(m.openGraph.title, "Launch a token for free");
  assert.equal(m.openGraph.siteName, "openlaunch.lol");
  assert.equal(m.twitter.title, "Launch a token for free");
  assert.equal(m.twitter.site, "@openlaunch_lol");
  // a page's own openGraph drops the inherited file image: the card must name it or previews go blank
  assert.deepEqual(m.openGraph.images.map((i) => i.url), ["/opengraph-image"]);
  assert.deepEqual(m.twitter.images, m.openGraph.images);
  assert.ok(m.openGraph.description.length <= 125 && m.twitter.description === m.openGraph.description, "share text is clamped for previews");
});
