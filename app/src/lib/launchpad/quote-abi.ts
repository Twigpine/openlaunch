import { parseAbi } from "viem";

export const QUOTE_FACTORY_ABI = parseAbi([
  "struct Recipient { address payout; uint16 bps; }",
  "struct LaunchParams { string name; string symbol; string metadataURI; address quote; uint256 supply; int24 startTick; uint24 creatorFeePips; bytes32 salt; Recipient[] recipients; }",
  "struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }",
  "function launch(LaunchParams p) returns (address token, uint256 tokenId)",
  "function predictToken(address launcher, bytes32 salt, string name, string symbol, uint256 supply, string metadataURI) view returns (address)",
  "function findSalt(address launcher, bytes32 baseSalt, string name, string symbol, uint256 supply, string metadataURI, address quote, uint256 maxTries) view returns (bytes32 salt, address token)",
  "function poolKeyOf(address token) view returns (PoolKey)",
  "function locker() view returns (address)", "function vault() view returns (address)", "function hook() view returns (address)",
  "event QuoteLaunched(address indexed token, uint256 indexed tokenId, address indexed launcher, address quote, bytes32 poolId, int24 startTick, uint24 creatorFeePips, uint256 supply, string metadataURI)",
  "error BadFee()", "error BadSupply()", "error BadTick()", "error QuoteOrdering()", "error SaltUsed()", "error NoSaltFound()", "error NativeQuoteUnsupported()",
]);

export const QUOTE_VAULT_ABI = parseAbi([
  "struct Recipient { address payout; uint16 bps; }",
  "function collect(uint256 tokenId) returns (uint256 quoteOut, uint256 tokenOut)",
  "function collectMany(uint256[] tokenIds)",
  "function claim(uint256 tokenId) returns (uint256)",
  "function claimFor(uint256 tokenId, address account) returns (uint256)",
  "function claimable(uint256 tokenId, address account) view returns (uint256)",
  "function pendingFees(uint256 tokenId) view returns (uint256)",
  "function recipientsOf(uint256 tokenId) view returns (Recipient[])",
  "event Collected(uint256 indexed tokenId, address indexed token, uint256 quoteAmount, uint256 tokenAmount)",
  "event Paid(uint256 indexed tokenId, address indexed account, address indexed currency, uint256 amount)",
  "event Credited(uint256 indexed tokenId, address indexed account, address indexed currency, uint256 amount)",
  "event Claimed(uint256 indexed tokenId, address indexed account, address indexed currency, uint256 amount)",
  "event Burned(uint256 indexed tokenId, address indexed currency, uint256 amount)",
  "error UnknownPosition()", "error TransferFailed()", "error BadRedemption()",
]);

export const QUOTE_HOOK_ABI = parseAbi([
  "event QuoteSwap(bytes32 indexed poolId, address indexed executor, bool zeroForOne, bool exactInput, uint256 quoteFee, int256 amount0, int256 amount1)",
]);
export const QUOTE_LAUNCHED_EVENT = QUOTE_FACTORY_ABI.find((e) => e.type === "event")!;
export const QUOTE_VAULT_EVENTS = QUOTE_VAULT_ABI.filter((e) => e.type === "event");
export const QUOTE_SWAP_EVENT = QUOTE_HOOK_ABI[0];
