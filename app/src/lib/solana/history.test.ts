import assert from "node:assert/strict";
import test from "node:test";
import { Buffer } from "buffer";
import {
  PublicKey,
  Message,
  type Connection,
  type VersionedTransactionResponse,
} from "@solana/web3.js";
import type { PoolSnapshot } from "../../../packages/solana-sdk/src/accounts.ts";
import { discriminator } from "../../../packages/solana-sdk/src/encoding.ts";
import {
  FIXED_SUPPLY,
  quoteBuy,
  quoteSell,
  type CurveState,
} from "../../../packages/solana-sdk/src/math.ts";
import {
  createHistoryCache,
  fetchRecentSolanaHistory,
  parseSolanaSwapLogs,
  parseSolanaTransaction,
  recentHistoryFromEvents,
} from "./history.ts";

const program = new PublicKey(new Uint8Array(32).fill(1));
const pool = new PublicKey(new Uint8Array(32).fill(2));
const trader = new PublicKey(new Uint8Array(32).fill(3));
const other = new PublicKey(new Uint8Array(32).fill(4));
const initial: CurveState = {
  tokenInventory: FIXED_SUPPLY,
  realSolReserves: 0n,
  virtualSol: 30_000_000_000n,
  feeBps: 100,
};
const invoke = (key: PublicKey, depth = 1) =>
  `Program ${key} invoke [${depth}]`;
const success = (key: PublicKey) => `Program ${key} success`;
const failure = (key: PublicKey) =>
  `Program ${key} failed: custom program error: 0x1`;
const emit = (bytes: Buffer) => `Program data: ${bytes.toString("base64")}`;
function event(
  state = initial,
  sequence = 1n,
  slot = 50n,
  isBuy = true,
  input = 1_000_000_000n,
) {
  const quote = (isBuy ? quoteBuy : quoteSell)(state, input);
  const bytes = Buffer.alloc(129);
  discriminator("event", "Swap").copy(bytes);
  pool.toBuffer().copy(bytes, 8);
  trader.toBuffer().copy(bytes, 40);
  bytes.writeBigUInt64LE(sequence, 72);
  bytes[80] = isBuy ? 1 : 0;
  [
    input,
    quote.amountOut,
    quote.fee,
    quote.nextTokenInventory,
    quote.nextRealSolReserves,
    slot,
  ].forEach((value, index) => bytes.writeBigUInt64LE(value, 81 + index * 8));
  return {
    bytes,
    quote,
    state: {
      ...state,
      tokenInventory: quote.nextTokenInventory,
      realSolReserves: quote.nextRealSolReserves,
    },
  };
}
const first = event();
const context = (
  curve = first.state,
  throughSequence = 1n,
  blockTime: number | null = 600,
) => ({
  signature: "signature",
  slot: 50,
  blockTime,
  pool,
  curve,
  throughSequence,
});
const snapshot = (curve = first.state, sequence = 1n): PoolSnapshot =>
  ({ address: pool, slot: 50, pool: { ...curve, sequence } }) as PoolSnapshot;
function transaction(
  logs: string[],
  options: { failed?: boolean; keys?: PublicKey[]; slot?: number } = {},
): VersionedTransactionResponse {
  const keys = options.keys ?? [trader, pool, program, other];
  return {
    slot: options.slot ?? 50,
    blockTime: 600,
    transaction: {
      signatures: ["signature"],
      message: new Message({
        header: {
          numRequiredSignatures: 1,
          numReadonlySignedAccounts: 0,
          numReadonlyUnsignedAccounts: 2,
        },
        accountKeys: keys,
        recentBlockhash: trader.toBase58(),
        instructions: [],
      }),
    },
    meta: {
      err: options.failed ? { InstructionError: [0, "InvalidArgument"] } : null,
      fee: 5000,
      preBalances: [],
      postBalances: [],
      logMessages: logs,
    },
  };
}

test("accept own successful top-level and CPI swaps with exact integer price", () => {
  const logs = [
    invoke(other),
    invoke(program, 2),
    emit(first.bytes),
    success(program),
    success(other),
  ];
  const parsed = parseSolanaSwapLogs(logs, program, context());
  assert.equal(parsed.rejected, false);
  assert.equal(parsed.events.length, 1);
  assert.equal(parsed.events[0].trade.eventIndex, 2);
  assert.equal(
    parsed.events[0].trade.amountOut,
    first.quote.amountOut.toString(),
  );
  assert.equal(parsed.events[0].trade.curveLamports, "990000000");
  assert.equal(parsed.events[0].trade.priceSol, "0.00000003099");
  assert.equal(
    parseSolanaTransaction(transaction(logs), "signature", program, snapshot())
      .events.length,
    1,
  );
});

