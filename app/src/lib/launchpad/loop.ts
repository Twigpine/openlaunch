import "server-only";
import { pollAll } from "./indexer";
import { recheckProfiles } from "@/lib/profiles/server";
import { computePointsIfDue } from "@/lib/points/server";

/** In-process launchpad poller (same shape as src/lib/syncLoop.ts). */
const DEFAULT_MS = 15_000;
type G = typeof globalThis & { __launchSyncLoop?: NodeJS.Timeout };

/** Start the in-process sync loop once per process: indexing every interval, plus the profile post re-check. */
export function startLaunchSyncLoop(): boolean {
  const g = globalThis as G;
  if (g.__launchSyncLoop) return false;
  const n = Number(process.env.LAUNCH_SYNC_INTERVAL_MS);
  const interval = Number.isFinite(n) && n >= 5_000 ? Math.trunc(n) : DEFAULT_MS;
  let warned = false;
  const tick = async () => {
    try {
      const all = await pollAll();
      for (const [chain, r] of Object.entries(all)) {
        if (r.status === "synced" && ((r.launches ?? 0) > 0 || (r.swaps ?? 0) > 0 || (r.fees ?? 0) > 0)) {
          console.log(`[launch-sync:${chain}] launches=${r.launches} swaps=${r.swaps} fees=${r.fees} to=${r.to} head=${r.head} caught_up=${r.caught_up}`);
        } else if (r.status === "skipped" && !warned) {
          warned = true;
          console.warn(`[launch-sync:${chain}] skipped: ${r.reason}`);
        }
      }
    } catch (err) {
      console.error("[launch-sync] error:", err instanceof Error ? err.message : err);
    }
    // verified X posts are re-read about weekly, a small batch every ten minutes (self-throttled)
    await recheckProfiles().catch((err) => console.warn("[profiles] recheck:", err instanceof Error ? err.message : err));
    // season points: recomputed hourly from the index, one machine at a time (self-throttled); not awaited, so a
    // long compute never holds up indexing
    void computePointsIfDue().catch((err) => console.warn("[points] compute:", err instanceof Error ? err.message : err));
  };
  const timer = setInterval(() => void tick(), interval);
  timer.unref();
  g.__launchSyncLoop = timer;
  const first = setTimeout(() => void tick(), 3_000);
  first.unref();
  console.log(`[launch-sync] started interval=${interval}ms`);
  return true;
}
