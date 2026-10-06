/**
 * TWIG as a quote asset on Base — pure logic (node --test loads this directly).
 *
 * TWIG is Twigpine's token: a plain 18-decimal ERC-20 wrapper of GITLAWB on Base. Anyone can wrap GITLAWB into
 * TWIG and unwrap it back, 1:1, at any time and with no fee; every TWIG is backed by one GITLAWB held in the TWIG
 * contract. No owner, no transfer restrictions, not upgradeable. Pools quoted in it work exactly like any other
 * ERC-20 quote (Permit2 path); trading fees are paid out in TWIG, or burned when the launch names no beneficiary.
 *
 * USD: one TWIG redeems for one GITLAWB, so TWIG is priced at GITLAWB's USD price (gitlawbServer.ts: the v4 spot,
 * checked against the v3 30-minute average). Its own TWIG/WETH pool is far thinner and would be cheap to push, so
 * it is never read. Display + sorting only, never used on-chain.
 *
 * Base only: TWIG has not been bridged anywhere, so every other chain must say so explicitly.
 */
import type { ChainKey } from "../chainKeys.ts";

export const TWIG_ADDRESS = "0x6ac18bcf4ede02591d4917452700ea5eaaea13c1";
/** TWIG per chain, lowercase; null where it does not exist (a new chain must say so explicitly). */
export const TWIG_ADDRESSES: Record<ChainKey, string | null> = { base: TWIG_ADDRESS, robinhood: null, arc: null };
export const TWIG_SYMBOL = "TWIG";
export const TWIG_NAME = "Twigpine";
export const TWIG_DECIMALS = 18;
export const TWIG_SITE = "https://twigpine.com";
/** Where people get TWIG: wrap GITLAWB 1:1, or buy it by the route through the main GITLAWB pool. */
export const TWIG_WRAP_URL = "https://wrap.twigpine.com";

/**
 * Twigpine's logo (the twigpine.com mark) as a rounded tile, served from our own origin. `public/twig-mark.png` is
 * generated from the web repo's `public/logo-dark.png` (the light tree with its green dot on near-black): cropped to
 * the mark, 160px, transparent corners, same radius as the GITLAWB tile.
 */
export const TWIG_LOGO_PATH = "/twig-mark.png";
/** The tile's ground — badges use the same colour so the tile and the pill read as one piece. */
export const TWIG_LOGO_BG = "#080B0A";

/** USD per TWIG: exactly GITLAWB's, since one TWIG always unwraps to one GITLAWB. null while GITLAWB has no price. */
export function twigUsdFromGitlawb(gitlawbUsd: number | null): number | null {
  return gitlawbUsd !== null && Number.isFinite(gitlawbUsd) && gitlawbUsd > 0 ? gitlawbUsd : null;
}

/**
 * USD for a quote priced off GITLAWB's own price: GITLAWB itself, and TWIG (one TWIG unwraps to one GITLAWB).
 * undefined for every other key, which keeps its own price. The one rule the form, the quotes API and the rows use;
 * the SQL sorts match the same two keys (queries.ts `isGitlawbPriced`).
 */
export function gitlawbLinkedUsd(key: string, gitlawbUsd: number | null): number | null | undefined {
  if (key === "gitlawb") return gitlawbUsd;
  if (key === "twig") return twigUsdFromGitlawb(gitlawbUsd);
  return undefined;
}
