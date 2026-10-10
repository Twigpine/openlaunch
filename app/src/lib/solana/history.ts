import { Buffer } from "buffer";
import {
  PublicKey,
  type Connection,
  type VersionedTransactionResponse,
} from "@solana/web3.js";
import { discriminator } from "../../../packages/solana-sdk/src/encoding";
import {
  FIXED_SUPPLY,
  U128_MAX,
  U64_MAX,
  quoteBuy,
  quoteSell,
  type CurveState,
} from "../../../packages/solana-sdk/src/math";
import type { PoolSnapshot } from "../../../packages/solana-sdk/src/accounts";

export const HISTORY_SIGNATURE_LIMIT = 100;
const SWAP_DISCRIMINATOR = discriminator("event", "Swap");
const PRICE_SCALE = 10n ** 18n;
const KEY = "[1-9A-HJ-NP-Za-km-z]{32,44}";
const INVOKE = new RegExp(`^Program (${KEY}) invoke \\[(\\d+)\\]$`);
const FINISH = new RegExp(`^Program (${KEY}) (success|failed:.*)$`);

export type SolanaTrade = {
  signature: string;
  eventIndex: number;
  slot: number;
  blockTime: number | null;
  sequence: string;
  trader: string;
  isBuy: boolean;
  amountIn: string;
  amountOut: string;
  fee: string;
  tokenReserve: string;
  solReserve: string;
  tokenAmount: string;
  curveLamports: string;
  priceSol: string;
};
export type SolanaCandle = {
  t: number;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
  trades: number;
};
export type SolanaHistory = {
  pool: string;
  snapshotSlot: number;
  throughSequence: string;
  trades: SolanaTrade[];
  candles: SolanaCandle[];
  tradeCount: number;
  coverage: {
    scope: "recent";
    partial: true;
    signatureLimit: 100;
    signaturesScanned: number;
    unavailableTransactions: number;
    rejectedTransactions: number;
    sequenceGaps: boolean;
  };
};
type EventContext = {
  signature: string;
  slot: number;
  blockTime: number | null;
  pool: PublicKey;
  curve: CurveState;
  throughSequence: bigint;
};
type RawTrade = {
  trade: SolanaTrade;
  price: bigint;
  volume: bigint;
  beforeToken: bigint;
  beforeSol: bigint;
};

function checked(value: bigint, max = U128_MAX): bigint {
  if (value < 0n || value > max) throw new Error("Invalid history arithmetic");
  return value;
}
function decimal(value: bigint, decimals: number): string {
  const text = checked(value)
    .toString()
    .padStart(decimals + 1, "0");
  const fraction = text.slice(-decimals).replace(/0+$/, "");
  return `${text.slice(0, -decimals)}${fraction ? `.${fraction}` : ""}`;
}

