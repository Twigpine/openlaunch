import assert from "node:assert/strict";
import test from "node:test";
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, type Address, type Hex } from "viem";
import { APPROVAL_DISCARD_AFTER_MS, APPROVAL_STORAGE_PREFIX, ARC_APPROVAL_CHAIN_ID, ARC_USDC, EXACT_APPROVAL_ABI, RELAY_APPROVAL_SPENDER, USDC_APPROVAL_EVENT, approvalBlocksSubmission, approvalCanDiscard, approvalRequestKey, approvalStorageKey, createApprovalStore, exactApprovalTransaction, hasMatchingApprovalEvent, isMatchingApprovalTransaction, parseStoredApproval, reconcileApproval, serializeApproval, submitExactApproval, validateApprovalMetadata, type ApprovalDependencies, type ApprovalRequest, type TrackedApproval } from "./approval";
import { BASE_USDC, ROBINHOOD_USDG } from "./types";
import { canApplyApprovalPoll, CCTP_APPROVAL_SPENDER, recoverApprovalFromEvidence } from "./approval";
import { CCTP_TOKEN_MESSENGER } from "./cctp";

const ADDRESS = "0x1111111111111111111111111111111111111111" as Address;
const OTHER = "0x2222222222222222222222222222222222222222" as Address;
const HASH = `0x${"c".repeat(64)}` as Hex;
const OTHER_HASH = `0x${"d".repeat(64)}` as Hex;
const NOW = 1_800_000_000_000;
const REQUEST: ApprovalRequest = { address: ADDRESS, amount: "25000000" };
const GAS = { gas: 100_000n, maxFeePerGas: 2n, maxPriorityFeePerGas: 1n };

function tracked(overrides: Partial<TrackedApproval> = {}): TrackedApproval {
  return { ...REQUEST, version: 1, chainId: ARC_APPROVAL_CHAIN_ID, token: ARC_USDC, spender: RELAY_APPROVAL_SPENDER, createdAt: NOW, status: "uncertain", ...overrides };
}

function scenario() {
  const events: string[] = [];
  const state = { current: { ...REQUEST } as ApprovalRequest | null, approval: null as TrackedApproval | null, chainId: 5042, address: ADDRESS as Address | undefined, sends: 0 };
  const deps: ApprovalDependencies = {
    now: () => NOW,
    currentRequest: () => state.current,
    readWallet: async () => { events.push("wallet"); return { address: state.address, chainId: state.chainId }; },
    switchChain: async (chainId) => { events.push("switch"); state.chainId = chainId; },
    prepare: async () => { events.push("prepare"); return GAS; },
    readApproval: () => state.approval,
    saveApproval: (approval) => { events.push(`save:${approval.status}`); state.approval = approval; },
    removeApproval: () => { events.push("remove"); state.approval = null; },
    send: async (request, transaction) => {
      events.push("send"); state.sends++;
      assert.deepEqual(request, REQUEST);
      assert.equal(transaction.to, ARC_USDC);
      assert.equal(transaction.chainId, 5042);
      assert.equal(transaction.value, 0n);
      const [spender, amount] = decodeFunctionData({ abi: EXACT_APPROVAL_ABI, data: transaction.data }).args;
      assert.equal(spender.toLowerCase(), RELAY_APPROVAL_SPENDER);
      assert.equal(amount, 25_000_000n);
      return HASH;
    },
    phase: (phase) => events.push(`phase:${phase}`),
  };
  return { state, events, deps };
}

function storageScenario() {
  const values = new Map<string, string>();
  const flags = { failWrite: false, failRead: false, discardWrite: false };
  const storage = {
    getItem(key: string) { if (flags.failRead) throw new Error("blocked"); return values.get(key) ?? null; },
    setItem(key: string, value: string) { if (flags.failWrite) throw new Error("quota"); if (!flags.discardWrite) values.set(key, value); },
    removeItem(key: string) { values.delete(key); },
  };
  return { values, flags, storage, store: createApprovalStore(() => storage) };
}

