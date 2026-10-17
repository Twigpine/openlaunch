import assert from "node:assert/strict";
import { test } from "node:test";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { Buffer } from "buffer";
import { allowedSolanaRpc } from "./rpc-policy.ts";
import { solanaRpcError } from "./rpc-errors.ts";
import { submitSignedTransaction, validateSignedTransaction } from "../../../packages/solana-sdk/src/transactions.ts";

const program = new PublicKey("Fg6PaFpoGXkYsidMpWxTWqkZPknxNpEMTZfkhHQjBcqr");
const request = (method: string, params: unknown[] = []) => ({
  jsonrpc: "2.0",
  id: 1,
  method,
  params,
});
const allowed = async (value: unknown) =>
  (await allowedSolanaRpc(value, program.toBase58())) !== null;

test("RPC rejects broad relay methods and oversized account/history batches", async () => {
  for (const value of [
    request("requestAirdrop"),
    request("getProgramAccounts", [SystemProgram.programId.toBase58()]),
    request("getMultipleAccounts", [Array(17).fill(program.toBase58())]),
    request("getSignaturesForAddress", [program.toBase58(), { limit: 101 }]),
    request("getSignaturesForAddress", [program.toBase58(), { limit: 100 }]),
    request("getTransaction", [program.toBase58()]),
    request("getTokenAccountsByOwner", [program.toBase58()]),
    request("getBalance", ["not-a-key"]),
    request("getFeeForMessage", ["x".repeat(1645)]),
  ]) assert.equal(await allowed(value), false);
  const value = request("getLatestBlockhash", [{ commitment: "confirmed" }]);
  assert.equal(await allowedSolanaRpc(value, program.toBase58()), value);
});

test("RPC sends only fully signed program transactions; simulation never signs", async () => {
  const signer = await Keypair.generate(); // Ephemeral offline fixture; never persisted or sent.
  const tx = new Transaction({
    feePayer: signer.publicKey,
    recentBlockhash: program.toBase58(),
  }).add(new TransactionInstruction({ programId: program, keys: [], data: Buffer.alloc(8) }));
  const wire = async () => Buffer.from(await tx.serialize({
    requireAllSignatures: false,
    verifySignatures: false,
  })).toString("base64");
  assert.equal(await allowed(request("sendTransaction", [await wire(), { encoding: "base64" }])), false);
  assert.equal(await allowed(request("simulateTransaction", [await wire(), { encoding: "base64", sigVerify: false }])), true);
  await tx.sign(signer);
  assert.equal(await allowed(request("sendTransaction", [await wire(), { encoding: "base64" }])), true);
  assert.equal(await allowed(request("sendTransaction", [await wire(), { encoding: "base64", skipPreflight: true }])), false);

  // v3 verifySignatures returns a Promise. A truthiness check would allow these corrupt bytes.
  const invalid = Buffer.from(await wire(), "base64");
  invalid[1] ^= 1;
  assert.equal(await allowedSolanaRpc(request("sendTransaction", [invalid.toString("base64"), { encoding: "base64" }]), program.toBase58()), null);
  const trailing = Buffer.concat([Buffer.from(await wire(), "base64"), Buffer.from([0])]);
  assert.equal(await allowed(request("sendTransaction", [trailing.toString("base64"), { encoding: "base64" }])), false);
  assert.equal(await allowed(request("simulateTransaction", [trailing.toString("base64"), { encoding: "base64" }])), false);

  tx.instructions = [SystemProgram.transfer({ fromPubkey: signer.publicKey, toPubkey: program, lamports: 1n })];
  await tx.sign(signer);
  assert.equal(await allowed(request("sendTransaction", [await wire(), { encoding: "base64" }])), false);
});

test("RPC awaits verification of every required signature", async () => {
  const payer = await Keypair.generate();
  const missing = await Keypair.generate();
  const tx = new Transaction({ feePayer: payer.publicKey, recentBlockhash: program.toBase58() }).add(
    new TransactionInstruction({
      programId: program,
      keys: [{ pubkey: missing.publicKey, isSigner: true, isWritable: false }],
      data: Buffer.alloc(8),
    }),
  );
  await tx.partialSign(payer);
  const bytes = await tx.serialize({ requireAllSignatures: false, verifySignatures: false });
  assert.equal(await allowedSolanaRpc(request("sendTransaction", [Buffer.from(bytes).toString("base64"), { encoding: "base64" }]), program.toBase58()), null);
});

test("RPC rejects unsafe request numerics rather than relaying rounded slots", async () => {
  for (const minContextSlot of [Number.MAX_SAFE_INTEGER + 1, -1, 0.5, Infinity, 9007199254740993n]) {
    assert.equal(await allowed(request("getBalance", [program.toBase58(), { minContextSlot }])), false);
  }
  assert.equal(await allowed({ ...request("getSlot"), id: Number.MAX_SAFE_INTEGER + 1 }), false);
  assert.equal(await allowed(request("getBalance", [program.toBase58(), { minContextSlot: Number.MAX_SAFE_INTEGER }])), true);
});

test("RPC allows the epoch read that pairs a slot with its block height", async () => {
  assert.equal(await allowed(request("getEpochInfo", [{ commitment: "finalized" }])), true);
});

test("v3 send errors keep safe retry classification after proxy validation and sanitization", async () => {
  const signer = await Keypair.generate();
  const tx = new Transaction({ feePayer: signer.publicKey, recentBlockhash: program.toBase58() }).add(
    new TransactionInstruction({ programId: program, keys: [], data: Buffer.alloc(8) }),
  );
  await tx.sign(signer);
  const signed = await validateSignedTransaction(tx.serializeMessage(), await tx.serialize({ verifySignatures: false }), signer.publicKey);
  let error: unknown = { code: -32002, message: "Private upstream wording", data: { err: "AlreadyProcessed", logs: [] } };
  const connection = new Connection("https://offline.invalid", {
    commitment: "confirmed",
    fetch: async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      const rpc = await allowedSolanaRpc(body, program.toBase58());
      assert.notEqual(rpc, null);
      assert.equal(rpc!.method, "sendTransaction");
      return Response.json({ jsonrpc: "2.0", id: rpc!.id, error: solanaRpcError(error, rpc!.method) });
    },
  });
  assert.equal((await submitSignedTransaction(connection, signed)).status, "unknown");
  error = { code: -32002, message: "Private upstream wording", data: { err: { InstructionError: [0, { Custom: 6010 }] }, logs: [] } };
  const rejected = await submitSignedTransaction(connection, signed);
  assert.equal(rejected.status, "rejected");
  assert.equal(rejected.error, "Minimum output not met");
});
