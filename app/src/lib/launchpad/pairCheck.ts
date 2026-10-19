import "server-only";
import { decodeFunctionResult, encodeFunctionData, isAddress, type Address, type Hex } from "viem";
import { publicClient } from "@/lib/chain";
import { chainIdOf, explorerAddress, type ChainKey } from "@/lib/chainPublic";
import { maybeDb } from "@/lib/db";
import { ERC20_MIN_ABI } from "./abi";
import { DEAD, coreQuoteNames, launchpad, quoteInfo as staticQuoteInfo } from "./config";
import { ensureRegistry, stockTickers } from "./stocksServer";
import { PAIR_MIN_AGE_DAYS, PAIR_MIN_HOLDERS, PAIR_MIN_LIQUIDITY_USD, pairSymbolCheck, type PairPriceKind, type PairPublic } from "./pairs";
import { isCoreQuote, readPairLeg, univ4Key } from "./pairPrice";
import { TRANSFER_PROBE_ABI, TRANSFER_PROBE_RUNTIME, hasDelegatecall, implementationOf1167 } from "./pairProbe";

/**
 * The free automatic pre-check of a token that wants to be a community pair (reports/Community pairs plan.md §4.2).
 * Contract checks are read from the chain; market facts from the chain and GeckoTerminal (holders, pool ages), with
 * GoPlus Security as a second opinion. Hard checks must all pass before an application (and its fee) is possible; flags
 * are for the reviewer. Unknowns (a service down) are never a pass.
 */
export type PairCheck = { id: string; label: string; pass: boolean | null; hard: boolean; value: string; link?: string };
export type PairSource = { kind: PairPriceKind; pool: string; quote: string; hook: string; label: string; reserve_usd: number | null; created_at: string | null; usable: boolean };
export type PairPrecheck = { chain: ChainKey; address: string; symbol: string; name: string; decimals: number; at: string; ok: boolean; checks: PairCheck[]; sources: PairSource[] };

const EIP1967_IMPL = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const EIP1967_BEACON = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";
const EIP1967_ADMIN = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";
const EIP1822_PROXIABLE = "0xc5f16f0fcc639fa48a6947836d9850f504798e3d4abe3f3c8f1d5b7f2ab56a3b";
const OWNER_ABI = [{ type: "function", name: "owner", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] }] as const;
const ZERO = "0x0000000000000000000000000000000000000000";
const DAY_MS = 86_400_000;

/** A JSON GET that never throws; one retry after a 429 (GeckoTerminal allows about 30 calls a minute). null = unknown. */
async function fetchJson(url: string, retry = true): Promise<unknown | null> {
  try {
    const res = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(6_000) });
    if (res.status === 429 && retry) {
      await new Promise((r) => setTimeout(r, 2_500));
      return fetchJson(url, false);
    }
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}
type GtPool = { attributes: { address: string; name: string; pool_created_at: string | null; reserve_in_usd: string | null }; relationships: { base_token: { data: { id: string } }; quote_token: { data: { id: string } }; dex: { data: { id: string } } } };
type GtInfo = { holders?: { count?: number | null; distribution_percentage?: { top_10?: string } } | null; is_honeypot?: boolean | string | null };
type GtToken = { volume_usd?: { h24?: string | null } };

async function gecko(chain: ChainKey, address: string): Promise<{ info: GtInfo | null; token: GtToken | null; pools: GtPool[] | null }> {
  const base = `https://api.geckoterminal.com/api/v2/networks/${chain}/tokens/${address}`;
  const [info, token, pools] = await Promise.all([fetchJson(`${base}/info`), fetchJson(base), fetchJson(`${base}/pools?page=1`)]);
  const data = <T,>(v: unknown): T | null => ((v as { data?: { attributes?: T } } | null)?.data?.attributes ?? null);
  return { info: data<GtInfo>(info), token: data<GtToken>(token), pools: ((pools as { data?: GtPool[] } | null)?.data ?? null) };
}

type GoPlus = Record<string, string | undefined>;
async function goplus(chain: ChainKey, address: string): Promise<GoPlus | null> {
  const body = (await fetchJson(`https://api.gopluslabs.io/api/v1/token_security/${chainIdOf(chain)}?contract_addresses=${address}`)) as { result?: Record<string, GoPlus> } | null;
  return body?.result?.[address] ?? null;
}

