import type { Address } from "viem";
import type { Quote } from "./config";

/**
 * Quotes the site does not list. The factory is permissionless: a launch can pair with any ERC-20, not only the
 * quotes the form offers (config.ts) or a stock registry knows. Such a pool is indexed and shown, but as an
 * UNLISTED pair: key "other", never priced in USD, never trending, and its symbol is only a label.
 *
 * The label is the token's own on-chain symbol, read once by the indexer (bb_quote_tokens). Anyone can deploy a
 * token named "USDC", so a symbol that is or looks like one we list is replaced by the address; so is one we could
 * not read. Decimals come from the chain too; until they are known the page shows the pool but does not trade it,
 * since every amount would otherwise be off by the difference (a 6-decimal quote read as 18 is off by 10^12).
 * Pure, node --test loads it directly.
 */

/** Symbols an unlisted quote may never show as: the quotes we list anywhere, and the assets people take them for. */
export const RESERVED_QUOTE_SYMBOLS = ["ETH", "WETH", "CBETH", "USDC", "USDG", "USDT", "USDBC", "DAI", "EURC", "BTC", "WBTC", "CBBTC", "GITLAWB", "MUSEWORLD"];
/** Any symbol starting with these reads as a dollar or as one of our own tokens ("USDC.e", "USD+", "GITLAWB2", "MUSEWORLD.v2"). */
const RESERVED_PREFIXES = ["USD", "GITLAWB", "MUSEWORLD"];

export const UNLISTED_SYMBOL_MAX = 12;
/** Beyond this, 10^decimals leaves double precision and the tick maths is meaningless. */
export const MAX_QUOTE_DECIMALS = 36;

/** What the indexer read from the quote's contract: null for a field the contract did not answer. */
export type QuoteTokenMeta = { symbol: string | null; name: string | null; decimals: number | null };

function comparable(s: string): string {
  return s.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/**
 * The on-chain symbol as a display label, or null when it must not be shown: empty after cleaning, or the same as
 * (or dressed up as) a listed asset. Only ASCII letters, digits and . _ - survive, so look-alike letters from other
 * scripts (Cyrillic "С", full-width "Ｕ") cannot spell a listed symbol; NFKC first folds full-width to plain ASCII,
 * which the reserved check then catches. `extraReserved` is the chain's stock tickers.
 */
export function cleanQuoteSymbol(raw: string | null | undefined, extraReserved: Iterable<string> = []): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.normalize("NFKC").replace(/^\$+/, "").replace(/[^A-Za-z0-9._-]/g, "").slice(0, UNLISTED_SYMBOL_MAX);
  const c = comparable(s);
  if (!c) return null;
  const reserved = new Set([...RESERVED_QUOTE_SYMBOLS, ...[...extraReserved].map(comparable)]);
  if (reserved.has(c) || RESERVED_PREFIXES.some((p) => c.startsWith(p))) return null;
  return s;
}

export function validDecimals(d: unknown): d is number {
  return typeof d === "number" && Number.isInteger(d) && d >= 0 && d <= MAX_QUOTE_DECIMALS;
}

/** "0x882c…29f8": what an unlisted quote is called when its own symbol cannot be shown. */
export function addressLabel(address: string): string {
  const a = address.toLowerCase();
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

/**
 * The Quote for an address no list knows. Without readable decimals it keeps the 18-decimal placeholder (the common
 * case, so the page stays roughly right) and says so with `decimalsKnown: false`; callers must not trade it.
 */
export function unlistedQuote(address: string, meta: QuoteTokenMeta | null, extraReserved: Iterable<string> = []): Quote {
  const known = validDecimals(meta?.decimals);
  return {
    key: "other",
    address: address as Address,
    symbol: cleanQuoteSymbol(meta?.symbol, extraReserved) ?? addressLabel(address),
    decimals: known ? meta!.decimals! : 18,
    usd: null,
    decimalsKnown: known,
  };
}
