import { Buffer } from "buffer";
import { Message, PublicKey, SendTransactionError, Transaction, VersionedTransaction, type Connection, type TransactionInstruction } from "@solana/web3.js";
import { signatureBytes, verifySignature } from "@solana/keys";
import { rpcSafeNumber } from "./encoding.ts";

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
  // v3's lossless RPC parser can promote nested InstructionError fields to bigint too.
  const text = typeof err === "string" ? err : JSON.stringify(err, (_key, value) => typeof value === "bigint" ? value.toString() : value) ?? "";
  // SendTransactionError also humanizes the structured code when no Anchor log is available.
  const custom = /"Custom":"?(\d+)/.exec(text) ?? /Custom program error: #(\d+)/.exec(text);
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
  const lastValidBlockHeight = rpcSafeNumber(latest.lastValidBlockHeight, "Transaction expiry");
  if (lastValidBlockHeight === 0) throw new Error("Invalid transaction expiry");
  const transaction = new Transaction({ feePayer: payer, recentBlockhash: latest.blockhash }).add(...instructions);
  const wireBytes = await transaction.serialize({ requireAllSignatures: false, verifySignatures: false });
  if (wireBytes.length > MAX_TRANSACTION_BYTES) throw new Error("Transaction exceeds Solana packet budget");
  return { transaction, wireBytes, messageBytes: transaction.serializeMessage(), blockhash: latest.blockhash, lastValidBlockHeight };
}
export async function simulatePreparedTransaction(connection: Connection, prepared: PreparedTransaction): Promise<{ unitsConsumed: number | undefined; logs: string[] }> {
  const transaction = VersionedTransaction.deserialize(prepared.wireBytes);
  const result = await connection.simulateTransaction(transaction, { sigVerify: false, replaceRecentBlockhash: false, commitment: "confirmed" });
  if (result.value.err) throw new Error(`Simulation failed: ${describeTransactionError(result.value.err, result.value.logs ?? [])}`);
  return { unitsConsumed: result.value.unitsConsumed === undefined ? undefined : rpcSafeNumber(result.value.unitsConsumed, "Simulation units"), logs: result.value.logs ?? [] };
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
/**
 * Strictly verify a private snapshot of every required signature. web3.js 3.0.2 imports verification keys as
 * non-extractable, incompatible with Kit 8.5's small-order point protection. Keep that protection: import public
 * keys as extractable and use the official strict verifier, never downgrade Kit or trust a truthy Promise.
 * Callers must not mutate a transaction during verification; the wallet boundary below owns its parsed copy.
 */
export async function verifyTransactionSignatures(transaction: Transaction): Promise<boolean> {
  const messageBytes = Uint8Array.from(transaction.serializeMessage());
  const message = Message.from(messageBytes);
  const required = message.header.numRequiredSignatures;
  const signatures = transaction.signatures.map(({ publicKey, signature }) => ({ publicKey: new PublicKey(publicKey.toBytes()), signature: signature && Uint8Array.from(signature) }));
  if (required < 1 || signatures.length !== required) return false;
  for (let i = 0; i < required; i++) {
    const { publicKey, signature } = signatures[i];
    if (!publicKey.equals(message.accountKeys[i]) || !signature || signature.length !== 64) return false;
    const key = await crypto.subtle.importKey("raw", Uint8Array.from(publicKey.toBytes()), { name: "Ed25519" }, true, ["verify"]);
    if (!await verifySignature(key, signatureBytes(signature), messageBytes)) return false;
  }
  return true;
}
/** Reject changed recipients, amounts, blockhashes, added instructions and missing/invalid signatures. */
export async function validateSignedTransaction(expectedMessage: Uint8Array, signedBytes: Uint8Array, payer: PublicKey): Promise<ValidatedSignedTransaction> {
  if (signedBytes.length > MAX_TRANSACTION_BYTES || signedBytes.length < 1) throw new Error("Invalid signed transaction size");
  // Do not retain mutable wallet-owned arrays across asynchronous signature verification.
  const wireSnapshot = Uint8Array.from(signedBytes);
  const transaction = Transaction.from(wireSnapshot);
  if (!transaction.feePayer?.equals(payer) || !Buffer.from(transaction.serializeMessage()).equals(Buffer.from(expectedMessage))) throw new Error("Wallet changed the transaction message");
  // Serialization here is only an encoding check, not authorization. Strict signatures are checked below.
  const canonical = await transaction.serialize({ requireAllSignatures: false, verifySignatures: false });
  if (!Buffer.from(canonical).equals(Buffer.from(wireSnapshot))) throw new Error("Wallet returned a noncanonical transaction encoding");
  if (!await verifyTransactionSignatures(transaction) || !transaction.signature) throw new Error("Wallet returned missing or invalid signatures");
  // Return exactly the private wire snapshot we verified, never re-read wallet-owned bytes after an await.
  return { bytes: wireSnapshot, signature: encodeBase58(transaction.signature) };
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
    if (e instanceof SendTransactionError && !/AlreadyProcessed|already been processed/i.test(e.transactionError.message ?? ""))
      return { signature: signed.signature, status: "rejected", error: describeTransactionError(e.transactionError.message, e.transactionError.logs) };
    // Kit's HTTP transport exposes a structured SolanaError, rather than v1's "429 ..." Error text.
    const context = e instanceof Error && "context" in e && e.context && typeof e.context === "object" ? e.context as Record<string, unknown> : null;
    const rateLimited = context?.__code === 8100002 && context.statusCode === 429;
    if (!(e instanceof SendTransactionError) && e instanceof Error && (rateLimited || /^429\b/.test(e.message)))
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
  if (height === undefined || typeof height !== "bigint" || height < 0n || height <= BigInt(lastValidBlockHeight)) return { status: "pending", unseen: true };
  // The two reads can reach different nodes behind a load balancer. "Not found" proves expiry only from a node that had
  // already processed the finalized bank past the expiry; a lagging node would miss a transaction that landed.
  if (typeof result.context.slot !== "bigint" || typeof finalized.absoluteSlot !== "bigint" || result.context.slot < 0n || finalized.absoluteSlot < 0n || result.context.slot < finalized.absoluteSlot) return { status: "pending", unseen: true };
  return { status: "expired" };
}