test("foreign emitters and log-prefixed fake runtime lines cannot impersonate own program", () => {
  const logs = [
    invoke(other),
    `Program log: ${invoke(program, 2)}`,
    emit(first.bytes),
    `Program log: ${success(program)}`,
    success(other),
  ];
  assert.deepEqual(parseSolanaSwapLogs(logs, program, context()), {
    rejected: false,
    events: [],
  });
  const sibling = [
    invoke(other),
    emit(first.bytes),
    success(other),
    invoke(program),
    emit(first.bytes),
    success(program),
  ];
  assert.equal(
    parseSolanaSwapLogs(sibling, program, context()).events.length,
    1,
  );
});

test("discard rolled-back CPI events including when an ancestor fails but outer transaction succeeds", () => {
  const childFailure = [
    invoke(other),
    invoke(program, 2),
    emit(first.bytes),
    failure(program),
    success(other),
  ];
  assert.deepEqual(parseSolanaSwapLogs(childFailure, program, context()), {
    rejected: false,
    events: [],
  });
  const ancestorFailure = [
    invoke(trader),
    invoke(other, 2),
    invoke(program, 3),
    emit(first.bytes),
    success(program),
    failure(other),
    success(trader),
  ];
  assert.deepEqual(parseSolanaSwapLogs(ancestorFailure, program, context()), {
    rejected: false,
    events: [],
  });
  const failedTransaction = transaction(
    [invoke(program), emit(first.bytes), success(program)],
    { failed: true },
  );
  assert.equal(
    parseSolanaTransaction(failedTransaction, "signature", program, snapshot())
      .rejected,
    true,
  );
});

test("reject incomplete stacks, mismatched completions, corrupt events and truncated logs", () => {
  const alteredAmount = Buffer.from(first.bytes);
  alteredAmount.writeBigUInt64LE(first.quote.amountOut + 1n, 89);
  const wrongSlot = Buffer.from(first.bytes);
  wrongSlot.writeBigUInt64LE(51n, 121);
  const wrongSequence = Buffer.from(first.bytes);
  wrongSequence.writeBigUInt64LE(2n, 72);
  const wrongBool = Buffer.from(first.bytes);
  wrongBool[80] = 2;
  for (const logs of [
    [invoke(program), emit(first.bytes)],
    [invoke(program, 2), emit(first.bytes), success(program)],
    [invoke(program), emit(first.bytes), success(other)],
    [emit(first.bytes)],
    [invoke(program), emit(first.bytes), "Log truncated", success(program)],
    [invoke(program), `${emit(first.bytes)}=`, success(program)],
    ...[
      first.bytes.subarray(0, 128),
      first.bytes.subarray(0, 3),
      Buffer.concat([first.bytes, Buffer.from([0])]),
      alteredAmount,
      wrongSlot,
      wrongSequence,
      wrongBool,
    ].map((bytes) => [invoke(program), emit(bytes), success(program)]),
  ])
    assert.deepEqual(parseSolanaSwapLogs(logs, program, context()), {
      rejected: true,
      events: [],
    });
  assert.equal(
    parseSolanaSwapLogs(
      [invoke(program), emit(first.bytes), success(program)],
      program,
      context(initial),
    ).rejected,
    true,
  );
});

test("reject signature, account, slot and metadata mismatches; ignore swaps for another pool", () => {
  const logs = [invoke(program), emit(first.bytes), success(program)];
  assert.equal(
    parseSolanaTransaction(
      transaction(logs),
      "other-signature",
      program,
      snapshot(),
    ).rejected,
    true,
  );
  assert.equal(
    parseSolanaTransaction(
      transaction(logs, { keys: [trader, program] }),
      "signature",
      program,
      snapshot(),
    ).rejected,
    true,
  );
  assert.equal(
    parseSolanaTransaction(
      transaction(logs, { keys: [trader, pool] }),
      "signature",
      program,
      snapshot(),
    ).rejected,
    true,
  );
  assert.equal(
    parseSolanaTransaction(
      transaction(logs, { slot: 51 }),
      "signature",
      program,
      snapshot(),
    ).rejected,
    true,
  );
  const missingMeta = transaction(logs);
  missingMeta.meta = null;
  assert.equal(
    parseSolanaTransaction(missingMeta, "signature", program, snapshot())
      .rejected,
    true,
  );
  const foreign = Buffer.from(first.bytes);
  other.toBuffer().copy(foreign, 8);
  assert.deepEqual(
    parseSolanaSwapLogs(
      [invoke(program), emit(foreign), success(program)],
      program,
      context(),
    ),
    { rejected: false, events: [] },
  );
});

