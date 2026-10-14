import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { zeroAddress, type Address } from "viem";
import { BUILDER_DATA_SUFFIX } from "@/lib/chainPublic";
import { ERC20_MIN_ABI } from "@/lib/launchpad/abi";
import { EARN_VAULT_ABI } from "@/lib/earn/abi";
import { BATCH_FAILED, EARN_BATCH_CAPABILITIES, approveCall, approvedState, batchHash, canBatch, depositCall, redeemCall, withdrawCall } from "@/lib/earn/calls";
import { fmtAmount, withdrawPlan } from "@/lib/earn/math";
import { NOT_CONFIRMED_YET, isBusy, revertedCopy, type EarnPhase } from "@/lib/earn/phase";
import { pausedCopy, termsCheck, type LiveTerms } from "@/lib/earn/terms";
import { EARN_VAULTS } from "@/lib/earn/vaults";

/**
 * Runs the real deposit / withdraw / recheck code from useEarn.ts (extracted from the source, like
 * transaction-safety.test.ts) against inert wallets and RPCs: no real wallet, chain or transaction.
 */
const FLOW = ["ensureAccount", "walletFor", "batching", "requireTerms", "preflightBatch", "unconfirmed", "settleTx", "sendBatch", "finish", "deposit", "withdraw", "recheck", "switchToVaultChain"] as const;
type Flow = Record<(typeof FLOW)[number], (...args: unknown[]) => Promise<void>>;

function load(bindings: Record<string, unknown>): Flow {
  const source = readFileSync(new URL("./useEarn.ts", import.meta.url), "utf8");
  const ast = ts.createSourceFile("useEarn.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const found = new Map<string, string>();
  const consts: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name && (FLOW as readonly string[]).includes(node.name.text)) found.set(node.name.text, node.getText(ast));
    // the module's own message constants travel with the code
    if (ts.isVariableStatement(node) && node.parent === ast && node.declarationList.declarations.some((d) => ts.isIdentifier(d.name) && /^[A-Z_]+$/.test(d.name.text))) consts.push(node.getText(ast));
    ts.forEachChild(node, visit);
  };
  visit(ast);
  for (const name of FLOW) assert.ok(found.has(name), `useEarn.ts no longer has ${name}`);
  const body = `(function () { ${consts.join("\n")}\n${[...found.values()].join("\n")}\n return { ${FLOW.join(", ")} }; })()`;
  const { outputText } = ts.transpileModule(body, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } });
  // same realm as the test (not node:vm), so the objects the flow builds compare with deepStrictEqual
  const names = Object.keys(bindings);
  return new Function(...names, `return ${outputText}`)(...names.map((n) => bindings[n]));
}

const vault = EARN_VAULTS.base!;
const A: Address = "0x00000000000000000000000000000000000000a1";
const B: Address = "0x00000000000000000000000000000000000000b2";
const reviewed: LiveTerms = { asset: vault.asset, performanceFee: 0n, managementFee: 0n, gates: [zeroAddress, zeroAddress, zeroAddress, zeroAddress] };
const feeRaised: LiveTerms = { ...reviewed, performanceFee: 100_000_000_000_000_000n };
const timeout = () => Promise.reject(new Error("timed out waiting for the receipt"));

