import { Transaction } from "@solana/web3.js";
import { Buffer } from "buffer";
import { publicKey } from "./config";

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

/** The proxy is not a general RPC relay. No airdrops, subscriptions, or arbitrary broadcasts. */
export function allowedSolanaRpc(
  value: unknown,
  programId: string,
): value is RpcRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const r = value as Partial<RpcRequest>;
  if (
    r.jsonrpc !== "2.0" ||
    !(typeof r.id === "number" || typeof r.id === "string") ||
    typeof r.method !== "string" ||
    !Array.isArray(r.params) ||
    r.params.length > 4
  )
    return false;
  if (r.method === "getProgramAccounts" && r.params[0] !== programId)
    return false;
  if (
    ["getAccountInfo", "getBalance"].includes(r.method) &&
    !publicKey(r.params[0])
  )
    return false;
  if (
    r.method === "getFeeForMessage" &&
    (typeof r.params[0] !== "string" ||
      r.params[0].length > 1644 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(r.params[0]))
  )
    return false;
  if (
    r.method === "getMultipleAccounts" &&
    (!Array.isArray(r.params[0]) ||
      r.params[0].length > 16 ||
      r.params[0].some((key) => !publicKey(key)))
  )
    return false;
  if (
    r.method === "getSignatureStatuses" &&
    (!Array.isArray(r.params[0]) ||
      r.params[0].length > 16 ||
      r.params[0].some(
        (s) =>
          typeof s !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(s),
      ))
  )
    return false;
  if (
    r.method === "getMinimumBalanceForRentExemption" &&
    (!Number.isSafeInteger(r.params[0]) ||
      Number(r.params[0]) < 0 ||
      Number(r.params[0]) > 4096)
  )
    return false;
  if (READS.has(r.method)) return true;
  if (r.method !== "sendTransaction" && r.method !== "simulateTransaction")
    return false;
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
    return false;
  try {
    const bytes = Buffer.from(encoded, "base64");
    if (bytes.length > 1232 || bytes.toString("base64") !== encoded)
      return false;
    const tx = Transaction.from(bytes);
    if (!tx.instructions.some((ix) => ix.programId.toBase58() === programId))
      return false;
    const approved = new Set([
      programId,
      "11111111111111111111111111111111",
      "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
      "ComputeBudget111111111111111111111111111111",
    ]);
    if (tx.instructions.some((ix) => !approved.has(ix.programId.toBase58())))
      return false;
    return (
      r.method === "simulateTransaction" ||
      (options.skipPreflight !== true && tx.verifySignatures())
    );
  } catch {
    return false;
  }
}
