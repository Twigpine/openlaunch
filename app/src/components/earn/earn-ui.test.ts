import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// Source contracts for the Earn components (like bridge-ui.test.ts): they hold the money-moving rules in place.
const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const hook = read("./useEarn.ts");
const card = read("./EarnCard.tsx");
const dialog = read("./EarnDialog.tsx");
const panel = read("./EarnPanel.tsx");
const calls = read("../../lib/earn/calls.ts");
const dashboard = read("../launchpad/MeDashboard.tsx");
const reviewPage = read("../../app/ui-review-earn/page.tsx");
const allEarn = [hook, card, dialog, panel, calls, read("../../lib/earn/math.ts"), read("../../lib/earn/terms.ts"), read("../../lib/earn/server.ts"), read("../../lib/earn/vaults.ts")];

test("every wallet write is credited to the builder code", () => {
  const direct = hook.match(/writeContract\(\{[^}]*\}/g) ?? [];
  assert.ok(direct.length >= 1);
  for (const w of direct) assert.match(w, /dataSuffix: BUILDER_DATA_SUFFIX/, w);
  const simulated = hook.match(/simulateContract\(\{[^}]*\}/g) ?? [];
  // batch preflight: deposit, approve, deposit with the allowance override; one-at-a-time deposit; redeem and
  // withdraw on each path
  assert.equal(simulated.length, 8);
  for (const s of simulated) assert.match(s, /dataSuffix: BUILDER_DATA_SUFFIX/, s);
  // a prepared request is only ever sent as simulated (the suffix travels inside it)
  assert.equal((hook.match(/writeContract\(request\)/g) ?? []).length, 3);
  assert.match(hook, /sendCalls\(config, \{ account, chainId, calls, capabilities: EARN_BATCH_CAPABILITIES, forceAtomic: true \}\)/);
  assert.match(calls, /const tagged = \(data: Hex\): Hex => concatHex\(\[data, BUILDER_DATA_SUFFIX\]\)/);
});

test("approvals are exact: no unlimited allowance anywhere in Earn", () => {
  for (const src of allEarn) assert.doesNotMatch(src, /maxUint256|maxUint160|2n \*\* 256n/);
  assert.match(hook, /functionName: "approve", args: \[vault\.address, value\]/);
});

test("both actions lock before their first await and simulate before any signature", () => {
  for (const name of ["deposit", "withdraw"]) {
    const body = hook.slice(hook.indexOf(`async function ${name}()`));
    const lockAt = body.indexOf("lock.current = true");
    assert.ok(lockAt > 0, name);
    assert.ok(lockAt < body.indexOf("await "), `${name} awaits before locking`);
  }
  const deposit = hook.slice(hook.indexOf("async function deposit()"), hook.indexOf("async function withdraw()"));
  assert.ok(deposit.indexOf("await requireTerms(pub)") < deposit.indexOf("batching("), "terms are checked before any send");
  // and again once an approval has confirmed, right before the deposit is prepared
  const afterApproval = deposit.slice(deposit.indexOf("functionName: \"approve\""));
  assert.ok(afterApproval.indexOf("await requireTerms(pub)") > 0 && afterApproval.indexOf("await requireTerms(pub)") < afterApproval.indexOf("simulateContract("));
  assert.ok(deposit.indexOf("simulateContract(") < deposit.indexOf("writeContract(request)"));
});

