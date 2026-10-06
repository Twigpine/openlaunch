import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { decodeAbiParameters, type Address, type Hex } from "viem";
import { ACTION_SETTLE, ACTION_SWAP_EXACT_IN, ADDRESS_THIS, ETH_ROUTE_CHAINS, OPEN_DELTA, UR_COMMAND_WRAP_ETH, WETH_BASE, encodeEthRouteBuy, ethRouteFor } from "./eth-route.ts";
import { GITLAWB_ADDRESS, GITLAWB_ADDRESS_ROBINHOOD, GITLAWB_POOL_KEY } from "./gitlawb.ts";
import { poolIdOf } from "./math.ts";
import { ACTION_TAKE_ALL, UR_COMMAND_V4_SWAP } from "./swap.ts";
import { TWIG_ADDRESS, TWIG_HOOK, TWIG_HOOK_POOL } from "./twig.ts";

/**
 * "Buy with ETH" (eth-route.ts): one Universal Router call, WRAP_ETH then V4_SWAP along ETH → GITLAWB (→ TWIG) → token.
 * Proven end to end on a Base fork against live pools (OL via TWIG, MUSEWORLD via GITLAWB: received exactly the quote,
 * no dust left in the router, a minimum it cannot meet reverts). These tests pin the route and the encoding.
 */
const TOKEN = "0xf00000000000000000000000000000000000beef" as Address;
const ZERO = "0x0000000000000000000000000000000000000000" as Address;
const pool = (quote: string) => ({ currency0: quote as Address, currency1: TOKEN, fee: 10_000, tickSpacing: 200, hooks: ZERO });
const src = (rel: string) => readFileSync(path.join(import.meta.dirname, rel), "utf8");

test("the TWIG wrap pool and the GITLAWB pool are the live ones (ids derived, pinned to the chain)", () => {
  const twigPool = poolIdOf({ currency0: GITLAWB_ADDRESS as Address, currency1: TWIG_ADDRESS as Address, fee: TWIG_HOOK_POOL.fee, tickSpacing: TWIG_HOOK_POOL.tickSpacing, hooks: TWIG_HOOK_POOL.hooks as Address });
  assert.equal(twigPool, "0xe7d26ece4839636ab7c0281d4df5446304eca45ab7f257cdf648bd8036996320", "TWIG/GITLAWB wrap pool on Base (initialised at 2^96, 1:1)");
  assert.equal(TWIG_HOOK, "0xf7423f48886f86f551b517254d21af4267732888", "Twigpine Wrap Hook, approved by Uniswap for routing");
  assert.ok(GITLAWB_ADDRESS < TWIG_ADDRESS, "GITLAWB sorts below TWIG, so it is the wrap pool's currency0");
});

test("a TWIG pair on Base routes ETH → GITLAWB → TWIG → token", () => {
  const r = ethRouteFor("base", TWIG_ADDRESS, TOKEN, pool(TWIG_ADDRESS))!;
  assert.ok(r);
  assert.equal(r.currencyIn, WETH_BASE);
  assert.deepEqual(r.via, ["ETH", "GITLAWB", "TWIG"]);
  assert.deepEqual(r.path.map((h) => h.intermediateCurrency.toLowerCase()), [GITLAWB_ADDRESS, TWIG_ADDRESS, TOKEN]);
  // hop 1: the deep WETH/GITLAWB pool (Doppler dynamic-fee hook); hop 2: the wrap hook at 0%; hop 3: the launch's own pool
  assert.deepEqual([r.path[0].fee, r.path[0].tickSpacing, r.path[0].hooks], [GITLAWB_POOL_KEY.fee, GITLAWB_POOL_KEY.tickSpacing, GITLAWB_POOL_KEY.hooks]);
  assert.deepEqual([r.path[1].fee, r.path[1].tickSpacing, r.path[1].hooks.toLowerCase()], [0, 1, TWIG_HOOK]);
  assert.deepEqual([r.path[2].fee, r.path[2].tickSpacing, r.path[2].hooks], [10_000, 200, ZERO]);
});

test("a GITLAWB pair on Base routes ETH → GITLAWB → token; nothing else gets a route", () => {
  const r = ethRouteFor("base", GITLAWB_ADDRESS.toUpperCase().replace("0X", "0x"), TOKEN, pool(GITLAWB_ADDRESS))!;
  assert.deepEqual(r.via, ["ETH", "GITLAWB"]);
  assert.deepEqual(r.path.map((h) => h.intermediateCurrency.toLowerCase()), [GITLAWB_ADDRESS, TOKEN]);
  assert.equal(ethRouteFor("base", ZERO, TOKEN, pool(ZERO)), null, "an ETH pair already pays in ETH");
  assert.equal(ethRouteFor("base", "0x7777777777777777777777777777777777777777", TOKEN, pool("0x7777777777777777777777777777777777777777")), null, "an unlisted pair never");
  assert.equal(ethRouteFor("robinhood", GITLAWB_ADDRESS_ROBINHOOD, TOKEN, pool(GITLAWB_ADDRESS_ROBINHOOD)), null, "Robinhood's GITLAWB has no deep market there");
  assert.equal(ethRouteFor("arc", GITLAWB_ADDRESS, TOKEN, pool(GITLAWB_ADDRESS)), null);
  assert.deepEqual(Object.keys(ETH_ROUTE_CHAINS), ["base"]);
  // the route must end in the launch's own pool: a pool for another token, or the wrong way round, gets none
  assert.equal(ethRouteFor("base", TWIG_ADDRESS, TOKEN, { ...pool(TWIG_ADDRESS), currency1: "0xf00000000000000000000000000000000000dead" as Address }), null);
  assert.equal(ethRouteFor("base", TWIG_ADDRESS, TOKEN, { ...pool(TWIG_ADDRESS), currency0: TOKEN, currency1: TWIG_ADDRESS as Address }), null);
});

