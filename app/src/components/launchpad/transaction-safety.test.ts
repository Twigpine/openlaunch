import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { type TestContext } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as launchJournal from "../../lib/launchpad/pending-launch";
import { waitForTrackedReceipt } from "../../lib/launchpad/transaction-receipt";
import { encodeAbiParameters, encodeEventTopics, type TransactionReceipt } from "viem";
import { ERC20_TRANSFER_EVENT } from "../../lib/launchpad/abi";
import { BOOST_TOKEN, BOOST_DEAD, boostAmount, boostWholeOf, boostShowsNow } from "../../lib/launchpad/boost";
import { boostReceiptAmount } from "../../lib/launchpad/boost-receipt";

/**
 * Execute the actual component handlers with inert dependencies. This avoids a
 * real wallet, RPC, or transaction while checking async control flow rather
 * than testing a duplicate implementation of the transaction logic.
 */
function handler(file: string, name: string, bindings: Record<string, unknown>): (...args: unknown[]) => Promise<void> {
  const source = readFileSync(new URL(file, import.meta.url), "utf8");
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let declaration = "";
  function visit(node: ts.Node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) declaration = node.getText(ast);
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.ok(declaration, `Missing ${name} handler in ${file}`);
  const { outputText } = ts.transpileModule(`(${declaration})`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } });
  return runInNewContext(outputText, bindings);
}

test("trade locks synchronously during preflight and a rejection allows retry", async () => {
  const transactionLock = { current: false };
  const phases: { k: string; message?: string }[] = [];
  let walletLookups = 0;
  let rejectWallet!: (error: Error) => void;
  const walletPending = new Promise<never>((_, reject) => { rejectWallet = reject; });
  const trade = handler("./TradePanel.tsx", "trade", {
    tradable: true, address: "wallet", amountIn: 1n, quote_: { out: 2n, forKey: "quote" }, quoteKey: "quote",
    busy: false, insufficient: false, transactionLock, onChain: true, CHAIN: { id: 8453 }, config: {},
    getPublicClient: () => ({}),
    getWalletClient: () => { walletLookups++; return walletPending; },
    setPhase: (phase: { k: string; message?: string }) => phases.push(phase),
    friendlyError: (error: Error) => error.message,
  });
  const first = trade();
  await trade(); // A second click before React has rendered the busy state.
  assert.equal(walletLookups, 1);
  assert.equal(transactionLock.current, true);
  assert.equal(phases[0]?.k, "preparing");
  rejectWallet(new Error("Wallet request rejected"));
  await first;
  assert.equal(transactionLock.current, false);
  assert.equal(phases.at(-1)?.k, "error");
  await trade();
  assert.equal(walletLookups, 2, "The failed request must not permanently lock trading");
  assert.equal(transactionLock.current, false);
});

test("trade releases the lock when synchronous preflight fails", async () => {
  const transactionLock = { current: false };
  const phases: { k: string }[] = [];
  const trade = handler("./TradePanel.tsx", "trade", {
    tradable: true, address: "wallet", amountIn: 1n, quote_: { out: 2n, forKey: "quote" }, quoteKey: "quote",
    busy: false, insufficient: false, transactionLock, onChain: true, CHAIN: { id: 8453 }, config: {},
    getPublicClient: () => { throw new Error("No RPC client"); },
    setPhase: (phase: { k: string }) => phases.push(phase), friendlyError: (error: Error) => error.message,
  });
  await trade();
  assert.equal(transactionLock.current, false);
  assert.deepEqual(phases.map((phase) => phase.k), ["preparing", "error"]);
});

test("trade never starts while an unlisted pair token's decimals are unknown", async () => {
  const transactionLock = { current: false };
  const phases: { k: string }[] = [];
  const trade = handler("./TradePanel.tsx", "trade", {
    tradable: false, address: "wallet", amountIn: 1n, quote_: { out: 2n, forKey: "quote" }, quoteKey: "quote",
    busy: false, insufficient: false, transactionLock, onChain: true, CHAIN: { id: 8453 }, config: {},
    getPublicClient: () => { throw new Error("must not be reached"); },
    setPhase: (phase: { k: string }) => phases.push(phase), friendlyError: (error: Error) => error.message,
  });
  await trade();
  assert.deepEqual(phases, [], "an amount parsed with placeholder decimals is never sent");
  assert.equal(transactionLock.current, false);
});