test("approval is pinned to Arc USDC, Relay depository and the exact six-decimal amount", () => {
  assert.deepEqual(validateApprovalMetadata({ token: ARC_USDC, spender: RELAY_APPROVAL_SPENDER, amount: REQUEST.amount }, ADDRESS), REQUEST);
  const tx = exactApprovalTransaction(REQUEST);
  assert.equal(tx.chainId, 5042);
  assert.equal(tx.to, ARC_USDC);
  assert.equal(tx.value, 0n);
  const decoded = decodeFunctionData({ abi: EXACT_APPROVAL_ABI, data: tx.data });
  assert.equal(decoded.functionName, "approve");
  assert.equal(decoded.args[0].toLowerCase(), RELAY_APPROVAL_SPENDER);
  assert.equal(decoded.args[1], 25_000_000n);
  for (const metadata of [null, {}, { token: OTHER, spender: RELAY_APPROVAL_SPENDER, amount: REQUEST.amount }, { token: ARC_USDC, spender: OTHER, amount: REQUEST.amount }]) assert.throws(() => validateApprovalMetadata(metadata, ADDRESS));
  for (const amount of ["0", "-1", "01", "1.0", "1e6", ((1n << 256n) - 1n).toString(), "9".repeat(90)]) assert.throws(() => exactApprovalTransaction({ ...REQUEST, amount }));
  const bound = (((1n << 256n) - 1n) / 10n ** 12n).toString();
  assert.doesNotThrow(() => exactApprovalTransaction({ ...REQUEST, amount: bound }));
  assert.throws(() => exactApprovalTransaction({ address: `0x${"0".repeat(40)}`, amount: "1" }));
});

test("Base approvals pin Base USDC and retain independent chain identity", () => {
  const request = { ...REQUEST, chainId: 8453 as const };
  assert.deepEqual(validateApprovalMetadata({ token: BASE_USDC, spender: RELAY_APPROVAL_SPENDER, amount: REQUEST.amount }, ADDRESS, 8453), request);
  const tx = exactApprovalTransaction(request);
  assert.equal(tx.chainId, 8453);
  assert.equal(tx.to, BASE_USDC);
  assert.equal(tx.value, 0n);
  assert.equal(decodeFunctionData({ abi: EXACT_APPROVAL_ABI, data: tx.data }).args[1], 25_000_000n);
  assert.notEqual(approvalRequestKey(request), approvalRequestKey(REQUEST));
  assert.throws(() => validateApprovalMetadata({ token: ARC_USDC, spender: RELAY_APPROVAL_SPENDER, amount: REQUEST.amount }, ADDRESS, 8453));
  assert.throws(() => validateApprovalMetadata({ token: BASE_USDC, spender: RELAY_APPROVAL_SPENDER, amount: REQUEST.amount }, ADDRESS, 5042));
  // Robinhood Chain approves its own token, USDG, never Base's or Arc's
  assert.equal(exactApprovalTransaction({ ...request, chainId: 4663 }).to, ROBINHOOD_USDG);
  assert.throws(() => validateApprovalMetadata({ token: BASE_USDC, spender: RELAY_APPROVAL_SPENDER, amount: REQUEST.amount }, ADDRESS, 4663));
  assert.throws(() => validateApprovalMetadata({ token: ROBINHOOD_USDG, spender: RELAY_APPROVAL_SPENDER, amount: REQUEST.amount }, ADDRESS, 8453));
  const unlimited = ((1n << 256n) - 1n).toString();
  assert.throws(() => exactApprovalTransaction({ ...request, amount: unlimited }));
  assert.throws(() => validateApprovalMetadata({ token: BASE_USDC, spender: RELAY_APPROVAL_SPENDER, amount: unlimited }, ADDRESS, 8453));
  assert.doesNotThrow(() => exactApprovalTransaction({ ...request, amount: ((1n << 256n) - 2n).toString() }));
  const record = tracked({ chainId: 8453, token: BASE_USDC, approvalHash: HASH, status: "pending" });
  assert.deepEqual(parseStoredApproval(serializeApproval(record), ADDRESS), record);
  assert.equal(isMatchingApprovalTransaction(record, { from: ADDRESS, to: BASE_USDC, input: tx.data, value: 0n }), true);
  assert.equal(isMatchingApprovalTransaction(record, { from: ADDRESS, to: ARC_USDC, input: tx.data, value: 0n }), false);
  assert.equal(reconcileApproval(record, { chainId: 8453, allowance: 25_000_000n, receipt: { transactionHash: HASH, status: "success" } }).status, "confirmed");
  assert.throws(() => reconcileApproval(record, { chainId: 5042, allowance: 25_000_000n, receipt: { transactionHash: HASH, status: "success" } }));
});

