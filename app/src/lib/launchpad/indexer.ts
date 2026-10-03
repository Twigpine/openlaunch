import "server-only";
import { parseEventLogs, type Address, type Hex, type Log } from "viem";
import { publicClient } from "@/lib/chain";
import { chainIdOf, type ChainKey } from "@/lib/chainPublic";
import { maybeDb, errMessage, type Db } from "@/lib/db";
import { LAUNCH_FACTORY_ABI, LAUNCH_LOCKER_ABI, POOL_MANAGER_ABI, ERC20_MIN_ABI, ERC20_TRANSFER_EVENT, LAUNCHED_EVENT, POOL_SWAP_EVENT, LOCKER_EVENTS } from "./abi";
import { CONFIGURED_CHAINS, launchpad, listedQuoteAddresses } from "./config";
import { validDecimals } from "./unlisted-quote";
import { DEAD_ADDR, ZERO_ADDR } from "./holders";
import { SYNC_CHUNK_BLOCKS, SYNC_MAX_CHUNKS_PER_CALL, syncOverlapBlocks } from "@/lib/config";
import { fetchLogsSplit, isRangeTooLarge } from "./log-range";
import { redactUrls } from "./redact";

/**
 * Launchpad chain → Postgres indexer.
 *
 *   receipt  applyLaunchTx(hash)  — POST /api/launch/sync?tx= right after a wallet returns
 *   poller   pollLaunches()       — every LAUNCH_SYNC_INTERVAL_MS from src/lib/launchpad/loop.ts
 *
 * One apply path for both. Sources:
 *   LaunchFactory.Launched                → bb_launches (+ name/symbol read from the token)
 *   PoolManager.Swap (id ∈ our pool ids)  → bb_launch_swaps + rolling price / volume on bb_launches
 *   LaunchLocker.Collected/Burned/Credited/Claimed → bb_launch_fee_events + fee totals
 * Everything is idempotent on (tx_hash, log_index).
 */
export type LaunchSyncResult = {
  status: "synced" | "skipped";
  reason?: string;
  from?: string;
  to?: string;
  head?: string;
  launches?: number;
  swaps?: number;
  fees?: number;
  caught_up?: boolean;
};

const DEPLOY_BLOCK_ENV: Record<ChainKey, () => string | undefined> = {
  base: () => process.env.LAUNCH_DEPLOY_BLOCK,
  robinhood: () => process.env.LAUNCH_DEPLOY_BLOCK_ROBINHOOD,
  arc: () => process.env.LAUNCH_DEPLOY_BLOCK_ARC,
};

export function launchDeployBlock(chain: ChainKey): bigint {
  const raw = (DEPLOY_BLOCK_ENV[chain]() ?? "").trim();
  return /^\d+$/.test(raw) ? BigInt(raw) : 0n;
}
/** Blocks left behind the head before a range is indexed. Arc finalizes every block (no reorgs), so none there. */
const DEFAULT_CONFIRMATIONS: Record<ChainKey, number> = { base: 2, robinhood: 2, arc: 0 };
/**
 * LAUNCH_SYNC_CONFIRMATIONS_<CHAIN> overrides one chain. LAUNCH_SYNC_CONFIRMATIONS overrides the chains that need a reorg
 * margin at all; a chain whose default is 0 finalizes every block and keeps 0 regardless of the global setting.
 */
function confirmations(chain: ChainKey): bigint {
  const fallback = DEFAULT_CONFIRMATIONS[chain];
  const env = (k: string) => process.env[k]?.trim() || undefined; // a blank value is unset, not 0
  const raw = Number(env(`LAUNCH_SYNC_CONFIRMATIONS_${chain.toUpperCase()}`) ?? (fallback === 0 ? 0 : (env("LAUNCH_SYNC_CONFIRMATIONS") ?? fallback)));
  return BigInt(Number.isFinite(raw) && raw >= 0 ? Math.trunc(raw) : fallback);
}

function skipReason(chain: ChainKey): string | null {
  if (!maybeDb()) return "db_unconfigured";
  if (!launchpad(chain).configured) return "launchpad_unconfigured";
  if (launchDeployBlock(chain) === 0n) return "deploy_block_unset";
  return null;
}

// ── caches (per process; cheap) ──────────────────────────────────────────────
const blockTime = new Map<string, string>();
async function timeOf(chain: ChainKey, block: bigint): Promise<string> {
  const k = `${chain}:${block}`;
  const hit = blockTime.get(k);
  if (hit) return hit;
  const b = await publicClient(chain).getBlock({ blockNumber: block });
  const iso = new Date(Number(b.timestamp) * 1000).toISOString();
  if (blockTime.size > 5000) blockTime.clear();
  blockTime.set(k, iso);
  return iso;
}
const txFrom = new Map<string, string>();
/** Transaction sender, lower-cased. Null when the RPC fails twice; the swap is then stored without a trader and `healSwapTraders` retries later. */
async function fromOf(chain: ChainKey, hash: Hex): Promise<string | null> {
  const k = `${chain}:${hash}`;
  const hit = txFrom.get(k);
  if (hit) return hit;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const tx = await publicClient(chain).getTransaction({ hash });
      const f = tx.from.toLowerCase();
      if (txFrom.size > 5000) txFrom.clear();
      txFrom.set(k, f);
      return f;
    } catch {
      // a busy launch block can rate-limit the node; one more try before giving up
    }
  }
  return null;
}

