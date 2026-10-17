"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getWallets } from "@wallet-standard/app";
import type { Wallet, WalletAccount } from "@wallet-standard/base";
import type {
  StandardConnectFeature,
  StandardDisconnectFeature,
  StandardEventsFeature,
} from "@wallet-standard/features";
import type { SolanaSignTransactionFeature } from "@solana/wallet-standard-features";
import { PublicKey } from "@solana/web3.js";
import type { SolanaCluster } from "./config";

type CompatibleWallet = Wallet & {
  features: StandardConnectFeature &
    StandardEventsFeature &
    SolanaSignTransactionFeature &
    Partial<StandardDisconnectFeature>;
};
export type WalletSession = {
  wallet: CompatibleWallet;
  account: WalletAccount;
  chain: "solana:devnet" | "solana:mainnet";
  isCurrent: () => boolean;
};

function compatible(wallet: Wallet, chain: string): wallet is CompatibleWallet {
  try {
    const f = wallet.features as Partial<CompatibleWallet["features"]>;
    return (
      Array.isArray(wallet.accounts) &&
      wallet.chains.includes(chain as `${string}:${string}`) &&
      typeof f["standard:connect"]?.connect === "function" &&
      typeof f["standard:events"]?.on === "function" &&
      typeof f["solana:signTransaction"]?.signTransaction === "function" &&
      f["solana:signTransaction"].supportedTransactionVersions.includes(
        "legacy",
      )
    );
  } catch {
    return false;
  }
}

export function validWalletAccount(
  account: WalletAccount,
  chain: string,
): boolean {
  try {
    return (
      account.chains.includes(chain as `${string}:${string}`) &&
      account.features.includes("solana:signTransaction") &&
      new PublicKey(account.publicKey).toBase58() === account.address
    );
  } catch {
    return false;
  }
}

/** Independent from wagmi; an EVM wallet/address can never sign a Solana action. */
export function useSolanaWallet(cluster: SolanaCluster) {
  const chain = cluster === "devnet" ? "solana:devnet" : "solana:mainnet";
  const [wallets, setWallets] = useState<CompatibleWallet[]>([]);
  const [session, setSession] = useState<WalletSession | null>(null);
  const current = useRef<WalletSession | null>(null);
  const generation = useRef(0);
  const stopEvents = useRef<(() => void) | null>(null);
  const clearConnection = useCallback(() => {
    generation.current++;
    current.current = null;
    const stop = stopEvents.current;
    stopEvents.current = null;
    stop?.();
  }, []);
  const invalidate = useCallback(() => {
    clearConnection();
    setSession(null);
  }, [clearConnection]);
  useEffect(() => {
    const registry = getWallets();
    const update = () => {
      const available = registry
        .get()
        .filter((w): w is CompatibleWallet => compatible(w, chain));
      if (current.current && !available.includes(current.current.wallet))
        invalidate();
      setWallets(available);
    };
    const timer = setTimeout(update, 0);
    const off = [
      registry.on("register", update),
      registry.on("unregister", update),
    ];
    return () => {
      clearTimeout(timer);
      off.forEach((stop) => stop());
      clearConnection();
    };
  }, [chain, invalidate, clearConnection]);
  const connect = useCallback(
    async (wallet: CompatibleWallet) => {
      invalidate();
      if (!compatible(wallet, chain))
        throw new Error(
          "This wallet no longer supports the selected Solana network.",
        );
      const id = ++generation.current;
      const { accounts } = await wallet.features["standard:connect"].connect();
      if (id !== generation.current)
        throw new Error("Wallet changed. Connect again.");
      const account = accounts.find(
        (a) =>
          validWalletAccount(a, chain) &&
          wallet.accounts.some(
            (live) =>
              live.address === a.address && validWalletAccount(live, chain),
          ),
      );
      if (!account)
        throw new Error(
          `This wallet has no supported ${cluster} signing account.`,
        );
      const next: WalletSession = {
        wallet,
        account,
        chain,
        isCurrent: () =>
          id === generation.current &&
          current.current === next &&
          compatible(wallet, chain) &&
          wallet.accounts.some(
            (live) =>
              live.address === account.address &&
              validWalletAccount(live, chain),
          ),
      };
      // Subscribe immediately, before publishing the session. A passive React
      // effect leaves a gap where account changes can be missed before signing.
      stopEvents.current = wallet.features["standard:events"].on(
        "change",
        invalidate,
      );
      current.current = next;
      setSession(next);
    },
    [chain, cluster, invalidate],
  );
  const disconnect = useCallback(async () => {
    const old = current.current;
    invalidate();
    await old?.wallet.features["standard:disconnect"]?.disconnect();
  }, [invalidate]);
  const sign = useCallback(
    async (transaction: Uint8Array) => {
      const active = current.current;
      const id = generation.current;
      if (!active || active.chain !== chain || !active.isCurrent())
        throw new Error("Connect your Solana wallet first.");
      const result = await active.wallet.features[
        "solana:signTransaction"
      ].signTransaction({ account: active.account, chain, transaction });
      if (
        id !== generation.current ||
        current.current !== active ||
        !active.isCurrent()
      )
        throw new Error("Wallet changed while signing. Nothing was broadcast.");
      if (result.length !== 1 || !result[0]?.signedTransaction)
        throw new Error("Wallet did not return a signed transaction.");
      return result[0].signedTransaction;
    },
    [chain],
  );
  return {
    wallets,
    session: session?.chain === chain ? session : null,
    connect,
    disconnect,
    sign,
  };
}
