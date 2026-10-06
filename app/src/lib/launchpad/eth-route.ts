/**
 * "Buy with ETH" for launches paired with TWIG or GITLAWB on Base (pure; node --test loads it directly).
 *
 * A launch quoted in TWIG or GITLAWB can only be bought with that token through its own pool. Most buyers hold ETH, so
 * this routes ETH to the token in ONE Universal Router transaction, through the deep markets that already exist:
 *
 *   GITLAWB pair:  ETH ─wrap→ WETH ─(WETH/GITLAWB v4 pool, the deep one)→ GITLAWB ─(the launch's pool)→ token
 *   TWIG pair:     ETH ─wrap→ WETH ─(WETH/GITLAWB v4 pool)→ GITLAWB ─(TWIG wrap hook, 1:1)→ TWIG ─(the launch's pool)→ token
 *
 *   commands = WRAP_ETH ‖ V4_SWAP
 *   WRAP_ETH  (recipient = the router itself, amountMin = amountIn): the router now holds the WETH
 *   V4_SWAP   actions = SWAP_EXACT_IN ‖ SETTLE ‖ TAKE_ALL
 *     SWAP_EXACT_IN  ExactInputParams{currencyIn = WETH, path, [minHopPriceX36 on v2 routers], amountIn, amountOutMinimum}
 *     SETTLE         (WETH, OPEN_DELTA, payerIsUser = false)  pay the pool manager from the router's own WETH
 *     TAKE_ALL       (token, minOut)                          the buyer gets every token, or the call reverts
 *
 * No approvals: the ETH goes in as msg.value and never touches Permit2. The router checks the minimum, so a moved
 * price fails the whole transaction rather than filling badly. Quotes come from the V4 Quoter's quoteExactInput
 * over the same path.
 */
import { encodeAbiParameters, encodePacked, type Address, type Hex } from "viem";
import type { ChainKey } from "../chainKeys.ts";
import { GITLAWB_ADDRESSES, GITLAWB_POOL_KEY } from "./gitlawb.ts";
import { TWIG_ADDRESSES, TWIG_HOOK_POOL } from "./twig.ts";
import { ACTION_TAKE_ALL, POOL_KEY_COMPONENTS, UR_COMMAND_V4_SWAP, type PoolKey, type SwapLayout } from "./swap.ts";

export const WETH_BASE = "0x4200000000000000000000000000000000000006";
export const UR_COMMAND_WRAP_ETH = 0x0b;
export const ACTION_SWAP_EXACT_IN = 0x07;
export const ACTION_SETTLE = 0x0b;
/** Universal Router: "the router itself" as a recipient (Constants.ADDRESS_THIS). */
export const ADDRESS_THIS = "0x0000000000000000000000000000000000000002";
/** V4 router: settle the whole open delta (ActionConstants.OPEN_DELTA). */
export const OPEN_DELTA = 0n;

export type PathKey = { intermediateCurrency: Address; fee: number; tickSpacing: number; hooks: Address; hookData: Hex };
export type EthRoute = { currencyIn: Address; path: PathKey[]; via: string[] };

const PATH_KEY_COMPONENTS = [
  { name: "intermediateCurrency", type: "address" },
  { name: "fee", type: "uint24" },
  { name: "tickSpacing", type: "int24" },
  { name: "hooks", type: "address" },
  { name: "hookData", type: "bytes" },
] as const;

/** The quote keys that get a "Buy with ETH" route, by chain. Base only: GITLAWB's deep market is the Base v4 pool. */
export const ETH_ROUTE_CHAINS: Partial<Record<ChainKey, true>> = { base: true };

/**
 * The ETH route to `token` for a launch whose pool is `pool` and whose quote is `quoteAddress`, or null when the launch
 * is not paired with TWIG or GITLAWB on a chain that has the route. The launch's own hop is read from its pool key, so
 * the route can only ever end in that pool.
 */
