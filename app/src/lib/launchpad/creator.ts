/** Pure creator-dashboard math (node --test loads this directly). */
export type Recipient = { payout: string; bps: number };
const DEAD = "0x000000000000000000000000000000000000dead";

/** This wallet's share of a launch's fees, in bps (0 when it is not a recipient). */
export function feeShareBps(recipients: Recipient[], wallet: string): number {
  const w = wallet.toLowerCase();
  return recipients.filter((r) => r.payout.toLowerCase() === w).reduce((a, r) => a + r.bps, 0);
}

/** Fees this wallet has been paid so far (raw quote units): (collected − burned) × its share. Exact in push mode. */
export function earnedRaw(collectedQuote: bigint | string, burnedQuote: bigint | string, shareBps: number): bigint {
  const paid = BigInt(collectedQuote) - BigInt(burnedQuote);
  if (paid <= 0n || shareBps <= 0) return 0n;
  return (paid * BigInt(shareBps)) / 10_000n;
}

/**
 * Fees in both pool currencies (raw units). Every collect pays beneficiaries the
 * quote side (buy fees) and the launched token side (sell fees) of the pool.
 */
export type FeeSides = { quote: bigint; token: bigint };

/** This wallet's paid share on both sides, from the indexed collected/burned totals. */
export function earnedSides(
  l: { wallet_fees_quote_paid?: string; fees_quote_collected: string; fees_quote_burned: string; fees_token_collected: string; fees_token_burned: string },
  shareBps: number,
): FeeSides {
  if (l.wallet_fees_quote_paid !== undefined) return { quote: BigInt(l.wallet_fees_quote_paid), token: 0n };
  return { quote: earnedRaw(l.fees_quote_collected, l.fees_quote_burned, shareBps), token: earnedRaw(l.fees_token_collected, l.fees_token_burned, shareBps) };
}

/** USD value of a fee pair: token side priced at the pool price (whole quote per token, 18-decimal token). Null without a quote USD price. */
export function feeSidesUsd(sides: FeeSides, quoteDecimals: number, priceQuote: number, quoteUsd: number | null): number | null {
  if (quoteUsd === null) return null;
  return (Number(sides.quote) / 10 ** quoteDecimals + (Number(sides.token) / 1e18) * priceQuote) * quoteUsd;
}

/** Whether a launch burns everything (no beneficiary). */
export function isBurnOnly(recipients: Recipient[]): boolean {
  return recipients.length === 1 && recipients[0].payout.toLowerCase() === DEAD;
}

/** Portfolio value of a holding: balance (wei) × price (whole quote per token) × quote USD. */
export function holdingUsd(balanceWei: bigint | string, priceQuote: number, quoteUsd: number | null): number | null {
  if (quoteUsd === null) return null;
  return (Number(BigInt(balanceWei)) / 1e18) * priceQuote * quoteUsd;
}

/** Whether a fee pair holds anything on either side. */
export function hasFees(sides: FeeSides | null | undefined): sides is FeeSides {
  return Boolean(sides && (sides.quote > 0n || sides.token > 0n));
}