// ── apply ────────────────────────────────────────────────────────────────────
type Launched = { token: Address; tokenId: bigint; launcher: Address; quote: Address; poolId: Hex; startTick: number; lpFee: number; supply: bigint; metadataURI: string };

async function applyLaunched(db: Db, chain: ChainKey, log: Log & { args: Launched }): Promise<boolean> {
  const a = log.args;
  const token = a.token.toLowerCase();
  const client = publicClient(chain);
  const locker = launchpad(chain).locker!;
  const [name, symbol, recipients] = await Promise.all([
    client.readContract({ address: a.token, abi: ERC20_MIN_ABI, functionName: "name" }).catch(() => "?"),
    client.readContract({ address: a.token, abi: ERC20_MIN_ABI, functionName: "symbol" }).catch(() => "?"),
    client
      .readContract({ address: locker, abi: LAUNCH_LOCKER_ABI, functionName: "recipientsOf", args: [a.tokenId] })
      .then((r) => r.map((x) => ({ payout: x.payout.toLowerCase(), bps: Number(x.bps) })))
      .catch(() => [] as { payout: string; bps: number }[]),
  ]);
  const time = await timeOf(chain, log.blockNumber!);
  const rows = await db`
    INSERT INTO bb_launches (chain_id, token, token_id, launcher, quote, pool_id, start_tick, lp_fee, supply, metadata_uri, name, symbol,
                             block_number, block_time, tx_hash, log_index, tick, recipients)
    VALUES (${chainIdOf(chain)}, ${token}, ${a.tokenId}, ${a.launcher.toLowerCase()}, ${a.quote.toLowerCase()}, ${a.poolId.toLowerCase()}, ${a.startTick}, ${a.lpFee},
            ${a.supply.toString()}, ${a.metadataURI}, ${name.slice(0, 64)}, ${symbol.slice(0, 16)},
            ${log.blockNumber!}, ${time}, ${log.transactionHash!.toLowerCase()}, ${log.logIndex!}, ${a.startTick}, ${db.json(recipients)})
    ON CONFLICT (chain_id, token) DO NOTHING
    RETURNING token`;
  return rows.length > 0;
}

type Swap = { id: Hex; sender: Address; amount0: bigint; amount1: bigint; sqrtPriceX96: bigint; liquidity: bigint; tick: number; fee: number };

async function applySwap(db: Db, chain: ChainKey, log: Log & { args: Swap }, poolToToken: Map<string, string>): Promise<boolean> {
  const a = log.args;
  const poolId = a.id.toLowerCase();
  const token = poolToToken.get(poolId);
  if (!token) return false;
  const cid = chainIdOf(chain);
  const isBuy = a.amount0 < 0n; // swapper paid quote (currency0)
  const absQuote = a.amount0 < 0n ? -a.amount0 : a.amount0;
  const [time, trader] = await Promise.all([timeOf(chain, log.blockNumber!), fromOf(chain, log.transactionHash!)]);
  const bn = log.blockNumber!;
  const li = log.logIndex!;
  // One transaction: the swap row and the launch totals commit together or not at all (a failure between
  // the two used to leave a recorded trade whose totals were never applied — and the dedupe then skips it).
  return db.begin(async (tx) => {
    const t = tx as unknown as Db;
    const inserted = await t`
    INSERT INTO bb_launch_swaps (chain_id, tx_hash, log_index, token, pool_id, trader, amount0, amount1, sqrt_price_x96, tick, is_buy, block_number, block_time)
    VALUES (${cid}, ${log.transactionHash!.toLowerCase()}, ${log.logIndex!}, ${token}, ${poolId}, ${trader}, ${a.amount0.toString()}, ${a.amount1.toString()},
            ${a.sqrtPriceX96.toString()}, ${a.tick}, ${isBuy}, ${log.blockNumber!}, ${time})
    ON CONFLICT DO NOTHING
    RETURNING tx_hash`;
    if (inserted.length === 0) return false;
    await t`
    UPDATE bb_launches SET
      volume_quote = volume_quote + ${absQuote.toString()}::numeric,
      buys = buys + ${isBuy ? 1 : 0},
      sells = sells + ${isBuy ? 0 : 1},
      last_trade_at = GREATEST(COALESCE(last_trade_at, ${time}::timestamptz), ${time}::timestamptz),
      sqrt_price_x96 = CASE WHEN (${bn}::bigint, ${li}::int) > (last_swap_block, last_swap_log) THEN ${a.sqrtPriceX96.toString()}::numeric ELSE sqrt_price_x96 END,
      tick           = CASE WHEN (${bn}::bigint, ${li}::int) > (last_swap_block, last_swap_log) THEN ${a.tick} ELSE tick END,
      last_swap_log  = CASE WHEN (${bn}::bigint, ${li}::int) > (last_swap_block, last_swap_log) THEN ${li} ELSE last_swap_log END,
      last_swap_block= CASE WHEN (${bn}::bigint, ${li}::int) > (last_swap_block, last_swap_log) THEN ${bn} ELSE last_swap_block END
    WHERE chain_id = ${cid} AND token = ${token}`;
    return true;
  }) as Promise<boolean>;
}

