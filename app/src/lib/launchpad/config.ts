import { isAddress, type Address } from "viem";
import { CHAIN_KEYS, SITE_URL, isChainKey, type ChainKey } from "@/lib/chainPublic";
import { unlistedQuote } from "./unlisted-quote";
import { MUSEWORLD_ADDRESS, MUSEWORLD_DECIMALS, MUSEWORLD_LOGO_PATH, MUSEWORLD_NAME, MUSEWORLD_SYMBOL } from "./museworld";
import { GITLAWB_ADDRESS, GITLAWB_ADDRESS_ROBINHOOD, GITLAWB_DECIMALS, GITLAWB_LOGO_PATH, GITLAWB_NAME, GITLAWB_SYMBOL } from "./gitlawb";

/**
 * CLIENT-SAFE launchpad config, per chain. Only NEXT_PUBLIC_* vars are read here.
 * Three ownerless contracts per chain (LaunchFactory / LaunchLocker / LaunchToken)
 * on top of Uniswap v4. No platform fee anywhere.
 */
export { TICK_SPACING } from "./math";
export const MAX_LP_FEE = 30_000; // pips (3%)
export const DEFAULT_SUPPLY = 1_000_000_000n * 10n ** 18n;
export const DEAD = "0x000000000000000000000000000000000000dEaD" as const;
export const NATIVE = "0x0000000000000000000000000000000000000000" as const;
export const BPS = 10_000;
/** Locker limit on beneficiaries per launch (LaunchLocker.MAX_RECIPIENTS); recipients.test.ts keeps the two in sync. */
export const MAX_RECIPIENTS = 7;

/**
 * key "museworld" = an official quote the form does not offer (museworld.ts); "stock" = a registry stock; "other" = an ERC-20 no list knows (an unlisted pair, unlisted-quote.ts). `decimalsKnown`
 * is false only for an unlisted quote whose decimals have not been read yet: its 18 is a placeholder and it must not trade.
 */
export type Quote = { key: "eth" | "usdg" | "usdc" | "gitlawb" | "museworld" | "stock" | "other"; address: Address; symbol: string; decimals: number; usd: number | null /* fixed USD price (stables); live for stocks + GITLAWB (server-filled) */; name?: string; logo?: string | null; decimalsKnown?: boolean };
export type V4 = { poolManager: Address; positionManager: Address; stateView: Address; quoter: Address; universalRouter: Address; permit2: Address; swapLayout: "v1" | "v2" };
export type ChainLaunchpad = { key: ChainKey; factory: Address | null; locker: Address | null; v4: V4; quotes: Quote[]; configured: boolean };

