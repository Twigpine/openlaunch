"use client";

import { useSyncExternalStore } from "react";
import { useAccount, useDisconnect, useSwitchChain } from "wagmi";
import { useTranslations } from "use-intl";
import { CHAINS } from "@/lib/chainPublic";
import ConnectWallet from "./ConnectWallet";
import WalletMenu from "./WalletMenu";

/**
 * Wallet chip. `block` renders a full-width row for the mobile menu sheet;
 * default is the compact inline chip for the desktop header.
 */
export default function ConnectButton({ block = false, onNavigate }: { block?: boolean; onNavigate?: () => void }) {
  const { address, isConnected, chainId, connector: activeConnector } = useAccount();
  const { disconnectAsync, isPending: disconnecting } = useDisconnect();
  const { switchChainAsync, isPending: switching } = useSwitchChain();
  const t = useTranslations("common");
  // Wallet state only exists on the client; render a neutral pill during SSR/hydration.
  const mounted = useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );

  // pill in the header strip, rounded-xl as a row in the mobile menu list
  const base = `${block ? "w-full min-h-12 px-4 text-sm rounded-xl" : "h-9 px-3.5 text-[13px] rounded-full"} inline-flex items-center justify-center gap-2 font-medium transition-colors disabled:opacity-50 whitespace-nowrap`;

  if (!mounted) return <div className={`${base} border border-line text-faint`}>{t("wallet")}</div>;

  if (!isConnected || !address) {
    // a quiet hairline utility (the ThemeToggle recipe): only the launch CTA is loud
    return <ConnectWallet className={`${base} border border-line text-body hover:text-ink hover:border-line-strong`}>{t("connectWallet")}</ConnectWallet>;
  }
  return (
    <WalletMenu address={address} chainId={chainId} connectorName={activeConnector?.name}
      block={block} switching={switching} disconnecting={disconnecting} onNavigate={onNavigate}
      onSwitchChain={(chain) => switchChainAsync({ chainId: CHAINS[chain].id })}
      onDisconnect={() => disconnectAsync()} />
  );
}
