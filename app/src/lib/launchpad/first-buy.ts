/**
 * The suggested first buy. Pure, node --test loads it directly.
 *
 * The launch form pre-fills a small buy (about SUGGESTED_BUY_USD in the quote asset) so a token opens with a holder and
 * a price move: with neither it reads as dead on every screener and sits under "quiet launches" on the home page.
 *
 * One rule: a SUGGESTED buy never blocks a launch. The default is selected from the start, wallet or not, so the form
 * always shows what it suggests; once a wallet is connected the balances can only take it away: it is dropped when the
 * quote balance cannot cover the amount, the native balance cannot cover the buy's gas (for an ETH quote, and for a quote
 * that is the chain's gas token in ERC-20 form such as USDC on Arc, both come from the same balance), or a balance read failed. While a read is still pending the suggestion stays, marked provisional.
 * The creator can clear it at any time. An amount the creator TYPED keeps the strict checks (LaunchForm.tsx).
 */

import type { Quote } from "./config";

export const SUGGESTED_BUY_USD = 25;

/** Quick-pick amounts per quote; the first one is the suggestion (about $25 at the prices this was written at). */
export const BUY_PRESETS: Record<Quote["key"], string[]> = { eth: ["0.01", "0.05", "0.1", "0.25"], usdg: ["25", "100", "250"], usdc: ["25", "100", "250"], gitlawb: ["500000", "1000000", "5000000"], museworld: [] /* not offered in the form */, stock: [], other: [] /* the form never offers an unlisted quote */ };

export type NoSuggestion = "no-price" | "unknown-balance" | "insufficient" | "no-gas" | "declined";
/** `provisional`: shown as selected but not yet confirmed against a balance (no wallet yet, or the read is pending). */
export type FirstBuySuggestion = { amount: string; provisional: boolean; reason?: undefined } | { amount: null; reason: NoSuggestion };

function trimZeros(s: string): string {
  return s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s;
}

/** `usd` worth of a quote priced at `quoteUsd`, as a short decimal string that parseUnits accepts; null when it rounds to nothing. */
export function amountForUsd(usd: number, quoteUsd: number, decimals: number): string | null {
  if (!(usd > 0) || !(quoteUsd > 0) || !Number.isFinite(usd) || !Number.isFinite(quoteUsd)) return null;
  const v = usd / quoteUsd;
  let s = v >= 1 ? v.toFixed(2) : v.toPrecision(2);
  if (/e/i.test(s)) s = v.toFixed(Math.min(decimals, 12));
  s = trimZeros(s);
  if (s === "0" || s === "") return null;
  const places = (s.split(".")[1] ?? "").length;
  if (places <= decimals) return s;
  const rounded = trimZeros(v.toFixed(decimals)); // fewer decimals than the amount needs: round to what the quote can carry
  return rounded === "0" || rounded === "" ? null : rounded;
}

/** The amount the form suggests for a quote before looking at the wallet: the first preset, or $25 worth for a stock. */
export function defaultFirstBuy(quote: Pick<Quote, "key" | "decimals" | "usd">): string | null {
  const preset = BUY_PRESETS[quote.key][0];
  if (preset) return preset;
  return quote.usd ? amountForUsd(SUGGESTED_BUY_USD, quote.usd, quote.decimals) : null;
}

export type SuggestInput = {
  quote: Pick<Quote, "key" | "decimals" | "usd">;
  connected: boolean;
  /** Wallet balance of what the buy is paid with (wei of the quote); undefined while unknown or after a failed read. */
  balance: bigint | undefined;
  /** Native balance, which pays the buy's gas (and the approvals an ERC-20 quote needs first); undefined while unknown. */
  nativeBalance: bigint | undefined;
  /** A balance read failed (as opposed to still loading): the suggestion is dropped rather than left blocking the launch. */
  balanceFailed: boolean;
  /** Native amount (18-dec wei) kept back for that gas. */
  gasReserve: bigint;
  /** The quote is the gas token's ERC-20 face (Arc: USDC), so the buy and the gas draw on one balance. */
  sharesGasBalance?: boolean;
  /** The creator cleared the suggestion (this session). */
  declined: boolean;
  /** viem's parseUnits, injected so this module stays dependency-free for tests. */
  parse: (amount: string, decimals: number) => bigint;
};

/** A native (18-dec) gas reserve in the quote's own units, for a quote that shares the gas balance (ETH itself, or USDC on Arc). */
export function gasReserveInQuote(reserveWei: bigint, quoteDecimals: number): bigint {
  return quoteDecimals >= 18 ? reserveWei : reserveWei / 10n ** BigInt(18 - quoteDecimals);
}

export function suggestFirstBuy(i: SuggestInput): FirstBuySuggestion {
  if (i.declined) return { amount: null, reason: "declined" };
  const amount = defaultFirstBuy(i.quote);
  if (!amount) return { amount: null, reason: "no-price" };
  if (!i.connected) return { amount, provisional: true }; // selected from the start; a wallet can only take it away
  if (i.balance === undefined || i.nativeBalance === undefined) return i.balanceFailed ? { amount: null, reason: "unknown-balance" } : { amount, provisional: true };
  const raw = i.parse(amount, i.quote.decimals);
  if (i.quote.key === "eth" || i.sharesGasBalance) return raw + gasReserveInQuote(i.gasReserve, i.quote.decimals) > i.balance ? { amount: null, reason: "insufficient" } : { amount, provisional: false };
  if (raw > i.balance) return { amount: null, reason: "insufficient" };
  if (i.nativeBalance < i.gasReserve) return { amount: null, reason: "no-gas" };
  return { amount, provisional: false };
}
