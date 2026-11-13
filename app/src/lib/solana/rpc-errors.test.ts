import assert from "node:assert/strict";
import { test } from "node:test";
import { solanaRpcError } from "./rpc-errors.ts";

test("a refused send keeps its code, transaction error and program logs, not provider text", () => {
  const out = solanaRpcError(
    {
      code: -32002,
      message: "Transaction simulation failed: Error processing Instruction 1 (provider acme-pro-plan key ab12)",
      data: {
        err: { InstructionError: [1, { Custom: 6010 }] },
        logs: ["Program log: AnchorError occurred. Error Code: Slippage. Error Number: 6010. Error Message: Minimum output not met."],
        accounts: null,
      },
    },
    "sendTransaction",
  );
  assert.equal(out.code, -32002);
  assert.equal(out.message, 'Transaction simulation failed: {"InstructionError":[1,{"Custom":6010}]}');
  assert.equal(out.message.includes("acme"), false);
  assert.deepEqual(out.data?.err, { InstructionError: [1, { Custom: 6010 }] });
  assert.equal(out.data?.logs.length, 1);
});

test("enum errors stay readable and AlreadyProcessed survives for the client to reconcile", () => {
  const out = solanaRpcError(
    { code: -32002, message: "x", data: { err: "AlreadyProcessed", logs: [] } },
    "sendTransaction",
  );
  assert.equal(out.message, "Transaction simulation failed: AlreadyProcessed");
});

test("reads get only a fixed message; unknown codes and malformed errors fall back", () => {
  assert.deepEqual(solanaRpcError({ code: -32005, message: "node 10.0.0.7 behind", data: { err: "x" } }, "getAccountInfo"), {
    code: -32005,
    message: "Solana RPC node is behind; retry shortly",
  });
  assert.equal(solanaRpcError("boom", "getSlot").code, -32000);
  assert.equal(solanaRpcError({ code: 1.5 }, "getSlot").code, -32000);
});

test("logs and oversized transaction errors are bounded", () => {
  const out = solanaRpcError(
    {
      code: -32002,
      data: { err: { InstructionError: [0, "x".repeat(600)] }, logs: [...Array(100).keys()].map((i) => `${i} ${"y".repeat(400)}`) },
    },
    "sendTransaction",
  );
  assert.equal(out.data?.err, null);
  assert.equal(out.message, "Transaction simulation failed");
  assert.equal(out.data?.logs.length, 60);
  assert(out.data!.logs.every((line) => line.length <= 300));
});
