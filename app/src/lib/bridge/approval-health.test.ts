import assert from "node:assert/strict";
import test from "node:test";
import { TransactionNotFoundError, type Hex } from "viem";
import { setClientLanguage } from "../../i18n/client.ts";
import { en, messagesFor } from "../../i18n/messages/index.ts";
import { ARC_USDC, RELAY_APPROVAL_SPENDER, exactApprovalTransaction, type TrackedApproval } from "./approval";
import { APPROVAL_HEALTH_UNAVAILABLE, describePendingApproval, readPendingApprovalHealth } from "./approval-health";

const NOW = 1_800_000_000_000;
const hash = `0x${"1".repeat(64)}` as Hex;
const approval: TrackedApproval = { version: 1, address: "0x1111111111111111111111111111111111111111", chainId: 5042, token: ARC_USDC, spender: RELAY_APPROVAL_SPENDER, amount: "500000", createdAt: NOW - 70_000, status: "pending", approvalHash: hash };
const transaction = { hash, from: approval.address, to: ARC_USDC, value: 0n, input: exactApprovalTransaction(approval).data, nonce: 2, maxFeePerGas: 30_000_000_000n };
const observation = { createdAt: approval.createdAt, now: NOW, transaction, latestNonce: 0, baseFeePerGas: 166_000_000_000n };

test("nonce 2 cannot be described as normally confirming while source nonce is 0", () => {
  const health = describePendingApproval(observation);
  assert.equal(health.kind, "queued");
  assert.match(health.detail, /nonce 2/);
  assert.match(health.detail, /nonce is 0/);
  assert.match(health.detail, /earliest pending/);
});

test("underpriced fee, consumed nonce and slow confirmation have distinct guidance", () => {
  assert.equal(describePendingApproval({ ...observation, latestNonce: 2 }).kind, "fee-too-low");
  assert.equal(describePendingApproval({ ...observation, latestNonce: 3 }).kind, "nonce-passed");
  assert.equal(describePendingApproval({ ...observation, latestNonce: 2, baseFeePerGas: 20_000_000_000n }).kind, "delayed");
  assert.equal(describePendingApproval({ ...observation, createdAt: NOW, latestNonce: 2, baseFeePerGas: 20_000_000_000n }).kind, "waiting");
  assert.equal(describePendingApproval({ ...observation, latestNonce: 2, transaction: { nonce: 2, gasPrice: 30_000_000_000n } }).kind, "fee-too-low");
});

test("missing hash has a propagation grace period and never asserts failure or cancellation", () => {
  assert.equal(describePendingApproval({ ...observation, transaction: null, createdAt: NOW }).kind, "waiting");
  const health = describePendingApproval({ ...observation, transaction: null });
  assert.equal(health.kind, "not-seen");
  assert.match(health.detail, /may still be queued/);
  assert.match(health.detail, /do not approve again/);
});

test("advice is worded when shown, so it follows the reader's language, and nonces read as written", () => {
  const queued = describePendingApproval({ ...observation, transaction: { ...transaction, nonce: 12345 }, latestNonce: 1234 });
  assert.match(queued.detail, /uses nonce 12345, but your wallet’s next confirmed nonce is 1234\./);
  const global = globalThis as { window?: unknown };
  global.window = {};
  try {
    // the browser, after the reader switches to Chinese: advice already on screen re-words itself
    setClientLanguage("zh-CN", messagesFor("zh-CN"));
    assert.equal(queued.title, messagesFor("zh-CN").bridge.health.queued.title);
    assert.match(queued.detail, /nonce 是 12345，.*nonce 是 1234。/);
    assert.equal(APPROVAL_HEALTH_UNAVAILABLE.title, messagesFor("zh-CN").bridge.health.unavailable.title);
  } finally {
    setClientLanguage("en", en);
    delete global.window;
  }
  assert.equal(APPROVAL_HEALTH_UNAVAILABLE.title, "Approval status unavailable");
  assert.equal(APPROVAL_HEALTH_UNAVAILABLE.kind, "unavailable");
});

test("invalid nonce observations stay unknown rather than falsely identifying a queue", () => {
  for (const latestNonce of [undefined, -1, NaN, 1.5, Infinity]) assert.equal(describePendingApproval({ ...observation, latestNonce }).kind, "unavailable");
});

test("read-only diagnostics use matching transaction evidence and preserve the journal", async () => {
  const before = JSON.stringify(approval);
  const client = {
    getTransaction: async () => transaction,
    getTransactionCount: async () => 0,
    getBlock: async () => ({ baseFeePerGas: 166_000_000_000n }),
  };
  assert.equal((await readPendingApprovalHealth(client, approval, NOW)).kind, "queued");
  assert.equal((await readPendingApprovalHealth({ ...client, getTransaction: async () => ({ ...transaction, value: 1n }) }, approval, NOW)).kind, "unavailable");
  assert.equal((await readPendingApprovalHealth({ ...client, getTransaction: async () => ({ ...transaction, hash: `0x${"2".repeat(64)}` as Hex }) }, approval, NOW)).kind, "unavailable");
  assert.equal(JSON.stringify(approval), before);
});

test("only typed transaction-not-found becomes missing; rate limits and RPC failures remain unavailable", async () => {
  const client = {
    getTransaction: async () => { throw new TransactionNotFoundError({ hash }); },
    getTransactionCount: async () => { throw new Error("should not read nonce"); },
    getBlock: async () => { throw new Error("should not read block"); },
  };
  assert.equal((await readPendingApprovalHealth(client, approval, NOW)).kind, "not-seen");
  assert.equal((await readPendingApprovalHealth({ ...client, getTransaction: async () => { throw new Error("rate limited"); } }, approval, NOW)).kind, "unavailable");
  assert.equal((await readPendingApprovalHealth({ ...client, getTransaction: async () => transaction }, approval, NOW)).kind, "unavailable");
});