type FeeLog = Log &
  (
    | { eventName: "Collected"; args: { tokenId: bigint; token: Address; quoteAmount: bigint; tokenAmount: bigint } }
    | { eventName: "Burned"; args: { tokenId: bigint; currency: Address; amount: bigint } }
    | { eventName: "Paid"; args: { tokenId: bigint; account: Address; currency: Address; amount: bigint } }
    | { eventName: "Credited" | "Claimed"; args: { account: Address; currency: Address; amount: bigint } }
  );

async function applyFee(pool: Db, chain: ChainKey, log: FeeLog, tokenIdToToken: Map<string, { token: string; quote: string }>): Promise<boolean> {
  const cid = chainIdOf(chain);
  const time = await timeOf(chain, log.blockNumber!);
  // event row + launch fee totals in one transaction (same reasoning as applySwap)
  return pool.begin(async (tx) => applyFeeIn(tx as unknown as Db, chain, cid, time, log, tokenIdToToken)) as Promise<boolean>;
}

async function applyFeeIn(db: Db, chain: ChainKey, cid: number, time: string, log: FeeLog, tokenIdToToken: Map<string, { token: string; quote: string }>): Promise<boolean> {
  const tx = log.transactionHash!.toLowerCase();
  const li = log.logIndex!;
  const bn = log.blockNumber!;
  if (log.eventName === "Collected") {
    const t = log.args.token.toLowerCase();
    const r = await db`
      INSERT INTO bb_launch_fee_events (chain_id, tx_hash, log_index, kind, token_id, token, quote_amount, token_amount, block_number, block_time)
      VALUES (${cid}, ${tx}, ${li}, 'collected', ${log.args.tokenId}, ${t}, ${log.args.quoteAmount.toString()}, ${log.args.tokenAmount.toString()}, ${bn}, ${time})
      ON CONFLICT DO NOTHING RETURNING tx_hash`;
    if (r.length === 0) return false;
    await db`UPDATE bb_launches SET fees_quote_collected = fees_quote_collected + ${log.args.quoteAmount.toString()}::numeric,
                                    fees_token_collected = fees_token_collected + ${log.args.tokenAmount.toString()}::numeric WHERE chain_id = ${cid} AND token = ${t}`;
    return true;
  }
  if (log.eventName === "Burned") {
    const info = tokenIdToToken.get(log.args.tokenId.toString());
    // Unknown position = the launch itself is not indexed yet (receipt path racing the poller). Inserting now would
    // pin the row with token NULL and skip the launch totals for good (the poller's later pass hits ON CONFLICT and
    // the rebuild script joins on token), so leave it for the poller, which indexes the launch first.
    if (!info) return false;
    const cur = log.args.currency.toLowerCase();
    const r = await db`
      INSERT INTO bb_launch_fee_events (chain_id, tx_hash, log_index, kind, token_id, token, currency, amount, block_number, block_time)
      VALUES (${cid}, ${tx}, ${li}, 'burned', ${log.args.tokenId}, ${info.token}, ${cur}, ${log.args.amount.toString()}, ${bn}, ${time})
      ON CONFLICT DO NOTHING RETURNING tx_hash`;
    if (r.length === 0) return false;
    if (cur === info.quote) await db`UPDATE bb_launches SET fees_quote_burned = fees_quote_burned + ${log.args.amount.toString()}::numeric WHERE chain_id = ${cid} AND token = ${info.token}`;
    else await db`UPDATE bb_launches SET fees_token_burned = fees_token_burned + ${log.args.amount.toString()}::numeric WHERE chain_id = ${cid} AND token = ${info.token}`;
    return true;
  }
  if (log.eventName === "Paid") {
    const info = tokenIdToToken.get(log.args.tokenId.toString());
    if (!info) return false; // same as Burned: the poller fills it in once the launch is indexed
    const r = await db`
      INSERT INTO bb_launch_fee_events (chain_id, tx_hash, log_index, kind, token_id, token, currency, account, amount, block_number, block_time)
      VALUES (${cid}, ${tx}, ${li}, 'paid', ${log.args.tokenId}, ${info.token}, ${log.args.currency.toLowerCase()}, ${log.args.account.toLowerCase()}, ${log.args.amount.toString()}, ${bn}, ${time})
      ON CONFLICT DO NOTHING RETURNING tx_hash`;
    return r.length > 0;
  }
  const r = await db`
    INSERT INTO bb_launch_fee_events (chain_id, tx_hash, log_index, kind, currency, account, amount, block_number, block_time)
    VALUES (${cid}, ${tx}, ${li}, ${log.eventName === "Credited" ? "credited" : "claimed"}, ${log.args.currency.toLowerCase()}, ${log.args.account.toLowerCase()}, ${log.args.amount.toString()}, ${bn}, ${time})
    ON CONFLICT DO NOTHING RETURNING tx_hash`;
  return r.length > 0;
}

async function poolMaps(db: Db, chain: ChainKey): Promise<{ poolToToken: Map<string, string>; tokenIdToToken: Map<string, { token: string; quote: string }> }> {
  const rows = await db<{ token: string; pool_id: string; token_id: bigint; quote: string }[]>`SELECT token, pool_id, token_id, quote FROM bb_launches WHERE chain_id = ${chainIdOf(chain)}`;
  const poolToToken = new Map<string, string>();
  const tokenIdToToken = new Map<string, { token: string; quote: string }>();
  for (const r of rows) {
    poolToToken.set(r.pool_id, r.token);
    tokenIdToToken.set(r.token_id.toString(), { token: r.token, quote: r.quote });
  }
  return { poolToToken, tokenIdToToken };
}

