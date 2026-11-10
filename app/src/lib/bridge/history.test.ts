import assert from "node:assert/strict";
import test from "node:test";
import type { Address, Hex } from "viem";
import type { TrackedBridgeTransfer } from "./client.ts";
import { BRIDGE_HISTORY_LIMIT, combineHistory, formatHistoryAmount, historyFromTransfer, historyReceived, historyStatus, mergeHistory, parseHistoryEntry, parseHistoryLedger, parseRelayHistory, relayHistoryEntry, serializeHistoryLedger, upsertHistory, validateHistoryResponse, type BridgeHistoryEntry } from "./history.ts";
import { bridgeHistoryKey, createBridgeHistoryStore } from "./history-store.ts";
import { BRIDGE_HISTORY_TTL_MS, BRIDGE_HISTORY_UPSTREAM_PER_MINUTE, getBridgeHistory } from "./relay.ts";
import { ARBITRUM_USDC, ARC_USDC, BASE_USDC, ELYSIUM_USDC, ROBINHOOD_USDG, bridgeCurrencyAsset } from "./types.ts";
import { GET } from "../../app/api/bridge/history/route.ts";

const WALLET = "0x1111111111111111111111111111111111111111" as Address;
const OTHER = "0x2222222222222222222222222222222222222222" as Address;
const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
const NATIVE = "0x0000000000000000000000000000000000000000";

function tracked(overrides: Partial<TrackedBridgeTransfer> = {}): TrackedBridgeTransfer {
  return { address: WALLET, originChainId: 42161, destinationChainId: 8453, originAsset: "USDC", destinationAsset: "USDC", amount: "25000000", requestId: hash(1), sourceHash: hash(2), destinationHashes: [], status: "pending", createdAt: 1_790_000_000_000, ...overrides };
}

function row(overrides: Partial<BridgeHistoryEntry> = {}): BridgeHistoryEntry {
  return { requestId: hash(1), originChainId: 42161, destinationChainId: 8453, originAsset: "USDC", destinationAsset: "USDC", amountIn: "25000000", inDecimals: 6, amountOut: "24970000", outDecimals: 6, outKind: "quoted", status: "pending", reverted: false, createdAt: 1_790_000_000_000, sourceHash: hash(2), destinationHashes: [], recipient: null, ...overrides };
}

const currency = (chainId: number, address: string, decimals: number, amount: string) => ({ currency: { chainId, address, symbol: "X", name: "X", decimals, metadata: {} }, amount, amountFormatted: "1", amountUsd: "1", minimumAmount: amount });

/** A GET /requests/v3 request in Relay's published shape, Arbitrum USDC to Base USDC unless overridden. */
function relayRequest(overrides: Record<string, unknown> = {}, route: { from?: unknown; to?: unknown; actualTo?: unknown } = {}) {
  return {
    id: hash(1), status: "success", user: WALLET, sender: WALLET, recipient: WALLET, refundTo: null, depositAddress: null, requestType: "Bridge",
    data: {
      slippageTolerance: "50", failReason: null, inTxs: [{ txHash: hash(2), chainId: 42161, status: "success" }], outTxs: [{ txHash: hash(3), chainId: 8453, status: "success" }],
      route: {
        quoted: { origin: { inputCurrency: route.from ?? currency(42161, ARBITRUM_USDC, 6, "25000000") }, destination: { outputCurrency: route.to ?? currency(8453, BASE_USDC, 6, "24970000") } },
        actual: { destination: { outputCurrency: route.actualTo ?? currency(8453, BASE_USDC, 6, "24975000") } },
      },
    },
    createdAt: "2026-11-10T09:30:00.000Z", updatedAt: "2026-11-10T09:30:20.000Z",
    ...overrides,
  };
}

function memoryStorage(fail = false) {
  const items = new Map<string, string>();
  return { items, adapter: { getItem: (key: string) => items.get(key) ?? null, setItem: (key: string, value: string) => { if (fail) throw new Error("quota"); items.set(key, value); } } };
}

