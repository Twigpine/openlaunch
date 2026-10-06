/**
 * Universal Router encoding for a single-hop Uniswap v4 swap (pure; unit-tested).
 *
 *   commands = [V4_SWAP]
 *   inputs[0] = abi.encode(actions, params[])
 *     actions  = SWAP_EXACT_IN_SINGLE ‖ SETTLE_ALL ‖ TAKE_ALL
 *     params[0]= ExactInputSingleParams{poolKey, zeroForOne, amountIn, amountOutMinimum, hookData}
 *     params[1]= (currencyIn,  amountIn)      settle everything we owe
 *     params[2]= (currencyOut, minOut)        take everything we're owed
 *
 * Buy  = ETH → token: zeroForOne (ETH is currency0), send `amountIn` as msg.value.
 * Sell = token → ETH: !zeroForOne, token must be Permit2-approved to the router.
 */
import { encodeAbiParameters, encodePacked, type Address, type Hex } from "viem";

/** PoolKey tuple layout (shared with abi.ts; defined here so this file stays import-free for node --test). */
export const POOL_KEY_COMPONENTS = [
  { name: "currency0", type: "address" },
  { name: "currency1", type: "address" },
  { name: "fee", type: "uint24" },
  { name: "tickSpacing", type: "int24" },
  { name: "hooks", type: "address" },
] as const;

export const UR_COMMAND_V4_SWAP = 0x10;
export const UR_COMMAND_WRAP_ETH = 0x0b;
export const ACTION_SWAP_EXACT_IN_SINGLE = 0x06;
export const ACTION_SWAP_EXACT_IN = 0x07;
export const ACTION_SETTLE = 0x0b;
export const ACTION_SETTLE_ALL = 0x0c;
export const ACTION_TAKE_ALL = 0x0f;
/** Universal Router: "the router itself" as a recipient (Constants.ADDRESS_THIS). */
export const ADDRESS_THIS = "0x0000000000000000000000000000000000000002";
/** V4 router: settle the whole open delta (ActionConstants.OPEN_DELTA). */
export const OPEN_DELTA = 0n;

/** PathKey tuple layout (one hop of a multi-hop v4 swap: the currency it ends in and that pool's fee, spacing, hooks). */
export const PATH_KEY_COMPONENTS = [
  { name: "intermediateCurrency", type: "address" },
  { name: "fee", type: "uint24" },
  { name: "tickSpacing", type: "int24" },
  { name: "hooks", type: "address" },
  { name: "hookData", type: "bytes" },
] as const;

export type PoolKey = { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address };

/** Which ExactInputSingleParams layout the chain's deployed Universal Router decodes. */
export type SwapLayout = "v1" | "v2";

export function encodeV4ExactInSingle(args: { key: PoolKey; zeroForOne: boolean; amountIn: bigint; minOut: bigint; layout?: SwapLayout }): { commands: Hex; inputs: Hex[] } {
  const { key, zeroForOne, amountIn, minOut, layout = "v1" } = args;
  const actions = encodePacked(["uint8", "uint8", "uint8"], [ACTION_SWAP_EXACT_IN_SINGLE, ACTION_SETTLE_ALL, ACTION_TAKE_ALL]);
  const swapParams =
    layout === "v2"
      ? encodeAbiParameters(
          [
            {
              type: "tuple",
              components: [
                { name: "poolKey", type: "tuple", components: POOL_KEY_COMPONENTS },
                { name: "zeroForOne", type: "bool" },
                { name: "amountIn", type: "uint128" },
                { name: "amountOutMinimum", type: "uint128" },
                { name: "minHopPriceX36", type: "uint256" },
                { name: "hookData", type: "bytes" },
              ],
            },
          ],
          [{ poolKey: key, zeroForOne, amountIn, amountOutMinimum: minOut, minHopPriceX36: 0n, hookData: "0x" }],
        )
      : encodeAbiParameters(
          [
            {
              type: "tuple",
              components: [
                { name: "poolKey", type: "tuple", components: POOL_KEY_COMPONENTS },
                { name: "zeroForOne", type: "bool" },
                { name: "amountIn", type: "uint128" },
                { name: "amountOutMinimum", type: "uint128" },
                { name: "hookData", type: "bytes" },
              ],
            },
          ],
          [{ poolKey: key, zeroForOne, amountIn, amountOutMinimum: minOut, hookData: "0x" }],
        );
  const currencyIn = zeroForOne ? key.currency0 : key.currency1;
  const currencyOut = zeroForOne ? key.currency1 : key.currency0;
  const settle = encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [currencyIn, amountIn]);
  const take = encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [currencyOut, minOut]);
  const input = encodeAbiParameters([{ type: "bytes" }, { type: "bytes[]" }], [actions, [swapParams, settle, take]]);
  return { commands: encodePacked(["uint8"], [UR_COMMAND_V4_SWAP]), inputs: [input] };
}
