import "server-only";
import { keccak256, type Address, type Hex } from "viem";
import { publicClient } from "@/lib/chain";
import { chainIdOf, type ChainKey } from "@/lib/chainPublic";
import { maybeDb } from "@/lib/db";
import { STATE_VIEW_ABI } from "./abi";
import { coreQuotes, launchpad, quoteInfo as staticQuoteInfo } from "./config";
import { ethUsd } from "./ethPrice";
import { gitlawbUsd } from "./gitlawbServer";
import { twapTick } from "./gitlawb";
import { gitlawbLinkedUsd } from "./twig";
import { poolIdOf, quotePerToken } from "./math";
import { PAIR_MIN_SAMPLED_S, PAIR_TWAP_WINDOW_S, guardedPairPrice, pairPriceFromSqrt, pairPriceFromTick, sortsBelow, timeWeightedPrice, twapSpan, type PairPriceKind } from "./pairs";

/**
 * A community pair's USD price, server-side (pairs.ts states the rule): its price pool's spot against that pool's
 * 30-minute average, then times the USD price of the core quote on the pool's other side. Never throws to a caller
 * that only wants a number: `readPairUsd` reports what failed instead.
 */
export type PairPriceSource = { chain: ChainKey; address: string; decimals: number; price_kind: PairPriceKind; price_pool: string; price_quote: string };
export type PairPriceReading = { usd: number | null; spot: number | null; twap: number | null; source: "spot" | "twap" | null; deviation: number | null; error?: string };

