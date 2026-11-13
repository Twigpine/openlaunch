import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  PAIR_APPLY_COPY,
  PAIR_QUOTE_LOCK_MS,
  PAIR_QUOTE_SETTLE_MS,
  PAIR_REVIEWS_MAX,
  PAIR_REVIEW_WINDOW_MS,
  PAIR_TAG_BASE,
  applicationCode,
  buildPairApplyMessage,
  buildPairReviewMessage,
  canAskAgain,
  isPaid,
  pairApplicationOf,
  pairBurnAmount,
  pairBurnFromTransfer,
  pairBurnUsd,
  pairFeeQuote,
  pairListingUsd,
  pairSettlingUntil,
  pairTagOf,
  proofPostText,
  proofPostUrl,
  sourceLabel,
} from "./pairApply.ts";
import { boostFromTransfer, isLaunchTag } from "./boost.ts";
import { PAIR_CHAINS, PAIR_CHAINS_TEXT, PAIR_FEE_CHAIN, buildPairAdminMessage, pairSymbolCheck, pairSymbolProblem } from "./pairs.ts";
import { coreQuoteNames } from "./config.ts";
import { hasDelegatecall, implementationOf1167 } from "./pairProbe.ts";

const src = (rel: string) => readFileSync(path.join(import.meta.dirname, rel), "utf8");
const TWIG = "0x6ac18bcf4ede02591d4917452700ea5eaaea13c1";
const DEAD = "0x000000000000000000000000000000000000dEaD";
const E18 = 10n ** 18n;
const transfer = (value: bigint, over: Partial<{ address: string; to: string; from: string }> = {}) => ({ address: TWIG, from: "0xAbC0000000000000000000000000000000000001", to: DEAD, value, txHash: "0xABC", logIndex: 3, blockNumber: 100n, ...over });

/* ── the tag ── */

test("kind 3 of the boost tag space names an application; boosts never read it, and it never reads a boost", () => {
  assert.equal(pairTagOf(12), PAIR_TAG_BASE + 12n);
  assert.equal(pairBurnAmount(12_200_000n, 12), 12_200_000n * E18 + 300_000_000_012n);
  assert.equal(pairApplicationOf(pairBurnAmount(5n, 99)), 99);
  assert.equal(pairApplicationOf(5n * E18 + 42n), null, "a launch tag");
  assert.equal(pairApplicationOf(5n * E18 + 10n ** 11n + 7n), null, "kind 1 (pinned posts)");
  assert.equal(pairApplicationOf(5n * E18 + PAIR_TAG_BASE), null, "id 0 is not an application");
  assert.throws(() => pairTagOf(0));
  assert.throws(() => pairTagOf(10n ** 11n));
  assert.equal(isLaunchTag(PAIR_TAG_BASE + 12n), false);
  assert.equal(boostFromTransfer(transfer(pairBurnAmount(20_000_000n, 12))), null, "a pair fee is never a boost");
  assert.equal(pairBurnFromTransfer(transfer(500_000n * E18 + 42n), TWIG, DEAD), null, "a boost is never a pair fee");
});

test("a burn row: TWIG to 0x…dEaD, kind-3 tag, at least one whole TWIG, never the locker's own burns", () => {
  const ok = pairBurnFromTransfer(transfer(pairBurnAmount(12_200_000n, 7)), TWIG, DEAD);
  assert.deepEqual(ok, { tx_hash: "0xabc", log_index: 3, sender: "0xabc0000000000000000000000000000000000001", application_id: 7, whole: "12200000", block_number: "100" });
  assert.equal(pairBurnFromTransfer(transfer(pairBurnAmount(1n, 7), { address: "0x1111111111111111111111111111111111111111" }), TWIG, DEAD), null, "not TWIG");
  assert.equal(pairBurnFromTransfer(transfer(pairBurnAmount(1n, 7), { to: "0x2222222222222222222222222222222222222222" }), TWIG, DEAD), null, "not burned");
  assert.equal(pairBurnFromTransfer(transfer(pairBurnAmount(1n, 7)), TWIG, DEAD, ["0xABC0000000000000000000000000000000000001"]), null, "the locker");
  assert.equal(pairBurnFromTransfer(transfer(PAIR_TAG_BASE + 7n), TWIG, DEAD), null, "dust: less than one TWIG");
});

/* ── the fee ── */