/** Event bytes are accepted only after their runtime invocation frame succeeds. */
function decodeSwap(
  bytes: Buffer,
  context: EventContext,
  eventIndex: number,
): RawTrade | null {
  if (!bytes.subarray(0, 8).equals(SWAP_DISCRIMINATOR)) return null;
  if (bytes.length !== 129) throw new Error("Truncated or extended swap event");
  const pool = new PublicKey(bytes.subarray(8, 40));
  if (!pool.equals(context.pool)) return null;
  const trader = new PublicKey(bytes.subarray(40, 72));
  const sequence = bytes.readBigUInt64LE(72);
  const side = bytes[80];
  const amountIn = bytes.readBigUInt64LE(81);
  const amountOut = bytes.readBigUInt64LE(89);
  const fee = bytes.readBigUInt64LE(97);
  const tokenReserve = bytes.readBigUInt64LE(105);
  const solReserve = bytes.readBigUInt64LE(113);
  const slot = bytes.readBigUInt64LE(121);
  if (
    sequence < 1n ||
    sequence > context.throughSequence ||
    slot !== BigInt(context.slot) ||
    side > 1 ||
    trader.equals(PublicKey.default)
  )
    throw new Error("Misattributed swap event");
  const isBuy = side === 1;
  const curveLamports = checked(
    isBuy ? amountIn - fee : amountOut + fee,
    U64_MAX,
  );
  const tokenAmount = isBuy ? amountOut : amountIn;
  if (curveLamports === 0n || tokenAmount === 0n || tokenAmount > FIXED_SUPPLY)
    throw new Error("Invalid swap amounts");
  // Reconstruct the pre-trade state and check the immutable curve and fee tier.
  const before: CurveState = {
    ...context.curve,
    tokenInventory: isBuy
      ? checked(tokenReserve + amountOut, FIXED_SUPPLY)
      : checked(tokenReserve - amountIn, FIXED_SUPPLY),
    realSolReserves: isBuy
      ? checked(solReserve - curveLamports, U64_MAX)
      : checked(solReserve + curveLamports, U64_MAX),
  };
  const quoted = (isBuy ? quoteBuy : quoteSell)(before, amountIn);
  if (
    quoted.amountOut !== amountOut ||
    quoted.fee !== fee ||
    quoted.nextTokenInventory !== tokenReserve ||
    quoted.nextRealSolReserves !== solReserve
  )
    throw new Error("Swap event disagrees with curve");
  if (
    sequence === context.throughSequence &&
    (tokenReserve !== context.curve.tokenInventory ||
      solReserve !== context.curve.realSolReserves)
  )
    throw new Error("Latest swap disagrees with snapshot");
  // SOL per whole token: lamports * 10^6 / (atoms * 10^9), scaled by 10^18.
  const price = checked(curveLamports * (PRICE_SCALE / 1000n)) / tokenAmount;
  if (price === 0n) throw new Error("Price is below display precision");
  return {
    price,
    volume: curveLamports,
    beforeToken: before.tokenInventory,
    beforeSol: before.realSolReserves,
    trade: {
      signature: context.signature,
      eventIndex,
      slot: context.slot,
      blockTime: context.blockTime,
      sequence: sequence.toString(),
      trader: trader.toBase58(),
      isBuy,
      amountIn: amountIn.toString(),
      amountOut: amountOut.toString(),
      fee: fee.toString(),
      tokenReserve: tokenReserve.toString(),
      solReserve: solReserve.toString(),
      tokenAmount: tokenAmount.toString(),
      curveLamports: curveLamports.toString(),
      priceSol: decimal(price, 18),
    },
  };
}

/** Strict runtime stack parsing prevents foreign emitters and rolled-back CPI events. */
export function parseSolanaSwapLogs(
  logs: readonly string[] | null | undefined,
  programId: PublicKey,
  context: EventContext,
): { rejected: boolean; events: RawTrade[] } {
  if (
    !logs ||
    logs.length > 10_000 ||
    logs.reduce((size, line) => size + line.length, 0) > 256_000
  )
    return { rejected: true, events: [] };
  const stack: { program: string; events: RawTrade[] }[] = [];
  const accepted: RawTrade[] = [];
  const ownProgram = programId.toBase58();
  try {
    for (let index = 0; index < logs.length; index++) {
      const line = logs[index];
      if (line === "Log truncated" || line.startsWith("Log truncated "))
        throw new Error("Truncated logs");
      const invoke = INVOKE.exec(line);
      if (invoke) {
        if (Number(invoke[2]) !== stack.length + 1 || stack.length >= 64)
          throw new Error("Broken invocation depth");
        stack.push({ program: invoke[1], events: [] });
        continue;
      }
      const finish = FINISH.exec(line);
      if (finish) {
        const frame = stack.pop();
        if (!frame || frame.program !== finish[1])
          throw new Error("Mismatched program completion");
        if (finish[2] === "success")
          (stack.at(-1)?.events ?? accepted).push(...frame.events);
        // Failure discards this frame and all successful child events: their writes rolled back.
        continue;
      }
      if (!line.startsWith("Program data: ")) continue;
      const frame = stack.at(-1);
      if (!frame) throw new Error("Unscoped event log");
      if (frame.program !== ownProgram) continue;
      const encoded = line.slice("Program data: ".length);
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4 !== 0)
        throw new Error("Malformed event encoding");
      const bytes = Buffer.from(encoded, "base64");
      if (bytes.length < 8 || bytes.toString("base64") !== encoded)
        throw new Error("Noncanonical event encoding");
      const event = decodeSwap(bytes, context, index);
      if (event) frame.events.push(event);
    }
    if (stack.length !== 0) throw new Error("Unfinished invocation logs");
    return { rejected: false, events: accepted };
  } catch {
    return { rejected: true, events: [] };
  }
}