/** Apply every launchpad-relevant log in one range. Launched first so same-range swaps resolve. */
async function applyRange(db: Db, chain: ChainKey, from: bigint, to: bigint): Promise<{ launches: number; swaps: number; fees: number }> {
  const client = publicClient(chain);
  const cfg = launchpad(chain);
  const factory = cfg.factory!;
  const locker = cfg.locker!;
  const pm = cfg.v4.poolManager;
  let launches = 0;
  let swaps = 0;
  let fees = 0;

  // every range goes through fetchLogsSplit: a node that caps results per call (Arc: 2000) gets the range halved until it answers
  const launchedLogs = await fetchLogsSplit((f, t) => client.getLogs({ address: factory, event: LAUNCHED_EVENT, fromBlock: f, toBlock: t }), from, to);
  for (const l of launchedLogs) if (await applyLaunched(db, chain, l as Log & { args: Launched })) launches++;

  const { poolToToken, tokenIdToToken } = await poolMaps(db, chain);
  if (poolToToken.size > 0) {
    const ids = [...poolToToken.keys()] as Hex[];
    const swapLogs = await fetchLogsSplit((f, t) => client.getLogs({ address: pm, event: POOL_SWAP_EVENT, args: { id: ids }, fromBlock: f, toBlock: t }), from, to);
    for (const l of swapLogs) if (await applySwap(db, chain, l as Log & { args: Swap }, poolToToken)) swaps++;
  }
  const feeLogs = await fetchLogsSplit((f, t) => client.getLogs({ address: locker, events: LOCKER_EVENTS, fromBlock: f, toBlock: t }), from, to);
  for (const l of feeLogs) if (await applyFee(db, chain, l as unknown as FeeLog, tokenIdToToken)) fees++;
  // holder balances: every Transfer of every launched token (idempotent; backfill covers history)
  const tokens = [...new Set([...poolToToken.values()])];
  if (tokens.length > 0) await applyTransfers(db, chain, tokens, from, to);
  return { launches, swaps, fees };
}

// ── holders ──────────────────────────────────────────────────────────────────
type TransferLog = Log & { args: { from: Address; to: Address; value: bigint } };

type RawReceiptLog = { address: string; topics: Hex[]; data: Hex; blockNumber: Hex; transactionHash: Hex; logIndex: Hex; removed?: boolean };

/**
 * A token's Transfer logs in one block, read from the block's receipts (eth_getBlockReceipts is not subject to the
 * per-call result cap that eth_getLogs has on some nodes). Null when the node does not offer the method.
 */
async function transfersFromBlockReceipts(chain: ChainKey, token: string, block: bigint): Promise<TransferLog[] | null> {
  const client = publicClient(chain);
  const want = token.toLowerCase();
  try {
    const receipts: unknown = await client.request({ method: "eth_getBlockReceipts" as never, params: [`0x${block.toString(16)}`] as never });
    // the response is untyped RPC data: anything not shaped like receipts with logs counts as "unavailable", never a throw
    if (!Array.isArray(receipts)) return null;
    const raw: RawReceiptLog[] = [];
    for (const r of receipts) {
      const logs = (r as { logs?: unknown } | null)?.logs;
      if (!Array.isArray(logs)) return null;
      for (const l of logs as Partial<RawReceiptLog>[]) {
        if (typeof l?.address !== "string" || !Array.isArray(l.topics) || typeof l.data !== "string" || typeof l.blockNumber !== "string" || typeof l.transactionHash !== "string" || typeof l.logIndex !== "string") return null;
        if (l.address.toLowerCase() === want && !l.removed) raw.push(l as RawReceiptLog);
      }
    }
    const parsed = parseEventLogs({ abi: [ERC20_TRANSFER_EVENT], eventName: "Transfer", logs: raw.map((l) => ({ ...l, blockNumber: BigInt(l.blockNumber), logIndex: Number(l.logIndex) })) as unknown as Log[] });
    return parsed as unknown as TransferLog[];
  } catch {
    return null;
  }
}
const SYNCED_FOREVER = 9223372036854775807n; // bigint max = "history fully scanned; the live loop keeps it current"

/** System addresses that hold launched tokens on the protocol's behalf (never counted as holders): pool, position manager, locker, factory, plus router/Permit2 which keep swap dust. */
export function systemAddresses(chain: ChainKey): string[] {
  const cfg = launchpad(chain);
  return [cfg.v4.poolManager, cfg.v4.positionManager, cfg.locker!, cfg.factory!, cfg.v4.universalRouter, cfg.v4.permit2].map((a) => a.toLowerCase());
}

/**
 * Ingest Transfer logs for `tokens` in [from, to]: one bulk insert into bb_token_transfers (dedupe: only the
 * rows that were new count), one bulk upsert of aggregated balance deltas into bb_token_holders — rows sorted
 * by (token, holder) so two machines applying the same chunk lock in the same order — then refresh the
 * per-launch `holders` counters for every token touched.
 */
