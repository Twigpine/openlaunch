/**
 * Who made a swap (pure; node --test loads this directly).
 *
 * The indexer credits the transaction sender, which is the trader for every wallet that sends its own transactions.
 * An ERC-4337 smart wallet (Coinbase / Base App) does not: a bundler submits its operation. Such a swap is credited to
 * the smart wallet only on proof it authorized the call: the swap log sits inside that operation's EXECUTION, i.e.
 * after the EntryPoint's BeforeExecution event (validation of every operation in the bundle happens before it, and a
 * swap made there belongs to nobody's authorized call) and before the UserOperationEvent that closes the operation;
 * that event's `sender` is the account. Token transfers are never the evidence on their own: anyone can buy and have the
 * tokens sent to someone else's wallet, and that must not put the trade under their name. Everything else (EOAs,
 * routers, aggregators, relayers) stays credited to the sender.
 *
 * An operation with a paymaster (about three in four smart-wallet swaps on Base) has one more step inside that window:
 * the paymaster's postOp runs after the account's execution and could swap too. Logs cannot tell the two apart, so
 * there the swap is credited to the account only if the account itself moved that token inside its own operation (the
 * tokens bought reached it, or the tokens sold left it); otherwise it stays on the sender. What is left is a paymaster
 * that the account's own signed operation named buying in postOp and handing the tokens over: paid for by the
 * paymaster, it can only add a buy, never move or sell the account's tokens.
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
/** ERC-20 Transfer(address indexed from, address indexed to, uint256 value). */
export const ERC20_TRANSFER_EVENT = toEventSelector("Transfer(address,address,uint256)");

export type ReceiptLog = { address: string; topics: readonly string[]; logIndex: number };

/** An address from a 32-byte topic, or null when the topic is not one. */
function topicAddress(t: string | undefined): string | null {
  const v = t?.toLowerCase();
  return v && /^0x0{24}[0-9a-f]{40}$/.test(v) ? `0x${v.slice(26)}` : null;
}

/** One user operation's slice of the receipt: its account, its paymaster (null for none), and its log range. */
export type OpWindow = { sender: string; paymaster: string | null; start: number; close: number };

/**
 * The user operation whose execution window holds the swap log: there must be a BeforeExecution from that EntryPoint
 * before the swap; the first UserOperationEvent after the swap closes the operation it ran in, and the operation began
 * after the last BeforeExecution or UserOperationEvent before the swap.
 */
export function userOpWindow(logs: readonly ReceiptLog[], entryPoint: string, swapLogIndex: number): OpWindow | null {
  const ep = entryPoint.toLowerCase();
  const own = logs.filter((l) => l.address.toLowerCase() === ep).sort((a, b) => a.logIndex - b.logIndex);
  const isBefore = (l: ReceiptLog) => l.topics[0]?.toLowerCase() === BEFORE_EXECUTION_EVENT;
  const isClose = (l: ReceiptLog) => l.topics[0]?.toLowerCase() === USER_OPERATION_EVENT;
  if (!own.some((l) => isBefore(l) && l.logIndex < swapLogIndex)) return null;
  const close = own.find((l) => isClose(l) && l.logIndex > swapLogIndex);
  const sender = close ? topicAddress(close.topics[2]) : null;
  if (!close || !sender) return null;
  const start = Math.max(...own.filter((l) => (isBefore(l) || isClose(l)) && l.logIndex < swapLogIndex).map((l) => l.logIndex));
  const pm = topicAddress(close.topics[3]);
  return { sender, paymaster: pm && pm !== `0x${"0".repeat(40)}` ? pm : null, start, close: close.logIndex };
}

/** The sender of the user operation whose execution window holds the swap log (see userOpWindow). */
export function userOpSender(logs: readonly ReceiptLog[], entryPoint: string, swapLogIndex: number): string | null {
  return userOpWindow(logs, entryPoint, swapLogIndex)?.sender ?? null;
}

/** Whether `wallet` sent or received `token` inside the operation's log range (exclusive on both ends). */
function accountMovedToken(logs: readonly ReceiptLog[], token: string, wallet: string, w: OpWindow): boolean {
  const tk = token.toLowerCase();
  return logs.some(
    (l) =>
      l.logIndex > w.start &&
      l.logIndex < w.close &&
      l.address.toLowerCase() === tk &&
      l.topics[0]?.toLowerCase() === ERC20_TRANSFER_EVENT &&
      (topicAddress(l.topics[1]) === wallet || topicAddress(l.topics[2]) === wallet),
  );
}

export type Attribution = { trader: string; via: "tx_from" | "userop" };

/**
 * The decision, given the transaction's from / to and, when `to` is an EntryPoint, the receipt logs and the swapped
 * token (needed for an operation with a paymaster; without it such a swap stays on the sender).
 */
export function attributeSwap(p: { from: string; to: string | null; swapLogIndex: number; logs?: readonly ReceiptLog[] | null; token?: string | null }): Attribution {
  const from = p.from.toLowerCase();
  const to = p.to?.toLowerCase() ?? null;
  if (to && ENTRY_POINTS.has(to) && p.logs) {
    const w = userOpWindow(p.logs, to, p.swapLogIndex);
    if (w && (!w.paymaster || (p.token && accountMovedToken(p.logs, p.token, w.sender, w)))) return { trader: w.sender, via: "userop" };
  }
  return { trader: from, via: "tx_from" };
}
