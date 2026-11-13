import { parseEventLogs, toEventSelector, type Address, type Hex, type Log } from "viem";
import { ERC20_TRANSFER_EVENT } from "./abi";

export type RecoveredTransfer = Log & { args: { from: Address; to: Address; value: bigint } };
export type ReceiptRpc = (method: string, params: readonly unknown[]) => Promise<unknown>;
export const RECEIPT_RECOVERY_CONCURRENCY = 4;

const hash = (value: unknown): value is Hex => typeof value === "string" && /^0x[0-9a-f]{64}$/i.test(value);
const address = (value: unknown): value is Address => typeof value === "string" && /^0x[0-9a-f]{40}$/i.test(value);
const quantity = (value: unknown): bigint | null => typeof value === "string" && /^0x[0-9a-f]+$/i.test(value) ? BigInt(value) : null;
const record = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const transferTopic = toEventSelector(ERC20_TRANSFER_EVENT);
type BlockIdentity = { hash: Hex; number: bigint; transactions: Hex[] };

/** Validate every receipt, including ones without this token's logs, against the block's complete transaction list. */
function completeLogs(value: unknown, block: BlockIdentity): Log[] | null {
  if (!Array.isArray(value) || value.length !== block.transactions.length) return null;
  const logs: Log[] = [];
  let nextLog = 0n;
  for (let i = 0; i < value.length; i++) {
    const receipt = record(value[i]);
    if (!receipt || !hash(receipt.transactionHash) || receipt.transactionHash.toLowerCase() !== block.transactions[i].toLowerCase()
      || !hash(receipt.blockHash) || receipt.blockHash.toLowerCase() !== block.hash.toLowerCase()
      || quantity(receipt.blockNumber) !== block.number || quantity(receipt.transactionIndex) !== BigInt(i)
      || !Array.isArray(receipt.logs)) return null;
    for (const raw of receipt.logs) {
      const log = record(raw);
      if (!log || !address(log.address) || !Array.isArray(log.topics) || log.topics.length > 4 || !log.topics.every(hash)
        || typeof log.data !== "string" || !/^0x(?:[0-9a-f]{2})*$/i.test(log.data)
        || !hash(log.transactionHash) || log.transactionHash.toLowerCase() !== block.transactions[i].toLowerCase()
        || !hash(log.blockHash) || log.blockHash.toLowerCase() !== block.hash.toLowerCase()
        || quantity(log.blockNumber) !== block.number || quantity(log.transactionIndex) !== BigInt(i)
        || quantity(log.logIndex) !== nextLog || nextLog > BigInt(Number.MAX_SAFE_INTEGER)
        || (log.removed !== undefined && log.removed !== false)) return null;
      logs.push({ address: log.address, data: log.data as Hex, topics: log.topics as Log["topics"], blockNumber: block.number,
        blockHash: block.hash, transactionHash: receipt.transactionHash, transactionIndex: i, logIndex: Number(nextLog), removed: false });
      nextLog++;
    }
  }
  return logs;
}

/**
 * Recovery for a single token/block whose getLogs result exceeded the provider cap.
 * Prefer bulk receipts; if unavailable or incomplete, read each transaction receipt with bounded concurrency.
 * Missing/changed evidence returns null, so the caller never advances a cursor over partial holder history.
 */
export async function recoverBlockTransfers(rpc: ReceiptRpc, token: string, height: bigint): Promise<RecoveredTransfer[] | null> {
  try {
    const raw = record(await rpc("eth_getBlockByNumber", [`0x${height.toString(16)}`, false]));
    if (!raw || !hash(raw.hash) || quantity(raw.number) !== height || !Array.isArray(raw.transactions)
      || raw.transactions.length === 0 || !raw.transactions.every(hash)
      || new Set(raw.transactions.map((tx) => tx.toLowerCase())).size !== raw.transactions.length) return null;
    const block: BlockIdentity = { hash: raw.hash, number: height, transactions: raw.transactions };
    const bulk = await rpc("eth_getBlockReceipts", [`0x${height.toString(16)}`]).catch(() => null);
    let logs = completeLogs(bulk, block);
    if (logs === null) {
      const receipts: unknown[] = [];
      for (let offset = 0; offset < block.transactions.length; offset += RECEIPT_RECOVERY_CONCURRENCY) {
        const batch = await Promise.all(block.transactions.slice(offset, offset + RECEIPT_RECOVERY_CONCURRENCY)
          .map((tx) => rpc("eth_getTransactionReceipt", [tx]).catch(() => null)));
        if (batch.some((receipt) => receipt === null)) return null;
        receipts.push(...batch);
      }
      logs = completeLogs(receipts, block);
      if (logs === null) return null;
    }
    const matching = logs.filter((log) => log.address.toLowerCase() === token.toLowerCase() && log.topics[0]?.toLowerCase() === transferTopic.toLowerCase());
    const parsed = parseEventLogs({ abi: [ERC20_TRANSFER_EVENT], eventName: "Transfer", logs: matching });
    // An over-cap token query cannot be recovered by an empty or silently malformed Transfer set.
    if (matching.length === 0 || parsed.length !== matching.length) return null;
    return parsed as unknown as RecoveredTransfer[];
  } catch {
    return null;
  }
}
