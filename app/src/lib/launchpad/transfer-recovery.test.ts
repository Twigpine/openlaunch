import assert from "node:assert/strict";
import test from "node:test";
import { encodeAbiParameters, encodeEventTopics, toHex } from "viem";
import { ERC20_TRANSFER_EVENT } from "./abi";
import { recoverBlockTransfers, RECEIPT_RECOVERY_CONCURRENCY, type ReceiptRpc } from "./transfer-recovery";

const token = `0x${"11".repeat(20)}` as const;
const from = `0x${"22".repeat(20)}` as const;
const to = `0x${"33".repeat(20)}` as const;
const blockHash = `0x${"aa".repeat(32)}`;
function fixture(count = 2) {
  const transactions = Array.from({ length: count }, (_, i) => toHex(i + 1, { size: 32 }));
  const block = { number: "0x64", hash: blockHash, transactions };
  const receipts = transactions.map((transactionHash, i) => ({ transactionHash, blockNumber: block.number, blockHash, transactionIndex: toHex(i), logs: [{
    transactionHash, transactionIndex: toHex(i), blockNumber: block.number, blockHash, address: token, logIndex: toHex(i), removed: false,
    topics: encodeEventTopics({ abi: [ERC20_TRANSFER_EVENT], eventName: "Transfer", args: { from, to } }),
    data: encodeAbiParameters([{ type: "uint256" }], [BigInt(i + 10)]),
  }] }));
  return { block, receipts };
}

test("complete bulk receipts recover exact transfers without per-transaction requests", async () => {
  const f = fixture(); const calls: string[] = [];
  const rpc: ReceiptRpc = async (method) => { calls.push(method); return method === "eth_getBlockByNumber" ? f.block : f.receipts; };
  const logs = await recoverBlockTransfers(rpc, token, 100n);
  assert.deepEqual(logs?.map((log) => log.args.value), [10n, 11n]);
  assert.deepEqual(logs?.map((log) => log.logIndex), [0, 1]);
  assert.deepEqual(calls, ["eth_getBlockByNumber", "eth_getBlockReceipts"]);
});

test("empty receipts and unrelated logs preserve global log indexes in a normal mixed block", async () => {
  const f = fixture(4), other = `0x${"44".repeat(20)}` as const;
  f.receipts[0].logs = [];
  f.receipts[1].logs[0].address = other;
  f.receipts[1].logs[0].logIndex = "0x0";
  f.receipts[2].logs[0].logIndex = "0x1";
  f.receipts[3].logs = [{ ...f.receipts[3].logs[0], address: other, logIndex: "0x2" }, f.receipts[3].logs[0]];
  const rpc: ReceiptRpc = async (method) => method === "eth_getBlockByNumber" ? f.block : f.receipts;
  const logs = await recoverBlockTransfers(rpc, token, 100n);
  assert.deepEqual(logs?.map((log) => log.logIndex), [1, 3]);
  assert.deepEqual(logs?.map((log) => log.args.value), [12n, 13n]);
});

test("unsupported bulk method recovers every receipt with bounded concurrency", async () => {
  const f = fixture(11); let active = 0, maximum = 0, read = 0;
  const rpc: ReceiptRpc = async (method, params) => {
    if (method === "eth_getBlockByNumber") return f.block;
    if (method === "eth_getBlockReceipts") throw Error("method unsupported");
    active++; maximum = Math.max(maximum, active); read++;
    await new Promise((resolve) => setTimeout(resolve, 2));
    active--;
    return f.receipts.find((r) => r.transactionHash === params[0]);
  };
  assert.equal((await recoverBlockTransfers(rpc, token, 100n))?.length, 11);
  assert.equal(read, 11);
  assert.equal(maximum, RECEIPT_RECOVERY_CONCURRENCY);
  assert.equal(active, 0);
});

test("incomplete bulk results are replaced by the full individual receipt set", async () => {
  const f = fixture(); let individual = 0;
  const rpc: ReceiptRpc = async (method, params) => {
    if (method === "eth_getBlockByNumber") return f.block;
    if (method === "eth_getBlockReceipts") return f.receipts.slice(0, 1);
    individual++; return f.receipts.find((r) => r.transactionHash === params[0]);
  };
  assert.equal((await recoverBlockTransfers(rpc, token, 100n))?.length, 2);
  assert.equal(individual, 2);
});

for (const [label, corrupt] of [
  ["missing receipt", (f: ReturnType<typeof fixture>) => { f.receipts.pop(); }],
  ["foreign block", (f: ReturnType<typeof fixture>) => { f.receipts[0].blockHash = `0x${"bb".repeat(32)}`; }],
  ["wrong transaction", (f: ReturnType<typeof fixture>) => { f.receipts[0].transactionHash = toHex(99, { size: 32 }); }],
  ["duplicate log index", (f: ReturnType<typeof fixture>) => { f.receipts[1].logs[0].logIndex = "0x0"; }],
  ["removed log", (f: ReturnType<typeof fixture>) => { f.receipts[0].logs[0].removed = true; }],
  ["log from a different receipt", (f: ReturnType<typeof fixture>) => { f.receipts[0].logs[0].transactionHash = f.receipts[1].transactionHash; }],
  ["malformed Transfer", (f: ReturnType<typeof fixture>) => { f.receipts[0].logs[0].data = "0x"; }],
] as const) {
  test(`${label} never returns a partial transfer history`, async () => {
    const f = fixture(); corrupt(f);
    const rpc: ReceiptRpc = async (method, params) => method === "eth_getBlockByNumber" ? f.block
      : method === "eth_getBlockReceipts" ? f.receipts : f.receipts.find((r) => r.transactionHash === params[0]) ?? null;
    assert.equal(await recoverBlockTransfers(rpc, token, 100n), null);
  });
}

test("duplicate block transaction identities fail before requesting receipts", async () => {
  const f = fixture(); f.block.transactions[1] = f.block.transactions[0]; let reads = 0;
  assert.equal(await recoverBlockTransfers(async () => { reads++; return f.block; }, token, 100n), null);
  assert.equal(reads, 1);
});

test("wrong-height or empty block cannot recover an over-cap token query", async () => {
  const f = fixture();
  assert.equal(await recoverBlockTransfers(async () => ({ ...f.block, number: "0x65" }), token, 100n), null);
  assert.equal(await recoverBlockTransfers(async () => ({ ...f.block, transactions: [] }), token, 100n), null);
});