for (const status of ["reverted", "success"]) {
  test(`fee-panel collect and claim handle a ${status} receipt honestly`, async () => {
    for (const what of ["collect", "claim"]) {
      const effects: string[] = [];
      const phases: { k: string; message?: string }[] = [];
      const send = handler("./CollectPanel.tsx", "send", {
        LOCKER_ADDRESS: "locker", address: "wallet", config: {}, CHAIN: { id: 8453 },
        chain: "base", tokenId: 1, quote: { address: "quote" }, symbol: "TEST", isBurnOnly: false,
        LAUNCH_LOCKER_ABI: [], BUILDER_DATA_SUFFIX: "0x",
        setPhase: (phase: { k: string; message?: string }) => phases.push(phase),
        getPublicClient: () => ({ simulateContract: async () => ({ request: {} }), waitForTransactionReceipt: async () => ({ status }) }),
        getWalletClient: async () => ({ writeContract: async () => "0xhash" }),
        syncTransaction: async () => { effects.push("sync"); return { status: "applied", tokens: [] }; },
        mine: { refetch: () => effects.push("balance") }, router: { refresh: () => effects.push("refresh") },
        toast: () => effects.push("success toast"), friendlyError: (error: Error) => error.message,
      });
      await send(what);
      if (status === "reverted") {
        assert.deepEqual(effects, [], `${what} must not sync or show success for a revert`);
        assert.equal(phases.at(-1)?.k, "error");
        assert.equal(phases.at(-1)?.message, "Transaction reverted on-chain.");
      } else {
        assert.deepEqual(effects, ["sync", "balance", "refresh", "success toast"]);
        assert.equal(phases.at(-1)?.k, "idle");
      }
    }
  });

  test(`dashboard collection handles a ${status} receipt honestly and clears busy state`, async () => {
    const effects: string[] = [];
    const busyStates: (string | null)[] = [];
    const collect = handler("./MeDashboard.tsx", "collect", {
      address: "wallet", config: {}, CHAINS: { base: { id: 8453 } },
      launchpad: () => ({ locker: "locker" }), key: () => "base:token",
      LAUNCH_LOCKER_ABI: [], BUILDER_DATA_SUFFIX: "0x",
      setBusy: (value: string | null) => busyStates.push(value),
      getPublicClient: () => ({ simulateContract: async () => ({ request: {} }), waitForTransactionReceipt: async () => ({ status }) }),
      getWalletClient: async () => ({ writeContract: async () => "0xhash" }),
      syncTransaction: async () => { effects.push("sync"); return { status: "applied", tokens: [] }; }, load: async () => { effects.push("reload"); },
      isBurnOnly: () => false, friendlyError: (error: Error) => error.message,
      toast: (message: { kind: string }) => effects.push(message.kind === "collect" ? "success toast" : "failure toast"),
    });
    await collect({ chain: "base", token: "token", token_id: 1, symbol: "TEST", recipients: [] });
    assert.deepEqual(effects, status === "success" ? ["sync", "success toast", "reload"] : ["failure toast"]);
    assert.deepEqual(busyStates, ["base:token", null]);
  });
}

test("preparing a trade disables the same controls as signing and confirming", () => {
  const source = readFileSync(new URL("./TradePanel.tsx", import.meta.url), "utf8");
  assert.match(source, /const busy = phase\.k === "preparing" \|\| phase\.k === "approving"/);
  assert.match(source, /Preparing trade…/);
  assert.match(source, /<input[^>]*disabled=\{busy\}/);
  assert.match(source, /if \(!v\[0\] \|\| busy\) return/);
});

