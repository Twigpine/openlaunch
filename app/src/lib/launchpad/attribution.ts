/**
 * Who made a swap (pure; node --test loads this directly).
 *
 * The indexer credits the transaction sender, which is the trader for every wallet that sends its own transactions.
 * Two kinds of wallet do not: an ERC-4337 smart wallet (Coinbase / Base App) whose operation a bundler submits, and
 * an EIP-7702 account whose call a relayer submits. Each is credited only on proof the account itself authorized the
 * call: for 4337, the `sender` of the UserOperationEvent that closes the operation containing the swap (the EntryPoint
 * emits it after that operation's own logs, and only for an operation the account validated); for 7702, the
 * transaction's target when it carries a delegation designator. Token transfers are never the evidence: anyone can
 * buy and have the tokens sent to someone else's wallet, and that must not put the trade under their name.
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

export type ReceiptLog = { address: string; topics: readonly string[]; logIndex: number };

/** The sender of the user operation that contains the swap log: the first UserOperationEvent after it, from that EntryPoint. */
export function userOpSender(logs: readonly ReceiptLog[], entryPoint: string, swapLogIndex: number): string | null {
  const ep = entryPoint.toLowerCase();
  const close = logs
    .filter((l) => l.address.toLowerCase() === ep && l.topics[0]?.toLowerCase() === USER_OPERATION_EVENT && l.logIndex > swapLogIndex && typeof l.topics[2] === "string")
    .sort((a, b) => a.logIndex - b.logIndex)[0];
  if (!close) return null;
  const t = close.topics[2].toLowerCase();
  return /^0x0{24}[0-9a-f]{40}$/.test(t) ? `0x${t.slice(26)}` : null;
}

/** EIP-7702: an account delegating to code has `0xef0100 ‖ address` as its code. */
export function isDelegationCode(code: string | null | undefined): boolean {
  return typeof code === "string" && /^0xef0100[0-9a-f]{40}$/i.test(code);
}

export type Attribution = { trader: string; via: "tx_from" | "userop" | "7702" };

/**
 * The decision, given what the indexer read: the transaction's from / to, the receipt logs when `to` is an EntryPoint,
 * and the code at `to` when it might be a 7702 account. `system` = routers, PoolManager, Permit2, locker, factory.
 */
export function attributeSwap(p: { from: string; to: string | null; swapLogIndex: number; logs?: readonly ReceiptLog[] | null; toCode?: string | null; system: readonly string[] }): Attribution {
  const from = p.from.toLowerCase();
  const to = p.to?.toLowerCase() ?? null;
  if (to && ENTRY_POINTS.has(to)) {
    const s = p.logs ? userOpSender(p.logs, to, p.swapLogIndex) : null;
    return s ? { trader: s, via: "userop" } : { trader: from, via: "tx_from" };
  }
  const system = new Set(p.system.map((a) => a.toLowerCase()));
  if (to && to !== from && !system.has(to) && isDelegationCode(p.toCode)) return { trader: to, via: "7702" };
  return { trader: from, via: "tx_from" };
}

/** Whether the code at `to` is worth reading: a 7702 account is a plain address, never one of the protocol contracts. */
export function needsCode(from: string, to: string | null, system: readonly string[]): boolean {
  if (!to) return false;
  const t = to.toLowerCase();
  return t !== from.toLowerCase() && !ENTRY_POINTS.has(t) && !system.some((a) => a.toLowerCase() === t);
}