/** The token's candidate price pools: its own openlaunch pool, then GeckoTerminal's pools against a core quote. */
async function sourcesFor(chain: ChainKey, address: string, decimals: number, pools: GtPool[] | null): Promise<PairSource[]> {
  const out: PairSource[] = [];
  const db = maybeDb();
  if (db) {
    const [row] = await db<{ quote: string; pool_id: string }[]>`SELECT quote, pool_id FROM bb_launches WHERE chain_id = ${chainIdOf(chain)} AND token = ${address}`;
    if (row && isCoreQuote(chain, row.quote)) {
      const gt = pools?.find((p) => p.attributes.address.toLowerCase() === row.pool_id.toLowerCase());
      out.push({ kind: "launch", pool: address, quote: row.quote, hook: "", label: `its openlaunch pool against ${staticQuoteInfo(chain, row.quote).symbol}`, reserve_usd: gt ? Number(gt.attributes.reserve_in_usd) : null, created_at: gt?.attributes.pool_created_at ?? null, usable: false });
    }
  }
  for (const p of pools ?? []) {
    const dex = p.relationships.dex.data.id;
    const ids = [p.relationships.base_token.data.id, p.relationships.quote_token.data.id].map((id) => id.replace(/^[a-z-]+_/, "").toLowerCase());
    const other = ids.find((a) => a !== address);
    if (!other || !ids.includes(address) || !isCoreQuote(chain, other)) continue;
    // a pool named by a 32-byte id is a Uniswap v4 pool whatever GeckoTerminal calls its dex (Bankr, Clanker…): the
    // PositionManager's key below confirms it; a 20-byte pool counts only on a v3-style dex (slot0 + observe)
    const v4 = /^0x[0-9a-f]{64}$/i.test(p.attributes.address);
    const kind: PairPriceKind | null = v4 ? "univ4" : dex.startsWith("uniswap-v3") || dex.startsWith("aerodrome-slipstream") ? "univ3" : null;
    if (!kind || out.some((s) => s.pool === p.attributes.address.toLowerCase())) continue;
    let hook = "";
    let quote = other;
    if (kind === "univ4") {
      const key = await univ4Key(chain, p.attributes.address).catch(() => null);
      if (!key) continue;
      quote = [key.currency0, key.currency1].find((c) => c !== address) ?? other; // native ETH or WETH, as the key says
      hook = key.hooks === ZERO ? "" : key.hooks;
    }
    out.push({ kind, pool: p.attributes.address.toLowerCase(), quote, hook, label: `${p.attributes.name} on ${dex}`, reserve_usd: Number(p.attributes.reserve_in_usd), created_at: p.attributes.pool_created_at, usable: false });
    if (out.length >= 5) break;
  }
  // usable = the pool reads a price now (a v3 pool also its oracle average; a v4 average starts once listed)
  await Promise.all(
    out.map(async (s) => {
      const leg = await readPairLeg({ chain, address, decimals, price_kind: s.kind, price_pool: s.pool, price_quote: s.quote }).catch(() => null);
      s.usable = Boolean(leg && leg.spot !== null && (s.kind !== "univ3" || leg.twap !== null));
    }),
  );
  return out.sort((a, b) => Number(b.usable) - Number(a.usable) || (b.reserve_usd ?? 0) - (a.reserve_usd ?? 0));
}

/** Simulate a real holder sending the token (the probe's code at its address, eth_call only): does it arrive whole, and reach 0x…dEaD? */
async function probeTransfer(chain: ChainKey, token: string, holder: string, decimals: number): Promise<{ ok: boolean | null; value: string }> {
  const client = publicClient(chain);
  const bal = (await client.readContract({ address: token as Address, abi: ERC20_MIN_ABI, functionName: "balanceOf", args: [holder as Address] }).catch(() => null)) as bigint | null;
  if (!bal) return { ok: null, value: "no holder balance to test with" };
  const unit = 10n ** BigInt(decimals);
  const amount = bal / 1000n < unit ? bal / 1000n || 1n : unit;
  try {
    const r = await client.call({
      to: holder as Address,
      data: encodeFunctionData({ abi: TRANSFER_PROBE_ABI, functionName: "probe", args: [token as Address, "0x00000000000000000000000000000000000b0b0b", amount, DEAD] }),
      stateOverride: [{ address: holder as Address, code: TRANSFER_PROBE_RUNTIME }],
    });
    const [received, deadOk] = decodeFunctionResult({ abi: TRANSFER_PROBE_ABI, functionName: "probe", data: r.data as Hex });
    if (received !== amount) return { ok: false, value: `sent ${amount}, arrived ${received}: a fee on transfer` };
    if (!deadOk) return { ok: false, value: "a transfer to 0x…dEaD is refused (launch fees are burned there)" };
    return { ok: true, value: "arrives whole; 0x…dEaD accepts it" };
  } catch (e) {
    return { ok: false, value: `the transfer reverts: ${(e instanceof Error ? e.message : String(e)).split("\n")[0].slice(0, 120)}` };
  }
}

