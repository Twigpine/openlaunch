import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { UNPRICED_LATERAL_SQL, UNPRICED_SWAPS_SQL, launchVolumeUsd, missingNow, tradeTimeUsd } from "./trade-time-usd.ts";

const ETH = 10n ** 18n;

test("trade-time USD = the stored sum, plus what has no stored value at today's price", () => {
  // all priced at their own hour: the stored sum, whatever today's price is (the old method would say 2 x 2,000)
  assert.equal(tradeTimeUsd(5_300, "0", 18, 2_000), 5_300);
  assert.equal(tradeTimeUsd(5_300, 0n, 18, null), 5_300, "a quote with no price right now keeps what was stored");
  // 1 ETH with no stored value counts at today's price
  assert.equal(tradeTimeUsd(5_300, ETH.toString(), 18, 2_000), 7_300);
  // 6-decimal quotes
  assert.equal(tradeTimeUsd(0, "100000000", 6, 1), 100);
  // nothing priced it at its hour and nothing prices it now: no USD
  assert.equal(tradeTimeUsd(0, ETH, 18, null), null);
  assert.equal(tradeTimeUsd(250, ETH, 18, null), 250, "the stored part still counts; the caller flags the rest as partial");
  // no trades at all
  assert.equal(tradeTimeUsd(0, "0", 18, 2_000), 0);
  assert.equal(tradeTimeUsd(0, "0", 18, null), null, "an unlisted quote with no trades shows no USD, as before");
  assert.equal(tradeTimeUsd(null, null, 18, 3), 0);
  assert.equal(tradeTimeUsd(Number.NaN, "0", 18, 3), 0, "a bad stored value is never shown");
});

test("a launch row shows its quote amount, not a smaller dollar figure, while part of its volume has no price at all", () => {
  assert.equal(launchVolumeUsd(500, (2n * ETH).toString(), 18, null), null, "ETH price down + 2 ETH unpriced: no dollar figure that looks complete");
  assert.equal(launchVolumeUsd(500, (2n * ETH).toString(), 18, 2_000), 4_500);
  assert.equal(launchVolumeUsd(500, "0", 18, null), 500, "everything has its trade-time value: no price needed now");
  assert.equal(launchVolumeUsd(0, "0", 18, null), null);
});

test("missingNow flags only a part that normally has a price but has none right now", () => {
  assert.equal(missingNow(ETH.toString(), null, true), true);
  assert.equal(missingNow(ETH.toString(), 2_000, true), false);
  assert.equal(missingNow(ETH.toString(), null, false), false, "an unlisted quote is unpriced by design, never 'partial'");
  assert.equal(missingNow("0", null, true), false);
  assert.equal(missingNow(null, null, true), false);
});

test("the unpriced read only touches rows with no stored value, per launch", () => {
  assert.match(UNPRICED_SWAPS_SQL, /FROM bb_launch_swaps WHERE usd IS NULL GROUP BY chain_id, token$/);
  // the lists probe one launch at a time (bb_launch_swaps_usd_missing_token_idx), never aggregate every unpriced trade
  assert.equal(UNPRICED_LATERAL_SQL, "SELECT sum(abs(x.amount0)) AS uq FROM bb_launch_swaps x WHERE x.chain_id = l.chain_id AND x.token = l.token AND x.usd IS NULL");
  const idx = readFileSync(path.join(process.cwd(), "db/concurrent-indexes.sql"), "utf8");
  assert.match(idx, /bb_launch_swaps_usd_missing_token_idx ON bb_launch_swaps \(chain_id, token\) WHERE usd IS NULL;/);
  assert.match(idx, /bb_launch_fee_events_usd_missing_idx ON bb_launch_fee_events \(chain_id, token\) WHERE usd IS NULL AND kind IN \('collected', 'burned'\);/);
  assert.match(UNPRICED_SWAPS_SQL, /sum\(abs\(amount0\)\) AS uq/, "buys and sells both count at their size, as volume_quote does");
});

test("the site reads trade-time USD everywhere the all-time figures are shown", () => {
  const q = readFileSync(path.join(process.cwd(), "src/lib/launchpad/queries.ts"), "utf8");
  // the list SELECT carries each launch's unpriced volume, joined once
  assert.match(q, /COALESCE\(u\.uq, 0\)::text AS volume_quote_unpriced/);
  assert.match(q, /LEFT JOIN LATERAL \(\$\{UNPRICED_LATERAL_SQL\}\) u ON true`;/);
  // a launch row's all-time volume
  assert.match(q, /volume_usd: launchVolumeUsd\(storedVolumeUsd, volume_quote_unpriced, q\.decimals, qu\)/);
  assert.doesNotMatch(q, /volume_usd: usd\(r\.volume_quote\)/, "never quote volume at today's price again");
  // the all-time Volume sort ranks by the same figure
  assert.match(q, /win === "all"\s*\? db`\(l\.volume_usd \+ COALESCE\(u\.uq, 0\) \/ power\(10, \$\{qd\}\) \* \$\{usdPerUnit\}\)`/);
  // the site totals: stored sums plus the unpriced parts, fees to recipients = collected - burned in USD
  const totals = q.slice(q.indexOf("export async function getLaunchTotals("), q.indexOf("export async function getLaunchTotals(") + 6000);
  assert.match(totals, /COALESCE\(sum\(l\.volume_usd\), 0\)::float8 AS volume_usd/);
  assert.ok(totals.includes(`LEFT JOIN (${UNPRICED_SWAPS_SQL}) u ON u.chain_id = l.chain_id AND u.token = l.token`), "the totals inline the same unpriced read as the lists");
  assert.match(totals, /WHERE f\.usd IS NULL AND \(f\.kind = 'collected' OR \(f\.kind = 'burned' AND f\.currency = fl\.quote\)\)/);
  assert.match(totals, /t\.volume_usd \+= tradeTimeUsd\(r\.volume_usd, r\.volume_unpriced, q\.decimals, usd\) \?\? 0;/);
  assert.match(totals, /t\.fees_to_creators_usd \+= collectedUsd - burnedUsd;/);
  assert.doesNotMatch(totals, /units\(r\.volume, q\.decimals\) \* qu/, "the old method is gone from the totals");
});