/** A world of inert wallets and RPCs; every option changes one thing about it. */
function world(o: {
  allowance?: bigint;
  batching?: boolean;
  receipt?: () => Promise<{ status: string }>;
  terms?: LiveTerms[];
  onRead?: (fn: string, w: { account: { value: Address }; mounted: { current: boolean } }) => void;
  afterApproval?: (w: { account: { value: Address } }) => void;
  phase?: EarnPhase;
  getReceipt?: () => Promise<{ status: string }>;
  callsStatus?: () => Promise<unknown>;
  waitForCalls?: () => Promise<unknown>;
  tab?: "deposit" | "withdraw";
  /** false: the node ignores the allowance override (as if the token's storage moved) */
  overrideTakes?: boolean;
  /** which simulations revert, by function name and whether the allowance override was applied */
  reverts?: (fn: string, withOverride: boolean) => boolean;
  /** the wallet's answer to a network switch */
  switchChain?: () => Promise<void>;
} = {}) {
  const phases: EarnPhase[] = [];
  const events: string[] = [];
  const writes: { functionName?: string; account?: unknown }[] = [];
  const walletRequests: unknown[] = [];
  const batches: unknown[] = [];
  const account = { value: A };
  const mounted = { current: true };
  const lock = { current: false };
  const termsQueue = [...(o.terms ?? [])];
  let refetches = 0;
  let toasts = 0;
  let switches = 0;
  const pub = {
    readContract: async ({ address, functionName, stateOverride }: { address: string; functionName: string; stateOverride?: { stateDiff: { value: string }[] }[] }) => {
      if (stateOverride) return o.overrideTakes === false ? 0n : BigInt(stateOverride[0].stateDiff[0].value);
      o.onRead?.(functionName, { account, mounted });
      if (functionName === "allowance") return o.allowance ?? 10_000_000_000n;
      if (functionName === "balanceOf") return address === vault.asset ? 10_000_000_000n : 957_000_000_000_000_000_000n;
      throw new Error(`unexpected read ${functionName}`);
    },
    simulateContract: async (args: { functionName: string; stateOverride?: unknown }) => {
      events.push(`simulate:${args.functionName}${args.stateOverride ? "+override" : ""}`);
      if (o.reverts?.(args.functionName, Boolean(args.stateOverride))) throw new Error(`${args.functionName} would revert`);
      return { request: { ...args } };
    },
    waitForTransactionReceipt: async ({ hash }: { hash: string }) => {
      if (hash === "0xapprove") {
        o.afterApproval?.({ account });
        return { status: "success" };
      }
      return (o.receipt ?? (async () => ({ status: "success" })))();
    },
    getTransactionReceipt: () => (o.getReceipt ?? timeout)(),
  };
  const wallet = {
    writeContract: async (req: { functionName?: string; account?: unknown }) => {
      writes.push(req);
      return req.functionName === "approve" ? "0xapprove" : "0xsent";
    },
  };
  const bindings = {
    config: {}, chainId: 8453, vault, decimals: 6, lock, mounted, onChain: true, problem: null, busy: false,
    address: A, amount: 250_000_000n, phase: o.phase ?? { k: "idle" },
    position: { shares: 957_000_000_000_000_000_000n, position: 1_000_000_000n, refetch: async () => {} },
    terms: { refetch: async () => { refetches++; } },
    switchChainAsync: () => { switches++; return (o.switchChain ?? (async () => {}))(); },
    isBusy,
    getPublicClient: () => pub,
    getAccount: () => ({ address: account.value }),
    getWalletClient: async (_config: unknown, opts: unknown) => { walletRequests.push(opts); return wallet; },
    getCapabilities: async (_config: unknown, opts: { account: Address }) => {
      if (opts.account !== account.value) throw new Error("Account not found for connector");
      if (!o.batching) throw new Error("wallet_getCapabilities is not supported");
      return { atomic: { status: "supported" } };
    },
    sendCalls: async (_config: unknown, req: unknown) => { events.push("sendCalls"); batches.push(req); return { id: "0xbatch" }; },
    waitForCallsStatus: () => (o.waitForCalls ?? (async () => ({ status: "success", receipts: [{ status: "success", transactionHash: "0xt" }] })))(),
    getCallsStatus: () => (o.callsStatus ?? (async () => ({ status: "pending" })))(),
    readTerms: async () => termsQueue.shift() ?? reviewed,
    termsCheck, pausedCopy, approveCall, approvedState, depositCall, redeemCall, withdrawCall, batchHash, canBatch, withdrawPlan, fmtAmount,
    BATCH_FAILED, EARN_BATCH_CAPABILITIES, ERC20_MIN_ABI, EARN_VAULT_ABI, BUILDER_DATA_SUFFIX, NOT_CONFIRMED_YET, revertedCopy,
    // like React's setter: a value, or an updater given the current phase
    setPhase: (p: EarnPhase | ((cur: EarnPhase) => EarnPhase)) => phases.push(typeof p === "function" ? p(phases.at(-1) ?? { k: "idle" }) : p), setText: () => {}, setAll: () => {}, toast: () => { toasts++; },
    friendlyError: (e: Error) => e.message,
  };
  if (o.tab === "withdraw") Object.assign(bindings, { amount: 1_000_000_000n });
  const flow = load(bindings);
  return { flow, phases, events, writes, walletRequests, batches, account, mounted, lock, refetches: () => refetches, toasts: () => toasts, switches: () => switches, last: () => phases.at(-1)!, rebind: (extra: Record<string, unknown>) => load({ ...bindings, ...extra }) };
}

