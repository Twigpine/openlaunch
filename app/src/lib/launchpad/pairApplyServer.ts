import "server-only";
import { isAddress } from "viem";
import { chainIdOf, chainKeyOf, type ChainKey } from "@/lib/chainPublic";
import { maybeDb, uniqueViolation } from "@/lib/db";
import { adminWallets, consumeNonce, isNonce, verify } from "./postsServer";
import { tsFresh } from "./posts";
import { gitlawbUsdParts } from "./gitlawbServer";
import { PAIR_CHAINS, PAIR_CHAINS_TEXT, PAIR_FEE_CHAIN, type PairPriceKind } from "./pairs";
import { loadPairs, readListing, reloadPairs, writeListing } from "./pairsServer";
import { cachedPrecheck, forgetPrecheck, type PairPrecheck } from "./pairCheck";
import {
  PAIR_APPLY_OPEN_MAX,
  PAIR_FEE_TOLERANCE,
  PAIR_QUOTE_LOCK_MS,
  PAIR_QUOTE_SETTLE_MS,
  PAIR_FEE_WAIVED,
  PAIR_REVIEWS_MAX,
  PAIR_REVIEW_WINDOW_MS,
  PAIR_UNPAID_EXPIRE_MS,
  applicationCode,
  buildPairApplyMessage,
  buildPairReviewMessage,
  canAskAgain,
  isPairApplyAction,
  isPaid,
  isPairReviewDecision,
  pairBurnAmount,
  pairBurnUsd,
  pairFeeQuote,
  pairListingUsd,
  pairSettlingUntil,
  proofPostUrl,
  sourceLabel,
  type PairApplicationStatus,
  type PairBurnRow,
} from "./pairApply";

/**
 * Server half of applying to list a community pair (pairApply.ts states the rule): the free pre-check, the signed
 * application, the fee quote, the burns the indexer records, and the admin's decision, which lists an approved pair
 * through the same checks as an admin listing (pairsServer.writeListing).
 */
export function applicationsOpen(): boolean {
  return process.env.PAIRS_APPLY === "on";
}

type Fail = { ok: false; error: string; status: number };
const fail = (error: string, status: number): Fail => ({ ok: false, error, status });

export async function precheckToken(chain: ChainKey, address: string): Promise<PairPrecheck> {
  return cachedPrecheck(chain, address, await loadPairs());
}

type AppRow = {
  quote_at: Date | null;
  id: string; chain_id: number; address: string; applicant: string; code: string; symbol: string; name: string; decimals: number;
  price_kind: PairPriceKind; price_pool: string; price_quote: string; price_hook: string | null; logo_url: string | null; website: string | null; x_handle: string | null; description: string | null; proof_url: string | null;
  precheck: PairPrecheck; status: PairApplicationStatus; fee_usd: number; paid_usd: number; paid_at: Date | null; quote_twig: string | null; quote_price_usd: number | null; quote_until: Date | null; last_quote_until: Date | null;
  reviews_used: number; reason: string | null; decided_by: string | null; decided_at: Date | null; created_at: Date;
};
export type PairBurnPublic = { tx_hash: string; sender: string; twig: string; usd: number | null; priced_by: "quote" | "live" | null; block_time: string };
export type PairApplicationPublic = {
  id: number; chain: ChainKey; address: string; applicant: string; code: string; symbol: string; name: string; decimals: number;
  price_kind: PairPriceKind; price_pool: string; price_quote: string; price_hook: string | null; logo: string | null; website: string | null; x_handle: string | null; description: string | null; proof_url: string | null;
  precheck: PairPrecheck; status: PairApplicationStatus; fee_usd: number; paid_usd: number; paid_at: string | null;
  quote: { twig: string; price_usd: number; until: string; amount: string } | null;
  /** A fee transfer may still be on its way until then (a fee quote is live or ended within the hour): no waiver before. */
  settling_until: string | null;
  reviews_used: number; reviews_max: number; reason: string | null; decided_at: string | null; created_at: string; can_ask_again: boolean; burns: PairBurnPublic[];
};
const iso = (v: Date | number | null) => (v ? new Date(v).toISOString() : null);
/** Until when a fee transfer may still be on its way: from the latest quote's end, which a landed burn does not erase. */
const settlingUntil = (r: AppRow) => {
  const ends = [r.quote_until, r.last_quote_until].filter((d) => d).map((d) => new Date(d!).getTime());
  return pairSettlingUntil(ends.length ? Math.max(...ends) : null, Date.now());
};

