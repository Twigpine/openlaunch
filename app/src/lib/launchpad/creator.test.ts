import { test } from "node:test";
import assert from "node:assert/strict";
import { earnedRaw, earnedSides, feeShareBps, feeSidesUsd, hasFees, holdingUsd, isBurnOnly } from "./creator.ts";
import { buildEditMessage, isNonce, validateEdit } from "./editAuth.ts";
import { ageLabel, clampSocial, feeLabel, shapeCard } from "./ogcard.ts";

const DEAD = "0x000000000000000000000000000000000000dead";
const W = "0xAbC0000000000000000000000000000000000001";

test("feeShareBps sums this wallet's recipient entries, case-insensitive", () => {
  assert.equal(feeShareBps([{ payout: W, bps: 6000 }, { payout: DEAD, bps: 4000 }], W.toLowerCase()), 6000);
  assert.equal(feeShareBps([{ payout: DEAD, bps: 10000 }], W), 0);
  assert.equal(feeShareBps([], W), 0);
});

test("earnedRaw = (collected − burned) × share, never negative", () => {
  assert.equal(earnedRaw("1000", "400", 5000), 300n);
  assert.equal(earnedRaw(1000n, 1000n, 5000), 0n);
  assert.equal(earnedRaw(1000n, 0n, 0), 0n);
  assert.equal(earnedRaw(10n ** 18n, 0n, 10000), 10n ** 18n);
});

test("earnedSides applies the share to the quote side and the launched token side", () => {
  const l = { fees_quote_collected: "1000", fees_quote_burned: "200", fees_token_collected: (10n ** 21n).toString(), fees_token_burned: "0" };
  assert.deepEqual(earnedSides(l, 5000), { quote: 400n, token: 5n * 10n ** 20n });
  assert.deepEqual(earnedSides(l, 0), { quote: 0n, token: 0n });
  // a sells-only launch has fees only on the token side
  assert.deepEqual(earnedSides({ ...l, fees_quote_collected: "0", fees_quote_burned: "0" }, 10000), { quote: 0n, token: 10n ** 21n });
});

test("feeSidesUsd prices the token side at the pool price; null without a quote price", () => {
  // 1242 USDG (6 decimals) + 1000 tokens at 0.01 USDG each, USDG = $1
  assert.equal(feeSidesUsd({ quote: 1_242_000_000n, token: 1000n * 10n ** 18n }, 6, 0.01, 1), 1252);
  assert.equal(feeSidesUsd({ quote: 0n, token: 2n * 10n ** 18n }, 18, 0.5, 2000), 2000);
  assert.equal(feeSidesUsd({ quote: 1n, token: 1n }, 6, 1, null), null);
});

test("hasFees is true when either side is non-zero", () => {
  assert.equal(hasFees({ quote: 0n, token: 1n }), true);
  assert.equal(hasFees({ quote: 1n, token: 0n }), true);
  assert.equal(hasFees({ quote: 0n, token: 0n }), false);
  assert.equal(hasFees(null), false);
  assert.equal(hasFees(undefined), false);
});

test("isBurnOnly / holdingUsd", () => {
  assert.equal(isBurnOnly([{ payout: DEAD, bps: 10000 }]), true);
  assert.equal(isBurnOnly([{ payout: W, bps: 5000 }, { payout: DEAD, bps: 5000 }]), false);
  assert.equal(holdingUsd(2n * 10n ** 18n, 0.5, 2000), 2000);
  assert.equal(holdingUsd(2n * 10n ** 18n, 0.5, null), null);
});

test("buildEditMessage is deterministic and binds chain/token/wallet/nonce/expiry/fields", () => {
  const m = buildEditMessage({ chain: "base", token: "0xAB", wallet: "0xCD", nonce: "n", expiresAt: 0, fields: { description: "hi" } });
  assert.match(m, /Chain: base/);
  assert.match(m, /Token: 0xab/);
  assert.match(m, /Wallet: 0xcd/);
  assert.match(m, /Nonce: n/);
  assert.match(m, /Expires: 1970-01-01T00:00:00.000Z/);
  assert.match(m, /description: hi/);
  assert.equal(m, buildEditMessage({ chain: "base", token: "0xab", wallet: "0xcd", nonce: "n", expiresAt: 0, fields: { description: "hi" } }));
});

test("validateEdit: https only, no private hosts, no HTML, handle format", () => {
  assert.equal(validateEdit({ description: "ok", image_url: "https://x.y/a.png", website: "https://x.y", x_handle: "@abc_1" }).ok, true);
  const v = validateEdit({ description: "ok", image_url: "https://x.y/a.png", website: "https://x.y", x_handle: "@abc_1" });
  if (v.ok) assert.equal(v.value.x_handle, "abc_1");
  assert.equal(validateEdit({ image_url: "http://x.y/a.png" }).ok, false);
  assert.equal(validateEdit({ website: "https://localhost/" }).ok, false);
  assert.equal(validateEdit({ website: "https://169.254.169.254/latest" }).ok, false);
  assert.equal(validateEdit({ description: "<script>x</script>" }).ok, false);
  assert.equal(validateEdit({ x_handle: "bad handle!" }).ok, false);
  assert.equal(validateEdit({}).ok, true, "all fields optional");
});

