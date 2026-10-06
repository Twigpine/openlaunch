/**
 * GITLAWB as a quote asset on Base and Robinhood Chain — pure logic (node --test loads this directly).
 *
 * GITLAWB is Twigpine's token (the project was called Gitlawb; the ticker stays): an ordinary 18-decimal ERC-20 on Base (bridged 1:1 to Robinhood Chain
 * over LayerZero OFT), no transfer restrictions, no issuer switch. Pools quoted in it work exactly like
 * any other ERC-20 quote (Permit2 path); trading fees are paid out in GITLAWB, or burned when the
 * launch names no beneficiary.
 *
 * USD comes from the deepest GITLAWB market: the Uniswap v4 WETH/GITLAWB pool (dynamic-fee hook,
 * tick spacing 200), read on-chain through StateView.getSlot0(poolId) and multiplied by ETH/USD.
 * Both sides are 18-dec, so no decimal adjustment. Display + sorting only, never used on-chain.
 */
import type { Address } from "viem";
import { DEFAULT_CHAIN, type ChainKey } from "../chainKeys.ts";
import { poolIdOf, sqrtPriceToTokensPerQuote } from "./math.ts";
import { stockMcapPresets } from "./stocks.ts";

export const GITLAWB_ADDRESS = "0x5f980dcfc4c0fa3911554cf5ab288ed0eb13dba3";
/**
 * GITLAWB on Robinhood Chain (4663): a LayerZero V2 OFT, minted 1:1 against GITLAWB locked in the
 * GitlawbOFTAdapter on Base (0x3308384bc308d09b3eba9a8f11cc36e993a273a4). Same token, one supply, two
 * chains — see the community repo's contracts.ts. Priced from the Base pool (the deep market); the
 * bridge keeps the two within arbitrage of each other.
 */
export const GITLAWB_ADDRESS_ROBINHOOD = "0xd1b0d44e4f6ed940fcc7a9f59bf30daf62ccfe3d";
/** GITLAWB per chain, lowercase; null where it has not been bridged (a new chain must say so explicitly). */
export const GITLAWB_ADDRESSES: Record<ChainKey, string | null> = { base: GITLAWB_ADDRESS, robinhood: GITLAWB_ADDRESS_ROBINHOOD, arc: null };
export const GITLAWB_SYMBOL = "GITLAWB";
export const GITLAWB_NAME = "Twigpine"; // the project behind the token (formerly Gitlawb); the ticker stays GITLAWB
export const GITLAWB_DECIMALS = 18;
export const GITLAWB_SITE = "https://twigpine.com";

/**
 * The WETH/GITLAWB v4 pool key on Base (Initialize event at block 43,202,530): a dynamic-fee pool
 * (fee 0x800000 = "the hook sets the fee"), tick spacing 200. Its id is derived, never pasted;
 * gitlawb.test.ts pins it to the on-chain id.
 */
export const GITLAWB_POOL_KEY = {
  currency0: "0x4200000000000000000000000000000000000006" as Address, // WETH
  currency1: GITLAWB_ADDRESS as Address,
  fee: 0x800000,
  tickSpacing: 200,
  hooks: "0xbb7784a4d481184283ed89619a3e3ed143e1adc0" as Address,
} as const;
export const GITLAWB_POOL_ID = poolIdOf(GITLAWB_POOL_KEY);

/**
 * Manipulation cross-check: the Uniswap v3 WETH/GITLAWB 1% pool on Base (token0 WETH, token1 GITLAWB)
 * keeps an on-chain oracle (observe), so a 30-minute time-weighted average tick is available without
 * any off-chain service. The v4 spot is the primary price (deepest market); when it strays more than
 * MAX_SPOT_DEVIATION from the TWAP, the TWAP is used instead, so a single-block price push in the v4
 * pool cannot rewrite market caps, USD volume or trending scores site-wide.
 */