test("Base approval submission rechecks chain and blocks another chain's pending journal", async () => {
  const item = scenario();
  const request = { ...REQUEST, chainId: 8453 as const };
  item.state.current = request;
  item.deps.send = async (owner, transaction) => {
    assert.equal(owner.chainId, 8453);
    assert.equal(transaction.chainId, 8453);
    assert.equal(transaction.to, BASE_USDC);
    item.state.sends++;
    return HASH;
  };
  assert.equal((await submitExactApproval(request, item.deps)).kind, "sent");
  assert.equal(item.state.chainId, 8453);
  assert.equal(item.state.approval?.chainId, 8453);
  assert.equal(item.state.approval?.token, BASE_USDC);
  item.state.current = REQUEST;
  await assert.rejects(submitExactApproval(REQUEST, item.deps), /already being tracked/);
  assert.equal(item.state.sends, 1);
  const changed = scenario(); changed.state.current = request;
  changed.deps.prepare = async () => { changed.state.current = { ...request, chainId: 5042 }; return GAS; };
  await assert.rejects(submitExactApproval(request, changed.deps), /changed/);
  assert.equal(changed.state.sends, 0);
});

test("Base approval event recovery cannot accept an Arc token event", () => {
  const approval = tracked({ chainId: 8453, token: BASE_USDC });
  const log = { address: BASE_USDC as Address, topics: encodeEventTopics({ abi: USDC_APPROVAL_EVENT, eventName: "Approval", args: { owner: ADDRESS, spender: RELAY_APPROVAL_SPENDER } }) as Hex[], data: encodeAbiParameters([{ type: "uint256" }], [25_000_000n]) };
  assert.equal(hasMatchingApprovalEvent(approval, { status: "success", logs: [log] }), true);
  assert.equal(hasMatchingApprovalEvent(approval, { status: "success", logs: [{ ...log, address: ARC_USDC }] }), false);
});

test("approval records are account scoped and cannot be mistaken for native deposit records", () => {
  const record = tracked();
  assert.deepEqual(parseStoredApproval(serializeApproval(record), ADDRESS), record);
  assert.equal(approvalStorageKey(ADDRESS), `${APPROVAL_STORAGE_PREFIX}${ADDRESS.toLowerCase()}`);
  assert.notEqual(approvalStorageKey(ADDRESS), `openlaunch.bridge.v1:${ADDRESS.toLowerCase()}`);
  assert.equal(approvalRequestKey(null), "");
  assert.equal(approvalRequestKey(REQUEST), `${ADDRESS}:5042:25000000`);
  for (const mutation of [
    { version: 2 }, { chainId: 8453 }, { token: OTHER }, { spender: OTHER }, { address: OTHER },
    { createdAt: 0 }, { createdAt: 1.2 }, { createdAt: Number.MAX_SAFE_INTEGER + 1 },
    { status: "success" }, { status: "confirmed" }, { status: "pending" }, { status: "reverted" }, { status: "insufficient" },
    { approvalHash: "0x1234" }, { approvalHash: `0x${"0".repeat(64)}` }, { amount: "0" },
  ]) assert.throws(() => parseStoredApproval(JSON.stringify({ ...record, ...mutation }), ADDRESS), /could not be read/);
  for (const invalid of ["{", "null", "[]", JSON.stringify({ ...REQUEST, requestId: HASH, sourceHash: HASH })]) assert.throws(() => parseStoredApproval(invalid, ADDRESS));
});

test("submission saves an uncertain journal before requesting the wallet, then preserves its own hash", async () => {
  const { deps, state, events } = scenario();
  const result = await submitExactApproval(REQUEST, deps);
  assert.equal(result.kind, "sent");
  assert.equal(state.approval?.approvalHash, HASH);
  assert.equal(state.approval?.status, "pending");
  assert.ok(events.indexOf("save:uncertain") < events.indexOf("send"));
  assert.ok(events.indexOf("send") < events.indexOf("save:pending"));
  assert.equal(state.sends, 1);
  assert.equal("sourceHash" in state.approval!, false);
  assert.equal("requestId" in state.approval!, false);
});