test("a deposit whose receipt cannot be read stays unconfirmed, and the form cannot send it again", async () => {
  const w = world({ receipt: timeout });
  await w.flow.deposit();
  assert.deepEqual(w.phases.map((p) => p.k), ["preparing", "signing", "sent", "unconfirmed"]);
  assert.deepEqual(w.last(), { k: "unconfirmed", tab: "deposit", amount: 250_000_000n, sent: { kind: "tx", hash: "0xsent" }, checking: false, note: null });
  assert.equal(w.lock.current, false);
  assert.equal(isBusy(w.last()), true);
  // the next render's flow sees busy = isBusy(phase): a second press sends nothing
  await w.rebind({ busy: isBusy(w.last()) }).deposit();
  assert.equal(w.writes.length, 1, "exactly one deposit was sent");
});

test("only a final reverted receipt allows sending again", async () => {
  const w = world({ receipt: async () => ({ status: "reverted" }) });
  await w.flow.deposit();
  assert.deepEqual(w.last(), { k: "error", message: revertedCopy("deposit") });
  assert.equal(isBusy(w.last()), false);
});

test("Check again: no receipt keeps it unconfirmed with a note; a receipt settles it either way", async () => {
  const pending: EarnPhase = { k: "unconfirmed", tab: "deposit", amount: 250_000_000n, sent: { kind: "tx", hash: "0xsent" }, checking: false, note: null };
  const still = world({ phase: pending });
  await still.flow.recheck();
  assert.deepEqual(still.phases.map((p) => p.k), ["unconfirmed", "unconfirmed"]);
  assert.deepEqual(still.last(), { ...pending, note: NOT_CONFIRMED_YET });
  const ok = world({ phase: pending, getReceipt: async () => ({ status: "success" }) });
  await ok.flow.recheck();
  assert.deepEqual(ok.last(), { k: "done", hash: "0xsent", tab: "deposit", amount: 250_000_000n });
  const reverted = world({ phase: pending, getReceipt: async () => ({ status: "reverted" }) });
  await reverted.flow.recheck();
  assert.deepEqual(reverted.last(), { k: "error", message: revertedCopy("deposit") });
});

