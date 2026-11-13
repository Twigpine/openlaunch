import type { Abi, AbiEvent } from "viem";
import { LAUNCH_FACTORY_ABI, LAUNCH_LOCKER_ABI, LAUNCHED_EVENT, LOCKER_EVENTS } from "./abi";
import { QUOTE_FACTORY_ABI, QUOTE_VAULT_ABI, QUOTE_LAUNCHED_EVENT, QUOTE_VAULT_EVENTS, QUOTE_SWAP_EVENT } from "./quote-abi";
import type { SuiteId } from "./suites";

/**
 * What differs between launch suites on-chain, in one place: which contracts to speak to and how the pool's
 * own fee relates to the creator's rate. Callers pick a kind by suite id instead of branching on it.
 */
export type SuiteKind = {
  factoryAbi: Abi;
  /** The factory's launch event (its name differs per suite). */
  launchedEvent: AbiEvent;
  /** The contract that collects and pays fees: the locker for lp-v1, the vault for quote-v2. */
  feeAbi: Abi;
  feeEvents: readonly AbiEvent[];
  /** Hook event that accompanies every core Swap and carries the trader's amounts; null when the pool has no hook. */
  hookSwapEvent: AbiEvent | null;
  /** Name of the creator's rate in the factory's LaunchParams tuple. */
  rateField: "lpFee" | "creatorFeePips";
  /** The pool key's own LP fee for a launch with this creator rate. */
  poolFeePips: (ratePips: number) => number;
};

export const SUITE_KINDS: Record<SuiteId, SuiteKind> = {
  "lp-v1": {
    factoryAbi: LAUNCH_FACTORY_ABI,
    launchedEvent: LAUNCHED_EVENT,
    feeAbi: LAUNCH_LOCKER_ABI,
    feeEvents: LOCKER_EVENTS,
    hookSwapEvent: null,
    rateField: "lpFee",
    poolFeePips: (ratePips) => ratePips,
  },
  "quote-v2": {
    factoryAbi: QUOTE_FACTORY_ABI,
    launchedEvent: QUOTE_LAUNCHED_EVENT,
    feeAbi: QUOTE_VAULT_ABI,
    feeEvents: QUOTE_VAULT_EVENTS,
    hookSwapEvent: QUOTE_SWAP_EVENT,
    rateField: "creatorFeePips",
    poolFeePips: () => 0,
  },
};
