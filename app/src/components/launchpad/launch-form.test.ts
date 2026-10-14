import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { minOut } from "../../lib/launchpad/math.ts";
import { en, messagesFor } from "../../i18n/messages/index.ts";

const source = readFileSync(new URL("./LaunchForm.tsx", import.meta.url), "utf8");
const copy = en.launch.form;
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
  assert.match(source, /title: t\("toast\.buyFailed"\), sub: t\("toast\.buyFailedSub", \{ reason: explain\(buyProblem\) \}\)/);
  assert.equal(copy.toast.buyFailed, "Launched, but the first buy did not go through");
  assert.match(source, /buying: t\("buying"\)/);
  assert.equal(copy.submit.buying, "Launched! Buying your first tokens…");
});

test("launch merge retains chain-scoped marks and honest optional-buy copy", () => {
  // the preview marks carry the chosen chain: it goes into the preview row, which both preview views draw from
  assert.match(source, /previewLaunch\(\{ chain, /);
  assert.match(readFileSync(new URL("./LaunchPreview.tsx", import.meta.url), "utf8"), /<TokenAvatar chain=\{row\.chain\}/);
  assert.match(source, /label=\{initialBuyRaw \? t\("submit\.launchBuy"\) : t\("submit\.launchFree"\)\}/);
  assert.equal(copy.submit.launchBuy, "Launch + first buy");
  assert.equal(copy.submit.launchFree, "Launch for free, gas only");
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
  assert.match(source, /className=\{btn\.secondarySm\}>\{t\("buy\.decline"\)\}<\/button>/);
  assert.equal(copy.buy.decline, "No first buy");
  assert.match(source, /<p className=\{helper\}>\{t\("buy\.why"\)\}<\/p>/);
  assert.match(copy.buy.why, /Clear it and the launch stays free/);
  // a cleared suggestion is visible and reversible; only the explicit button persists for the session
  assert.match(source, /suggestion\.reason === "declined" && !typedBuy/);
  assert.match(source, /onClick=\{suggestAgain\}/);
  assert.match(source, /onClick=\{\(\) => declineFirstBuy\(true\)\}/);
  assert.match(source, /if \(forSession\) setFirstBuyDeclined\(true\)/);
  // hydration: the session flag is read through useSyncExternalStore with a false server snapshot, never in a state initializer
  assert.match(source, /useSyncExternalStore\(subscribeFirstBuyDeclined, getFirstBuyDeclined, getFirstBuyDeclinedServer\)/);
  assert.doesNotMatch(source, /sessionStorage/, "the form never touches sessionStorage directly");
  assert.match(source, /suggestion\.reason === "unknown-balance"/);
  assert.match(source, /t\("buy\.slippage", \{ pct: FIRST_BUY_SLIPPAGE_BPS \/ 100 \}\)/);
  assert.match(copy.buy.slippage, /Other traders can buy before you/);
  assert.match(copy.buy.slippage, /First-buy slippage tolerance: \{pct\}%/);
  assert.match(copy.buy.slippage, /Network gas and pool fees apply/);
  assert.doesNotMatch(source + JSON.stringify(en.launch), /first holder/i);
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
  assert.match(source, /const stockPick = t\("stock\.pick"\);/);
  assert.equal(copy.stock.pick, "Pick a stock to price the token in, or switch the quote.");
  assert.equal(source.match(/stockPick/g)?.length, 3);
  assert.match(source, /if \(quoteKey === "stock" && !stock\) errors.push\(stockPick\)/);
  assert.match(source, /\{quoteKey === "stock" && !stock \? \(\s*<div className="[^"]*" role="status">\s*\{stockPick\}/);
  // the only live region is that status box: the search results must not be re-announced on every keystroke
  assert.doesNotMatch(source, /aria-live/);
  assert.doesNotMatch(source, /data-testid|\(registry\)|Quote = \{/);
  // the picked stock chip says whose stock it is and can be cleared; "Switch quote" returns to the first configured quote
  assert.match(source, /\{stock\.symbol\}\s*<span className="[^"]*">\{stockCopy\?\.badge\}<\/span>/);
  assert.equal(copy.stock.coinbase.badge, "Coinbase stock");
  assert.equal(copy.stock.robinhood.badge, "Robinhood stock");
  // a chain without a stock registry (Arc) says so in the copy table and gets no Stock quote button at all
  assert.match(source, /arc: \{[^}]*stock: null,/);
  assert.match(source, /\.\.\.\(STOCK_SOURCE\[chain\] \? \[\{ key: "stock" as const, label: t\("quote\.stock"\) \}\] : \[\]\)/);
  assert.equal(copy.quote.stock, "Stock");
  assert.match(source, /aria-label=\{t\("stock\.clear"\)\}/);
  assert.equal(copy.stock.clear, "clear stock quote");
  assert.match(source, /\{t\("stock\.switchQuote"\)\}/);
  assert.equal(copy.stock.switchQuote, "Switch quote");
  assert.match(source, /setQuoteKey\(cfg\.quotes\[0\]\?\.key \?\? "eth"\);\s*setStock\(null\);\s*setStockQ\(""\);\s*setMcapPick\(null\);\s*setCustomMcap\(""\);/);
  // switching chains drops the picked stock: a registry address from one chain must never become the other chain's quote
  // ...but re-clicking the active chain is a no-op, so it cannot wipe the picked stock
  assert.match(source, /if \(k === chain\) return;[^}]*setChain\(k\);\s*setQuoteKey\(launchpad\(k\)\.quotes\[0\]\.key\);[^}]*setStock\(null\);\s*setStockQ\(""\);\s*setStockHits\(\[\]\);/);
  // the issuer disclaimer is rendered from the per-chain copy table (a Record<ChainKey, …>: a new chain must write its own)
  assert.match(source, /const CHAIN_COPY: Record<ChainKey, \{/);
  assert.match(source, /const registry = CHAIN_COPY\[chain\]\.stock;/);
  assert.match(source, /<p className=\{helper\}>\{stockCopy\?\.issuer\}<\/p>/);
  // the disclaimers are legal wording: in Chinese they name the same rule, issuer and excluded places as in English
  const zh = messagesFor("zh-CN").launch.form.stock;
  assert.match(copy.stock.coinbase.issuer, /under Regulation S and are not offered to persons in the US, UK, Canada, Australia, Singapore or Switzerland/);
  assert.match(zh.coinbase.issuer, /Regulation S/);
  for (const place of ["美国", "英国", "加拿大", "澳大利亚", "新加坡", "瑞士"]) assert.ok(zh.coinbase.issuer.includes(place), place);
  assert.match(copy.stock.robinhood.issuer, /not offered to US persons/);
  assert.match(zh.robinhood.issuer, /不向美国人士提供/);
});

test("stock picker: a one-page list says how many stocks there are, and a stock without a USD price explains the stock-unit cap", () => {
  // the registry's size comes from the server with each page: the form never hard-codes a count or a ticker list that goes stale
  assert.match(source, /const d = \(await res\.json\(\)\) as \{ stocks: Quote\[\]; stocksTotal\?: number; stocksMatched\?: number \};/);
  // a reply from a server that does not send the match count yet (mid-deploy) reads as "nothing left out"
  assert.match(source, /setStockHits\(d\.stocks \?\? \[\]\);\s*setStockTotal\(d\.stocksTotal \?\? 0\);\s*setStockMatched\(d\.stocksMatched \?\? 0\);\s*setStockAnswered\(stockQ\);/);
  assert.doesNotMatch(source + JSON.stringify(en.launch), /\d+ Coinbase tokenized stocks/);
  assert.equal(copy.stock.coinbase.empty, "No match. Search a ticker or a company name, e.g. NVDA, AMD or Netflix.");
  // how many the page leaves out: against the registry for an empty search, against the matches for a typed one ("S" matches more than fit).
  // Counted only when the page answers the text as typed (a reply still on its way describes the old text) and no stock is picked.
  assert.match(source, /const stockMore = !stock && stockAnswered === stockQ && stockHits\.length > 0 \? Math\.max\(0, \(stockQ\.trim\(\) \? stockMatched : stockTotal\) - stockHits\.length\) : 0;/);
  assert.match(source, /\{stockMore > 0 \? \(\s*<p className=\{helper\}>\s*\{stockQ\.trim\(\) \? t\("stock\.showingMatches", \{ shown: stockHits\.length, total: stockHits\.length \+ stockMore \}\) : t\("stock\.showing", \{ shown: stockHits\.length, total: stockHits\.length \+ stockMore \}\)\}\s*<\/p>\s*\) : null\}/);
  assert.equal(copy.stock.showingMatches, "Showing {shown} of {total} matches. Keep typing to narrow it down.");
  assert.equal(copy.stock.showing, "Showing {shown} of {total}. Search a ticker or a company name for the rest.");
  // the counts belong to one chain's registry, like the hits: switching chains drops them all
  assert.match(source, /setStockHits\(\[\]\);\s*setStockTotal\(0\);\s*setStockMatched\(0\);\s*setStockAnswered\(null\);/);
  // most Coinbase stocks have no price feed: the cap box then takes stock units, and one line says so (never for ETH or a priced stock)
  assert.match(source, /\{quote\.key === "stock" && entry\.unit === "quote" \? \(\s*<p className=\{helper\}>\s*\{t\("price\.noUsd", \{ symbol: quote\.symbol \}\)\}\s*<\/p>\s*\) : null\}/);
  assert.equal(copy.price.noUsd, "{symbol} has no USD price here: enter the starting market cap in {symbol}.");
});

test("stock picker: a stock nobody holds yet is marked in the list, and picking it says why nobody can buy with it yet", () => {
  // only a confirmed "none issued" (issued === false) is marked; a stock the server could not read (null) or never reads (Robinhood) is not
  assert.match(source, /title=\{h\.issued === false \? t\("stock\.noneIssuedTitle", \{ name: h\.name \?\? h\.symbol \}\) : h\.name\}/);
  assert.equal(copy.stock.noneIssuedTitle, "{name}: none issued yet");
  assert.match(source, /\{h\.issued === false \? <span className="font-normal text-muted">\{t\("stock\.notIssued"\)\}<\/span> : null\}/);
  assert.equal(copy.stock.notIssued, "not issued yet");
  // a warning, not a block: the launch works and trading starts once the issuer puts some in circulation
  assert.match(source, /\{stock\?\.issued === false \? \(\s*<p className=\{helper\}>\s*\{t\("stock\.noneIssued", \{ symbol: stock\.symbol \}\)\}\s*<\/p>\s*\) : null\}/);
  assert.equal(copy.stock.noneIssued, "None of {symbol} has been issued yet, so nobody holds any and nobody can buy your token with it until Coinbase issues some. You can still launch now.");
  assert.doesNotMatch(source, /issued === true|issued !== false|!\w+\.issued\b/, "never read a missing or unknown flag as \"not issued\"");
  // and no first buy is suggested in it (first-buy.ts): the step says why instead of showing an amount nobody can hold
  assert.match(source, /\) : suggestion\.reason === "not-issued" \? \(\s*<p className=\{helper\}>\{t\("buy\.notIssued", \{ symbol: quote\.symbol \}\)\}<\/p>/);
  assert.equal(copy.buy.notIssued, "Nothing suggested: no {symbol} has been issued yet, so there is none to buy with. The launch stays free.");
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
  assert.match(source, /t\("feeRoute\.split", \{ count: recipients\.length \|\| rows\.length \}\)/);
  assert.equal(copy.feeRoute.split, "split {count} ways");
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

test("the preview draws the real board card from the form, with no link and nothing sent", () => {
  assert.match(source, /const previewRow = previewLaunch\(\{ chain, name, symbol: symbolClean,/);
  assert.match(source, /<LaunchPreview row=\{previewRow\} \/>/);
  const preview = readFileSync(new URL("./LaunchPreview.tsx", import.meta.url), "utf8");
  assert.match(preview, /<LaunchCard preview l=\{row\} now=\{0\} chip=\{justLaunched\} \/>/);
  assert.match(preview, /const justLaunched: ChipParts = \{ tier: "new", count: null, label: t\("justLaunched"\), when: null, more: null \};/);
  assert.equal(en.launch.preview.justLaunched, "just launched");
  // a blank name previews as the placeholder in the reader's language; the lib keeps its English one for other callers
  assert.match(source, /launcher: address \?\? null, unnamed: t\("unnamed"\) \}\);/);
  assert.equal(copy.unnamed, "Your token");
  // both views share one grid cell, so switching them never changes the panel's height
  assert.match(preview, /col-start-1 row-start-1/);
  assert.doesNotMatch(preview, /\bfetch\s*\(/);
});

test("a first-buy chip is labelled by the one formatter, so its label never rounds away from its value", () => {
  assert.match(source, /\{fmtQuoteUnits\(Number\(v\), quote\.decimals\)\} \{quote\.symbol\}<\/span>/);
  assert.doesNotMatch(source, /fmtCompact\(Number\(v\), 0\)/);
});

test("the form's words are messages, and the English ones read as the form always did", () => {
  // validation names the field and its rule
  assert.match(source, /if \(!nameOk\) errors\.push\(t\("token\.nameInvalid"\)\);/);
  assert.equal(copy.token.nameInvalid, "Name: 1–32 characters.");
  assert.match(source, /if \(!symbolOk\) errors\.push\(t\("token\.symbolInvalid"\)\);/);
  assert.equal(copy.token.symbolInvalid, "Symbol: use 1–10 English letters (A–Z) or digits (0–9).");
  assert.equal(copy.token.xInvalid, "X: enter a handle or an x.com link.");
  assert.equal(copy.token.xPlaceholder, "@handle or x.com link");
  // the TWIG / GITLAWB nudge carries the quote's badge inside its sentence, so the badge sits where each language puts it
  assert.equal(copy.quote.pair, "Pair with {symbol}, get the <badge></badge> badge");
  assert.match(source, /t\.rich\(quote\.key === "twig" \? "quote\.brandTwig" : "quote\.brandGitlawb", \{/);
  assert.match(copy.quote.brandGitlawb, /^Your token carries the <badge><\/badge> badge on the launch list, trending, the activity feed, its page and its share card\. GITLAWB is Twigpine's token\{bridged, select, yes \{, bridged 1:1 from Base to Robinhood Chain over LayerZero\} other \{\}\}: /);
  assert.match(source, /robinhood: \{ stock: "robinhood", bridgedGitlawb: true \}/);
  // what the launch does, step by step, and the one-paragraph summary; the buy sentence follows only when there is a buy
  assert.equal(copy.launch.summary, "One transaction on {chain}: deploys the token, creates the Uniswap v4 pool ({quote} / your token), locks 100% of the supply in it forever, and registers the fee routing. Cost: gas only, usually a few cents. Nothing is refundable and nothing can be edited afterwards.");
  assert.equal(copy.launch.summaryBuy, `${copy.launch.summary} Then a second transaction buys {amount} of your token; if you reject it, the launch still stands.`);
  assert.equal(copy.launch.summaryBuyApproval, `${copy.launch.summary} Then a second transaction buys {amount} of your token (with a one-time approval the first time); if you reject it, the launch still stands.`);
  assert.match(source, /t\(quote\.key !== "eth" \? "launch\.summaryBuyApproval" : "launch\.summaryBuy", \{ chain: CHAIN_LABEL, quote: quote\.symbol, amount: initialBuyLabel \}\)/);
  // the progress line keeps its explorer link around the hash in every language
  for (const key of ["txDone", "txSent", "buyQuote", "buyApprove", "buySign", "buySent"] as const) {
    assert.match(copy.phase[key], /<tx>\{hash\}<\/tx>/, key);
    assert.match(messagesFor("zh-CN").launch.form.phase[key], /<tx>\{hash\}<\/tx>/, key);
  }
  assert.match(source, /tx: \(chunks\) => <a href=\{explorerTx\(chain, hash\)\} target="_blank" rel="noreferrer"/);
  // the toasts name the token and chain as data, never translated
  assert.match(source, /title: t\("toast\.live", \{ name: name\.trim\(\), chain: CHAIN_LABEL \}\)/);
  assert.equal(copy.toast.live, "{name} is live on {chain}");
});

test("every failure reason the form translates is one the code really gives, and its English reads as the reason did", () => {
  const read = (file: string) => readFileSync(new URL(file, import.meta.url), "utf8").replaceAll("\r\n", "\n");
  const form = source.replaceAll("\r\n", "\n");
  // the reasons as the code writes them: the metadata route's and the form's own throws (not its map). friendlyError
  // words its own reasons in the reader's language, so none of them is mapped here.
  const given = [read("../../app/api/launch/meta/route.ts"), form.replace(/const REASONS = new Map[\s\S]*?\]\);/, "")].join("\n");
  const mapped = new Map([...form.matchAll(/^\s*\["([^"]+)", "(\w+)"\],$/gm)].map((m) => [m[2], m[1]]));
  for (const [key, english] of Object.entries(copy.reasons)) {
    assert.equal(mapped.get(key), english, `REASONS maps "${english}" to reasons.${key}`);
    assert.ok(given.includes(`"${english}"`), `reasons.${key} ("${english}") is not a reason the code gives`);
  }
  const friendly = [en.errors.cancelled, en.errors.gas, en.errors.unknown, ...Object.values(en.errors.contract)];
  for (const english of friendly) assert.ok(![...mapped.values()].includes(english), `friendlyError's "${english}" is not mapped again`);
  // both places a reason is shown read it through the map; anything unknown (a wallet's own words) reads as it came
  assert.match(source, /\{explain\(phase\.message\)\}/);
  assert.match(source, /reason: explain\(buyProblem\)/);
  assert.match(source, /return key \? t\(key\) : reason;\s*\}, \[t\]\);/);
});
