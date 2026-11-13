import type { Config } from "wagmi";
import { getAccount, getWalletClient, switchChain } from "wagmi/actions";

/**
 * The connected wallet's client on `chainId`, asking the wallet to switch first when it sits on another chain:
 * getWalletClient refuses a chain the connector is not on (ConnectorChainMismatchError), and a smart wallet's signature
 * is checked on the chain it was made for. A refused switch throws, as any refused wallet request does.
 */
export async function walletOnChain(config: Config, chainId: number) {
  if (getAccount(config).chainId !== chainId) await switchChain(config, { chainId });
  return getWalletClient(config, { chainId });
}