async function applyTransfers(db: Db, chain: ChainKey, tokens: string[], from: bigint, to: bigint): Promise<number> {
  const client = publicClient(chain);
  const cid = chainIdOf(chain);
  // one address list for every launched token, bisected by block like every other fetch; only when a SINGLE block is over
  // the node's result cap does the token list split, and one token still over the cap in one block (a contract spamming
  // Transfer events; a few USDC of gas on Arc) has that block's holder update skipped rather than the chain's indexing
  // wedging on it. Launches, swaps and fees are fetched separately and unaffected. That token's holder balances stay off
  // by that block's transfers (balances are accumulated deltas, so nothing recomputes them), which is why the skip is
  // logged as an alert rather than a warning: it is a deliberate degradation to look at, not a transient.
  const oneBlockOrRange = async (addrs: string[], a: bigint, b: bigint): Promise<TransferLog[]> => {
    try {
      return (await client.getLogs({ address: addrs as Address[], event: ERC20_TRANSFER_EVENT, fromBlock: a, toBlock: b })) as TransferLog[];
    } catch (err) {
      if (a !== b || !isRangeTooLarge(err)) throw err; // a range: let fetchLogsSplit halve the blocks
      if (addrs.length <= 1) {
        // one token, one block, over the cap: the block's receipts are not capped, so read the token's Transfer logs from
        // them; only if the node has no receipts method is the block skipped (an alert, since the balances stay off by it)
        const recovered = await transfersFromBlockReceipts(chain, addrs[0], a);
        if (recovered !== null) return recovered;
        console.error(`[alert] launch-sync ${chain}: Transfer logs of ${addrs[0]} in block ${a} exceed the node's result cap and eth_getBlockReceipts is unavailable; that block's holder update for the token is skipped and its holder balances are off by it from now on`);
        return [];
      }
      const mid = Math.ceil(addrs.length / 2);
      return [...(await oneBlockOrRange(addrs.slice(0, mid), a, b)), ...(await oneBlockOrRange(addrs.slice(mid), a, b))];
    }
  };
  const logs = await fetchLogsSplit((a, b) => oneBlockOrRange(tokens, a, b), from, to);
  if (logs.length === 0) return 0;
  const rows = logs.map((l) => ({
    chain_id: cid,
    tx_hash: l.transactionHash!.toLowerCase(),
    log_index: l.logIndex!,
    token: (l.address as string).toLowerCase(),
    from_addr: l.args.from.toLowerCase(),
    to_addr: l.args.to.toLowerCase(),
    value: l.args.value.toString(),
    block_number: Number(l.blockNumber!),
  }));
  // One statement per 500 logs: insert (dedupe) → aggregate deltas of the NEW rows → upsert balances.
  // Atomic by construction: a transfer is never recorded without its balance effect (the earlier two-step
  // version left holes when a statement was aborted by a deadlock).
  const touched = new Set<string>();
  let applied = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const part = rows.slice(i, i + 500);
    const r = await db<{ token: string; n: number }[]>`
      WITH ins AS (
        INSERT INTO bb_token_transfers (chain_id, tx_hash, log_index, token, from_addr, to_addr, value, block_number)
        SELECT ${cid}, u.tx, u.li, u.tok, u.fa, u.ta, u.v::numeric, u.bn
          FROM unnest(${part.map((x) => x.tx_hash)}::text[], ${part.map((x) => x.log_index)}::int[], ${part.map((x) => x.token)}::text[], ${part.map((x) => x.from_addr)}::text[], ${part.map((x) => x.to_addr)}::text[], ${part.map((x) => x.value)}::text[], ${part.map((x) => x.block_number)}::bigint[]) AS u(tx, li, tok, fa, ta, v, bn)
        ON CONFLICT DO NOTHING
        RETURNING token, from_addr, to_addr, value, block_number
      ), legs AS (
        SELECT token, from_addr AS holder, -value AS d, block_number FROM ins WHERE from_addr <> ${ZERO_ADDR}
        UNION ALL
        SELECT token, to_addr, value, block_number FROM ins WHERE to_addr <> ${ZERO_ADDR}
      ), agg AS (
        SELECT token, holder, sum(d) AS d, min(block_number) AS f, max(block_number) AS l FROM legs GROUP BY token, holder ORDER BY token, holder
      ), up AS (
        INSERT INTO bb_token_holders (chain_id, token, holder, balance, first_block, last_block)
        SELECT ${cid}, token, holder, d, f, l FROM agg
        ON CONFLICT (chain_id, token, holder) DO UPDATE
          SET balance = bb_token_holders.balance + EXCLUDED.balance, last_block = GREATEST(bb_token_holders.last_block, EXCLUDED.last_block)
        RETURNING token
      )
      SELECT token, count(*)::int AS n FROM ins GROUP BY token`;
    for (const x of r) {
      touched.add(x.token);
      applied += x.n;
    }
  }
  if (touched.size === 0) return 0;
  await refreshHolderCounts(db, chain, [...touched].sort());
  return applied;
}

async function refreshHolderCounts(db: Db, chain: ChainKey, tokens: string[]): Promise<void> {
  const cid = chainIdOf(chain);
  const excluded = [...systemAddresses(chain), ZERO_ADDR, DEAD_ADDR];
  await db`
    UPDATE bb_launches l SET holders = c.n
      FROM (SELECT h.token, count(*)::int AS n FROM bb_token_holders h
             WHERE h.chain_id = ${cid} AND h.token = ANY(${tokens}) AND h.balance > 0 AND NOT (h.holder = ANY(${excluded}))
             GROUP BY h.token ORDER BY h.token) c
     WHERE l.chain_id = ${cid} AND l.token = c.token`;
  // tokens that now have zero holders still need the counter zeroed
  await db`UPDATE bb_launches SET holders = 0 WHERE chain_id = ${cid} AND token = ANY(${tokens})
             AND NOT EXISTS (SELECT 1 FROM bb_token_holders h WHERE h.chain_id = bb_launches.chain_id AND h.token = bb_launches.token AND h.balance > 0 AND NOT (h.holder = ANY(${excluded})))`;
}

