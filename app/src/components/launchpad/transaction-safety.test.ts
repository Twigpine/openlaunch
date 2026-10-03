import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { hasFees } from "@/lib/launchpad/creator";
import { NATIVE, SWAP_GAS_RESERVE_WEI, quoteInfo, sharesGasBalance } from "@/lib/launchpad/config";
import { requiredTradeNativeBalance } from "@/lib/launchpad/trade-gas";
import { parseUnits } from "viem";
import { CHAINS } from "@/lib/chainPublic";

/**
 * Execute the actual component handlers with inert dependencies. This avoids a
 * real wallet, RPC, or transaction while checking async control flow rather
 * than testing a duplicate implementation of the transaction logic.
 */
function handler(file: string, name: string, bindings: Record<string, unknown>): (...args: unknown[]) => Promise<unknown> {
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
    busy: false, insufficient: false, gasStatus: "ready", transactionLock, onChain: true, CHAIN: { id: 8453 }, config: {},
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
    busy: false, insufficient: false, gasStatus: "ready", transactionLock, onChain: true, CHAIN: { id: 8453 }, config: {},
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
    busy: false, insufficient: false, gasStatus: "ready", transactionLock, onChain: true, CHAIN: { id: 8453 }, config: {},
    getPublicClient: () => { throw new Error("must not be reached"); },
    setPhase: (phase: { k: string }) => phases.push(phase), friendlyError: (error: Error) => error.message,
  });
  await trade();
  assert.deepEqual(phases, [], "an amount parsed with placeholder decimals is never sent");
  assert.equal(transactionLock.current, false);
});

for (const side of ["buy", "sell"] as const) {
  for (const chain of ["base", "robinhood", "arc"] as const) {
    for (const gasRead of ["insufficient", "failed"] as const) {
      test(`${chain} ERC-20 ${side} never requests approval when the fresh gas balance is ${gasRead}`, async () => {
        const effects: string[] = [];
        const phases: { k: string; message?: string }[] = [];
        const transactionLock = { current: false };
        const trade = handler("./TradePanel.tsx", "trade", {
          tradable: true, address: "wallet", amountIn: 1n, quote_: { out: 2n, forKey: "quote" }, quoteKey: "quote",
          busy: false, insufficient: false, gasStatus: "ready", transactionLock, onChain: true, CHAIN: CHAINS[chain], config: {},
          side, chain, isNative: false, quote: { address: "quote" }, token: "token", V4: { permit2: "permit2" },
          requiredNativeBalance: 10n, NATIVE_SYMBOL: chain === "arc" ? "USDC" : "ETH",
          gasBalanceError: "Could not check the gas balance. Retry.", gasInsufficientMessage: "Not enough native currency for gas.",
          slippageBps: 100, minOut: () => 1n, ERC20_MIN_ABI: [], maxUint256: 100n, BUILDER_DATA_SUFFIX: "0x",
          getPublicClient: (_config: unknown, { chainId }: { chainId: number }) => {
            assert.equal(chainId, CHAINS[chain].id);
            return {
              getBalance: async ({ address }: { address: string }) => { assert.equal(address, "wallet"); effects.push("gas"); if (gasRead === "failed") throw new Error("RPC offline"); return 0n; },
              readContract: async () => { effects.push("allowance"); return 0n; },
            };
          },
          getWalletClient: async (_config: unknown, { chainId }: { chainId: number }) => {
            assert.equal(chainId, CHAINS[chain].id);
            return { writeContract: async () => { effects.push("sign"); throw new Error("unexpected approval"); } };
          },
          setPhase: (phase: { k: string; message?: string }) => phases.push(phase), friendlyError: (error: Error) => error.message,
        });
        await trade();
        assert.deepEqual(effects, ["gas"], "cached token funds and a prior ready state cannot bypass fresh gas preflight");
        assert.equal(phases.at(-1)?.k, "error");
        assert.equal(phases.at(-1)?.message, gasRead === "failed" ? "Could not check the gas balance. Retry." : "Not enough native currency for gas.");
        assert.equal(transactionLock.current, false);
      });
    }
  }
}

