import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const panel = read("./BridgeDialog.tsx");
const provider = read("./BridgeProvider.tsx");
const header = read("../HeaderNav.tsx");
const css = read("./BridgeDialog.module.css");

test("bridge uses bundled official asset marks rather than letter placeholders", () => {
  for (const asset of ["base.svg", "robinhood-black.svg", "robinhood-white.svg", "ethereum.svg", "arc.svg", "arbitrum.svg", "optimism.svg", "usdc.svg"]) {
    assert.ok(panel.includes(`/brand/${asset}`), asset);
    const svg = read(`../../../public/brand/${asset}`);
    assert.match(svg, /<svg\b/);
    assert.match(svg, /Source(?: asset| archive)?: https:\/\//);
    assert.doesNotMatch(svg, /<script\b|<foreignObject\b|\bonload=|(?:href|src)=["']https?:/i);
  }
  assert.doesNotMatch(panel, /\? "B" : "R"/);
  assert.match(css, /:global\(\.dark\) \.networkMark \.lightLogo/);
  assert.match(css, /:global\(\.dark\) \.networkMark \.darkLogo/);
  assert.match(panel, /<AssetMark asset=\{asset\} size=\{28\} \/>/);
  assert.match(panel, /<AssetMark asset=\{outputCurrency.symbol\} \/>/);
});

test("bridge keeps one lazily loaded controller across desktop/mobile and dismissal", () => {
  assert.match(header, /<BridgeProvider>/);
  // desktop: one button, icon-only (its label pushed the Launch button out of the strip)
  assert.match(header, /<BridgeButton compact \/>/);
  assert.match(header, /<BridgeButton block onOpen=\{\(\) => setOpen\(false\)\} \/>/);
  assert.match(provider, /dynamic\(\(\) => import\("\.\/BridgeDialog"\)/);
  // mounted on first use or when the /bridge page registers its slot, and kept mounted after either
  assert.match(provider, /activated \|\| slot\.node \? <BridgeDialog open=\{open\} onOpenChange=\{setOpen\} restoreFocus=\{restoreFocus\} slot=\{slot\.node\} link=\{slot\.node \? slot\.link : requested\?\.link \?\? null\} linkCount=\{slot\.node \? 0 : requested\?\.count \?\? 0\} \/>/);
  assert.doesNotMatch(provider, /open \? <BridgeDialog/);
});

test("the /bridge page shows the same controller's panel instead of starting a second one", () => {
  const page = read("../../app/bridge/page.tsx");
  const slot = read("./BridgePageSlot.tsx");
  const store = read("./bridge-slot.ts");
  // the page only registers an element; nothing in it or its slot runs the bridge hook
  assert.match(page, /<BridgePageSlot link=\{link\} \/>/);
  assert.match(page, /const link = parseBridgeLink\(await searchParams\);/);
  assert.doesNotMatch(page + slot + store, /useBridge|BridgeDialog|sendTransaction/);
  assert.match(slot, /bridgeSlot\.mount\(node, link\)/);
  assert.match(store, /return \(\) => \{ if \(current\.node === node\)/, "a stale page cannot withdraw a newer page's slot");
  assert.equal((panel.match(/useBridge\(/g) ?? []).length, 1, "one hook call serves the dialog and the page");
  assert.match(panel, /const bridge = useBridge\(open \|\| onPage\);/);
  assert.match(panel, /onPage \? createPortal\(<section className=\{signal\.pagePanel\} aria-label="Bridge">\{content\}\{footer\}<\/section>, slot\) : null/);
  assert.match(panel, /<Dialog\.Root open=\{open && !onPage\}/, "the dialog never opens over the page's own panel");
  assert.match(provider, /if \(slot\.node && open\) setOpen\(false\);/);
  assert.match(provider, /page\.querySelector<HTMLElement>\("#bridge-amount"\)\?\.focus/);
  // a link preselects through the pickers' guarded setters, once, and carries no amount
  assert.match(panel, /if \(!link \|\| appliedLink\.current === linkKey\) return;/);
  assert.match(panel, /bridge\.setOriginChainId\(link\.originChainId\);\s+bridge\.setDestinationChainId\(link\.destinationChainId\);/);
  assert.doesNotMatch(panel, /link\.amount|bridge\.setAmount\(link/);
});

test("the signal board is decorative and sliding confirms the deposit only", () => {
  const board = read("./SignalBoard.tsx");
  const slide = read("./SlideConfirm.tsx");
  const signalCss = read("./Signal.module.css");
  // the board says nothing a screen reader needs: the panel's own status text carries it
  assert.match(board, /<div className=\{styles\.board\} aria-hidden="true">/);
  assert.match(board, /window\.matchMedia\("\(prefers-reduced-motion: reduce\)"\)\.matches/);
  assert.match(board, /if \(still\) paint\(started\);\s+else frame = requestAnimationFrame\(loop\);/);
  assert.match(board, /return \(\) => \{ cancelAnimationFrame\(frame\); observer\.disconnect\(\); \};/);
  assert.match(board, /observer\.observe\(rule\);/, "sizing the canvas never re-triggers its own observer");
  assert.doesNotMatch(board + slide, /setInterval|sendTransaction|useBridge/);
  assert.equal((panel.match(/<SignalBoard /g) ?? []).length, 3, "form, approval and transfer views");
  // the slide appears for the deposit alone, and runs the very same guarded path as the button
  assert.match(panel, /const slideReady = !!b\.address && reviewing && !b\.approvalRequired && !loading && !b\.allowanceLoading;/);
  assert.match(panel, /\{slideReady \? <SlideConfirm key=\{b\.quote!\.requestId\}[^\n]+onConfirm=\{runPrimaryAction\} \/> : null\}/);
  const formSubmit = panel.match(/<form className=\{dotFont\.variable\} onSubmit=\{\(event\) => \{([\s\S]*?)\}\}>/)?.[1] ?? "";
  assert.match(formSubmit, /event\.preventDefault\(\);/);
  assert.match(formSubmit, /if \(b\.address && !actionDisabled && !reviewing\) void b\.requestQuote\(\);/);
  assert.doesNotMatch(formSubmit, /runPrimaryAction|\.approve\(|\.confirm\(|connect\(/, "implicit submission can only request a quote");
  assert.match(panel, /<button type="button" className=\{slideReady \? styles\.secondary : styles\.primary\} disabled=\{actionDisabled\} onClick=\{runPrimaryAction\}/, "the ordinary button never goes away");
  assert.equal((panel.match(/b\.confirm\(\)/g) ?? []).length, 1);
  assert.equal((panel.match(/b\.approve\(\)/g) ?? []).length, 1);
  // only a release or Enter at the end confirms, read from the live drag, never from movement
  assert.match(slide, /if \(slideRelease\(at\) === "confirm"\) \{ place\(1\); onConfirm\(\); return; \}/);
  assert.match(slide, /if \(next\.confirm\) onConfirm\(\);/);
  assert.equal((slide.match(/onConfirm\(\)/g) ?? []).length, 2);
  assert.doesNotMatch(slide.slice(slide.indexOf("function move"), slide.indexOf("function up")), /onConfirm/);
  assert.match(slide, /role="slider" tabIndex=\{0\} aria-label=\{label\} aria-valuemin=\{0\} aria-valuemax=\{100\}/);
  assert.match(slide, /<p className=\{styles\.slideHint\} aria-live="polite">/);
  assert.match(signalCss, /\.slideTrack \{[^}]*touch-action: none/);
  assert.match(signalCss, /prefers-reduced-motion: reduce[\s\S]+\.caption span \{ animation: none; \}/);
  assert.match(signalCss, /\.coin:focus-visible/);
  // the dot face loads with the panel only
  assert.match(read("./dot-font.ts"), /Doto\(\{ subsets: \["latin"\], axes: \["ROND"\], variable: "--font-dots", display: "swap", preload: false \}\)/);
});

test("bridge review names minimum, separate gas, recipient, risk and expiry", () => {
  for (const content of ["Minimum received", "Source gas", "Receiving wallet", "0.5% slippage", "carries risk", "This quote expired", "Refresh quote", "0 Openlaunch fee"]) assert.ok(panel.includes(content), content);
  assert.match(panel, /reviewing \? b.approvalRequired \? b.approve\(\) : b.confirm\(\) : b.requestQuote\(\)/);
  assert.doesNotMatch(panel, /dangerouslySetInnerHTML|setInterval|sendTransaction/);
});

test("bridge dialog has accessible focus, mobile layout and reduced motion", () => {
  assert.match(panel, /Dialog.Popup[^>]+initialFocus=\{popup\}/);
  assert.match(panel, /finalFocus=\{connecting \? false : restoreFocus\}/);
  assert.match(panel, /Dialog.Close[^>]+aria-label="Close bridge"/);
  assert.match(panel, /htmlFor="bridge-amount"/);
  assert.match(css, /prefers-reduced-motion: reduce/);
  assert.match(css, /max-height: calc\(100dvh - 16px\)/);
  assert.match(css, /:focus-visible/);
});

test("bridge alerts wrap long provider reasons without discarding actionable errors", () => {
  assert.match(css, /\.error \{[^}]*min-width: 0[^}]*overflow-wrap: anywhere/);
  assert.match(css, /\.error > span \{[^}]*min-width: 0/);
  assert.match(read("./useBridge.ts"), /const messageOf = bridgeErrorMessage;/);
});

test("both quote and transfer recipients expose the full address without hover", () => {
  assert.match(panel, /<details className=\{styles.recipient\}>[\s\S]*<summary>[\s\S]*<code className=\{styles.fullAddress\}>\{address\}<\/code>/);
  assert.match(panel, /<Recipient address=\{b.address\} \/>/);
  assert.match(panel, /<Recipient address=\{transfer.address\} \/>/);
  assert.match(css, /input, select, summary\):focus-visible/);
});

test("bridge selectors send from every network, receive only on launch chains, and label conversion and gas", () => {
  assert.match(panel, /const SOURCE_CHAINS: readonly BridgeChainId\[\] = BRIDGE_CHAIN_IDS;/);
  assert.match(panel, /const DESTINATION_CHAINS: readonly BridgeChainId\[\] = BRIDGE_DESTINATION_IDS;/);
  assert.match(panel, /const chains = label === "From" \? SOURCE_CHAINS : DESTINATION_CHAINS;/);
  assert.match(panel, /<Select.GroupLabel className=\{styles.networkGroupLabel\}>Fund from<\/Select.GroupLabel>/);
  assert.match(panel, /disabled=\{locked \|\| !b.canReverse\} onClick=\{b.reverseRoute\}/);
  assert.match(panel, /onClick=\{\(\) => b.setOriginChainId\(walletFunding\)\}/);
  assert.match(panel, /Select.Trigger[^>]+aria-label=\{`\$\{label\} network`\}/);
  assert.match(panel, /onChange=\{b.setDestinationChainId\}/);
  assert.match(panel, /onClick=\{b.reverseRoute\}/);
  assert.match(panel, /Gas in \{BRIDGE_CHAINS\[chain\].symbol\}/);
  assert.match(panel, /Converted by Relay/);
  assert.match(panel, /Value change/);
  assert.doesNotMatch(panel + provider, /Bridge ETH|relayFeeEth|sourceGasEth|Your ETH is on its way/);
});

test("network pickers use themed Base UI lists without native browser menus", () => {
  assert.match(panel, /import \{ Select \} from "@base-ui\/react\/select"/);
  assert.doesNotMatch(panel, /<select\b|<option\b/);
  assert.match(panel, /Select.Root value=\{chain\} items=\{chains.map\(\(id\) => \(\{ value: id, label: BRIDGE_CHAINS\[id\].name \}\)\)\} disabled=\{disabled\}/);
  assert.match(panel, /if \(isBridgeChainId\(value\)\) onChange\(value\)/);
  assert.match(panel, /Select.Portal/);
  assert.match(panel, /alignItemWithTrigger=\{false\}/);
  assert.match(panel, /Select.Item[^>]+label=\{BRIDGE_CHAINS\[id\].name\}/);
  assert.match(panel, /Select.ItemIndicator/);
  assert.match(css, /networkPositioner \{ z-index: 90/);
  assert.match(css, /networkPopup\[data-instant\] \{ transition: none/);
  assert.match(css, /prefers-reduced-motion: reduce[^\n]+\.networkPopup/);
});

test("synthetic bridge review is development-only and cannot execute a transaction", () => {
  assert.match(read("../../app/ui-review-bridge/page.tsx"), /process.env.NODE_ENV !== "development"\) notFound\(\)/);
  const review = read("../../app/ui-review-bridge/BridgeReview.tsx");
  assert.doesNotMatch(review, /sendTransaction|useBridge\(\)|fetch\(/);
  assert.match(review, /No wallet requests, API calls, or funds/);
});

test("USDC approval is visibly separate from the bridge and has chain-aware recovery", () => {
  // the approval names the token being approved: USDC on Base and Arc, USDG on Robinhood Chain
  assert.match(panel, /Approve \$\{nativeAmount\(b.amount\)\} \$\{inputCurrency\.symbol\}/);
  assert.match(panel, /const approvalSymbol = bridgeTokenAsset\(approval\.chainId\) \?\? "token";/);
  assert.match(panel, /<span>\{approvalSymbol\} approval on \{approvalChain\.name\}<\/span>/);
  assert.doesNotMatch(panel, /USDC approval|exact USDC amount|\} USDC[<`"]/, "no approval copy assumes the token is USDC");
  assert.match(panel, /Approval alone does not move your funds/);
  assert.match(panel, /No bridge deposit has been requested/);
  assert.match(panel, /Review a fresh quote before bridging/);
  assert.match(panel, /approval\.approvalHash/);
  assert.match(panel, /b.recoverApproval\(hash.trim\(\)\)/);
  assert.match(panel, /unspent allowance remains until used or revoked/);
  assert.match(panel, /No wallet request will be made/);
  assert.match(panel, /b.approvalError \|\| b.storageError/);
  assert.match(panel, /approval\.approvalHash \? <button[^>]+onClick=\{b.retryApproval\}/);
  assert.match(panel, /BRIDGE_CHAINS\[approval.chainId\]/);
  assert.match(panel, /approvalChain.explorer/);
});

test("USDC selectors separate selected token units from native gas and disallow unsafe Robinhood routes", () => {
  assert.match(panel, /AssetSelect label="Send"[^>]+onChange=\{b.setOriginAsset\}/);
  assert.match(panel, /AssetSelect label="Receive"[^>]+onChange=\{b.setDestinationAsset\}/);
  assert.match(panel, /BRIDGE_ASSETS\[chain\]/);
  assert.match(panel, /isBridgeAssetSupported\(chain, value\)/);
  assert.match(panel, /formatUnits\(b.balance, inputCurrency.decimals\)/);
  assert.match(panel, /formatUnits\(BigInt\(value\), outputCurrency.decimals\)/);
  assert.match(panel, /For gas: \{nativeAmount\(b.nativeBalance\)\} \{origin.symbol\}/);
  assert.match(panel, /USDC on Robinhood is unavailable: its routes do not pass our current safety checks\. ETH and USDG are available\./);
  // Elysium carries USDC only, and says its gas is HYPE, which the bridge does not carry
  assert.ok(panel.includes(`{b.originChainId === 99901 || b.destinationChainId === 99901 ? <p className={styles.routeNotice}>Only USDC moves to and from Elysium. Gas there is HYPE, which this bridge does not carry, so keep some HYPE on Elysium to use or send your USDC.</p> : null}`));
  assert.ok(panel.includes('if (chain === 99901) return <span className={`${styles.networkMark} ${styles.elysiumMark}`} aria-hidden><Image src="/brand/elysium.png"'));
  assert.ok(css.includes(".elysiumMark img { border-radius: 7px; }"));
  // each asset is named in full, and says which token pays its chain's gas
  assert.match(panel, /\{BRIDGE_ASSET_NAMES\[value\]\} · \{value === BRIDGE_CHAINS\[chain\]\.symbol \? "Gas token" : `Gas in \$\{BRIDGE_CHAINS\[chain\]\.symbol\}`\}/);
  assert.match(panel, /if \(asset === "USDG"\) return <CircleDollarSign/, "USDG has no bundled logo, so it never borrows USDC's or Ether's");
  assert.match(panel, /uses additional \{origin.symbol\} for gas/);
  assert.match(panel, /const inputCurrency = bridgeTransferInputCurrency\(transfer\)/);
});

test("stuck records have a bounded discard path, and the hook avoids APIs missing in older wallet browsers", () => {
  const hook = read("./useBridge.ts");
  assert.match(panel, /b\.canDiscard \? <details/);
  assert.match(panel, /disabled=\{b\.discarding\} onClick=\{b\.discard\}>/);
  assert.match(panel, /b\.approvalCanBeDiscarded \? <details/);
  assert.match(panel, /onClick=\{b\.discardApproval\}>/);
  assert.match(hook, /const fresh = \{ requestId, status, sourceMined, observedAt: Date\.now\(\) \};/); // removal re-reads evidence under the lock
  assert.match(hook, /if \(!transferCanDiscard\(current, fresh, Date\.now\(\)\)\) throw/);
  assert.match(hook, /if \(!approvalCanDiscard\(current, fresh, Date\.now\(\)\)\) throw/);
  assert.match(panel, /Keep the Transfer ID below/);
  assert.match(panel, /Openlaunch does not operate \{provider\}, holds no funds in transit, and is not responsible for delays, refunds or losses/);
  assert.doesNotMatch(hook, /AbortSignal\.(any|timeout)/);
  assert.match(hook, /linkedTimeoutSignal\(signal, 20_000\)/);
  assert.match(hook, /anchorQuoteExpiry\(body, requestedAt\)/);
  assert.match(hook, /setActivity\(activityAfterWalletChange\)/);
  assert.match(hook, /error instanceof TransactionReceiptNotFoundError\) return null/);
  assert.match(hook, /const walletHashUnmined = receipt\.status === "fulfilled" && receipt\.value === null;/);
  assert.match(hook, /replacementSourceHash\(current, status, walletHashUnmined\)/);
  assert.match(hook, /const messageOf = bridgeErrorMessage;/);
});

test("the history board only reads: no second bridge, no recovery record, and the ledger is written by the controller alone", () => {
  const board = read("./BridgeHistory.tsx");
  const hook = read("./useBridge.ts");
  const page = read("../../app/bridge/page.tsx");
  assert.doesNotMatch(board, /useBridge|client-storage|sendTransaction|writeContract|\.record\(|\.forget\(/);
  assert.ok(board.includes("bridgeLedger.read(address)"));
  assert.ok(page.includes("<BridgeHistory />"));
  assert.ok(hook.includes("try { bridgeLedger.record(tracked, quoted); } catch"));
  assert.match(hook, /transfers\.remove\(address\);\s+try \{ bridgeLedger\.forget\(address, requestId\); \} catch/);
  assert.ok(panel.includes(`href="/bridge#transfers"`));
});

test("bridge, then buy stays two steps: the trade panel card opens and follows the one controller and never sends", () => {
  const card = read("./BridgeToBuy.tsx");
  const trade = read("../launchpad/TradePanel.tsx");
  assert.doesNotMatch(card, /useBridge\b|client-storage|sendTransaction|writeContract|useWriteContract|\.record\(|\.forget\(/);
  assert.ok(card.includes("useOpenBridge()") && card.includes("useWakeBridge()"));
  assert.ok(card.includes("bridgeLedger.read(address)"));
  assert.ok(trade.includes("<BridgeToBuy "));
  assert.match(trade, /side === "buy" && isConnected && tradable \? \(\s*<BridgeToBuy /);
  assert.ok(trade.includes("onArrived={refetchPay}"));
  assert.ok(provider.includes("const wake = useCallback(() => setActivated(true), []);"), "waking mounts the controller closed so tracking continues");
  assert.ok(provider.includes("export function useWakeBridge"));
  assert.ok(provider.includes("if (slot.node && requested) setRequested(null);"), "the /bridge page's route is never overwritten later by an older request");
  assert.ok(panel.includes("const linkKey = link ? `${linkCount}:${bridgeLinkKey(link)}` : \"\";"), "asking for the same route again re-applies it");
});

test("quotes update without locking typing or automatically submitting wallet actions", () => {
  const hook = read("./useBridge.ts");
  assert.match(panel, /useBridge\(open \|\| onPage\)/);
  assert.match(hook, /autoQuoteEnabled = open && !!request && !sending && !approvalSending && !approvalPending && !tracked/);
  assert.match(hook, /quoteSession.schedule\(\(\) => \{ void requestQuote\(\); \}\)/);
  assert.match(hook, /\[autoQuoteEnabled, amount, walletChainId, requestQuote, quoteSession\]/);
  assert.match(hook, /if \(!canApply\(\)\) return/);
  assert.match(hook, /if \(value === inputs.current.amount\) return/);
  assert.match(hook, /next\.originChainId === inputs\.current\.originChainId[^\n]+next\.amount === inputs\.current\.amount\) return/);
  assert.match(hook, /busy: sending \|\| approvalSending \|\| approvalPending,/);
  assert.match(panel, /const loading = locked \|\| b.quoteLoading/);
  assert.match(panel, /input id="bridge-amount"[^\n]+disabled=\{locked\}/);
  assert.match(panel, /if \(loading \|\| b.allowanceLoading \|\| !b.canQuote\) return/);
  assert.match(panel, /Your quote updates automatically/);
  assert.match(panel, /rejection.reason === "relay-fee"/);
  assert.match(panel, /rejection.relayFeePercent/);
  assert.doesNotMatch(hook, /busy:.*quoting/);
});

test("fee warnings separate the percentage, costs and touch-accessible exact explanation", () => {
  assert.match(panel, /<FeeLimitNotice rejection=\{b.quoteRejection\}/);
  assert.match(panel, /formatFeeWarningPercent\(exactPercent\)/);
  assert.match(panel, /5% safety limit/);
  assert.match(panel, /role="status" aria-atomic="true"/);
  assert.match(panel, /<details className=\{styles.feeLimitReason\}>[\s\S]+Why is this blocked\?/);
  assert.match(panel, /Relay’s fee is \$\{exactPercent\}%/);
  assert.match(panel, /quote loses \$\{exactPercent\}% in conversion and fees/);
  assert.match(panel, /Source gas is extra and is not included in this limit/);
  assert.match(css, /\.feeLimitHeading \{[^}]*display: grid[^}]*align-items: start/);
  assert.match(css, /\.feeLimitReason summary \{[^}]*min-height: 44px/);
  assert.match(css, /\.feeLimitReason p \{[^}]*overflow-wrap: anywhere/);
});

test("pending approvals explain missing/queued transactions and accept a verified replacement without a new wallet call", () => {
  const hook = read("./useBridge.ts");
  assert.match(panel, /health\?\.title/);
  assert.match(panel, /needsAttention \? <CircleAlert/);
  assert.match(panel, /Sped up your approval in the wallet/);
  assert.doesNotMatch(panel, /has no record of this approval/);
  assert.match(panel, /discarding this record does not cancel it or fix a queued nonce/);
  assert.match(hook, /recoverApprovalFromEvidence\(current/);
  assert.match(hook, /!canApplyApprovalPoll\(current, observed\)/);
  assert.match(hook, /const health = receipt \? null : await readPendingApprovalHealth/);
  assert.match(hook, /value: APPROVAL_HEALTH_UNAVAILABLE/);
  assert.equal((hook.match(/await assertBridgeWalletQueueClear\(/g) ?? []).length, 2);
});

test("a Circle transfer is named as Circle's, reads allowance for Circle's spender, and never links to a Relay page", () => {
  const hook = read("./useBridge.ts");
  const board = read("./BridgeHistory.tsx");
  // allowances are read for whichever contract the approval names, never a hard-coded Relay depository
  assert.doesNotMatch(hook, /RELAY_DEPOSITORY/);
  assert.match(hook, /args: \[quote\.address, quote\.approval\.spender\]/);
  assert.match(hook, /const statusUrl = observed \? bridgeStatusUrl\(observed\)/);
  assert.match(hook, /findCctpBurn\(pub, current\)/);
  assert.match(panel, /const circle = \(bridge\.tracked\?\.provider \?\? bridge\.quote\?\.provider\) === "cctp";/);
  assert.match(panel, /Powered by Circle CCTP/);
  assert.match(panel, /\{circle \? null : <a className=\{styles\.externalAction\} href=\{\x60https:\/\/relay\.link\/transaction\//);
  assert.match(panel, /\{circle \? null : <p className=\{styles\.disclaimer\}>Transfer ID/);
  assert.match(panel, /Circle takes one fixed fee, so this is the exact amount you receive\./);
  assert.match(board, /entry\.provider === "cctp" \? <span className=\{styles\.via\}>Circle<\/span> : <a href=\{\x60https:\/\/relay\.link\/transaction\//);
  assert.doesNotMatch(panel, /—/);
});
