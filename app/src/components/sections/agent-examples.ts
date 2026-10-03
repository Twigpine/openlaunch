import { CHAIN_KEYS, CHAIN_LABELS, CHAINS, SITE_URL } from "@/lib/chainPublic";
import { launchpad, NATIVE } from "@/lib/launchpad/config";
import { startTickForFdv } from "@/lib/launchpad/math";

export type AgentExample = { chain: string; label: string; title: string; code: string };

/** Reference text only. No key, wallet connection, or transaction is created here. */
export function agentExamples(kind: "launch" | "read" | "sync"): AgentExample[] {
  return CHAIN_KEYS.map((chain) => {
    const config = launchpad(chain);
    const label = CHAIN_LABELS[chain];
    const common = { chain, label };
    if (kind === "read") return { ...common, title: `Read ${label} launches`, code: `GET ${SITE_URL}/api/launch/list?chain=${chain}&sort=live&window=24h&limit=50\nGET ${SITE_URL}/api/launch/feed  # all chains\nGET ${SITE_URL}/api/launch/meta/<token>?chain=${chain}\nGET ${SITE_URL}/llms.txt` };
    if (kind === "sync") return { ...common, title: `Sync a ${label} transaction`, code: `POST ${SITE_URL}/api/launch/sync?chain=${chain}&tx=<confirmed-transaction-hash>` };
    // Preserve the ETH references where offered. Arc's factory rejects address(0):
    // its example must use the configured 6-decimal ERC-20 USDC quote instead.
    const quote = config.quotes.find((item) => item.address === NATIVE) ?? config.quotes[0];
    const fdv = quote.key === "eth" ? 10 : 10_000;
    return { ...common, title: `Launch on ${label}`, code: JSON.stringify({
      chainId: CHAINS[chain].id,
      factory: config.factory ?? "<factory-not-configured>",
      function: "launch((string,string,string,address,uint256,int24,uint24,bytes32,(address,uint16)[]))",
      params: {
        name: "My Token", symbol: "MYT", metadataURI: "", quote: quote.address,
        supply: "0", startTick: startTickForFdv(fdv, quote.decimals), lpFee: 10000,
        salt: "<unique-32-byte-salt>", recipients: [{ payout: "<beneficiary-wallet-address>", bps: 10000 }],
      },
    }, null, 2) };
  });
}
