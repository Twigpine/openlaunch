/** Correlate core pool deltas with the authenticated hook's trader deltas, in receipt order. */
export type QuoteSwapLog = {
  address: string; transactionHash: string | null; logIndex: number | null;
  args: { poolId: string; quoteFee: bigint; amount0: bigint; amount1: bigint };
};
type CoreSwapLog = { transactionHash: string | null; logIndex: number | null; args: { id?: string; amount0?: bigint; amount1?: bigint } };
/** Pair each core Swap on a quote-only pool with the hook's QuoteSwap from the same transaction; throws when one is missing or inconsistent so the range is retried. */
export function pairQuoteSwaps(core: CoreSwapLog[], hooks: QuoteSwapLog[], quotePools: Map<string, string>): Map<string, QuoteSwapLog> {
  const queues = new Map<string, QuoteSwapLog[]>();
  for (const log of [...hooks].sort((a, b) => (a.logIndex ?? 0) - (b.logIndex ?? 0))) {
    const pool = log.args.poolId.toLowerCase();
    if (quotePools.get(pool)?.toLowerCase() !== log.address.toLowerCase()) continue;
    const key = `${log.transactionHash}:${pool}`;
    const queue = queues.get(key) ?? [];
    queue.push(log); queues.set(key, queue);
  }
  const result = new Map<string, QuoteSwapLog>();
  for (const log of [...core].sort((a, b) => (a.logIndex ?? 0) - (b.logIndex ?? 0))) {
    const pool = log.args.id?.toLowerCase();
    if (!pool || !quotePools.has(pool)) continue;
    const hook = queues.get(`${log.transactionHash}:${pool}`)?.shift();
    if (!hook || hook.args.amount0 + hook.args.quoteFee !== log.args.amount0 || hook.args.amount1 !== log.args.amount1) {
      throw new Error(`Missing or inconsistent quote fee event for ${log.transactionHash}:${log.logIndex}`);
    }
    result.set(`${log.transactionHash}:${log.logIndex}`, hook);
  }
  return result;
}