export const GITLAWB_V3_POOL = "0x72c12f0cc0e0c6e97ff9869717a482aff97e3b30" as Address;
export const TWAP_WINDOW_S = 1800;
export const MAX_SPOT_DEVIATION = 0.25;

/** Time-weighted average tick from two tickCumulative readings `windowS` apart (Uniswap v3 semantics: floor toward -inf). */
export function twapTick(cumulativeThen: bigint, cumulativeNow: bigint, windowS: number): number {
  const delta = cumulativeNow - cumulativeThen;
  const w = BigInt(windowS);
  let tick = delta / w;
  if (delta < 0n && delta % w !== 0n) tick -= 1n;
  return Number(tick);
}

/** USD per GITLAWB from a WETH/GITLAWB tick (GITLAWB per WETH = 1.0001^tick; both 18-dec) and ETH/USD. */
export function gitlawbUsdFromTick(tick: number, ethUsd: number | null): number | null {
  if (ethUsd === null || !(ethUsd > 0) || !Number.isFinite(tick)) return null;
  const usd = ethUsd / Math.pow(1.0001, tick);
  return Number.isFinite(usd) && usd > 0 ? usd : null;
}

/**
 * Pick the price to publish: the spot unless it deviates from the TWAP by more than `maxDeviation`,
 * in which case the TWAP wins. With only one side available that side is used; with neither, null.
 */
export function reconcileGitlawbUsd(spot: number | null, twap: number | null, maxDeviation = MAX_SPOT_DEVIATION): { usd: number | null; source: "spot" | "twap" | null; deviation: number | null } {
  if (spot === null && twap === null) return { usd: null, source: null, deviation: null };
  if (spot === null) return { usd: twap, source: "twap", deviation: null };
  if (twap === null) return { usd: spot, source: "spot", deviation: null };
  const deviation = Math.abs(spot - twap) / twap;
  return deviation > maxDeviation ? { usd: twap, source: "twap", deviation } : { usd: spot, source: "spot", deviation };
}

/**
 * USD per GITLAWB from the v4 pool's sqrtPriceX96 (GITLAWB per WETH; both 18-dec) and ETH/USD.
 * null only when an input is unusable. Manipulation resistance comes from reconcileGitlawbUsd()
 * (spot vs the v3 TWAP), not from a fixed dollar band.
 */
export function gitlawbUsdFromSqrtPrice(sqrtPriceX96: bigint, ethUsd: number | null): number | null {
  if (ethUsd === null || !(ethUsd > 0) || sqrtPriceX96 <= 0n) return null;
  const gitlawbPerEth = sqrtPriceToTokensPerQuote(sqrtPriceX96, 18);
  if (!Number.isFinite(gitlawbPerEth) || gitlawbPerEth <= 0) return null;
  const usd = ethUsd / gitlawbPerEth;
  return Number.isFinite(usd) && usd > 0 ? usd : null;
}

/** Starting-market-cap presets in whole GITLAWB for the same dollar targets the stock form uses; empty while the price is unknown. */
export function gitlawbMcapPresets(usdPrice: number | null): number[] {
  return stockMcapPresets(usdPrice ?? 0).map(Math.round);
}

/**
 * Gitlawb's logo (the white branch-and-key mark on black, as on gitlawb.com) as a rounded tile, served from
 * our own origin. `public/gitlawb-mark.png` is generated from the web repo's `public/logo.png`: strokes
 * boldened slightly so they survive 18–22px badges, cropped to the mark, 160px, transparent corners.
 */
export const GITLAWB_LOGO_PATH = "/gitlawb-mark.png";
/** The tile's ground — badges use the same black so the tile and the pill read as one piece. */
export const GITLAWB_LOGO_BG = "#000000";

export function isGitlawbAddress(address: string, chain: ChainKey = DEFAULT_CHAIN): boolean {
  const gl = GITLAWB_ADDRESSES[chain];
  return gl !== null && address.toLowerCase() === gl;
}
