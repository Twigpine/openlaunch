export function tradeQuoteKey(chain: string, token: string, side: "buy" | "sell", amount: string): string {
  return `${chain}:${token.toLowerCase()}:${side}:${amount}`;
}

/** Partial transfer indexing is not evidence of zero holdings or zero risk. */
export function holderFactsAvailable(panel: { synced: boolean } | null): boolean {
  return panel?.synced === true;
}

export function marketCount(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return value.toLocaleString("en-US", { notation: "compact", maximumFractionDigits: 1 });
}