for (const status of ["pending", "error", "reverted", "applied"]) {
  test(`boost ${status} indexing retains its sent guard until indexing succeeds`, async () => {
    const pending: unknown[] = [];
    const phases: { k: string }[] = [];
    const effects: string[] = [];
    const settle = handler("./BoostDialog.tsx", "settle", {
      onPending: (value: unknown) => pending.push(value),
      setPhase: (value: { k: string }) => phases.push(value),
      syncTransaction: async () => ({ status }), INDEX_PENDING_COPY: "Still indexing", BOOST_CHAIN: "base",
      symbol: "TEST", token: "token", groupWhole: String,
      toast: () => effects.push("toast"), bal: { refetch: () => effects.push("balance") }, onBoosted: () => effects.push("boost"),
    });
    await settle("0xhash", 100n, true, true);
    if (status === "applied") {
      assert.deepEqual(pending, [null]);
      assert.equal(phases.at(-1)?.k, "done");
      assert.deepEqual(effects, ["toast", "balance", "boost"]);
    } else {
      assert.deepEqual(pending, [], "an indexing result cannot release the existing sent hash");
      assert.equal(phases.at(-1)?.k, "unconfirmed");
      assert.deepEqual(effects, [], "do not claim a lane change before the indexer applies it");
    }
  });
}

for (const state of [{ sentReady: false, waiting: false, payment_reorg: false }, { sentReady: true, waiting: true, payment_reorg: false }, { sentReady: true, waiting: false, payment_reorg: true }]) {
  test(`pair fee recovery blocks a new wallet action: ${JSON.stringify(state)}`, async () => {
    let started = false;
    const pay = handler("./PairApplication.tsx", "pay", {
      app: { quote: {}, payment_reorg: state.payment_reorg }, address: "wallet", lock: { current: false },
      sentReady: state.sentReady, waiting: state.waiting,
      pairApplicationOf: () => { started = true; throw Error("must not reach preflight"); },
    });
    await pay();
    assert.equal(started, false);
  });
}

const launchHash = `0x${"ab".repeat(32)}` as const;
const secondHash = `0x${"cd".repeat(32)}` as const;
const launcher = `0x${"12".repeat(20)}` as const;
const launchedToken = `0x${"34".repeat(20)}` as const;
function journalStorage(t: TestContext) {
  const disk = new Map([["ol:pending-launch", "null "]]);
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: { getItem: (k: string) => disk.get(k) ?? null, setItem: (k: string, v: string) => disk.set(k, v), removeItem: (k: string) => disk.delete(k) } });
  launchJournal.pendingLaunch();
  t.after(() => { disk.set("ol:pending-launch", "null  "); launchJournal.pendingLaunch(); launchJournal.rememberPendingLaunch(null); Reflect.deleteProperty(globalThis, "sessionStorage"); });
  return disk;
}
function launchHarness(t: TestContext, syncStatus: string) {
  const disk = journalStorage(t);
  const effects: string[] = [];
  const phases: { k: string }[] = [];
  let sends = 0;
  const pub = {
    getChainId: async () => 8453,
    getTransaction: async () => ({ hash: launchHash, from: launcher, nonce: 7 }),
    getTransactionCount: async () => 8,
    simulateContract: async () => ({ request: {} }),
    waitForTransactionReceipt: async () => ({ transactionHash: launchHash, status: "success", logs: [] }),
  };
  const bindings = {
    ...launchJournal, waitForTrackedReceipt, valid: true, address: launcher, cfg: { factory: launcher, v4: {} }, startTick: 1,
    launchLock: { current: false }, saltRef: { current: null }, metaKeyRef: { current: null }, randomSalt: () => launchHash,
    chain: "base", name: "Test", symbolClean: "TEST", description: "", image: "", banner: "", website: "", x: "", onChain: true,
    CHAIN: { id: 8453 }, CHAIN_LABEL: "Base", CHAINS: { base: { id: 8453 } }, config: {}, quote: { address: launcher },
    fetch: async () => ({ status: 200, json: async () => ({ uri: "https://synthetic.invalid/meta", token: launchedToken }) }),
    getPublicClient: () => pub, getWalletClient: async () => ({ writeContract: async () => { sends++; return launchHash; } }),
    setPhase: (phase: { k: string }) => phases.push(phase), isNativeQuote: () => true,
    DEFAULT_SUPPLY: 1n, feePips: 0, recipients: [], LAUNCH_FACTORY_ABI: [], BUILDER_DATA_SUFFIX: "0x", FIRST_BUY_SLIPPAGE_BPS: 300,
    parseEventLogs: () => [{ args: { token: launchedToken } }], initialBuyRaw: 1n,
    firstBuy: async (ctx: { recordBuy: (buy: object) => void }) => { ctx.recordBuy({ hash: secondHash, status: "confirmed", amount: "10", exact: true }); return { hash: secondHash, out: 10n, exact: true }; },
    syncTransaction: async (_chain: string, hash: string) => { effects.push(`sync:${hash}`); return { status: syncStatus, tokens: [launchedToken] }; },
    toast: (toast: { kind: string }) => effects.push(`toast:${toast.kind}`), fmtCompact: String,
    friendlyError: (error: Error) => error.message, startNav: () => {}, router: { push: (url: string) => effects.push(`navigate:${url}`) },
  };
  return { bindings, disk, effects, phases, pub, sends: () => sends };
}

