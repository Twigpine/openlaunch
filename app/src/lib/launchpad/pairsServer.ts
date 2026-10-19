import "server-only";
import { isAddress, type Address } from "viem";
import { publicClient } from "@/lib/chain";
import { chainIdOf, chainKeyOf, type ChainKey } from "@/lib/chainPublic";
import { maybeDb, uniqueViolation } from "@/lib/db";
import { ERC20_MIN_ABI } from "./abi";
import { isOwnImageUrl } from "./images";
import { imagePublicBase } from "./imageStore";
import { adminWallets, consumeNonce, isNonce, verify } from "./postsServer";
import { tsFresh } from "./posts";
import { PAIR_CHAINS, PAIR_CHAINS_TEXT, PAIR_FEE_CHAIN, PAIR_DESCRIPTION_MAX, guardedPairPrice, pairWarmingUp, PAIR_MONITOR_EVERY_MS, PAIR_MONITOR_LIQUIDITY_USD, PAIR_SAMPLE_EVERY_MS, buildPairAdminMessage, isPairAdminAction, isPairPriceKind, isPairWebsite, isSiteLogoPath, isXHandle, nextPairStatus, pairSymbolProblem, type PairHealth, type PairListing, type PairPriceKind, type PairPublic, type PairStatus } from "./pairs";
import { codeHashOf, isCoreQuote, poolLiquidityUsd, readPairLeg, readPairUsd, samplePairSpot, univ3Tokens, univ4Key } from "./pairPrice";
import { coreQuoteNames } from "./config";
import { ensureRegistry, stockTickers } from "./stocksServer";

/**
 * Server half of community pairs (pairs.ts): the list as every request sees it (prices included, refreshed in the
 * background), the admin actions, and the hourly monitor that suspends a pair whose checks fail.
 */
type PairDbRow = {
  chain_id: number; address: string; symbol: string; name: string; decimals: number; logo_url: string | null; website: string | null; x_handle: string | null; description: string | null;
  status: PairStatus; status_by: "admin" | "monitor"; status_reason: string | null; status_at: Date | string; price_kind: PairPriceKind; price_pool: string; price_quote: string; price_hook: string | null;
  code_hash: string | null; failing_since: Date | string | null; checked_at: Date | string | null; listed_at: Date | string;
};
const iso = (v: Date | string) => new Date(v).toISOString();

function publicOf(r: PairDbRow, usd: number | null): PairPublic | null {
  const chain = chainKeyOf(r.chain_id);
  if (!chain) return null;
  return {
    chain, address: r.address, symbol: r.symbol, name: r.name, decimals: r.decimals, logo: r.logo_url, website: r.website, x_handle: r.x_handle, description: r.description,
    status: r.status, status_reason: r.status_reason, status_at: iso(r.status_at), listed_at: iso(r.listed_at),
    price_kind: r.price_kind, price_pool: r.price_pool, price_quote: r.price_quote, price_hook: r.price_hook, usd,
    checked_at: r.checked_at ? iso(r.checked_at) : null, failing_since: r.failing_since ? iso(r.failing_since) : null,
  };
}

async function readAll(): Promise<PairPublic[]> {
  const db = maybeDb();
  if (!db) return [];
  const rows = await db<PairDbRow[]>`SELECT * FROM bb_pairs WHERE chain_id = ANY(${PAIR_CHAINS.map((c) => chainIdOf(c))}) ORDER BY listed_at, address`;
  const out = await Promise.all(
    rows.map(async (r) => {
      const chain = chainKeyOf(r.chain_id);
      if (!chain) return null;
      const usd = r.status === "listed" ? (await readPairUsd({ chain, address: r.address, decimals: r.decimals, price_kind: r.price_kind, price_pool: r.price_pool, price_quote: r.price_quote })).usd : null;
      return publicOf(r, usd);
    }),
  );
  return out.filter((p): p is PairPublic => p !== null);
}

/**
 * The list now, prices included. Stale-while-revalidate like the GITLAWB price: fresh for 15 s; after that the last
 * list is served at once and one refresh runs; a cold process waits up to 4 s for the first read. A failed refresh
 * keeps the last good list. Never throws: with nothing read yet the answer is an empty list (pairs show as unlisted).
 */
