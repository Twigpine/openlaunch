/**
 * Pure launchpad math (no server-only, unit-tested). Prices are "token per
 * 1 ETH" (currency0 = ETH/quote, currency1 = token; both 18 decimals). Uniswap
 * price = currency1 / currency0 = 1.0001^tick, so tick > 0 means many tokens
 * per ETH — the cheap-token regime every launch starts in. Buys push the tick
 * DOWN (fewer tokens per ETH = token got pricier).
 */
import { encodeAbiParameters, keccak256, type Address, type Hex } from "viem";

// Self-contained on purpose: node --test loads this file directly and cannot
// resolve extensionless sibling imports. config.ts re-exports these.
export const TICK_SPACING = 200;

const Q96 = 2n ** 96n;
const WAD = 10n ** 18n;

/**
 * Uniswap's raw price is token-wei per smallest quote unit = 1.0001^tick.
 * With `quoteDecimals` (18 for ETH, 6 for USDG) that becomes tokens per 1 whole
 * quote unit: 1.0001^tick · 10^qd / 10^18.
 */
export function tickToTokensPerQuote(tick: number, quoteDecimals = 18): number {
  return Math.pow(1.0001, tick) * Math.pow(10, quoteDecimals - 18);
}

/** sqrtPriceX96 → tokens per 1 whole quote unit (float). */
export function sqrtPriceToTokensPerQuote(sqrtPriceX96: bigint, quoteDecimals = 18): number {
  const s = Number(sqrtPriceX96) / Number(Q96);
  return s * s * Math.pow(10, quoteDecimals - 18);
}

/** Whole quote units per 1 token (float). */
export function quotePerToken(sqrtPriceX96: bigint, quoteDecimals = 18): number {
  const t = sqrtPriceToTokensPerQuote(sqrtPriceX96, quoteDecimals);
  return t > 0 ? 1 / t : 0;
}

/** Fully diluted valuation in whole quote units. */
export function fdvQuote(sqrtPriceX96: bigint, supplyWei: bigint, quoteDecimals = 18): number {
  return quotePerToken(sqrtPriceX96, quoteDecimals) * (Number(supplyWei) / 1e18);
}

/**
 * Start tick for a target FDV in whole quote units: tokens per quote unit =
 * supply / fdv, converted to Uniswap's raw ratio, snapped DOWN to the tick
 * spacing (a slightly higher FDV, never lower).
 */
export function startTickForFdv(fdv: number, quoteDecimals = 18, supplyWei: bigint = 10n ** 27n): number {
  if (!(fdv > 0)) throw new Error("fdv must be > 0");
  const tokensPerQuote = Number(supplyWei) / 1e18 / fdv;
  const rawRatio = tokensPerQuote * Math.pow(10, 18 - quoteDecimals);
  const raw = Math.log(rawRatio) / Math.log(1.0001);
  return Math.floor(raw / TICK_SPACING) * TICK_SPACING;
}

/** FDV (whole quote units) implied by a start tick, for the form's live preview. */
export function fdvForStartTick(tick: number, quoteDecimals = 18, supplyWei: bigint = 10n ** 27n): number {
  return Number(supplyWei) / 1e18 / tickToTokensPerQuote(tick, quoteDecimals);
}

/** Whole-unit amount from a raw amount with `decimals`. */
/**
 * USD per quote unit: `usd` when the quote carries one (stables, a native stable such as USDC on Arc, live-priced
 * stocks and GITLAWB), the live ETH price for the ETH quote, and unknown → null for anything else. The quote must come
 * from quoteInfo(chain, …) / the chain's config: address(0) alone says nothing about what a chain's native asset is.
 */
export function quoteUsdOf(q: { key: string; usd: number | null }, ethUsd: number | null): number | null {
  if (q.usd !== null && q.usd !== undefined) return q.usd;
  return q.key === "eth" ? ethUsd : null;
}

export function units(raw: bigint | string, decimals: number): number {
  return Number(BigInt(raw)) / Math.pow(10, decimals);
}

/** Uniswap v4 PoolId = keccak256(abi.encode(PoolKey)). */
export function poolIdOf(key: { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address }): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "address" },
        { type: "address" },
        { type: "uint24" },
        { type: "int24" },
        { type: "address" },
      ],
      [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks],
    ),
  );
}

/**
 * What the very first buy into a fresh launch pool returns, before anyone else
 * has traded. Mirrors the factory exactly: the whole supply sits as currency1
 * liquidity in [minUsableTick, startTick], the pool is initialized at the
 * upper edge, and a buy (quote in, zeroForOne) walks the price down the range:
 *   L = supply / (√Pu − √Pl)                       (getLiquidityForAmount1)
 *   1/√Pnew = 1/√Pu + Δin·(1 − fee)/L               (Δ currency0 for a move)
 *   out = L · (√Pu − √Pnew)                         (Δ currency1 released)
 * Floats are plenty for a preview (relative error ≪ 1e-9); the real amount is
 * quoted on-chain right before the swap.
 */
export function initialBuyPreview(args: { startTick: number; amountInRaw: bigint; lpFeePips?: number; quoteDecimals?: number; supplyWei?: bigint }): { tokensOut: number; pctOfSupply: number; fdvAfter: number } {
  const { startTick, amountInRaw, lpFeePips = 0, quoteDecimals = 18, supplyWei = 10n ** 27n } = args;
  const supply = Number(supplyWei);
  const minTick = -Math.floor(887_272 / TICK_SPACING) * TICK_SPACING;
  const sqrtPu = Math.pow(1.0001, startTick / 2);
  const sqrtPl = Math.pow(1.0001, minTick / 2);
  const L = supply / (sqrtPu - sqrtPl);
  const dIn = Number(amountInRaw) * (1 - lpFeePips / 1_000_000);
  const sqrtPnew = Math.max(sqrtPl, 1 / (1 / sqrtPu + dIn / L));
  const outRaw = Math.min(supply, L * (sqrtPu - sqrtPnew));
  const tokensPerQuote = sqrtPnew * sqrtPnew * Math.pow(10, quoteDecimals - 18);
  return { tokensOut: outRaw / 1e18, pctOfSupply: (outRaw / supply) * 100, fdvAfter: supply / 1e18 / tokensPerQuote };
}

