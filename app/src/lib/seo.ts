/**
 * Pure SEO helpers (node --test loads this). No Next.js, no DB, no env reads:
 * callers pass `siteUrl` in so unit tests stay deterministic.
 */

import { CHAIN_KEYS, CHAIN_LABELS, isChainKey, type ChainKey } from "./chainKeys.ts";
import { chainLandingPath } from "./chainLanding.ts";
import { BRAND_DOMAIN, BRAND_X, SITE_TITLE } from "./brand.ts";
import { clampSocial } from "./launchpad/ogcard.ts";

export { isChainKey, type ChainKey };

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

export function isTokenAddress(v: unknown): boolean {
  return typeof v === "string" && ADDRESS_RE.test(v);
}

export function isCanonicalTokenPath(chain: unknown, token: unknown): boolean {
  return isChainKey(chain) && isTokenAddress(token);
}

export function canonicalUrl(siteUrl: string, path: string): string {
  const base = siteUrl.replace(/\/$/, "");
  const p = path.startsWith("/") ? path : `/${path}`;
  return `${base}${p}`;
}

export function tokenPath(chain: ChainKey, token: string): string {
  return `/t/${chain}/${token.toLowerCase()}`;
}

export function tokenCanonical(siteUrl: string, chain: ChainKey, token: string): string {
  return canonicalUrl(siteUrl, tokenPath(chain, token));
}

export type StaticRoute = {
  path: string;
  changeFrequency: "always" | "hourly" | "daily" | "weekly" | "monthly" | "yearly" | "never";
  priority: number;
};

/**
 * Static sitemap routes. Facts only: every path exists in src/app.
 * /admin and /me are intentionally excluded (both noindex; /admin is also disallowed in robots.txt).
 */
export const STATIC_SITEMAP_ROUTES: StaticRoute[] = [
  { path: "/", changeFrequency: "hourly", priority: 1 },
  { path: "/launch", changeFrequency: "weekly", priority: 0.8 },
  ...CHAIN_KEYS.map((chain): StaticRoute => ({ path: chainLandingPath(chain), changeFrequency: "hourly", priority: 0.8 })),
  { path: "/feed", changeFrequency: "hourly", priority: 0.7 },
  { path: "/rules", changeFrequency: "monthly", priority: 0.6 },
  { path: "/about", changeFrequency: "monthly", priority: 0.6 },
  { path: "/agents", changeFrequency: "monthly", priority: 0.6 },
];

export type SitemapEntry = {
  url: string;
  lastModified?: string;
  changeFrequency: StaticRoute["changeFrequency"];
  priority: number;
};

/**
 * `chains`: the chains with contracts on this deployment. A chain landing page 404s without them,
 * and a sitemap must never advertise a 404.
 */
export function staticSitemapEntries(siteUrl: string, lastModified?: string, chains: readonly ChainKey[] = CHAIN_KEYS): SitemapEntry[] {
  const hidden = new Set(CHAIN_KEYS.filter((k) => !chains.includes(k)).map(chainLandingPath));
  return STATIC_SITEMAP_ROUTES.filter((r) => !hidden.has(r.path)).map((r) => ({
    url: canonicalUrl(siteUrl, r.path),
    ...(lastModified ? { lastModified } : {}),
    changeFrequency: r.changeFrequency,
    priority: r.priority,
  }));
}

export type TokenRow = {
  chain: ChainKey;
  token: string;
  block_time: string | null;
};

export function tokenSitemapEntries(siteUrl: string, rows: TokenRow[]): SitemapEntry[] {
  const out: SitemapEntry[] = [];
  for (const r of rows) {
    if (!isCanonicalTokenPath(r.chain, r.token)) continue;
    out.push({
      url: tokenCanonical(siteUrl, r.chain, r.token),
      ...(r.block_time ? { lastModified: r.block_time } : {}),
      changeFrequency: "hourly",
      priority: 0.9,
    });
  }
  return out;
}

export type TokenJsonLdInput = {
  name: string;
  symbol: string;
  chain: ChainKey;
  chainId: number;
  token: string;
  launcher: string;
  quoteSymbol: string;
  supply: string;
  poolId: string;
  startTick: number;
  lpFee: number;
  blockTime: string;
  description: string | null;
  siteUrl: string;
};

/**
 * Facts-only JSON-LD for a token page. Every field is on-chain (factory /
 * locker / pool) or creator-supplied metadata — no scores, no flags, no
 * predictions (see CONTRIBUTING.md "Facts over scores").
 */
export function tokenJsonLd(l: TokenJsonLdInput): Record<string, unknown> {
  const url = tokenCanonical(l.siteUrl, l.chain, l.token);
  const chainLabel = CHAIN_LABELS[l.chain];
  return {
    "@context": "https://schema.org",
    "@type": "WebPage",
    name: `${l.name} (${l.symbol})`,
    description: (l.description ?? `${l.name} launched on openlaunch.lol.`).slice(0, 500),
    url,
    dateCreated: l.blockTime,
    about: {
      "@type": "DigitalDocument",
      name: l.name,
      identifier: l.token.toLowerCase(),
      url,
      inLanguage: "en",
      creator: { "@type": "Organization", identifier: l.launcher.toLowerCase() },
      isPartOf: { "@type": "WebSite", name: chainLabel, identifier: String(l.chainId) },
      additionalProperty: [
        { "@type": "PropertyValue", name: "symbol", value: l.symbol },
        { "@type": "PropertyValue", name: "quoteSymbol", value: l.quoteSymbol },
        { "@type": "PropertyValue", name: "supply", value: l.supply },
        { "@type": "PropertyValue", name: "poolId", value: l.poolId },
        { "@type": "PropertyValue", name: "startTick", value: String(l.startTick) },
        { "@type": "PropertyValue", name: "lpFeePips", value: String(l.lpFee) },
      ],
    },
  };
}