export function parseSolanaTransaction(
  tx: VersionedTransactionResponse,
  signature: string,
  programId: PublicKey,
  snapshot: PoolSnapshot,
): { rejected: boolean; events: RawTrade[] } {
  if (
    !tx.meta ||
    tx.meta.err ||
    tx.transaction.signatures[0] !== signature ||
    !Number.isSafeInteger(tx.slot) ||
    tx.slot < 0 ||
    tx.slot > snapshot.slot
  )
    return { rejected: true, events: [] };
  const keys = [
    ...tx.transaction.message.staticAccountKeys,
    ...(tx.meta.loadedAddresses?.writable ?? []),
    ...(tx.meta.loadedAddresses?.readonly ?? []),
  ];
  if (
    !keys.some((key) => key.equals(snapshot.address)) ||
    !keys.some((key) => key.equals(programId))
  )
    return { rejected: true, events: [] };
  const blockTime =
    Number.isSafeInteger(tx.blockTime) && (tx.blockTime ?? -1) >= 0
      ? tx.blockTime!
      : null;
  return parseSolanaSwapLogs(tx.meta.logMessages, programId, {
    signature,
    slot: tx.slot,
    blockTime,
    pool: snapshot.address,
    curve: snapshot.pool,
    throughSequence: snapshot.pool.sequence,
  });
}

export function recentHistoryFromEvents(
  events: readonly RawTrade[],
  throughSequence: bigint,
): { trades: SolanaTrade[]; candles: SolanaCandle[]; sequenceGaps: boolean } {
  const identities = new Map<string, RawTrade>();
  const conflictingIds = new Set<string>();
  for (const event of events) {
    const key = `${event.trade.signature}:${event.trade.eventIndex}`;
    const seen = identities.get(key);
    if (seen && JSON.stringify(seen.trade) !== JSON.stringify(event.trade))
      conflictingIds.add(key);
    else identities.set(key, event);
  }
  const bySequence = new Map<string, RawTrade[]>();
  for (const [key, event] of identities) {
    if (conflictingIds.has(key)) continue;
    const found = bySequence.get(event.trade.sequence) ?? [];
    found.push(event);
    bySequence.set(event.trade.sequence, found);
  }
  // Conflicting transactions for one sequence may be divergent forks. Never pick a winner.
  const ordered = [...bySequence.values()]
    .filter((rows) => rows.length === 1)
    .map((rows) => rows[0])
    .sort((a, b) =>
      BigInt(a.trade.sequence) < BigInt(b.trade.sequence) ? -1 : 1,
    );
  for (let i = 1; i < ordered.length; i++) {
    const previous = ordered[i - 1];
    const current = ordered[i];
    if (
      BigInt(current.trade.sequence) === BigInt(previous.trade.sequence) + 1n &&
      (current.beforeToken !== BigInt(previous.trade.tokenReserve) ||
        current.beforeSol !== BigInt(previous.trade.solReserve))
    ) {
      // Inconsistent consecutive states cannot form one canonical history.
      return { trades: [], candles: [], sequenceGaps: true };
    }
  }
  let sequenceGaps =
    conflictingIds.size > 0 ||
    [...bySequence.values()].some((rows) => rows.length > 1);
  let previous = 0n;
  const buckets = new Map<
    number,
    {
      t: number;
      open: bigint;
      high: bigint;
      low: bigint;
      close: bigint;
      volume: bigint;
      trades: number;
    }
  >();
  for (const event of ordered) {
    const sequence = BigInt(event.trade.sequence);
    if (sequence !== previous + 1n) sequenceGaps = true;
    previous = sequence;
    if (event.trade.blockTime === null) continue; // No fabricated timestamps or candles.
    const t = Math.floor(event.trade.blockTime / 300) * 300;
    const bucket = buckets.get(t);
    if (!bucket)
      buckets.set(t, {
        t,
        open: event.price,
        high: event.price,
        low: event.price,
        close: event.price,
        volume: event.volume,
        trades: 1,
      });
    else {
      bucket.high = bucket.high > event.price ? bucket.high : event.price;
      bucket.low = bucket.low < event.price ? bucket.low : event.price;
      bucket.close = event.price;
      bucket.volume = checked(bucket.volume + event.volume);
      bucket.trades++;
    }
  }
  if (previous !== throughSequence) sequenceGaps = true;
  return {
    trades: ordered.map((event) => event.trade),
    sequenceGaps,
    candles: [...buckets.values()]
      .sort((a, b) => a.t - b.t)
      .map((bucket) => ({
        t: bucket.t,
        open: decimal(bucket.open, 18),
        high: decimal(bucket.high, 18),
        low: decimal(bucket.low, 18),
        close: decimal(bucket.close, 18),
        volume: decimal(bucket.volume, 9),
        trades: bucket.trades,
      })),
  };
}

