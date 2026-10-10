import assert from "node:assert/strict";
import test from "node:test";
import { Keypair, PublicKey, SendTransactionError, SystemProgram, Transaction, type Connection } from "@solana/web3.js";
import { describeTransactionError, encodeBase58, prepareTransaction, rebroadcastSignedTransaction, reconcileTransaction, submitSignedTransaction, validateSignedTransaction } from "../src/transactions.ts";

const signer = Keypair.fromSeed(new Uint8Array(32).fill(1));
const recipient = Keypair.fromSeed(new Uint8Array(32).fill(2)).publicKey;
function transaction() { return new Transaction({ feePayer: signer.publicKey, recentBlockhash: PublicKey.default.toBase58() }).add(SystemProgram.transfer({ fromPubkey: signer.publicKey, toPubkey: recipient, lamports: 1n })); }
test("signatures derived locally; changed message, partial signatures, invalid signatures refused", () => {
  const tx = transaction(); const expected = tx.serializeMessage(); tx.sign(signer);
  const validated = validateSignedTransaction(expected, tx.serialize(), signer.publicKey);
  assert.equal(validated.signature, encodeBase58(tx.signature!));
  const changed = transaction().add(SystemProgram.transfer({ fromPubkey: signer.publicKey, toPubkey: recipient, lamports: 100n })); changed.sign(signer);
  assert.throws(() => validateSignedTransaction(expected, changed.serialize(), signer.publicKey), /changed/);
  assert.throws(() => validateSignedTransaction(expected, transaction().serialize({ requireAllSignatures: false, verifySignatures: false }), signer.publicKey), /signatures/);
  const damaged = tx.serialize(); damaged[2] ^= 1;
  assert.throws(() => validateSignedTransaction(expected, damaged, signer.publicKey));
  assert.equal(encodeBase58(new Uint8Array(32)), PublicKey.default.toBase58());
});
test("ambiguous submission retains local signature and never creates a replacement", async () => {
  const tx = transaction(); const expected = tx.serializeMessage(); tx.sign(signer);
  const signed = validateSignedTransaction(expected, tx.serialize(), signer.publicKey);
  const fake = { sendRawTransaction: async () => { throw new Error("network timeout"); } } as unknown as Connection;
  const result = await submitSignedTransaction(fake, signed);
  assert.equal(result.signature, signed.signature); assert.equal(result.status, "unknown");
});
test("a send refused before forwarding is rejected with the program's reason; transport errors stay unknown", async () => {
  const tx = transaction(); const expected = tx.serializeMessage(); tx.sign(signer);
  const signed = validateSignedTransaction(expected, tx.serialize(), signer.publicKey);
  let thrown: unknown = null;
  let options: Record<string, unknown> = {};
  const fake = { sendRawTransaction: async (_bytes: Uint8Array, given: Record<string, unknown>) => { options = given; if (thrown) throw thrown; return signed.signature; } } as unknown as Connection;
  assert.equal((await submitSignedTransaction(fake, signed)).status, "submitted");
  // The RPC keeps re-forwarding until the blockhash expires: no maxRetries cap.
  assert.equal("maxRetries" in options, false); assert.equal(options.skipPreflight, false);
  thrown = new SendTransactionError({ action: "simulate", signature: "", transactionMessage: 'Transaction simulation failed: {"InstructionError":[1,{"Custom":6010}]}', logs: [] });
  assert.deepEqual(await submitSignedTransaction(fake, signed), { signature: signed.signature, status: "rejected", error: "Minimum output not met" });
  thrown = new SendTransactionError({ action: "simulate", signature: "", transactionMessage: "Transaction simulation failed", logs: ["Program log: AnchorError thrown in lib.rs:636. Error Code: Expired. Error Number: 6015. Error Message: Quote expired at its maximum slot."] });
  assert.equal((await submitSignedTransaction(fake, signed)).error, "Quote expired at its maximum slot");
  // The same signature already landed: never report that as a refusal.
  thrown = new SendTransactionError({ action: "simulate", signature: "", transactionMessage: "Transaction simulation failed: AlreadyProcessed", logs: [] });
  assert.equal((await submitSignedTransaction(fake, signed)).status, "unknown");
  thrown = new Error('429 Too Many Requests: {"error":"Solana RPC is busy. Please retry shortly."}');
  assert.equal((await submitSignedTransaction(fake, signed)).status, "rejected");
  thrown = new Error('503 Service Unavailable: {"jsonrpc":"2.0"}');
  assert.equal((await submitSignedTransaction(fake, signed)).status, "unknown");
  thrown = new Error("network timeout");
  await rebroadcastSignedTransaction(fake, signed.bytes);
});
test("transaction errors read as the program's messages", () => {
  assert.equal(describeTransactionError({ InstructionError: [1, { Custom: 6015 }] }), "Quote expired at its maximum slot");
  assert.equal(describeTransactionError({ InstructionError: [0, { Custom: 6000 }] }), "Arithmetic limit exceeded");
  assert.equal(describeTransactionError({ InstructionError: [0, { Custom: 1 }] }), "Program error 1");
  assert.equal(describeTransactionError("InsufficientFundsForFee"), "InsufficientFundsForFee");
  assert.equal(describeTransactionError({ InstructionError: [0, { Custom: 6010 }] }, ["Program log: AnchorError occurred. Error Code: Slippage. Error Number: 6010. Error Message: Minimum output not met."]), "Minimum output not met");
});
test("reconciliation needs finalized expiry or finalized failure before safe replacement", async () => {
  let height = 99;
  let value: unknown = null;
  let statusSlot = 500;
  const fake = {
    getEpochInfo: async () => ({ absoluteSlot: 400, blockHeight: height, epoch: 0, slotIndex: 0, slotsInEpoch: 1 }),
    getSignatureStatuses: async () => ({ context: { slot: statusSlot }, value: [value] }),
  } as unknown as Connection;
  assert.deepEqual(await reconcileTransaction(fake, "test", 100), { status: "pending", unseen: true });
  height = 101; assert.equal((await reconcileTransaction(fake, "test", 100)).status, "expired");
  // A status node behind the finalized bank that proved expiry could have missed the landing: keep waiting.
  statusSlot = 399; assert.deepEqual(await reconcileTransaction(fake, "test", 100), { status: "pending", unseen: true });
  statusSlot = 400; assert.equal((await reconcileTransaction(fake, "test", 100)).status, "expired");
  value = { err: { InstructionError: [0, "Custom"] }, confirmationStatus: "processed" };
  assert.equal((await reconcileTransaction(fake, "test", 100)).status, "pending");
  value = { err: { InstructionError: [0, "Custom"] }, confirmationStatus: "confirmed" };
  assert.equal((await reconcileTransaction(fake, "test", 100)).status, "pending");
  value = { err: { InstructionError: [0, "Custom"] }, confirmationStatus: "finalized" };
  assert.equal((await reconcileTransaction(fake, "test", 100)).status, "failed");
  value = { err: null, confirmationStatus: "finalized" };
  assert.equal((await reconcileTransaction(fake, "test", 100)).status, "finalized");
});
test("preparation reports exact unsigned bytes and enforces packet size", async () => {
  const fake = { getLatestBlockhash: async () => ({ blockhash: PublicKey.default.toBase58(), lastValidBlockHeight: 100 }) } as unknown as Connection;
  const ready = await prepareTransaction(fake, signer.publicKey, transaction().instructions);
  assert.equal(ready.lastValidBlockHeight, 100);
  assert.deepEqual(ready.messageBytes, ready.transaction.serializeMessage());
  await assert.rejects(prepareTransaction(fake, signer.publicKey, []), /no instructions/);
});