/**
 * Serialise any JSON-LD object for a `<script type="application/ld+json">` sink.
 * `<` is escaped to `\u003c` so a literal `</script>` inside a string (token
 * names are creator-supplied) can never terminate the script element (XSS).
 * The JSON parses identically.
 */
export function jsonLdScript(obj: Record<string, unknown>): string {
  return JSON.stringify(obj).replace(/</g, "\\u003c");
}

/** Token-page JSON-LD, escaped (see jsonLdScript). */
export function jsonLdHtml(l: TokenJsonLdInput): string {
  return jsonLdScript(tokenJsonLd(l));
}

export type SiteJsonLdInput = {
  siteUrl: string;
  /** The bare brand word ("openlaunch"): the entity name search engines reconcile the query against. */
  brand: string;
  /** The domain ("openlaunch.lol"): how most people write the brand, kept as an alternate name. */
  domain: string;
  description: string;
  /** Official profiles only (X, GitHub). Look-alike handles must never appear here. */
  sameAs: string[];
};

/**
 * Site-wide entity record: Organization + WebSite + WebApplication in one @graph.
 * Facts only: names, URLs, official profiles, and that the app is free to use
 * (there is no fee address in the contracts). No ratings, no claims.
 */
export function siteJsonLd(i: SiteJsonLdInput): Record<string, unknown> {
  const siteUrl = i.siteUrl.replace(/\/$/, "");
  const orgId = `${siteUrl}/#organization`;
  const siteId = `${siteUrl}/#website`;
  const logo = `${siteUrl}/icon.png`;
  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Organization",
        "@id": orgId,
        name: i.brand,
        alternateName: i.domain,
        url: `${siteUrl}/`,
        logo: { "@type": "ImageObject", url: logo, width: 512, height: 512 },
        sameAs: i.sameAs,
      },
      {
        "@type": "WebSite",
        "@id": siteId,
        name: i.brand,
        alternateName: i.domain,
        url: `${siteUrl}/`,
        description: i.description,
        inLanguage: "en",
        publisher: { "@id": orgId },
      },
      {
        "@type": "WebApplication",
        name: i.brand,
        url: `${siteUrl}/`,
        description: i.description,
        applicationCategory: "FinanceApplication",
        operatingSystem: "Web",
        browserRequirements: "Requires JavaScript and an Ethereum wallet",
        isAccessibleForFree: true,
        offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
        publisher: { "@id": orgId },
        isPartOf: { "@id": siteId },
      },
    ],
  };
}

/** Site JSON-LD, escaped for a script sink (see jsonLdScript). */
export function siteJsonLdHtml(i: SiteJsonLdInput): string {
  return jsonLdScript(siteJsonLd(i));
}

/**
 * Search-engine ownership verification tags, read from the environment so a
 * deploy can verify Search Console / Bing Webmaster without a DNS change.
 * Returns undefined when nothing is set, so the tags never render empty.
 */
export function siteVerification(env: Record<string, string | undefined>): { google?: string; other?: Record<string, string> } | undefined {
  const google = env.GOOGLE_SITE_VERIFICATION?.trim() || undefined;
  const bing = env.BING_SITE_VERIFICATION?.trim() || undefined;
  if (!google && !bing) return undefined;
  return { ...(google ? { google } : {}), ...(bing ? { other: { "msvalidate.01": bing } } : {}) };
}

export type PageMetadata = {
  title: string;
  description: string;
  alternates: { canonical: string };
  openGraph: { siteName: string; type: "website"; title: string; description: string; url: string; images: ShareImage[] };
  twitter: { card: "summary_large_image"; site: string; title: string; description: string; images: ShareImage[] };
};
type ShareImage = { url: string; width: number; height: number; alt: string };

/** The site card (app/opengraph-image.tsx, 1200×630). A page's own openGraph drops the inherited file image, so it is named here. */
const SITE_SHARE_IMAGE: ShareImage = { url: "/opengraph-image", width: 1200, height: 630, alt: SITE_TITLE };

/**
 * Metadata for an indexable page: its canonical plus its own share card. Next replaces nested
 * metadata objects instead of merging them, so a page that sets only title/description inherits the
 * root layout's openGraph/twitter whole: the home page's card, and og:url pointing at "/".
 * `path` and the image resolve against the layout's metadataBase.
 */
export function pageMetadata({ path, title, description }: { path: string; title: string; description: string }): PageMetadata {
  const social = clampSocial(description);
  return {
    title,
    description,
    alternates: { canonical: path },
    openGraph: { siteName: BRAND_DOMAIN, type: "website", title, description: social, url: path, images: [SITE_SHARE_IMAGE] },
    twitter: { card: "summary_large_image", site: `@${BRAND_X}`, title, description: social, images: [SITE_SHARE_IMAGE] },
  };
}
