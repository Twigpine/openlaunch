"use client";

import { useSyncExternalStore } from "react";
import { useAccount } from "wagmi";

type Account = ReturnType<typeof useAccount>;
/** The account fields the wallet-aware views read. */
export type HydratedAccount = Pick<Account, "address" | "isConnected" | "chainId" | "connector">;

const SIGNED_OUT: HydratedAccount = { address: undefined, isConnected: false, chainId: undefined, connector: undefined };
const noSubscribe = () => () => {};

/**
 * wagmi's account, read so the first browser render matches the server's HTML. The server never knows a wallet, so it
 * renders every wallet-aware view signed out. A wallet that reconnects before part of the page has hydrated (anything
 * inside a Suspense boundary, such as a route with a loading screen) would otherwise hydrate that part signed in, and
 * React throws the server HTML away. Until the calling component has hydrated this reads as no wallet; right after,
 * it reads wagmi's account, which is the same moment wagmi's own reconnect lands for most visitors.
 */
export function useHydratedAccount(): HydratedAccount {
  const { address, isConnected, chainId, connector } = useAccount();
  const hydrated = useSyncExternalStore(noSubscribe, () => true, () => false);
  return hydrated ? { address, isConnected, chainId, connector } : SIGNED_OUT;
}
