import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { minOut } from "../../lib/launchpad/math.ts";

const source = readFileSync(new URL("./LaunchForm.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("LaunchForm.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

test("launch merge preserves optional funding checks and post-launch buy isolation", () => {
  assert.match(source, /initialBuyRaw && address && buyBalance === undefined/);
  assert.match(source, /initialBuyRaw \+ reserveInQuote > buyBalance/);
  // the reserve covers both transactions (the launch is sent first and pays its own gas before the buy runs) and is per chain;
  // it comes out of the quote balance for ETH and for a quote that IS the gas token (USDC on Arc), never for another ERC-20
  assert.match(source, /const gasReserve = GAS_RESERVE_WEI\[chain\];/);
  assert.match(source, /const sharedGas = sharesGasBalance\(chain, quote\);/);
  assert.match(source, /const reserveInQuote = quote\.key === "eth" \|\| sharedGas \? gasReserveInQuote\(gasReserve, quote\.decimals\) : 0n;/);
  assert.doesNotMatch(source, /not enough ETH/, "gas copy names the chain's native asset, not ETH");
  assert.match(source, /if \(initialBuyRaw && ev\?\.args\.token\) \{\s*try \{/);
  assert.match(source, /buyProblem = friendlyError\(err, \{ slippagePct: FIRST_BUY_SLIPPAGE_BPS \/ 100 \}\)/);
  const receiptCheck = source.indexOf('if (receipt.status !== "success")');
  const buyCall = source.indexOf("await firstBuy(");
  assert.ok(receiptCheck >= 0, "Launch receipt status check must remain");
  assert.ok(buyCall >= 0, "Optional first buy call must remain");
  assert.ok(receiptCheck < buyCall, "The receipt status check must run before the first buy");
  assert.match(source, /if \(buyHash\) await fetch\(`\/api\/launch\/sync\?chain=\$\{chain\}&tx=\$\{buyHash\}/);
  assert.match(source, /Launched, but the first buy did not go through/);
  assert.match(source, /buying: "Launched! Buying your first tokens…"/);
});

test("launch merge retains chain-scoped marks and honest optional-buy copy", () => {
  assert.match(source, /<TokenAvatar chain=\{chain\}/);
  assert.match(source, /label=\{initialBuyRaw \? "Launch \+ first buy" : "Launch for free, gas only"\}/);
  // a suggested buy is computed from a known, sufficient balance and can be cleared; a typed amount keeps the strict checks
  assert.match(source, /suggestFirstBuy\(\{ quote, connected: Boolean\(address\) && onChain, balance: buyBalance, nativeBalance, balanceFailed: buyBalanceFailed \|\| ethBal\.isError, gasReserve, sharesGasBalance: sharedGas, declined: buyDeclined \|\| Boolean\(typedBuy\)/);
  // an ERC-20 quote's typed buy is checked for native gas too, not only the token balance
  // …and only for a quote that does not share the gas balance (Arc USDC already had the reserve applied above: one shortfall, one message)
  assert.match(source, /initialBuyRaw && quote\.key !== "eth" && !sharedGas && nativeBalance !== undefined && nativeBalance < gasReserve/);
  assert.match(source, /const initialBuy = typedBuy \|\| suggestion\.amount \|\| ""/);
  // a typed amount is bound to the quote it was typed for, so a chain or quote switch drops it instead of re-reading it as another asset
  assert.match(source, /const quoteId = `\$\{chain\}:\$\{quote\.address\.toLowerCase\(\)\}`/);
  assert.match(source, /const typedBuy = typedBuyFor && typedBuyFor\.quoteId === quoteId \? typedBuyFor\.amount : ""/);
  assert.match(source, /setTypedBuyFor\(\{ amount: v, quoteId \}\)/);
  assert.match(source, /No first buy/);
  assert.match(source, /Clear it and the launch stays free/);
  // a cleared suggestion is visible and reversible; only the explicit button persists for the session
  assert.match(source, /suggestion\.reason === "declined" && !typedBuy/);
  assert.match(source, /onClick=\{suggestAgain\}/);
  assert.match(source, /onClick=\{\(\) => declineFirstBuy\(true\)\}/);
  assert.match(source, /if \(forSession\) setFirstBuyDeclined\(true\)/);
  // hydration: the session flag is read through useSyncExternalStore with a false server snapshot, never in a state initializer
  assert.match(source, /useSyncExternalStore\(subscribeFirstBuyDeclined, getFirstBuyDeclined, getFirstBuyDeclinedServer\)/);
  assert.doesNotMatch(source, /sessionStorage/, "the form never touches sessionStorage directly");
  assert.match(source, /suggestion\.reason === "unknown-balance"/);
  assert.match(source, /Other traders can buy before you/);
  assert.match(source, /First-buy slippage tolerance: \{FIRST_BUY_SLIPPAGE_BPS \/ 100\}%/);
  assert.match(source, /Network gas and pool fees apply/);
  assert.doesNotMatch(source, /first holder/i);
  // (no em-dash policing: the site copy voice is the maintainers' call)
});

for (const status of ["success", "reverted"]) {
  test(`optional native buy preserves 3% tolerance and handles a ${status} receipt`, async () => {
    let declaration = "";
    function visit(node: ts.Node) {
      if (ts.isFunctionDeclaration(node) && node.name?.text === "firstBuy") declaration = node.getText(ast);
      ts.forEachChild(node, visit);
    }
    visit(ast);
    assert.ok(declaration);
    let encodedMinimum: bigint | undefined;
    let sentValue: bigint | undefined;
    const { outputText } = ts.transpileModule(`(${declaration})`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } });
    // Inert wallet/RPC dependencies: no connection, signature or network request.
    const firstBuy = runInNewContext(outputText, {
      TICK_SPACING: 200, zeroAddress: "zero", V4_QUOTER_ABI: [], UNIVERSAL_ROUTER_ABI: [], ERC20_TRANSFER_EVENT: {},
      FIRST_BUY_SLIPPAGE_BPS: 300, BUILDER_DATA_SUFFIX: "0x", minOut,
      encodeV4ExactInSingle: (input: { minOut: bigint }) => { encodedMinimum = input.minOut; return { commands: "0x10", inputs: [] }; },
      parseEventLogs: () => [
        { address: "token", args: { to: "wallet", value: 975n } },
        { address: "other-token", args: { to: "wallet", value: 500n } },
        { address: "token", args: { to: "other-wallet", value: 20n } },
      ],
    }) as (ctx: unknown, token: string, hash: string, amount: bigint) => Promise<{ hash: string; out: bigint; exact: boolean }>;
    const result = firstBuy({
      pub: {
        simulateContract: async (input: { functionName: string; value?: bigint }) => {
          if (input.functionName === "quoteExactInputSingle") return { result: [1_000n] };
          sentValue = input.value;
          return { request: {} };
        },
        waitForTransactionReceipt: async () => ({ status, logs: [] }),
      },
      wallet: { writeContract: async () => "buy-hash" }, address: "wallet",
      V4: { quoter: "quoter", universalRouter: "router", swapLayout: "v1" }, quote: { key: "eth", address: "zero" },
      feePips: 0, CHAIN: { id: 8453 }, setPhase: () => {},
    }, "token", "launch-hash", 100n);
    if (status === "success") {
      const bought = await result;
      assert.equal(bought.hash, "buy-hash");
      assert.equal(bought.out, 975n, "Only this token received by this wallet is counted");
      assert.equal(bought.exact, true);
    } else {
      await assert.rejects(result, /The buy reverted on-chain/);
    }
    assert.equal(encodedMinimum, 970n);
    assert.equal(sentValue, 100n);
  });
}

test("stock quote: one blocking message, a chip that names the issuer, a way out, and no test hooks in production markup", () => {
  // the sentence lives once and is shown by the validation list and the submit-card status box
  assert.match(source, /const STOCK_PICK_MESSAGE = "Pick a stock to price the token in, or switch the quote\."/);
  assert.equal(source.match(/STOCK_PICK_MESSAGE/g)?.length, 3);
  assert.match(source, /if \(quoteKey === "stock" && !stock\) errors.push\(STOCK_PICK_MESSAGE\)/);
  assert.match(source, /\{quoteKey === "stock" && !stock \? \(\s*<div className="[^"]*" role="status">\s*\{STOCK_PICK_MESSAGE\}/);
  // the only live region is that status box: the search results must not be re-announced on every keystroke
  assert.doesNotMatch(source, /aria-live/);
  assert.doesNotMatch(source, /data-testid|\(registry\)|Quote = \{/);
  // the picked stock chip says whose stock it is and can be cleared; "Switch quote" returns to the first configured quote
  assert.match(source, /\{stock\.symbol\}\s*<span className="[^"]*">\{CHAIN_COPY\[chain\]\.stock\?\.badge\}<\/span>/);
  assert.match(source, /badge: "Coinbase stock"/);
  assert.match(source, /badge: "Robinhood stock"/);
  // a chain without a stock registry (Arc) says so in the copy table and gets no Stock quote button at all
  assert.match(source, /arc: \{[^}]*stock: null,/);
  assert.match(source, /\.\.\.\(STOCK_SOURCE\[chain\] \? \[\{ key: "stock" as const, label: "Stock" \}\] : \[\]\)/);
  assert.match(source, /aria-label="clear stock quote"/);
  assert.match(source, /Switch quote/);
  assert.match(source, /setQuoteKey\(cfg\.quotes\[0\]\?\.key \?\? "eth"\);\s*setStock\(null\);\s*setStockQ\(""\);\s*setMcapPick\(null\);\s*setCustomMcap\(""\);/);
  // switching chains drops the picked stock: a registry address from one chain must never become the other chain's quote
  // ...but re-clicking the active chain is a no-op, so it cannot wipe the picked stock
  assert.match(source, /if \(k === chain\) return;[^}]*setChain\(k\);\s*setQuoteKey\(launchpad\(k\)\.quotes\[0\]\.key\);[^}]*setStock\(null\);\s*setStockQ\(""\);\s*setStockHits\(\[\]\);/);
  // the issuer disclaimer is rendered from the per-chain copy table (a Record<ChainKey, …>: a new chain must write its own)
  assert.match(source, /const CHAIN_COPY: Record<ChainKey, \{/);
  assert.match(source, /<p className=\{helper\}>\{CHAIN_COPY\[chain\]\.stock\?\.issuer\}<\/p>/);
});

test("beneficiary split: recipients come from the tested helper, and the summary reflects the split", () => {
  // custom mode is the split editor; its rules live in lib/launchpad/recipients.ts, never inline in the form
  assert.match(source, /const split = useMemo\(\(\) => buildRecipients\(rows\), \[rows\]\);/);
  assert.match(source, /if \(feePips > 0 && beneficiary === "custom"\) errors\.push\(\.\.\.split\.errors\);/);
  assert.match(source, /return split\.recipients;/);
  // burn names no recipients (the factory registers DEAD: 100%); a 0% fee routes nothing
  assert.match(source, /if \(feePips === 0 \|\| beneficiary === "burn"\) return \[\];/);
  // the row count is capped by the locker constant, not a UI literal
  assert.match(source, /rs\.length >= MAX_RECIPIENTS/);
  assert.doesNotMatch(source, /isAddress\(customAddr/);
  // the summary derives its chip and copy from the recipients actually sent, so it cannot disagree with the transaction
  // an unfinished split previews as a split, not a burn; only a completed list goes through feeModeOf
  assert.match(source, /const feeMode = feePips > 0 && beneficiary !== "burn" && recipients\.length === 0 \? \(beneficiary === "custom" && rows\.length > 1 \? "split" : "creator"\) : feeModeOf\(feePips, recipients\);/);
  assert.match(source, /<FeeChip lpFee=\{feePips\} mode=\{feeMode\} \/>/);
  assert.match(source, /describeShares\(recipients, shortAddr\)/);
  assert.match(source, /split \$\{recipients\.length \|\| rows\.length\} ways/);
});

test("custom market-cap entry clears the preset pick when sanitization rejects the value", () => {
  // With a preset active, typing 1e-7 sanitizes to "" — the preset must clear,
  // otherwise mcapEntered falls back to the old preset cap while the field shows empty.
  assert.match(source, /resolveCustomMcapInput\(e\.target\.value\)/);
  assert.match(source, /if \(next\.clearPick\) setMcapPick\(null\)/);
  assert.match(source, /setCustomMcap\(next\.value\)/);
});

test("a rejected first-buy entry is ignored, never read as declining the first buy", () => {
  assert.match(source, /const next = resolveFirstBuyInput\(e\.target\.value\); if \(next\.kind === "choose"\) chooseFirstBuy\(next\.value\); else if \(next\.kind === "decline"\) declineFirstBuy\(\);/);
  assert.doesNotMatch(source, /sanitizeDecimalInput\(e\.target\.value\); if \(v\) chooseFirstBuy\(v\); else declineFirstBuy\(\)/);
});
