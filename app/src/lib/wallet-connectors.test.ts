import assert from "node:assert/strict";
import test from "node:test";
import { connectErrorMessage, walletChoices, type ConnectorInfo } from "./wallet-connectors.ts";
import { chainList } from "./chainKeys.ts";
import { en, messagesFor } from "../i18n/messages/index.ts";
import { setClientLanguage } from "../i18n/client.ts";

// the picker's words are messages; outside the browser (here) they read in English
const NO_WALLET_NOTE = en.account.walletPicker.noWallet;

// The ids and types wagmi 3 / @wagmi/connectors 8 actually use. The Coinbase connector's id is
// "coinbaseWalletSDK", not "coinbaseWallet": matching on `type` is what keeps the picker honest.
const injected: ConnectorInfo = { id: "injected", name: "Injected", type: "injected" };
const coinbase: ConnectorInfo = { id: "coinbaseWalletSDK", name: "Coinbase Wallet", type: "coinbaseWallet" };
const rabby: ConnectorInfo = { id: "io.rabby", name: "Rabby Wallet", type: "injected", icon: "data:image/svg+xml;base64,AA==" };
const metamask: ConnectorInfo = { id: "io.metamask", name: "MetaMask", type: "injected", icon: "data:image/svg+xml;base64,BB==" };

test("announced wallets come first (sorted), then Coinbase; the generic connector stays hidden behind them", () => {
  const choices = walletChoices([injected, coinbase, rabby, metamask], { hasInjectedProvider: true });
  assert.deepEqual(choices.map((c) => [c.id, c.kind]), [["io.metamask", "detected"], ["io.rabby", "detected"], ["coinbaseWalletSDK", "coinbase"]]);
  assert.equal(choices[0].icon, metamask.icon);
  assert.equal(choices[0].hint, "Detected in this browser");
});

test("a browser wallet that only injects window.ethereum is offered through the generic connector", () => {
  const choices = walletChoices([injected, coinbase], { hasInjectedProvider: true });
  assert.deepEqual(choices.map((c) => [c.id, c.kind, c.name]), [["injected", "browser", "Browser wallet"], ["coinbaseWalletSDK", "coinbase", "Coinbase Wallet"]]);
});

test("with nothing injected only Coinbase is offered: the generic connector would reject with ProviderNotFound", () => {
  const choices = walletChoices([injected, coinbase], { hasInjectedProvider: false });
  assert.deepEqual(choices.map((c) => c.id), ["coinbaseWalletSDK"]);
  assert.match(choices[0].hint, /passkey/);
});

test("Coinbase is found by type, never by the old id, and the list survives an empty config", () => {
  assert.deepEqual(walletChoices([{ ...coinbase, id: "somethingElse" }], { hasInjectedProvider: false }).map((c) => c.id), ["somethingElse"]);
  assert.deepEqual(walletChoices([{ id: "coinbaseWallet", name: "x", type: "unknown" }], { hasInjectedProvider: false }), []);
  assert.deepEqual(walletChoices([], { hasInjectedProvider: true }), []);
});

test("connect errors are explained without leaking raw messages", () => {
  const named = (name: string, message = "") => Object.assign(new Error(message), { name });
  assert.equal(connectErrorMessage(named("ProviderNotFoundError", "Provider not found.\n\nVersion: @wagmi/core@3.6.4")), NO_WALLET_NOTE);
  assert.equal(connectErrorMessage(named("UserRejectedRequestError", "User rejected the request.")), "The connection was cancelled in the wallet.");
  assert.equal(connectErrorMessage(Object.assign(new Error("boom"), { code: 4001 })), "The connection was cancelled in the wallet.");
  assert.equal(connectErrorMessage(new Error("user closed modal")), "The connection was cancelled in the wallet.");
  assert.equal(connectErrorMessage(named("ConnectorAlreadyConnectedError", "Connector already connected.")), "This wallet is already connected.");
  assert.equal(connectErrorMessage(Object.assign(new Error("Request of type 'wallet_requestPermissions' already pending"), { code: -32002 })), "The wallet already has a connection request open. Finish it there, then try again.");
  assert.match(connectErrorMessage(new Error("Popup was blocked")), /Allow pop-ups/);
  assert.match(connectErrorMessage(Object.assign(new Error("Cannot find module '@coinbase/wallet-sdk'"), { code: "MODULE_NOT_FOUND" })), /Reload the page/);
  assert.match(connectErrorMessage(named("ChainNotConfiguredError", "Chain not configured.")), /Base, Robinhood Chain or Arc/);
  // every chain the site names, worded as chainList words it
  assert.ok(connectErrorMessage(named("ChainNotConfiguredError")).includes(` ${chainList("or")} `));
});

test("in the browser the picker reads in the reader's language, the chains listed the Chinese way", () => {
  const g = globalThis as { window?: unknown };
  g.window = {}; // clientTranslator follows the page's language only in a browser
  try {
    setClientLanguage("zh-CN", messagesFor("zh-CN"));
    assert.match(connectErrorMessage(Object.assign(new Error("Chain not configured."), { name: "ChainNotConfiguredError" })), /请在钱包中切换到 Base、Robinhood Chain 或 Arc。$/);
    assert.equal(connectErrorMessage(Object.assign(new Error("boom"), { code: 4001 })), messagesFor("zh-CN").account.walletPicker.errors.cancelled);
    const [browser, cb] = walletChoices([injected, coinbase], { hasInjectedProvider: true });
    assert.deepEqual([browser.name, browser.hint, cb.name], ["浏览器钱包", "此浏览器中的钱包扩展或应用", "Coinbase Wallet"]);
  } finally {
    setClientLanguage("en", en);
    delete g.window;
  }
});

test("wrapped errors are recognised through their cause chain, and unknown ones get a generic line", () => {
  const wrapped = Object.assign(new Error("Connect failed"), { name: "ConnectorError", cause: Object.assign(new Error("denied"), { code: 4001 }) });
  assert.equal(connectErrorMessage(wrapped), "The connection was cancelled in the wallet.");
  const generic = "Couldn’t connect. Try again, or pick another wallet.";
  assert.equal(connectErrorMessage(new Error("0xdeadbeef internal failure with a private key in it")), generic);
  assert.equal(connectErrorMessage(undefined), generic);
  assert.equal(connectErrorMessage("string"), generic);
  // a cycle in the cause chain must not hang the UI
  const loop: { cause?: unknown; message: string } = { message: "x" };
  loop.cause = loop;
  assert.equal(connectErrorMessage(loop), generic);
  // raw text never reaches the user
  assert.doesNotMatch(connectErrorMessage(new Error("Version: @wagmi/core@3.6.4")), /wagmi/);
});
