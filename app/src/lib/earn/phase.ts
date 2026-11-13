import type { Hex } from "viem";

/**
 * Where an Earn action stands (pure; node --test loads it directly).
 *
 * "unconfirmed" is the state after the wallet has sent something (a transaction hash, or a batch id) but its outcome
 * could not be read: a receipt timeout or an RPC error is not evidence that it failed. The form stays locked, the
 * amount is kept out of reach, and only a final answer (a receipt, or the wallet's final batch status) ends it.
 */
export type EarnTab = "deposit" | "withdraw";
export type EarnSent = { kind: "tx"; hash: Hex } | { kind: "batch"; id: string };
export type EarnPhase =
  | { k: "idle" }
  | { k: "preparing" }
  | { k: "approving" }
  | { k: "signing" }
  | { k: "sent"; hash: Hex | null }
  | { k: "unconfirmed"; tab: EarnTab; amount: bigint; sent: EarnSent; checking: boolean; note: string | null }
  | { k: "done"; hash: Hex | null; tab: EarnTab; amount: bigint }
  | { k: "error"; message: string };

/** Whether a new deposit or withdrawal must wait: anything in flight, including a send whose outcome is not known. */
export function isBusy(phase: EarnPhase): boolean {
  return phase.k === "preparing" || phase.k === "approving" || phase.k === "signing" || phase.k === "sent" || phase.k === "unconfirmed";
}

/** What an action's last step came to: confirmed with its hash (null when a batch reports none), or not known yet. */
export type EarnOutcome = { confirmed: true; hash: Hex | null } | { confirmed: false };

/** "Check again" found no final answer yet. */
export const NOT_CONFIRMED_YET = "Still no confirmation. It can take a while when the network is busy; check again in a moment, or look at your wallet's activity.";

/** A final, reverted receipt: the one failure after sending that allows sending again. */
export function revertedCopy(tab: EarnTab): string {
  return `The ${tab === "deposit" ? "deposit" : "withdrawal"} reverted on-chain. Nothing moved; network gas was still charged.`;
}
