import type { Address } from "viem";
import { clientTranslator } from "@/i18n/client";

type WalletQueueClient = {
  getTransactionCount: (request: { address: Address; blockTag: "latest" | "pending" }) => Promise<number>;
};

/**
 * Do not stack a bridge transaction behind a queue visible to the source RPC.
 * This is a read-only preflight, not a guarantee that every node sees the same
 * mempool. Never choose a nonce or replace an existing wallet transaction here.
 */
export async function assertBridgeWalletQueueClear(client: WalletQueueClient, address: Address, networkName: string): Promise<void> {
  // Pending first avoids reporting a queue just because a transaction mined
  // between a latest read and a newer pending read. A reverse mismatch fails
  // closed as an inconsistent observation, not as evidence of a stuck queue.
  const pending = await client.getTransactionCount({ address, blockTag: "pending" });
  const latest = await client.getTransactionCount({ address, blockTag: "latest" });
  if (!Number.isSafeInteger(pending) || pending < 0 || !Number.isSafeInteger(latest) || latest < 0 || pending < latest) {
    throw new Error(clientTranslator("bridge")("errors.nonceInconsistent", { network: networkName }));
  }
  if (pending > latest) {
    throw new Error(clientTranslator("bridge")("errors.pendingTransaction", { network: networkName }));
  }
}
