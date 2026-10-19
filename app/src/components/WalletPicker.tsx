"use client";

import { useState, useSyncExternalStore } from "react";
import { useConnect } from "wagmi";
import { useTranslations } from "use-intl";
import { Wallet } from "lucide-react";
import { connectErrorMessage, walletChoices, type WalletChoice } from "@/lib/wallet-connectors";
import Sheet from "./Sheet";

const INJECTED_PROVIDER_EVENTS = ["ethereum#initialized", "eip6963:announceProvider"] as const;

function subscribeToInjectedProvider(onChange: () => void): () => void {
  for (const name of INJECTED_PROVIDER_EVENTS) window.addEventListener(name, onChange);
  return () => {
    for (const name of INJECTED_PROVIDER_EVENTS) window.removeEventListener(name, onChange);
  };
}

/**
 * The connect dialog: every wallet the browser announced, the generic browser wallet when one is
 * injected without announcing itself, and Coinbase (passkey Smart Wallet or the Coinbase app).
 * Connection errors are shown here instead of vanishing into hook state. Presentation only:
 * no signing, no transactions.
 */
export default function WalletPicker({ onClose }: { onClose: () => void }) {
  const { connect, connectors, isPending, reset } = useConnect({ mutation: { onSuccess: onClose } });
  const t = useTranslations("account.walletPicker");
  const [error, setError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  // window.ethereum can appear after the sheet opens (a wallet that injects late fires the EIP-1193
  // "ethereum#initialized" event; EIP-6963 wallets announce themselves). Re-read it on either signal.
  const hasInjectedProvider = useSyncExternalStore(
    subscribeToInjectedProvider,
    () => Boolean((window as { ethereum?: unknown }).ethereum),
    () => false,
  );
  const choices = walletChoices(connectors, { hasInjectedProvider });

  function pick(choice: WalletChoice) {
    const connector = connectors.find((c) => c.id === choice.id);
    if (!connector || isPending) return;
    setError(null);
    reset();
    setPendingId(connector.id);
    connect({ connector }, { onError: (e) => setError(connectErrorMessage(e)), onSettled: () => setPendingId(null) });
  }

  return (
    <Sheet title={t("title")} onClose={onClose}>
      <ul className="flex flex-col gap-2" aria-label={t("list")}>
        {choices.map((choice) => {
          const busy = isPending && pendingId === choice.id;
          return (
            <li key={choice.id}>
              <button
                type="button"
                onClick={() => pick(choice)}
                disabled={isPending}
                aria-busy={busy || undefined}
                className="w-full min-h-14 px-3.5 py-2.5 inline-flex items-center gap-3.5 rounded-xl bg-card border border-line-strong text-left hover:border-ink/40 hover:bg-paper transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <span className="h-9 w-9 shrink-0 inline-flex items-center justify-center rounded-lg bg-paper border border-line overflow-hidden" aria-hidden>
                  {choice.icon ? (
                    // the wallet's own EIP-6963 icon, a data: URI; nothing to optimize
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={choice.icon} alt="" width={24} height={24} className="h-6 w-6" />
                  ) : (
                    <Wallet size={18} strokeWidth={1.75} />
                  )}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold text-ink truncate">{choice.name}</span>
                  <span className="block text-xs text-muted truncate">{busy ? t("waiting") : choice.hint}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {!hasInjectedProvider && choices.every((c) => c.kind === "coinbase") ? <p className="mt-3 text-xs text-muted leading-relaxed">{t("noWallet")}</p> : null}
      {choices.length === 0 ? <p className="text-sm text-muted">{t("none")}</p> : null}
      <p role="alert" aria-live="assertive" className={`mt-3 text-[13px] leading-relaxed text-down-ink ${error ? "" : "sr-only"}`}>{error ?? ""}</p>
      <p className="mt-4 text-[11px] text-muted leading-relaxed">{t("footnote")}</p>
    </Sheet>
  );
}
