import "server-only";
import { Connection } from "@solana/web3.js";
import deployment from "./deployment.json";
import { solanaConfig } from "./config";

export function configuredSolana() {
  return solanaConfig(process.env, deployment);
}

export function solanaRpcUrl(): string | null {
  const config = configuredSolana();
  if (!config) return null;
  const raw = process.env.SOLANA_RPC_URL?.trim();
  if (!raw)
    return config.cluster === "devnet" ? "https://api.devnet.solana.com" : null;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

export function solanaConnection(): Connection {
  const url = solanaRpcUrl();
  if (!url) throw new Error("Solana RPC is not configured.");
  return new Connection(url, {
    commitment: "confirmed",
    disableRetryOnRateLimit: true,
    fetch: (input, init) =>
      fetch(input, {
        ...init,
        signal: AbortSignal.timeout(15_000),
        cache: "no-store",
      }),
  });
}
