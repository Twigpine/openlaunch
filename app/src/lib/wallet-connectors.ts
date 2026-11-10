/**
 * Which wallets the connect picker offers, in what order, and what a failed connect should say.
 * No wagmi or "@/" imports, so the tests load it directly. Its words are the account.walletPicker
 * messages in the reader's language (clientTranslator; English outside the browser, as in tests).
 *
 * wagmi registers three kinds of connector in this app:
 *  - wallets announced by the browser through EIP-6963 (type "injected", id = the wallet's rdns),
 *    added by wagmi's provider discovery on the client;
 *  - the generic `injected()` connector (id "injected"), which talks to whatever `window.ethereum`
 *    is and rejects with ProviderNotFoundError when there is none;
 *  - the Coinbase connector (type "coinbaseWallet"), which needs no extension: Smart Wallet signs
 *    with a passkey in a popup, and the same popup pairs the Coinbase Wallet app.
 */
import { CHAIN_KEYS, CHAIN_LABELS } from "./chainKeys.ts";
import { clientTranslator } from "../i18n/client.ts";

export type ConnectorInfo = { id: string; name: string; type: string; icon?: string };

export type WalletChoice = {
  id: string;
  name: string;
  /** One line under the name. */
  hint: string;
  icon?: string;
  kind: "detected" | "browser" | "coinbase";
};

export const COINBASE_CONNECTOR_TYPE = "coinbaseWallet";
export const INJECTED_CONNECTOR_TYPE = "injected";
/** wagmi's generic injected connector: `window.ethereum`, whichever wallet that is. */
export const GENERIC_INJECTED_ID = "injected";

/**
 * Wallets to offer: every wallet the browser announced, then the generic browser wallet when
 * something is injected but nothing announced itself, then Coinbase (always, it needs no extension).
 */
export function walletChoices(connectors: readonly ConnectorInfo[], { hasInjectedProvider }: { hasInjectedProvider: boolean }): WalletChoice[] {
  const t = clientTranslator("account");
  const detected = connectors
    .filter((c) => c.type === INJECTED_CONNECTOR_TYPE && c.id !== GENERIC_INJECTED_ID)
    .map<WalletChoice>((c) => ({ id: c.id, name: c.name, hint: t("walletPicker.detected"), icon: c.icon, kind: "detected" }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const out: WalletChoice[] = [...detected];
  if (detected.length === 0 && hasInjectedProvider) {
    const generic = connectors.find((c) => c.id === GENERIC_INJECTED_ID);
    if (generic) out.push({ id: generic.id, name: t("walletPicker.browserWallet"), hint: t("walletPicker.browserHint"), icon: generic.icon, kind: "browser" });
  }
  const coinbase = connectors.find((c) => c.type === COINBASE_CONNECTOR_TYPE);
  if (coinbase) out.push({ id: coinbase.id, name: coinbase.name, hint: t("walletPicker.coinbaseHint"), icon: coinbase.icon, kind: "coinbase" });
  return out;
}

/** Every chain the site names, as "Base, Robinhood Chain or Arc" in English (chainList's wording) or "Base、Robinhood Chain 或 Arc". */
function chainsOr(t: ReturnType<typeof clientTranslator<"account">>): string {
  const names = CHAIN_KEYS.map((k) => CHAIN_LABELS[k]);
  if (names.length <= 1) return names[0] ?? "";
  return t("walletPicker.chainsOr", { list: names.slice(0, -1).join(t("walletPicker.listSeparator")), last: names[names.length - 1] });
}

type ErrorLike = { name?: unknown; code?: unknown; message?: unknown; cause?: unknown };

/** Walks `err` and its `cause` chain (viem and wagmi wrap the wallet's error) and returns the first match. */
function findCause(err: unknown, test: (e: ErrorLike) => boolean): ErrorLike | null {
  let cur: unknown = err;
  for (let depth = 0; depth < 8 && cur && typeof cur === "object"; depth++) {
    const e = cur as ErrorLike;
    if (test(e)) return e;
    cur = e.cause;
  }
  return null;
}

type Match = { name?: RegExp; message?: RegExp; code?: number | string };
const has = (e: ErrorLike, m: Match) =>
  (m.name !== undefined && m.name.test(String(e.name ?? ""))) ||
  (m.message !== undefined && m.message.test(String(e.message ?? ""))) ||
  (m.code !== undefined && e.code === m.code);

/** User-facing text for a failed wallet connection. Never echoes raw error text. */
export function connectErrorMessage(err: unknown): string {
  const t = clientTranslator("account");
  const found = (m: Match) => findCause(err, (e) => has(e, m)) !== null;
  // the same note the picker shows when it finds no extension
  if (found({ name: /^ProviderNotFoundError$/, message: /provider not found/i })) return t("walletPicker.noWallet");
  if (found({ name: /^UserRejectedRequestError$/, message: /user rejected|user denied|user closed modal|request rejected|cancelled|canceled/i, code: 4001 }))
    return t("walletPicker.errors.cancelled");
  if (found({ name: /^ConnectorAlreadyConnectedError$/, message: /already connected/i })) return t("walletPicker.errors.alreadyConnected");
  if (found({ name: /^ResourceUnavailableRpcError$/, message: /already pending|already processing/i, code: -32002 }))
    return t("walletPicker.errors.pending");
  if (found({ name: /^(ChainNotConfiguredError|SwitchChainError)$/, message: /chain not configured|unrecognized chain/i }))
    return t("walletPicker.errors.wrongNetwork", { chains: chainsOr(t) });
  if (found({ message: /pop-?up|window\.open|blocked/i })) return t("walletPicker.errors.popup");
  if (found({ message: /cannot find module|failed to fetch dynamically imported module|loading chunk/i, code: "MODULE_NOT_FOUND" }))
    return t("walletPicker.errors.loadFailed");
  return t("walletPicker.errors.generic");
}
