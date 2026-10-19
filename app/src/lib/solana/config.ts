import { PublicKey } from "@solana/web3.js";

export type SolanaCluster = "devnet" | "mainnet-beta";
export type SolanaConfig = {
  cluster: SolanaCluster;
  programId: string;
  rpcPath: string;
};
export type Deployment = {
  schema: number;
  cluster: string;
  genesisHash: string | null;
  programId: string | null;
  programData: string | null;
  sourceCommit: string | null;
  binarySha256: string | null;
  verifiedSlot: number | null;
  securityReview: string | null;
  economicReview: string | null;
  releaseApproved: boolean;
};

export function publicKey(value: unknown): string | null {
  if (typeof value !== "string" || value.length < 32 || value.length > 44)
    return null;
  try {
    const key = new PublicKey(value);
    return key.toBase58() === value && !key.equals(PublicKey.default)
      ? value
      : null;
  } catch {
    return null;
  }
}

/** A mainnet env flag cannot bypass the reviewed, committed release record. */
export function solanaConfig(
  env: Record<string, string | undefined>,
  release: Deployment,
): SolanaConfig | null {
  if (env.SOLANA_ENABLED !== "1") return null;
  if (env.SOLANA_CLUSTER === "devnet") {
    const programId = publicKey(env.SOLANA_DEVNET_PROGRAM_ID);
    return programId &&
      programId !== "Fg6PaFpoGXkYsidMpWxTWqkZPknxNpEMTZfkhHQjBcqr"
      ? { cluster: "devnet", programId, rpcPath: "/api/solana/rpc" }
      : null;
  }
  if (
    env.SOLANA_CLUSTER !== "mainnet-beta" ||
    !release.releaseApproved ||
    release.schema !== 1 ||
    release.cluster !== "mainnet-beta" ||
    release.genesisHash !== "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d"
  )
    return null;
  const programId = publicKey(release.programId);
  if (
    !programId ||
    programId === "Fg6PaFpoGXkYsidMpWxTWqkZPknxNpEMTZfkhHQjBcqr" ||
    !publicKey(release.programData) ||
    !/^[a-f0-9]{40}$/.test(release.sourceCommit ?? "") ||
    !/^[a-f0-9]{64}$/.test(release.binarySha256 ?? "") ||
    !Number.isSafeInteger(release.verifiedSlot) ||
    (release.verifiedSlot ?? 0) <= 0 ||
    !release.securityReview?.startsWith("https://") ||
    !release.economicReview?.startsWith("https://")
  )
    return null;
  return { cluster: "mainnet-beta", programId, rpcPath: "/api/solana/rpc" };
}

export function explorerUrl(
  cluster: SolanaCluster,
  kind: "address" | "tx",
  value: string,
): string {
  return `https://explorer.solana.com/${kind}/${encodeURIComponent(value)}${cluster === "devnet" ? "?cluster=devnet" : ""}`;
}

export function parseUnits(value: string, decimals: number): bigint {
  if (
    !Number.isInteger(decimals) ||
    decimals < 0 ||
    decimals > 9 ||
    value.length > 40 ||
    !/^\d+(?:\.\d+)?$/.test(value)
  )
    throw new Error(
      "Enter a positive decimal amount, without commas or exponents.",
    );
  const [whole, fraction = ""] = value.split(".");
  if (fraction.length > decimals)
    throw new Error(`Use at most ${decimals} decimal places.`);
  const amount =
    BigInt(whole) * 10n ** BigInt(decimals) +
    BigInt(fraction.padEnd(decimals, "0") || "0");
  if (amount <= 0n || amount > (1n << 64n) - 1n)
    throw new Error("Amount is outside the supported range.");
  return amount;
}

/** v3 RPC amounts must remain exact integers through review and display. */
export function requireLamports(value: unknown): bigint {
  if (typeof value !== "bigint" || value < 0n || value > (1n << 64n) - 1n)
    throw new Error("Could not read an exact SOL amount from Solana RPC. Try again.");
  return value;
}

/** Zero rent is not a valid estimate; do not present a failed read as a free account. */
export function requireRent(lamports: unknown): bigint {
  if (typeof lamports !== "bigint" || lamports <= 0n || lamports > (1n << 64n) - 1n)
    throw new Error("Could not read account rent from Solana RPC. Try again.");
  return lamports;
}

export function formatUnits(value: bigint, decimals: number): string {
  const negative = value < 0n;
  const digits = (negative ? -value : value)
    .toString()
    .padStart(decimals + 1, "0");
  const fraction = decimals ? digits.slice(-decimals).replace(/0+$/, "") : "";
  return `${negative ? "-" : ""}${decimals ? digits.slice(0, -decimals) : digits}${fraction ? `.${fraction}` : ""}`;
}
