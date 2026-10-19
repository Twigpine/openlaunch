import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";

// Source contracts for Boost (like earn-ui.test.ts): they hold the rules that keep a paid lane honest in place.
const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8").replaceAll("\r\n", "\n");
const dialog = read("./BoostDialog.tsx");
const panel = read("./BoostPanel.tsx");
const lane = read("./BoostedLane.tsx");
const admin = read("./BoostAdmin.tsx");
const rulesEntry = read("./BoostRulesEntry.tsx");
const rules = read("../../app/rules/page.tsx");
const dashboard = read("./MeDashboard.tsx");
const server = read("../../lib/launchpad/boostServer.ts");
const boostSwitch = read("../../lib/launchpad/boostSwitch.ts");
const live = read("./LiveProvider.tsx");
const layout = read("../../app/layout.tsx");
const syncRoute = read("../../app/api/launch/sync/route.ts");
const landing = read("./ChainLanding.tsx");
const css = read("../../app/globals.css");
const indexer = read("../../lib/launchpad/indexer.ts");
const queries = read("../../lib/launchpad/queries.ts");
const liveRoute = read("../../app/api/launch/live/route.ts");
const boostRoute = read("../../app/api/boost/route.ts");
const llms = read("../../app/llms.txt/route.ts");
const home = read("../../app/(home)/page.tsx");
const tokenPage = read("../../app/t/[chain]/[token]/page.tsx");
const seenRoute = read("../../app/api/boost/seen/route.ts");
const statsRoute = read("../../app/api/boost/stats/route.ts");