test("the fee: $200 at the LOWER of spot and average, rounded up to 100K TWIG; no price, no quote", () => {
  assert.deepEqual(pairFeeQuote(200, 0.0000164, 0.0000165), { whole: 12_200_000n, priceUsd: 0.0000164 });
  assert.equal(pairFeeQuote(200, 0.00002, 0.0000164)!.whole, 12_200_000n, "a pushed spot cannot shrink the fee");
  assert.equal(pairFeeQuote(200, null, 0.0000164)!.whole, 12_200_000n);
  assert.equal(pairFeeQuote(200, null, null), null);
  assert.equal(pairFeeQuote(200, 0, Number.NaN), null);
  assert.equal(pairFeeQuote(0, 0.0000164, null), null);
  assert.equal(pairFeeQuote(200, 0.002, 0.002)!.whole, 100_000n, "never under one step");
  assert.equal(pairListingUsd(undefined), 200);
  assert.equal(pairListingUsd("350"), 350);
  for (const bad of ["", "abc", "0", "5", "1000000"]) assert.equal(pairListingUsd(bad), 200, bad);
});

test("a burn's value: the locked price inside the lock, the price when indexed after it; paid within 2%", () => {
  const quote = { priceUsd: 0.0000164, from: 100, until: 1_000 };
  assert.deepEqual(pairBurnUsd(12_200_000n, 999, quote, 0.00001), { usd: 12_200_000 * 0.0000164, by: "quote" });
  assert.equal(pairBurnUsd(12_200_000n, 99, quote, 0.00001)!.by, "live", "sent before this lock began: not at its price");
  const late = pairBurnUsd(12_200_000n, 1_001, quote, 0.00001)!;
  assert.equal(late.by, "live");
  assert.ok(Math.abs(late.usd - 122) < 1e-9);
  assert.equal(pairBurnUsd(12_200_000n, 1_001, quote, null), null, "no price: recorded, valued later never by guesswork");
  assert.equal(isPaid(196, 200), true);
  assert.equal(isPaid(195.9, 200), false);
});

test("reviews: up to 3, within 60 days of paying, and only after changes were asked", () => {
  const paid = 1_000;
  assert.equal(canAskAgain({ status: "changes", reviews_used: 1, paid_at: paid }, paid + 1), true);
  assert.equal(canAskAgain({ status: "changes", reviews_used: PAIR_REVIEWS_MAX, paid_at: paid }, paid + 1), false);
  assert.equal(canAskAgain({ status: "changes", reviews_used: 1, paid_at: paid }, paid + PAIR_REVIEW_WINDOW_MS), false);
  assert.equal(canAskAgain({ status: "rejected", reviews_used: 1, paid_at: paid }, paid + 1), false);
  assert.equal(canAskAgain({ status: "changes", reviews_used: 1, paid_at: null }, paid + 1), false);
});

/* ── proof and messages ── */

test("proof: a code, a post text that names us, and only links to posts on X", () => {
  assert.match(applicationCode(12, () => 0), /^OL-12-AAAA$/);
  assert.match(applicationCode(7), /^OL-7-[A-Z2-9]{4}$/);
  assert.equal(proofPostText("OL-7-K7QX", "NOICE"), "We applied to list $NOICE as a community pair on @openlaunch_lol. Application OL-7-K7QX");
  assert.equal(proofPostUrl("https://twitter.com/noicedotso/status/1234567890?s=20"), "https://x.com/noicedotso/status/1234567890");
  assert.equal(proofPostUrl(" https://x.com/noicedotso/status/1234567890 "), "https://x.com/noicedotso/status/1234567890");
  for (const bad of ["http://x.com/a/status/1234567890", "https://evil.com/x.com/a/status/1234567890", "https://x.com/a", "https://x.com.evil.io/a/status/1234567890", "javascript:alert(1)"]) assert.equal(proofPostUrl(bad), null, bad);
});

test("messages: the application's fields are what is signed, and the price line reads like the admin's", () => {
  const src0 = { price_kind: "univ4", price_pool: "0xPOOL", price_quote: "0xQUOTE", price_hook: "0xHOOK" };
  assert.equal(sourceLabel(src0), "univ4 0xpool against 0xquote (hook 0xhook)");
  const admin = buildPairAdminMessage({ action: "list", chain: "base", address: "0x1", wallet: "0x2", nonce: "n", ts: 0, listing: { logo: "", website: "", x_handle: "", description: "", price_kind: "univ4", price_pool: "0xPOOL", price_quote: "0xQUOTE", price_hook: "0xHOOK" } });
  assert.ok(admin.split("\n").includes(`Price: ${sourceLabel(src0)}`), admin);
  assert.equal(
    buildPairApplyMessage({ action: "apply", chain: "base", address: "0xAA", wallet: "0xBB", nonce: "0123456789abcdef0123456789abcdef", ts: Date.UTC(2026, 9, 16), source: "univ3 0xp against 0xq", website: "https://noice.so", x_handle: "noicedotso", logo: "", description: "Noice." }),
    ["openlaunch.lol community pair application", "", "Action: apply", "Token: base:0xaa", "Price pool: univ3 0xp against 0xq", "Website: https://noice.so", "X: noicedotso", "Logo: -", "About: Noice.", "Wallet: 0xbb", "Nonce: 0123456789abcdef0123456789abcdef", "Issued: 2026-10-16T00:00:00.000Z"].join("\n"),
  );
  assert.match(buildPairApplyMessage({ action: "proof", chain: "base", address: "0xAA", wallet: "0xBB", nonce: "n", ts: 0, id: 7, proof: "https://x.com/a/status/1" }), /\nApplication: 7\nProof post: https:\/\/x\.com\/a\/status\/1\n/);
  assert.equal(
    buildPairReviewMessage({ decision: "changes", id: 7, wallet: "0xCC", nonce: "n", ts: 0, reason: "No proof post." }),
    ["openlaunch.lol community pair review", "", "Decision: changes", "Application: 7", "Reason: No proof post.", "Admin: 0xcc", "Nonce: n", "Issued: 1970-01-01T00:00:00.000Z"].join("\n"),
  );
});

