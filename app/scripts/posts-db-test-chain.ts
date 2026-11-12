// The integration tests use real signatures, replacing only the external RPC.
import type { Address, Hex } from "viem";

type Client = {
  readContract: () => Promise<bigint>;
  verifyMessage: (args: { address: Address; message: string; signature: Hex }) => Promise<boolean>;
};
let client: Client | null = null;
export function setPostsTestClient(value: Client) { client = value; }
export function publicClient() {
  if (!client) throw new Error("posts integration-test client not configured");
  return client;
}
