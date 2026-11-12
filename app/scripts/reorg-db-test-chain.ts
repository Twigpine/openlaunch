// Test-only RPC adapter: all reads use the synthetic viem transport.
export * from "../src/lib/chainPublic";
import type { ChainModel } from "./reorg-db-test-model";
let active: ReturnType<ChainModel["client"]> | null = null;
export function setClient(value: ReturnType<ChainModel["client"]>) { active = value; }
export function publicClient() {
    if (!active)
        throw new Error("reorg test chain not configured");
    return active;
}
export function b20Client() { throw new Error("External B20 RPC disabled in reorg tests"); }