test("switches only to Arc and rechecks the wallet, review and latest journal after async preparation", async () => {
  const switched = scenario();
  switched.state.chainId = 8453;
  await submitExactApproval(REQUEST, switched.deps);
  assert.ok(switched.events.includes("switch"));
  assert.equal(switched.state.chainId, 5042);
  for (const change of [
    (state: ReturnType<typeof scenario>["state"]) => { state.address = OTHER; },
    (state: ReturnType<typeof scenario>["state"]) => { state.chainId = 8453; },
    (state: ReturnType<typeof scenario>["state"]) => { state.current = null; },
    (state: ReturnType<typeof scenario>["state"]) => { state.current = { ...REQUEST, amount: "1" }; },
    (state: ReturnType<typeof scenario>["state"]) => { state.approval = tracked(); },
  ]) {
    const item = scenario();
    item.deps.prepare = async () => { change(item.state); return GAS; };
    await assert.rejects(submitExactApproval(REQUEST, item.deps));
    assert.equal(item.state.sends, 0);
  }
});

test("invalid wallet, expired review or invalid gas never opens an approval prompt", async () => {
  const invalidWallet = scenario(); invalidWallet.state.address = OTHER;
  await assert.rejects(submitExactApproval(REQUEST, invalidWallet.deps));
  assert.equal(invalidWallet.state.sends, 0);
  const expired = scenario(); expired.state.current = null;
  await assert.rejects(submitExactApproval(REQUEST, expired.deps));
  assert.equal(expired.state.sends, 0);
  const invalidGas = scenario(); invalidGas.deps.prepare = async () => ({ ...GAS, gas: 0n });
  await assert.rejects(submitExactApproval(REQUEST, invalidGas.deps), /estimate approval gas/);
  assert.equal(invalidGas.state.sends, 0);
});

test("storage failure or non-durable writes prevent wallet requests", async () => {
  for (const discardWrite of [false, true]) {
    const item = scenario();
    const disk = storageScenario();
    disk.flags.failWrite = !discardWrite; disk.flags.discardWrite = discardWrite;
    item.deps.readApproval = disk.store.read;
    item.deps.saveApproval = disk.store.save;
    item.deps.removeApproval = disk.store.remove;
    await assert.rejects(submitExactApproval(REQUEST, item.deps), /No transaction was requested/);
    assert.equal(item.state.sends, 0);
  }
});

test("wallet rejection removes an unsent approval record and preserves any previous settled approval", async () => {
  for (const previous of [null, tracked({ status: "confirmed", approvalHash: HASH })]) {
    const item = scenario();
    item.state.approval = previous;
    item.deps.send = async () => { throw { cause: { code: 4001 } }; };
    assert.deepEqual(await submitExactApproval(REQUEST, item.deps), { kind: "rejected" });
    assert.deepEqual(item.state.approval, previous);
  }
});

test("unknown broadcast and malformed wallet hashes retain an uncertain journal and prohibit resubmission", async () => {
  for (const send of [async () => { throw new Error("RPC timeout"); }, async () => "0x1234" as Hex, async () => `0x${"0".repeat(64)}` as Hex]) {
    const item = scenario(); item.deps.send = send;
    const result = await submitExactApproval(REQUEST, item.deps);
    assert.equal(result.kind, "uncertain");
    assert.equal(item.state.approval?.status, "uncertain");
    assert.equal(item.state.approval?.approvalHash, undefined);
    await assert.rejects(submitExactApproval(REQUEST, item.deps), /already being tracked/);
  }
});

test("pending approvals block duplicates even when a different amount is requested", async () => {
  const item = scenario(); item.state.approval = tracked({ amount: "1", status: "pending", approvalHash: HASH });
  await assert.rejects(submitExactApproval(REQUEST, item.deps), /already being tracked/);
  assert.equal(item.state.sends, 0);
  assert.equal(approvalBlocksSubmission(null), false);
  for (const status of ["confirmed", "reverted", "insufficient"] as const) assert.equal(approvalBlocksSubmission(tracked({ status, approvalHash: HASH })), false);
});

