/** The points compute's result and its log line (pure; node --test loads this directly). */

/** `read`: how many rows the run loaded (swaps, first buys, balance moves, linked transfers): it holds them all in memory. */
export type ComputeResult = { wallets: number; eligible: number; ms: number; read?: { swaps: number; firstBuys: number; moves: number; linked: number } } | { skipped: string };

/** A run that loads more rows than this, or takes longer, is logged as a warning: time to page the reads or move the run off the web machines. */
export const COMPUTE_WARN_ROWS = 1_000_000;
export const COMPUTE_WARN_MS = 60_000;

/**
 * The log line of one run: counts and time, flagged when the run is getting heavy (pure). `elapsedMs` (the caller's
 * clock) times a skipped run too: one skipped late (a price missing after the season was read) can be heavy as well.
 */
export function computeLogLine(slug: string, r: ComputeResult, elapsedMs?: number): { level: "log" | "warn"; line: string } {
  if ("skipped" in r) {
    const slow = elapsedMs !== undefined && elapsedMs > COMPUTE_WARN_MS;
    return { level: slow ? "warn" : "log", line: `[points] ${slug}: skipped (${r.skipped}), last board kept${elapsedMs !== undefined ? ` after ${elapsedMs}ms` : ""}${slow ? ` (heavy: over ${COMPUTE_WARN_MS / 1000}s)` : ""}` };
  }
  const rows = r.read ? r.read.swaps + r.read.firstBuys + r.read.moves + r.read.linked : 0;
  const heavy = rows > COMPUTE_WARN_ROWS || r.ms > COMPUTE_WARN_MS;
  const read = r.read ? ` from ${r.read.swaps} swaps, ${r.read.firstBuys} first buys, ${r.read.moves} moves, ${r.read.linked} linked transfers` : "";
  return { level: heavy ? "warn" : "log", line: `[points] ${slug}: ${r.wallets} wallets (${r.eligible} eligible) in ${r.ms}ms${read}${heavy ? ` (heavy: over ${COMPUTE_WARN_ROWS.toLocaleString("en-US")} rows or ${COMPUTE_WARN_MS / 1000}s)` : ""}` };
}