test("the ranking never reads boosts: no paid row can enter the Live sort or the Trending board", () => {
  // boost code, not the English word (the board's own copy says fresh tokens "get a boost" in score)
  // bb_boost also covers the lane's views and clicks (bb_boost_views, bb_boost_clicks): attention never ranks either
  const BOOST_CODE = /from ["'][^"']*[bB]oost[^"']*["']|bb_boost|BOOST_|[bB]oostLane|useBoostOn|getTokenBoost|live\.boost|snap\.boost/;
  for (const f of ["../../lib/launchpad/ranking.ts", "../../lib/launchpad/trending-live.ts", "../../lib/launchpad/trending-board.ts", "./TrendingStrip.tsx", "./LaunchList.tsx"]) {
    assert.doesNotMatch(read(f), BOOST_CODE, f);
  }
  // queries.ts names bb_boosts only inside getLaunchTotals (the TWIG burned figure), never in a list or ranking query
  const start = queries.indexOf("export async function getLaunchTotals(");
  const end = queries.indexOf("\n}\n", start);
  assert.ok(start > 0 && end > start);
  // the only imports it needs: the chain id the totals filter on, and the switch that gates them
  const IMPORTS = ['import { BOOST_CHAIN_ID } from "./boost";\n', 'import { boostEnabled } from "./boostSwitch";\n'];
  for (const imp of IMPORTS) assert.equal(queries.split(imp).length, 2, imp);
  const outside = IMPORTS.reduce((acc, imp) => acc.replace(imp, ""), queries.slice(0, start) + queries.slice(end));
  assert.doesNotMatch(outside, BOOST_CODE);
  assert.doesNotMatch(queries.slice(start, end), /bb_boost_(clicks|views)/);
  // the totals count only boosts that name a launch, and only while the switch is on
  assert.match(queries.slice(start, end), /boostEnabled\(\)\n\s*\? db<\{ burned: string \}\[\]>`\n\s*SELECT COALESCE\(sum\(b\.amount\), 0\)::text AS burned FROM bb_boosts b\n\s*JOIN bb_launches l ON l\.chain_id = b\.chain_id AND l\.token_id = b\.tag/);
});

test("a boost is one plain TWIG transfer to 0x…dEaD: simulated, credited to the builder code, never an approval", () => {
  assert.match(dialog, /simulateContract\(\{ address: BOOST_TOKEN as `0x\$\{string\}`, abi: ERC20_TRANSFER_ABI, functionName: "transfer", args: \[DEAD, raw\], account: address, dataSuffix: BUILDER_DATA_SUFFIX \}\)/);
  assert.equal((dialog.match(/writeContract\(/g) ?? []).length, 1);
  assert.match(dialog, /wallet\.writeContract\(request\)/);
  assert.doesNotMatch(dialog, /approve|maxUint|sendTransaction|signMessage/);
  // the amount is built from the launch's own position id, only once the checks pass
  assert.match(dialog, /whole !== null && problem === null \? boostAmount\(whole, tag\) : null/);
  assert.match(dialog, /const tag = BigInt\(tokenId\)/);
  // the transfer ABI is reachable from the two audited senders alone: this dialog, and the community pair fee step
  // (PairApplication.tsx, held to the same rules in pairApply.test.ts)
  const users = walk(path.resolve(import.meta.dirname, "../..")).filter((f) => !f.endsWith(".test.ts") && readFileSync(f, "utf8").includes("ERC20_TRANSFER_ABI"));
  assert.deepEqual(users.map((f) => path.basename(f)).sort(), ["BoostDialog.tsx", "PairApplication.tsx", "abi.ts"]);
});

test("the send locks before its first await and simulates before the wallet is asked", () => {
  const body = dialog.slice(dialog.indexOf("async function send()"));
  const lockAt = body.indexOf("lock.current = true");
  assert.ok(lockAt > 0 && lockAt < body.indexOf("await"), "lock before the first await");
  assert.ok(body.indexOf("simulateContract") < body.indexOf("writeContract"), "simulate before write");
  assert.match(body, /if \(chainId !== BASE\.id\) await switchChainAsync\(\{ chainId: BASE\.id \}\)/);
});

test("sent means sent: an unread receipt locks the dialog instead of inviting a second burn", () => {
  const body = dialog.slice(dialog.indexOf("async function send()"), dialog.indexOf("async function settle("));
  // the hash is handed to the panel before the receipt wait, and a failed wait is "unconfirmed", never "error"
  assert.ok(body.indexOf("onPending({ hash, whole })") < body.indexOf("waitForTransactionReceipt"));
  assert.match(body, /catch \{\n\s*\/\/ sent, outcome unknown[^\n]*\n\s*setPhase\(\{ k: "unconfirmed", hash, whole, checking: false, note: null \}\);\n\s*return;/);
  assert.match(dialog, /const busy = phase\.k === "preparing" \|\| phase\.k === "signing" \|\| phase\.k === "sent" \|\| phase\.k === "unconfirmed";/);
  assert.match(dialog, /useState<Phase>\(pending \? \{ k: "unconfirmed", \.\.\.pending, checking: false, note: null \} : \{ k: "idle" \}\)/);
  // the panel owns the pending hash, so closing and reopening keeps the lock
  assert.match(panel, /pending=\{pending\} onPending=\{setPending\}/);
  // only a receipt settles it, and the sync call indexes it at once
  assert.match(dialog, /await fetch\(`\/api\/launch\/sync\?chain=\$\{BOOST_CHAIN\}&tx=\$\{hash\}`, \{ method: "POST" \}\)/);
});

test("the dialog says where the TWIG goes, that it is final, and that the ranking is untouched", () => {
  for (const key of ["what", "tag", "final"]) assert.match(dialog, new RegExp(`BOOST_COPY\\.${key}`), key);
  assert.match(dialog, /0x…dEaD \(burned\)/);
  assert.match(dialog, /Platform fee<\/dt><dd[^>]*>\$0/);
});

test("everything stays dark while BOOST is off", () => {
  assert.match(boostSwitch, /return process\.env\.BOOST\?\.trim\(\)\.toLowerCase\(\) === "on";/);
  assert.match(server, /export \{ boostEnabled \};/);
  assert.match(lane, /if \(!lane\.enabled\) return null;/);
  assert.match(panel, /if \(!state\.enabled\) return null;/);
  assert.match(admin, /if \(lane && !lane\.enabled\) return null;/);
  assert.match(rules, /\{boostEnabled\(\) \? <BoostRulesEntry \/> : null\}/);
  assert.doesNotMatch(rulesEntry, /"use client"/);
  assert.match(dashboard, /boostOn && l\.chain === BOOST_CHAIN \?/);
  assert.match(llms, /if \(!boostEnabled\(\)\) return "";/);
  assert.match(boostRoute, /if \(!boostEnabled\(\)\) return NextResponse\.json\(\{ enabled: false \}/);
  assert.match(tokenPage, /const boostable = chain === BOOST_CHAIN && boostEnabled\(\);/);
});

test("a failed lane read never breaks a page or blanks open tabs", () => {
  assert.match(server, /\.catch\(\(err\) => \{\n\s*console\.warn\("\[boost\] lane read failed:"/);
  assert.match(liveRoute, /boost: boost \?\? undefined/);
  assert.match(home, /<BoostedLane initial=\{boost \?\? \{ enabled: false \}\} serverNow=\{now\} source="home" \/>/);
  // a tick without the lane is no news: the cards stay as they are
  assert.match(lane, /const next = snap\.boost;\n\s*if \(!next\) return;/);
  // the lane sits after the facts-only board, never inside it
  assert.ok(home.indexOf("<TrendingStrip") < home.indexOf("<BoostedLane"));
});

test("the indexer reads TWIG transfers to 0x…dEaD on Base only and skips the locker's fee burns", () => {
  assert.match(indexer, /const twig = TWIG_ADDRESSES\[chain\];\n\s*if \(twig\) \{\n\s*const burnLogs = await fetchLogsSplit\(\(f, t\) => client\.getLogs\(\{ address: twig as Address, event: ERC20_TRANSFER_EVENT, args: \{ to: DEAD \}, fromBlock: f, toBlock: t \}\), from, to\);/);
  assert.match(indexer, /applyBoost\(db, chain, l as Log & \{ args: TransferArgs \}, locker\.toLowerCase\(\)\)/);
  assert.match(indexer, /applyBoost\(db, chain, l as unknown as Log & \{ args: TransferArgs \}, locker\)/);
  assert.match(indexer, /INSERT INTO bb_boosts \(chain_id, tx_hash, log_index, booster, amount, tag, block_number, block_time\)[\s\S]*?ON CONFLICT DO NOTHING/);
});

test("moderation is admin-only, signed over its own message, with a single-use nonce", () => {
  const body = server.slice(server.indexOf("export async function moderateBoost("));
  const adminAt = body.indexOf("if (!adminWallets().has(wallet)) return fail(\"admin only\", 403);");
  const verifyAt = body.indexOf("await verify(BOOST_CHAIN, wallet, message, p.signature)");
  const nonceAt = body.indexOf("await consumeNonce(p.nonce, wallet)");
  const writeAt = body.indexOf("INSERT INTO bb_token_settings");
  assert.ok(adminAt > 0 && adminAt < verifyAt && verifyAt < nonceAt && nonceAt < writeAt);
  assert.match(body, /const message = buildBoostModMessage\(/);
  // a hidden token is out of the lane, and its page offers no button
  assert.match(server, /AND NOT COALESCE\(s\.boost_hidden, false\)/);
  assert.match(panel, /\{state\.hidden \? \(\n\s*<p[^>]*>\{BOOST_COPY\.hidden\}<\/p>\n\s*\) : \(/);
});

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(p)) out.push(p);
  }
  return out;
}

test("only a lane on screen downloads the lane; every page gets the switch as one boolean", () => {
  assert.match(lane, /useEffect\(\(\) => wantBoost\(\), \[wantBoost\]\);/);
  assert.match(live, /if \(boostWanted\.current > 0\) parts\.push\("boost=1"\);/);
  assert.match(liveRoute, /wantsBoost \? boostLaneOrNull\(usd\) : Promise\.resolve\(null\)/);
  assert.match(liveRoute, /boost_on: boostEnabled\(\), boost: boost \?\? undefined/);
  // the switch survives a tick from an older machine; the lane does not pretend to
  assert.match(live, /boost_on: data\.boost_on \?\? last\.current\.boost_on/);
  assert.doesNotMatch(live, /boost: data\.boost \?\?/);
  assert.match(layout, /boost_on: boostEnabled\(\)/);
  assert.match(read("./useBoostOn.ts"), /useState\(live\.boost_on === true\)/);
  // /base keeps the lane mounted, so a switch-on reaches an open tab
  assert.match(landing, /chain === BOOST_CHAIN \? <div className="mt-14 empty:hidden"><BoostedLane initial=\{boost \?\? \{ enabled: false \}\} serverNow=\{now\} source="base" \/>/);
});

test("a write that changes the lane makes the next read fresh", () => {
  assert.match(syncRoute, /if \(r\.boosts\) forgetBoostLane\(\);/);
  const mod = server.slice(server.indexOf("export async function moderateBoost("));
  assert.ok(mod.indexOf("forgetBoostLane();") > mod.indexOf("INSERT INTO bb_token_settings"));
  assert.match(panel, /again\.current = setTimeout\(read, 6_000\);/);
});

test("a boost that cannot enter a full lane is said so before anything is sent", () => {
  assert.match(dialog, /const shows = raw === null \|\| boostShowsNow\(entry, current, raw, inLane\);/);
  assert.match(dialog, /\{problem === null && !shows \? \(/);
  assert.match(dialog, /BOOST_COPY\.short/);
  // the done screen never claims a place the boost did not get
  assert.match(dialog, /phase\.shows \? `\$\{name\} is in the Boosted lane\.` : `\$\{name\} is not in the lane yet/);
});

test("the lane moves only when something happens, and reduced motion keeps only colour", () => {
  assert.match(lane, /const lit = boostIgnitions\(prev\.current, next\.items, t\);/);
  assert.match(lane, /<span key=\{`ring-\$\{lit\}`\} aria-hidden="true" className="bb-boost-ring/);
  assert.match(lane, /const fuse = boostFuse\(b\.last_at, now\);/);
  assert.match(lane, /layout=\{reduced \? false : "position"\}/);
  // no looping animation anywhere in the lane
  assert.doesNotMatch(lane, /animate-(ping|pulse|spin|bounce)|infinite|BorderBeam|ShineBorder/);
  assert.match(css, /\.bb-boost-ring \{ animation: bb-boost-ring 2\.4s ease-out 1 both; \}/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{ \.bb-ember \{ display: none; \} \}/);
});

test("CodeRabbit round 1: the done screen, admin errors and the agent formula", () => {
  // both ways a receipt can arrive settle with the same rule: never a hard-coded "it shows"
  assert.equal((dialog.match(/await settle\(hash, whole, rc\.status === "success", showsAfter\(whole\)\);/g) ?? []).length, 2);
  assert.doesNotMatch(dialog, /settle\([^)]*, true\)/);
  assert.match(dialog, /const showsAfter = \(w: bigint\): boolean => !tagOk \|\| boostShowsNow\(entry, current, boostAmount\(w, tag\), inLane\);/);
  // an error page that is not JSON still reports the HTTP failure; a bad lane read never throws from the effect
  assert.match(admin, /const d = \(await res\.json\(\)\.catch\(\(\) => \(\{\}\)\)\) as \{ error\?: string; lane\?: BoostLane \| null \};/);
  assert.match(admin, /throw new Error\(d\.error \?\? `request failed \(HTTP \$\{res\.status\}\)`\);/);
  assert.match(admin, /const load = useCallback\(async \(\) => \{\n\s*try \{/);
  // agents get the bounds the decoder enforces (isLaunchTag: 0 < tag < 10^11; whole TWIG >= the floor)
  assert.match(llms, /whole = a count of whole TWIG, at least \$\{BOOST_FLOOR_TWIG\}/);
  assert.match(llms, /greater than 0 and less than 10\^11/);
});

test("the whole card opens the token; only the credit's name sits above it as its own target", () => {
  // the token link's ::after covers the card (LaunchCard's pattern), and keyboard focus rings the whole card
  assert.match(lane, /className="flex min-w-0 items-center gap-2\.5 outline-none \[grid-area:link\] after:absolute after:inset-0 after:z-\[1\] focus-visible:after:ring-2 focus-visible:after:ring-inset focus-visible:after:ring-brand sm:pr-5"/);
  // the credit: the profile link (or the address's explorer link) is raised above the card's link; "by" stays the card's
  assert.match(lane, /<WhoName\n\s*address=\{b\.top_booster\}\n\s*className="relative z-\[2\] text-\[10px\]"/);
  assert.match(lane, /href=\{explorerAddress\(BOOST_CHAIN, b\.top_booster\)\} target="_blank" rel="noreferrer" className="relative z-\[2\] /);
  // one link per card: no link wraps the card, and the stats tooltip moved onto the link that covers it
  assert.equal((lane.match(/<Link\b/g) ?? []).length, 1);
  assert.match(lane, /<Link\n\s*href=\{`\/t\/\$\{l\.chain\}\/\$\{l\.token\}`\}\n\s*title=\{`\$\{b\.boosts\}/);
  // the decorations never take a click
  for (const m of lane.matchAll(/<span aria-hidden="true" className="([^"]*absolute inset-[^"]*)"/g)) assert.match(m[1], /pointer-events-none/, m[1]);
});

test("a hover is only ever the visitor's doing, and reduced motion keeps only colour", () => {
  assert.match(lane, /className=\{`group\/card relative grid min-w-0 [^`]* transition-colors duration-150 hover:bg-\[color-mix\(in_oklab,var\(--color-warm-soft\)_70%,var\(--color-card\)\)\] active:bg-warm-soft motion-reduce:transition-none/);
  // movement (the avatar's scale, the arrow's slide) only with motion allowed; colour and the edge stay for everyone
  assert.match(lane, /motion-safe:group-hover\/card:scale-105/);
  assert.match(lane, /motion-safe:-translate-x-0\.5 motion-safe:translate-y-0\.5 motion-safe:group-hover\/card:translate-x-0/);
  assert.doesNotMatch(lane, /(?<!motion-safe:)group-hover\/card:(scale|translate)/);
  // a hover never starts a looping animation or replays the ignition
  assert.doesNotMatch(lane, /hover[^"\s]*:(animate|bb-)/);
});

test("the lane counts one view per page and each card click, sent without holding up the click", () => {
  assert.match(lane, /navigator\.sendBeacon\?\.\("\/api\/boost\/seen", data\)/);
  assert.match(lane, /void fetch\("\/api\/boost\/seen", \{ method: "POST", body: data, keepalive: true \}\)\.catch\(\(\) => \{\}\);/);
  // a click (and a middle click, which fires no click event) reports the card's token
  assert.match(lane, /setPendingToken\([^\n]*\);\n\s*sendSeen\(\{ kind: "click", token: l\.token \}, source\);/);
  assert.match(lane, /if \(e\.button === 1\) sendSeen\(\{ kind: "click", token: l\.token \}, source\);/);
  // the view: once per mount, when the lane with cards in it is on screen
  assert.match(lane, /if \(viewed\.current \|\| !entries\.some\(\(e\) => e\.isIntersecting\)\) return;\n\s*viewed\.current = true;\n\s*io\.disconnect\(\);\n\s*sendSeen\(\{ kind: "view" \}, source\);/);
  assert.equal((lane.match(/sendSeen\(/g) ?? []).length, 4, "the helper, the view, the click, the middle click");
});

test("a click counts only while the token is in the lane, at the server's place, once per visitor and slot", () => {
  const body = server.slice(server.indexOf("export async function recordBoostSeen("), server.indexOf("export type BoostStatsRow"));
  assert.match(body, /^export async function recordBoostSeen\(seen: BoostSeen, visitorHash: string, ethUsdNow: number \| null\): Promise<boolean> \{\n\s*if \(!boostEnabled\(\)\) return false;/);
  assert.match(body, /const place = boostPlace\(lane, seen\.token\);\n\s*if \(place === null\) return false;/);
  assert.match(body, /ON CONFLICT DO NOTHING RETURNING 1/);
  assert.doesNotMatch(body, /seen\.place|seen\.source === /, "nothing but the token and the source come from the request");
  // the lane is the one pages and polls read (same cache), and a boost that ran out inside it is dropped there, once
  assert.match(server, /const lane = await boostLaneOrNull\(ethUsdNow\);\n\s*return lane\?\.enabled \? lane\.items\.map\(\(b\) => b\.token\) : \[\];/);
  const orNull = server.slice(server.indexOf("export async function boostLaneOrNull("), server.indexOf("/** One token's boost state"));
  assert.match(orNull, /return \{ \.\.\.lane, items: lane\.items\.filter\(\(b\) => boostTimeLeft\(b\.last_at, now\) !== null\) \};/);
  assert.equal((server.match(/boostTimeLeft\(/g) ?? []).length, 1, "one expiry filter on the server");
  // no address, wallet or raw presence hash is stored: the visitor is the daily hash mixed with the token
  assert.match(server, /createHash\("sha256"\)\.update\(`\$\{visitorHash\}\|\$\{token\}`\)\.digest\("hex"\)\.slice\(0, 32\)/);
  // the address alone: no user agent (the caller's to choose) goes into a click's visitor, and the bucket is the same key
  assert.match(seenRoute, /const ip = boostClickAddress\(clientIp\(req\)\);/);
  assert.match(seenRoute, /await recordBoostSeen\(seen, visitorHash\(ip, ""\), await ethUsd\(\)\);/);
  assert.doesNotMatch(seenRoute, /visitorHash\(ip, ua\)/);
  // the address key uses node:net, so it lives in a server-only module; boost.ts ships to the browser with the lane
  assert.match(seenRoute, /import \{ boostClickAddress \} from "@\/lib\/launchpad\/boostAddress";/);
  const address = read("../../lib/launchpad/boostAddress.ts");
  assert.match(address, /^import "server-only";\nimport \{ isIP \} from "node:net";/);
  assert.doesNotMatch(read("../../lib/launchpad/boost.ts"), /from "node:|boostClickAddress/);
  assert.doesNotMatch(lane, /boostAddress/);
  assert.match(seenRoute, /return new NextResponse\(null, \{ status: 204 \}\);\n\}/);
});

test("views and clicks are read in boostServer.ts alone; the full table only for an admin wallet", () => {
  const users = walk(path.resolve(import.meta.dirname, "../..")).filter((f) => !f.endsWith(".test.ts") && /bb_boost_(clicks|views)/.test(readFileSync(f, "utf8")));
  assert.deepEqual(users.map((f) => path.basename(f)), ["boostServer.ts"]);
  assert.ok(statsRoute.indexOf('if (!adminWallets().has(wallet)) return NextResponse.json({ error: "admin only" }, { status: 403 });') < statsRoute.indexOf("getBoostStats("));
  assert.match(statsRoute, /if \(!isBoostStatsDays\(days\)\) return NextResponse\.json\(\{ error: "bad days" \}, \{ status: 400 \}\);/);
  assert.match(admin, /\{address \? <LaneStats wallet=\{address\} \/> : null\}/);
});

test("each card shows its clicks of the last 24 hours, never a 0, and a failed read never fails the lane", () => {
  assert.match(lane, /\{clicks > 0 \? \(\n\s*<span className="[^"]*\[grid-area:clicks\]">\n\s*<MousePointerClick size=\{11\} aria-hidden="true"[^>]*\/>\n\s*<LiveNumber value=\{clicks\} format=\{CLICKS_FORMAT\} \/>\n\s*<span className="sr-only">\{clicks === 1 \? " click" : " clicks"\} in the last 24 hours<\/span>/);
  // a poll from a machine still on the older build (mid-deploy) has no clicks: none shown, never "undefined"
  assert.match(lane, /const clicks = b\.clicks \?\? 0;/);
  assert.doesNotMatch(lane.replace("b.clicks ?? 0", ""), /b\.clicks/);
  // the count is the lane's own window, read with the lane; a read that fails is no counts, not no lane
  const body = server.slice(server.indexOf("async function laneClicks("), server.indexOf("export async function getBoostLane("));
  assert.match(body, /AND clicked_at > now\(\) - make_interval\(hours => \$\{BOOST_WINDOW_H\}\)/);
  assert.match(body, /\} catch \(err\) \{\n\s*console\.warn\("\[boost\] lane clicks read failed:"[^\n]*\n\s*return new Map\(\);/);
  assert.match(server, /const items = shown\.map\(\(t\) => \(\{ \.\.\.t, clicks: clicks\.get\(t\.token\) \?\? 0, top_booster: boosters\.get\(t\.token\) \}\)\);/);
  // a click count is no ignition: only more TWIG lights a card
  assert.match(read("../../lib/launchpad/boost.ts"), /const grew = before === undefined \|\| BigInt\(it\.twig\) > BigInt\(before\);/);
});

test("a phone gets a compact row with all five places; from 640px the stacked card", () => {
  assert.match(lane, /\[grid-template-areas:'link_twig_twig'_'link_clicks_left'_'by_by_by'\]/);
  assert.match(lane, /sm:\[grid-template-areas:'link_link'_'twig_left'_'by_clicks'\]/);
  for (const area of ["link", "twig", "clicks", "left", "by"]) assert.match(lane, new RegExp(`\\[grid-area:${area}\\]`), area);
  // the credit lines up under the name on a phone (avatar 32 + gap 10)
  assert.match(lane, /\[grid-area:by\] max-sm:pl-\[42px\]/);
  // the burn proof left the card for the credit; the token page keeps it
  assert.doesNotMatch(lane, /Latest burn|explorerTx/);
  assert.match(panel, /explorerTx\(BOOST_CHAIN, state\.last_tx\)/);
});

test("a page view never writes in the request: views are tallied and flushed every few seconds per machine", () => {
  const record = server.slice(server.indexOf("export async function recordBoostSeen("), server.indexOf("/** One token's lane figures"));
  assert.match(record, /if \(seen\.kind === "view"\) \{\n\s*if \(lane\.length === 0\) return false;\n\s*queueViews\(lane, Date\.now\(\)\);\n\s*return true;\n\s*\}/);
  assert.doesNotMatch(record, /bb_boost_views/);
  assert.match(server, /const VIEW_FLUSH_MS = 10_000;/);
  assert.match(server, /viewFlush = setTimeout\(\(\) => void flushViews\(\), VIEW_FLUSH_MS\);\n\s*viewFlush\.unref\?\.\(\);/);
  assert.match(server, /ON CONFLICT \(chain_id, token, hour_at\) DO UPDATE SET views = bb_boost_views\.views \+ EXCLUDED\.views/);
  // the batch is taken before the write, so a failed flush cannot grow the tally; a bound anyway
  assert.match(server, /const batch = \[\.\.\.pendingViews\];\n\s*pendingViews\.clear\(\);/);
  assert.match(server, /if \(pendingViews\.size > 1_000\) pendingViews\.clear\(\);/);
  // click rows (a visitor of one day each) are pruned hourly, off the request path
  assert.match(server, /DELETE FROM bb_boost_clicks WHERE chain_id = \$\{BOOST_CHAIN_ID\} AND clicked_at < now\(\) - make_interval\(days => \$\{BOOST_CLICKS_KEEP_DAYS\}\)/);
});

test("the admin figures compare like with like and total every token", () => {
  const stats = server.slice(server.indexOf("export async function getBoostStats("));
  // views, clicks and burns start at the same whole hour
  assert.equal((stats.match(/>= date_trunc\('hour', now\(\) - make_interval\(days => \$\{days\}\)\)/g) ?? []).length, 3);
  // totals are window sums over every token, taken before LIMIT
  assert.match(stats, /\(count\(\*\) OVER \(\)\)::int AS all_tokens, \(sum\(COALESCE\(v\.views, 0\)\) OVER \(\)\)::int AS all_views/);
  assert.match(stats, /LIMIT \$\{STATS_ROWS\}/);
  // visitors have no total (a visitor is counted per token), and a period never shows another period's error
  assert.match(admin, /title="Not added up: a visitor is counted per token">–<\/td>/);
  assert.match(admin, /const err = !stats && failed\?\.key === key \? failed\.text : null;/);
});

test("the lane never counts a view of its empty line, and the hover arrow never covers the TWIG on a narrow window", () => {
  assert.match(lane, /const shown = lane\.enabled \? lane\.items\.filter\(\(b\) => boostTimeLeft\(b\.last_at, now\) !== null\) : \[\];/);
  assert.match(lane, /const hasCards = shown\.length > 0;/);
  assert.match(lane, /const items = shown;/);
  assert.match(lane, /<ArrowUpRight size=\{14\} aria-hidden="true" className="pointer-events-none absolute right-3 top-3 text-warm-ink max-sm:hidden /);
});

const picker = read("./BoostPicker.tsx");
const list = read("../../app/api/launch/list/route.ts");

test("the lane invites a boost: a header button, every open place a button, and what it takes to get in", () => {
  assert.match(lane, /const open = Math\.max\(0, BOOST_LANE_SIZE - items\.length\);\n\s*\/\/ read off the cards shown, so it can never contradict them\n\s*const entryLine = boostEntryLine\(items\.map\(\(b\) => b\.twig\)\);/);
  assert.doesNotMatch(server.slice(server.indexOf("export async function getBoostLane("), server.indexOf("export async function boostLaneOrNull(")), /laneEntry/, "the lane's line is never the server's ranked cutoff");
  assert.match(lane, /<button type="button" onClick=\{pick\} className=\{`\$\{btn\.warmOutlineSm\} ml-auto shrink-0`\}>\n\s*<Flame size=\{14\} aria-hidden="true" \/>\n\s*\{BOOST_COPY\.cta\}/);
  // the entry line never squeezes beside the button on a phone: a full line of its own there
  assert.match(lane, /<p className="order-last basis-full text-\[12px\] text-warm-ink tnum sm:order-none sm:basis-auto">\{entryLine\}<\/p>/);
  // one button per open place from 1024px, one row for all of them below; none once the lane is full
  assert.match(lane, /\{Array\.from\(\{ length: open \}, \(_, i\) => \(\n\s*<li key=\{`open-\$\{i\}`\} className="hidden min-h-\[104px\] bg-card lg:flex">\n\s*<button type="button" onClick=\{pick\}/);
  assert.match(lane, /\{open > 0 \? \(\n\s*<li className="bg-card sm:col-span-2 lg:hidden">/);
  assert.doesNotMatch(lane, /aria-hidden="true" className="hidden items-center justify-center bg-card/, "open places are buttons now, not hidden text");
  // the picker loads on first use; the lane itself never sends anything
  assert.match(lane, /const BoostPicker = dynamic\(\(\) => import\("\.\/BoostPicker"\), \{ ssr: false \}\);/);
  assert.match(lane, /\{picking \? <BoostPicker onClose=\{\(\) => setPicking\(false\)\} \/> : null\}/);
  // the list counts the lane's places (cards, then open ones), not only boosted tokens
  assert.match(lane, /<ol aria-label="Places in the Boosted lane"/);
  // the credited wallets' names come with the lane (null = no profile), so the first paint has no address-to-name swap
  assert.match(server, /items, names: await creditNames\(\[\.\.\.boosters\.values\(\)\]\) \};/);
  assert.match(server, /const known = await namesFor\(wallets\)\.catch\(\(\) => null\);\n\s*return known \? Object\.fromEntries\(wallets\.map\(\(w\) => \[w, known\[w\] \?\? null\]\)\) : \{\};/);
  assert.match(lane, /<NamesProvider names=\{lane\.names \?\? NO_NAMES\}>/);
  // a public read of the lane comes from the same few-second cache: polling it adds no database pass, and no query
  // parameter skips it (CodeRabbit #102: a wallet in the URL is not proof of an admin)
  assert.match(boostRoute, /const lane = await boostLaneOrNull\(await ethUsd\(\)\);/);
  assert.doesNotMatch(boostRoute, /getBoostLane|searchParams\.get\("fresh"\)|adminWallets/);
  // the only fresh read is the answer to a signed, single-use moderation request, after the write
  const modRoute = read("../../app/api/boost/mod/route.ts");
  assert.ok(modRoute.indexOf("if (!r.ok) return") < modRoute.indexOf("getBoostLane(await ethUsd(), { fresh: true })"), "fresh only after a verified write");
  assert.match(modRoute, /return NextResponse\.json\(\{ \.\.\.r, lane \}\);/);
  assert.match(server, /const ranked = opts\.fresh \? rankLane\(await laneTotals\(BOOST_LANE_SIZE \* 4\), BOOST_LANE_SIZE \* 4\) : await rankedLane\(\);/);
  // the panel takes that lane; its own reads are the cached ones everyone gets
  assert.match(admin, /if \(d\.lane\) \{\n\s*setLane\(d\.lane\);\n\s*\} else \{/);
  assert.match(admin, /fetch\(`\/api\/boost\?chain=\$\{BOOST_CHAIN\}`, \{ cache: "no-store" \}\)/);
  assert.doesNotMatch(admin, /fresh=1|justHidden|JUST_HIDDEN/);
});

test("the picker only navigates: the boost happens on the token's page, with every check the dialog has", () => {
  assert.match(picker, /router\.push\(`\/t\/\$\{BOOST_CHAIN\}\/\$\{t\.token\}\?boost=1#boost`\);/);
  assert.doesNotMatch(picker, /wagmi|viem|writeContract|sendTransaction|simulateContract|signMessage|BoostDialog/);
  // Base only, in every list it reads; the wallet's own launches by the launcher filter, only as many as are shown
  assert.match(picker, /\/api\/launch\/search\?q=\$\{encodeURIComponent\(q\)\}&chain=\$\{BOOST_CHAIN\}&order=holders/);
  assert.match(picker, /\/api\/launch\/list\?chain=\$\{BOOST_CHAIN\}&sort=live/);
  assert.match(picker, /\/api\/launch\/list\?chain=\$\{BOOST_CHAIN\}&launcher=\$\{wallet\}&sort=new&limit=\$\{MINE_MAX\}/);
  assert.doesNotMatch(picker, /\/api\/me/);
  assert.equal((picker.match(/\.filter\(\(l\) => l\.chain === BOOST_CHAIN\)/g) ?? []).length, 3);
  // a token an admin keeps out of the lane is said so here, never a trip to a page with no Boost button
  assert.match(picker, /const kept = await fetch\(`\/api\/boost\?chain=\$\{BOOST_CHAIN\}&token=\$\{t\.token\}`/);
  assert.match(picker, /if \(kept\) \{\n\s*setHidden\(\(h\) => new Set\(h\)\.add\(t\.token\)\);\n\s*return;\n\s*\}/);
  assert.ok(picker.indexOf("if (kept)") < picker.indexOf("router.push("));
  // closing the picker mid-check aborts the check, and an aborted check never navigates (CodeRabbit #101)
  assert.match(picker, /useEffect\(\(\) => \(\) => pickCheck\.current\?\.abort\(\), \[\]\);/);
  assert.match(picker, /\{ cache: "no-store", signal: ac\.signal \}\)/);
  assert.match(picker, /if \(ac\.signal\.aborted\) return;/);
  const pickBody = picker.slice(picker.indexOf("const pick = async"), picker.indexOf("const row = "));
  assert.ok(pickBody.indexOf("if (ac.signal.aborted) return;") < pickBody.indexOf("setChecking(null)"));
  assert.ok(pickBody.indexOf("if (ac.signal.aborted) return;") < pickBody.indexOf("router.push("));
  assert.match(list, /const launcher = l && isAddress\(l\) \? l\.toLowerCase\(\) : undefined;/);
  // the connected wallet's own launches first; an answer for another wallet is never shown
  assert.match(picker, /const own = mine && mine\.wallet === wallet \? mine\.tokens : \[\];/);
  assert.match(picker, /BOOST_COPY\.pickerNote/);
});

test("a card credits the wallet that sent the most TWIG for it; a failed read shows no credit, never no lane", () => {
  const body = server.slice(server.indexOf("async function laneBoosters("), server.indexOf("/** The Boosted lane: the top"));
  assert.match(body, /AND b\.block_time > now\(\) - make_interval\(hours => \$\{BOOST_WINDOW_H\}\)\n\s*AND b\.amount >= \$\{RAW_FLOOR\}::numeric\n\s*GROUP BY l\.token, b\.booster`;\n\s*return topBoosters\(rows\);/);
  assert.match(body, /\} catch \(err\) \{\n\s*console\.warn\("\[boost\] lane boosters read failed:"[^\n]*\n\s*return new Map\(\);/);
  assert.match(lane, /\{b\.top_booster \? \(/);
});


test("the token page shows what the lane brought: clicks in the same 24 hours, from 10 up, only while boosted", () => {
  assert.match(panel, /const clicks = state\.clicks \?\? 0;/);
  assert.match(panel, /\{active && clicks >= BOOST_PANEL_CLICKS_MIN \? \(/);
  assert.match(panel, /clicks from the lane in the last 24 hours/);
  // the lane card's own count (laneClicks: same window, never throws), and only for a token boosted in the window
  const body = server.slice(server.indexOf("export async function getTokenBoost("), server.indexOf("/* ─────────────────────────────── views and clicks"));
  assert.match(body, /const clicks = row\?\.last_at \? \(\(await laneClicks\(\[t\]\)\)\.get\(t\) \?\? 0\) : 0;/);
  assert.doesNotMatch(body, /FROM bb_boost_clicks/, "one click count for the card and the page, not two copies");
});

test("after a confirmed boost the booster can share it on X: its own post, in a new tab", () => {
  const done = dialog.slice(dialog.indexOf('{phase.k === "done" ? ('), dialog.indexOf(") : ("));
  assert.match(done, /<a href=\{boostShareUrl\(symbol, boostAmount\(phase\.whole, tag\), `\$\{SITE_URL\}\/t\/\$\{BOOST_CHAIN\}\/\$\{token\}`\)\} target="_blank" rel="noreferrer" className=\{btn\.secondarySm\}>Share on X/);
  assert.equal((dialog.match(/boostShareUrl\(/g) ?? []).length, 1, "only on the done screen");
});

test("the agents' notes name the lane's fields as they are", () => {
  assert.match(llms, /\(the lane: twig, boosts, last_at, expires_at, clicks, top_booster, launch; names\)/);
  assert.doesNotMatch(llms, /launch; entry\)/);
});



test("one X intent builder: the booster's post and the token page's Share both go through intentUrl", () => {
  assert.match(read("../../lib/launchpad/boost.ts"), /return intentUrl\(boostShareText\(symbol, raw\), \{ url: pageUrl, via: BRAND_X \}\);/);
  assert.match(tokenPage, /<a href=\{intentUrl\(shareText, \{ url: `\$\{SITE_URL\}\/t\/\$\{chain\}\/\$\{l\.token\}` \}\)\} target="_blank"/);
  for (const f of ["../../lib/launchpad/boost.ts", "../../app/t/[chain]/[token]/page.tsx"]) assert.doesNotMatch(read(f), /https:\/\/x\.com\/intent/, f);
});
