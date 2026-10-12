/**
 * Market cap is a dollar figure everywhere; the quote-denominated figure is a detail. Pure, node --test loads it directly.
 *
 * The launch form lets the creator enter the starting cap in dollars whenever the quote has a USD price (ETH, USDG,
 * GITLAWB and stocks with a live price) and converts to quote units for the tick maths; when the quote has no price
 * the form falls back to quote units, as before. The same four dollar targets apply to every priced quote, so an
 * ETH launch no longer opens at "10 ETH" while a USDG launch opens at "$10K".
 */

import { MCAP_PRESETS, type Quote } from "./config";
import { fmtCompact, fmtQuoteUnits } from "./math";
import { marketUsd } from "./market-format";

export const MCAP_USD_TARGETS = [5_000, 10_000, 25_000, 100_000];
export const MCAP_DEFAULT_INDEX = 2; // $25K, about what the old 10 ETH default was

/** How the form takes the starting cap: in dollars (with the quote's USD price) or in quote units (no price). */
export type CapEntry = { unit: "usd"; quoteUsd: number } | { unit: "quote" };

export function capEntry(quoteUsd: number | null): CapEntry {
  return quoteUsd !== null && Number.isFinite(quoteUsd) && quoteUsd > 0 ? { unit: "usd", quoteUsd } : { unit: "quote" };
}

/** Preset caps in the entry unit: the dollar targets, or the quote-unit presets a quote has without a price (none for stocks/GITLAWB). */
export function capPresets(entry: CapEntry, quoteKey: Quote["key"]): number[] {
  return entry.unit === "usd" ? MCAP_USD_TARGETS : MCAP_PRESETS[quoteKey];
}

/** The preset to use: the creator's pick when it belongs to this quote's presets (a pick does not carry across quotes), else the default. */
export function capPick(pick: number | null, presets: number[]): number | null {
  if (pick !== null && presets.includes(pick)) return pick;
  return presets[MCAP_DEFAULT_INDEX] ?? presets[0] ?? null;
}

/** A cap in the entry unit → quote units, which is what the start tick is computed from. */
export function capToQuote(v: number, entry: CapEntry): number {
  return entry.unit === "usd" ? v / entry.quoteUsd : v;
}

/** Preset chip text: "$25K" in dollar mode, "10 ETH" in quote mode. */
export function capChipLabel(v: number, entry: CapEntry, quote: Pick<Quote, "symbol" | "decimals">): string {
  return entry.unit === "usd" ? `$${fmtCompact(v, 0)}` : `${fmtQuoteUnits(v, quote.decimals)} ${quote.symbol}`;
}

/** A quote-denominated cap as quote text: "9.87 ETH", "25,000 USDG", "0.112 NVDA". */
export function capQuoteLabel(fdvQuote: number, quote: Pick<Quote, "key" | "symbol" | "decimals">): string {
  if (typeof fdvQuote !== "number" || !Number.isFinite(fdvQuote) || fdvQuote < 0) return "—";
  if (fdvQuote >= 1e15) return `${fdvQuote.toExponential(1)} ${quote.symbol}`;
  if (quote.decimals <= 6) return `${fdvQuote.toLocaleString("en-US", { maximumFractionDigits: Math.abs(fdvQuote) < 100 ? 2 : 0 })} ${quote.symbol}`; // a 0.5 USDG cap is "0.5 USDG", not "1 USDG"
  if (quote.key === "stock") return `${fdvQuote.toFixed(3)} ${quote.symbol}`;
  return `${fmtQuoteUnits(fdvQuote, quote.decimals)} ${quote.symbol}`;
}

export const NO_USD_PRICE = "no USD price";

/**
 * How a cap is shown anywhere on the site: the dollar figure leads and the quote figure is the detail; without a USD
 * price the quote figure leads and the detail says so. Never a bare dash. `compact` is the one-string form for sites
 * with room for a single figure: the dollar figure when priced, else the quote figure with the mark, so an unpriced
 * cap is never shown as if it were dollars.
 */
export function capDisplay(fdvQuote: number, quoteUsd: number | null, quote: Pick<Quote, "key" | "symbol" | "decimals">): { main: string; detail: string; compact: string; usd: number | null } {
  const quoteText = capQuoteLabel(fdvQuote, quote);
  if (quoteText === "—") return { main: "—", detail: "valuation unavailable", compact: "—", usd: null };
  if (quoteUsd !== null && Number.isFinite(quoteUsd) && quoteUsd > 0) {
    const usd = fdvQuote * quoteUsd;
    if (!Number.isFinite(usd)) return { main: "—", detail: quoteText, compact: "—", usd: null };
    const main = marketUsd(usd);
    return { main, detail: quoteText, compact: main, usd };
  }
  return { main: quoteText, detail: NO_USD_PRICE, compact: `${quoteText} · ${NO_USD_PRICE}`, usd: null };
}