for (const status of ["pending", "error", "applied"]) test(`actual launch retains confirmed first buy across ${status} indexing`, async (t) => {
  const h = launchHarness(t, status);
  const launch = handler("./LaunchForm.tsx", "launch", h.bindings);
  await launch();
  assert.equal(h.sends(), 1);
  assert.ok(h.effects.indexOf("toast:buy") < h.effects.indexOf(`sync:${launchHash}`), "confirmed buy is reported before launch sync can fail");
  h.disk.set("ol:pending-launch", h.disk.get("ol:pending-launch")! + " ");
  const retained = status === "applied" ? launchJournal.recentLaunches()[0] : launchJournal.pendingLaunch();
  assert.equal(retained?.firstBuy?.hash, secondHash);
  assert.equal(retained?.firstBuy?.status, "confirmed");
  assert.equal(retained?.hash, launchHash);
  if (status !== "applied") { await launch(); assert.equal(h.sends(), 1, "pending outcome never starts a second wallet send"); }
  else assert.equal(launchJournal.pendingLaunch(), null, "indexed reference does not block unrelated new launches");
});

test("explicit finalized-nonce resolution archives only the checked active launch", async (t) => {
  const h = launchHarness(t, "pending");
  await handler("./LaunchForm.tsx", "launch", h.bindings)();
  h.pub.getTransactionCount = async () => 7;
  const resolve = handler("./LaunchForm.tsx", "resolveLaunch", h.bindings);
  assert.equal(await resolve(launchHash), false);
  assert.equal(launchJournal.pendingLaunch()?.hash, launchHash);
  h.pub.getTransactionCount = async () => 8;
  assert.equal(await resolve(launchHash), true);
  assert.equal(launchJournal.pendingLaunch(), null);
  assert.equal(launchJournal.recentLaunches()[0].outcome, "nonce-finalized");
  assert.equal(launchJournal.recentLaunches()[0].firstBuy?.hash, secondHash);
  assert.equal(h.sends(), 1, "resolution has no wallet write");
});

test("a later launch revert preserves its independent first-buy reference", async (t) => {
  const h = launchHarness(t, "pending");
  await handler("./LaunchForm.tsx", "launch", h.bindings)();
  await handler("./LaunchForm.tsx", "recoverLaunch", h.bindings)(launchHash, { status: "reverted" });
  assert.equal(launchJournal.pendingLaunch(), null);
  assert.equal(launchJournal.recentLaunches()[0].outcome, "reverted");
  assert.equal(launchJournal.recentLaunches()[0].firstBuy?.hash, secondHash);
  assert.equal(h.sends(), 1);
});