test("a tracked transfer enters the history only once it has left the wallet", () => {
  assert.equal(historyFromTransfer(tracked({ sourceHash: undefined, status: "waiting" })), null, "a cancelled or unsent wallet prompt is not a transfer");
  assert.equal(historyFromTransfer(tracked({ sourceHash: undefined, status: "uncertain" })), null);
  const sent = historyFromTransfer(tracked(), "24970000")!;
  assert.deepEqual(sent, row());
  assert.equal(historyFromTransfer(tracked(), "not a number")!.amountOut, null);
  // settled by Relay without a wallet hash (recovered on another path) still counts
  assert.equal(historyFromTransfer(tracked({ sourceHash: undefined, status: "success" }))!.status, "success");
  const reverted = historyFromTransfer(tracked({ status: "failure", failureReason: "source-reverted" }))!;
  assert.equal(reverted.reverted, true);
  // Arc's first journal entries were native 18-decimal USDC, and arrive on Arc as the 18-decimal native balance
  const legacyArc = historyFromTransfer(tracked({ originChainId: 5042, destinationChainId: 8453, originAsset: undefined, destinationAsset: undefined, amount: "5000000000000000000" }))!;
  assert.equal(legacyArc.inDecimals, 18);
  assert.equal(legacyArc.originAsset, "USDC");
  assert.equal(legacyArc.destinationAsset, "ETH");
  assert.equal(historyFromTransfer(tracked({ originChainId: 8453, destinationChainId: 5042, originAsset: "USDC", destinationAsset: "USDC" }))!.outDecimals, 18);
});

test("a stored row is checked field by field and copied; anything off drops that row only", () => {
  assert.deepEqual(parseHistoryEntry({ ...row(), extra: "<script>" }), row());
  for (const bad of [
    { requestId: "0x12" }, { originChainId: 137 }, { destinationChainId: 42161 }, { destinationChainId: 42161, originChainId: 8453 }, { originChainId: 8453, destinationChainId: 8453 },
    { originAsset: "USDG" }, { destinationAsset: "DAI" }, { inDecimals: 18 }, { outDecimals: 18 }, { amountIn: "0" }, { amountIn: "-1" }, { amountIn: "1e6" }, { amountIn: "1".repeat(80) },
    { amountOut: null }, { outKind: null }, { outKind: "guessed" }, { status: "done" }, { reverted: true }, { reverted: "no" }, { createdAt: 0 }, { createdAt: Number.NaN },
    { sourceHash: "0xabc" }, { destinationHashes: ["nope"] }, { destinationHashes: Array.from({ length: 51 }, (_, i) => hash(i)) }, { recipient: "vitalik.eth" },
  ]) assert.equal(parseHistoryEntry({ ...row(), ...bad }), null, JSON.stringify(bad));
  assert.ok(parseHistoryEntry(row({ originChainId: 5042, originAsset: "USDC", inDecimals: 18 })), "Arc legacy native deposits keep 18 decimals");
  assert.equal(parseHistoryEntry(row({ originChainId: 8453, originAsset: "USDC", inDecimals: 18 })), null, "only Arc has the legacy exception");
  assert.equal(parseHistoryEntry(null), null);
  assert.equal(parseHistoryEntry([row()]), null);
});