const ETH: Quote = { key: "eth", address: NATIVE, symbol: "ETH", decimals: 18, usd: null };
const USDG: Quote = { key: "usdg", address: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", symbol: "USDG", decimals: 6, usd: 1 };
/** USDC on Arc: the ERC-20 face of the chain's gas token (same balance as the native asset, 6 decimals here vs 18 natively). */
const USDC_ARC: Quote = { key: "usdc", address: "0x3600000000000000000000000000000000000000", symbol: "USDC", decimals: 6, usd: 1 };
/** GITLAWB: usd is null here (client-safe static); the server fills the live price (gitlawbServer.ts). Robinhood's is the LayerZero OFT of the Base token. */
const GITLAWB: Quote = { key: "gitlawb", address: GITLAWB_ADDRESS as Address, symbol: GITLAWB_SYMBOL, decimals: GITLAWB_DECIMALS, usd: null, name: GITLAWB_NAME, logo: GITLAWB_LOGO_PATH };
const GITLAWB_RH: Quote = { ...GITLAWB, address: GITLAWB_ADDRESS_ROBINHOOD as Address };
/** MUSEWORLD: usd is null here (client-safe static); the server fills the price from its own GITLAWB pool (queries.ts). */
const MUSEWORLD: Quote = { key: "museworld", address: MUSEWORLD_ADDRESS, symbol: MUSEWORLD_SYMBOL, decimals: MUSEWORLD_DECIMALS, usd: null, name: MUSEWORLD_NAME, logo: MUSEWORLD_LOGO_PATH };

/** Canonical Uniswap v4 deployments (developers.uniswap.org/docs/protocols/v4/deployments). */
const V4_BY_CHAIN: Record<ChainKey, V4> = {
  base: {
    poolManager: "0x498581fF718922c3f8e6A244956aF099B2652b2b",
    positionManager: "0x7C5f5A4bBd8fD63184577525326123B519429bDc",
    stateView: "0xA3c0c9b65baD0b08107Aa264b0f3dB444b867A71",
    quoter: "0x0d5e0F971ED27FBfF6c2837bf31316121532048D",
    universalRouter: "0x6fF5693b99212Da76ad316178A184AB56D299b43",
    permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
    swapLayout: "v1", // router predates minHopPriceX36 (verified on a fork)
  },
  robinhood: {
    poolManager: "0x8366a39CC670B4001A1121B8F6A443A643e40951",
    positionManager: "0x58daec3116aae6D93017bAAea7749052E8a04fA7",
    stateView: "0xf3334192d15450cdd385c8b70e03f9a6bd9e673b",
    quoter: "0x8dc178efb8111bb0973dd9d722ebeff267c98f94",
    universalRouter: "0x8876789976decbfcbbbe364623c63652db8c0904",
    permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
    swapLayout: "v2", // newer router build: ExactInputSingleParams carries minHopPriceX36 (verified on a fork)
  },
  // Uniswap/contracts deployments/5042.md (Universal Router v2.1.1, the same generation as Robinhood's). No wrapped native on Arc.
  arc: {
    poolManager: "0x8366a39CC670B4001A1121B8F6A443A643e40951",
    positionManager: "0x6049c9a0e26405c0985f9e3685c87d0ae917f82b",
    stateView: "0xf3334192d15450cdd385c8b70e03f9a6bd9e673b",
    quoter: "0x8dc178efb8111bb0973dd9d722ebeff267c98f94",
    universalRouter: "0x4fca4a51ab4f23a7447b3284fbd7d73289a89fb1",
    permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
    swapLayout: "v2", // router v2.1.1, same ExactInputSingleParams as Robinhood (verified on a fork: test/LaunchFactory.arc.fork.t.sol)
  },
};
/** Quote assets offered per chain, first = default. */
const QUOTES_BY_CHAIN: Record<ChainKey, Quote[]> = { base: [ETH, GITLAWB], robinhood: [USDG, ETH, GITLAWB_RH], arc: [USDC_ARC] };
/**
 * Official quotes: known, badged and priced wherever a launch paired with them is listed, but NEVER offered in the
 * launch form (MUSEWORLD launches are made inside Museworld by its agents). Kept out of QUOTES_BY_CHAIN on purpose.
 */
const OFFICIAL_QUOTES: Record<ChainKey, Quote[]> = { base: [MUSEWORLD], robinhood: [], arc: [] };

/**
 * What address(0) means on each chain. The factory is permissionless and documents address(0) as the native asset,
 * so a pool quoted in it can exist on any chain whether or not the form offers it; the indexer lists it and it must
 * price as that chain's native asset. On Arc that is USDC at 18 decimals and a fixed dollar, never ETH: priced at
 * ETH, a $10k launch would rank as a multi-million-dollar one. (The Arc factory refuses native quotes outright, see
 * contracts/docs/LAUNCHPAD.md; the pricing rule stays so any such row could never be mispriced.)
 */
const USDC_ARC_NATIVE: Quote = { key: "usdc", address: NATIVE, symbol: "USDC", decimals: 18, usd: 1 };
export const NATIVE_QUOTES: Record<ChainKey, Quote> = { base: ETH, robinhood: ETH, arc: USDC_ARC_NATIVE };

/** Every quote a chain can price without a feed (the stables, and a native asset that is one), for SQL pricing. */
export function fixedUsdQuotes(): { chain: ChainKey; key: Quote["key"]; address: string; decimals: number; usd: number }[] {
  return CHAIN_KEYS.flatMap((chain) => allQuotes(chain).flatMap((q) => (q.usd !== null ? [{ chain, key: q.key, address: q.address.toLowerCase(), decimals: q.decimals, usd: q.usd }] : [])));
}
/** Where a quote key is found: (chain, address) pairs, so a filter never matches a same-address token on another chain. */
export function quotesWithKey(key: Quote["key"]): { chain: ChainKey; address: string }[] {
  return CHAIN_KEYS.flatMap((chain) => allQuotes(chain).flatMap((q) => (q.key === key ? [{ chain, address: q.address.toLowerCase() }] : [])));
}
/** Lowercase addresses of every quote a chain lists (offered + native); anything else is unlisted, or a registry stock. */
export function listedQuoteAddresses(chain: ChainKey): string[] {
  return allQuotes(chain).map((q) => q.address.toLowerCase());
}
/** The chain's offered quotes plus its native asset (already among them where the form offers it), plus its official quotes. */
function allQuotes(chain: ChainKey): Quote[] {
  const offered = QUOTES_BY_CHAIN[chain];
  return [...(offered.some((q) => q.address === NATIVE) ? offered : [...offered, NATIVE_QUOTES[chain]]), ...OFFICIAL_QUOTES[chain]];
}

/**
 * Native amount (18-dec wei) kept back from a first buy: the launch transaction pays its own gas first, then the buy
 * and, for an ERC-20 quote, its approvals. Generous for each chain's gas prices.
 */
export const GAS_RESERVE_WEI: Record<ChainKey, bigint> = {
  base: 1_500_000_000_000_000n, // 0.0015 ETH: deploy + pool init + position mint, then approvals + swap
  robinhood: 1_500_000_000_000_000n, // 0.0015 ETH
  arc: 1_000_000_000_000_000_000n, // 1 USDC: a launch is ~2.5M gas; Arc's base fee floors at 20 gwei but ran ~80 gwei + ~30 gwei tips on launch day (≈ 0.3 USDC), so keep a wide margin
};
/** Native amount (18-dec wei) a trade keeps back for its own gas (approvals + one swap); the launch-sized reserve above is for the form. */
export const SWAP_GAS_RESERVE_WEI: Record<ChainKey, bigint> = {
  base: 500_000_000_000_000n, // 0.0005 ETH
  robinhood: 500_000_000_000_000n, // 0.0005 ETH
  arc: 200_000_000_000_000_000n, // 0.2 USDC: a router swap is ~0.3M gas (≈ 0.03 USDC at launch-day fees), plus approvals, with margin
};
/** The ERC-20 face of the chain's gas token where one exists (Arc: USDC). A buy paid in it draws on the gas balance. */
export const NATIVE_ERC20: Record<ChainKey, Address | null> = { base: null, robinhood: null, arc: USDC_ARC.address };
export function sharesGasBalance(chain: ChainKey, quote: Pick<Quote, "address">): boolean {
  const n = NATIVE_ERC20[chain];
  return n !== null && n.toLowerCase() === quote.address.toLowerCase();
}

/**
 * Where a chain's tokenized stocks come from: Coinbase's static B20 list (Base), Robinhood's registry (Robinhood Chain),
 * or none (Arc: the form offers no Stock quote). Explicit per chain so a new chain never inherits another chain's registry.
 */
export type StockSource = "coinbase-b20" | "robinhood-registry" | null;
export const STOCK_SOURCE: Record<ChainKey, StockSource> = { base: "coinbase-b20", robinhood: "robinhood-registry", arc: null };

function addr(v: string | undefined): Address | null {
  const raw = (v ?? "").trim();
  return isAddress(raw) ? (raw as Address) : null;
}

const CFG: Record<ChainKey, ChainLaunchpad> = {
  base: {
    key: "base",
    factory: addr(process.env.NEXT_PUBLIC_LAUNCH_FACTORY),
    locker: addr(process.env.NEXT_PUBLIC_LAUNCH_LOCKER),
    v4: V4_BY_CHAIN.base,
    quotes: QUOTES_BY_CHAIN.base,
    configured: false,
  },
  robinhood: {
    key: "robinhood",
    factory: addr(process.env.NEXT_PUBLIC_LAUNCH_FACTORY_ROBINHOOD),
    locker: addr(process.env.NEXT_PUBLIC_LAUNCH_LOCKER_ROBINHOOD),
    v4: V4_BY_CHAIN.robinhood,
    quotes: QUOTES_BY_CHAIN.robinhood,
    configured: false,
  },
  arc: {
    key: "arc",
    factory: addr(process.env.NEXT_PUBLIC_LAUNCH_FACTORY_ARC),
    locker: addr(process.env.NEXT_PUBLIC_LAUNCH_LOCKER_ARC),
    v4: V4_BY_CHAIN.arc,
    quotes: QUOTES_BY_CHAIN.arc,
    configured: false,
  },
};
for (const k of CHAIN_KEYS) CFG[k].configured = CFG[k].factory !== null && CFG[k].locker !== null;

export function launchpad(key: ChainKey): ChainLaunchpad {
  return CFG[key];
}
export const CONFIGURED_CHAINS: ChainKey[] = CHAIN_KEYS.filter((k) => CFG[k].configured);
export const LAUNCHPAD_CONFIGURED = CONFIGURED_CHAINS.length > 0;
/** Chains offered in wallet switchers and list filters: the configured ones; every chain where none is (local development). */
export const VISIBLE_CHAINS: ChainKey[] = CONFIGURED_CHAINS.length > 0 ? CONFIGURED_CHAINS : CHAIN_KEYS;
/**
 * Chains with a landing page (/base, /robinhood, /arc): configured ones only, never the development fallback
 * above. A page for a chain without contracts has nothing to launch, so every link to one, the sitemap entry
 * and the /t/<chain> redirect go through this.
 */
export function hasChainPage(key: ChainKey): boolean {
  return CONFIGURED_CHAINS.includes(key);
}
/** A `?chain=` param the list may filter by: a visible chain, else null (all chains), so a link to a chain that is not live yet never shows an empty list. */
export function visibleChainOr(v: unknown): ChainKey | null {
  return isChainKey(v) && VISIBLE_CHAINS.includes(v) ? v : null;
}

/**
 * Quote metadata for an on-chain quote address. Unknown ERC20 → an unlisted quote (key "other", labelled by its
 * address, placeholder 18 decimals, NEVER priced); the server upgrades it to a registry stock or to the token's own
 * symbol and decimals (queries.ts). It must not fall back to "eth": an unknown quote priced at ETH once inflated site
 * volume ~2× (NVDA-quoted launches before the stock registry shipped).
 */
export function quoteInfo(key: ChainKey, address: string): Quote {
  const a = address.toLowerCase();
  return allQuotes(key).find((q) => q.address.toLowerCase() === a) ?? unlistedQuote(address, null);
}

/** Quote key for a stored quote address: a fixed quote's key, else "other" (the server may still find it in a stock registry). */
export function quoteKeyOf(key: ChainKey, address: string): Quote["key"] {
  return quoteInfo(key, address).key;
}

export { quoteUsdOf } from "./math";

/** LP fee presets offered in the form (pips). */
export const FEE_PRESETS = [
  { pips: 0, label: "0%", blurb: "Totally free. Nobody earns anything on trades." },
  { pips: 10_000, label: "1%", blurb: "Standard. Goes to your beneficiary, or is burned." },
  { pips: 30_000, label: "3%", blurb: "Max. Same routing, three times the yield." },
] as const;

/** Starting market cap presets per quote (fully diluted, in quote units). */
export const MCAP_PRESETS: Record<Quote["key"], number[]> = { eth: [1, 5, 10, 25], usdg: [5_000, 10_000, 25_000, 100_000], usdc: [5_000, 10_000, 25_000, 100_000], gitlawb: [] /* derived from the live price */, museworld: [] /* not offered in the form */, stock: [] /* derived from the live price */, other: [] /* never offered */ };
/** Buy amount presets per quote. */
export const BUY_PRESETS: Record<Quote["key"], string[]> = { eth: ["0.01", "0.05", "0.1", "0.5"], usdg: ["5", "25", "100", "500"], usdc: ["5", "25", "100", "500"], gitlawb: ["100000", "500000", "1000000", "5000000"], museworld: ["50000", "100000", "500000", "1000000"], stock: ["0.1", "0.5", "1", "5"], other: [] /* unknown token, unknown scale */ };

// NEXT_PUBLIC_* must be read as literal `process.env.X` expressions: Next inlines them at build time.
const DEV_RPC: Record<ChainKey, string | undefined> = {
  base: process.env.NEXT_PUBLIC_RPC_URL_BASE,
  robinhood: process.env.NEXT_PUBLIC_RPC_URL_ROBINHOOD,
  arc: process.env.NEXT_PUBLIC_RPC_URL_ARC,
};

/** Browser RPC: dev override per chain, else our same-origin proxy (→ Alchemy/public, key stays server-side). */
export function browserRpc(key: ChainKey): string {
  return DEV_RPC[key]?.trim() || `${SITE_URL}/api/rpc?chain=${key}`;
}

/** Where a token trades outside this site, per chain. A chain without an entry shows no outside link. */
export const SWAP_SITES: Partial<Record<ChainKey, { name: string; url: (token: string) => string }>> = {
  base: { name: "Uniswap", url: (t) => `https://app.uniswap.org/swap?chain=base&outputCurrency=${t}` },
  arc: { name: "Uniswap", url: (t) => `https://app.uniswap.org/swap?chain=arc&outputCurrency=${t}` },
};