function publicOf(r: AppRow, burns: PairBurnPublic[]): PairApplicationPublic {
  const live = r.quote_until && r.quote_twig && r.quote_price_usd && new Date(r.quote_until).getTime() > Date.now();
  return {
    id: Number(r.id), chain: chainKeyOf(r.chain_id) ?? PAIR_CHAINS[0], address: r.address, applicant: r.applicant, code: r.code, symbol: r.symbol, name: r.name, decimals: r.decimals,
    price_kind: r.price_kind, price_pool: r.price_pool, price_quote: r.price_quote, price_hook: r.price_hook, logo: r.logo_url, website: r.website, x_handle: r.x_handle, description: r.description, proof_url: r.proof_url,
    precheck: r.precheck, status: r.status, fee_usd: r.fee_usd, paid_usd: r.paid_usd, paid_at: iso(r.paid_at),
    quote: live ? { twig: String(r.quote_twig), price_usd: r.quote_price_usd!, until: iso(r.quote_until)!, amount: pairBurnAmount(BigInt(r.quote_twig!), Number(r.id)).toString() } : null,
    settling_until: iso(settlingUntil(r)),
    reviews_used: r.reviews_used, reviews_max: PAIR_REVIEWS_MAX, reason: r.reason, decided_at: iso(r.decided_at), created_at: iso(r.created_at)!,
    can_ask_again: canAskAgain({ status: r.status, reviews_used: r.reviews_used, paid_at: r.paid_at ? new Date(r.paid_at).getTime() : null }, Date.now()),
    burns,
  };
}

export async function getApplication(id: number): Promise<PairApplicationPublic | null> {
  const db = maybeDb();
  if (!db || !Number.isSafeInteger(id) || id <= 0) return null;
  const [r] = await db<AppRow[]>`SELECT * FROM bb_pair_applications WHERE id = ${id}`;
  if (!r) return null;
  const burns = await db<{ tx_hash: string; sender: string; twig: string; usd: number | null; priced_by: "quote" | "live" | null; block_time: Date }[]>`
    SELECT tx_hash, sender, twig::text AS twig, usd, priced_by, block_time FROM bb_pair_burns WHERE application_id = ${id} ORDER BY block_time, log_index`;
  return publicOf(r, burns.map((b) => ({ ...b, block_time: iso(b.block_time)! })));
}

/** The queue: applications in progress first (paid ones, oldest first, are the reviewer's), then the latest decided ones. */
export async function listApplications(): Promise<PairApplicationPublic[]> {
  const db = maybeDb();
  if (!db) return [];
  const rows = await db<AppRow[]>`
    (SELECT * FROM bb_pair_applications WHERE status IN ('paid', 'changes', 'open') ORDER BY (status = 'paid') DESC, created_at LIMIT 100)
    UNION ALL
    (SELECT * FROM bb_pair_applications WHERE status IN ('approved', 'rejected') ORDER BY decided_at DESC NULLS LAST LIMIT 20)`;
  return rows.map((r) => publicOf(r, []));
}

/**
 * Applications that no longer hold their token's place: unpaid (no fee and no burn at all) after 48 hours, and "changes"
 * whose 60-day review window has closed. Both become "expired", so a token is never blocked by an abandoned one. Run
 * before every new application for the token, and from the sync loop for all of them.
 */