export async function fetchRecentSolanaHistory(
  connection: Connection,
  programId: PublicKey,
  snapshot: PoolSnapshot,
): Promise<SolanaHistory> {
  const signatures = (
    await connection.getSignaturesForAddress(
      snapshot.address,
      { limit: HISTORY_SIGNATURE_LIMIT, minContextSlot: snapshot.slot },
      "confirmed",
    )
  ).slice(0, HISTORY_SIGNATURE_LIMIT);
  const unique = [
    ...new Map(
      signatures.map((signature) => [signature.signature, signature]),
    ).values(),
  ];
  const candidates = unique.filter(
    (signature) =>
      !signature.err &&
      signature.slot <= snapshot.slot &&
      signature.confirmationStatus !== "processed",
  );
  let unavailableTransactions = 0;
  let rejectedTransactions = 0;
  let next = 0;
  const deadline = Date.now() + 10_000;
  const events: RawTrade[] = [];
  // Each request uses at most four RPCs concurrently; route also bounds total live requests.
  await Promise.all(
    Array.from({ length: Math.min(4, candidates.length) }, async () => {
      while (next < candidates.length) {
        if (Date.now() >= deadline) {
          unavailableTransactions += candidates.length - next;
          next = candidates.length;
          break;
        }
        const signature = candidates[next++];
        try {
          const tx = await connection.getTransaction(signature.signature, {
            commitment: "confirmed",
            maxSupportedTransactionVersion: 0,
          });
          if (!tx) {
            unavailableTransactions++;
            continue;
          }
          const parsed = parseSolanaTransaction(
            tx,
            signature.signature,
            programId,
            snapshot,
          );
          if (parsed.rejected || tx.slot !== signature.slot)
            rejectedTransactions++;
          else events.push(...parsed.events);
        } catch {
          unavailableTransactions++;
        }
      }
    }),
  );
  const history = recentHistoryFromEvents(events, snapshot.pool.sequence);
  return {
    pool: snapshot.address.toBase58(),
    snapshotSlot: snapshot.slot,
    throughSequence: snapshot.pool.sequence.toString(),
    trades: history.trades,
    candles: history.candles,
    tradeCount: history.trades.length,
    coverage: {
      scope: "recent",
      partial: true,
      signatureLimit: HISTORY_SIGNATURE_LIMIT,
      signaturesScanned: unique.length,
      unavailableTransactions,
      rejectedTransactions,
      sequenceGaps: history.sequenceGaps,
    },
  };
}

/** Per-process load shedding, not a distributed quota or durable indexer. */
export function createHistoryCache<T>(now: () => number = Date.now) {
  const cache = new Map<string, { expires: number; value: T }>();
  const pending = new Map<string, Promise<T>>();
  let windowAt = 0;
  let starts = 0;
  return async (key: string, load: () => Promise<T>): Promise<T> => {
    const time = now();
    const found = cache.get(key);
    if (found && found.expires > time) return found.value;
    const existing = pending.get(key);
    if (existing) return existing;
    if (time - windowAt >= 60_000) {
      windowAt = time;
      starts = 0;
    }
    if (pending.size >= 2 || starts >= 6) throw new Error("HISTORY_BUSY");
    starts++;
    const task = Promise.resolve()
      .then(load)
      .then((value) => {
        for (const [id, entry] of cache)
          if (entry.expires <= now()) cache.delete(id);
        if (cache.size >= 128) cache.delete(cache.keys().next().value!);
        cache.set(key, { expires: now() + 15_000, value });
        return value;
      })
      .finally(() => pending.delete(key));
    pending.set(key, task);
    return task;
  };
}
