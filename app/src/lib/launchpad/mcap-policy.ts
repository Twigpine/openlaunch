/** Market-cap browsing policy. Small launches never need volume or holders to appear. */
export const MCAP_HIGH_USD = 10_000_000;
export const MCAP_SUPPORT_RATIO = 0.001;
export const MCAP_MIN_TRADERS = 3;
export const MCAP_MIN_WALLET_USD = 1;
export const MCAP_POLICY_VERSION = 1;

export type McapMode = "filtered" | "all";
/**
 * The public list/live API keeps its unfiltered market-cap order unless a caller asks for the filter (`mcap=filtered`), so
 * existing API readers see no change. The site defaults to the filter and always sends its mode explicitly.
 */
export const API_MCAP_DEFAULT: McapMode = "all";
/** Read `mcap=filtered|all`; a missing or unknown value takes `fallback` (the site's default: filtered). */
export function parseMcapMode(raw: unknown, fallback: McapMode = "filtered"): McapMode {
  return raw === "all" || raw === "filtered" ? raw : fallback;
}

export type McapFacts = {
  startFdvQuote: number;
  fdvQuote: number;
  quoteUsd: number | null;
  /** Only measured for high starting/current valuations; null otherwise. */
  outsideVolumeQuote: number | null;
  outsideTraders: number | null;
};
export type McapClassification = "included" | "limited-outside-trading" | "unpriced";

/**
 * Classify quote-denominated FDVs using the current quote/USD price and lifetime outside-trading facts.
 * Invalid valuations stay unpriced; small starting or current valuations never need trading support.
 */
export function classifyMcap(facts: McapFacts): McapClassification {
  const { startFdvQuote, fdvQuote, quoteUsd, outsideVolumeQuote, outsideTraders } = facts;
  if (quoteUsd === null || !Number.isFinite(quoteUsd) || quoteUsd <= 0 ||
      !Number.isFinite(startFdvQuote) || startFdvQuote <= 0 || !Number.isFinite(fdvQuote) || fdvQuote <= 0 ||
      !Number.isFinite(startFdvQuote * quoteUsd) || !Number.isFinite(fdvQuote * quoteUsd)) return "unpriced";
  if (startFdvQuote * quoteUsd < MCAP_HIGH_USD || fdvQuote * quoteUsd < MCAP_HIGH_USD) return "included";
  return outsideVolumeQuote !== null && Number.isFinite(outsideVolumeQuote) && outsideVolumeQuote >= startFdvQuote * MCAP_SUPPORT_RATIO &&
    outsideTraders !== null && outsideTraders >= MCAP_MIN_TRADERS ? "included" : "limited-outside-trading";
}

export const MCAP_FILTER_DESCRIPTION = "Starting and current valuations of at least $10M need lifetime outside trading of at least 0.1% of the starting valuation, from at least 3 wallets trading $1 each. Creator trades and the launch block plus the next 3 blocks are excluded. Both valuations use the current quote/USD price. Small launches remain visible with zero trades.";
