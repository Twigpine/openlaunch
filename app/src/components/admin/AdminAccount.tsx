"use client";

import { createContext, useContext, type ReactNode } from "react";
import { useHydratedAccount } from "@/lib/useHydratedAccount";

const AdminWallet = createContext<string | null>(null);

/** The signed-in admin's wallet, for the admin panels inside. */
export function AdminWalletProvider({ wallet, children }: { wallet: string; children: ReactNode }) {
  return <AdminWallet.Provider value={wallet.toLowerCase()}>{children}</AdminWallet.Provider>;
}

/**
 * The connected wallet as the admin panels see it: only when it is the signed-in admin's. Any other wallet reads as
 * none, so the panels' buttons stay off (the server refuses an action signed by a wallet other than the session's).
 */
export function useAdminAccount(): { address: `0x${string}` | undefined } {
  const { address } = useHydratedAccount();
  const admin = useContext(AdminWallet);
  return { address: address && admin !== null && address.toLowerCase() === admin ? address : undefined };
}