let pairsNow: PairPublic[] = [];
let goodAt = 0;
let refreshedAt = 0;
let inflight: Promise<void> | null = null;
// every read is numbered when it starts: a read that started before a write never replaces one that started after it
let started = 0;
let applied = 0;
const FRESH_MS = 15_000;
const COLD_WAIT_MS = 4_000;

function read(): Promise<void> {
  const gen = ++started;
  return readAll()
    .then((list) => {
      if (gen < applied) return;
      applied = gen;
      pairsNow = list;
      goodAt = Date.now();
    })
    .catch((err) => console.warn("[pairs] list read failed:", err instanceof Error ? err.message : err))
    .finally(() => {
      refreshedAt = Date.now();
    });
}
function refresh(): Promise<void> {
  return (inflight ??= read().finally(() => {
    inflight = null;
  }));
}

export async function loadPairs(): Promise<PairPublic[]> {
  if (Date.now() - refreshedAt >= FRESH_MS) {
    const p = refresh();
    if (goodAt === 0) await Promise.race([p, new Promise<void>((r) => setTimeout(r, COLD_WAIT_MS).unref?.())]);
  }
  return pairsNow;
}
/** After a write: a read that starts now, so it sees the write (a refresh already running may have read before it). Other machines catch up within 15 s. */
export async function reloadPairs(): Promise<PairPublic[]> {
  await read();
  return pairsNow;
}

/** One pair by address, any status (null when never listed). */
export async function pairByAddress(chain: ChainKey, address: string): Promise<PairPublic | null> {
  const a = address.toLowerCase();
  return (await loadPairs()).find((p) => p.chain === chain && p.address === a) ?? null;
}

export type PairStats = { launches: number; launches_24h: number; volume_quote: string };
/** Launches paired with each pair, and their all-time volume in the pair token (raw units). */
export async function pairStats(chain: ChainKey, addresses: string[]): Promise<Map<string, PairStats>> {
  const db = maybeDb();
  if (!db || addresses.length === 0) return new Map();
  const rows = await db<{ quote: string; launches: number; launches_24h: number; volume_quote: string }[]>`
    SELECT quote, count(*)::int AS launches, count(*) FILTER (WHERE block_time > now() - interval '24 hours')::int AS launches_24h, COALESCE(sum(volume_quote), 0)::text AS volume_quote
      FROM bb_launches WHERE chain_id = ${chainIdOf(chain)} AND quote = ANY(${addresses.map((a) => a.toLowerCase())}) GROUP BY quote`;
  return new Map(rows.map((r) => [r.quote, { launches: r.launches, launches_24h: r.launches_24h, volume_quote: r.volume_quote }]));
}

export type PairEvent = { status: PairStatus; reason: string | null; actor: string; created_at: string };
export async function pairEvents(chain: ChainKey, address: string): Promise<PairEvent[]> {
  const db = maybeDb();
  if (!db) return [];
  const rows = await db<{ status: PairStatus; reason: string | null; actor: string; created_at: Date }[]>`
    SELECT status, reason, actor, created_at FROM bb_pair_events WHERE chain_id = ${chainIdOf(chain)} AND address = ${address.toLowerCase()} ORDER BY created_at DESC, id DESC LIMIT 50`;
  return rows.map((r) => ({ status: r.status, reason: r.reason, actor: r.actor, created_at: iso(r.created_at) }));
}

/* ─────────────────────────────── admin ─────────────────────────────── */

type Fail = { ok: false; error: string; status: number };
const fail = (error: string, status: number): Fail => ({ ok: false, error, status });
/** A trimmed string field. Never cut short here: the signed message carries the whole text, so an over-long one is refused instead. */
const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const MAX = { logo: 300, website: 200, x: 16, pool: 66, quote: 42, hook: 42, reason: 200 } as const;