for (const gasStatus of ["loading", "error", "insufficient"] as const) {
  test(`trade blocks a ${gasStatus} gas balance before wallet lookup`, async () => {
    const phases: unknown[] = [];
    const transactionLock = { current: false };
    const trade = handler("./TradePanel.tsx", "trade", {
      tradable: true, address: "wallet", amountIn: 1n, quote_: { out: 2n, forKey: "quote" }, quoteKey: "quote",
      busy: false, insufficient: false, gasStatus, transactionLock,
      setPhase: (phase: unknown) => phases.push(phase),
      getWalletClient: () => { throw new Error("No wallet lookup should occur"); },
    });
    await trade();
    assert.deepEqual(phases, []);
    assert.equal(transactionLock.current, false);
  });
}

for (const side of ["buy", "sell"] as const) {
  for (const chain of ["base", "robinhood", "arc"] as const) {
    test(`funded ${chain} ${side} reaches the router only after a fresh native gas check`, async () => {
      const quote = quoteInfo(chain, chain === "arc" ? "0x3600000000000000000000000000000000000000" : NATIVE);
      const isNative = quote.address === NATIVE;
      const amountIn = parseUnits("1", side === "buy" ? quote.decimals : 18);
      const requiredNativeBalance = requiredTradeNativeBalance({ amountIn, spendsNativeBalance: side === "buy" && (isNative || sharesGasBalance(chain, quote)), quoteDecimals: quote.decimals, reserveWei: SWAP_GAS_RESERVE_WEI[chain] });
      for (const sufficient of [false, true]) {
        const effects: string[] = [];
        const trade = handler("./TradePanel.tsx", "trade", {
          tradable: true, address: "wallet", amountIn, quote_: { out: 2n, forKey: "quote" }, quoteKey: "quote",
          busy: false, insufficient: false, gasStatus: "ready", transactionLock: { current: false }, onChain: true, CHAIN: CHAINS[chain], config: {},
          side, chain, isNative, quote, token: "token", V4: { permit2: "permit2", universalRouter: "router" }, poolKey: {},
          requiredNativeBalance, gasBalanceError: "Cannot read gas", gasInsufficientMessage: "Not enough gas",
          slippageBps: 100, minOut: () => 1n, ERC20_MIN_ABI: [], PERMIT2_ABI: [], UNIVERSAL_ROUTER_ABI: [], BUILDER_DATA_SUFFIX: "0x",
          encodeV4ExactInSingle: () => ({ commands: "0x", inputs: [] }),
          getPublicClient: (_config: unknown, { chainId }: { chainId: number }) => {
            assert.equal(chainId, CHAINS[chain].id);
            return {
              getBalance: async ({ address }: { address: string }) => { assert.equal(address, "wallet"); effects.push("gas"); return sufficient ? requiredNativeBalance : requiredNativeBalance - 1n; },
              readContract: async ({ address }: { address: string }) => address === "permit2" ? [amountIn, Math.floor(Date.now() / 1000) + 3600] : amountIn,
              simulateContract: async ({ value }: { value: bigint }) => { effects.push("simulate"); assert.equal(value, side === "buy" && isNative ? amountIn : 0n); return { request: {} }; },
            };
          },
          getWalletClient: async (_config: unknown, { chainId }: { chainId: number }) => {
            assert.equal(chainId, CHAINS[chain].id);
            return { writeContract: async () => { effects.push("sign"); throw new Error("Stop before a real transaction"); } };
          },
          setPhase: () => {}, friendlyError: (error: Error) => error.message,
        });
        await trade();
        assert.deepEqual(effects, sufficient ? ["gas", "simulate", "sign"] : ["gas"]);
      }
    });
  }
}

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
    const stages: string[] = [];
    const mounted = { current: true };
    const collecting = { current: false };
    const collect = handler("./MeDashboard.tsx", "collect", {
      mounted, collecting,
      address: "wallet", config: {}, CHAINS: { base: { id: 8453 } },
      launchpad: () => ({ locker: "locker" }), key: () => "base:token",
      LAUNCH_LOCKER_ABI: [], BUILDER_DATA_SUFFIX: "0x",
      setBusy: (value: string | null) => busyStates.push(value),
      setCollection: (value: { stage: string }) => stages.push(value.stage),
      getPublicClient: () => ({ simulateContract: async () => ({ request: {} }), waitForTransactionReceipt: async () => ({ status }) }),
      getWalletClient: async () => ({ writeContract: async () => "0xhash" }),
      fetch: async () => { effects.push("sync"); }, load: async () => { effects.push("reload"); },
      isBurnOnly: () => false, friendlyError: (error: Error) => error.message,
      toast: (message: { kind: string }) => effects.push(message.kind === "collect" ? "success toast" : "failure toast"),
    });
    assert.equal(await collect({ chain: "base", token: "token", token_id: 1, symbol: "TEST", recipients: [] }), status === "success");
    assert.deepEqual(effects, status === "success" ? ["sync", "success toast", "reload"] : ["failure toast"]);
    assert.deepEqual(busyStates, ["base:token", null]);
    assert.equal(collecting.current, false);
    assert.deepEqual(stages, status === "success" ? ["checking", "signing", "confirming", "syncing", "confirmed"] : ["checking", "signing", "confirming", "failed"]);
  });
}

