import { TransactionNotFoundError, type Address, type Hex } from "viem";
import { clientTranslator } from "@/i18n/client";
import { isMatchingApprovalTransaction, type TrackedApproval } from "./approval";

export type ApprovalHealth = {
  kind: "waiting" | "not-seen" | "queued" | "fee-too-low" | "nonce-passed" | "delayed" | "unavailable";
  title: string;
  detail: string;
};

/**
 * Advice of one kind (the bridge area's `health` messages). Its words are read when shown, not when observed, so
 * advice already on screen follows a language switch, and the shared unavailable advice is never fixed in one language.
 */
function advice(kind: ApprovalHealth["kind"], values?: { nonce: string; latestNonce: string }): ApprovalHealth {
  return {
    kind,
    get title() { return clientTranslator("bridge")(`health.${kind}.title`); },
    get detail() { return clientTranslator("bridge")(`health.${kind}.detail`, values); },
  };
}

type PendingTransaction = { hash: Hex; from: Address; to: Address | null; input: Hex; value: bigint; nonce: number; maxFeePerGas?: bigint; gasPrice?: bigint };
type ApprovalHealthClient = {
  getTransaction: (args: { hash: Hex }) => Promise<PendingTransaction>;
  getTransactionCount: (args: { address: Address; blockTag: "latest" }) => Promise<number>;
  getBlock: (args: { blockTag: "latest" }) => Promise<{ baseFeePerGas: bigint | null }>;
};

export const APPROVAL_HEALTH_UNAVAILABLE: ApprovalHealth = advice("unavailable");

/** Advice only: never changes the journal, confirms an approval or permits a retry. */
export function describePendingApproval(input: { createdAt: number; now: number; transaction: Pick<PendingTransaction, "nonce" | "maxFeePerGas" | "gasPrice"> | null; latestNonce?: number; baseFeePerGas?: bigint | null }): ApprovalHealth {
  const delayed = input.now - input.createdAt >= 60_000;
  const waiting = advice("waiting");
  if (!input.transaction) return delayed ? advice("not-seen") : waiting;
  const { nonce, maxFeePerGas, gasPrice } = input.transaction;
  if (!Number.isSafeInteger(nonce) || nonce < 0 || !Number.isSafeInteger(input.latestNonce) || input.latestNonce! < 0) return APPROVAL_HEALTH_UNAVAILABLE;
  // nonces as written (no locale digit grouping)
  if (nonce > input.latestNonce!) return advice("queued", { nonce: String(nonce), latestNonce: String(input.latestNonce) });
  if (nonce < input.latestNonce!) return advice("nonce-passed");
  const feeCap = maxFeePerGas ?? gasPrice;
  if (feeCap !== undefined && input.baseFeePerGas != null && feeCap < input.baseFeePerGas) return advice("fee-too-low");
  return delayed ? advice("delayed") : waiting;
}

/** Optional diagnostics. A failed RPC read is not evidence that a transaction is missing. */
export async function readPendingApprovalHealth(client: ApprovalHealthClient, approval: TrackedApproval, now: number): Promise<ApprovalHealth> {
  if (!approval.approvalHash) return APPROVAL_HEALTH_UNAVAILABLE;
  try {
    const transaction = await client.getTransaction({ hash: approval.approvalHash }).catch((error: unknown) => {
      if (error instanceof TransactionNotFoundError) return null;
      throw error;
    });
    if (!transaction) return describePendingApproval({ createdAt: approval.createdAt, now, transaction });
    if (transaction.hash.toLowerCase() !== approval.approvalHash.toLowerCase() || !isMatchingApprovalTransaction(approval, transaction)) return APPROVAL_HEALTH_UNAVAILABLE;
    const [latestNonce, block] = await Promise.all([
      client.getTransactionCount({ address: approval.address, blockTag: "latest" }),
      client.getBlock({ blockTag: "latest" }),
    ]);
    return describePendingApproval({ createdAt: approval.createdAt, now, transaction, latestNonce, baseFeePerGas: block.baseFeePerGas });
  } catch { return APPROVAL_HEALTH_UNAVAILABLE; }
}