/** The listing fields from a request, cleaned; an error names the first bad one. */
export function readListing(b: Record<string, unknown>): { ok: true; listing: PairListing } | Fail {
  const logo = text(b.logo);
  const website = text(b.website);
  const x = text(b.x_handle).replace(/^@/, "");
  const description = text(b.description);
  const pool = text(b.price_pool).toLowerCase();
  const quote = text(b.price_quote).toLowerCase();
  const hook = b.price_kind === "univ4" ? text(b.price_hook).toLowerCase() : "";
  if (logo.length > MAX.logo || website.length > MAX.website || x.length > MAX.x || pool.length > MAX.pool || quote.length > MAX.quote || hook.length > MAX.hook) return fail("a field is too long", 400);
  if (!isPairPriceKind(b.price_kind)) return fail("bad price kind", 400);
  if (logo && !isSiteLogoPath(logo) && !isOwnImageUrl(logo, imagePublicBase())) return fail("the logo must be uploaded here (our image host)", 400);
  if (website && !isPairWebsite(website)) return fail("the website must be an https link", 400);
  if (x && !isXHandle(x)) return fail("bad X handle", 400);
  if (description.length > PAIR_DESCRIPTION_MAX) return fail(`the description is over ${PAIR_DESCRIPTION_MAX} characters`, 400);
  if (b.price_kind === "univ4" ? !/^0x[0-9a-f]{64}$/.test(pool) : !isAddress(pool)) return fail(b.price_kind === "univ4" ? "a v4 pool is named by its 32-byte pool id" : "bad pool address", 400);
  if (!isAddress(quote)) return fail("bad quote address", 400);
  if (hook && !isAddress(hook)) return fail("bad hook address", 400);
  return { ok: true, listing: { logo, website, x_handle: x, description, price_kind: b.price_kind, price_pool: pool, price_quote: quote, price_hook: hook } };
}

/** What can be read about the token and its price pool before it is listed or changed; an error says what is wrong. */
async function inspect(chain: ChainKey, address: string, l: PairListing, others: PairPublic[]): Promise<{ ok: true; symbol: string; name: string; decimals: number; code_hash: string } | Fail> {
  if (isCoreQuote(chain, address)) return fail("a core quote cannot be a community pair", 400);
  if (!isCoreQuote(chain, l.price_quote)) return fail(`the price pool must be against a core quote (${coreQuoteNames(chain)})`, 400);
  const client = publicClient(chain);
  const code_hash = await codeHashOf(chain, address).catch(() => null);
  if (!code_hash) return fail("no contract code at that address (or the chain could not be read)", 400);
  const [symbol, name, decimals] = await Promise.all([
    client.readContract({ address: address as Address, abi: ERC20_MIN_ABI, functionName: "symbol" }).catch(() => null),
    client.readContract({ address: address as Address, abi: ERC20_MIN_ABI, functionName: "name" }).catch(() => null),
    client.readContract({ address: address as Address, abi: ERC20_MIN_ABI, functionName: "decimals" }).catch(() => null),
  ]);
  if (typeof symbol !== "string" || typeof name !== "string" || typeof decimals !== "number") return fail("it does not read as an ERC-20 (symbol, name, decimals)", 400);
  if (decimals < 6 || decimals > 18) return fail("decimals must be 6 to 18", 400);
  const clean = symbol.normalize("NFKC").replace(/^\$/, "").trim();
  await ensureRegistry().catch(() => null); // Robinhood's stock tickers
  const stocks = stockTickers(chain);
  if (!stocks) return fail("the chain's stock list could not be read to rule out a stock's ticker; try again", 503);
  const problem = pairSymbolProblem(clean, others.filter((p) => p.status === "listed" && !(p.chain === chain && p.address === address)).map((p) => p.symbol), stocks);
  if (problem) return fail(problem, 400);
  const src = { chain, address, decimals, price_kind: l.price_kind, price_pool: l.price_pool, price_quote: l.price_quote };
  if (l.price_kind === "launch") {
    const db = maybeDb()!;
    const [row] = await db<{ quote: string }[]>`SELECT quote FROM bb_launches WHERE chain_id = ${chainIdOf(chain)} AND token = ${l.price_pool}`;
    if (!row) return fail("that openlaunch pool is not indexed: price_pool must be the launched token", 400);
    if (row.quote !== l.price_quote) return fail("that openlaunch pool is quoted in another token", 400);
    if (l.price_pool !== address) return fail("an openlaunch price pool is the pair token's own launch", 400);
  } else if (l.price_kind === "univ3") {
    const tokens = await univ3Tokens(chain, l.price_pool).catch(() => null);
    if (!tokens) return fail("that is not a Uniswap v3 style pool", 400);
    if (![address, l.price_quote].every((t) => tokens.includes(t))) return fail("that pool does not trade this token against that quote", 400);
  } else {
    // a v4 pool is named by its id alone: read its key, so the pool is this token against that quote, and its hook is the one named
    const key = await univ4Key(chain, l.price_pool).catch(() => null);
    if (!key) return fail("the v4 PositionManager does not know that pool id", 400);
    if (![address, l.price_quote].every((t) => [key.currency0, key.currency1].includes(t))) return fail("that v4 pool does not trade this token against that quote", 400);
    const hook = key.hooks === "0x0000000000000000000000000000000000000000" ? "" : key.hooks;
    if (hook !== l.price_hook) return fail(hook ? `that pool has a hook (${hook}): name it to list against it` : "that pool has no hook: leave the hook empty", 400);
  }
  // the pool must give a price now (a v4 pool its spot: its average needs 20 minutes of samples after listing)
  const leg = await readPairLeg(src).catch((e: unknown) => e as Error);
  if (leg instanceof Error) return fail(`the price pool could not be read: ${leg.message}`, 400);
  if (leg.spot === null) return fail("the price pool gives no price", 400);
  if (l.price_kind === "univ3" && leg.twap === null) return fail("that pool has no 30-minute oracle history: pick another pool, or a v4 pool", 400);
  // the monitor suspends a pair whose pool holds less than its line: never list one that would start failing at once
  const poolId = l.price_kind === "launch" ? (await maybeDb()!<{ pool_id: string }[]>`SELECT pool_id FROM bb_launches WHERE chain_id = ${chainIdOf(chain)} AND token = ${l.price_pool}`)[0]?.pool_id : l.price_pool;
  const liq = poolId ? await poolLiquidityUsd(chain, poolId) : null;
  if (liq !== null && liq < PAIR_MONITOR_LIQUIDITY_USD) return fail(`that pool holds about $${Math.round(liq).toLocaleString("en-US")}, under the $${PAIR_MONITOR_LIQUIDITY_USD.toLocaleString("en-US")} the monitor requires`, 400);
  return { ok: true, symbol: clean, name: name.slice(0, 64), decimals, code_hash };
}