for (const unmountAt of ["wallet", "simulation", "receipt", "reload"] as const) {
  test(`dashboard account change during ${unmountAt} stops later account-scoped actions`, async () => {
    const mounted = { current: true };
    const collecting = { current: false };
    const effects: string[] = [];
    const stateAfterUnmount: string[] = [];
    const update = (name: string) => { if (!mounted.current) stateAfterUnmount.push(name); };
    const collect = handler("./MeDashboard.tsx", "collect", {
      mounted, collecting, address: "old-wallet", config: {}, CHAINS: { base: { id: 8453 } },
      launchpad: () => ({ locker: "locker" }), key: () => "base:token",
      LAUNCH_LOCKER_ABI: [], BUILDER_DATA_SUFFIX: "0x",
      setBusy: () => update("busy"), setCollection: () => update("collection"),
      getWalletClient: async () => {
        if (unmountAt === "wallet") mounted.current = false;
        return { writeContract: async () => { effects.push("sign"); return "0xhash"; } };
      },
      getPublicClient: () => ({
        simulateContract: async () => { effects.push("simulate"); if (unmountAt === "simulation") mounted.current = false; return { request: {} }; },
        waitForTransactionReceipt: async () => { effects.push("receipt"); if (unmountAt === "receipt") mounted.current = false; return { status: "success" }; },
      }),
      fetch: async () => effects.push("sync"), load: async () => { effects.push("reload"); if (unmountAt === "reload") mounted.current = false; },
      toast: () => effects.push("toast"), isBurnOnly: () => false, friendlyError: (error: Error) => error.message,
    });
    assert.equal(await collect({ chain: "base", token: "token", token_id: 1, symbol: "TEST", recipients: [] }), false);
    assert.deepEqual(effects, unmountAt === "wallet" ? [] : unmountAt === "simulation" ? ["simulate"] : unmountAt === "receipt" ? ["simulate", "sign", "receipt"] : ["simulate", "sign", "receipt", "sync", "toast", "reload"]);
    assert.deepEqual(stateAfterUnmount, []);
    assert.equal(collecting.current, false);
  });
}