/** Slippage-adjusted minimum output. */
export function minOut(amountOut: bigint, slippageBps: number): bigint {
  return (amountOut * BigInt(10_000 - slippageBps)) / 10_000n;
}

// ── formatting ───────────────────────────────────────────────────────────────

const COMPACT_UNITS: readonly [number, string][] = [[1e12, "T"], [1e9, "B"], [1e6, "M"], [1e3, "K"]];

/** Compact number with a K/M/B/T suffix. A value that rounds up to 1000 of a unit takes the next one: 999,999 → "1.00M", never "1000.00K". */
export function fmtCompact(n: number, digits = 2): string {
  if (!Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  const i = COMPACT_UNITS.findIndex(([size]) => abs >= size);
  if (i === -1) return n.toFixed(abs >= 100 ? 0 : abs >= 1 ? 2 : digits);
  const [size, suffix] = COMPACT_UNITS[i];
  if (i > 0 && Math.abs(Number((n / size).toFixed(digits))) >= 1000) {
    const [nextSize, nextSuffix] = COMPACT_UNITS[i - 1];
    return `${(n / nextSize).toFixed(digits)}${nextSuffix}`;
  }
  return `${(n / size).toFixed(digits)}${suffix}`;
}

/** Quote amount for display: "0.0421" style, trimming noise. bigint = wei (18 dec); number = whole units. */
export function fmtEth(wei: bigint | number, opts: { max?: number } = {}): string {
  const v = typeof wei === "bigint" ? Number(wei) / 1e18 : wei;
  if (!Number.isFinite(v)) return "—";
  if (v === 0) return "0";
  const abs = Math.abs(v);
  const digits = abs >= 100 ? 1 : abs >= 1 ? 3 : abs >= 0.01 ? 4 : abs >= 0.0001 ? 6 : 8;
  return v.toFixed(Math.min(digits, opts.max ?? digits)).replace(/\.?0+$/, "");
}

/** Tiny per-token prices: "0.00000012" or subscript-free sci notation for extremes. */
export function fmtPrice(v: number): string {
  if (!Number.isFinite(v) || v <= 0) return "—";
  if (v >= 1) return v.toFixed(4).replace(/\.?0+$/, "");
  if (v >= 1e-8) return v.toFixed(10).replace(/\.?0+$/, "");
  return v.toExponential(2);
}

export function fmtUsd(v: number, opts: { compact?: boolean } = {}): string {
  if (!Number.isFinite(v)) return "—";
  if (opts.compact && Math.abs(v) >= 1000) return `$${fmtCompact(v, 1)}`;
  if (Math.abs(v) >= 1) return `$${v.toLocaleString("en-US", { maximumFractionDigits: 2, minimumFractionDigits: v >= 100 ? 0 : 2 })}`;
  if (v === 0) return "$0";
  return `$${fmtPrice(v)}`;
}

/** Token amounts with 18 decimals → compact human number. */
export function fmtTokens(wei: bigint): string {
  return fmtCompact(Number(wei) / 1e18);
}

export function pipsToPct(pips: number): string {
  const pct = pips / 10_000;
  return `${Number.isInteger(pct) ? pct : pct.toFixed(2)}%`;
}

const COMPACT = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 });

/**
 * The smallest non-zero amount fmtQuoteUnits can show for a quote: half of its last displayed digit
 * (2 decimals for stables, 8 for everything else). Below it a real trade used to print as a bare "0".
 */
export function quoteDisplayFloor(decimals: number): number {
  return decimals <= 6 ? 0.005 : 5e-9;
}

/**
 * Whole quote units for display. ≤6-dec quotes (stables) show 2 decimals; 18-dec quotes show ETH-style
 * precision below 100K units and compact above (GITLAWB: millions per dollar → "1.2M", never
 * "1200000.0000"; 999,999 → "1M", not "1000.00K"). A non-zero amount under the display floor reads
 * "<0.01" / "<0.00000001", never "0": only an exact zero prints "0".
 */
export function fmtQuoteUnits(v: number, decimals: number): string {
  if (!Number.isFinite(v)) return "—";
  const abs = Math.abs(v);
  if (abs > 0 && abs < quoteDisplayFloor(decimals)) return decimals <= 6 ? "<0.01" : "<0.00000001";
  if (decimals <= 6) return (abs >= 100 ? v.toFixed(0) : v.toFixed(2)).replace(/\.00$/, "");
  return Math.round(abs) >= 100_000 ? COMPACT.format(v) : fmtEth(v);
}

/**
 * The exact amount behind a compact figure, for a title: integer part with thousands separators, the fraction
 * trimmed of trailing zeros, no float anywhere (a raw 18-dec string keeps every digit). "0" for zero.
 */
export function fmtUnitsExact(raw: bigint | string, decimals: number): string {
  const v = BigInt(raw);
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const base = 10n ** BigInt(decimals);
  const whole = (abs / base).toLocaleString("en-US");
  const frac = (abs % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}

/** "12.5 USDG" / "0.05 ETH" / "1.2M GITLAWB" from a raw amount. */
export function fmtQuote(raw: bigint | string, decimals: number, symbol: string): string {
  return `${fmtQuoteUnits(units(raw, decimals), decimals)} ${symbol}`;
}

export const WAD_ = WAD;