const BACKFILL_TOKENS_PER_CALL = 40;
const BACKFILL_CHUNKS_PER_CALL = 25;

/**
 * Scan Transfer history for launches whose holders are not yet indexed (holders_synced_block NULL or behind
 * the chain cursor), in 2000-block chunks, resumable: after each chunk the batch's holders_synced_block moves
 * forward; when it reaches the cursor the batch is marked SYNCED_FOREVER and the live loop keeps it current.
 * Runs after every poll; costs a bounded number of getLogs calls per run.
 */
export async function backfillHolders(chain: ChainKey): Promise<{ tokens: number; chunks: number; transfers: number } | null> {
  const pool = maybeDb();
  if (!pool || skipReason(chain)) return null;
  // one backfill per chain across all machines: session-level advisory lock on a reserved connection
  const reserved = await pool.reserve();
  const db = reserved as unknown as Db;
  try {
    const [{ ok }] = await db<{ ok: boolean }[]>`SELECT pg_try_advisory_lock(hashtext(${`holders-backfill-${chain}`})) AS ok`;
    if (!ok) return null;
    return await backfillHoldersLocked(db, chain);
  } finally {
    await db`SELECT pg_advisory_unlock(hashtext(${`holders-backfill-${chain}`}))`.catch(() => {});
    reserved.release();
  }
}

async function backfillHoldersLocked(db: Db, chain: ChainKey): Promise<{ tokens: number; chunks: number; transfers: number } | null> {
  const cid = chainIdOf(chain);
  const [cur] = await db<{ cursor_block: bigint }[]>`SELECT cursor_block FROM bb_launch_sync_cursor WHERE chain_id = ${cid}`;
  if (!cur || cur.cursor_block <= 0n) return null;
  const cursor = BigInt(cur.cursor_block);
  const batch = await db<{ token: string; block_number: bigint; holders_synced_block: bigint | null }[]>`
    SELECT token, block_number, holders_synced_block FROM bb_launches
     WHERE chain_id = ${cid} AND (holders_synced_block IS NULL OR holders_synced_block < ${cursor})
     ORDER BY block_number ASC LIMIT ${BACKFILL_TOKENS_PER_CALL}`;
  if (batch.length === 0) return null;
  const tokens = batch.map((b) => b.token);
  let from = batch.reduce((m, b) => {
    const start = b.holders_synced_block === null ? BigInt(b.block_number) : BigInt(b.holders_synced_block) + 1n;
    return start < m ? start : m;
  }, cursor + 1n);
  let chunks = 0;
  let transfers = 0;
  while (from <= cursor && chunks < BACKFILL_CHUNKS_PER_CALL) {
    let to = from + SYNC_CHUNK_BLOCKS - 1n;
    if (to > cursor) to = cursor;
    transfers += await applyTransfers(db, chain, tokens, from, to);
    const mark = to >= cursor ? SYNCED_FOREVER : to;
    await db`UPDATE bb_launches SET holders_synced_block = ${mark} WHERE chain_id = ${cid} AND token = ANY(${tokens})`;
    from = to + 1n;
    chunks++;
  }
  if (chunks > 0) console.log(`[launch-sync] holders backfill ${chain}: ${tokens.length} tokens, ${chunks} chunk(s), ${transfers} transfers, ${from > cursor ? "batch complete" : `resume at ${from}`}`);
  return { tokens: tokens.length, chunks, transfers };
}

// ── poller ───────────────────────────────────────────────────────────────────
const inFlight = new Map<ChainKey, Promise<LaunchSyncResult>>();

export async function pollLaunches(chain: ChainKey): Promise<LaunchSyncResult> {
  const cur = inFlight.get(chain);
  if (cur) return cur;
  const p = run(chain).finally(() => {
    inFlight.delete(chain);
  });
  inFlight.set(chain, p);
  return p;
}

/** Poll every configured chain (used by the loop and POST /api/launch/sync without a tx). */
export async function pollAll(): Promise<Record<string, LaunchSyncResult>> {
  const out: Record<string, LaunchSyncResult> = {};
  await Promise.all(
    CONFIGURED_CHAINS.map(async (c) => {
      out[c] = await pollLaunches(c).catch((e): LaunchSyncResult => ({ status: "skipped", reason: errMessage(e) }));
      await healLaunchReads(c).catch((e) => console.warn(`[launch-sync] heal ${c}:`, errMessage(e)));
      await healQuoteTokens(c).catch((e) => console.warn(`[launch-sync] quote tokens ${c}:`, errMessage(e)));
      await healSwapTraders(c).catch((e) => console.warn(`[launch-sync] heal traders ${c}:`, errMessage(e)));
      await backfillHolders(c).catch((e) => console.warn(`[launch-sync] holders backfill ${c}:`, errMessage(e)));
    }),
  );
  return out;
}

/**
 * Self-heal rows whose eth_calls failed at index time (a launch is indexed in the same block it is mined;
 * a lagging RPC node then reverts `name()`/`symbol()`/`recipientsOf()` and the fallback "?" / [] was stored).
 * Re-reads a few of the newest such rows on every poll and rewrites them once the reads succeed.
 */