test("dashboard collection locks before wallet lookup and permits retry after rejection", async () => {
  const collecting = { current: false };
  let walletLookups = 0;
  let rejectWallet!: (error: Error) => void;
  const pendingWallet = new Promise<never>((_, reject) => { rejectWallet = reject; });
  const collect = handler("./MeDashboard.tsx", "collect", {
    mounted: { current: true }, collecting, address: "wallet", config: {}, CHAINS: { base: { id: 8453 } },
    launchpad: () => ({ locker: "locker" }), key: () => "base:token",
    setBusy: () => {}, setCollection: () => {}, getPublicClient: () => ({}),
    getWalletClient: () => { walletLookups++; return pendingWallet; },
    toast: () => {}, friendlyError: (error: Error) => error.message,
  });
  const launch = { chain: "base", token: "token", token_id: 1, symbol: "TEST" };
  const first = collect(launch);
  assert.equal(await collect(launch), false);
  assert.equal(walletLookups, 1);
  rejectWallet(new Error("Wallet request rejected"));
  assert.equal(await first, false);
  assert.equal(collecting.current, false);
  await collect(launch);
  assert.equal(walletLookups, 2);
});

test("collect-all includes token-only fees, skips empty or unknown pools and stops at rejection", async () => {
  const collectingBatch = { current: false };
  const items: string[] = [];
  const batches: ({ completed: number; total: number } | null)[] = [];
  const collectAll = handler("./MeDashboard.tsx", "collectAll", {
    me: { launches: [{ token: "one" }, { token: "unknown" }, { token: "empty" }, { token: "two" }, { token: "three" }] },
    pending: { one: { quote: 0n, token: 1n }, unknown: null, empty: { quote: 0n, token: 0n }, two: { quote: 2n, token: 0n }, three: { quote: 0n, token: 3n } },
    hasFees,
    key: (launch: { token: string }) => launch.token,
    mounted: { current: true }, collecting: { current: false }, collectingBatch,
    setBatch: (batch: { completed: number; total: number } | null) => batches.push(batch ? { ...batch } : null),
    collect: async (launch: { token: string }) => { items.push(launch.token); return launch.token !== "two"; },
  });
  await collectAll();
  assert.deepEqual(items, ["one", "two"]);
  assert.deepEqual(batches, [{ completed: 0, total: 3 }, { completed: 1, total: 3 }, null]);
  assert.equal(collectingBatch.current, false);
});

test("collect-all does not request the next signature after its wallet boundary unmounts", async () => {
  const mounted = { current: true };
  const collectingBatch = { current: false };
  let calls = 0;
  let staleUpdates = 0;
  const collectAll = handler("./MeDashboard.tsx", "collectAll", {
    me: { launches: [{ token: "one" }, { token: "two" }] },
    pending: { one: { quote: 0n, token: 1n }, two: { quote: 1n, token: 0n } }, hasFees,
    key: (launch: { token: string }) => launch.token, mounted, collecting: { current: false }, collectingBatch,
    setBatch: () => { if (!mounted.current) staleUpdates++; },
    collect: async () => { calls++; mounted.current = false; return true; },
  });
  await collectAll();
  assert.equal(calls, 1);
  assert.equal(staleUpdates, 0);
  assert.equal(collectingBatch.current, false);
});

test("preparing a trade disables the same controls as signing and confirming", () => {
  const source = readFileSync(new URL("./TradePanel.tsx", import.meta.url), "utf8");
  assert.match(source, /const busy = phase\.k === "preparing" \|\| phase\.k === "approving"/);
  assert.match(source, /Preparing trade…/);
  assert.match(source, /<input[^>]*disabled=\{busy\}/);
  assert.match(source, /if \(!v\[0\] \|\| busy\) return/);
});

test("every connected trade fetches gas and exposes a blocked-balance recovery action", () => {
  const source = readFileSync(new URL("./TradePanel.tsx", import.meta.url), "utf8");
  assert.match(source, /useBalance\(\{ address, chainId: CHAIN\.id, query: \{ enabled: Boolean\(address\),/);
  assert.match(source, /disabled=\{busy \|\| amountIn === null[^}]+gasStatus !== "ready"\}/);
  assert.match(source, /onClick=\{\(\) => void eth\.refetch\(\)\} disabled=\{eth\.isFetching\}/);
  assert.match(source, /Checking \$\{NATIVE_SYMBOL\} for gas/);
});
