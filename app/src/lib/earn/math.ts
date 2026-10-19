import { formatUnits, parseUnits } from "viem";
import { sanitizeDecimalInput } from "../launchpad/decimal-input.ts";

/**
 * Earn arithmetic (pure; node --test loads it directly). Amounts stay bigint in the asset's raw units; numbers appear
 * only for display.
 */

/** The rate window: what the vault paid over the last 30 days. */
export const RATE_WINDOW_S = 30 * 86_400;
const YEAR_S = 365 * 86_400;
/** Shares used to read the share price: a million whole shares keeps 12 significant digits of a 6-decimal asset. */
export const SHARE_PRICE_PROBE = 10n ** 24n;

/**
 * What the vault actually paid between two share-price reads, as a simple annual rate (not compounded):
 * (after / before − 1) × year / elapsed. A share price that fell gives a negative rate, shown as it is.
 * Null when it cannot be told (a missing or zero read, or no time between the reads).
 */
export function annualisedRate(before: bigint, after: bigint, elapsedS: number): number | null {
  if (before <= 0n || after <= 0n || !Number.isFinite(elapsedS) || elapsedS <= 0) return null;
  const growth = Number(after - before) / Number(before); // the difference in bigint keeps the precision
  return (growth * YEAR_S) / elapsedS;
}

/** "4.4%", "−0.3%", "—" when unknown. One decimal: the rate moves every block, more digits would be noise. */
export function fmtRate(rate: number | null): string {
  if (rate === null || !Number.isFinite(rate)) return "—";
  const tenths = Math.round(Math.abs(rate) * 1000); // rounded by size, so a loss rounds like the same gain
  if (tenths === 0) return "0.0%";
  return `${rate < 0 ? "−" : ""}${(tenths / 10).toFixed(1)}%`;
}

/** A WAD fee (1e18 = 100%) as a percent number. */
export function wadPct(wad: bigint): number {
  return Number(wad) / 1e16;
}

/** Vault V2's management fee is a WAD rate per second; this is the yearly percent. */
export function managementFeeYearPct(perSecondWad: bigint): number {
  return (Number(perSecondWad) * YEAR_S) / 1e16;
}

/** "0%", "10%", "2.5%": a fee as people read it. */
export function fmtFeePct(pct: number): string {
  if (!Number.isFinite(pct) || pct <= 0) return "0%";
  return `${Math.round(pct * 100) / 100}%`;
}

/**
 * What the amount field may hold: the shared sanitizer (which refuses anything ambiguous, see decimal-input.ts), then
 * no more fraction digits than the asset has, so the field never shows a figure the chain cannot represent.
 */
export function cleanAmountInput(raw: string, decimals: number): string {
  const s = sanitizeDecimalInput(raw);
  const dot = s.indexOf(".");
  return dot === -1 ? s : s.slice(0, dot + 1 + decimals);
}

/** The field's text as raw units, or null when it is empty, not a number, or not above zero. */
export function parseAmount(text: string, decimals: number): bigint | null {
  const s = text.trim();
  if (!s || s === ".") return null;
  if (!/^\d*\.?\d*$/.test(s)) return null;
  const frac = s.split(".")[1] ?? "";
  if (frac.length > decimals) return null;
  try {
    const v = parseUnits(s, decimals);
    return v > 0n ? v : null;
  } catch {
    return null;
  }
}

/** The Max button's text: the whole balance, every digit (no rounding up past what the wallet holds). */
export function maxInput(raw: bigint, decimals: number): string {
  return raw > 0n ? formatUnits(raw, decimals) : "";
}

/**
 * An asset amount for display: grouped whole part and two decimals, always rounded DOWN so the screen never shows
 * more than is there; "<0.01" for a dust balance above zero.
 */
export function fmtAmount(raw: bigint, decimals: number, places = 2): string {
  if (raw < 0n) return `−${fmtAmount(-raw, decimals, places)}`;
  const unit = 10n ** BigInt(decimals);
  const whole = raw / unit;
  const keep = Math.min(places, decimals);
  const frac = ((raw % unit) / 10n ** BigInt(decimals - keep)).toString().padStart(keep, "0");
  if (raw > 0n && whole === 0n && /^0*$/.test(frac)) return `<0.${"0".repeat(Math.max(0, keep - 1))}1`;
  return keep > 0 ? `${whole.toLocaleString("en-US")}.${frac}` : whole.toLocaleString("en-US");
}

/** Why a deposit cannot go ahead yet, as the button's text, or null when it can. */
export function depositProblem({ amount, balance }: { amount: bigint | null; balance: bigint | undefined }): string | null {
  if (amount === null) return "Enter an amount";
  if (balance === undefined) return "Reading your balance…";
  if (amount > balance) return "More than your USDC";
  return null;
}

/**
 * How to take an amount out. Asking for the whole position (or more) redeems every share, so no dust share is left
 * behind and rounding can never ask for one share too many; anything less withdraws that exact amount of the asset.
 */
export type WithdrawPlan = { fn: "redeem"; shares: bigint; assets: bigint } | { fn: "withdraw"; assets: bigint };
export function withdrawPlan({ amount, shares, position }: { amount: bigint | null; shares: bigint | undefined; position: bigint | undefined }): WithdrawPlan | null {
  if (amount === null || shares === undefined || position === undefined || shares <= 0n) return null;
  if (amount >= position) return { fn: "redeem", shares, assets: position };
  return { fn: "withdraw", assets: amount };
}

/** Why a withdrawal cannot go ahead yet, as the button's text, or null when it can. */
export function withdrawProblem({ amount, shares, position }: { amount: bigint | null; shares: bigint | undefined; position: bigint | undefined }): string | null {
  if (shares === undefined || position === undefined) return "Reading your deposit…";
  if (shares <= 0n) return "Nothing deposited";
  if (amount === null) return "Enter an amount";
  if (amount > position) return "More than your deposit";
  return null;
}