test("words: the fee pays for a review, is burned, and cannot be refunded; no value talk", () => {
  const all = [PAIR_APPLY_COPY.feeRule(200), ...Object.values(PAIR_APPLY_COPY).filter((v): v is string => typeof v === "string")].join(" ");
  assert.match(PAIR_APPLY_COPY.feeRule(200), /pays for a review, not a listing/);
  assert.match(PAIR_APPLY_COPY.feeRule(200), /cannot be refunded/);
  assert.match(PAIR_APPLY_COPY.sentFinal, /cannot be undone or refunded/);
  assert.doesNotMatch(all, /\b(moon|rally|guarantee[ds]?|official|verified pair|safe|endorsed|buyback|reward)\b/i);
});

/* ── the probe's helpers ── */

test("probe helpers: clones are read for their implementation; DELEGATECALL counts as an opcode only", () => {
  assert.equal(implementationOf1167("0x363d3d373d3d3d363d73766e0671bbbf59370c35a8882366a2085b46eb7b5af43d82803e903d91602b57fd5bf3"), "0x766e0671bbbf59370c35a8882366a2085b46eb7b", "TIBBIR (EIP-1167)");
  assert.equal(implementationOf1167("0x3d3d3d3d363d3d37363d73db7b520bb5c3a2c5d4871198081911359f93be875af43d3d93803e602a57fd5bf3"), "0xdb7b520bb5c3a2c5d4871198081911359f93be87", "1F916 (44-byte variant)");
  assert.equal(implementationOf1167("0x6080"), null);
  assert.equal(hasDelegatecall("0x60f4"), false, "f4 inside PUSH1 data");
  assert.equal(hasDelegatecall("0x7f" + "f4".repeat(32) + "00"), false, "f4s inside PUSH32 data");
  assert.equal(hasDelegatecall("0x6000f4"), true);
});

/* ── the fee step: the second (and last) place the app sends TWIG ── */

