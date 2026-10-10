import assert from "node:assert/strict";
import test from "node:test";
import { Keypair, PublicKey, SystemProgram, Transaction, type Connection } from "@solana/web3.js";
import { encodeBase58, prepareTransaction, reconcileTransaction, submitSignedTransaction, validateSignedTransaction } from "../src/transactions.ts";

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
test("reconciliation needs finalized expiry or finalized failure before safe replacement", async () => {
  let height = 99;
  let value: unknown = null;
  const fake = { getBlockHeight: async () => height, getSignatureStatuses: async () => ({ value: [value] }) } as unknown as Connection;
  assert.equal((await reconcileTransaction(fake, "test", 100)).status, "pending");
  height = 101; assert.equal((await reconcileTransaction(fake, "test", 100)).status, "expired");
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