class SymbolTaken extends Error {}

/**
 * Write a listing (a new one, a relisting of a delisted pair, or a change), after reading the token and its pool
 * (inspect). Shared by the admin "list" / "update" actions and an approved application, so both pass the same checks.
 * `actor` goes on the public record.
 */
export async function writeListing(chain: ChainKey, address: string, l: PairListing, actor: string, mode: "list" | "update", cur?: PairDbRow | null, others?: PairPublic[]): Promise<{ ok: true } | Fail> {
  try {
    return await write(chain, address, l, actor, mode, cur, others);
  } catch (e) {
    if (e instanceof SymbolTaken) return fail(e.message, 409);
    throw e;
  }
}
async function write(chain: ChainKey, address: string, l: PairListing, actor: string, mode: "list" | "update", cur?: PairDbRow | null, others?: PairPublic[]): Promise<{ ok: true } | Fail> {
  const db = maybeDb();
  if (!db) return fail("db unconfigured", 503);
  const cid = chainIdOf(chain);
  const row = cur !== undefined ? cur : ((await db<PairDbRow[]>`SELECT * FROM bb_pairs WHERE chain_id = ${cid} AND address = ${address}`)[0] ?? null);
  if (mode === "list" && row && row.status !== "delisted") return fail("already listed: use update", 409);
  if (mode === "update" && !row) return fail("not listed", 404);
  const got = await inspect(chain, address, l, others ?? (await loadPairs()));
  if (!got.ok) return got;
  if (mode === "list") {
    await dbWrite(() => db`
      INSERT INTO bb_pairs (chain_id, address, symbol, name, decimals, logo_url, website, x_handle, description, status, status_by, status_reason, status_at, price_kind, price_pool, price_quote, price_hook, code_hash, failing_since, checked_at, listed_at)
      VALUES (${cid}, ${address}, ${got.symbol}, ${got.name}, ${got.decimals}, ${l.logo || null}, ${l.website || null}, ${l.x_handle || null}, ${l.description || null}, 'listed', 'admin', NULL, now(), ${l.price_kind}, ${l.price_pool}, ${l.price_quote}, ${l.price_hook || null}, ${got.code_hash}, NULL, NULL, now())
      ON CONFLICT (chain_id, address) DO UPDATE SET symbol = EXCLUDED.symbol, name = EXCLUDED.name, decimals = EXCLUDED.decimals, logo_url = EXCLUDED.logo_url, website = EXCLUDED.website, x_handle = EXCLUDED.x_handle,
        description = EXCLUDED.description, status = 'listed', status_by = 'admin', status_reason = NULL, status_at = now(), price_kind = EXCLUDED.price_kind, price_pool = EXCLUDED.price_pool,
        price_quote = EXCLUDED.price_quote, price_hook = EXCLUDED.price_hook, code_hash = EXCLUDED.code_hash, failing_since = NULL, checked_at = NULL, listed_at = now()`);
    await db`INSERT INTO bb_pair_events (chain_id, address, status, reason, actor) VALUES (${cid}, ${address}, 'listed', NULL, ${actor})`;
  } else {
    await dbWrite(() => db`
      UPDATE bb_pairs SET symbol = ${got.symbol}, name = ${got.name}, decimals = ${got.decimals}, logo_url = ${l.logo || null}, website = ${l.website || null}, x_handle = ${l.x_handle || null}, description = ${l.description || null},
        price_kind = ${l.price_kind}, price_pool = ${l.price_pool}, price_quote = ${l.price_quote}, price_hook = ${l.price_hook || null}
       WHERE chain_id = ${cid} AND address = ${address}`);
  }
  return { ok: true };
}