const boostTag = 123n;
const boostLocker = `0x${"44".repeat(20)}`;
function boostReceipt(raw = boostAmount(300_000n, boostTag)): TransactionReceipt {
  return { status: "success", transactionHash: secondHash, logs: [{ address: BOOST_TOKEN, transactionHash: secondHash, blockNumber: 1n, logIndex: 0, removed: false,
    data: encodeAbiParameters([{ type: "uint256" }], [raw]),
    topics: encodeEventTopics({ abi: [ERC20_TRANSFER_EVENT], eventName: "Transfer", args: { from: launcher, to: BOOST_DEAD } }),
  }] } as unknown as TransactionReceipt;
}
function boostHarness(reason: string, receipt: TransactionReceipt, options: { waitError?: boolean; syncStatus?: string; syncWait?: Promise<void> } = {}) {
  const pending: ({ hash: string; whole: bigint; replaced?: boolean } | null)[] = [];
  const phases: { k: string; hash?: string; whole?: bigint; raw?: bigint; shows?: boolean }[] = [];
  const synced: string[] = [];
  const effects: string[] = [];
  let sends = 0;
  const original = { hash: launchHash, from: launcher, to: launcher, nonce: 7, input: "0xab", value: 0n };
  const pub = {
    simulateContract: async () => ({ request: {} }),
    waitForTransactionReceipt: async ({ onReplaced }: { onReplaced: (event: unknown) => void }) => {
      onReplaced({ reason: reason === "invalid" ? "repriced" : reason, replacedTransaction: original,
        transaction: { ...original, hash: secondHash, nonce: reason === "invalid" ? 8 : 7, input: reason === "repriced" || reason === "invalid" ? original.input : "0xcd" }, transactionReceipt: { transactionHash: secondHash } });
      if (options.waitError) throw new Error("Receipt timeout");
      return receipt;
    },
    getTransactionReceipt: async () => receipt,
  };
  const bindings: Record<string, unknown> = {
    address: launcher, raw: boostAmount(100_000n, boostTag), whole: 100_000n, busy: false, lock: { current: false }, chainId: 8453, BASE: { id: 8453 }, config: {},
    getPublicClient: () => pub, getWalletClient: async () => ({ writeContract: async () => { sends++; return launchHash; } }), waitForTrackedReceipt,
    BOOST_TOKEN, ERC20_TRANSFER_ABI: [], DEAD: BOOST_DEAD, BUILDER_DATA_SUFFIX: "0x", BOOST_CHAIN: "base", tag: boostTag,
    setPhase: (p: { k: string }) => { phases.push(p); bindings.phase = p; bindings.busy = ["preparing", "signing", "sent", "unconfirmed"].includes(p.k); },
    onPending: (value: typeof pending[number]) => pending.push(value), showsAfter: () => false, friendlyError: (error: Error) => error.message,
    boostReceiptAmount, boostWholeOf, boostShowsNow, launchpad: () => ({ locker: boostLocker }), entry: { full: true, cutoff: String(boostAmount(200_000n, boostTag)) }, current: 0n, inLane: false,
    syncTransaction: async (_chain: string, hash: string) => { synced.push(hash); await options.syncWait; return { status: options.syncStatus ?? "applied" }; }, INDEX_PENDING_COPY: "Still indexing",
    symbol: "TEST", token: "token", groupWhole: String, toast: () => effects.push("toast"), bal: { refetch: () => effects.push("balance") }, onBoosted: () => effects.push("boost"),
  };
  bindings.settle = handler("./BoostDialog.tsx", "settle", bindings);
  bindings.settleReceipt = handler("./BoostDialog.tsx", "settleReceipt", bindings);
  return { send: handler("./BoostDialog.tsx", "send", bindings), checkAgain: handler("./BoostDialog.tsx", "checkAgain", bindings), bindings, pending, phases, synced, effects, pub, sends: () => sends };
}

test("actual changed boost retains its hash through indexing and settles the actual burn amount", async () => {
  let finish!: () => void;
  const h = boostHarness("replaced", boostReceipt(), { syncWait: new Promise<void>((resolve) => { finish = resolve; }) });
  const sending = h.send();
  while (!h.synced.length) await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual({ ...h.pending.at(-1) }, { hash: secondHash, whole: 300_000n, replaced: true });
  await h.send();
  assert.equal(h.sends(), 1, "the replacement cannot invite a second wallet send while indexing");
  finish(); await sending;
  assert.deepEqual(h.synced, [secondHash]);
  assert.equal(h.pending.at(-1), null);
  assert.equal(h.phases.at(-1)?.k, "done");
  assert.equal(h.phases.at(-1)?.whole, 300_000n);
  assert.equal(h.phases.at(-1)?.raw, boostAmount(300_000n, boostTag));
  assert.equal(h.phases.at(-1)?.shows, true, "the original amount would not enter this lane");
});