export async function expireStaleApplications(chain?: ChainKey, address?: string): Promise<number> {
  const db = maybeDb();
  if (!db) return 0;
  const scope = chain && address ? db`AND chain_id = ${chainIdOf(chain)} AND address = ${address}` : db``;
  const rows = await db`
    UPDATE bb_pair_applications a SET status = 'expired', reason = CASE WHEN a.status = 'open' THEN 'Not paid within 48 hours.' ELSE 'The review window closed.' END, decided_at = now()
     WHERE ((a.status = 'open' AND a.paid_usd = 0 AND a.created_at < now() - ${`${PAIR_UNPAID_EXPIRE_MS / 1000} seconds`}::interval
             -- never while a fee quote is live, nor in the hour after it (a transfer sent under it may still be indexing)
             AND (a.quote_until IS NULL OR a.quote_until < now() - ${`${PAIR_QUOTE_SETTLE_MS / 1000} seconds`}::interval)
             -- only burns sent for it count: a stray one sent before it existed must not keep it alive
             AND NOT EXISTS (SELECT 1 FROM bb_pair_burns b WHERE b.application_id = a.id AND b.block_time >= a.created_at))
        OR (a.status = 'changes' AND a.paid_at < now() - ${`${PAIR_REVIEW_WINDOW_MS / 1000} seconds`}::interval)) ${scope}
    RETURNING id`;
  return rows.length;
}

/** Whether a wallet has a visible profile with a verified X account: the identity an application rests on. */
async function verifiedProfile(wallet: string): Promise<boolean> {
  const db = maybeDb()!;
  const [row] = await db`SELECT 1 FROM bb_profiles WHERE wallet = ${wallet} AND x_status = 'verified' AND NOT hidden AND deleted_at IS NULL`;
  return Boolean(row);
}

/**
 * The applicant's signed actions: "apply" (a new application, once the pre-check passes, with the price pool picked
 * from the pre-check's pools), "proof" (the community's proof post), "again" (another review after changes were asked).
 */