/** A write that may meet the one-listed-symbol-per-chain index: that conflict becomes a clear refusal. */
async function dbWrite(run: () => PromiseLike<unknown>): Promise<void> {
  try {
    await run();
  } catch (e) {
    if (uniqueViolation(e)) throw new SymbolTaken("another listed pair already has this symbol");
    throw e;
  }
}

/**
 * An admin action on a pair: an ADMIN_WALLETS signature over buildPairAdminMessage (the listing fields included), a
 * single-use nonce, a fresh timestamp. Every change is written to the pair's public record.
 */
export async function moderatePair(b: Record<string, unknown>): Promise<{ ok: true; pair: PairPublic | null } | Fail> {
  try {
    return await moderate(b);
  } catch (e) {
    if (e instanceof SymbolTaken) return fail(e.message, 409);
    throw e;
  }
}
async function moderate(b: Record<string, unknown>): Promise<{ ok: true; pair: PairPublic | null } | Fail> {
  const db = maybeDb();
  if (!db) return fail("db unconfigured", 503);
  if (typeof b.wallet !== "string" || !isAddress(b.wallet)) return fail("bad wallet", 400);
  const wallet = b.wallet.toLowerCase();
  const action: unknown = b.action;
  if (!isPairAdminAction(action)) return fail("bad action", 400);
  const chain = PAIR_CHAINS.find((c) => c === b.chain);
  if (!chain) return fail(`pairs are listed on ${PAIR_CHAINS_TEXT} only`, 400);
  if (typeof b.address !== "string" || !isAddress(b.address)) return fail("bad pair address", 400);
  const address = b.address.toLowerCase();
  if (!isNonce(b.nonce) || !tsFresh(b.ts, Date.now())) return fail("stale or bad nonce", 400);
  if (!adminWallets().has(wallet)) return fail("admin only", 403);
  const withListing = action === "list" || action === "update";
  const parsed = withListing ? readListing(b) : null;
  if (parsed && !parsed.ok) return parsed;
  const listing = parsed?.ok ? parsed.listing : undefined;
  const reason = withListing ? undefined : text(b.reason);
  if ((action === "suspend" || action === "delist") && !reason) return fail("say why", 400);
  if (reason && reason.length > MAX.reason) return fail(`the reason is over ${MAX.reason} characters`, 400);
  const message = buildPairAdminMessage({ action, chain, address, wallet, nonce: b.nonce, ts: Number(b.ts), listing, reason });
  // signed on Base like every pair signature (PAIR_FEE_CHAIN), whatever chain the pair is on
  if (!(await verify(PAIR_FEE_CHAIN, wallet, message, b.signature))) return fail("signature does not match", 401);
  if (!(await consumeNonce(b.nonce, wallet))) return fail("nonce already used", 401);

  const cid = chainIdOf(chain);
  const [cur] = await db<PairDbRow[]>`SELECT * FROM bb_pairs WHERE chain_id = ${cid} AND address = ${address}`;
  const others = await loadPairs();
  const event = async (status: PairStatus, why: string | null) => {
    await db`INSERT INTO bb_pair_events (chain_id, address, status, reason, actor) VALUES (${cid}, ${address}, ${status}, ${why}, ${wallet})`;
  };

  if (action === "list" || action === "update") {
    const w = await writeListing(chain, address, listing!, wallet, action, cur ?? null, others);
    if (!w.ok) return w;
  } else {
    if (!cur) return fail("not listed", 404);
    const next: PairStatus = action === "reinstate" ? "listed" : action === "suspend" ? "suspended" : "delisted";
    if (action === "suspend" && cur.status !== "listed") return fail("only a listed pair can be suspended", 409);
    if (action === "delist" && cur.status === "delisted") return fail("already delisted", 409);
    if (action === "reinstate" && cur.status === "listed") return fail("already listed", 409);
    // reinstating vouches for the code as it is now: the monitor compares against this from here on
    const code = action === "reinstate" ? await codeHashOf(chain, address).catch(() => null) : cur.code_hash;
    if (action === "reinstate" && !code) return fail("no contract code at that address (or the chain could not be read)", 400);
    await dbWrite(() => db`UPDATE bb_pairs SET status = ${next}, status_by = 'admin', status_reason = ${reason || null}, status_at = now(), failing_since = NULL, code_hash = ${code} WHERE chain_id = ${cid} AND address = ${address}`);
    await event(next, reason || null);
  }
  const list = await reloadPairs();
  return { ok: true, pair: list.find((p) => p.chain === chain && p.address === address) ?? null };
}

