/**
 * Who made a swap (pure; node --test loads this directly).
 *
 * The indexer credits the transaction sender, which is the trader for every wallet that sends its own transactions.
 * An ERC-4337 smart wallet (Coinbase / Base App) does not: a bundler submits its operation. Such a swap is credited to
 * the smart wallet only on proof it authorized the call: the swap log sits inside that operation's EXECUTION, i.e.
 * after the EntryPoint's BeforeExecution event (validation of every operation in the bundle happens before it, and a
 * swap made there belongs to nobody's authorized call) and before the UserOperationEvent that closes the operation;
 * that event's `sender` is the account. Token transfers are never the evidence: anyone can buy and have the tokens sent
 * to someone else's wallet, and that must not put the trade under their name. Everything else (EOAs, routers,
 * aggregators, relayers) stays credited to the sender.
 */
import { toEventSelector } from "viem";

/** ERC-4337 EntryPoint singletons (same address on every chain): v0.6, v0.7, v0.8, v0.9. Lowercase. */
export const ENTRY_POINTS: ReadonlySet<string> = new Set([
  "0x5ff137d4b0fdcd49dca30c7cf57e578a026d2789",
  "0x0000000071727de22e5e9d8baf0edac6f37da032",
  "0x4337084d9e255ff0702461cf8895ce9e3b5ff108",
  "0x433709009b8330fda32311df1c2afa402ed8d009",
]);

/** UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, …): same in every version. */
export const USER_OPERATION_EVENT = toEventSelector("UserOperationEvent(bytes32,address,address,uint256,bool,uint256,uint256)");
/** Emitted once per bundle between validating every operation and executing them (v0.6 onward). */
export const BEFORE_EXECUTION_EVENT = toEventSelector("BeforeExecution()");

export type ReceiptLog = { address: string; topics: readonly string[]; logIndex: number };

/**
 * The sender of the user operation whose execution contains the swap log: there must be a BeforeExecution from that
 * EntryPoint before the swap, and the first UserOperationEvent after the swap closes the operation it ran in.
 */
export function userOpSender(logs: readonly ReceiptLog[], entryPoint: string, swapLogIndex: number): string | null {
  const ep = entryPoint.toLowerCase();
  const own = logs.filter((l) => l.address.toLowerCase() === ep).sort((a, b) => a.logIndex - b.logIndex);
  const started = own.some((l) => l.topics[0]?.toLowerCase() === BEFORE_EXECUTION_EVENT && l.logIndex < swapLogIndex);
  if (!started) return null;
  const close = own.find((l) => l.topics[0]?.toLowerCase() === USER_OPERATION_EVENT && l.logIndex > swapLogIndex && typeof l.topics[2] === "string");
  if (!close) return null;
  const t = close.topics[2].toLowerCase();
  return /^0x0{24}[0-9a-f]{40}$/.test(t) ? `0x${t.slice(26)}` : null;
}

export type Attribution = { trader: string; via: "tx_from" | "userop" };

/** The decision, given the transaction's from / to and, when `to` is an EntryPoint, the receipt logs. */
export function attributeSwap(p: { from: string; to: string | null; swapLogIndex: number; logs?: readonly ReceiptLog[] | null }): Attribution {
  const from = p.from.toLowerCase();
  const to = p.to?.toLowerCase() ?? null;
  if (to && ENTRY_POINTS.has(to)) {
    const s = p.logs ? userOpSender(p.logs, to, p.swapLogIndex) : null;
    if (s) return { trader: s, via: "userop" };
  }
  return { trader: from, via: "tx_from" };
}
