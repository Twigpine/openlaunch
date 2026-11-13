import assert from "node:assert/strict";
import test from "node:test";
import { Buffer } from "buffer";
import { Connection, Keypair, PublicKey, SystemProgram, type Blockhash } from "@solana/web3.js";
import { prepareTransaction, rebroadcastSignedTransaction, reconcileTransaction, simulatePreparedTransaction, submitSignedTransaction, validateSignedTransaction } from "../src/transactions.ts";

type Request = { id: string | number; method: string; params: unknown[] };
/** Real v3 JSON transport with an in-memory endpoint. No network, wallet or chain transaction. */
function mockConnection(reply: (request: Request) => Response | unknown) {
  const requests: Request[] = [];
  const connection = new Connection("https://solana-rpc.invalid", {
    commitment: "confirmed", disableRetryOnRateLimit: true,
    fetch: async (_url, init) => {
      const request = JSON.parse(String(init?.body)) as Request;
      requests.push(request);
      const result = reply(request);
      return result instanceof Response ? result : Response.json({ jsonrpc: "2.0", id: request.id, result });
    },
  });
  return { connection, requests };
}
const blockhash = "11111111111111111111111111111111" as Blockhash;
const signer = await Keypair.fromSeed(new Uint8Array(32).fill(1));
const recipient = new PublicKey(new Uint8Array(32).fill(2));
const instruction = SystemProgram.transfer({ fromPubkey: signer.publicKey, toPubkey: recipient, lamports: 1n });
const latest = { context: { slot: 500 }, value: { blockhash, lastValidBlockHeight: 100 } };

test("real v3 Connection preserves prepare/simulate/send wire shape and finalized reconciliation", async () => {
  let status: unknown = null;
  let statusSlot = 500;
  let height = 99;
  let signature = "";
  const { connection, requests } = mockConnection((request) => {
    switch (request.method) {
      case "getLatestBlockhash": return latest;
      case "simulateTransaction": return { context: { slot: 500 }, value: { err: null, logs: ["simulation ok"], unitsConsumed: 25000 } };
      case "sendTransaction": return signature;
      case "getEpochInfo": return { absoluteSlot: 500, blockHeight: height, epoch: 0, slotIndex: 500, slotsInEpoch: 432000, transactionCount: 1 };
      case "getSignatureStatuses": return { context: { slot: statusSlot }, value: [status] };
      default: throw new Error(`Unexpected RPC method ${request.method}`);
    }
  });
  const ready = await prepareTransaction(connection, signer.publicKey, [instruction]);
  assert.equal(ready.lastValidBlockHeight, 100);
  assert.deepEqual(await simulatePreparedTransaction(connection, ready), { unitsConsumed: 25000, logs: ["simulation ok"] });
  await ready.transaction.sign(signer);
  const signedWire = await ready.transaction.serialize({ verifySignatures: false });
  const signed = await validateSignedTransaction(ready.messageBytes, signedWire, signer.publicKey);
  assert.deepEqual(signed.bytes, signedWire);
  signature = signed.signature;
  assert.deepEqual(await submitSignedTransaction(connection, signed), { signature, status: "submitted" });
  await rebroadcastSignedTransaction(connection, signed.bytes);
  const sends = requests.filter((request) => request.method === "sendTransaction");
  assert.equal(sends.length, 2);
  assert.deepEqual(sends[0].params, sends[1].params);
  assert.deepEqual(sends[0].params, [Buffer.from(signedWire).toString("base64"), { encoding: "base64", preflightCommitment: "confirmed" }]);
  const simulation = requests.find((request) => request.method === "simulateTransaction")!;
  // v3 omits false-valued flags; both RPC defaults are false (no signature check and no replacement blockhash).
  assert.deepEqual(simulation.params, [Buffer.from(ready.wireBytes).toString("base64"), { encoding: "base64", commitment: "confirmed" }]);
  assert.deepEqual(requests[0].params, [{ commitment: "confirmed" }]);
  assert.deepEqual(await reconcileTransaction(connection, signature, 100), { status: "pending", unseen: true });
  height = 101; statusSlot = 499;
  assert.deepEqual(await reconcileTransaction(connection, signature, 100), { status: "pending", unseen: true });
  statusSlot = 500;
  assert.deepEqual(await reconcileTransaction(connection, signature, 100), { status: "expired" });
  status = { slot: 499, confirmations: 1, err: { InstructionError: [0, { Custom: 6010 }] }, confirmationStatus: "confirmed" };
  assert.equal((await reconcileTransaction(connection, signature, 100)).status, "pending");
  status = { slot: 499, confirmations: null, err: null, confirmationStatus: "finalized" };
  assert.equal((await reconcileTransaction(connection, signature, 100)).status, "finalized");
  assert.deepEqual(requests.find((request) => request.method === "getSignatureStatuses")!.params, [[signature], { searchTransactionHistory: true }]);
  // Kit removes finalized from the wire because Solana RPC's server default is finalized; proxy must not replace it.
  assert.deepEqual(requests.find((request) => request.method === "getEpochInfo")!.params, [{}]);
});