export function ethRouteFor(chain: ChainKey, quoteAddress: string, token: Address, pool: PoolKey): EthRoute | null {
  if (!ETH_ROUTE_CHAINS[chain]) return null;
  const q = quoteAddress.toLowerCase();
  const gitlawb = GITLAWB_ADDRESSES[chain];
  const twig = TWIG_ADDRESSES[chain];
  if (!gitlawb) return null;
  // the launch's own pool must be quote/token with the quote as currency0 (openlaunch pools always are)
  if (pool.currency0.toLowerCase() !== q || pool.currency1.toLowerCase() !== token.toLowerCase()) return null;
  const toGitlawb: PathKey = { intermediateCurrency: gitlawb as Address, fee: GITLAWB_POOL_KEY.fee, tickSpacing: GITLAWB_POOL_KEY.tickSpacing, hooks: GITLAWB_POOL_KEY.hooks, hookData: "0x" };
  const toToken: PathKey = { intermediateCurrency: token, fee: pool.fee, tickSpacing: pool.tickSpacing, hooks: pool.hooks, hookData: "0x" };
  if (q === gitlawb) return { currencyIn: WETH_BASE, path: [toGitlawb, toToken], via: ["ETH", "GITLAWB"] };
  if (twig && q === twig) {
    const toTwig: PathKey = { intermediateCurrency: twig as Address, fee: TWIG_HOOK_POOL.fee, tickSpacing: TWIG_HOOK_POOL.tickSpacing, hooks: TWIG_HOOK_POOL.hooks as Address, hookData: "0x" };
    return { currencyIn: WETH_BASE, path: [toGitlawb, toTwig, toToken], via: ["ETH", "GITLAWB", "TWIG"] };
  }
  return null;
}

/** The Universal Router call for an ETH-route buy: send `amountIn` wei as msg.value. */
export function encodeEthRouteBuy(args: { route: EthRoute; token: Address; amountIn: bigint; minOut: bigint; layout?: SwapLayout }): { commands: Hex; inputs: Hex[]; value: bigint } {
  const { route, token, amountIn, minOut, layout = "v1" } = args;
  if (amountIn <= 0n) throw new Error("amountIn must be positive");
  const wrap = encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [ADDRESS_THIS, amountIn]);
  const actions = encodePacked(["uint8", "uint8", "uint8"], [ACTION_SWAP_EXACT_IN, ACTION_SETTLE, ACTION_TAKE_ALL]);
  const swapParams =
    layout === "v2"
      ? encodeAbiParameters(
          [
            {
              type: "tuple",
              components: [
                { name: "currencyIn", type: "address" },
                { name: "path", type: "tuple[]", components: PATH_KEY_COMPONENTS },
                { name: "minHopPriceX36", type: "uint256[]" },
                { name: "amountIn", type: "uint128" },
                { name: "amountOutMinimum", type: "uint128" },
              ],
            },
          ],
          [{ currencyIn: route.currencyIn, path: route.path, minHopPriceX36: route.path.map(() => 0n), amountIn, amountOutMinimum: minOut }],
        )
      : encodeAbiParameters(
          [
            {
              type: "tuple",
              components: [
                { name: "currencyIn", type: "address" },
                { name: "path", type: "tuple[]", components: PATH_KEY_COMPONENTS },
                { name: "amountIn", type: "uint128" },
                { name: "amountOutMinimum", type: "uint128" },
              ],
            },
          ],
          [{ currencyIn: route.currencyIn, path: route.path, amountIn, amountOutMinimum: minOut }],
        );
  const settle = encodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "bool" }], [route.currencyIn, OPEN_DELTA, false]);
  const take = encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [token, minOut]);
  const v4 = encodeAbiParameters([{ type: "bytes" }, { type: "bytes[]" }], [actions, [swapParams, settle, take]]);
  return { commands: encodePacked(["uint8", "uint8"], [UR_COMMAND_WRAP_ETH, UR_COMMAND_V4_SWAP]), inputs: [wrap, v4], value: amountIn };
}

/** V4 Quoter: quoteExactInput over a path (the same path the buy will take). */
export const V4_QUOTER_EXACT_INPUT_ABI = [
  {
    type: "function",
    name: "quoteExactInput",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "exactCurrency", type: "address" },
          { name: "path", type: "tuple[]", components: PATH_KEY_COMPONENTS },
          { name: "exactAmount", type: "uint128" },
        ],
      },
    ],
    outputs: [
      { name: "amountOut", type: "uint256" },
      { name: "gasEstimate", type: "uint256" },
    ],
  },
] as const;

export { POOL_KEY_COMPONENTS };
