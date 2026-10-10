import assert from "node:assert/strict";
import { test } from "node:test";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { Buffer } from "buffer";
import { allowedSolanaRpc } from "./rpc-policy.ts";

const program = new PublicKey("Fg6PaFpoGXkYsidMpWxTWqkZPknxNpEMTZfkhHQjBcqr");
const request = (method: string, params: unknown[] = []) => ({
  jsonrpc: "2.0",
  id: 1,
  method,
  params,
});
test("RPC rejects broad relay methods and oversized account/history batches", () => {
  assert.equal(
    allowedSolanaRpc(request("requestAirdrop"), program.toBase58()),
    false,
  );
  assert.equal(
    allowedSolanaRpc(
      request("getProgramAccounts", [SystemProgram.programId.toBase58()]),
      program.toBase58(),
    ),
    false,
  );
  assert.equal(
    allowedSolanaRpc(
      request("getMultipleAccounts", [Array(17).fill(program.toBase58())]),
      program.toBase58(),
    ),
    false,
  );
  assert.equal(
    allowedSolanaRpc(
      request("getSignaturesForAddress", [program.toBase58(), { limit: 101 }]),
      program.toBase58(),
    ),
    false,
  );
  assert.equal(
    allowedSolanaRpc(
      request("getSignaturesForAddress", [program.toBase58(), { limit: 100 }]),
      program.toBase58(),
    ),
    false,
  );
  for (const method of ["getTransaction", "getTokenAccountsByOwner"])
    assert.equal(
      allowedSolanaRpc(
        request(method, [program.toBase58()]),
        program.toBase58(),
      ),
      false,
    );
  assert.equal(
    allowedSolanaRpc(request("getBalance", ["not-a-key"]), program.toBase58()),
    false,
  );
  assert.equal(
    allowedSolanaRpc(
      request("getFeeForMessage", ["x".repeat(1645)]),
      program.toBase58(),
    ),
    false,
  );
  assert.equal(
    allowedSolanaRpc(
      request("getLatestBlockhash", [{ commitment: "confirmed" }]),
      program.toBase58(),
    ),
    true,
  );
});
test("RPC sends only fully signed program transactions; simulation never signs", () => {
  const signer = Keypair.generate(); // ephemeral, offline test only; never persisted
  const tx = new Transaction({
    feePayer: signer.publicKey,
    recentBlockhash: program.toBase58(),
  }).add(
    new TransactionInstruction({
      programId: program,
      keys: [],
      data: Buffer.alloc(8),
    }),
  );
  const wire = () =>
    tx
      .serialize({ requireAllSignatures: false, verifySignatures: false })
      .toString("base64");
  assert.equal(
    allowedSolanaRpc(
      request("sendTransaction", [wire(), { encoding: "base64" }]),
      program.toBase58(),
    ),
    false,
  );
  assert.equal(
    allowedSolanaRpc(
      request("simulateTransaction", [
        wire(),
        { encoding: "base64", sigVerify: false },
      ]),
      program.toBase58(),
    ),
    true,
  );
  tx.sign(signer);
  assert.equal(
    allowedSolanaRpc(
      request("sendTransaction", [wire(), { encoding: "base64" }]),
      program.toBase58(),
    ),
    true,
  );
  assert.equal(
    allowedSolanaRpc(
      request("sendTransaction", [
        wire(),
        { encoding: "base64", skipPreflight: true },
      ]),
      program.toBase58(),
    ),
    false,
  );
  tx.instructions = [
    SystemProgram.transfer({
      fromPubkey: signer.publicKey,
      toPubkey: program,
      lamports: 1,
    }),
  ];
  tx.sign(signer);
  assert.equal(
    allowedSolanaRpc(
      request("sendTransaction", [wire(), { encoding: "base64" }]),
      program.toBase58(),
    ),
    false,
  );
});