test("changed boost totals actual fractional burns for lane eligibility", async () => {
  const raw = boostAmount(100_000n, boostTag) + 10n ** 12n;
  const receipt = boostReceipt(raw);
  receipt.logs.push({ ...receipt.logs[0], logIndex: 1 });
  const h = boostHarness("replaced", receipt);
  h.bindings.entry = { full: true, cutoff: String(2n * raw) };
  await h.send();
  assert.equal(h.phases.at(-1)?.raw, 2n * raw);
  assert.equal(h.phases.at(-1)?.shows, true, "do not drop fractional TWIG or a second matching burn");
});

for (const syncStatus of ["pending", "error"]) test(`changed boost survives ${syncStatus} indexing and close/reopen without resending`, async () => {
  const options = { syncStatus };
  const h = boostHarness("replaced", boostReceipt(), options);
  await h.send();
  assert.equal(h.phases.at(-1)?.k, "unconfirmed");
  assert.deepEqual({ ...h.pending.at(-1) }, { hash: secondHash, whole: 300_000n, replaced: true });
  h.bindings.phase = { k: "unconfirmed", ...h.pending.at(-1), checking: false, note: null }; // the dialog's actual reopen initializer
  await h.send(); assert.equal(h.sends(), 1);
  options.syncStatus = "applied";
  await h.checkAgain();
  assert.deepEqual(h.synced, [secondHash, secondHash]);
  assert.equal(h.phases.at(-1)?.whole, 300_000n);
  assert.equal(h.pending.at(-1), null);
});

test("changed callback followed by timeout retains the replacement for a later receipt recheck", async () => {
  const h = boostHarness("replaced", boostReceipt(), { waitError: true });
  await h.send();
  assert.equal(h.phases.at(-1)?.k, "unconfirmed");
  assert.equal(h.pending.at(-1)?.hash, secondHash);
  assert.equal(h.pending.at(-1)?.replaced, true);
  await h.send(); assert.equal(h.sends(), 1);
  await h.checkAgain();
  assert.deepEqual(h.synced, [secondHash]);
  assert.equal(h.phases.at(-1)?.whole, 300_000n);
});

for (const reason of ["repriced", "cancelled", "reverted", "invalid", "unknown", "wrong-hash", "malformed"]) test(`actual boost resolves ${reason} only with matching receipt evidence`, async () => {
  const rc = boostReceipt();
  if (reason === "cancelled") rc.logs = [];
  if (reason === "reverted") rc.status = "reverted";
  if (reason === "unknown") rc.status = "unknown" as TransactionReceipt["status"];
  if (reason === "wrong-hash") rc.transactionHash = launchHash;
  if (reason === "malformed") rc.logs[0].data = "0x";
  const h = boostHarness(["repriced", "cancelled", "invalid"].includes(reason) ? reason : "replaced", rc);
  await h.send();
  if (reason === "repriced") {
    assert.deepEqual(h.synced, [secondHash]);
    assert.equal(h.phases.at(-1)?.k, "done");
    assert.equal(h.phases.at(-1)?.whole, 100_000n, "unchanged repricing keeps the submitted amount");
  } else if (reason === "cancelled" || reason === "reverted") {
    assert.equal(h.pending.at(-1), null, "known receipt outcome resolves the guard");
    assert.equal(h.phases.at(-1)?.k, "error");
    assert.equal(h.phases.at(-1)?.hash, secondHash, "the resolved replacement keeps its explorer reference");
    assert.deepEqual(h.synced, []);
    assert.ok(!h.effects.includes("toast"));
  } else {
    assert.equal(h.phases.at(-1)?.k, "unconfirmed");
    assert.equal(h.pending.at(-1)?.hash, reason === "invalid" ? launchHash : secondHash);
    assert.deepEqual(h.synced, []);
    await h.send(); assert.equal(h.sends(), 1);
  }
});