const PATH = [{ type: "tuple[]", components: [{ name: "intermediateCurrency", type: "address" }, { name: "fee", type: "uint24" }, { name: "tickSpacing", type: "int24" }, { name: "hooks", type: "address" }, { name: "hookData", type: "bytes" }] }] as const;

test("encodeEthRouteBuy: WRAP_ETH to the router, then SWAP_EXACT_IN ‖ SETTLE from the router ‖ TAKE_ALL to the buyer", () => {
  const route = ethRouteFor("base", TWIG_ADDRESS, TOKEN, pool(TWIG_ADDRESS))!;
  const amountIn = 10n ** 16n;
  const minOut = 123456789n;
  const { commands, inputs, value } = encodeEthRouteBuy({ route, token: TOKEN, amountIn, minOut });
  assert.equal(commands, `0x${UR_COMMAND_WRAP_ETH.toString(16).padStart(2, "0")}${UR_COMMAND_V4_SWAP.toString(16)}`);
  assert.equal(value, amountIn, "the ETH goes in as msg.value");
  const [recipient, wrapMin] = decodeAbiParameters([{ type: "address" }, { type: "uint256" }], inputs[0]);
  assert.equal(recipient.toLowerCase(), ADDRESS_THIS, "wrapped WETH stays in the router for the swap");
  assert.equal(wrapMin, amountIn);
  const [actions, params] = decodeAbiParameters([{ type: "bytes" }, { type: "bytes[]" }], inputs[1]);
  assert.equal(actions, `0x${[ACTION_SWAP_EXACT_IN, ACTION_SETTLE, ACTION_TAKE_ALL].map((a) => a.toString(16).padStart(2, "0")).join("")}`);
  const [swap] = decodeAbiParameters([{ type: "tuple", components: [{ name: "currencyIn", type: "address" }, { name: "path", ...PATH[0] }, { name: "amountIn", type: "uint128" }, { name: "amountOutMinimum", type: "uint128" }] }], params[0] as Hex);
  assert.equal(swap.currencyIn.toLowerCase(), WETH_BASE);
  assert.equal(swap.path.length, 3);
  assert.equal(swap.amountIn, amountIn);
  assert.equal(swap.amountOutMinimum, minOut);
  const [settleCurrency, settleAmount, payerIsUser] = decodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "bool" }], params[1] as Hex);
  assert.deepEqual([settleCurrency.toLowerCase(), settleAmount, payerIsUser], [WETH_BASE, OPEN_DELTA, false], "paid from the router's own WETH, never pulled from the buyer");
  const [takeCurrency, takeMin] = decodeAbiParameters([{ type: "address" }, { type: "uint256" }], params[2] as Hex);
  assert.deepEqual([takeCurrency.toLowerCase(), takeMin], [TOKEN, minOut], "the buyer takes every token, at least the minimum");
});

test("encodeEthRouteBuy: the v2 router layout carries one minHopPriceX36 per hop; a zero amount is refused", () => {
  const route = ethRouteFor("base", GITLAWB_ADDRESS, TOKEN, pool(GITLAWB_ADDRESS))!;
  const v2 = encodeEthRouteBuy({ route, token: TOKEN, amountIn: 5n, minOut: 1n, layout: "v2" });
  const [, params] = decodeAbiParameters([{ type: "bytes" }, { type: "bytes[]" }], v2.inputs[1]);
  const [swap] = decodeAbiParameters([{ type: "tuple", components: [{ name: "currencyIn", type: "address" }, { name: "path", ...PATH[0] }, { name: "minHopPriceX36", type: "uint256[]" }, { name: "amountIn", type: "uint128" }, { name: "amountOutMinimum", type: "uint128" }] }], params[0] as Hex);
  assert.deepEqual(swap.minHopPriceX36, [0n, 0n]);
  assert.throws(() => encodeEthRouteBuy({ route, token: TOKEN, amountIn: 0n, minOut: 0n }), /positive/);
});

test("trade panel: ETH is the default way to pay where the route exists; quotes and approvals follow the pay asset", () => {
  const panel = src("../../components/launchpad/TradePanel.tsx");
  assert.match(panel, /const ethRoute = useMemo\(\(\) => ethRouteFor\(chain, quote\.address, token, poolKey\)/);
  assert.match(panel, /useState<"eth" \| "quote">\("eth"\)/, "ETH first: most buyers hold ETH");
  assert.match(panel, /\$\{viaEth \? ":eth" : ""\}/, "a quote for one pay asset never prices the other");
  assert.match(panel, /functionName: "quoteExactInput", args: \[\{ exactCurrency: ethRoute\.currencyIn, path: ethRoute\.path, exactAmount: amountIn \}\]/, "quoted over the exact path the router takes");
  assert.match(panel, /const payToken: Address \| null = side === "sell" \? token : isNative \|\| ethBuy \? null : quote\.address;/, "no approvals for an ETH buy");
  assert.match(panel, /encodeEthRouteBuy\(\{ route: ethRoute, token, amountIn, minOut: min, layout: V4\.swapLayout \}\)/);
  assert.match(panel, /quote\.key === "twig" && !viaEth/, "the 'Need TWIG?' hint only when paying in TWIG");
  assert.match(panel, /One swap through Uniswap: \{\[\.\.\.ethRoute\.via, symbol\]\.join\(" → "\)\}/);
});
