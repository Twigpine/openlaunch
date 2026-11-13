import "server-only";
import { publicClient } from "@/lib/chain";
import { STATE_VIEW_ABI } from "./abi";
import { launchpad } from "./config";
import { ethUsd } from "./ethPrice";
import { GITLAWB_POOL_ID, GITLAWB_V3_POOL, TWAP_WINDOW_S, gitlawbUsdFromSqrtPrice, gitlawbUsdFromTick, reconcileGitlawbUsd, twapTick } from "./gitlawb";

/**
 * USD per GITLAWB, server-side. Two on-chain readings, one ETH/USD:
 *   - spot: StateView.getSlot0 on the Uniswap v4 WETH/GITLAWB pool (the deep market)
 *   - TWAP: observe([1800, 0]) on the Uniswap v3 WETH/GITLAWB pool (30-minute time-weighted average)
 * The spot is published unless it strays >25% from the TWAP, in which case the TWAP is published: a
 * single-block push of the v4 price cannot rewrite market caps, USD volume or trending scores. When
 * only one side reads, that side is used (logged when it is the unguarded spot).
 *
 * Stale-while-revalidate so it never sits on a request's critical path once warm: a fresh value is
 * served for 60s; after that the cached value is returned immediately and ONE refresh runs in the
 * background. Only a cold process (no value yet) awaits the read, capped at 4s. Failures keep the last
 * good price for up to 15 minutes; after that GITLAWB pools simply show no USD (and rank with 0 weight
 * in USD sorts) until a read succeeds. Never throws.
 */
let usdNow: number | null = null;
/** The two readings behind usdNow (USD per GITLAWB): the v4 spot and the v3 30-minute average, for prices that want the lower one. */
let partsNow: { spot: number | null; twap: number | null } = { spot: null, twap: null };
let goodAt = 0; // when usdNow was last read successfully
let refreshedAt = 0; // when the last refresh attempt finished
let inflight: Promise<void> | null = null;
const FRESH_MS = 60_000;
const MAX_STALE_MS = 15 * 60_000;
const COLD_WAIT_MS = 4_000;
const READ_TIMEOUT_MS = 8_000;

const V3_OBSERVE_ABI = [
  { type: "function", name: "observe", stateMutability: "view", inputs: [{ name: "secondsAgos", type: "uint32[]" }], outputs: [{ name: "tickCumulatives", type: "int56[]" }, { name: "secondsPerLiquidityCumulativeX128s", type: "uint160[]" }] },
] as const;

async function read(): Promise<number | null> {
  const client = publicClient("base");
  const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`timeout after ${READ_TIMEOUT_MS}ms`)), READ_TIMEOUT_MS).unref?.());
  const [eth, slot0, observed] = await Promise.race([
    Promise.all([
      ethUsd(),
      client.readContract({ address: launchpad("base").v4.stateView, abi: STATE_VIEW_ABI, functionName: "getSlot0", args: [GITLAWB_POOL_ID] }).then((r) => r[0] as bigint, () => null),
      client.readContract({ address: GITLAWB_V3_POOL, abi: V3_OBSERVE_ABI, functionName: "observe", args: [[TWAP_WINDOW_S, 0]] }).then((r) => r[0] as readonly bigint[], () => null),
    ]),
    timeout,
  ]);
  const spot = slot0 === null ? null : gitlawbUsdFromSqrtPrice(slot0, eth);
  const twap = observed === null || observed.length < 2 ? null : gitlawbUsdFromTick(twapTick(observed[0], observed[1], TWAP_WINDOW_S), eth);
  const { usd, source, deviation } = reconcileGitlawbUsd(spot, twap);
  if (usd !== null) partsNow = { spot, twap };
  if (source === "twap" && spot !== null) console.warn(`[gitlawb] v4 spot $${spot} is ${Math.round((deviation ?? 0) * 100)}% off the 30m v3 TWAP $${twap}; publishing the TWAP`);
  else if (source === "spot" && twap === null) console.warn("[gitlawb] v3 TWAP unavailable; publishing the unguarded v4 spot");
  return usd;
}

function refresh(): Promise<void> {
  return (inflight ??= read()
    .then((usd) => {
      if (usd !== null) {
        usdNow = usd;
        goodAt = Date.now();
      }
    })
    .catch((err) => console.warn("[gitlawb] price read failed:", err instanceof Error ? err.message : err))
    .finally(() => {
      refreshedAt = Date.now();
      inflight = null;
    }));
}

/**
 * GITLAWB's spot and 30-minute average separately (USD), from the same reads as gitlawbUsd. For a fee that must not shrink
 * when the price is pushed for a moment, the caller takes the lower one. Both null when nothing fresh was read.
 */
export async function gitlawbUsdParts(): Promise<{ spot: number | null; twap: number | null }> {
  const usd = await gitlawbUsd();
  return usd === null ? { spot: null, twap: null } : partsNow;
}

export async function gitlawbUsd(): Promise<number | null> {
  const now = Date.now();
  if (now - refreshedAt >= FRESH_MS) {
    const p = refresh();
    // cold start: nothing to serve yet → wait briefly for the first read (bounded)
    if (goodAt === 0) await Promise.race([p, new Promise<void>((r) => setTimeout(r, COLD_WAIT_MS).unref?.())]);
  }
  return goodAt > 0 && Date.now() - goodAt <= MAX_STALE_MS ? usdNow : null;
}
