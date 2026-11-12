import type { Hex, PublicClient } from "viem";

/** Adopt only an exact same-sender/nonce repricing; changed calls are a separate outcome. */
export async function waitForTrackedReceipt(pub: Pick<PublicClient, "waitForTransactionReceipt">, hash: Hex, onHash: (hash: Hex) => void) {
  let expected = hash;
  let changed = false;
  let invalid = false;
  const receipt = await pub.waitForTransactionReceipt({
    hash,
    onReplaced: ({ reason, replacedTransaction: previous, transaction: next, transactionReceipt }) => {
      if (previous.hash.toLowerCase() !== expected.toLowerCase() || next.hash.toLowerCase() !== transactionReceipt.transactionHash.toLowerCase()
        || previous.from.toLowerCase() !== next.from.toLowerCase() || !Number.isSafeInteger(previous.nonce) || previous.nonce < 0 || previous.nonce !== next.nonce) {
        invalid = true;
        return;
      }
      const sameCall = previous.to?.toLowerCase() === next.to?.toLowerCase() && previous.input.toLowerCase() === next.input.toLowerCase() && previous.value === next.value;
      if (reason === "repriced" && !sameCall) { invalid = true; return; }
      expected = next.hash;
      changed ||= reason !== "repriced";
      if (!changed) onHash(expected);
    },
  });
  if (invalid || receipt.transactionHash.toLowerCase() !== expected.toLowerCase()) throw new Error("The receipt could not be matched to the submitted transaction. Check the saved transaction before sending again.");
  return { receipt, changed };
}