test("real v3 JSON preflight failures, rate limits and ambiguous sends retain their safety meaning", async () => {
  let mode = "preflight";
  const { connection } = mockConnection((request) => {
    if (request.method === "getLatestBlockhash") return latest;
    assert.equal(request.method, "sendTransaction");
    if (mode === "timeout") throw new Error("network timeout");
    if (mode === "429") return new Response("Busy", { status: 429 });
    if (mode === "503") return new Response("Unavailable", { status: 503 });
    if (mode === "signature") return "unexpected signature";
    return Response.json({ jsonrpc: "2.0", id: request.id, error: {
      code: -32002,
      message: mode === "already" ? "Transaction simulation failed: AlreadyProcessed" : "Transaction simulation failed: custom program error: 0x177a",
      data: { err: mode === "already" ? "AlreadyProcessed" : { InstructionError: [0, { Custom: 6010 }] }, logs: mode === "already" || mode === "customNoLogs" ? [] : ["Program log: Error Message: Minimum output not met."] },
    } });
  });
  const ready = await prepareTransaction(connection, signer.publicKey, [instruction]);
  await ready.transaction.sign(signer);
  const signed = await validateSignedTransaction(ready.messageBytes, await ready.transaction.serialize({ verifySignatures: false }), signer.publicKey);
  assert.deepEqual(await submitSignedTransaction(connection, signed), { signature: signed.signature, status: "rejected", error: "Minimum output not met" });
  mode = "customNoLogs";
  assert.deepEqual(await submitSignedTransaction(connection, signed), { signature: signed.signature, status: "rejected", error: "Minimum output not met" });
  for (const next of ["already", "timeout", "503", "signature"]) {
    mode = next;
    const result = await submitSignedTransaction(connection, signed);
    assert.equal(result.status, "unknown", next); assert.equal(result.signature, signed.signature, next);
  }
  mode = "429";
  assert.deepEqual(await submitSignedTransaction(connection, signed), { signature: signed.signature, status: "rejected", error: "Solana RPC is busy" });
});

test("real v3 JSON transport keeps oversized RPC integers exact until SDK rejects numeric expiry", async () => {
  const { connection, requests } = mockConnection((request) => {
    assert.equal(request.method, "getLatestBlockhash");
    return new Response(`{"jsonrpc":"2.0","id":${JSON.stringify(request.id)},"result":{"context":{"slot":500},"value":{"blockhash":"${blockhash}","lastValidBlockHeight":9007199254740993}}}`, { headers: { "Content-Type": "application/json" } });
  });
  assert.equal((await connection.getLatestBlockhash("confirmed")).lastValidBlockHeight, 9007199254740993n);
  await assert.rejects(prepareTransaction(connection, signer.publicKey, [instruction]), /precision/);
  assert.ok(requests.every((request) => request.method === "getLatestBlockhash"));
});

test("real v3 simulation retains custom error codes without bigint serialization failures", async () => {
  const { connection } = mockConnection((request) => {
    if (request.method === "getLatestBlockhash") return latest;
    assert.equal(request.method, "simulateTransaction");
    return { context: { slot: 500 }, value: { err: { InstructionError: [0, { Custom: 6010 }] }, logs: [], unitsConsumed: 25000 } };
  });
  const ready = await prepareTransaction(connection, signer.publicKey, [instruction]);
  await assert.rejects(simulatePreparedTransaction(connection, ready), { message: "Simulation failed: Minimum output not met" });
});
