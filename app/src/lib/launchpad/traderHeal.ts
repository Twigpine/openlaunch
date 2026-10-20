/**
 * Pure planning for the missing-trader heal pass. No `server-only` import: node --test loads it directly.
 *
 * The old query took the newest 100 rows every time. Rows whose transaction could not be read were parked in a
 * retry map and skipped, but they still occupied those 100 slots, so rows behind them were never reached. This
 * planner always advances past every visited transaction group (parked or not); the caller stores the returned
 * cursor and asks for the page after it next tick. The page therefore walks the whole set instead of staring at
 * its head.
 */
export type HealSwapRow = { tx_hash: string; log_index: number; token: string; block_number: bigint };
export type TraderHealCursor = { block: bigint; log: number };

export type TraderHealGroup = {
  tx: string;
  /** `${chain}:${tx}`: the key used by the rest map. */
  key: string;
  swaps: HealSwapRow[];
  resting: boolean;
  /** The last row of the group, which the next page starts after. */
  last: TraderHealCursor;
};

export function planTraderHeal(
  rows: readonly HealSwapRow[],
  restUntil: ReadonlyMap<string, number>,
  chain: string,
  now: number,
  maxReads: number,
): { groups: TraderHealGroup[]; reads: number; cursor: TraderHealCursor | null } {
  const byTx = new Map<string, HealSwapRow[]>();
  for (const r of rows) {
    const group = byTx.get(r.tx_hash);
    if (group) group.push(r);
    else byTx.set(r.tx_hash, [r]);
  }
  const groups: TraderHealGroup[] = [];
  let reads = 0;
  let cursor: TraderHealCursor | null = null;
  for (const [tx, swaps] of byTx) {
    if (reads >= maxReads) break;
    const last = swaps[swaps.length - 1]!;
    cursor = { block: last.block_number, log: Number(last.log_index) };
    const key = `${chain}:${tx}`;
    const resting = now < (restUntil.get(key) ?? 0);
    groups.push({ tx, key, swaps, resting, last: cursor });
    if (!resting) reads++;
  }
  return { groups, reads, cursor };
}