/* ─────────────────────────────── monitor ─────────────────────────────── */

/**
 * One reading of a pair's health: its code, its pool's own price (spot and 30-minute average), its pool's liquidity.
 * Unknown (null) when the chain cannot be read. The core quote's USD price is not the pair's to answer for: an ETH or
 * GITLAWB price outage hides USD everywhere, and must never suspend every pair priced against it. `code` is the hash
 * read now, so a pair listed without one (the seeded MUSEWORLD) is pinned on its first check.
 */
export async function checkPair(r: PairDbRow, chain: ChainKey): Promise<{ health: PairHealth; code: string | null }> {
  const hash = await codeHashOf(chain, r.address).catch(() => undefined);
  if (hash === undefined) return { health: null, code: null };
  // "no code" fails softly: one lagging node can answer 0x, and a real token's code cannot vanish (SELFDESTRUCT no longer
  // deletes it), so it takes 24 hours of failing checks. Different code (a swapped implementation) still suspends at once.
  if (hash === null) return { health: { ok: false, hard: false, reason: "No contract code read at its address." }, code: null };
  if (r.code_hash && hash !== r.code_hash) return { health: { ok: false, hard: true, reason: "Its contract code changed." }, code: hash };
  return { health: await poolHealth(r, chain), code: hash };
}
async function poolHealth(r: PairDbRow, chain: ChainKey): Promise<PairHealth> {
  const leg = await readPairLeg({ chain, address: r.address, decimals: r.decimals, price_kind: r.price_kind, price_pool: r.price_pool, price_quote: r.price_quote }).catch((e: unknown) => e as Error);
  if (leg instanceof Error) return { ok: false, hard: false, reason: `Its price pool cannot be read: ${leg.message}.` };
  // a v4 pool's average comes from our own minute samples: a pair listed minutes ago has none yet, which is not a failure
  // (only the missing average is excused: a bad spot fails as before, and liquidity is still checked below)
  const warming = leg.twap === null && leg.spot !== null && leg.spot > 0 && pairWarmingUp(r.price_kind, new Date(r.listed_at).getTime(), Date.now());
  if (!warming && guardedPairPrice(leg.spot, leg.twap).price === null) return { ok: false, hard: false, reason: leg.twap === null ? "No 30-minute average from its price pool." : "Its price pool gives no price." };
  const poolId = r.price_kind === "launch" ? (await maybeDb()!<{ pool_id: string }[]>`SELECT pool_id FROM bb_launches WHERE chain_id = ${r.chain_id} AND token = ${r.price_pool}`)[0]?.pool_id : r.price_pool;
  const liq = poolId ? await poolLiquidityUsd(chain, poolId) : null;
  if (liq !== null && liq < PAIR_MONITOR_LIQUIDITY_USD) return { ok: false, hard: false, reason: `Its price pool holds about $${Math.round(liq).toLocaleString("en-US")}, under $${PAIR_MONITOR_LIQUIDITY_USD.toLocaleString("en-US")}.` };
  return warming ? null : { ok: true };
}

