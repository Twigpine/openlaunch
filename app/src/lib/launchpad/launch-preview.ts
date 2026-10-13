import type { LaunchRow } from "./queries";
import type { Quote } from "./config";
import { chainIdOf, type ChainKey } from "../chainPublic.ts";

/** Every launch mints the same fixed supply, all of it into the pool (the launch form's "1,000,000,000 supply"). */
const SUPPLY = 1_000_000_000;

/**
 * The market row a launch will have, built from the launch form before anything is sent, so the form can preview the
 * real board card. Only what the form knows is filled in; everything the chain decides later (address, pool, trades)
 * starts empty. Never stored or sent anywhere.
 */
export function previewLaunch(p: {
  chain: ChainKey;
  name: string;
  symbol: string;
  description: string;
  image: string;
  banner: string;
  website: string;
  xHandle: string | null;
  fdvQuote: number | null;
  quote: { key: Quote["key"]; symbol: string; decimals: number; usd: number | null };
  lpFee: number;
  launcher: string | null;
}): LaunchRow {
  const https = (v: string) => (/^https:\/\//.test(v.trim()) ? v.trim() : null);
  const fdv = p.fdvQuote !== null && Number.isFinite(p.fdvQuote) ? p.fdvQuote : 0;
  const usd = p.quote.usd;
  const symbol = p.symbol || "TICKER";
  return {
    chain: p.chain,
    chain_id: chainIdOf(p.chain),
    token: previewAddress(symbol),
    token_id: 0,
    launcher: p.launcher ?? "0x0000000000000000000000000000000000000000",
    quote: "",
    quote_key: p.quote.key,
    quote_symbol: p.quote.symbol,
    quote_decimals: p.quote.decimals,
    quote_decimals_known: true,
    pool_id: "",
    start_tick: 0,
    lp_fee: p.lpFee,
    supply: String(SUPPLY),
    metadata_uri: "",
    name: p.name.trim() || "Your token",
    symbol,
    block_number: 0,
    block_time: new Date(0).toISOString(),
    tx_hash: "",
    tick: 0,
    sqrt_price_x96: null,
    volume_quote: "0",
    buys: 0,
    sells: 0,
    last_trade_at: null,
    fees_quote_collected: "0",
    fees_token_collected: "0",
    fees_quote_burned: "0",
    fees_token_burned: "0",
    recipients: [],
    trades_1h: 0,
    traders_1h: 0,
    traders_1h_ex: 0,
    volume_1h: "0",
    trades_24h: 0,
    traders_24h_ex: 0,
    volume_24h: "0",
    last_outside_trade_at: null,
    live_tier: "new",
    launcher_collapsed: 0,
    description: p.description.trim() || null,
    image_url: https(p.image),
    banner_url: https(p.banner),
    holders: 0,
    website: https(p.website),
    x_handle: p.xHandle,
    price_quote: fdv / SUPPLY,
    fdv_quote: fdv,
    change_from_launch: 0,
    quote_usd: usd,
    price_usd: usd === null ? null : (fdv / SUPPLY) * usd,
    fdv_usd: usd === null ? null : fdv * usd,
    volume_usd: usd === null ? null : 0,
    volume_1h_usd: usd === null ? null : 0,
    volume_24h_usd: usd === null ? null : 0,
  };
}

/** A stand-in address made from the ticker, so a logo-less preview takes the same colour each time for the same ticker. */
export function previewAddress(symbol: string): string {
  let hex = "";
  for (const ch of symbol.slice(0, 20)) hex += ch.charCodeAt(0).toString(16).padStart(2, "0");
  return `0x${hex.padEnd(40, "0").slice(0, 40)}`;
}