export async function healLaunchReads(chain: ChainKey): Promise<number> {
  const db = maybeDb();
  if (!db || skipReason(chain)) return 0;
  const cid = chainIdOf(chain);
  const rows = await db<{ token: string; token_id: bigint; name: string; symbol: string; lp_fee: number; recipients: unknown }[]>`
    SELECT token, token_id, name, symbol, lp_fee, recipients FROM bb_launches
     WHERE chain_id = ${cid} AND (name = '?' OR symbol = '?' OR (lp_fee > 0 AND recipients = '[]'::jsonb))
     ORDER BY block_number DESC LIMIT 10`;
  if (rows.length === 0) return 0;
  const client = publicClient(chain);
  const locker = launchpad(chain).locker!;
  let healed = 0;
  for (const r of rows) {
    const token = r.token as Address;
    const [name, symbol, recipients] = await Promise.all([
      r.name === "?" ? client.readContract({ address: token, abi: ERC20_MIN_ABI, functionName: "name" }).catch(() => null) : Promise.resolve(r.name),
      r.symbol === "?" ? client.readContract({ address: token, abi: ERC20_MIN_ABI, functionName: "symbol" }).catch(() => null) : Promise.resolve(r.symbol),
      r.lp_fee > 0 && Array.isArray(r.recipients) && r.recipients.length === 0
        ? client
            .readContract({ address: locker, abi: LAUNCH_LOCKER_ABI, functionName: "recipientsOf", args: [BigInt(r.token_id)] })
            .then((x) => x.map((y) => ({ payout: y.payout.toLowerCase(), bps: Number(y.bps) })))
            .catch(() => null)
        : Promise.resolve(null),
    ]);
    const setName = typeof name === "string" && name !== "?" && name !== r.name ? name.slice(0, 64) : null;
    const setSymbol = typeof symbol === "string" && symbol !== "?" && symbol !== r.symbol ? symbol.slice(0, 16) : null;
    const setRecipients = recipients && recipients.length > 0 ? recipients : null;
    if (!setName && !setSymbol && !setRecipients) continue;
    await db`
      UPDATE bb_launches SET
        name = COALESCE(${setName}, name),
        symbol = COALESCE(${setSymbol}, symbol),
        recipients = COALESCE(${setRecipients ? db.json(setRecipients) : null}, recipients)
      WHERE chain_id = ${cid} AND token = ${r.token}`;
    healed++;
  }
  if (healed) console.log(`[launch-sync] healed ${healed} launch row(s) on ${chain}`);
  return healed;
}

/**
 * Read symbol / name / decimals of quotes no list knows (unlisted pairs, lib/launchpad/unlisted-quote.ts) into
 * bb_quote_tokens. New quotes first; a quote whose decimals did not answer is retried every 10 minutes. The raw
 * symbol is stored: what may be shown is decided at read time, so a change to the reserved list applies to old rows.
 */
export async function healQuoteTokens(chain: ChainKey): Promise<number> {
  const db = maybeDb();
  if (!db || skipReason(chain)) return 0;
  const cid = chainIdOf(chain);
  const rows = await db<{ quote: string }[]>`
    SELECT l.quote FROM bb_launches l
      LEFT JOIN bb_quote_tokens q ON q.chain_id = l.chain_id AND q.address = l.quote
     WHERE l.chain_id = ${cid} AND l.quote <> ALL(${listedQuoteAddresses(chain)})
       AND (q.address IS NULL OR (q.decimals IS NULL AND q.checked_at < now() - interval '10 minutes'))
     GROUP BY l.quote, q.address ORDER BY (q.address IS NULL) DESC, max(l.block_number) DESC LIMIT 10`;
  if (rows.length === 0) return 0;
  const client = publicClient(chain);
  let resolved = 0;
  for (const r of rows) {
    const address = r.quote as Address;
    const read = <T,>(functionName: "symbol" | "name" | "decimals") => client.readContract({ address, abi: ERC20_MIN_ABI, functionName }).then((v) => v as T).catch(() => null);
    const [symbol, name, decimals] = await Promise.all([read<string>("symbol"), read<string>("name"), read<number>("decimals")]);
    const d = decimals !== null && validDecimals(Number(decimals)) ? Number(decimals) : null;
    // Postgres text refuses NUL, and a token picks its own strings: keep printable characters only
    const text = (v: string | null) => (v === null ? null : v.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 64));
    await db`
      INSERT INTO bb_quote_tokens (chain_id, address, symbol, name, decimals, checked_at)
      VALUES (${cid}, ${r.quote}, ${text(symbol)}, ${text(name)}, ${d}, now())
      ON CONFLICT (chain_id, address) DO UPDATE SET
        symbol = COALESCE(EXCLUDED.symbol, bb_quote_tokens.symbol),
        name = COALESCE(EXCLUDED.name, bb_quote_tokens.name),
        decimals = COALESCE(EXCLUDED.decimals, bb_quote_tokens.decimals),
        checked_at = now()`;
    if (d !== null) resolved++;
  }
  if (resolved) console.log(`[launch-sync] read ${resolved} unlisted quote token(s) on ${chain}`);
  return resolved;
}

/**
 * Self-heal swaps stored without a trader (the sender lookup failed at index time, typically a rate-limited
 * node during a busy launch block). Those rows carry no wallet facts: the holder panel skips them and the
 * ranking cannot tell whether they were outside trades. Re-reads a bounded batch of the newest ones per poll.
 */