test("a smart-wallet batch is one atomic, builder-tagged request; an unreadable status stays unconfirmed until the wallet's final answer", async () => {
  const w = world({ batching: true, allowance: 0n, waitForCalls: timeout });
  await w.flow.deposit();
  // the whole batch simulated before the one prompt: the approval, then the deposit with the allowance in place
  assert.deepEqual(w.events, ["simulate:approve", "simulate:deposit+override", "sendCalls"]);
  assert.equal(w.batches.length, 1);
  const req = w.batches[0] as { account: Address; calls: { to: Address }[]; capabilities: unknown; forceAtomic: boolean };
  assert.equal(req.account, A);
  assert.deepEqual(req.calls.map((c) => c.to), [vault.asset, vault.address]); // approve, then deposit
  assert.deepEqual(req.capabilities, { dataSuffix: { value: BUILDER_DATA_SUFFIX, optional: true } });
  assert.equal(req.forceAtomic, true);
  assert.deepEqual(w.last(), { k: "unconfirmed", tab: "deposit", amount: 250_000_000n, sent: { kind: "batch", id: "0xbatch" }, checking: false, note: null });
  assert.equal(w.writes.length, 0);
  const pending = w.last();
  for (const answer of [{ status: "pending" }, { status: undefined }, null]) {
    const r = world({ phase: pending, callsStatus: async () => answer });
    await r.flow.recheck();
    assert.equal(r.last().k, "unconfirmed", JSON.stringify(answer));
  }
  const done = world({ phase: pending, callsStatus: async () => ({ status: "success", receipts: [{ status: "success", transactionHash: "0xt" }] }) });
  await done.flow.recheck();
  assert.deepEqual(done.last(), { k: "done", hash: "0xt", tab: "deposit", amount: 250_000_000n });
  assert.equal(done.toasts(), 1);
  // a batch the wallet reports as failed is an error: never "done", no success toast, nothing marked as deposited
  const failed = world({ phase: pending, callsStatus: async () => ({ status: "failure", receipts: [] }) });
  await failed.flow.recheck();
  assert.deepEqual(failed.last(), { k: "error", message: BATCH_FAILED });
  assert.ok(!failed.phases.some((p) => p.k === "done"));
  assert.equal(failed.toasts(), 0);
  // so is a "success" whose receipts include a revert
  const partial = world({ phase: pending, callsStatus: async () => ({ status: "success", receipts: [{ status: "reverted", transactionHash: "0xt" }] }) });
  await partial.flow.recheck();
  assert.deepEqual(partial.last(), { k: "error", message: BATCH_FAILED });
  assert.equal(partial.toasts(), 0);
});

test("a batch deposit that would revert, with the allowance in place, stops before the wallet's prompt", async () => {
  const w = world({ batching: true, allowance: 0n, reverts: (fn, withOverride) => fn === "deposit" && withOverride });
  await w.flow.deposit();
  assert.deepEqual(w.events, ["simulate:approve", "simulate:deposit+override"]);
  assert.equal(w.batches.length, 0);
  assert.equal(w.writes.length, 0);
  assert.deepEqual(w.last(), { k: "error", message: "deposit would revert" });
});

test("when the allowance override does not take, a batching wallet gets the simulated one-at-a-time path", async () => {
  const w = world({ batching: true, allowance: 0n, overrideTakes: false });
  await w.flow.deposit();
  assert.equal(w.batches.length, 0, "no batch sent on an unverified simulation");
  assert.deepEqual(w.writes.map((x) => x.functionName), ["approve", "deposit"]);
  assert.deepEqual(w.events, ["simulate:approve", "simulate:deposit"]); // the batch's approval check, then the real deposit simulation after the approval
  assert.equal(w.last().k, "done");
});

test("an approved batching wallet's single deposit is simulated before its prompt", async () => {
  const w = world({ batching: true });
  await w.flow.deposit();
  assert.deepEqual(w.events, ["simulate:deposit", "sendCalls"]);
  assert.equal((w.batches[0] as { calls: unknown[] }).calls.length, 1);
  assert.equal(w.last().k, "done");
});

test("a batching wallet's withdrawal is simulated before its prompt, and a revert sends nothing", async () => {
  const ok = world({ tab: "withdraw", batching: true });
  await ok.flow.withdraw();
  assert.deepEqual(ok.events, ["simulate:redeem", "sendCalls"]);
  const bad = world({ tab: "withdraw", batching: true, reverts: (fn) => fn === "redeem" });
  await bad.flow.withdraw();
  assert.deepEqual(bad.events, ["simulate:redeem"]);
  assert.equal(bad.batches.length, 0);
  assert.equal(bad.last().k, "error");
});

test("every wallet prompt is bound to the account that started the deposit", async () => {
  const w = world({ allowance: 0n });
  await w.flow.deposit();
  assert.equal(w.last().k, "done");
  for (const req of w.walletRequests) assert.deepEqual(req, { chainId: 8453, account: A });
  assert.deepEqual(w.writes.map((x) => [x.functionName, x.account]), [["approve", A], ["deposit", A]]);
});