test("only a matching successful receipt and fresh sufficient allowance confirm an approval", () => {
  const pending = tracked({ status: "pending", approvalHash: HASH });
  const observation = { chainId: 5042, allowance: 25_000_000n, receipt: { transactionHash: HASH, status: "success" as const } };
  assert.equal(reconcileApproval(pending, observation).status, "confirmed");
  assert.equal(reconcileApproval(pending, { ...observation, allowance: 24_999_999n }).status, "insufficient");
  assert.equal(reconcileApproval(pending, { ...observation, receipt: { transactionHash: HASH, status: "reverted" } }).status, "reverted");
  assert.equal(reconcileApproval(pending, { chainId: 5042, allowance: 25_000_000n }).status, "pending");
  assert.equal(reconcileApproval(tracked({ status: "confirmed", approvalHash: HASH }), { chainId: 5042, allowance: 25_000_000n }).status, "pending");
  assert.equal(reconcileApproval(tracked(), observation).status, "uncertain");
  assert.throws(() => reconcileApproval(pending, { ...observation, chainId: 8453 }));
  assert.throws(() => reconcileApproval(pending, { ...observation, allowance: -1n }));
  assert.throws(() => reconcileApproval(pending, { ...observation, receipt: { transactionHash: OTHER_HASH, status: "success" } }));
});

test("manual hash recovery requires exact owner, USDC target, zero value and canonical approval calldata", () => {
  const approval = tracked();
  const transaction = { from: ADDRESS, to: ARC_USDC as Address | null, value: 0n, input: exactApprovalTransaction(REQUEST).data };
  assert.equal(isMatchingApprovalTransaction(approval, transaction), true);
  for (const mutation of [
    { from: OTHER }, { to: OTHER }, { to: null }, { value: 1n },
    { input: exactApprovalTransaction({ ...REQUEST, amount: "1" }).data },
    { input: `${transaction.input}00` as Hex },
    { input: transaction.input.replace(RELAY_APPROVAL_SPENDER.slice(2), OTHER.slice(2)) as Hex },
  ]) assert.equal(isMatchingApprovalTransaction(approval, { ...transaction, ...mutation }), false);
});

test("smart-wallet recovery binds successful USDC Approval logs to exact owner, spender and six-decimal amount", () => {
  const approval = tracked();
  const log = {
    address: ARC_USDC as Address,
    topics: encodeEventTopics({ abi: USDC_APPROVAL_EVENT, eventName: "Approval", args: { owner: ADDRESS, spender: RELAY_APPROVAL_SPENDER } }) as Hex[],
    data: encodeAbiParameters([{ type: "uint256" }], [25_000_000n]),
  };
  assert.equal(hasMatchingApprovalEvent(approval, { status: "success", logs: [log] }), true);
  assert.equal(hasMatchingApprovalEvent(approval, { status: "reverted", logs: [log] }), false);
  for (const mutation of [
    { address: OTHER }, { topics: [] }, { topics: [...log.topics, HASH] },
    { topics: encodeEventTopics({ abi: USDC_APPROVAL_EVENT, eventName: "Approval", args: { owner: OTHER, spender: RELAY_APPROVAL_SPENDER } }) as Hex[] },
    { topics: encodeEventTopics({ abi: USDC_APPROVAL_EVENT, eventName: "Approval", args: { owner: ADDRESS, spender: OTHER } }) as Hex[] },
    { data: encodeAbiParameters([{ type: "uint256" }], [1n]) }, { data: "0x1234" as Hex }, { data: `${log.data}00` as Hex },
  ]) assert.equal(hasMatchingApprovalEvent(approval, { status: "success", logs: [{ ...log, ...mutation }] }), false);
});

test("post-send storage failure retains the returned approval hash in memory and unknown recovery on disk", async () => {
  const item = scenario();
  const disk = storageScenario();
  item.deps.readApproval = disk.store.read; item.deps.saveApproval = disk.store.save; item.deps.removeApproval = disk.store.remove;
  item.deps.send = async () => { disk.flags.failWrite = true; return HASH; };
  const result = await submitExactApproval(REQUEST, item.deps);
  assert.equal(result.kind, "sent");
  assert.equal(disk.store.getSnapshot().approvals[ADDRESS]?.approvalHash, HASH);
  assert.equal(disk.store.read(ADDRESS)?.approvalHash, HASH);
  const reloaded = createApprovalStore(() => disk.storage);
  assert.equal(reloaded.read(ADDRESS)?.status, "uncertain");
  assert.equal(reloaded.read(ADDRESS)?.approvalHash, undefined);
  assert.equal(approvalBlocksSubmission(reloaded.read(ADDRESS)), true);
});