test("the fee is one plain TWIG transfer to 0x…dEaD: simulated, credited to the builder code, never an approval, and it names this application", () => {
  const page = src("../../components/launchpad/PairApplication.tsx");
  assert.match(page, /simulateContract\(\{ address: TWIG_ADDRESS, abi: ERC20_TRANSFER_ABI, functionName: "transfer", args: \[DEAD, BigInt\(q\.amount\)\], account: address, dataSuffix: BUILDER_DATA_SUFFIX \}\)/);
  assert.equal((page.match(/writeContract\(/g) ?? []).length, 1);
  assert.doesNotMatch(page, /\bapprove\(|functionName: "approve"|maxUint|sendTransaction/);
  assert.match(page, /if \(pairApplicationOf\(BigInt\(q\.amount\)\) !== app\.id\)/);
  assert.match(page, /lock\.current = true; \/\/ before the first await/);
  // a burn whose confirmation is late is never offered again
  assert.match(page, /never offer to send the same TWIG again/);
});

/* ── review fixes (2026-10-16) ── */

test("nothing holds a token's place for good: unpaid applications expire after 48 hours, closed review windows too", () => {
  const s = src("pairApplyServer.ts");
  const exp = s.slice(s.indexOf("export async function expireStaleApplications"), s.indexOf("/** Whether a wallet has a visible profile"));
  assert.match(exp, /a\.status = 'open' AND a\.paid_usd = 0 AND a\.created_at < now\(\)/);
  assert.match(exp, /a\.quote_until IS NULL OR a\.quote_until < now\(\) - \$\{`\$\{PAIR_QUOTE_SETTLE_MS \/ 1000\} seconds`\}::interval/, "never under a live quote, nor in the hour after it");
  assert.match(exp, /NOT EXISTS \(SELECT 1 FROM bb_pair_burns b WHERE b\.application_id = a\.id AND b\.block_time >= a\.created_at\)/, "never once anything was burned for it (a stray burn from before it existed does not count)");
  assert.match(exp, /a\.status = 'changes' AND a\.paid_at < now\(\)/);
  const apply = s.slice(s.indexOf("export async function applicantAction"));
  assert.ok(apply.indexOf("await expireStaleApplications(chain, address);") < apply.indexOf("INSERT INTO bb_pair_applications"));
  assert.match(apply, /pg_advisory_xact_lock\(hashtext\(\$\{`pair-apply:\$\{wallet\}`\}\)\)/, "the per-wallet cap holds under parallel requests");
  assert.match(src("loop.ts"), /void revaluePairBurns\(\)/);
});

test("burns: the fact first, then its value, then the total; each step heals on the next pass", () => {
  const s = src("pairApplyServer.ts");
  const rec = s.slice(s.indexOf("export async function recordPairBurn"), s.indexOf("async function valueBurn"));
  assert.ok(rec.indexOf("INSERT INTO bb_pair_burns") < rec.indexOf("await valueBurn("), "inserted before any price read");
  assert.match(rec, /if \(cur && cur\.usd === null\) await valueBurn/, "a re-fed burn is only valued if it still has no value");
  assert.match(rec, /await settleApplication\(row\.application_id\);/);
  assert.match(s, /AND usd IS NULL RETURNING tx_hash/);
  assert.match(s, /SET quote_twig = NULL, quote_price_usd = NULL, quote_at = NULL, quote_until = NULL WHERE id = \$\{appId\} AND status = 'open'/, "a landed burn spends its lock: the next quote is for what is still due");
  assert.match(s, /JOIN bb_pair_applications a ON a\.id = b\.application_id WHERE b\.usd IS NULL/, "unvalued burns are valued later");
  assert.match(s, /precheck = COALESCE\(\$\{pre \? db\.json\(pre\) : null\}, precheck\)/, "another review sees the token as it is now");
});

test("the fee step never offers to send again while a sent transfer is not indexed", () => {
  const page = src("../../components/launchpad/PairApplication.tsx");
  assert.match(page, /if \(!address \|\| !q \|\| lock\.current \|\| waiting\) return;/);
  assert.match(page, /const waiting = sent !== null && !indexed && app\.status === "open";/);
  assert.match(page, /window\.sessionStorage\.setItem\(sentKey, h\)/, "kept across a reload");
  assert.match(page, /\{app\.status === "open" && waiting \? \(/);
  // a reverted transfer sent nothing: the guard is lifted so the applicant can try again
  assert.match(page, /if \(rc\.status !== "success"\) \{\n\s*remember\(null\);/);
});

test("a late burn on a closed application never marks it paid (status or date)", () => {
  const s = src("pairApplyServer.ts");
  const settle = s.slice(s.indexOf("async function settleApplication"), s.indexOf("let lastRevalue"));
  assert.match(settle, /status = CASE WHEN a\.status = 'open' AND s\.total >=/);
  assert.match(settle, /paid_at = CASE WHEN a\.paid_at IS NULL AND a\.status = 'open' AND s\.total >=/);
});

/* ── pre-deploy review fixes (2026-10-16) ── */

test("a burn sent before its application existed never counts, and is never retried", () => {
  const s = src("pairApplyServer.ts");
  const value = s.slice(s.indexOf("async function valueBurn"), s.indexOf("async function settleApplication"));
  assert.match(value, /if \(sentAt\.getTime\(\) < new Date\(app\.created_at\)\.getTime\(\)\) return;/);
  assert.match(s, /WHERE b\.usd IS NULL AND b\.block_time >= a\.created_at LIMIT 20/);
});

test("llms.txt explains the application fee only while applications are open", () => {
  const llms = src("../../app/llms.txt/route.ts");
  assert.match(llms, /function pairApplySection\(\): string \{\n  if \(!applicationsOpen\(\)\) return "";/);
  assert.equal((llms.match(/3 × 10\^11 \+ application id/g) ?? []).length, 1, "only inside pairApplySection");
});

/* ── fee waiver (2026-10-17) ── */

test("an admin can approve an unpaid application with the fee waived, and an already listed token just marks it approved", () => {
  const s = src("pairApplyServer.ts");
  const decide = s.slice(s.indexOf("export async function reviewApplication"));
  assert.match(decide, /decision === "waive" \? \["open", "changes"\]/, "only an application that has not paid");
  assert.match(decide, /const why = decision === "waive" \? reason \|\| PAIR_FEE_WAIVED : reason;/);
  assert.match(decide, /SELECT 1 FROM bb_pairs WHERE chain_id = \$\{app\.chain_id\} AND address = \$\{app\.address\} AND status = 'listed'/);
  // the listed check is inside the guarded block: a failing query restores the application too
  assert.ok(decide.indexOf("try {") < decide.indexOf("SELECT 1 FROM bb_pairs WHERE chain_id"), "the listed-pair query runs inside the restore guard");
  // a paid fee is never recorded as waived
  assert.match(decide, /if \(decision === "waive" && isPaid\(app\.paid_usd, app\.fee_usd\)\) return fail\(/);
  // and the claim itself re-checks it, so a burn settling between the check and the claim cannot be waived away
  assert.match(decide, /WHERE id = \$\{id\} AND status = \$\{app\.status\} AND \(\$\{decision\} <> 'waive' OR \(paid_usd < fee_usd \* \$\{1 - PAIR_FEE_TOLERANCE\}\n\s*AND \(quote_until IS NULL OR quote_until < now\(\) - \$\{`\$\{PAIR_QUOTE_SETTLE_MS \/ 1000\} seconds`\}::interval\)\n\s*AND \(last_quote_until IS NULL OR last_quote_until < now\(\) - \$\{`\$\{PAIR_QUOTE_SETTLE_MS \/ 1000\} seconds`\}::interval\)\)\) RETURNING id/);
  assert.match(decide, /const restore = \(\) => db`\s*UPDATE bb_pair_applications SET\s*status = CASE WHEN \$\{app\.status\} = 'open' AND paid_usd >= fee_usd \* \$\{1 - PAIR_FEE_TOLERANCE\} THEN 'paid' ELSE \$\{app\.status\} END,[^`]*reviews_used = \$\{app\.reviews_used\}[^`]*AND status = 'approved'`/, "a failed listing puts the application back where it was (as paid when a burn settled meanwhile)");
  assert.match(decide, /\(decision === "changes" \|\| decision === "reject"\) && !reason/, "approving and waiving need no reason");
  assert.match(src("../../components/launchpad/PairReviewAdmin.tsx"), /\{!isPaid\(a\.paid_usd, a\.fee_usd\) && !a\.settling_until \? <button type="button" disabled=\{!address \|\| busy\} onClick=\{\(\) => void decide\(a\.id, "waive"\)\} className=\{btn\.primarySm\}[^>]*>Approve without fee</, "only offered when the fee is not paid and not being paid");
  assert.match(src("../../components/launchpad/PairApplication.tsx"), /app\.status === "approved" && app\.paid_usd < app\.fee_usd \* 0\.98 \? <p className="text-sm text-up">\{app\.paid_usd > 0 \? PAIR_APPLY_COPY\.waivedRest\(app\.paid_usd\) : PAIR_APPLY_COPY\.waived\}/, "a partial payment is shown, and only the rest is waived");
  assert.equal(PAIR_APPLY_COPY.waivedRest(12.5), "Paid: $12.50. openlaunch waived the rest of the fee.");
  // a listing that throws (not only one refused) puts the application back
  assert.match(decide, /\} catch \(e\) \{\n\s*await restore\(\);\n\s*throw e;/);
  assert.match(decide, /if \(!w\.ok\) \{\n\s*await restore\(\);/);
  assert.match(buildPairReviewMessage({ decision: "waive", id: 1, wallet: "0xA", nonce: "n", ts: 0, reason: "" }), /^openlaunch\.lol community pair review\n\nDecision: waive\nApplication: 1\nReason: -\n/);
});

test("a fee is never waived while the applicant may be paying it: under a live quote or in the hour after it", () => {
  const now = 1_800_000_000_000;
  assert.equal(PAIR_QUOTE_SETTLE_MS, 60 * 60_000);
  assert.equal(pairSettlingUntil(null, now), null, "no quote was given: waive at once");
  const until = now + PAIR_QUOTE_LOCK_MS;
  assert.equal(pairSettlingUntil(until, now), until + PAIR_QUOTE_SETTLE_MS, "a live quote");
  assert.equal(pairSettlingUntil(now - 59 * 60_000, now), now + 60_000, "ended 59 minutes ago: a transfer may still be indexing");
  assert.equal(pairSettlingUntil(now - PAIR_QUOTE_SETTLE_MS, now), null, "an hour after it ended");
  const s = src("pairApplyServer.ts");
  const decide = s.slice(s.indexOf("export async function reviewApplication"));
  const guard = decide.indexOf('if (decision === "waive" && settling !== null) return fail(');
  assert.ok(guard > decide.indexOf("const settling = settlingUntil(app);") && guard < decide.indexOf("const claimed = await db`"), "checked before the claim");
  // from the latest quote's end, which a landed burn does not erase: a second transfer under the same quote holds it too
  assert.match(s, /const ends = \[r\.quote_until, r\.last_quote_until\]\.filter\(\(d\) => d\)\.map\(\(d\) => new Date\(d!\)\.getTime\(\)\);\n\s*return pairSettlingUntil\(ends\.length \? Math\.max\(\.\.\.ends\) : null, Date\.now\(\)\);/);
  assert.match(s, /quote_until = now\(\) \+ \$\{`\$\{PAIR_QUOTE_LOCK_MS \/ 1000\} seconds`\}::interval,\n\s*last_quote_until = now\(\) \+ \$\{`\$\{PAIR_QUOTE_LOCK_MS \/ 1000\} seconds`\}::interval\n/, "every quote records its end twice");
  assert.match(s, /SET quote_twig = NULL, quote_price_usd = NULL, quote_at = NULL, quote_until = NULL WHERE id = \$\{appId\}/, "a landed burn clears the quote…");
  assert.doesNotMatch(s, /last_quote_until = NULL/, "…but never last_quote_until");
  const schema = src("../../../db/schema.sql");
  assert.match(schema, /ALTER TABLE bb_pair_applications ADD COLUMN IF NOT EXISTS last_quote_until timestamptz;/);
  assert.match(schema, /UPDATE bb_pair_applications SET last_quote_until = quote_until WHERE last_quote_until IS NULL AND quote_until IS NOT NULL;/, "backfill: a live quote");
  // a quote a burn already spent before the column existed began before the migration, so it ends by then + the 30-minute lock
  assert.match(schema, /UPDATE bb_pair_applications a SET last_quote_until = now\(\) \+ interval '30 minutes'\n\s*WHERE a\.last_quote_until IS NULL AND a\.status IN \('open', 'changes'\) AND EXISTS \(SELECT 1 FROM bb_pair_burns b WHERE b\.application_id = a\.id\);/, "backfill: a spent quote");
  assert.equal(PAIR_QUOTE_LOCK_MS, 30 * 60_000, "the backfill's 30 minutes is the quote lock");
  assert.ok(schema.indexOf("CREATE TABLE IF NOT EXISTS bb_pair_burns") < schema.indexOf("EXISTS (SELECT 1 FROM bb_pair_burns b WHERE b.application_id = a.id)"), "the backfill runs after bb_pair_burns exists (a fresh database)");
  // the panel holds the button back and says when, from the same rule
  assert.match(s, /settling_until: iso\(settlingUntil\(r\)\),/);
  const panel = src("../../components/launchpad/PairReviewAdmin.tsx");
  assert.match(panel, /\{!isPaid\(a\.paid_usd, a\.fee_usd\) && a\.settling_until \? <span[^>]*>The applicant may be paying the fee now: waive it after \{new Date\(a\.settling_until\)/);
  // an open panel reloads the queue when the earliest hold ends, so the button comes back on its own
  assert.match(panel, /const next = Math\.min\(\.\.\.\(apps \?\? \[\]\)\.map\(\(a\) => \(a\.settling_until \? Date\.parse\(a\.settling_until\) : Infinity\)\)\);\n\s*if \(!Number\.isFinite\(next\)\) return;\n\s*const id = setTimeout\(\(\) => void load\(\), Math\.max\(15_000, next - nowMs\(\) \+ 1_000\)\);\n\s*return \(\) => clearTimeout\(id\);\n\s*\}, \[apps, load\]\);/);
});

/* ── wiring ── */

test("server: verified identity, a passing check, signatures before writes, a lock never replaced, approval through the listing's own checks", () => {
  const s = src("pairApplyServer.ts");
  const body = s.slice(s.indexOf("export async function applicantAction"));
  const order = ["await verify(PAIR_FEE_CHAIN, wallet, message, b.signature)", "await consumeNonce(b.nonce, wallet)", "await verifiedProfile(wallet)", "if (!pre.ok)", "INSERT INTO bb_pair_applications"];
  const at = order.map((o) => body.indexOf(o));
  assert.ok(at.every((i) => i > 0), JSON.stringify(at));
  assert.deepEqual([...at].sort((a, b) => a - b), at);
  assert.match(s, /x_status = 'verified' AND NOT hidden AND deleted_at IS NULL/);
  assert.match(s, /WHERE id = \$\{id\} AND status = 'open' AND \(quote_until IS NULL OR quote_until <= now\(\)\) RETURNING \*/);
  const decide = s.slice(s.indexOf("export async function reviewApplication"));
  const claimAt = decide.indexOf("AND status = ${app.status} AND (${decision} <> 'waive'");
  const listAt = decide.indexOf("await writeListing(chain, app.address,");
  assert.ok(claimAt >= 0 && listAt >= 0 && claimAt < listAt, "the decision is claimed before anything is listed");
  assert.match(decide, /if \(claimed\.length === 0\) return fail\("this application changed meanwhile: reload", 409\);/);
  assert.match(decide, /ELSE \$\{app\.status\} END,[^`]*reviews_used = \$\{app\.reviews_used\}[^`]*WHERE id = \$\{id\} AND status = 'approved'/, "a failed listing gives the review back");
  assert.match(decide, /decision === "reject" \? \["paid", "open", "changes"\]/, "an admin can close an application nobody pays for");
  assert.match(src("../../../db/schema.sql"), /CREATE UNIQUE INDEX IF NOT EXISTS bb_pair_applications_open_idx ON bb_pair_applications \(chain_id, address\) WHERE status IN \('open', 'paid', 'changes'\);/);
  const idx = src("indexer.ts");
  assert.equal(idx.match(/else await applyPairBurn\(chain, l as/g)?.length, 2, "both the range scan and the receipt path record pair fees");
  assert.match(src("../../app/api/pairs/precheck/route.ts"), /if \(!applicationsOpen\(\)\)/);
});

/* ── Robinhood Chain (2026-10-17) ── */

test("pairs are listed on Base and Robinhood Chain; the fee and every signature stay on Base", () => {
  assert.deepEqual([...PAIR_CHAINS], ["base", "robinhood"]);
  assert.equal(PAIR_FEE_CHAIN, "base");
  assert.equal(PAIR_CHAINS_TEXT, "Base and Robinhood Chain");
  assert.match(PAIR_APPLY_COPY.feeRule(200), /in TWIG on Base, sent to 0x…dEaD, whichever chain the token is on/);
  const s = src("pairApplyServer.ts");
  // TWIG lives on Base only: a burn is matched to its application by id, never by the burn's own chain
  const value = s.slice(s.indexOf("async function valueBurn("), s.indexOf("/** An application's total"));
  assert.match(value, /SELECT \* FROM bb_pair_applications WHERE id = \$\{appId\}`;/);
  assert.doesNotMatch(value, /WHERE id = \$\{appId\} AND chain_id/);
  // applicant, review and admin signatures are all checked on Base, whatever chain the pair is on
  assert.equal(s.match(/await verify\(PAIR_FEE_CHAIN, wallet, message, b\.signature\)/g)?.length, 2, "applicant + review");
  assert.doesNotMatch(s, /await verify\("base"|await verify\(chain,/);
  assert.match(src("pairsServer.ts"), /await verify\(PAIR_FEE_CHAIN, wallet, message, b\.signature\)/);
  assert.match(src("pairsServer.ts"), /return fail\(`pairs are listed on \$\{PAIR_CHAINS_TEXT\} only`, 400\);/);
  assert.match(src("../../app/llms.txt/route.ts"), /## Community pairs \(\$\{PAIR_CHAINS_TEXT\}\)/);
  assert.match(src("pairCheck.ts"), /label: `A price pool against \$\{coreQuoteNames\(chain\)\} that reads a price`/);
});

test("the forms: the applicant picks the token's chain, signs and pays on Base; the admin lists on either chain", () => {
  const form = src("../../components/launchpad/PairApply.tsx");
  assert.match(form, /\{PAIR_CHAINS\.map\(\(c\) => \(\n\s*<button key=\{c\} type="button" aria-pressed=\{c === chain\} onClick=\{\(\) => pickChain\(c\)\}/);
  assert.match(form, /body: JSON\.stringify\(\{ chain, address: token\.trim\(\) \}\)/, "the check runs on the picked chain");
  assert.match(form, /const wallet = await walletOnChain\(config, CHAINS\[PAIR_FEE_CHAIN\]\.id\);/, "a wallet on Robinhood is asked to switch to Base first");
  assert.match(form, /buildPairApplyMessage\(\{ action: "apply", chain: check\.chain,/, "the application names the checked token's chain");
  assert.match(form, /function pickChain\(c: ChainKey\) \{[\s\S]*?setCheck\(null\);/, "a check never carries over to another chain");
  const page = src("../../components/launchpad/PairApplication.tsx");
  assert.match(page, /buildPairApplyMessage\(\{ action, chain: app\.chain,/);
  assert.match(page, /body: JSON\.stringify\(\{ action, chain: app\.chain,/);
  assert.equal(page.match(/\/api\/launch\/sync\?chain=\$\{FEE_CHAIN\}&tx=/g)?.length, 2, "the fee transfer is indexed on Base");
  assert.doesNotMatch(page, /\bCHAIN\b/);
  const admin = src("../../components/launchpad/PairsAdmin.tsx");
  assert.match(admin, /const wallet = await walletOnChain\(config, CHAINS\[PAIR_FEE_CHAIN\]\.id\);/);
  assert.match(admin, /buildPairAdminMessage\(\{ action, chain, address: pair,/);
  for (const a of ["suspend", "delist", "reinstate"]) assert.match(admin, new RegExp(`act\\("${a}", p\\.chain, p\\.address,`), a);
  assert.match(admin, /\{PAIR_CHAINS\.map\(\(c\) => <option key=\{c\} value=\{c\}>\{CHAIN_LABELS\[c\]\}<\/option>\)\}/);
  assert.match(src("../../components/launchpad/PairReviewAdmin.tsx"), /on \{CHAIN_LABELS\[a\.chain\]\}/);
});

test("review fixes: a wallet on another chain switches first; Base-only burns; no borrowed names", () => {
  // getWalletClient refuses a chain the wallet is not on: every pair signature and the admin sign-in switch first
  const helper = src("../walletOnChain.ts");
  assert.match(helper, /if \(getAccount\(config\)\.chainId !== chainId\) await switchChain\(config, \{ chainId \}\);\n\s*return getWalletClient\(config, \{ chainId \}\);/);
  assert.match(src("../../components/launchpad/PairApplication.tsx"), /const wallet = await walletOnChain\(config, BASE\.id\);/);
  assert.match(src("../../components/launchpad/PairReviewAdmin.tsx"), /const wallet = await walletOnChain\(config, CHAINS\.base\.id\);/);
  assert.match(src("../../components/admin/AdminSignIn.tsx"), /const wallet = await walletOnChain\(config, CHAINS\.base\.id\);/);
  // a fee is paid on Base only, even if a TWIG-like token turns up elsewhere one day
  assert.match(src("pairApplyServer.ts"), /export async function recordPairBurn\([^)]*\)[^{]*\{\n\s*const db = maybeDb\(\);\n[^\n]*\n\s*if \(!db \|\| chain !== PAIR_FEE_CHAIN\) return false;/);
  // a pair never borrows a stock ticker, nor a name listed on another chain
  assert.equal(pairSymbolProblem("TSLA", [], ["TSLA", "NVDA"]), "TSLA is a stock's ticker");
  assert.equal(pairSymbolProblem("museworld", ["MUSEWORLD"]), "another listed pair is already museworld");
  assert.equal(pairSymbolProblem("PORKU", ["MUSEWORLD"], ["TSLA"]), null);
  for (const f of ["pairCheck.ts", "pairsServer.ts"]) {
    const s = src(f);
    assert.match(s, /\.filter\(\(p\) => p\.status === "listed" && !\(p\.chain === chain && p\.address === address\)\)\.map\(\(p\) => p\.symbol\), (stockTickers\(chain\)|stocks)\)/, f);
    assert.match(s, /await ensureRegistry\(\)\.catch\(\(\) => null\); \/\/ Robinhood's stock tickers/, f);
    assert.doesNotMatch(s, /stockList\(/, f); // an unread Robinhood list reads as empty there: tickers come from stockTickers (null when unread)
  }
  // a stock list that was never read is no pass: the free check says unknown, a listing is refused until it reads
  assert.match(src("stocksServer.ts"), /export function stockTickers\(chain: ChainKey\): readonly string\[\] \| null \{\n\s*if \(STOCK_SOURCE\[chain\] === "robinhood-registry" && !registry\) return null;/);
  assert.match(src("pairsServer.ts"), /const stocks = stockTickers\(chain\);\n\s*if \(!stocks\) return fail\("the chain's stock list could not be read to rule out a stock's ticker; try again", 503\);/);
  assert.deepEqual(pairSymbolCheck("PORKU", [], ["TSLA"]), { pass: true, value: "PORKU" });
  assert.deepEqual(pairSymbolCheck("TSLA", [], ["TSLA"]), { pass: false, value: "TSLA is a stock's ticker" });
  assert.equal(pairSymbolCheck("PORKU", [], null).pass, null);
  assert.match(pairSymbolCheck("PORKU", [], null).value, /stock list could not be read/);
  assert.deepEqual(pairSymbolCheck("museworld", ["MUSEWORLD"], null), { pass: false, value: "another listed pair is already museworld" });
  assert.equal(pairSymbolCheck("WETH", [], null).pass, false);
  assert.equal(coreQuoteNames("robinhood"), "USDG, ETH or GITLAWB");
  assert.match(src("pairsServer.ts"), /the price pool must be against a core quote \(\$\{coreQuoteNames\(chain\)\}\)/);
});
