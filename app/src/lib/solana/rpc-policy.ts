import { Transaction } from "@solana/web3.js";
import { Buffer } from "buffer";
import { publicKey } from "./config";
import { verifyTransactionSignatures } from "../../../packages/solana-sdk/src/transactions";

const READS = new Set([
  "getAccountInfo",
  "getMultipleAccounts",
  "getBalance",
  "getLatestBlockhash",
  "getBlockHeight",
  "getEpochInfo",
  "getSlot",
  "getGenesisHash",
  "getFeeForMessage",
  "getMinimumBalanceForRentExemption",
  "getSignatureStatuses",
  "getProgramAccounts",
]);
export type RpcRequest = {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params: unknown[];
};

/** JSON numbers are already parsed here. Never relay a rounded slot, size or other RPC integer. */
function exactRequestNumbers(values: readonly unknown[]): boolean {
  const pending = [...values];
  while (pending.length) {
    const value = pending.pop();
    if (typeof value === "number" && (!Number.isSafeInteger(value) || value < 0))
      return false;
    if (typeof value === "bigint") return false; // Not a JSON request value.
    if (Array.isArray(value)) pending.push(...value);
    else if (value && typeof value === "object") pending.push(...Object.values(value));
  }
  return true;
}

/** The proxy is not a general RPC relay. No airdrops, subscriptions, or arbitrary broadcasts. */
export async function allowedSolanaRpc(
  value: unknown,
  programId: string,
): Promise<RpcRequest | null> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const r = value as Partial<RpcRequest>;
  if (
    r.jsonrpc !== "2.0" ||
    !(typeof r.id === "number" || typeof r.id === "string") ||
    (typeof r.id === "number" && !Number.isSafeInteger(r.id)) ||
    typeof r.method !== "string" ||
    !Array.isArray(r.params) ||
    r.params.length > 4 ||
    !exactRequestNumbers(r.params)
  )
    return null;
  if (r.method === "getProgramAccounts" && r.params[0] !== programId)
    return null;
  if (
    ["getAccountInfo", "getBalance"].includes(r.method) &&
    !publicKey(r.params[0])
  )
    return null;
  if (
    r.method === "getFeeForMessage" &&
    (typeof r.params[0] !== "string" ||
      r.params[0].length > 1644 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(r.params[0]))
  )
    return null;
  if (
    r.method === "getMultipleAccounts" &&
    (!Array.isArray(r.params[0]) ||
      r.params[0].length > 16 ||
      r.params[0].some((key) => !publicKey(key)))
  )
    return null;
  if (
    r.method === "getSignatureStatuses" &&
    (!Array.isArray(r.params[0]) ||
      r.params[0].length > 16 ||
      r.params[0].some(
        (s) =>
          typeof s !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(s),
      ))
  )
    return null;
  if (
    r.method === "getMinimumBalanceForRentExemption" &&
    (!Number.isSafeInteger(r.params[0]) ||
      Number(r.params[0]) < 0 ||
      Number(r.params[0]) > 4096)
  )
    return null;
  if (READS.has(r.method)) return r as RpcRequest;
  if (r.method !== "sendTransaction" && r.method !== "simulateTransaction")
    return null;
  const encoded = r.params[0];
  const options = r.params[1] as
    | { encoding?: string; skipPreflight?: boolean; sigVerify?: boolean }
    | undefined;
  if (
    typeof encoded !== "string" ||
    encoded.length > 1644 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) ||
    options?.encoding !== "base64"
  )
    return null;
  try {
    const bytes = Buffer.from(encoded, "base64");
    if (bytes.length > 1232 || bytes.toString("base64") !== encoded)
      return null;
    const tx = Transaction.from(bytes);
    // Verify precisely the wire bytes forwarded upstream, not a normalized message that ignores trailing data.
    const canonical = await tx.serialize({ requireAllSignatures: false, verifySignatures: false });
    if (!Buffer.from(canonical).equals(bytes)) return null;
    if (!tx.instructions.some((ix) => ix.programId.toBase58() === programId))
      return null;
    const approved = new Set([
      programId,
      "11111111111111111111111111111111",
      "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
      "ComputeBudget111111111111111111111111111111",
    ]);
    if (tx.instructions.some((ix) => !approved.has(ix.programId.toBase58())))
      return null;
    if (r.method === "simulateTransaction") return r as RpcRequest;
    // v3 verifies signatures asynchronously. Never treat the Promise itself as approval.
    return options.skipPreflight !== true && (await verifyTransactionSignatures(tx))
      ? (r as RpcRequest)
      : null;
  } catch {
    return null;
  }
}