export async function precheckPair(chain: ChainKey, rawAddress: string, listed: PairPublic[]): Promise<PairPrecheck> {
  const address = rawAddress.toLowerCase();
  const at = new Date().toISOString();
  const checks: PairCheck[] = [];
  const add = (c: PairCheck) => checks.push(c);
  const client = publicClient(chain);
  const code = isAddress(address) ? await client.getCode({ address: address as Address }).catch(() => undefined) : undefined;
  const hasCode = Boolean(code && code !== "0x");
  add({ id: "contract", label: "A token contract", pass: code === undefined ? null : hasCode, hard: true, value: hasCode ? (code === "0xef" ? "a B20 token (Base's native token standard)" : "contract code found") : "no contract code at this address", link: explorerAddress(chain, address) });
  const [symbol, name, decimals] = hasCode
    ? await Promise.all([
        client.readContract({ address: address as Address, abi: ERC20_MIN_ABI, functionName: "symbol" }).catch(() => null),
        client.readContract({ address: address as Address, abi: ERC20_MIN_ABI, functionName: "name" }).catch(() => null),
        client.readContract({ address: address as Address, abi: ERC20_MIN_ABI, functionName: "decimals" }).catch(() => null),
      ])
    : [null, null, null];
  const sym = typeof symbol === "string" ? symbol.normalize("NFKC").replace(/^\$/, "").trim() : "";
  const dec = typeof decimals === "number" ? decimals : 0;
  const erc20 = typeof symbol === "string" && typeof name === "string" && typeof decimals === "number";
  add({ id: "erc20", label: "Reads as an ERC-20 with 6 to 18 decimals", pass: hasCode ? erc20 && dec >= 6 && dec <= 18 : null, hard: true, value: erc20 ? `${sym}, ${dec} decimals` : "symbol, name or decimals cannot be read" });
  if (erc20) await ensureRegistry().catch(() => null); // Robinhood's stock tickers
  const symCheck = erc20 ? pairSymbolCheck(sym, listed.filter((p) => p.status === "listed" && !(p.chain === chain && p.address === address)).map((p) => p.symbol), stockTickers(chain)) : null;
  add({ id: "symbol", label: "A symbol of its own", pass: symCheck?.pass ?? null, hard: true, value: symCheck?.value ?? sym });
  const already = listed.find((p) => p.chain === chain && p.address === address && p.status !== "delisted");
  add({ id: "new", label: "Not a pair already, and not a core quote", pass: !already && !isCoreQuote(chain, address), hard: true, value: already ? `already ${already.status}` : isCoreQuote(chain, address) ? "a core quote" : "new" });

  // upgradeability: EIP-1967 / EIP-1822 slots (a token whose code can be swapped can become anything after listing)
  if (hasCode && code !== "0xef") {
    const slots = await Promise.all([EIP1967_IMPL, EIP1967_BEACON, EIP1967_ADMIN, EIP1822_PROXIABLE].map((s) => client.getStorageAt({ address: address as Address, slot: s as Hex }).catch(() => undefined)));
    const set = slots.some((v) => v !== undefined && v !== null && BigInt(v) !== 0n);
    const unknown = slots.some((v) => v === undefined);
    add({ id: "proxy", label: "Not upgradeable", pass: set ? false : unknown ? null : true, hard: true, value: set ? "an upgradeable proxy (EIP-1967 / EIP-1822 slot set)" : "no proxy slot set" });
    const impl = implementationOf1167(code as Hex);
    if (impl) add({ id: "clone", label: "A fixed clone", pass: null, hard: false, value: `a minimal proxy (EIP-1167) of ${impl}: it cannot be upgraded; its implementation's functions are the token's`, link: explorerAddress(chain, impl) });
    else if (hasDelegatecall(code as Hex)) add({ id: "delegatecall", label: "No DELEGATECALL", pass: false, hard: false, value: "its code can run other code: the reviewer checks why" });
    const owner = await client.readContract({ address: address as Address, abi: OWNER_ABI, functionName: "owner" }).catch(() => null);
    if (owner && owner.toLowerCase() !== ZERO) add({ id: "owner", label: "No live owner", pass: false, hard: false, value: `owner() is ${owner}: the reviewer checks what it can do`, link: explorerAddress(chain, owner) });
  } else if (code === "0xef") {
    add({ id: "b20", label: "B20 roles", pass: null, hard: false, value: "a B20 token: the reviewer confirms on the explorer that no account holds the admin, mint, pause or seize role" });
  }

  const [gt, gp] = await Promise.all([gecko(chain, address), goplus(chain, address)]);
  const sources = erc20 && hasCode ? await sourcesFor(chain, address, dec, gt.pools) : [];
  const best = sources.find((s) => s.usable) ?? null;
  add({ id: "pool", label: `A price pool against ${coreQuoteNames(chain)} that reads a price`, pass: sources.length ? best !== null : gt.pools === null ? null : false, hard: true, value: best ? best.label : "none found" });
  const liq = best?.reserve_usd ?? null;
  add({ id: "liquidity", label: `At least $${PAIR_MIN_LIQUIDITY_USD.toLocaleString("en-US")} in that pool`, pass: liq === null ? null : liq >= PAIR_MIN_LIQUIDITY_USD, hard: true, value: liq === null ? "unknown" : `$${Math.round(liq).toLocaleString("en-US")}` });
  const oldest = (gt.pools ?? []).map((p) => (p.attributes.pool_created_at ? Date.parse(p.attributes.pool_created_at) : NaN)).filter(Number.isFinite).sort((a, b) => a - b)[0];
  const ageDays = oldest ? Math.floor((Date.now() - oldest) / DAY_MS) : null;
  add({ id: "age", label: `Trading for at least ${PAIR_MIN_AGE_DAYS} days`, pass: ageDays === null ? null : ageDays >= PAIR_MIN_AGE_DAYS, hard: true, value: ageDays === null ? "unknown" : `${ageDays} days` });
  const holders = gt.info?.holders?.count ?? (gp?.holder_count ? Number(gp.holder_count) : null);
  add({ id: "holders", label: `At least ${PAIR_MIN_HOLDERS} holders`, pass: holders === null || !Number.isFinite(holders) ? null : holders >= PAIR_MIN_HOLDERS, hard: true, value: holders === null ? "unknown" : holders.toLocaleString("en-US") });
  if (best && erc20) {
    const holder = best.kind === "univ3" ? best.pool : launchpad(chain).v4.poolManager;
    const probe = await probeTransfer(chain, address, holder, dec);
    add({ id: "transfer", label: "Plain transfers (no fee, 0x…dEaD accepted)", pass: probe.ok, hard: true, value: probe.value });
  } else {
    add({ id: "transfer", label: "Plain transfers (no fee, 0x…dEaD accepted)", pass: null, hard: true, value: "needs a price pool to test from" });
  }

  // flags for the reviewer
  const top10 = gt.info?.holders?.distribution_percentage?.top_10;
  if (top10) add({ id: "top10", label: "Top 10 holders", pass: null, hard: false, value: `${Number(top10).toFixed(1)}% (pools and lockers included)` });
  const vol = Number(gt.token?.volume_usd?.h24 ?? NaN);
  if (Number.isFinite(vol)) add({ id: "volume", label: "Traded in the last 24 hours", pass: vol >= 1_000, hard: false, value: `$${Math.round(vol).toLocaleString("en-US")}` });
  if (gp) {
    const yes = (k: string) => gp[k] === "1";
    const tax = ["buy_tax", "sell_tax", "transfer_tax"].map((k) => Number(gp[k] ?? 0)).filter((n) => n > 0);
    const flags = [yes("is_mintable") && "mintable", yes("transfer_pausable") && "pausable", yes("is_blacklisted") && "has a blacklist", yes("hidden_owner") && "hidden owner", yes("owner_change_balance") && "owner can change balances", yes("is_honeypot") && "honeypot", tax.length > 0 && `tax ${Math.max(...tax) * 100}%`].filter(Boolean);
    add({ id: "goplus", label: "GoPlus Security (second opinion)", pass: flags.length === 0, hard: false, value: flags.length ? flags.join(", ") : "nothing flagged", link: `https://gopluslabs.io/token-security/${chainIdOf(chain)}/${address}` });
  }
  const ok = checks.filter((c) => c.hard).every((c) => c.pass === true);
  return { chain, address, symbol: sym, name: typeof name === "string" ? name.slice(0, 64) : "", decimals: dec, at, ok, checks, sources };
}

/** A small cache of recent pre-checks (10 minutes, 100 tokens), its own map so arbitrary addresses never crowd the shared memo. */
const recent = new Map<string, { at: number; p: Promise<PairPrecheck> }>();
export function cachedPrecheck(chain: ChainKey, address: string, listed: PairPublic[], now = Date.now()): Promise<PairPrecheck> {
  const key = `${chain}:${address.toLowerCase()}`;
  const hit = recent.get(key);
  if (hit && now - hit.at < 10 * 60_000) return hit.p;
  const p = precheckPair(chain, address, listed).catch((e) => {
    recent.delete(key);
    throw e;
  });
  recent.set(key, { at: now, p });
  while (recent.size > 100) recent.delete(recent.keys().next().value!);
  return p;
}
export function forgetPrecheck(chain: ChainKey, address: string): void {
  recent.delete(`${chain}:${address.toLowerCase()}`);
}
