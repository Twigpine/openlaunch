import assert from "node:assert/strict";
import test from "node:test";
import { Keypair, PublicKey, SendTransactionError, SystemProgram, Transaction, type Blockhash, type Connection } from "@solana/web3.js";
import { describeTransactionError, encodeBase58, prepareTransaction, rebroadcastSignedTransaction, reconcileTransaction, simulatePreparedTransaction, submitSignedTransaction, validateSignedTransaction, verifyTransactionSignatures } from "../src/transactions.ts";

const signer = await Keypair.fromSeed(new Uint8Array(32).fill(1));
const recipient = (await Keypair.fromSeed(new Uint8Array(32).fill(2))).publicKey;
function transaction() { return new Transaction({ feePayer: signer.publicKey, recentBlockhash: "11111111111111111111111111111111" as Blockhash }).add(SystemProgram.transfer({ fromPubkey: signer.publicKey, toPubkey: recipient, lamports: 1n })); }
test("signatures derived locally; changed message, partial signatures, invalid signatures refused", async () => {
  const tx = transaction(); const expected = tx.serializeMessage(); await tx.sign(signer);
  const validated = await validateSignedTransaction(expected, await tx.serialize({ verifySignatures: false }), signer.publicKey);
  assert.equal(validated.signature, encodeBase58(tx.signature!));
  const changed = transaction().add(SystemProgram.transfer({ fromPubkey: signer.publicKey, toPubkey: recipient, lamports: 100n })); await changed.sign(signer);
  await assert.rejects(validateSignedTransaction(expected, await changed.serialize({ verifySignatures: false }), signer.publicKey), /changed/);
  await assert.rejects(validateSignedTransaction(expected, await transaction().serialize({ requireAllSignatures: false, verifySignatures: false }), signer.publicKey), /signatures/);
  const damaged = await tx.serialize({ verifySignatures: false }); damaged[2] ^= 1;
  await assert.rejects(validateSignedTransaction(expected, damaged, signer.publicKey), /signatures/);
  await assert.rejects(validateSignedTransaction(expected, await tx.serialize({ verifySignatures: false }), recipient), /changed/);
  await assert.rejects(validateSignedTransaction(expected, new Uint8Array(1233), signer.publicKey), /size/);
  const trailing = Uint8Array.of(...await tx.serialize({ verifySignatures: false }), 0);
  await assert.rejects(validateSignedTransaction(expected, trailing, signer.publicKey), /encoding/);
  assert.equal(encodeBase58(new Uint8Array(32)), PublicKey.default.toBase58());
});
test("ambiguous submission retains local signature and never creates a replacement", async () => {
  const tx = transaction(); const expected = tx.serializeMessage(); await tx.sign(signer);
  const signed = await validateSignedTransaction(expected, await tx.serialize({ verifySignatures: false }), signer.publicKey);
  const fake = { sendRawTransaction: async () => { throw new Error("network timeout"); } } as unknown as Connection;
  const result = await submitSignedTransaction(fake, signed);
  assert.equal(result.signature, signed.signature); assert.equal(result.status, "unknown");
});
test("a send refused before forwarding is rejected with the program's reason; transport errors stay unknown", async () => {
  const tx = transaction(); const expected = tx.serializeMessage(); await tx.sign(signer);
  const signed = await validateSignedTransaction(expected, await tx.serialize({ verifySignatures: false }), signer.publicKey);
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

test("strict verifier checks every signer and rejects small-order keys and signature R points", async () => {
  const second = await Keypair.fromSeed(new Uint8Array(32).fill(3));
  const multi = transaction().add(SystemProgram.transfer({ fromPubkey: second.publicKey, toPubkey: recipient, lamports: 1n }));
  await multi.partialSign(signer);
  assert.equal(await verifyTransactionSignatures(multi), false);
  await multi.partialSign(second);
  assert.equal(await verifyTransactionSignatures(multi), true);
  multi.signatures[1].signature![1] ^= 1;
  assert.equal(await verifyTransactionSignatures(multi), false);

  // Ed25519 compressed identity point (y=1), a small-order public key and signature R; no private key exists here.
  // Kit 8.5 explicitly rejects these instead of inheriting Node WebCrypto's permissive verification semantics.
  const identity = Uint8Array.of(1, ...new Uint8Array(31));
  const forgedPayer = new PublicKey(identity);
  const forged = new Transaction({ feePayer: forgedPayer, recentBlockhash: "11111111111111111111111111111111" as Blockhash })
    .add(SystemProgram.transfer({ fromPubkey: forgedPayer, toPubkey: recipient, lamports: 1n }));
  forged.addSignature(forgedPayer, Uint8Array.of(...identity, ...new Uint8Array(32)));
  assert.equal(await verifyTransactionSignatures(forged), false);
  await assert.rejects(validateSignedTransaction(forged.serializeMessage(), await forged.serialize({ verifySignatures: false }), forgedPayer), /signatures/);

  const valid = transaction(); await valid.sign(signer);
  valid.signatures[0].signature!.set(identity, 0);
  assert.equal(await verifyTransactionSignatures(valid), false);
});

test("wallet-owned arrays cannot change the transaction while async verification is pending", async () => {
  const tx = transaction(); await tx.sign(signer);
  const bytes = await tx.serialize({ verifySignatures: false });
  const expected = tx.serializeMessage();
  const original = Uint8Array.from(bytes);
  const validation = validateSignedTransaction(expected, bytes, signer.publicKey);
  bytes.fill(0); expected.fill(0);
  assert.deepEqual((await validation).bytes, original);
});
test("transaction errors read as the program's messages", () => {
  assert.equal(describeTransactionError({ InstructionError: [1, { Custom: 6015 }] }), "Quote expired at its maximum slot");
  assert.equal(describeTransactionError({ InstructionError: [0, { Custom: 6000 }] }), "Arithmetic limit exceeded");
  assert.equal(describeTransactionError({ InstructionError: [0n, { Custom: 6010n }] }), "Minimum output not met");
  assert.equal(describeTransactionError("Custom program error: #6010 (instruction #1)"), "Minimum output not met");
  assert.equal(describeTransactionError({ InstructionError: [0, { Custom: 1 }] }), "Program error 1");
  assert.equal(describeTransactionError("InsufficientFundsForFee"), "InsufficientFundsForFee");
  assert.equal(describeTransactionError({ InstructionError: [0, { Custom: 6010 }] }, ["Program log: AnchorError occurred. Error Code: Slippage. Error Number: 6010. Error Message: Minimum output not met."]), "Minimum output not met");
  // An empty message falls through to the error code; a long hostile line is read in one pass.
  assert.equal(describeTransactionError({ InstructionError: [0, { Custom: 6010 }] }, ["Program log: Error Message: ."]), "Minimum output not met");
  const hostile = `Program log: ${"Error Message: a".repeat(20_000)}`;
  const started = performance.now();
  assert.equal(describeTransactionError("x", [hostile]).startsWith("aError Message: "), true);
  assert(performance.now() - started < 50);
});
test("reconciliation needs finalized expiry or finalized failure before safe replacement", async () => {
  let height = 99n;
  let value: unknown = null;
  let statusSlot = 500n;
  const fake = {
    getEpochInfo: async () => ({ absoluteSlot: 400n, blockHeight: height, epoch: 0n, slotIndex: 0n, slotsInEpoch: 1n }),
    getSignatureStatuses: async () => ({ context: { slot: statusSlot }, value: [value] }),
  } as unknown as Connection;
  assert.deepEqual(await reconcileTransaction(fake, "test", 100), { status: "pending", unseen: true });
  height = 101n; assert.equal((await reconcileTransaction(fake, "test", 100)).status, "expired");
  // A status node behind the finalized bank that proved expiry could have missed the landing: keep waiting.
  statusSlot = 399n; assert.deepEqual(await reconcileTransaction(fake, "test", 100), { status: "pending", unseen: true });
  statusSlot = 400n; assert.equal((await reconcileTransaction(fake, "test", 100)).status, "expired");
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
  const fake = { getLatestBlockhash: async () => ({ blockhash: PublicKey.default.toBase58(), lastValidBlockHeight: 100n }) } as unknown as Connection;
  const ready = await prepareTransaction(fake, signer.publicKey, transaction().instructions);
  assert.equal(ready.lastValidBlockHeight, 100);
  assert.deepEqual(ready.messageBytes, ready.transaction.serializeMessage());
  await assert.rejects(prepareTransaction(fake, signer.publicKey, []), /no instructions/);
});

test("RPC bigint boundaries stay exact and unsafe expiry is rejected before signing or broadcasting", async () => {
  let expiry: unknown = BigInt(Number.MAX_SAFE_INTEGER);
  let broadcasts = 0;
  const fake = {
    getLatestBlockhash: async () => ({ blockhash: PublicKey.default.toBase58(), lastValidBlockHeight: expiry }),
    sendRawTransaction: async () => { broadcasts++; throw new Error("Unexpected broadcast"); },
  } as unknown as Connection;
  assert.equal((await prepareTransaction(fake, signer.publicKey, transaction().instructions)).lastValidBlockHeight, Number.MAX_SAFE_INTEGER);
  for (const invalid of [BigInt(Number.MAX_SAFE_INTEGER) + 1n, -1n, 0n, Number.MAX_SAFE_INTEGER + 1]) {
    expiry = invalid;
    await assert.rejects(prepareTransaction(fake, signer.publicKey, transaction().instructions), /expiry|precision/);
  }
  assert.equal(broadcasts, 0);
  await assert.rejects(reconcileTransaction(fake, "test", Number.MAX_SAFE_INTEGER + 1), /expiry/);
});

test("simulation awaits v3 serialization and converts units without rounding", async () => {
  let units = 25000n;
  let options: unknown;
  const fake = {
    getLatestBlockhash: async () => ({ blockhash: PublicKey.default.toBase58(), lastValidBlockHeight: 100n }),
    simulateTransaction: async (_tx: unknown, config: unknown) => { options = config; return { value: { err: null, logs: ["ok"], unitsConsumed: units } }; },
  } as unknown as Connection;
  const ready = await prepareTransaction(fake, signer.publicKey, transaction().instructions);
  assert.deepEqual(await simulatePreparedTransaction(fake, ready), { unitsConsumed: 25000, logs: ["ok"] });
  assert.deepEqual(options, { sigVerify: false, replaceRecentBlockhash: false, commitment: "confirmed" });
  units = BigInt(Number.MAX_SAFE_INTEGER) + 1n;
  await assert.rejects(simulatePreparedTransaction(fake, ready), /precision/);
});
