import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { en, messagesFor } from "../../i18n/messages/index.ts";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const panel = read("./BridgeDialog.tsx");
const provider = read("./BridgeProvider.tsx");
const header = read("../HeaderNav.tsx");
const css = read("./BridgeDialog.module.css");
// the dialog's words live in the bridge messages; the source holds their keys
const english = JSON.stringify(en.bridge);
const chinese = messagesFor("zh-CN").bridge;

test("bridge uses bundled official asset marks rather than letter placeholders", () => {
  for (const asset of ["base.svg", "robinhood-black.svg", "robinhood-white.svg", "ethereum.svg", "arc.svg", "usdc.svg"]) {
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
  assert.match(provider, /activated \? <BridgeDialog/);
  assert.doesNotMatch(provider, /open \? <BridgeDialog/);
});

test("bridge review names minimum, separate gas, recipient, risk and expiry", () => {
  for (const content of ["Minimum received", "Source gas", "Receiving wallet", "0.5% slippage", "carries risk", "This quote expired", "Refresh quote", "0 Openlaunch fee"]) assert.ok(english.includes(content), content);
  for (const key of ["quote.minimum", "quote.sourceGas", "receivingWallet", "quote.slippage", "form.disclaimer", "quote.expiredNotice", "action.refresh", "noFee"]) assert.ok(panel.includes(`"${key}"`), key);
  assert.match(panel, /reviewing \? b.approvalRequired \? b.approve\(\) : b.confirm\(\) : b.requestQuote\(\)/);
  assert.doesNotMatch(panel, /dangerouslySetInnerHTML|setInterval|sendTransaction/);
});

test("the risk and fee wording keeps its meaning in Chinese", () => {
  // third-party protocol, carries risk, not responsible for delays, refunds or losses; nothing stronger than the English
  assert.match(chinese.form.disclaimer, /第三方协议 Relay/);
  assert.match(chinese.form.disclaimer, /存在风险/);
  assert.match(chinese.form.disclaimer, /不对延迟、退款或损失负责/);
  assert.match(chinese.feeLimit.whyFee, /超过 5% 的报价/);
  assert.match(chinese.quote.slippage, /^0\.5% 滑点上限/);
  assert.doesNotMatch(JSON.stringify(chinese), /保证|零风险|无风险|绝对安全|最安全|最佳/);
});

test("bridge dialog has accessible focus, mobile layout and reduced motion", () => {
  assert.match(panel, /Dialog.Popup[^>]+initialFocus=\{popup\}/);
  assert.match(panel, /finalFocus=\{connecting \? false : restoreFocus\}/);
  assert.match(panel, /Dialog.Close[^>]+aria-label=\{t\("close"\)\}/);
  assert.equal(en.bridge.close, "Close bridge");
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

test("bridge selectors expose three networks and label cross-asset conversion and gas", () => {
  assert.match(panel, /BRIDGE_CHAIN_IDS.map/);
  assert.match(panel, /Select.Trigger[^>]+aria-label=\{t\(from \? "route.fromNetwork" : "route.toNetwork"\)\}/);
  assert.equal(en.bridge.route.fromNetwork, "From network");
  assert.equal(en.bridge.route.toNetwork, "To network");
  assert.match(panel, /onChange=\{b.setDestinationChainId\}/);
  assert.match(panel, /onClick=\{b.reverseRoute\}/);
  assert.match(panel, /t\("route.gasIn", \{ symbol: BRIDGE_CHAINS\[chain\].symbol \}\)/);
  assert.equal(en.bridge.route.gasIn, "Gas in {symbol}");
  assert.match(panel, /t\("route.converted"\)/);
  assert.equal(en.bridge.route.converted, "Converted by Relay");
  assert.match(panel, /t.rich\("quote.valueChange"/);
  assert.match(en.bridge.quote.valueChange, /^Value change/);
  assert.doesNotMatch(panel + provider + english, /Bridge ETH|relayFeeEth|sourceGasEth|Your ETH is on its way/);
});

test("network pickers use themed Base UI lists without native browser menus", () => {
  assert.match(panel, /import \{ Select \} from "@base-ui\/react\/select"/);
  assert.doesNotMatch(panel, /<select\b|<option\b/);
  assert.match(panel, /Select.Root value=\{chain\} items=\{networkItems\} disabled=\{disabled\}/);
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
  assert.match(panel, /t\("action.approve", \{ amount: nativeAmount\(b.amount\) \}\)/);
  assert.equal(en.bridge.action.approve, "Approve {amount} USDC");
  for (const [key, content] of [
    ["quote.approveFirst", "Approval alone does not move your funds"],
    ["approval.notice", "No bridge deposit has been requested"],
    ["form.approvalConfirmed", "Review a fresh quote before bridging"],
    ["approval.resume", "unspent allowance remains until used or revoked"],
    ["approval.verifyingDetail", "No wallet request will be made"],
  ] as const) {
    assert.ok(panel.includes(`"${key}"`), key);
    assert.ok(english.includes(content), content);
  }
  assert.match(panel, /approval\.approvalHash/);
  assert.match(panel, /b.recoverApproval\(hash.trim\(\)\)/);
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
  assert.match(panel, /t\("form.forGas", \{ amount: nativeAmount\(b.nativeBalance\), symbol: origin.symbol \}\)/);
  assert.equal(en.bridge.form.forGas, "For gas: {amount} {symbol}");
  assert.match(panel, /t\("route.robinhoodUsdc"\)/);
  assert.match(en.bridge.route.robinhoodUsdc, /^USDC on Robinhood is unavailable/);
  assert.match(panel, /t\("quote.approveFirst", \{ amount: nativeAmount\(b.amount\), symbol: origin.symbol \}\)/);
  assert.match(en.bridge.quote.approveFirst, /uses additional \{symbol\} for gas/);
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
  assert.match(panel, /t\("transfer.discardHelp", \{ network: origin.name \}\)/);
  assert.match(en.bridge.transfer.discardHelp, /Keep the Transfer ID below/);
  assert.match(en.bridge.form.disclaimer, /Openlaunch does not operate Relay, holds no funds in transit, and is not responsible for delays, refunds or losses/);
  assert.doesNotMatch(hook, /AbortSignal\.(any|timeout)/);
  assert.match(hook, /linkedTimeoutSignal\(signal, 20_000\)/);
  assert.match(hook, /anchorQuoteExpiry\(body, requestedAt\)/);
  assert.match(hook, /setActivity\(activityAfterWalletChange\)/);
  assert.match(hook, /error instanceof TransactionReceiptNotFoundError\) return null/);
  assert.match(hook, /replacementSourceHash\(current, status, receipt\.status === "fulfilled" && receipt\.value === null\)/);
  assert.match(hook, /const messageOf = bridgeErrorMessage;/);
});

test("quotes update without locking typing or automatically submitting wallet actions", () => {
  const hook = read("./useBridge.ts");
  assert.match(panel, /useBridge\(open\)/);
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
  assert.match(panel, /t\("feeLimit.hint"\)/);
  assert.match(en.bridge.feeLimit.hint, /Your quote updates automatically/);
  assert.match(panel, /rejection.reason === "relay-fee"/);
  assert.match(panel, /rejection.relayFeePercent/);
  assert.doesNotMatch(hook, /busy:.*quoting/);
});

test("the API's English errors read in the reader's language where the dialog shows them", () => {
  const hook = read("./useBridge.ts");
  // quote and status failures arrive as the API's own English text
  assert.match(hook, /typeof data\.error === "string" \? bridgeServiceMessage\(data\.error\)/);
  assert.match(hook, /typeof body\.error === "string" \? bridgeServiceMessage\(body\.error\)/);
  // messages raised in handlers and effects are worded then, so no callback or effect re-runs on a language switch
  assert.match(hook, /messageOf\(error, clientTranslator\("bridge"\)\("errors\.quoteFailed"\)\)/);
  assert.match(hook, /\}, \[approvalPending, tracked, config, requestKey, quoteSession\]\);/);
});

test("fee warnings separate the percentage, costs and touch-accessible exact explanation", () => {
  assert.match(panel, /<FeeLimitNotice rejection=\{b.quoteRejection\}/);
  assert.match(panel, /formatFeeWarningPercent\(exactPercent\)/);
  assert.match(panel, /t\("feeLimit.limit"\)/);
  assert.equal(en.bridge.feeLimit.limit, "5% safety limit");
  assert.match(panel, /role="status" aria-atomic="true"/);
  assert.match(panel, /<details className=\{styles.feeLimitReason\}>[\s\S]+t\("feeLimit.why"\)/);
  assert.equal(en.bridge.feeLimit.why, "Why is this blocked?");
  assert.match(panel, /t\(feeTooHigh \? "feeLimit.whyFee" : "feeLimit.whyLoss", \{ percent: exactPercent \}\)/);
  assert.match(en.bridge.feeLimit.whyFee, /^Relay’s fee is \{percent\}%/);
  assert.match(en.bridge.feeLimit.whyLoss, /quote loses \{percent\}% in conversion and fees/);
  for (const why of [en.bridge.feeLimit.whyFee, en.bridge.feeLimit.whyLoss]) assert.match(why, /Source gas is extra and is not included in this limit/);
  assert.match(css, /\.feeLimitHeading \{[^}]*display: grid[^}]*align-items: start/);
  assert.match(css, /\.feeLimitReason summary \{[^}]*min-height: 44px/);
  assert.match(css, /\.feeLimitReason p \{[^}]*overflow-wrap: anywhere/);
});

test("pending approvals explain missing/queued transactions and accept a verified replacement without a new wallet call", () => {
  const hook = read("./useBridge.ts");
  assert.match(panel, /health\?\.title/);
  assert.match(panel, /needsAttention \? <CircleAlert/);
  assert.match(panel, /t\("approval.spedUp"\)/);
  assert.equal(en.bridge.approval.spedUp, "Sped up your approval in the wallet?");
  assert.doesNotMatch(panel + english, /has no record of this approval/);
  assert.match(panel, /t\("approval.discardHelp"\)/);
  assert.match(en.bridge.approval.discardHelp, /discarding this record does not cancel it or fix a queued nonce/);
  assert.match(hook, /recoverApprovalFromEvidence\(current/);
  assert.match(hook, /!canApplyApprovalPoll\(current, observed\)/);
  assert.match(hook, /const health = receipt \? null : await readPendingApprovalHealth/);
  assert.match(hook, /value: APPROVAL_HEALTH_UNAVAILABLE/);
  assert.equal((hook.match(/await assertBridgeWalletQueueClear\(/g) ?? []).length, 2);
});