test("every prompt is bound to the initiating account; an unreadable receipt is never a retryable failure", () => {
  assert.match(hook, /getWalletClient\(config, \{ chainId, account \}\)/);
  assert.match(hook, /wallet\.writeContract\(\{ account, address: vault\.asset/);
  assert.doesNotMatch(hook, /getWalletClient\(config, \{ chainId \}\)/);
  for (const name of ["walletFor", "batching", "sendBatch"]) {
    const body = hook.slice(hook.indexOf(`function ${name}(`));
    assert.match(body.slice(0, 200), /ensureAccount\(account\)/, name);
  }
  // the deposit and withdrawal receipts go through settleTx, which turns a failed wait into "unconfirmed"
  assert.equal((hook.match(/outcome = await settleTx\(pub, hash, /g) ?? []).length, 2);
  assert.match(hook.slice(hook.indexOf("async function settleTx(")), /catch \{\s*setPhase\(unconfirmed\(tab, amount, \{ kind: "tx", hash \}\)\);/);
  assert.match(hook.slice(hook.indexOf("async function sendBatch(")), /catch \{\s*setPhase\(unconfirmed\(tab, amount, \{ kind: "batch", id \}\)\);/);
  assert.match(hook, /const busy = isBusy\(phase\);/);
});

test("a deposit pause is derived from a polled read, never stored, so it cannot stick after the terms recover", () => {
  assert.doesNotMatch(hook, /setPaused|useState<string \| null>/);
  assert.match(hook, /useReadContracts\(\{[\s\S]*?query: \{ refetchInterval: 60_000 \}/);
  for (const fn of ["asset", "performanceFee", "managementFee", "receiveSharesGate", "sendSharesGate", "receiveAssetsGate", "sendAssetsGate"]) assert.match(hook, new RegExp(`functionName: "${fn}"`), fn);
  assert.match(panel, /const pauseReason = depositPause\(e\.liveTerms, snapshot\?\.terms \?\? null\);/);
  // a failed latest poll is no live answer (wagmi keeps the last good data through a failed refetch)
  assert.match(hook, /const liveTerms = liveCheck\(vault, terms\.data, terms\.isError\);/);
  // a failed send-time check refreshes the polled read so the form shows the pause at once
  const require = hook.slice(hook.indexOf("async function requireTerms("));
  assert.match(require, /if \(!check\.ok\) \{\s*void terms\.refetch\(\);[^\n]*\n\s*throw new Error\(pausedCopy\(check\.reason\)\);/);
});

test("a batch is simulated before its one prompt, like every other send", () => {
  const deposit = hook.slice(hook.indexOf("async function deposit()"), hook.indexOf("async function withdraw()"));
  assert.match(deposit, /if \(\(await batching\(account\)\) && \(await preflightBatch\(pub, account, value, short\)\)\) \{\s*(?:\/\/[^\n]*\n\s*)*outcome = await sendBatch\(/);
  const withdraw = hook.slice(hook.indexOf("async function withdraw()"), hook.indexOf("async function recheck()"));
  const batchBranch = withdraw.slice(withdraw.indexOf("if (await batching(account)) {"));
  assert.ok(batchBranch.indexOf("simulateContract(") < batchBranch.indexOf("sendBatch("));
  // the override is trusted only after it is seen to take
  const preflight = hook.slice(hook.indexOf("async function preflightBatch("));
  assert.match(preflight, /if \(seen !== value\) return false;/);
  assert.ok(preflight.indexOf("if (seen !== value) return false;") < preflight.indexOf("stateOverride });"));
});

test("while a send is in flight the button shows its progress, never a network-switch offer", () => {
  assert.match(panel, /const clickable = !e\.isConnected \|\| \(!e\.onChain && !e\.switching && !e\.busy\) \|\| ready;/);
  const label = panel.slice(panel.indexOf("const label = "), panel.indexOf("const ready = "));
  assert.ok(label.indexOf('e.phase.k === "sent"') < label.indexOf("!e.onChain ?"), "progress labels come before the switch offer");
  assert.match(hook.slice(hook.indexOf("async function switchToVaultChain(")), /^async function switchToVaultChain\(\) \{\s*if \(busy \|\| lock\.current\) return;/);
});

test("an upgrade-to-smart-account prompt is never triggered", () => {
  assert.match(calls, /c\.atomic\?\.status === "supported"/);
  assert.doesNotMatch(calls, /status === "ready"/);
});

test("the card shows only while the switch is on, and the sheet loads on first use", () => {
  assert.match(card, /info\?\.enabled \?/);
  assert.match(card, /if \(!entry \|\| !vault\) return null;/);
  assert.match(card, /dynamic\(\(\) => import\("\.\/EarnDialog"\), \{ ssr: false \}\)/);
  assert.match(card, /id="earn"/);
  assert.equal((dashboard.match(/<SeasonCard address=\{address\} \/>\n\s*<EarnCard address=\{address\} \/>/g) ?? []).length, 2);
});

test("the copy states the risk and the absence of any openlaunch fee, and makes no promise", () => {
  assert.match(panel, /Deposits can lose money\./);
  assert.match(panel, /openlaunch never holds your funds, cannot move them and cannot guarantee a withdrawal/);
  assert.match(panel, /<dt>openlaunch fee<\/dt><dd>None<\/dd>/);
  assert.match(dialog, /0 openlaunch fee/);
  assert.match(card, /Can lose money\. No openlaunch fee\./);
  for (const src of [card, dialog, panel]) {
    assert.doesNotMatch(src, /Base Earn|Coinbase|high[- ]yield|guaranteed (?:return|yield|rate)|risk[- ]free|\bsafe\b/i);
  }
});

test("the review page is development-only", () => {
  assert.match(reviewPage, /process\.env\.NODE_ENV !== "development"\) notFound\(\)/);
});