test("a settled status is never rolled back, a delivered amount beats a quoted one, and hashes add up", () => {
  const settled = row({ status: "success", outKind: "received", amountOut: "24975000", destinationHashes: [hash(3)] });
  const late = row({ status: "pending", destinationHashes: [hash(4)] });
  const merged = combineHistory(settled, late);
  assert.equal(merged.status, "success");
  assert.equal(merged.amountOut, "24975000");
  assert.equal(merged.outKind, "received");
  assert.deepEqual(merged.destinationHashes, [hash(3), hash(4)]);
  assert.equal(combineHistory(row(), row({ status: "refund" })).status, "refund");
  assert.equal(combineHistory(row({ status: "uncertain" }), row({ status: "pending" })).status, "pending");
  assert.equal(combineHistory(row({ createdAt: 5 }), row({ createdAt: 9 })).createdAt, 5);
  assert.equal(combineHistory(row({ status: "failure", reverted: true }), row({ status: "pending" })).reverted, true);

  let rows: BridgeHistoryEntry[] = [];
  for (let i = 0; i < BRIDGE_HISTORY_LIMIT + 5; i++) rows = upsertHistory(rows, row({ requestId: hash(100 + i), createdAt: 1000 + i }));
  assert.equal(rows.length, BRIDGE_HISTORY_LIMIT);
  assert.equal(rows[0].createdAt, 1000 + BRIDGE_HISTORY_LIMIT + 4, "newest first");
  rows = upsertHistory(rows, row({ requestId: hash(100 + BRIDGE_HISTORY_LIMIT + 4).toUpperCase().replace("0X", "0x") as Hex, status: "success", createdAt: 1000 + BRIDGE_HISTORY_LIMIT + 4 }));
  assert.equal(rows.length, BRIDGE_HISTORY_LIMIT, "the same request in another case is one row");
  assert.equal(rows[0].status, "success");

  const both = mergeHistory([row(), row({ requestId: hash(9), createdAt: 1 })], [row({ status: "success", outKind: "received", amountOut: "24975000" })]);
  assert.equal(both.length, 2);
  assert.equal(both[0].status, "success");
});

test("the browser ledger round-trips, ignores rows it cannot read and rejects a foreign format", () => {
  const raw = serializeHistoryLedger([row(), row({ requestId: hash(5), createdAt: 2 })]);
  assert.deepEqual(parseHistoryLedger(raw).map((entry) => entry.requestId), [hash(1), hash(5)]);
  const mixed = JSON.stringify({ version: 1, entries: [row(), { ...row(), requestId: "bad" }, "junk"] });
  assert.equal(parseHistoryLedger(mixed).length, 1);
  assert.throws(() => parseHistoryLedger(JSON.stringify({ version: 2, entries: [] })));
  assert.throws(() => parseHistoryLedger(JSON.stringify([row()])));
});

