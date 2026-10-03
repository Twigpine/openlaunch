import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { CHAIN_KEYS } from "../chainKeys.ts";
import { MCAP_PRESETS, launchpad, listedQuoteAddresses, quoteInfo, quoteUsdOf } from "./config.ts";
import { MUSEWORLD_ADDRESS, MUSEWORLD_BLUE, MUSEWORLD_LOGO_PATH, timeWeightedPrice } from "./museworld.ts";
import { cleanQuoteSymbol } from "./unlisted-quote.ts";
import { quotePillOf } from "./ogcard.ts";

/**
 * MUSEWORLD is an official quote (museworld.ts): badged and priced wherever its launches are listed, never offered in
 * the launch form, since those launches are made inside Museworld by its agents.
 */
const src = (rel: string) => readFileSync(path.join(import.meta.dirname, rel), "utf8");

test("MUSEWORLD resolves on Base by address, with its logo; nowhere else", () => {
  const q = quoteInfo("base", "0x882C8E35504D58979B1280FE76D6553F717029F8");
  assert.equal(q.key, "museworld");
  assert.equal(q.symbol, "MUSEWORLD");
  assert.equal(q.decimals, 18, "on-chain decimals() = 18; the SQL sorts assume 18 for it");
  assert.equal(q.logo, MUSEWORLD_LOGO_PATH);
  assert.equal(quoteUsdOf(q, 4_000), null, "client-safe static: the server fills the price, never the ETH price");
  for (const k of CHAIN_KEYS.filter((k) => k !== "base")) assert.equal(quoteInfo(k, MUSEWORLD_ADDRESS).key, "other", `${k}: the same address is some other token`);
  assert.ok(listedQuoteAddresses("base").includes(MUSEWORLD_ADDRESS.toLowerCase()), "known, so the indexer does not treat it as unlisted");
});

test("MUSEWORLD is never offered in the launch form", () => {
  for (const k of CHAIN_KEYS) assert.ok(!launchpad(k).quotes.some((q) => q.key === "museworld"), k);
  assert.deepEqual(MCAP_PRESETS.museworld, []);
  assert.match(src("../../app/api/quotes/route.ts"), /launchpad\(chain\)\.quotes/, "the form's quote API lists the offered quotes only");
});

test("a fake MUSEWORLD at another address shows by address, not as ours", () => {
  for (const fake of ["MUSEWORLD", "museworld", "$MUSEWORLD", "MUSEWORLD2", "MuseWorld.v2"]) assert.equal(cleanQuoteSymbol(fake), null, fake);
  assert.equal(cleanQuoteSymbol("MUSE"), "MUSE", "a different name stays readable");
});

test("time-weighted price: a one-block push barely moves a 30-minute average", () => {
  const from = 0;
  const to = 1800;
  assert.equal(timeWeightedPrice([], 2, from, to), 2, "no swaps: the price before the window held throughout");
  assert.equal(timeWeightedPrice([], null, from, to), null, "nothing known");
  // steady at 1 for the window, pushed 10x for the last 2 seconds
  const pushed = timeWeightedPrice([{ t: 1798, price: 10 }], 1, from, to)!;
  assert.ok(pushed < 1.02, `pushed average ${pushed}`);
  // half the window at 1, half at 3
  assert.equal(timeWeightedPrice([{ t: 900, price: 3 }], 1, from, to), 2);
  // no baseline: the window starts at the first swap
  assert.equal(timeWeightedPrice([{ t: 900, price: 3 }, { t: 1500, price: 1 }], null, from, to), (3 * 600 + 1 * 300) / 900);
  // unordered input and junk prices are handled
  assert.equal(timeWeightedPrice([{ t: 1500, price: 1 }, { t: 900, price: 3 }, { t: 1000, price: Number.NaN }, { t: 1100, price: 0 }], null, from, to), (3 * 600 + 1 * 300) / 900);
  assert.equal(timeWeightedPrice([{ t: 10, price: 5 }], 1, 100, 100), null, "empty window");
});

test("server: priced from its own GITLAWB pool, guarded by the average, fails soft, ranks in USD sorts", () => {
  const q = src("queries.ts");
  assert.match(q, /if \(q\.key === "museworld"\) return \{ \.\.\.q, usd: museworldUsdNow \};/);
  assert.match(q, /row\.quote !== GITLAWB_ADDRESS\.toLowerCase\(\)\) return null;/, "only the MUSEWORLD/GITLAWB pool may price it");
  assert.match(q, /reconcileGitlawbUsd\(spot > 0 \? spot : null, twap\)/);
  assert.match(q, /perMuseworld \* gitlawbUsd/);
  assert.match(q, /museworldUsdNow = null; \/\/ fail soft/);
  assert.match(q, /WHEN \$\{quoteArms\("museworld"\)\} THEN \$\{museworldFactor\}::double precision/);
});

test("badge: Museworld blue with its logo, in every list and on the token page and share card", () => {
  assert.equal(MUSEWORLD_BLUE, "#0866FF");
  assert.ok(existsSync(path.join(import.meta.dirname, "../../../public", MUSEWORLD_LOGO_PATH)));
  for (const f of ["LaunchRow.tsx", "LaunchTape.tsx", "MeDashboard.tsx", "TrendingStrip.tsx"]) assert.match(src(`../../components/launchpad/${f}`), /<QuoteBrandBadge quoteKey=\{/, f);
  assert.match(src("../../app/t/[chain]/[token]/page.tsx"), /<MuseworldBadge label="Paired with MUSEWORLD" \/>/);
  assert.deepEqual(quotePillOf("museworld", "MUSEWORLD"), { symbol: "MUSEWORLD", ticker: "MW", kind: "museworld" });
  assert.match(src("../../app/t/[chain]/[token]/opengraph-image.tsx"), /official · priced in/);
});
