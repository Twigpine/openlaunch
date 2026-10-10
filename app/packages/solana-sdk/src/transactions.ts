import { Buffer } from "buffer";
import { PublicKey, SendTransactionError, Transaction, VersionedTransaction, type Connection, type TransactionInstruction } from "@solana/web3.js";

export const MAX_TRANSACTION_BYTES = 1232;
/** `PoolError` messages in program order: Anchor numbers custom errors from 6000. */
const POOL_ERRORS = [
  "Arithmetic limit exceeded", "Invalid immutable fee tier", "Invalid fixed recipients", "Invalid token inventory",
  "Virtual SOL is outside the supported range", "Actual reserves do not cover accounted obligations",
  "Trade or claim amount rounds to zero", "Operation is not allowed in this pool state", "Invalid mint authority, supply, or decimals",
  "Invalid custody vault", "Minimum output not met", "Protocol account aliases are not permitted", "Unsupported pool version",
  "Invalid or oversized metadata", "Activation requires this exact program to be immutable", "Quote expired at its maximum slot",
];
/** A readable reason for a failed simulation or a refused send: the program's own error message when there is one. */
export function describeTransactionError(err: unknown, logs: readonly string[] = []): string {
  // Anchor logs end "... Error Message: <text>." Found by index, not regex: logs are untrusted input (CodeQL js/polynomial-redos).
  const marker = "Error Message: ";
  for (const line of logs) {
    const at = line.indexOf(marker);
    if (at === -1) continue;
    const text = line.slice(at + marker.length).trim();
    const message = text.endsWith(".") ? text.slice(0, -1) : text;
    if (message) return message;
  }
  const text = typeof err === "string" ? err : JSON.stringify(err) ?? "";
  const custom = /"Custom":(\d+)/.exec(text);
  if (custom) return POOL_ERRORS[Number(custom[1]) - 6000] ?? `Program error ${custom[1]}`;
  return text;
}
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
  if (result.value.err) throw new Error(`Simulation failed: ${describeTransactionError(result.value.err, result.value.logs ?? [])}`);
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
export type SubmissionResult = { signature: string; status: "submitted" | "rejected" | "unknown"; error?: string };
/**
 * Persist the local signature + expiry BEFORE calling. A transport error is not a failed transaction ("unknown"). An
 * error the RPC returns for this preflighted send, or a 429 from the proxy or provider, means the transaction was not
 * forwarded ("rejected"): it cannot land, so a fresh review is safe. The one exception is "AlreadyProcessed", which
 * means the same signature already landed and must be reconciled.
 */
export async function submitSignedTransaction(connection: Connection, signed: ValidatedSignedTransaction): Promise<SubmissionResult> {
  try {
    // No maxRetries: the RPC keeps forwarding the signed bytes until the blockhash expires.
    const returned = await connection.sendRawTransaction(signed.bytes, { skipPreflight: false, preflightCommitment: "confirmed" });
    if (returned !== signed.signature) return { signature: signed.signature, status: "unknown", error: "RPC returned an unexpected signature; reconcile the locally signed transaction" };
    return { signature: signed.signature, status: "submitted" };
  } catch (e) {
    if (e instanceof SendTransactionError && !/AlreadyProcessed/.test(e.transactionError.message ?? ""))
      return { signature: signed.signature, status: "rejected", error: describeTransactionError(e.transactionError.message, e.transactionError.logs) };
    if (!(e instanceof SendTransactionError) && e instanceof Error && /^429\b/.test(e.message))
      return { signature: signed.signature, status: "rejected", error: "Solana RPC is busy" };
    return { signature: signed.signature, status: "unknown", error: "Submission result unknown. Check this signature before submitting a replacement." };
  }
}
/** Re-send the identical signed bytes while the signature is unseen. A signature lands at most once, so this cannot duplicate. */
export async function rebroadcastSignedTransaction(connection: Connection, bytes: Uint8Array): Promise<void> {
  try {
    await connection.sendRawTransaction(bytes, { skipPreflight: false, preflightCommitment: "confirmed" });
  } catch {
    // Already processed, expired or refused for now: reconciliation decides what happened.
  }
}
/** `unseen`: no node has reported the signature yet, so re-sending its bytes may still help it land. */
export type Reconciliation = { status: "confirmed" | "finalized" | "failed" | "pending" | "expired"; error?: unknown; unseen?: true };
export async function reconcileTransaction(connection: Connection, signature: string, lastValidBlockHeight: number): Promise<Reconciliation> {
  if (!Number.isSafeInteger(lastValidBlockHeight) || lastValidBlockHeight <= 0) throw new Error("Invalid transaction expiry");
  // One finalized bank gives both the slot and the block height. Read it before historical status: if it is past the
  // expiry, no new landing can race the status read.
  const finalized = await connection.getEpochInfo("finalized");
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
  const height = finalized.blockHeight;
  if (height === undefined || !Number.isSafeInteger(height) || height <= lastValidBlockHeight) return { status: "pending", unseen: true };
  // The two reads can reach different nodes behind a load balancer. "Not found" proves expiry only from a node that had
  // already processed the finalized bank past the expiry; a lagging node would miss a transaction that landed.
  if (result.context.slot < finalized.absoluteSlot) return { status: "pending", unseen: true };
  return { status: "expired" };
}