test("validateEdit: an X link normalizes to the handle, so the signed message is the same either way", () => {
  const link = validateEdit({ x_handle: "https://x.com/abc_1?s=21" });
  const bare = validateEdit({ x_handle: "@abc_1" });
  assert.ok(link.ok && bare.ok);
  if (!link.ok || !bare.ok) return;
  assert.equal(link.value.x_handle, "abc_1");
  const p = { chain: "base", token: "0xab", wallet: "0xcd", nonce: "n", expiresAt: 0 };
  assert.equal(buildEditMessage({ ...p, fields: link.value }), buildEditMessage({ ...p, fields: bare.value }));
  assert.match(buildEditMessage({ ...p, fields: link.value }), /^x: abc_1$/m);
  assert.equal(validateEdit({ x_handle: "https://evil.com/abc_1" }).ok, false, "other hosts rejected");
  assert.equal(validateEdit({ x_handle: "a".repeat(16) }).ok, false, "too long is an error, not a truncation");
});

test("isNonce accepts 32 hex chars only", () => {
  assert.equal(isNonce("0123456789abcdef0123456789abcdef"), true);
  assert.equal(isNonce("0123456789ABCDEF0123456789abcdef"), false);
  assert.equal(isNonce("abc"), false);
});

test("share card shaping", () => {
  const now = Date.parse("2026-09-06T12:00:00Z");
  const c = shapeCard({ name: "Dollar Dog", symbol: "DDOG", chain: "robinhood", fdv_usd: 12345, fdv_quote: 12345, quote_key: "usdg", quote_symbol: "USDG", change_from_launch: 0.234, lp_fee: 10000, recipients: [{ payout: DEAD, bps: 10000 }], block_time: "2026-09-06T09:30:00Z" }, now);
  assert.deepEqual(c, { title: "Dollar Dog", symbol: "DDOG", chainLabel: "Robinhood Chain", mcap: "$12.3K", change: "+23%", up: true, fee: "1% fee, burned", age: "2h old", quote: null });
  assert.deepEqual(shapeCard({ name: "Base Stock Test", symbol: "BSTK", chain: "base", fdv_usd: 25206, fdv_quote: 109.6, quote_key: "stock", quote_symbol: "NVDAc", change_from_launch: 0, lp_fee: 10000, recipients: [{ payout: "0x00000000000000000000000000000000000c0ffe", bps: 10000 }], block_time: "2026-09-06T09:30:00Z" }, now).quote, { symbol: "NVDAc", ticker: "NVDA", kind: "stock" }, "stock quotes get a ticker tile on the card");
  assert.deepEqual(shapeCard({ name: "Lawb Fan", symbol: "LAWB", chain: "base", fdv_usd: 9800, fdv_quote: 580_000_000, quote_key: "gitlawb", quote_symbol: "GITLAWB", change_from_launch: 0, lp_fee: 10000, recipients: [], block_time: "2026-09-06T09:30:00Z" }, now).quote, { symbol: "GITLAWB", ticker: "GL", kind: "gitlawb" }, "GITLAWB quotes get the Gitlawb mark");
  assert.equal(feeLabel(0, []), "0% fee");
  assert.equal(feeLabel(30000, [{ payout: "0x1", bps: 10000 }]), "3% fee → beneficiary");
  assert.equal(feeLabel(10000, [{ payout: "0x1", bps: 6000 }, { payout: "0x2", bps: 4000 }]), "1% fee → beneficiaries");
  assert.equal(ageLabel("2026-09-06T11:59:30Z", now), "30s old");
  assert.equal(shapeCard({ name: "X", symbol: "X", chain: "base", fdv_usd: null, fdv_quote: 2.5, quote_key: "eth", quote_symbol: "ETH", change_from_launch: -0.5, lp_fee: 0, recipients: [], block_time: "2026-09-01T00:00:00Z" }, now).mcap, "2.50 ETH");
});

test("clampSocial: ≤125 chars on a word boundary with an ellipsis; short text untouched; whitespace collapsed", () => {
  assert.equal(clampSocial("short and sweet"), "short and sweet");
  assert.equal(clampSocial("a  b\n c"), "a b c");
  const long = "word ".repeat(60).trim();
  const c = clampSocial(long);
  assert.ok(c.length <= 125, `${c.length}`);
  assert.ok(c.endsWith("…"));
  assert.ok(!c.includes("wor…"), "cuts between words, not inside one");
  assert.equal(clampSocial("x".repeat(200)).length, 125, "no spaces → hard cut + ellipsis");
  assert.ok(clampSocial("x".repeat(200), 155).length <= 155);
});
