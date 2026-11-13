// Opt-in integration-test adapter: real EOA signature checks, synthetic prices, no network transport.
import { verifyMessage } from "viem";

export function publicClient() {
  return {
    verifyMessage,
    readContract: async ({ functionName }: { functionName: string }) => {
      if (functionName === "latestRoundData") return [1n, 2000_00000000n, 0n, BigInt(Math.floor(Date.now() / 1000)), 1n];
      if (functionName === "getSlot0") return [10_000n * 2n ** 96n, 0n, 0n, 0n];
      if (functionName === "observe") return [[0n, 184216n * 1800n], []];
      throw new Error(`unexpected synthetic contract read: ${functionName}`);
    },
  };
}
export function b20Client(): never { throw new Error("external RPC disabled in pair tests"); }