test("store is reactive, retains recovery on read errors, and rejects corrupt records without losing other wallets", () => {
  const disk = storageScenario();
  let updates = 0;
  const unsubscribe = disk.store.subscribe(() => { updates++; });
  assert.deepEqual(disk.store.getServerSnapshot(), { approvals: {}, errors: {} });
  disk.store.save(tracked());
  disk.store.save(tracked({ address: OTHER }));
  assert.equal(updates, 2);
  disk.flags.failRead = true;
  assert.throws(() => disk.store.read(ADDRESS), /unavailable or unreadable/);
  assert.equal(disk.store.getSnapshot().approvals[ADDRESS]?.amount, REQUEST.amount);
  assert.ok(disk.store.getSnapshot().errors[ADDRESS]);
  disk.flags.failRead = false;
  disk.values.set(approvalStorageKey(ADDRESS), "bad JSON");
  assert.throws(() => disk.store.read(ADDRESS));
  assert.equal(disk.store.read(OTHER)?.address, OTHER);
  disk.store.remove(ADDRESS);
  assert.equal(disk.store.read(ADDRESS), null);
  unsubscribe();
});

test("approval workflow requires a new reviewed quote and never dispatches a deposit", async () => {
  const item = scenario();
  await submitExactApproval(REQUEST, item.deps);
  const confirmed = reconcileApproval(item.state.approval!, { chainId: 5042, allowance: 25_000_000n, receipt: { transactionHash: HASH, status: "success" } });
  assert.equal(confirmed.status, "confirmed");
  assert.equal(item.state.sends, 1);
  assert.equal(item.events.filter((event) => event === "send").length, 1);
});

test("an unmined approval can be discarded after the wait; a hash needs a fresh missing-receipt observation", () => {
  const later = NOW + APPROVAL_DISCARD_AFTER_MS;
  const uncertain = tracked({ status: "uncertain" });
  const pending = tracked({ status: "pending", approvalHash: HASH });
  const missing = { createdAt: NOW, receiptFound: false, observedAt: later };
  assert.equal(approvalCanDiscard(uncertain, null, later), true);
  assert.equal(approvalCanDiscard(uncertain, null, later - 1), false);
  assert.equal(approvalCanDiscard(pending, missing, later), true);
  assert.equal(approvalCanDiscard(pending, null, later), false); // never observed on-chain
  assert.equal(approvalCanDiscard(pending, { ...missing, receiptFound: true }, later), false);
  assert.equal(approvalCanDiscard(pending, { ...missing, observedAt: later - 61_000 }, later), false);
  assert.equal(approvalCanDiscard(pending, { ...missing, observedAt: later + 1 }, later), false);
  assert.equal(approvalCanDiscard(pending, { ...missing, createdAt: NOW + 1 }, later), false); // another attempt's observation
  for (const status of ["confirmed", "reverted", "insufficient"] as const) assert.equal(approvalCanDiscard(tracked({ status, approvalHash: HASH }), missing, later), false, status);
  assert.equal(approvalCanDiscard(null, missing, later), false);
});

test("a confirmed exact replacement recovers a pending hash without resubmitting or granting more allowance", () => {
  const approval = tracked({ status: "pending", approvalHash: HASH });
  const evidence = {
    chainId: 5042, allowance: 25_000_000n,
    transaction: { hash: OTHER_HASH, from: ADDRESS, to: ARC_USDC, input: exactApprovalTransaction(REQUEST).data, value: 0n },
    receipt: { transactionHash: OTHER_HASH, status: "success" as const, logs: [] },
    blockTimestamp: BigInt(NOW / 1000), now: NOW,
  };
  const recovered = recoverApprovalFromEvidence(approval, evidence);
  assert.equal(recovered.approvalHash, OTHER_HASH);
  assert.equal(recovered.status, "confirmed");
  assert.equal(recovered.amount, approval.amount);
  assert.equal(recovered.createdAt, approval.createdAt);
  assert.equal(approval.approvalHash, HASH); // input journal untouched
  assert.equal(recoverApprovalFromEvidence(approval, { ...evidence, allowance: 0n }).status, "insufficient");
  assert.throws(() => recoverApprovalFromEvidence(approval, { ...evidence, chainId: 8453 }), /network/);
  assert.throws(() => recoverApprovalFromEvidence(approval, { ...evidence, blockTimestamp: evidence.blockTimestamp - 31n }), /predates/);
  assert.throws(() => recoverApprovalFromEvidence(approval, { ...evidence, blockTimestamp: evidence.blockTimestamp + 31n }), /clock/);
  assert.throws(() => recoverApprovalFromEvidence(approval, { ...evidence, transaction: { ...evidence.transaction, hash: HASH } }), /network/);
  for (const changes of [{ to: ADDRESS, input: "0x" as Hex }, { from: OTHER }, { input: exactApprovalTransaction({ ...REQUEST, amount: "1" }).data }, { value: 1n }]) {
    assert.throws(() => recoverApprovalFromEvidence(approval, { ...evidence, transaction: { ...evidence.transaction, ...changes } }), /exact token approval/);
  }
  assert.throws(() => recoverApprovalFromEvidence({ ...approval, status: "confirmed" }, evidence), /already resolved/);
});