const READ_TIMEOUT_MS = 6_000;
const withTimeout = <T,>(p: Promise<T>, what: string): Promise<T> =>
  Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${what}: timeout after ${READ_TIMEOUT_MS}ms`)), READ_TIMEOUT_MS).unref?.())]);

/** The core quotes a pair's pool may be priced against, and their USD price now; null for anything else. */
export async function coreQuoteUsd(chain: ChainKey, quote: string): Promise<{ usd: number | null; decimals: number } | null> {
  const q = staticQuoteInfo(chain, quote);
  if (q.key === "eth") return { usd: await ethUsd(), decimals: q.decimals };
  if (q.key === "usdc" || q.key === "usdg") return { usd: q.usd, decimals: q.decimals };
  if (q.key === "gitlawb" || q.key === "twig") return { usd: gitlawbLinkedUsd(q.key, await gitlawbUsd()) ?? null, decimals: q.decimals };
  return null;
}
export function isCoreQuote(chain: ChainKey, quote: string): boolean {
  return coreQuotes(chain).some((q) => q.address.toLowerCase() === quote.toLowerCase());
}

const V3_ABI = [
  // the first two fields only: Uniswap v3 returns seven, Aerodrome Slipstream six; both start with these
  { type: "function", name: "slot0", stateMutability: "view", inputs: [], outputs: [{ name: "sqrtPriceX96", type: "uint160" }, { name: "tick", type: "int24" }] },
  { type: "function", name: "observe", stateMutability: "view", inputs: [{ name: "secondsAgos", type: "uint32[]" }], outputs: [{ name: "tickCumulatives", type: "int56[]" }, { name: "secondsPerLiquidityCumulativeX128s", type: "uint160[]" }] },
  { type: "function", name: "token0", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "token1", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
] as const;

type Leg = { spot: number | null; twap: number | null };

/** Our own pool: the launch row's spot, and the time-weighted price of its indexed swaps (MUSEWORLD's rule since PR 58). */
async function launchLeg(src: PairPriceSource, quoteDecimals: number): Promise<Leg> {
  const db = maybeDb();
  if (!db) throw new Error("db unconfigured");
  const cid = chainIdOf(src.chain);
  const token = src.price_pool.toLowerCase();
  const now = Math.floor(Date.now() / 1000);
  const from = now - PAIR_TWAP_WINDOW_S;
  const [launch, before, recent] = await Promise.all([
    db<{ quote: string; sqrt_price_x96: string | null }[]>`SELECT quote, sqrt_price_x96 FROM bb_launches WHERE chain_id = ${cid} AND token = ${token}`,
    db<{ sqrt_price_x96: string }[]>`
      SELECT sqrt_price_x96 FROM bb_launch_swaps WHERE chain_id = ${cid} AND token = ${token} AND block_time < to_timestamp(${from})
       ORDER BY block_number DESC, log_index DESC LIMIT 1`,
    db<{ t: number; sqrt_price_x96: string }[]>`
      SELECT extract(epoch FROM block_time)::int AS t, sqrt_price_x96 FROM bb_launch_swaps
       WHERE chain_id = ${cid} AND token = ${token} AND block_time >= to_timestamp(${from})
       ORDER BY block_number, log_index LIMIT 5000`,
  ]);
  const row = launch[0];
  if (!row?.sqrt_price_x96) throw new Error("its openlaunch pool is not indexed");
  if (row.quote !== src.price_quote.toLowerCase()) throw new Error("its openlaunch pool is quoted in another token");
  const at = (sqrt: string) => quotePerToken(BigInt(sqrt), quoteDecimals); // launched tokens are 18-dec and sort above their quote
  const spot = at(row.sqrt_price_x96);
  const baseline = before[0] ? at(before[0].sqrt_price_x96) : null;
  // a pool with no swap in the window and none before it: the spot has held since the pool opened
  const twap = timeWeightedPrice(recent.map((r) => ({ t: Number(r.t), price: at(r.sqrt_price_x96) })), baseline ?? (recent.length === 0 ? spot : null), from, now);
  return { spot: spot > 0 ? spot : null, twap };
}

/** A Uniswap v3 or Slipstream pool: slot0 for the spot, the pool's own oracle for the average (no oracle history, no price). */
async function univ3Leg(src: PairPriceSource, quoteDecimals: number): Promise<Leg> {
  const client = publicClient(src.chain);
  const pool = src.price_pool as Address;
  const pairIsToken0 = sortsBelow(src.address, src.price_quote);
  const [slot0, observed] = await Promise.all([
    withTimeout(client.readContract({ address: pool, abi: V3_ABI, functionName: "slot0" }), "slot0"),
    withTimeout(client.readContract({ address: pool, abi: V3_ABI, functionName: "observe", args: [[PAIR_TWAP_WINDOW_S, 0]] }), "observe").catch(() => null),
  ]);
  const spot = pairPriceFromSqrt(slot0[0], pairIsToken0, src.decimals, quoteDecimals);
  const cums = observed?.[0];
  const twap = cums && cums.length === 2 ? pairPriceFromTick(twapTick(cums[0], cums[1], PAIR_TWAP_WINDOW_S), pairIsToken0, src.decimals, quoteDecimals) : null;
  return { spot, twap };
}

/** A hookless v4 pool's spot (StateView), from the chain. */
async function univ4Spot(src: PairPriceSource, quoteDecimals: number): Promise<number | null> {
  const r = await withTimeout(publicClient(src.chain).readContract({ address: launchpad(src.chain).v4.stateView, abi: STATE_VIEW_ABI, functionName: "getSlot0", args: [src.price_pool as Hex] }), "getSlot0");
  const sqrt = r[0] as bigint;
  if (sqrt === 0n) throw new Error("its v4 pool is not initialized");
  return pairPriceFromSqrt(sqrt, sortsBelow(src.address, src.price_quote), src.decimals, quoteDecimals);
}
/** v4 keeps no oracle: the average comes from our own minute samples (bb_pair_prices), and needs 20 minutes of them. */
async function univ4Leg(src: PairPriceSource, quoteDecimals: number): Promise<Leg> {
  const db = maybeDb();
  const spot = await univ4Spot(src, quoteDecimals);
  if (!db) return { spot, twap: null };
  const cid = chainIdOf(src.chain);
  const a = src.address.toLowerCase();
  const now = Math.floor(Date.now() / 1000);
  const from = now - PAIR_TWAP_WINDOW_S;
  const [before, recent] = await Promise.all([
    db<{ price: number }[]>`SELECT price FROM bb_pair_prices WHERE chain_id = ${cid} AND address = ${a} AND t < to_timestamp(${from}) AND t >= to_timestamp(${from - 300}) ORDER BY t DESC LIMIT 1`,
    db<{ t: number; price: number }[]>`SELECT extract(epoch FROM t)::int AS t, price FROM bb_pair_prices WHERE chain_id = ${cid} AND address = ${a} AND t >= to_timestamp(${from}) ORDER BY t`,
  ]);
  const avg = twapSpan(recent.map((r) => ({ t: Number(r.t), price: Number(r.price) })), before[0] ? Number(before[0].price) : null, from, now);
  return { spot, twap: avg && avg.span >= PAIR_MIN_SAMPLED_S ? avg.price : null };
}

/** The pool leg alone (quote units per pair token, spot and average); throws when the pool cannot be read. */
export async function readPairLeg(src: PairPriceSource): Promise<Leg> {
  const quote = staticQuoteInfo(src.chain, src.price_quote);
  if (src.price_kind === "launch") return launchLeg(src, quote.decimals);
  if (src.price_kind === "univ3") return univ3Leg(src, quote.decimals);
  return univ4Leg(src, quote.decimals);
}

/** USD per whole pair token now, with what went into it. Never throws. */
export async function readPairUsd(src: PairPriceSource): Promise<PairPriceReading> {
  try {
    const core = await coreQuoteUsd(src.chain, src.price_quote);
    if (!core) return { usd: null, spot: null, twap: null, source: null, deviation: null, error: "its pool is not priced against a core quote" };
    const leg = await readPairLeg(src);
    const g = guardedPairPrice(leg.spot, leg.twap);
    if (g.source === "twap" && g.deviation !== null) console.warn(`[pairs] ${src.address}: pool spot is ${Math.round(g.deviation * 100)}% off its 30m average; publishing the average`);
    const usd = g.price !== null && core.usd !== null && core.usd > 0 ? g.price * core.usd : null;
    const error = usd !== null ? undefined : leg.twap === null ? "no 30-minute average from its pool yet" : core.usd === null ? "its core quote has no price right now" : "its pool gave no price";
    return { usd, spot: leg.spot, twap: leg.twap, source: g.source, deviation: g.deviation, ...(error ? { error } : {}) };
  } catch (e) {
    return { usd: null, spot: null, twap: null, source: null, deviation: null, error: e instanceof Error ? e.message : String(e) };
  }
}

/** One minute sample of a v4 price pool (both machines may write it: one row per minute). */
export async function samplePairSpot(src: PairPriceSource): Promise<boolean> {
  const db = maybeDb();
  if (!db || src.price_kind !== "univ4") return false;
  const spot = await univ4Spot(src, staticQuoteInfo(src.chain, src.price_quote).decimals);
  if (spot === null) return false;
  await db`INSERT INTO bb_pair_prices (chain_id, address, t, price) VALUES (${chainIdOf(src.chain)}, ${src.address.toLowerCase()}, date_trunc('minute', now()), ${spot}) ON CONFLICT DO NOTHING`;
  return true;
}

/** keccak256 of the runtime code at an address (null = no code: not a contract, or gone). */
export async function codeHashOf(chain: ChainKey, address: string): Promise<string | null> {
  const code = await withTimeout(publicClient(chain).getCode({ address: address as Address }), "getCode");
  return code && code !== "0x" ? keccak256(code) : null;
}

/** For a v3 listing: the pool's two tokens, to check they are the pair and its quote. */
export async function univ3Tokens(chain: ChainKey, pool: string): Promise<[string, string]> {
  const client = publicClient(chain);
  const [t0, t1] = await Promise.all([
    withTimeout(client.readContract({ address: pool as Address, abi: V3_ABI, functionName: "token0" }), "token0"),
    withTimeout(client.readContract({ address: pool as Address, abi: V3_ABI, functionName: "token1" }), "token1"),
  ]);
  return [t0.toLowerCase(), t1.toLowerCase()];
}

const POOL_KEYS_ABI = [
  { type: "function", name: "poolKeys", stateMutability: "view", inputs: [{ name: "poolId", type: "bytes25" }], outputs: [{ name: "currency0", type: "address" }, { name: "currency1", type: "address" }, { name: "fee", type: "uint24" }, { name: "tickSpacing", type: "int24" }, { name: "hooks", type: "address" }] },
] as const;
/**
 * For a v4 listing: the pool's key, from the v4 PositionManager (it records the key of every pool a position was minted
 * in through it, by the id's first 25 bytes). null when it does not know the pool.
 */
export async function univ4Key(chain: ChainKey, poolId: string): Promise<{ currency0: string; currency1: string; hooks: string } | null> {
  const r = await withTimeout(publicClient(chain).readContract({ address: launchpad(chain).v4.positionManager, abi: POOL_KEYS_ABI, functionName: "poolKeys", args: [poolId.slice(0, 52) as Hex] }), "poolKeys");
  if (r[0] === r[1]) return null; // an unknown id reads as the empty key
  const k = { currency0: r[0].toLowerCase(), currency1: r[1].toLowerCase(), hooks: r[4].toLowerCase() };
  // the key must hash back to the whole id (the lookup only used its first 25 bytes)
  return poolIdOf({ currency0: r[0], currency1: r[1], fee: Number(r[2]), tickSpacing: Number(r[3]), hooks: r[4] }).toLowerCase() === poolId.toLowerCase() ? k : null;
}

/** GeckoTerminal's liquidity figure for a pool (USD), or null when it cannot say. Advisory: the monitor's liquidity line only. */
export async function poolLiquidityUsd(chain: ChainKey, poolId: string, request: typeof fetch = fetch): Promise<number | null> {
  try {
    const res = await request(`https://api.geckoterminal.com/api/v2/networks/${chain}/pools/${encodeURIComponent(poolId.toLowerCase())}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(5_000) });
    if (!res.ok) return null;
    const body = (await res.json()) as { data?: { attributes?: { reserve_in_usd?: string | null } } };
    const v = Number(body.data?.attributes?.reserve_in_usd);
    return Number.isFinite(v) && v >= 0 ? v : null;
  } catch {
    return null;
  }
}
