/** ABIs for the launchpad + the Uniswap v4 periphery it uses. Hand-trimmed to what the app calls. */
import { PATH_KEY_COMPONENTS, POOL_KEY_COMPONENTS } from "./swap.ts";

export const LAUNCH_FACTORY_ABI = [
  {
    type: "function",
    name: "launch",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "p",
        type: "tuple",
        components: [
          { name: "name", type: "string" },
          { name: "symbol", type: "string" },
          { name: "metadataURI", type: "string" },
          { name: "quote", type: "address" },
          { name: "supply", type: "uint256" },
          { name: "startTick", type: "int24" },
          { name: "lpFee", type: "uint24" },
          { name: "salt", type: "bytes32" },
          {
            name: "recipients",
            type: "tuple[]",
            components: [
              { name: "payout", type: "address" },
              { name: "bps", type: "uint16" },
            ],
          },
        ],
      },
    ],
    outputs: [
      { name: "token", type: "address" },
      { name: "tokenId", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "predictToken",
    stateMutability: "view",
    inputs: [
      { name: "launcher", type: "address" },
      { name: "salt", type: "bytes32" },
      { name: "name", type: "string" },
      { name: "symbol", type: "string" },
      { name: "supply", type: "uint256" },
      { name: "metadataURI", type: "string" },
    ],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "findSalt",
    stateMutability: "view",
    inputs: [
      { name: "launcher", type: "address" },
      { name: "baseSalt", type: "bytes32" },
      { name: "name", type: "string" },
      { name: "symbol", type: "string" },
      { name: "supply", type: "uint256" },
      { name: "metadataURI", type: "string" },
      { name: "quote", type: "address" },
      { name: "maxTries", type: "uint256" },
    ],
    outputs: [
      { name: "salt", type: "bytes32" },
      { name: "token", type: "address" },
    ],
  },
  {
    type: "function",
    name: "poolKeyOf",
    stateMutability: "view",
    inputs: [{ name: "token", type: "address" }],
    outputs: [{ name: "", type: "tuple", components: POOL_KEY_COMPONENTS }],
  },
  {
    type: "function",
    name: "infoOf",
    stateMutability: "view",
    inputs: [{ name: "token", type: "address" }],
    outputs: [
      { name: "tokenId", type: "uint256" },
      { name: "launcher", type: "address" },
      { name: "quote", type: "address" },
      { name: "startTick", type: "int24" },
      { name: "lpFee", type: "uint24" },
    ],
  },
  { type: "function", name: "launchCount", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "locker", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
  {
    type: "event",
    name: "Launched",
    inputs: [
      { name: "token", type: "address", indexed: true },
      { name: "tokenId", type: "uint256", indexed: true },
      { name: "launcher", type: "address", indexed: true },
      { name: "quote", type: "address", indexed: false },
      { name: "poolId", type: "bytes32", indexed: false },
      { name: "startTick", type: "int24", indexed: false },
      { name: "lpFee", type: "uint24", indexed: false },
      { name: "supply", type: "uint256", indexed: false },
      { name: "metadataURI", type: "string", indexed: false },
    ],
  },
  { type: "error", name: "BadSupply", inputs: [] },
  { type: "error", name: "BadFee", inputs: [] },
  { type: "error", name: "BadTick", inputs: [] },
  { type: "error", name: "NoLiquidity", inputs: [] },
  { type: "error", name: "SaltUsed", inputs: [] },
  { type: "error", name: "QuoteOrdering", inputs: [] },
  { type: "error", name: "NoSaltFound", inputs: [] },
  { type: "error", name: "NativeQuoteUnsupported", inputs: [] }, // LaunchFactoryArc only: Arc pools quote the ERC-20 USDC, never the native asset
] as const;

export const LAUNCH_LOCKER_ABI = [
  {
    type: "function",
    name: "collect",
    stateMutability: "nonpayable",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [
      { name: "quoteOut", type: "uint256" },
      { name: "tokenOut", type: "uint256" },
    ],
  },
  { type: "function", name: "claim", stateMutability: "nonpayable", inputs: [{ name: "currency", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
  {
    type: "function",
    name: "claimable",
    stateMutability: "view",
    inputs: [
      { name: "account", type: "address" },
      { name: "currency", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "recipientsOf",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [
      {
        name: "",
        type: "tuple[]",
        components: [
          { name: "payout", type: "address" },
          { name: "bps", type: "uint16" },
        ],
      },
    ],
  },
  { type: "function", name: "tokenIdOf", stateMutability: "view", inputs: [{ name: "token", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
  {
    type: "event",
    name: "Collected",
    inputs: [
      { name: "tokenId", type: "uint256", indexed: true },
      { name: "token", type: "address", indexed: true },
      { name: "quoteAmount", type: "uint256", indexed: false },
      { name: "tokenAmount", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "Paid",
    inputs: [
      { name: "tokenId", type: "uint256", indexed: true },
      { name: "account", type: "address", indexed: true },
      { name: "currency", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "Burned",
    inputs: [
      { name: "tokenId", type: "uint256", indexed: true },
      { name: "currency", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "Credited",
    inputs: [
      { name: "account", type: "address", indexed: true },
      { name: "currency", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "Claimed",
    inputs: [
      { name: "account", type: "address", indexed: true },
      { name: "currency", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
  { type: "error", name: "UnknownPosition", inputs: [] },
] as const;

/** PoolManager — only the Swap event (indexed per pool id). */
export const POOL_MANAGER_ABI = [
  {
    type: "event",
    name: "Swap",
    inputs: [
      { name: "id", type: "bytes32", indexed: true },
      { name: "sender", type: "address", indexed: true },
      { name: "amount0", type: "int128", indexed: false },
      { name: "amount1", type: "int128", indexed: false },
      { name: "sqrtPriceX96", type: "uint160", indexed: false },
      { name: "liquidity", type: "uint128", indexed: false },
      { name: "tick", type: "int24", indexed: false },
      { name: "fee", type: "uint24", indexed: false },
    ],
  },
] as const;

export const STATE_VIEW_ABI = [
  {
    type: "function",
    name: "getSlot0",
    stateMutability: "view",
    inputs: [{ name: "poolId", type: "bytes32" }],
    outputs: [
      { name: "sqrtPriceX96", type: "uint160" },
      { name: "tick", type: "int24" },
      { name: "protocolFee", type: "uint24" },
      { name: "lpFee", type: "uint24" },
    ],
  },
] as const;

export const V4_QUOTER_ABI = [
  {
    type: "function",
    name: "quoteExactInputSingle",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "poolKey", type: "tuple", components: POOL_KEY_COMPONENTS },
          { name: "zeroForOne", type: "bool" },
          { name: "exactAmount", type: "uint128" },
          { name: "hookData", type: "bytes" },
        ],
      },
    ],
    outputs: [
      { name: "amountOut", type: "uint256" },
      { name: "gasEstimate", type: "uint256" },
    ],
  },
] as const;

/** V4 Quoter: quoteExactInput over a multi-hop path (the "Buy with ETH" route, eth-route.ts). */
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

export const UNIVERSAL_ROUTER_ABI = [
  {
    type: "function",
    name: "execute",
    stateMutability: "payable",
    inputs: [
      { name: "commands", type: "bytes" },
      { name: "inputs", type: "bytes[]" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [],
  },
] as const;

export const PERMIT2_ABI = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token", type: "address" },
      { name: "spender", type: "address" },
      { name: "amount", type: "uint160" },
      { name: "expiration", type: "uint48" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "user", type: "address" },
      { name: "token", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [
      { name: "amount", type: "uint160" },
      { name: "expiration", type: "uint48" },
      { name: "nonce", type: "uint48" },
    ],
  },
] as const;

export const ERC20_MIN_ABI = [
  { type: "function", name: "name", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "string" }] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "string" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint8" }] },
  { type: "function", name: "totalSupply", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "o", type: "address" },
      { name: "s", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "s", type: "address" },
      { name: "v", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

/** Typed event items (viem getLogs wants AbiEvent, not an ABI index). */
export const LAUNCHED_EVENT = LAUNCH_FACTORY_ABI.find((x) => x.type === "event" && x.name === "Launched")! as Extract<(typeof LAUNCH_FACTORY_ABI)[number], { type: "event" }>;
export const POOL_SWAP_EVENT = POOL_MANAGER_ABI[0];
export const LOCKER_EVENTS = LAUNCH_LOCKER_ABI.filter((x) => x.type === "event") as Extract<(typeof LAUNCH_LOCKER_ABI)[number], { type: "event" }>[];

/** ERC-20 Transfer (launched tokens; used by the holder index). */
export const ERC20_TRANSFER_EVENT = {
  type: "event",
  name: "Transfer",
  inputs: [
    { name: "from", type: "address", indexed: true },
    { name: "to", type: "address", indexed: true },
    { name: "value", type: "uint256", indexed: false },
  ],
} as const;
