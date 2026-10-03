import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const picker = readFileSync(new URL("./WalletPicker.tsx", import.meta.url), "utf8");
const button = readFileSync(new URL("./ConnectWallet.tsx", import.meta.url), "utf8");
const src = fileURLToPath(new URL("../", import.meta.url));

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

// Source contracts: the picker is the only place that chooses a connector or calls connect().
test("every connect entry point goes through the shared picker; nothing else touches useConnect", () => {
  const users = walk(src).filter((p) => /useConnect\b|connectors\[0\]|c\.id === "coinbaseWallet"/.test(readFileSync(p, "utf8")));
  assert.deepEqual(users.map((p) => relative(src, p).replaceAll("\\", "/")), ["components/WalletPicker.tsx"]);
  for (const file of ["components/ConnectButton.tsx", "components/launchpad/Posts.tsx", "components/launchpad/TradePanel.tsx", "components/launchpad/MeDashboard.tsx"]) {
    assert.match(readFileSync(join(src, file), "utf8"), /<ConnectWallet className=/, file);
  }
  assert.match(readFileSync(join(src, "components/launchpad/LaunchForm.tsx"), "utf8"), /onConnect=\{\(\) => setPickerOpen\(true\)\}[\s\S]*<WalletPicker onClose=/);
});

test("the picker offers wallets by capability, not by a hard-coded connector id", () => {
  assert.match(picker, /walletChoices\(connectors, \{ hasInjectedProvider \}\)/);
  assert.doesNotMatch(picker, /"coinbaseWallet"|"coinbaseWalletSDK"|connectors\[0\]/);
  // window.ethereum is read through useSyncExternalStore with a server snapshot, never during render on the server,
  // and re-read when a wallet injects after the sheet opened (EIP-1193 "ethereum#initialized", EIP-6963 announce)
  assert.match(picker, /useSyncExternalStore\(\s*subscribeToInjectedProvider,\s*\(\) => Boolean\(\(window as \{ ethereum\?: unknown \}\)\.ethereum\),\s*\(\) => false,\s*\)/);
  assert.match(picker, /INJECTED_PROVIDER_EVENTS = \["ethereum#initialized", "eip6963:announceProvider"\] as const/);
  assert.match(picker, /for \(const name of INJECTED_PROVIDER_EVENTS\) window\.addEventListener\(name, onChange\)/);
  assert.match(picker, /return \(\) => \{\s*for \(const name of INJECTED_PROVIDER_EVENTS\) window\.removeEventListener\(name, onChange\);/);
});

test("connect errors are explained in the dialog and never echoed raw", () => {
  assert.match(picker, /onError: \(e\) => setError\(connectErrorMessage\(e\)\)/);
  assert.match(picker, /role="alert" aria-live="assertive"/);
  assert.doesNotMatch(picker, /error\.message|String\(e\)|friendlyError/);
  // one in-flight request at a time, and the row that is waiting says so
  assert.match(picker, /if \(!connector \|\| isPending\) return/);
  assert.match(picker, /disabled=\{isPending\}/);
  assert.match(picker, /Waiting for the wallet…/);
  assert.match(picker, /onSettled: \(\) => setPendingId\(null\)/);
  // a successful connect closes the sheet; the caller unmounts it
  assert.match(picker, /useConnect\(\{ mutation: \{ onSuccess: onClose \} \}\)/);
});

test("the picker and its button are presentation only: no signing, transactions, storage, or tracking", () => {
  assert.doesNotMatch(picker + button, /signMessage|signTypedData|writeContract|sendTransaction|fetch\(|localStorage|sessionStorage|setInterval\(/);
  assert.match(picker, /<Sheet title="Connect a wallet" onClose=\{onClose\}>/);
  assert.match(picker, /Transactions and edits always need your signature/);
  assert.match(button, /aria-haspopup="dialog" aria-expanded=\{open\}/);
  assert.match(button, /\{open \? <WalletPicker onClose=\{\(\) => setOpen\(false\)\} \/> : null\}/);
  // wallet icons are the browser-announced data: URIs, shown decoratively
  assert.match(picker, /<img src=\{choice\.icon\} alt="" width=\{24\} height=\{24\}/);
  assert.doesNotMatch(picker + button, /—/);
});
