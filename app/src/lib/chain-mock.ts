// Mock @/lib/chain for tests. publicClient returns either a fake client whose
// verifyMessage behavior is driven by the global mock state from db-mock.ts,
// or, when transportOutage is set, a real viem client with an unreachable
// transport. The real client lets the RPC-outage path run through viem itself
// (verifyMessage returns false on an offline transport; getChainId throws)
// instead of a hand-rolled stub.
import { createPublicClient, fallback, http } from "viem";
import { base } from "viem/chains";
import { RPC_ENV_NAME, type ChainKey } from "./chainPublic.ts";
import { getMock } from "./db-mock.ts";

export * from "./chainPublic.ts";

// Same per-chain env lookup as the real module (one shared name table), so a test can point one chain at a fake keyed upstream.
export function rpcUrl(key: ChainKey): string | undefined {
  return process.env[RPC_ENV_NAME[key]]?.trim() || undefined;
}

export function b20RpcUrl(): string {
  return "http://mock";
}

// The B20-capable node: its multicall answers totalSupply() from the mock state (b20Supply) and counts the reads; with no state it throws, like a node that is down.
export function b20Client(): any {
  return {
    multicall: async ({ contracts }: { contracts: { address: string }[] }) => {
      const m = getMock();
      m.b20SupplyReads++;
      const supply = m.b20Supply;
      if (!supply) throw new Error("mock RPC error");
      return contracts.map((c) => {
        const v = supply[c.address];
        return v === undefined || v === "fail" ? { status: "failure", error: new Error("mock call failed") } : { status: "success", result: v };
      });
    },
  };
}

// A port nothing listens on: connection refused is instant and deterministic,
// so the outage test stays fast with no real network dependency.
const DEAD_RPC = "http://127.0.0.1:1";

export function publicClient(_key: ChainKey): any {
  const m = getMock();
  if (m.transportOutage) {
    return createPublicClient({
      chain: base,
      transport: fallback(
        [http(DEAD_RPC, { retryCount: 0 }), http(DEAD_RPC, { retryCount: 0 })],
        { rank: false },
      ),
    });
  }
  return {
    verifyMessage: async (_args: any): Promise<boolean> => {
      const m = getMock();
      if (m.verifyShouldThrow) throw new Error("mock RPC error");
      return m.verifyResult;
    },
    // Liveness probe used by applySignedEdit to distinguish an RPC outage
    // (throws) from a genuinely invalid signature when verifyMessage is false.
    getChainId: async (): Promise<number> => 8453,
  };
}
