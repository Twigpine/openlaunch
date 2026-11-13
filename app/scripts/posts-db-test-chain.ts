// The integration tests use real signatures, replacing only the external RPC.
import type { Abi, Address, Hex } from "viem";
import type { ChainKey } from "../src/lib/chainPublic.ts";

type Client = {
  readContract: (args: { address: Address; abi: Abi; functionName: string; args: readonly unknown[] }) => Promise<bigint>;
  verifyMessage: (args: { address: Address; message: string; signature: Hex }) => Promise<boolean>;
  getChainId: () => Promise<number>;
};
let client: Client | null = null;
export function setPostsTestClient(value: Client) { client = value; }
export function publicClient(_chain: ChainKey) {
  if (!client) throw new Error("posts integration-test client not configured");
  return client;
}