test("Relay's records become rows only for this wallet, on this bridge's networks and tokens, in their own units", () => {
  const delivered = relayHistoryEntry(relayRequest(), WALLET)!;
  assert.deepEqual(delivered, row({ status: "success", amountOut: "24975000", outKind: "received", sourceHash: hash(2), destinationHashes: [hash(3)], createdAt: Date.parse("2026-11-10T09:30:00.000Z") }));
  assert.equal(relayHistoryEntry(relayRequest(), WALLET.toUpperCase().replace("0X", "0x"))!.requestId, hash(1), "the wallet matches in any case");
  // in flight: the quoted amount, labelled as quoted
  const moving = relayHistoryEntry(relayRequest({ status: "pending", data: { ...relayRequest().data, outTxs: [] } }), WALLET)!;
  assert.equal(moving.outKind, "quoted");
  assert.equal(moving.amountOut, "24970000");
  assert.deepEqual(moving.destinationHashes, []);
  // sent elsewhere: kept, with the recipient named
  assert.equal(relayHistoryEntry(relayRequest({ recipient: OTHER }), WALLET)!.recipient, OTHER);
  // Base ETH to Arc, which arrives as Arc's 18-decimal native USDC
  const arc = relayHistoryEntry(relayRequest({}, { from: currency(8453, NATIVE, 18, "10000000000000000"), to: currency(5042, NATIVE, 18, "31000000000000000000"), actualTo: currency(5042, NATIVE, 18, "31100000000000000000") }), WALLET)!;
  assert.deepEqual([arc.originAsset, arc.destinationAsset, arc.outDecimals, arc.amountOut], ["ETH", "USDC", 18, "31100000000000000000"]);
  const usdg = relayHistoryEntry(relayRequest({}, { from: currency(8453, BASE_USDC, 6, "5000000"), to: currency(4663, ROBINHOOD_USDG, 6, "4990000"), actualTo: currency(4663, ROBINHOOD_USDG, 6, "4990000") }), WALLET)!;
  assert.equal(usdg.destinationAsset, "USDG");
  for (const [label, request] of [
    ["another wallet", relayRequest({ user: OTHER, sender: OTHER })],
    ["a network the bridge does not carry", relayRequest({}, { from: currency(137, "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", 6, "25000000") })],
    ["a funding network as destination", relayRequest({}, { to: currency(10, "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85", 6, "1"), actualTo: currency(10, "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85", 6, "1") })],
    ["a token the bridge does not carry", relayRequest({}, { from: currency(42161, "0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8", 6, "25000000") })],
    ["decimals that disagree", relayRequest({}, { from: currency(42161, ARBITRUM_USDC, 18, "25000000") })],
    ["delivery on another chain than quoted", relayRequest({}, { actualTo: currency(4663, NATIVE, 18, "1") })],
    ["a zero deposit", relayRequest({}, { from: currency(42161, ARBITRUM_USDC, 6, "0") })],
    ["no creation time", relayRequest({ createdAt: "soon" })],
    ["an unknown status", relayRequest({ status: "uncertain" })],
    ["a non-EVM recipient", relayRequest({ recipient: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU" })],
    ["no route at all", relayRequest({ data: {} })],
  ] as const) assert.equal(relayHistoryEntry(request, WALLET), null, label);
  assert.ok(bridgeCurrencyAsset(5042, ARC_USDC)?.decimals === 6 && bridgeCurrencyAsset(5042, NATIVE)?.decimals === 18);
  // Elysium's USDC reads both ways; a record that names its native HYPE is not this bridge's
  const elysiumRequest = relayRequest({}, { from: currency(99901, ELYSIUM_USDC.toLowerCase(), 6, "25000000") });
  elysiumRequest.data.inTxs = [{ txHash: hash(2), chainId: 99901, status: "success" }];
  const fromElysium = relayHistoryEntry(elysiumRequest, WALLET);
  assert.deepEqual([fromElysium?.originChainId, fromElysium?.originAsset, fromElysium?.inDecimals], [99901, "USDC", 6]);
  const toElysium = relayHistoryEntry(relayRequest({}, { to: currency(99901, ELYSIUM_USDC, 6, "24970000"), actualTo: currency(99901, ELYSIUM_USDC, 6, "24975000") }), WALLET);
  assert.deepEqual([toElysium?.destinationChainId, toElysium?.destinationAsset, toElysium?.amountOut], [99901, "USDC", "24975000"]);
  assert.equal(relayHistoryEntry(relayRequest({}, { to: currency(99901, NATIVE, 18, "1000000000000000000"), actualTo: currency(99901, NATIVE, 18, "1000000000000000000") }), WALLET), null);

  assert.equal(parseRelayHistory({ requests: [relayRequest(), relayRequest({ id: hash(7), user: OTHER, sender: OTHER })], continuation: "x" }, WALLET).length, 1);
  assert.throws(() => parseRelayHistory({ data: [] }, WALLET));
});

test("the browser re-checks the history the server sends", () => {
  assert.deepEqual(validateHistoryResponse({ relay: "off" }), { relay: "off" });
  assert.deepEqual(validateHistoryResponse({ relay: "on", transfers: [row(), { ...row(), requestId: "bad" }] }), { relay: "on", transfers: [row()] });
  assert.throws(() => validateHistoryResponse({ error: "busy" }));
  assert.throws(() => validateHistoryResponse({ relay: "on" }));
});

test("the board says what is known in words, and never shows a destination amount that did not arrive", () => {
  assert.deepEqual(historyStatus(row({ status: "success" })), { label: "Arrived", tone: "ok" });
  for (const status of ["waiting", "depositing", "pending", "submitted"] as const) assert.equal(historyStatus(row({ status })).label, "In transit");
  assert.equal(historyStatus(row({ status: "delayed" })).tone, "warn");
  assert.equal(historyStatus(row({ status: "refund" })).label, "Refunded");
  assert.equal(historyStatus(row({ status: "failure" })).label, "Failed");
  assert.equal(historyStatus(row({ status: "failure", reverted: true })).label, "Reverted");
  assert.equal(historyStatus(row({ status: "uncertain" })).tone, "muted");

  assert.deepEqual(historyReceived(row({ status: "success", outKind: "received", amountOut: "24975000" })), { label: "Received", amount: "24.975 USDC", note: null });
  assert.deepEqual(historyReceived(row()), { label: "Quoted", amount: "24.97 USDC", note: null });
  assert.deepEqual(historyReceived(row({ status: "refund" })), { label: "Received", amount: null, note: "Refunded" });
  assert.equal(historyReceived(row({ status: "failure", reverted: true })).note, "Not sent");
  assert.equal(historyReceived(row({ status: "failure" })).note, "Not delivered");
  assert.equal(historyReceived(row({ status: "success", amountOut: null, outKind: null })).note, "Not reported");
  assert.equal(historyReceived(row({ amountOut: null, outKind: null })).note, "On its way");

  assert.equal(formatHistoryAmount("25000000", 6), "25");
  assert.equal(formatHistoryAmount("1234567891234567891", 18), "1.2345678");
  assert.equal(formatHistoryAmount("1", 18), "<0.0000001");
  assert.equal(formatHistoryAmount("0", 6), "0");
});

test("the ledger store remembers sent transfers, survives a storage failure without throwing, and forgets discarded ones", () => {
  const { items, adapter } = memoryStorage();
  const store = createBridgeHistoryStore(() => adapter);
  let notified = 0;
  store.subscribe(() => notified++);
  store.record(tracked({ sourceHash: undefined, status: "waiting" }));
  assert.equal(items.size, 0, "nothing is written before the deposit leaves");
  store.record(tracked(), "24970000");
  assert.deepEqual(parseHistoryLedger(items.get(bridgeHistoryKey(WALLET))!), [row()]);
  const writes = notified;
  store.record(tracked(), "24970000");
  assert.equal(notified, writes, "recording the same state again changes nothing");
  // the quote is only known in the tab that sent it; a later update without it keeps it
  store.record(tracked({ status: "success", destinationHashes: [hash(3)] }));
  assert.equal(store.read(WALLET)[0].amountOut, "24970000");
  assert.equal(store.read(WALLET)[0].status, "success");
  store.forget(WALLET, hash(1));
  assert.deepEqual(store.read(WALLET), []);

  const broken = memoryStorage(true);
  const offline = createBridgeHistoryStore(() => broken.adapter);
  assert.doesNotThrow(() => offline.record(tracked()));
  assert.equal(offline.getSnapshot().unsaved[WALLET.toLowerCase()], true);
  assert.equal(offline.read(WALLET).length, 1, "rows only memory holds are kept while the page is open");
  const blocked = createBridgeHistoryStore(() => { throw new Error("SecurityError"); });
  assert.doesNotThrow(() => blocked.record(tracked()));
  assert.doesNotThrow(() => blocked.read(WALLET));
  assert.deepEqual(createBridgeHistoryStore(() => adapter).getServerSnapshot(), { entries: {}, unsaved: {} });
});

async function withKey<T>(key: string | undefined, run: () => Promise<T>): Promise<T> {
  const before = process.env.RELAY_API_KEY;
  if (key === undefined) delete process.env.RELAY_API_KEY; else process.env.RELAY_API_KEY = key;
  try { return await run(); } finally { if (before === undefined) delete process.env.RELAY_API_KEY; else process.env.RELAY_API_KEY = before; }
}

test("Relay history stays off without a key, and with one asks /requests/v3 for this wallet with the key in a header", async () => {
  let calls = 0;
  const never = async () => { calls++; return Response.json({}); };
  await withKey(undefined, async () => {
    assert.deepEqual(await getBridgeHistory(WALLET, never), { relay: "off" });
    await assert.rejects(getBridgeHistory("0x123", never), { status: 400 });
  });
  assert.equal(calls, 0);

  await withKey("test-key", async () => {
    const seen: { url: string; key: string | null }[] = [];
    const fetcher = async (url: string, init: RequestInit) => {
      seen.push({ url, key: new Headers(init.headers).get("x-api-key") });
      return Response.json({ requests: [relayRequest()] });
    };
    let clock = 1_000;
    const first = await getBridgeHistory(WALLET.toUpperCase().replace("0X", "0x"), fetcher, () => clock);
    assert.equal(first.relay, "on");
    assert.equal(first.relay === "on" && first.transfers[0].status, "success");
    const url = new URL(seen[0].url);
    assert.equal(url.origin + url.pathname, "https://api.relay.link/requests/v3");
    assert.equal(url.searchParams.get("user"), WALLET, "the wallet is sent lowercased");
    assert.equal(url.searchParams.get("includePendingRequests"), "true");
    assert.equal(url.searchParams.has("apiKey"), false, "the key never goes in the URL");
    assert.equal(seen[0].key, "test-key");
    clock += BRIDGE_HISTORY_TTL_MS - 1;
    await getBridgeHistory(WALLET, fetcher, () => clock);
    assert.equal(seen.length, 1, "one wallet's list is reused for a short while");
    clock += 2;
    await getBridgeHistory(WALLET, fetcher, () => clock);
    assert.equal(seen.length, 2);

    let failing = true;
    const flaky = async () => failing ? new Response("upstream detail", { status: 500 }) : Response.json({ requests: [] });
    const error: unknown = await getBridgeHistory(WALLET, flaky, () => 5_000).then(() => null, (reason: unknown) => reason);
    assert.equal((error as { status: number }).status, 503);
    assert.doesNotMatch(String((error as Error).message), /upstream detail/);
    failing = false;
    assert.deepEqual(await getBridgeHistory(WALLET, flaky, () => 5_001), { relay: "on", transfers: [] }, "a failure is not cached");
    await assert.rejects(getBridgeHistory(OTHER, async () => Response.json({ nope: true }), () => 1), { status: 503 });

    const busy = async () => Response.json({ requests: [] });
    for (let i = 0; i < BRIDGE_HISTORY_UPSTREAM_PER_MINUTE; i++) await getBridgeHistory(`0x${(i + 1).toString(16).padStart(40, "0")}`, busy, () => 10_000);
    await assert.rejects(getBridgeHistory(OTHER, busy, () => 10_000), { status: 429 });
    assert.equal((await getBridgeHistory(OTHER, busy, () => 70_001)).relay, "on", "the budget refills each minute");
  });
});

test("HTTP history boundary accepts one wallet address only and answers privately", async () => {
  await withKey(undefined, async () => {
    for (const query of ["", "address=0x123", "address=a&address=b", `address=${WALLET}&user=${OTHER}`, "wallet=0x1111111111111111111111111111111111111111"]) {
      const response = await GET(new Request(`https://openlaunch.example/api/bridge/history?${query}`, { headers: { "fly-client-ip": "bridge-history-invalid" } }));
      assert.equal(response.status, 400, query);
      assert.match(response.headers.get("cache-control")!, /private, no-store/);
    }
    const ok = await GET(new Request(`https://openlaunch.example/api/bridge/history?address=${WALLET}`, { headers: { "fly-client-ip": "bridge-history-ok" } }));
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { relay: "off" });
    assert.match(ok.headers.get("cache-control")!, /private, no-store/);
    const ask = () => GET(new Request(`https://openlaunch.example/api/bridge/history?address=${WALLET}`, { headers: { "fly-client-ip": "bridge-history-rate" } }));
    for (let i = 0; i < 30; i++) assert.equal((await ask()).status, 200);
    const limited = await ask();
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get("retry-after"), "5");
  });
});

test("a Circle row keeps its provider through the ledger, and no other provider is read back", () => {
  const circle = historyFromTransfer(tracked({ provider: "cctp", sourceBlock: "10" }), "24984750")!;
  assert.equal(circle.provider, "cctp");
  assert.equal(historyFromTransfer(tracked())!.provider, undefined);
  assert.deepEqual(parseHistoryLedger(serializeHistoryLedger([circle])), [circle]);
  assert.equal(parseHistoryEntry({ ...circle, provider: "relay" }), null);
  assert.equal(parseHistoryEntry({ ...circle, provider: 1 }), null);
  assert.equal(combineHistory(circle, row({ status: "success" })).provider, "cctp");
  assert.equal(combineHistory(row(), row({ status: "success" })).provider, undefined);
});
