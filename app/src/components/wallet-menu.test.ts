import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { en } from "../i18n/messages/index.ts";

const source = readFileSync(new URL("./WalletMenu.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("./WalletMenu.module.css", import.meta.url), "utf8");
const adapter = readFileSync(new URL("./ConnectButton.tsx", import.meta.url), "utf8");
const header = readFileSync(new URL("./HeaderNav.tsx", import.meta.url), "utf8");

// Source contracts supplement browser QA without connecting, signing, or
// disconnecting a real wallet. They are not a simulated wagmi integration test.
test("connected wallet chip is an account disclosure, never a one-click disconnect", () => {
  const trigger = source.slice(source.indexOf("<Popover.Trigger"), source.indexOf("</Popover.Trigger>"));
  assert.match(trigger, /aria-label=\{t\("trigger"/);
  assert.match(en.wallet.trigger, /Open account menu/);
  assert.doesNotMatch(trigger, /onDisconnect|runAction|onClick/);
  assert.match(source, /<Popover.Root\b[^>]*open=\{open\} onOpenChange=/);
  assert.match(source, /className=\{styles.disconnect\} disabled=\{busy\} onClick=\{\(\) => void runAction\("disconnect"\)\}/);
  assert.match(source, /if \(target === "disconnect"\)\s*\{\s*await onDisconnect\(\);\s*setOpen\(false\)/);
  assert.match(source, /<AccountMenu key=\{props.address.toLowerCase\(\)\}/);
});

test("wallet adapter preserves hydration, routes connecting through the picker, and keeps explicit async actions", () => {
  assert.match(adapter, /useSyncExternalStore\(/);
  assert.match(adapter, /if \(!mounted\) return <div/);
  assert.match(adapter, /if \(!isConnected \|\| !address\)/);
  // wallet choice and connect errors live in WalletPicker; the header never picks a connector itself
  assert.match(adapter, /<ConnectWallet className=/);
  assert.doesNotMatch(adapter, /useConnect\(|\bconnectors\b|\bconnect\(/);
  assert.match(adapter, /onSwitchChain=\{\(chain\) => switchChainAsync\(\{ chainId: CHAINS\[chain\].id \}\)\}/);
  assert.match(adapter, /onDisconnect=\{\(\) => disconnectAsync\(\)\}/);
  assert.match(adapter, /switching=\{switching\} disconnecting=\{disconnecting\}/);
});

test("unknown networks stay unknown and never get an inferred explorer destination", () => {
  assert.match(source, /const key = chainKeyOf\(chainId\)/);
  assert.match(source, /key \? CHAIN_SHORT\[key\] : bridgeNetwork\?\.name \?\? t\("unsupportedNetwork"\)/);
  assert.equal(en.wallet.unsupportedNetwork, "Unsupported network");
  assert.match(source, /isBridgeChainId\(chainId\) \? BRIDGE_CHAINS\[chainId\]/);
  assert.match(source, /\{explorer \? \(\s*<a[^>]*href=\{explorer\}/);
  assert.match(source, /const explorer = key \? explorerAddress\(key, address\) : bridgeNetwork \? `[\s\S]*` : null/);
  assert.match(source, /explorerName\(key\)/);
  assert.match(source, /t\("unsupportedHelp"\)/);
  assert.equal(en.wallet.unsupportedHelp, "This network isn’t supported. Choose one below.");
  // the switcher offers the chains the site has contracts on (every chain in development, where none may be configured)
  assert.match(source, /VISIBLE_CHAINS.map\(\(chain\) =>/);
  assert.match(source, /aria-pressed=\{chain === key\}/);
  assert.doesNotMatch(source, /chainKeyOf\(chainId\)\s*(?:\|\||\?\?)\s*"base"|explorerAddress\("base"/);
});

test("pending actions are locked against duplicate requests and rejection is recoverable", () => {
  assert.match(source, /const busy = switching \|\| disconnecting \|\| localBusy !== null/);
  assert.match(source, /if \(busy \|\| actionLock.current \|\| target === key\) return/);
  assert.match(source, /actionLock.current = true/);
  assert.match(source, /await onSwitchChain\(target\)/);
  assert.match(source, /finally\s*\{\s*actionLock.current = false;\s*setLocalBusy\(null\)/);
  assert.match(source, /target === "disconnect" \? t\("disconnectFailed"\) : t\("switchFailed"\)/);
  assert.equal(en.wallet.switchFailed, "Network switch wasn’t completed. Try again in your wallet.");
  assert.equal(en.wallet.disconnectFailed, "Couldn’t disconnect. Try again.");
  assert.match(source, /disabled=\{busy\} onClick=\{\(\) => void runAction\(chain\)\}/);
  assert.match(source, /role="status" aria-live="polite"/);
});

test("network switcher uses official local logos with theme-correct Robinhood marks", () => {
  // one logo record per chain (a new chain must bring its own mark); every referenced file is a real SVG
  assert.match(source, /const NETWORK_LOGOS: Record<ChainKey, \{/);
  for (const asset of ["base", "robinhood-black", "robinhood-white", "arc"]) {
    assert.ok(source.includes(`"/brand/${asset}.svg"`), `logo ${asset}`);
    assert.match(readFileSync(new URL(`../../public/brand/${asset}.svg`, import.meta.url), "utf8"), /<svg\b/);
  }
  assert.match(source, /robinhood: \{ light: "\/brand\/robinhood-black\.svg", dark: "\/brand\/robinhood-white\.svg"/);
  assert.match(source, /<Image className=\{styles\.lightLogo\} src=\{logo\.light\}/);
  assert.match(source, /<Image className=\{styles\.darkLogo\} src=\{logo\.dark\}/);
  assert.match(source, /className=\{styles.networkLogo\} aria-hidden/);
  assert.doesNotMatch(source, /\? "B" : "R"|styles\.networkGlyph/);
  assert.match(css, /\.networkLogo img\s*\{[^}]*object-fit: contain/);
  assert.match(css, /\.networkLogo \.darkLogo\s*\{\s*display: none/);
  assert.match(css, /:global\(\.dark\) \.networkLogo \.lightLogo\s*\{\s*display: none/);
  assert.match(css, /:global\(\.dark\) \.networkLogo \.darkLogo\s*\{\s*display: block/);
});

test("the header chip carries its network as an avatar badge; only the mobile row spells it out", () => {
  // the network's name in the desktop chip pushed the Launch button out of the header (up to 49px in the floating pill)
  const trigger = source.slice(source.indexOf("<Popover.Trigger"), source.indexOf("</Popover.Trigger>"));
  assert.match(trigger, /\{block \? <span className=\{styles\.triggerNetwork\}>/);
  assert.match(trigger, /block \? <span className=\{styles\.connectionDot\} \/> : <NetworkBadge chain=\{key \?\? bridgeNetwork\?\.key \?\? null\} \/>/);
  assert.match(trigger, /title=\{block \? undefined : [^\n]*t\("unsupportedTitle"\)\}/);
  assert.equal(en.wallet.unsupportedTitle, "Unsupported network. Open to switch");
  const badge = source.slice(source.indexOf("function NetworkBadge"), source.indexOf("type WalletMenuProps"));
  assert.match(badge, /if \(!chain\) return <span className=\{styles\.networkWarn\} aria-hidden>!<\/span>/);
  // the site's chain tile (Arc's white mark needs its dark tile), as on token avatars
  assert.match(badge, /<ChainLogo chain=\{chain\} size=\{14\} className="absolute -right-1 -bottom-1 ring-2 ring-card" \/>/);
  assert.match(css, /\.networkWarn\s*\{[^}]*position: absolute[^}]*background: var\(--color-warm\)/);
});

test("wallet shortcuts copy the full address and close the nested menu on navigation", () => {
  assert.match(source, /await navigator.clipboard.writeText\(address\)/);
  assert.match(source, /setNotice\(t\("copiedNotice"\)\)/);
  assert.match(source, /setNotice\(t\("copyFailed"\)\)/);
  assert.equal(en.wallet.copiedNotice, "Address copied.");
  assert.equal(en.wallet.copyFailed, "Couldn’t copy. Select the address above to copy it manually.");
  assert.match(source, /aria-label=\{t\("fullAddress"\)\}>\{address\}/);
  assert.match(source, /href="\/me"[^>]*onClick=\{\(\) => \{ setOpen\(false\); onNavigate\?\.\(\)/);
  assert.match(header, /<ConnectButton block onNavigate=\{\(\) => setOpen\(false\)\}/);
  assert.match(source, /<Popover.Portal>/);
  assert.match(source, /<Popover.Root modal=\{block\}/);
  assert.match(source, /aria-modal=\{block \|\| undefined\}/);
  assert.match(source, /block \? <Popover.Backdrop className=\{styles.backdrop\}/);
  assert.match(source, /collisionPadding=\{12\} positionMethod="fixed"/);
  assert.match(source, /event.key === "Escape"\) \{ event.stopPropagation\(\); setOpen\(false\)/);
  assert.match(source, /aria-label=\{t\("close"\)\}/);
  assert.equal(en.wallet.close, "Close wallet menu");
});

test("wallet presentation has no signing, transaction, balance, polling, or tracking work", () => {
  assert.doesNotMatch(source + adapter, /useSignMessage|signMessage\(|signTypedData\(|writeContract\(|sendTransaction\(|useBalance|useReadContract|fetch\(|setInterval\(|localStorage|sessionStorage/);
  assert.match(source, /<WalletAvatar address=\{address\}/);
  assert.doesNotMatch(source, /Math.random\(|Date.now\(|verified identity|verified wallet/i);
});

test("wallet menu stays theme-native, bounded on mobile, keyboard-accessible, and motion-aware", () => {
  assert.match(css, /width: min\(336px, calc\(100vw - 24px\)\)/);
  assert.match(css, /max-height: min\(var\(--available-height\), calc\(100dvh - 24px\)\)/);
  assert.match(css, /overflow-y: auto/);
  assert.match(css, /\.mobilePositioner\s*\{[^}]*inset: auto 12px max\(12px, env\(safe-area-inset-bottom\)\)/);
  assert.match(css, /max-height: calc\(100dvh - 32px - env\(safe-area-inset-bottom\)\)/);
  assert.match(css, /overflow-wrap: anywhere/);
  assert.match(css, /min-height: 44px/);
  assert.match(css, /:focus-visible/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /transition: none/);
  assert.match(css, /background: var\(--color-paper\)/);
  assert.doesNotMatch(css, /#[\da-f]{3,8}\b|gradient\(|box-shadow:|text-shadow:|animation:/i);
  assert.doesNotMatch(source + css, /\u2014/);
});