test("deduplicate identities, reject conflicting sequences and aggregate only real timed candles", () => {
  const second = event(first.state, 2n, 50n, false, first.quote.amountOut / 2n);
  const a = parseSolanaSwapLogs(
    [invoke(program), emit(first.bytes), success(program)],
    program,
    context(second.state, 2n),
  ).events[0];
  const b = parseSolanaSwapLogs(
    [invoke(program), emit(second.bytes), success(program)],
    program,
    { ...context(second.state, 2n, 700), signature: "second" },
  ).events[0];
  const result = recentHistoryFromEvents([b, a, a], 2n);
  assert.deepEqual(
    result.trades.map((trade) => trade.sequence),
    ["1", "2"],
  );
  assert.equal(result.sequenceGaps, false);
  assert.equal(result.candles.length, 1);
  assert.equal(result.candles[0].t, 600);
  assert.equal(result.candles[0].trades, 2);
  assert.equal(result.candles[0].open, a.trade.priceSol);
  assert.equal(result.candles[0].close, b.trade.priceSol);
  assert.equal(result.candles[0].volume, "1.493034923");
  assert.deepEqual(recentHistoryFromEvents([], 0n), {
    trades: [],
    candles: [],
    sequenceGaps: false,
  });
  const noTime = { ...a, trade: { ...a.trade, blockTime: null } };
  assert.equal(recentHistoryFromEvents([noTime], 1n).candles.length, 0);
  assert.equal(recentHistoryFromEvents([a], 2n).sequenceGaps, true);
  const duplicateSequence = { ...a, trade: { ...a.trade, signature: "fork" } };
  const conflict = recentHistoryFromEvents([a, duplicateSequence], 1n);
  assert.equal(conflict.trades.length, 0);
  assert.equal(conflict.sequenceGaps, true);
  const badContinuity = { ...b, beforeSol: b.beforeSol + 1n };
  assert.deepEqual(recentHistoryFromEvents([a, badContinuity], 2n), {
    trades: [],
    candles: [],
    sequenceGaps: true,
  });
});

test("RPC history scanning is bounded, filters failed signatures and reports unavailable transactions", async () => {
  let concurrent = 0;
  let maximum = 0;
  let calls = 0;
  const fake = {
    getSignaturesForAddress: async (
      _address: PublicKey,
      options: { limit: number },
    ) => {
      assert.equal(options.limit, 100);
      return Array.from({ length: 103 }, (_, i) => ({
        signature: `sig${i}`,
        slot: 50,
        err: i === 0 ? {} : null,
        memo: null,
        confirmationStatus: "confirmed",
      }));
    },
    getTransaction: async () => {
      concurrent++;
      maximum = Math.max(maximum, concurrent);
      calls++;
      await new Promise((resolve) => setTimeout(resolve, 0));
      concurrent--;
      return null;
    },
  } as unknown as Connection;
  const result = await fetchRecentSolanaHistory(fake, program, snapshot());
  assert.equal(calls, 99);
  assert(maximum <= 4);
  assert.equal(result.coverage.signaturesScanned, 100);
  assert.equal(result.coverage.unavailableTransactions, 99);
  assert.equal(result.coverage.partial, true);
  assert.equal(result.tradeCount, 0);
  assert.deepEqual(result.candles, []);
});

test("cache deduplicates requests and limits concurrent and per-minute upstream starts", async () => {
  let now = 60_001;
  const cached = createHistoryCache<number>(() => now, {
    maxPending: 2,
    startsPerMinute: 6,
    ttlMs: 15_000,
  });
  let resolve: (n: number) => void = () => {};
  let starts = 0;
  const loader = () => {
    starts++;
    return new Promise<number>((done) => {
      resolve = done;
    });
  };
  const a = cached("a", loader);
  const duplicate = cached("a", loader);
  const b = cached("b", async () => 2);
  await assert.rejects(
    cached("c", async () => 3),
    /HISTORY_BUSY/,
  );
  await b;
  resolve(1);
  assert.equal(await a, 1);
  assert.equal(await duplicate, 1);
  assert.equal(starts, 1);
  assert.equal(await cached("a", async () => 9), 1);
  now += 16_000;
  for (const key of ["c", "d", "e", "f"]) await cached(key, async () => 1);
  await assert.rejects(
    cached("g", async () => 1),
    /HISTORY_BUSY/,
  );
  now += 60_000;
  assert.equal(await cached("g", async () => 7), 7);
});

test("refreshes reuse confirmed transactions and refetch a signature the listing moved to another slot", async () => {
  const logs = [
    invoke(other),
    invoke(program, 2),
    emit(first.bytes),
    success(program),
    success(other),
  ];
  let calls = 0;
  let listedSlot = 50;
  const fake = {
    getSignaturesForAddress: async () => [
      {
        signature: "signature",
        slot: listedSlot,
        err: null,
        memo: null,
        confirmationStatus: "confirmed",
      },
    ],
    getTransaction: async () => {
      calls++;
      return transaction(logs, { slot: listedSlot });
    },
  } as unknown as Connection;
  const transactions = new Map();
  const a = await fetchRecentSolanaHistory(fake, program, snapshot(), transactions);
  const b = await fetchRecentSolanaHistory(fake, program, snapshot(), transactions);
  assert.equal(a.tradeCount, 1);
  assert.equal(b.tradeCount, 1);
  assert.equal(calls, 1);
  // The listing now places the signature at another slot: the cached copy is not trusted, the RPC is asked again.
  listedSlot = 49;
  await fetchRecentSolanaHistory(fake, program, snapshot(), transactions);
  assert.equal(calls, 2);
  assert.equal(transactions.get("signature")?.slot, 49);
});