let lastMonitor = 0;
let lastSample = 0;
let lastPrune = 0;
let monitoring = false;

/**
 * Called from the sync loop on every machine. Samples v4 price pools once a minute, and checks each listed or
 * monitor-suspended pair about hourly: a pair is claimed by one machine at a time (checked_at moves forward in the
 * same UPDATE that picks it), so two machines never write the same change twice.
 */
export async function pairsTick(now = Date.now()): Promise<void> {
  const db = maybeDb();
  if (!db) return;
  if (now - lastSample >= PAIR_SAMPLE_EVERY_MS) {
    lastSample = now;
    const v4 = (await loadPairs()).filter((p) => p.status !== "delisted" && p.price_kind === "univ4");
    await Promise.all(v4.map((p) => samplePairSpot(p).catch((e) => console.warn(`[pairs] sample ${p.symbol}:`, e instanceof Error ? e.message : e))));
  }
  if (now - lastPrune >= 6 * 3_600_000) {
    lastPrune = now;
    await db`DELETE FROM bb_pair_prices WHERE t < now() - interval '7 days'`.catch(() => {});
  }
  if (monitoring || now - lastMonitor < 60_000) return;
  lastMonitor = now;
  monitoring = true;
  try {
    const claimed = await db<PairDbRow[]>`
      UPDATE bb_pairs SET checked_at = now()
       WHERE (chain_id, address) IN (
         SELECT chain_id, address FROM bb_pairs
          WHERE chain_id = ANY(${PAIR_CHAINS.map((c) => chainIdOf(c))}) AND status <> 'delisted' AND NOT (status = 'suspended' AND status_by = 'admin')
            AND (checked_at IS NULL OR checked_at < now() - ${`${Math.round(PAIR_MONITOR_EVERY_MS / 1000)} seconds`}::interval)
          ORDER BY checked_at NULLS FIRST LIMIT 5 FOR UPDATE SKIP LOCKED)
      RETURNING *`;
    let changed = false;
    for (const r of claimed) {
      const chain = chainKeyOf(r.chain_id);
      if (!chain) continue;
      const { health, code } = await checkPair(r, chain).catch(() => ({ health: null, code: null }));
      const step = nextPairStatus({ status: r.status, status_by: r.status_by, status_at: new Date(r.status_at).getTime(), failing_since: r.failing_since ? new Date(r.failing_since).getTime() : null }, health, Date.now());
      // only if nothing changed the row while it was checked (an admin's suspension must never be written over); a JS Date holds
      // milliseconds and Postgres microseconds, so the timestamps are compared at milliseconds
      const done = await db`UPDATE bb_pairs SET status = ${step.status}, status_by = ${step.status_by}, status_at = to_timestamp(${step.status_at / 1000}), failing_since = ${step.failing_since === null ? null : new Date(step.failing_since)},
                 status_reason = ${step.changed ? step.reason : r.status_reason}, code_hash = COALESCE(code_hash, ${code})
                 WHERE chain_id = ${r.chain_id} AND address = ${r.address} AND status = ${r.status} AND status_by = ${r.status_by} AND date_trunc('milliseconds', status_at) = date_trunc('milliseconds', ${new Date(r.status_at)}::timestamptz)
                 RETURNING address`;
      if (done.length === 0) continue;
      if (step.changed) {
        changed = true;
        await db`INSERT INTO bb_pair_events (chain_id, address, status, reason, actor) VALUES (${r.chain_id}, ${r.address}, ${step.status}, ${step.reason}, 'monitor')`;
        console.log(`[pairs] ${r.symbol} ${r.status} → ${step.status}: ${step.reason}`);
      } else if (health && !health.ok) {
        console.warn(`[pairs] ${r.symbol} failing: ${health.reason}`);
      }
    }
    if (changed) await reloadPairs();
  } finally {
    monitoring = false;
  }
}