test("a wallet switch during the first reads stops the deposit before any prompt, instead of falling back", async () => {
  const w = world({ allowance: 0n, onRead: (fn, s) => { if (fn === "allowance") s.account.value = B; } });
  await w.flow.deposit();
  assert.equal(w.walletRequests.length, 0, "no wallet client was requested for the other account");
  assert.equal(w.writes.length, 0);
  assert.equal(w.batches.length, 0);
  assert.match((w.last() as { message: string }).message, /switched accounts/);
});

test("a wallet switch while the approval confirms stops before the deposit prompt", async () => {
  const w = world({ allowance: 0n, afterApproval: (s) => { s.account.value = B; } });
  await w.flow.deposit();
  assert.deepEqual(w.writes.map((x) => x.functionName), ["approve"]);
  assert.match((w.last() as { message: string }).message, /switched accounts/);
});

test("the vault's terms are read again after the approval confirms; a change stops the deposit", async () => {
  const w = world({ allowance: 0n, terms: [reviewed, feeRaised] });
  await w.flow.deposit();
  assert.deepEqual(w.writes.map((x) => x.functionName), ["approve"], "no deposit prompt after the terms changed");
  assert.deepEqual(w.last(), { k: "error", message: pausedCopy("The vault now keeps 10% of the interest it earns.") });
  assert.equal(w.refetches(), 1, "the form is told to show the pause at once");
});

test("terms changed before anything was sent: no prompt at all", async () => {
  const w = world({ allowance: 0n, terms: [feeRaised] });
  await w.flow.deposit();
  assert.equal(w.writes.length, 0);
  assert.equal(w.last().k, "error");
});

test("a withdrawal whose receipt cannot be read stays unconfirmed too", async () => {
  const w = world({ tab: "withdraw", receipt: timeout });
  await w.flow.withdraw();
  assert.deepEqual(w.writes.map((x) => [x.functionName, x.account]), [["redeem", A]]);
  assert.deepEqual(w.last(), { k: "unconfirmed", tab: "withdraw", amount: 1_000_000_000n, sent: { kind: "tx", hash: "0xsent" }, checking: false, note: null });
});

test("the network switch is refused while a send is in flight or unsettled", async () => {
  const w = world();
  await w.rebind({ busy: true }).switchToVaultChain();
  assert.equal(w.switches(), 0);
  w.lock.current = true;
  await w.flow.switchToVaultChain();
  assert.equal(w.switches(), 0);
  w.lock.current = false;
  await w.flow.switchToVaultChain();
  assert.equal(w.switches(), 1);
});

test("a switch rejected after a send became unconfirmed leaves it unconfirmed; when idle it shows the error", async () => {
  let reject!: (e: Error) => void;
  const w = world({ switchChain: () => new Promise<void>((_, r) => { reject = r; }) });
  const pending = w.flow.switchToVaultChain();
  // meanwhile a send was made and its confirmation could not be read
  const unconfirmed: EarnPhase = { k: "unconfirmed", tab: "deposit", amount: 250_000_000n, sent: { kind: "tx", hash: "0xsent" }, checking: false, note: null };
  w.phases.push(unconfirmed);
  reject(new Error("User rejected the request."));
  await pending;
  assert.deepEqual(w.last(), unconfirmed, "the 'do not send again' state survives a late rejection");
  const idle = world({ switchChain: async () => { throw new Error("User rejected the request."); } });
  await idle.flow.switchToVaultChain();
  assert.deepEqual(idle.last(), { k: "error", message: "User rejected the request." });
});

test("a card that unmounted mid-action stops before its next prompt", async () => {
  const w = world({ onRead: (fn, s) => { if (fn === "allowance") s.mounted.current = false; } });
  await w.flow.deposit();
  assert.equal(w.writes.length, 0);
  assert.match((w.last() as { message: string }).message, /closed/);
});
