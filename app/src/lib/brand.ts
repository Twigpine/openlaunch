/** Single source of truth for the brand. Rename here, nowhere else. */
export const BRAND = "openlaunch";
export const BRAND_TLD = ".lol";
export const BRAND_DOMAIN = `${BRAND}${BRAND_TLD}`; // openlaunch.lol
/** @openlaunchlol and the openlaunchlol GitHub org were squatted after the rename — never link them. */
export const BRAND_X = "openlaunch_lol"; // the official account (never link the look-alike handles)
export const BRAND_GITHUB = "https://github.com/Gitlawb/openlaunch"; // MIT, contracts + site
export const TAGLINE = "launch a token. Free. Open source. On Base, Robinhood Chain or Arc.";
/**
 * Per-surface copy (each surface truncates at a different point):
 *   SITE_TITLE ≤ 60 chars (Google), also the X title (≤ 70);
 *   SITE_DESCRIPTION ≤ 155 chars (Google snippet);
 *   SOCIAL_DESCRIPTION ≤ 125 chars (OpenGraph / X previews, mobile-safe).
 */
/** Leads with the bare brand word: "openlaunch" is the query to win, and Google tokenises the domain as two words. */
export const SITE_TITLE = `${BRAND}: free token launchpad on Base, Robinhood & Arc`;
export const SITE_DESCRIPTION = "Launch a token in one transaction on Base, Robinhood Chain or Arc. Zero platform fee, open source, 100% of supply locked as Uniswap v4 liquidity forever.";
export const SOCIAL_DESCRIPTION = "Zero-fee, open-source token launchpad. One transaction, liquidity locked forever. Base + Robinhood Chain + Arc.";
/** Old domain: kept alive as a redirect (on-chain metadata URIs of early launches point at it). */
export const LEGACY_DOMAIN = "basebid.lol";
