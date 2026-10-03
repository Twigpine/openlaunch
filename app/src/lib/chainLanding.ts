/**
 * Copy for the per-chain landing pages (/base, /robinhood, /arc), pure (node --test loads this).
 * Each page answers one search ("token launchpad on Base", "launch a token on Arc") with its own
 * title, heading and canonical, instead of a ?chain= view that search engines fold into "/".
 * Facts only (CONTRIBUTING.md "Facts over scores"): what the chain is, what a launch there quotes in,
 * what it costs. Keyed by ChainKey, so a new chain fails to type-check until it has copy.
 */
import type { ChainKey } from "./chainKeys.ts";

export type ChainLandingCopy = {
  /** ≤ 60 chars once the layout template adds " · openlaunch.lol" (Google truncates past that); query words first. */
  title: string;
  /** ≤ 155 chars (Google snippet). */
  description: string;
  heading: string;
  /** One paragraph under the heading: what the chain is, in plain words. */
  intro: string;
  /** What gas is paid in on this chain. */
  gas: string;
};

export const CHAIN_LANDING: Record<ChainKey, ChainLandingCopy> = {
  base: {
    title: "Free token launchpad on Base",
    description: "Launch a token on Base in one transaction. Zero platform fee, open source, 100% of supply locked as Uniswap v4 liquidity forever. You only pay gas.",
    heading: "Launch a token on Base",
    intro: "Base is Coinbase's Ethereum layer 2. A launch here deploys a fixed-supply ERC-20, opens a Uniswap v4 pool on Base and locks all of the supply in it, in one transaction.",
    gas: "ETH",
  },
  robinhood: {
    title: "Free token launchpad on Robinhood Chain",
    description: "Launch a token on Robinhood Chain in one transaction. Zero platform fee, open source, 100% of supply locked as Uniswap v4 liquidity forever.",
    heading: "Launch a token on Robinhood Chain",
    intro: "Robinhood Chain is Robinhood's Ethereum layer 2. A launch here deploys a fixed-supply ERC-20, opens a Uniswap v4 pool on Robinhood Chain and locks all of the supply in it, in one transaction.",
    gas: "ETH",
  },
  arc: {
    title: "Free token launchpad on Arc (USDC)",
    description: "Launch a token on Arc, Circle's chain, in one transaction. Quoted in USDC, zero platform fee, 100% of supply locked as Uniswap v4 liquidity forever.",
    heading: "Launch a token on Arc",
    intro: "Arc is Circle's layer 1, where USDC is the gas token. A launch here deploys a fixed-supply ERC-20, opens a USDC-quoted Uniswap v4 pool on Arc and locks all of the supply in it, in one transaction.",
    gas: "USDC",
  },
};

/** The landing page path for a chain: /base, /robinhood, /arc. */
export function chainLandingPath(chain: ChainKey): string {
  return `/${chain}`;
}
