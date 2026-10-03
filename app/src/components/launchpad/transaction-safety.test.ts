import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

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
        fetch: async () => { effects.push("sync"); },
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
      fetch: async () => { effects.push("sync"); }, load: async () => { effects.push("reload"); },
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
