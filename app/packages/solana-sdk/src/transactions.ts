import { Buffer } from "buffer";
import { PublicKey, Transaction, VersionedTransaction, type Connection, type TransactionInstruction } from "@solana/web3.js";

export const MAX_TRANSACTION_BYTES = 1232;
export type PreparedTransaction = {
  transaction: Transaction; wireBytes: Uint8Array; messageBytes: Uint8Array;
  blockhash: string; lastValidBlockHeight: number;
};
export async function prepareTransaction(connection: Connection, payer: PublicKey, instructions: TransactionInstruction[]): Promise<PreparedTransaction> {
  if (instructions.length === 0) throw new Error("Transaction has no instructions");
  const latest = await connection.getLatestBlockhash("confirmed");
  const transaction = new Transaction({ feePayer: payer, recentBlockhash: latest.blockhash }).add(...instructions);
  const wireBytes = transaction.serialize({ requireAllSignatures: false, verifySignatures: false });
  if (wireBytes.length > MAX_TRANSACTION_BYTES) throw new Error("Transaction exceeds Solana packet budget");
  return { transaction, wireBytes, messageBytes: transaction.serializeMessage(), ...latest };
}
export async function simulatePreparedTransaction(connection: Connection, prepared: PreparedTransaction): Promise<{ unitsConsumed: number | undefined; logs: string[] }> {
  const transaction = VersionedTransaction.deserialize(prepared.wireBytes);
  const result = await connection.simulateTransaction(transaction, { sigVerify: false, replaceRecentBlockhash: false, commitment: "confirmed" });
  if (result.value.err) throw new Error(`Simulation failed: ${JSON.stringify(result.value.err)}`);
  return { unitsConsumed: result.value.unitsConsumed, logs: result.value.logs ?? [] };
}

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
/** Local encoding avoids trusting a returned RPC signature after ambiguous submission. */
export function encodeBase58(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let result = "";
  while (n > 0n) { result = BASE58[Number(n % 58n)] + result; n /= 58n; }
  for (const b of bytes) { if (b !== 0) break; result = "1" + result; }
  return result;
}
export type ValidatedSignedTransaction = { bytes: Uint8Array; signature: string };
/** Reject changed recipients, amounts, blockhashes, added instructions and missing/invalid signatures. */
export function validateSignedTransaction(expectedMessage: Uint8Array, signedBytes: Uint8Array, payer: PublicKey): ValidatedSignedTransaction {
  if (signedBytes.length > MAX_TRANSACTION_BYTES || signedBytes.length < 1) throw new Error("Invalid signed transaction size");
  const transaction = Transaction.from(signedBytes);
  if (!transaction.feePayer?.equals(payer) || !transaction.serializeMessage().equals(Buffer.from(expectedMessage))) throw new Error("Wallet changed the transaction message");
  if (!transaction.verifySignatures(true) || !transaction.signature) throw new Error("Wallet returned missing or invalid signatures");
  const bytes = transaction.serialize({ requireAllSignatures: true, verifySignatures: true });
  return { bytes, signature: encodeBase58(transaction.signature) };
}
export type SubmissionResult = { signature: string; status: "submitted" | "unknown"; error?: string };
/** Persist the local signature + expiry BEFORE calling. A transport error is not a failed transaction. */
export async function submitSignedTransaction(connection: Connection, signed: ValidatedSignedTransaction): Promise<SubmissionResult> {
  try {
    const returned = await connection.sendRawTransaction(signed.bytes, { skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 0 });
    if (returned !== signed.signature) return { signature: signed.signature, status: "unknown", error: "RPC returned an unexpected signature; reconcile the locally signed transaction" };
    return { signature: signed.signature, status: "submitted" };
  } catch {
    return { signature: signed.signature, status: "unknown", error: "Submission result unknown. Check this signature before submitting a replacement." };
  }
}
export type Reconciliation = { status: "confirmed" | "finalized" | "failed" | "pending" | "expired"; error?: unknown };
export async function reconcileTransaction(connection: Connection, signature: string, lastValidBlockHeight: number): Promise<Reconciliation> {
  if (!Number.isSafeInteger(lastValidBlockHeight) || lastValidBlockHeight <= 0) throw new Error("Invalid transaction expiry");
  // Check finalized block height before historical status: if expired, no new landing can race this read.
  const height = await connection.getBlockHeight("finalized");
  const result = await connection.getSignatureStatuses([signature], { searchTransactionHistory: true });
  const status = result.value[0];
  if (status) {
    // A processed/confirmed error may exist only on a fork. Its signed message
    // can still land successfully elsewhere until finalized or expired.
    if (status.err) return { status: status.confirmationStatus === "finalized" ? "failed" : "pending", error: status.err };
    if (status.confirmationStatus === "finalized") return { status: "finalized" };
    if (status.confirmationStatus === "confirmed") return { status: "confirmed" };
    return { status: "pending" };
  }
  return { status: height > lastValidBlockHeight ? "expired" : "pending" };
}