test("a delayed missing-receipt poll cannot undo same-hash confirmation or another recovery", () => {
  const observed = tracked({ status: "pending", approvalHash: HASH });
  assert.equal(canApplyApprovalPoll(observed, observed), true);
  const confirmed = reconcileApproval(observed, { chainId: 5042, allowance: BigInt(observed.amount), receipt: { transactionHash: HASH, status: "success" } });
  assert.equal(canApplyApprovalPoll(confirmed, observed), false);
  for (const status of ["reverted", "insufficient"] as const) assert.equal(canApplyApprovalPoll({ ...observed, status }, observed), false);
  for (const change of [{ approvalHash: OTHER_HASH }, { address: OTHER }, { amount: "1" }, { createdAt: NOW + 1 }, { chainId: 8453 as const }]) assert.equal(canApplyApprovalPoll({ ...observed, ...change }, observed), false);
  assert.equal(canApplyApprovalPoll(null, observed), false);
});

test("a Circle approval pins Circle's messenger as spender, and no other contract is ever accepted", () => {
  const circle = { ...REQUEST, spender: CCTP_APPROVAL_SPENDER };
  assert.deepEqual(validateApprovalMetadata({ token: ARC_USDC, spender: CCTP_TOKEN_MESSENGER, amount: REQUEST.amount }, ADDRESS), circle);
  // Relay stays the implicit spender, so Relay's records and keys are unchanged
  assert.deepEqual(validateApprovalMetadata({ token: ARC_USDC, spender: RELAY_APPROVAL_SPENDER, amount: REQUEST.amount }, ADDRESS), REQUEST);
  assert.equal(approvalRequestKey(REQUEST).includes(CCTP_APPROVAL_SPENDER), false);
  assert.notEqual(approvalRequestKey(circle), approvalRequestKey(REQUEST));
  assert.equal(decodeFunctionData({ abi: EXACT_APPROVAL_ABI, data: exactApprovalTransaction(circle).data }).args[0].toLowerCase(), CCTP_APPROVAL_SPENDER);
  assert.throws(() => validateApprovalMetadata({ token: ARC_USDC, spender: OTHER, amount: REQUEST.amount }, ADDRESS));
  assert.throws(() => exactApprovalTransaction({ ...REQUEST, spender: OTHER }));

  const approval = tracked({ spender: CCTP_APPROVAL_SPENDER });
  assert.deepEqual(parseStoredApproval(serializeApproval(approval), ADDRESS), approval);
  assert.throws(() => parseStoredApproval(serializeApproval(tracked({ spender: OTHER })), ADDRESS));
  const event = (spender: Address) => ({
    address: ARC_USDC as Address,
    topics: encodeEventTopics({ abi: USDC_APPROVAL_EVENT, eventName: "Approval", args: { owner: ADDRESS, spender } }) as Hex[],
    data: encodeAbiParameters([{ type: "uint256" }], [25_000_000n]),
  });
  assert.equal(hasMatchingApprovalEvent(approval, { status: "success", logs: [event(CCTP_TOKEN_MESSENGER)] }), true);
  // an approval of Relay's depository never stands in for Circle's, nor the reverse
  assert.equal(hasMatchingApprovalEvent(approval, { status: "success", logs: [event(RELAY_APPROVAL_SPENDER)] }), false);
  assert.equal(hasMatchingApprovalEvent(tracked(), { status: "success", logs: [event(CCTP_TOKEN_MESSENGER)] }), false);
});