export async function applicantAction(b: Record<string, unknown>): Promise<{ ok: true; id: number; code: string } | Fail> {
  const db = maybeDb();
  if (!db) return fail("db unconfigured", 503);
  if (!applicationsOpen()) return fail("applications are not open yet", 503);
  if (typeof b.wallet !== "string" || !isAddress(b.wallet)) return fail("bad wallet", 400);
  const wallet = b.wallet.toLowerCase();
  if (!isPairApplyAction(b.action)) return fail("bad action", 400);
  const action = b.action;
  const chain = PAIR_CHAINS.find((c) => c === b.chain);
  if (!chain) return fail(`pairs are listed on ${PAIR_CHAINS_TEXT} only`, 400);
  if (typeof b.address !== "string" || !isAddress(b.address)) return fail("bad token address", 400);
  const address = b.address.toLowerCase();
  if (!isNonce(b.nonce) || !tsFresh(b.ts, Date.now())) return fail("stale or bad nonce", 400);
  const id = action === "apply" ? undefined : Number(b.id);
  if (id !== undefined && !(Number.isSafeInteger(id) && id > 0)) return fail("bad application", 400);
  const parsed = action === "apply" ? readListing(b) : null;
  if (parsed && !parsed.ok) return parsed;
  const l = parsed?.ok ? parsed.listing : null;
  const proof = action === "proof" ? proofPostUrl(typeof b.proof === "string" ? b.proof : "") : null;
  if (action === "proof" && !proof) return fail("the proof must be a link to a post on X", 400);
  const message = buildPairApplyMessage({ action, chain, address, wallet, nonce: b.nonce, ts: Number(b.ts), id, ...(l ? { source: sourceLabel(l), website: l.website, x_handle: l.x_handle, logo: l.logo, description: l.description } : {}), ...(proof ? { proof } : {}) });
  // signed on Base, where the applicant pays, whatever chain the pair is on (a smart wallet is checked where it lives)
  if (!(await verify(PAIR_FEE_CHAIN, wallet, message, b.signature))) return fail("signature does not match", 401);
  if (!(await consumeNonce(b.nonce, wallet))) return fail("nonce already used", 401);
  const cid = chainIdOf(chain);

  if (action === "apply") {
    if (!(await verifiedProfile(wallet))) return fail("applying needs an openlaunch profile with a verified X account", 403);
    await expireStaleApplications(chain, address);
    const pre = await precheckToken(chain, address);
    if (!pre.ok) return fail("the token does not pass the free check yet: nothing to apply for", 400);
    const src = pre.sources.find((s) => s.usable && s.kind === l!.price_kind && s.pool === l!.price_pool && s.quote === l!.price_quote && s.hook === l!.price_hook);
    if (!src) return fail("pick one of the price pools the check found", 400);
    try {
      // the cap and the insert under one per-wallet lock: parallel requests cannot all pass the count
      const made = await db.begin(async (sql) => {
        await sql`SELECT pg_advisory_xact_lock(hashtext(${`pair-apply:${wallet}`}))`;
        const [open] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM bb_pair_applications WHERE applicant = ${wallet} AND status IN ('open', 'paid', 'changes')`;
        if (open.n >= PAIR_APPLY_OPEN_MAX) return null;
        const [row] = await sql<{ id: string }[]>`
          INSERT INTO bb_pair_applications (chain_id, address, applicant, code, symbol, name, decimals, price_kind, price_pool, price_quote, price_hook, logo_url, website, x_handle, description, precheck, fee_usd)
          VALUES (${cid}, ${address}, ${wallet}, '', ${pre.symbol}, ${pre.name}, ${pre.decimals}, ${src.kind}, ${src.pool}, ${src.quote}, ${src.hook || null}, ${l!.logo || null}, ${l!.website || null}, ${l!.x_handle || null}, ${l!.description || null}, ${sql.json(pre)}, ${pairListingUsd()})
          RETURNING id`;
        const newId = Number(row.id);
        const code = applicationCode(newId);
        await sql`UPDATE bb_pair_applications SET code = ${code} WHERE id = ${newId}`;
        return { id: newId, code };
      });
      if (!made) return fail(`a wallet may have ${PAIR_APPLY_OPEN_MAX} applications in progress at once`, 429);
      return { ok: true, ...made };
    } catch (e) {
      if (uniqueViolation(e)) return fail("this token already has an application in progress", 409);
      throw e;
    }
  }
  const [app] = await db<AppRow[]>`SELECT * FROM bb_pair_applications WHERE id = ${id!} AND chain_id = ${cid} AND address = ${address}`;
  if (!app) return fail("no such application", 404);
  if (app.applicant !== wallet) return fail("only the wallet that applied can do that", 403);
  if (action === "proof") {
    if (app.status === "approved" || app.status === "rejected" || app.status === "expired") return fail("this application is decided", 409);
    await db`UPDATE bb_pair_applications SET proof_url = ${proof} WHERE id = ${id!}`;
  } else {
    if (!canAskAgain({ status: app.status, reviews_used: app.reviews_used, paid_at: app.paid_at ? new Date(app.paid_at).getTime() : null }, Date.now())) return fail("no review left to ask for", 409);
    // the reviewer judges the token as it is now: the check is run again and stored with the application
    forgetPrecheck(chain, address);
    const pre = await precheckToken(chain, address).catch(() => null);
    await db`UPDATE bb_pair_applications SET status = 'paid', reason = NULL, precheck = COALESCE(${pre ? db.json(pre) : null}, precheck) WHERE id = ${id!} AND status = 'changes'`;
  }
  return { ok: true, id: id!, code: app.code };
}

/** The fee's TWIG amount for an unpaid application, locked 30 minutes (a live lock is returned, never replaced). */
export async function quoteFee(id: number): Promise<PairApplicationPublic["quote"] | Fail> {
  const db = maybeDb();
  if (!db) return fail("db unconfigured", 503);
  if (!applicationsOpen()) return fail("applications are not open yet", 503);
  const [app] = await db<AppRow[]>`SELECT * FROM bb_pair_applications WHERE id = ${id}`;
  if (!app) return fail("no such application", 404);
  if (app.status !== "open") return fail("this application needs no payment", 409);
  if (app.quote_until && new Date(app.quote_until).getTime() > Date.now() && app.quote_twig && app.quote_price_usd) return publicOf(app, []).quote;
  const parts = await gitlawbUsdParts(); // TWIG is priced as GITLAWB (one unwraps to one)
  const due = Math.max(app.fee_usd - app.paid_usd, 1);
  const q = pairFeeQuote(due, parts.spot, parts.twap);
  if (!q) return fail("TWIG has no price right now: try again in a minute", 503);
  const [row] = await db<AppRow[]>`
    UPDATE bb_pair_applications SET quote_twig = ${q.whole.toString()}, quote_price_usd = ${q.priceUsd}, quote_at = now(), quote_until = now() + ${`${PAIR_QUOTE_LOCK_MS / 1000} seconds`}::interval,
           last_quote_until = now() + ${`${PAIR_QUOTE_LOCK_MS / 1000} seconds`}::interval
     WHERE id = ${id} AND status = 'open' AND (quote_until IS NULL OR quote_until <= now()) RETURNING *`;
  const fresh = row ?? (await db<AppRow[]>`SELECT * FROM bb_pair_applications WHERE id = ${id}`)[0];
  return publicOf(fresh, []).quote;
}

/**
 * One burn the indexer found (pairBurnFromTransfer). The raw fact is inserted first, whatever it names; a burn not yet
 * valued is then valued (at the application's locked quote when it was sent inside that lock, else at TWIG's price
 * now), and the application's total is recomputed. Every step is idempotent: the indexer's overlap re-feeds a burn,
 * and the sync loop revalues any burn left without a value (revaluePairBurns), so a failure part-way heals itself.
 */
export async function recordPairBurn(chain: ChainKey, row: PairBurnRow, blockTime: Date): Promise<boolean> {
  const db = maybeDb();
  // a fee is TWIG on Base: a transfer on any other chain, whatever token it names itself, never pays one
  if (!db || chain !== PAIR_FEE_CHAIN) return false;
  const cid = chainIdOf(chain);
  const ins = await db`
    INSERT INTO bb_pair_burns (chain_id, tx_hash, log_index, application_id, sender, twig, usd, priced_by, block_number, block_time)
    VALUES (${cid}, ${row.tx_hash}, ${row.log_index}, ${row.application_id}, ${row.sender}, ${row.whole}, NULL, NULL, ${row.block_number}, ${blockTime})
    ON CONFLICT DO NOTHING RETURNING tx_hash`;
  const [cur] = ins.length ? [{ usd: null }] : await db<{ usd: number | null }[]>`SELECT usd FROM bb_pair_burns WHERE chain_id = ${cid} AND tx_hash = ${row.tx_hash} AND log_index = ${row.log_index}`;
  if (cur && cur.usd === null) await valueBurn(cid, row.tx_hash, row.log_index, row.application_id, BigInt(row.whole), blockTime);
  await settleApplication(row.application_id);
  return ins.length > 0;
}

async function valueBurn(cid: number, tx: string, log: number, appId: number, whole: bigint, sentAt: Date): Promise<void> {
  const db = maybeDb()!;
  // by id alone: the fee is TWIG on Base whatever chain the pair is on, so the burn's chain is not the application's
  const [app] = await db<AppRow[]>`SELECT * FROM bb_pair_applications WHERE id = ${appId}`;
  if (!app) return; // names no application (yet): kept as a fact, never counted
  // sent before the application existed (an early or stray burn whose tag happens to name it): kept as a fact, never counted
  if (sentAt.getTime() < new Date(app.created_at).getTime()) return;
  const parts = await gitlawbUsdParts();
  const live = [parts.spot, parts.twap].filter((p): p is number => p !== null && p > 0);
  const quote = app.quote_price_usd && app.quote_at && app.quote_until ? { priceUsd: app.quote_price_usd, from: new Date(app.quote_at).getTime(), until: new Date(app.quote_until).getTime() } : null;
  const v = pairBurnUsd(whole, sentAt.getTime(), quote, live.length ? Math.min(...live) : null);
  if (!v) return;
  const done = await db`UPDATE bb_pair_burns SET usd = ${v.usd}, priced_by = ${v.by} WHERE chain_id = ${cid} AND tx_hash = ${tx} AND log_index = ${log} AND usd IS NULL RETURNING tx_hash`;
  // a burn has landed: the lock it was sent under is spent, so the next quote is for what is still due
  if (done.length) await db`UPDATE bb_pair_applications SET quote_twig = NULL, quote_price_usd = NULL, quote_at = NULL, quote_until = NULL WHERE id = ${appId} AND status = 'open'`;
}

/** An application's total from its valued burns; paid once it reaches the fee (within 2%). Idempotent. */
async function settleApplication(appId: number): Promise<void> {
  const db = maybeDb()!;
  await db`
    UPDATE bb_pair_applications a SET
      paid_usd = s.total,
      status = CASE WHEN a.status = 'open' AND s.total >= a.fee_usd * ${1 - PAIR_FEE_TOLERANCE} THEN 'paid' ELSE a.status END,
      paid_at = CASE WHEN a.paid_at IS NULL AND a.status = 'open' AND s.total >= a.fee_usd * ${1 - PAIR_FEE_TOLERANCE} THEN now() ELSE a.paid_at END
      FROM (SELECT COALESCE(sum(usd), 0) AS total FROM bb_pair_burns WHERE application_id = ${appId}) s
     WHERE a.id = ${appId} AND a.paid_usd IS DISTINCT FROM s.total`;
}

let lastRevalue = 0;
/** From the sync loop, once a minute: value burns left unvalued (no price when they landed) and settle their applications; expire stale applications. */
export async function revaluePairBurns(now = Date.now()): Promise<void> {
  const db = maybeDb();
  if (!db || now - lastRevalue < 60_000) return;
  lastRevalue = now;
  const rows = await db<{ chain_id: number; tx_hash: string; log_index: number; application_id: string; twig: string; block_time: Date }[]>`
    SELECT b.chain_id, b.tx_hash, b.log_index, b.application_id, b.twig::text AS twig, b.block_time FROM bb_pair_burns b
      JOIN bb_pair_applications a ON a.id = b.application_id WHERE b.usd IS NULL AND b.block_time >= a.created_at LIMIT 20`;
  for (const r of rows) {
    await valueBurn(r.chain_id, r.tx_hash, r.log_index, Number(r.application_id), BigInt(r.twig), new Date(r.block_time));
    await settleApplication(Number(r.application_id));
  }
  await expireStaleApplications();
}

/**
 * The reviewer's decision: an ADMIN_WALLETS signature over buildPairReviewMessage. "approve" lists the pair through the
 * admin listing's own checks (and fails with their reason when the token or its pool no longer pass); "changes" and
 * "reject" use one of the application's reviews, with a reason the applicant sees.
 */
export async function reviewApplication(b: Record<string, unknown>): Promise<{ ok: true; application: PairApplicationPublic | null } | Fail> {
  const db = maybeDb();
  if (!db) return fail("db unconfigured", 503);
  if (typeof b.wallet !== "string" || !isAddress(b.wallet)) return fail("bad wallet", 400);
  const wallet = b.wallet.toLowerCase();
  if (!isPairReviewDecision(b.decision)) return fail("bad decision", 400);
  const decision = b.decision;
  const id = Number(b.id);
  if (!(Number.isSafeInteger(id) && id > 0)) return fail("bad application", 400);
  const reason = typeof b.reason === "string" ? b.reason.trim() : "";
  if (reason.length > 300) return fail("the reason is over 300 characters", 400);
  if ((decision === "changes" || decision === "reject") && !reason) return fail("say why: the applicant sees it", 400);
  if (!isNonce(b.nonce) || !tsFresh(b.ts, Date.now())) return fail("stale or bad nonce", 400);
  if (!adminWallets().has(wallet)) return fail("admin only", 403);
  const message = buildPairReviewMessage({ decision, id, wallet, nonce: b.nonce, ts: Number(b.ts), reason });
  if (!(await verify(PAIR_FEE_CHAIN, wallet, message, b.signature))) return fail("signature does not match", 401);
  if (!(await consumeNonce(b.nonce, wallet))) return fail("nonce already used", 401);
  const [app] = await db<AppRow[]>`SELECT * FROM bb_pair_applications WHERE id = ${id}`;
  if (!app) return fail("no such application", 404);
  // a fee already paid is not waived: a paid application in "changes" goes back through "again" and then "approve"
  if (decision === "waive" && isPaid(app.paid_usd, app.fee_usd)) return fail("this application has paid its fee: approve it after the applicant asks again", 409);
  // nor while the applicant may be paying it: under a live fee quote, or in the hour after it while their transfer may
  // still be indexing. Waiving then would have them burn TWIG for a fee that was waived meanwhile
  const settling = settlingUntil(app);
  if (decision === "waive" && settling !== null) return fail(`the applicant may be paying the fee right now (a fee quote is open or just ended): waive it after ${new Date(settling).toISOString().slice(11, 16)} UTC`, 409);
  // an admin may close (reject) any application still in progress, so nothing can hold a token's place; approving and
  // asking for changes need a paid one; waiving the fee approves one that has not paid
  const allowed: PairApplicationStatus[] = decision === "reject" ? ["paid", "open", "changes"] : decision === "waive" ? ["open", "changes"] : ["paid"];
  if (!allowed.includes(app.status)) return fail(decision === "reject" ? "this application is already decided" : decision === "waive" ? "only an application that has not paid can have its fee waived" : "only a paid application waiting for review can be decided", 409);
  const chain = chainKeyOf(app.chain_id) as ChainKey;
  const used = app.status === "paid" ? app.reviews_used + 1 : app.reviews_used;
  const approving = decision === "approve" || decision === "waive";
  // asking for changes with no review left ends it: there is nothing more to ask for
  const status: PairApplicationStatus = approving ? "approved" : decision === "reject" || used >= PAIR_REVIEWS_MAX ? "rejected" : "changes";
  const why = decision === "waive" ? reason || PAIR_FEE_WAIVED : reason;
  // claim the decision first: two admins deciding at once cannot both win, and a listing never runs for a lost claim
  // a waiver is claimed only while the row still records the fee as unpaid and no fee transfer may be on its way (under
  // the live quote or the last one, even if a first burn already spent it): a burn that settles, or a quote the
  // applicant takes, after the checks above loses no money
  const claimed = await db`
    UPDATE bb_pair_applications SET status = ${status}, reviews_used = ${used}, reason = ${why || null}, decided_by = ${wallet}, decided_at = now()
     WHERE id = ${id} AND status = ${app.status} AND (${decision} <> 'waive' OR (paid_usd < fee_usd * ${1 - PAIR_FEE_TOLERANCE}
       AND (quote_until IS NULL OR quote_until < now() - ${`${PAIR_QUOTE_SETTLE_MS / 1000} seconds`}::interval)
       AND (last_quote_until IS NULL OR last_quote_until < now() - ${`${PAIR_QUOTE_SETTLE_MS / 1000} seconds`}::interval))) RETURNING id`;
  if (claimed.length === 0) return fail("this application changed meanwhile: reload", 409);
  if (approving) {
    // not listed, whether refused or thrown: the application goes back to where it was, its review not used. An unpaid one
    // whose fee was paid by a burn that settled while the listing ran goes back as paid (settlement will not look again)
    const restore = () => db`
      UPDATE bb_pair_applications SET
        status = CASE WHEN ${app.status} = 'open' AND paid_usd >= fee_usd * ${1 - PAIR_FEE_TOLERANCE} THEN 'paid' ELSE ${app.status} END,
        paid_at = CASE WHEN ${app.status} = 'open' AND paid_usd >= fee_usd * ${1 - PAIR_FEE_TOLERANCE} AND paid_at IS NULL THEN now() ELSE paid_at END,
        reviews_used = ${app.reviews_used}, reason = ${app.reason}, decided_by = ${app.decided_by}, decided_at = ${app.decided_at}
       WHERE id = ${id} AND status = 'approved'`;
    let w: { ok: true } | { ok: false; error: string; status: number };
    try {
      // already listed (an admin listed the token directly): the application is simply marked approved
      const [listed] = await db`SELECT 1 FROM bb_pairs WHERE chain_id = ${app.chain_id} AND address = ${app.address} AND status = 'listed'`;
      w = listed ? { ok: true } : await writeListing(chain, app.address, { logo: app.logo_url ?? "", website: app.website ?? "", x_handle: app.x_handle ?? "", description: app.description ?? "", price_kind: app.price_kind, price_pool: app.price_pool, price_quote: app.price_quote, price_hook: app.price_hook ?? "" }, wallet, "list");
    } catch (e) {
      await restore();
      throw e;
    }
    if (!w.ok) {
      await restore();
      return fail(`not listed: ${w.error}`, w.status);
    }
    await reloadPairs(); // this machine shows the new pair at once; the others within 15 s
  }
  return { ok: true, application: await getApplication(id) };
}