export async function healSwapTraders(chain: ChainKey): Promise<number> {
  const db = maybeDb();
  if (!db || skipReason(chain)) return 0;
  const cid = chainIdOf(chain);
  const rows = await db<{ tx_hash: string }[]>`
    SELECT tx_hash FROM bb_launch_swaps
     WHERE chain_id = ${cid} AND trader IS NULL GROUP BY tx_hash ORDER BY max(block_number) DESC LIMIT 20`;
  if (rows.length === 0) return 0;
  let healed = 0;
  for (const r of rows) {
    const trader = await fromOf(chain, r.tx_hash as Hex);
    if (!trader) continue;
    await db`UPDATE bb_launch_swaps SET trader = ${trader} WHERE chain_id = ${cid} AND tx_hash = ${r.tx_hash} AND trader IS NULL`;
    healed++;
  }
  if (healed) console.log(`[launch-sync] healed traders on ${healed} swap tx(s) on ${chain}`);
  return healed;
}

async function run(chain: ChainKey): Promise<LaunchSyncResult> {
  const reason = skipReason(chain);
  if (reason) return { status: "skipped", reason };
  const db = maybeDb()!;
  const cid = chainIdOf(chain);
  try {
    await db`INSERT INTO bb_launch_sync_cursor (chain_id) VALUES (${cid}) ON CONFLICT DO NOTHING`;
    const [{ cursor_block }] = await db<{ cursor_block: bigint }[]>`SELECT cursor_block FROM bb_launch_sync_cursor WHERE chain_id = ${cid}`;
    const head = await publicClient(chain).getBlockNumber();
    const confirmed = head - confirmations(chain);
    const deploy = launchDeployBlock(chain);
    let from = cursor_block > 0n ? cursor_block - syncOverlapBlocks() : deploy;
    if (from < deploy) from = deploy;
    const totals = { launches: 0, swaps: 0, fees: 0 };
    let chunks = 0;
    let to = from;
    while (from <= confirmed && chunks < SYNC_MAX_CHUNKS_PER_CALL) {
      to = from + SYNC_CHUNK_BLOCKS - 1n;
      if (to > confirmed) to = confirmed;
      const r = await applyRange(db, chain, from, to);
      totals.launches += r.launches;
      totals.swaps += r.swaps;
      totals.fees += r.fees;
      await db`UPDATE bb_launch_sync_cursor SET cursor_block = ${to}, head_block = ${head}, last_run_at = now(), last_error = NULL WHERE chain_id = ${cid}`;
      from = to + 1n;
      chunks++;
    }
    return { status: "synced", from: from.toString(), to: to.toString(), head: head.toString(), ...totals, caught_up: from > confirmed };
  } catch (err) {
    const msg = errMessage(err);
    // the stored message reaches /api/health unauthenticated: never with the upstream URL (a keyed provider URL carries its API key)
    await db`UPDATE bb_launch_sync_cursor SET last_run_at = now(), last_error = ${redactUrls(msg).slice(0, 500)} WHERE chain_id = ${cid}`.catch(() => {});
    throw err;
  }
}

// ── receipt apply ────────────────────────────────────────────────────────────
export type ApplyLaunchTxResult = { status: "applied" | "not_found" | "reverted" | "skipped"; reason?: string; launches?: number; swaps?: number; fees?: number; tokens?: string[] };

export async function applyLaunchTx(chain: ChainKey, hash: Hex): Promise<ApplyLaunchTxResult> {
  const reason = skipReason(chain);
  if (reason) return { status: "skipped", reason };
  const db = maybeDb()!;
  const receipt = await publicClient(chain).getTransactionReceipt({ hash }).catch(() => null);
  if (!receipt) return { status: "not_found" };
  if (receipt.status !== "success") return { status: "reverted" };
  const cfg = launchpad(chain);
  const factory = cfg.factory!.toLowerCase();
  const locker = cfg.locker!.toLowerCase();
  const pm = cfg.v4.poolManager.toLowerCase();

  let launches = 0;
  let swaps = 0;
  let fees = 0;
  const tokens: string[] = [];
  const launched = parseEventLogs({ abi: LAUNCH_FACTORY_ABI, eventName: "Launched", logs: receipt.logs.filter((l) => l.address.toLowerCase() === factory) });
  for (const l of launched) {
    if (await applyLaunched(db, chain, l as unknown as Log & { args: Launched })) launches++;
    tokens.push(l.args.token.toLowerCase());
  }
  const { poolToToken, tokenIdToToken } = await poolMaps(db, chain);
  const swapLogs = parseEventLogs({ abi: POOL_MANAGER_ABI, eventName: "Swap", logs: receipt.logs.filter((l) => l.address.toLowerCase() === pm) });
  for (const l of swapLogs) {
    if (await applySwap(db, chain, l as unknown as Log & { args: Swap }, poolToToken)) {
      swaps++;
      const t = poolToToken.get(l.args.id.toLowerCase());
      if (t && !tokens.includes(t)) tokens.push(t);
    }
  }
  const feeLogs = parseEventLogs({ abi: LAUNCH_LOCKER_ABI, logs: receipt.logs.filter((l) => l.address.toLowerCase() === locker) });
  for (const l of feeLogs) if (await applyFee(db, chain, l as unknown as FeeLog, tokenIdToToken)) fees++;
  return { status: "applied", launches, swaps, fees, tokens };
}
