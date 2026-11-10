import assert from "node:assert/strict";
import test from "node:test";
import { decodeFunctionData } from "viem";
import { CCTP_BURN_ABI, CCTP_FORWARD_HOOK, CCTP_TOKEN_MESSENGER, cctpBurnData } from "./cctp";
import { CCTP_MAX_BURN, CCTP_UPSTREAM_PER_MINUTE, cctpMaxFee, getCctpQuote, getCctpStatus, parseCctpFees, parseCctpStatus, parseCctpStatusRequest, type CctpStatusRequest } from "./cctp-server";
import { validateBridgeQuote } from "./client";
import { getBridgeQuote } from "./relay";
import { FIXTURE_INPUT, FIXTURE_NOW, addApprovalFixture, relayChainsFixture, relayRouteFixture } from "./relay.fixture";
import { ARBITRUM_USDC, ARC_USDC, type BridgeQuoteRequest } from "./types";
import { BridgeApiError } from "./validation";
import { GET as STATUS } from "../../app/api/bridge/status/route";

const WALLET = "0x6376ca7e839f1c3dd7f23cc8a1a58329f60db125" as const;
const NOW = 1_790_000_000_000;
const REQUEST: BridgeQuoteRequest = { address: WALLET, originChainId: 42161, destinationChainId: 8453, originAsset: "USDC", destinationAsset: "USDC", amount: "25000000" };
// The shape Circle's fee endpoint returned on 2026-11-10 (basis points, then the forward in USDC's smallest unit).
const FEES = [
  { finalityThreshold: 1000, minimumFee: 1.3, forwardFee: { low: 10_000, med: 11_000, high: 12_000 } },
  { finalityThreshold: 2000, minimumFee: 0, forwardFee: { low: 10_000, med: 11_000, high: 12_000 } },
];

type Call = { url: string; init: RequestInit };
type Answers = { fees?: unknown; allowance?: unknown; gas?: unknown; message?: unknown; failFees?: number };
function circle(answers: Answers = {}) {
  const calls: Call[] = [];
  const fetcher = async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    if (init.method === "POST") return Response.json({ jsonrpc: "2.0", id: 1, result: answers.gas ?? "0x5f5e100" });
    const path = url.replace("https://iris-api.circle.com", "");
    if (path.startsWith("/v2/burn/USDC/fees/")) return answers.failFees ? new Response("", { status: answers.failFees }) : Response.json(answers.fees ?? FEES);
    if (path === "/v2/fastBurn/USDC/allowance") return Response.json({ allowance: answers.allowance ?? 53_837_639.760122, lastUpdated: "2026-11-10T13:15:36.376Z" });
    if (path.startsWith("/v2/messages/")) return answers.message === undefined ? new Response("", { status: 404 }) : Response.json(answers.message);
    throw new Error(`unexpected ${url}`);
  };
  return { fetcher, calls, paths: () => calls.map((call) => call.init.method === "POST" ? `rpc:${JSON.parse(String(call.init.body)).method}` : call.url.replace("https://iris-api.circle.com", "")) };
}

test("Circle's fee is read for the burn's finality, bounded, and never from an exponent or fraction of a unit", () => {
  assert.deepEqual(parseCctpFees(FEES, 1000), { microBps: 1_300_000n, forwardFee: 12_000n });
  assert.deepEqual(parseCctpFees(FEES, 2000), { microBps: 0n, forwardFee: 12_000n });
  assert.deepEqual(parseCctpFees([{ finalityThreshold: 1000, minimumFee: 0.325, forwardFee: { low: 18509, med: 18959, high: 18959 } }], 1000), { microBps: 325_000n, forwardFee: 18_959n });
  const entry = FEES[0];
  for (const [name, value] of [
    ["missing finality", [FEES[1]]],
    ["empty", []],
    ["too many", Array(9).fill(entry)],
    ["not an array", entry],
    ["exponent", [{ ...entry, minimumFee: 1e-7 }]],
    ["negative", [{ ...entry, minimumFee: -1 }]],
    ["string", [{ ...entry, minimumFee: "1.3" }]],
    ["seven decimals", [{ ...entry, minimumFee: 1.0000001 }]],
    ["over 1%", [{ ...entry, minimumFee: 100.000001 }]],
    ["forward over $5", [{ ...entry, forwardFee: { high: 5_000_001 } }]],
    ["forward fraction", [{ ...entry, forwardFee: { high: 12_000.5 } }]],
    ["no forward", [{ ...entry, forwardFee: null }]],
  ] as const) assert.throws(() => parseCctpFees(value, 1000), (error) => error instanceof BridgeApiError && error.status === 502, name);
});

test("the whole fee is Circle's share of the amount rounded up, plus the forward", () => {
  assert.equal(cctpMaxFee(25_000_000n, { microBps: 1_300_000n, forwardFee: 12_000n }), 15_250n);
  assert.equal(cctpMaxFee(25_000_000n, { microBps: 325_000n, forwardFee: 18_959n }), 813n + 18_959n);
  assert.equal(cctpMaxFee(1n, { microBps: 1n, forwardFee: 0n }), 1n);
  assert.equal(cctpMaxFee(25_000_000n, { microBps: 0n, forwardFee: 63_895n }), 63_895n);
});

test("a Circle quote is built from pinned contracts and the bounded fee, and passes the browser's own check", async () => {
  const c = circle();
  const quote = await getCctpQuote(REQUEST, c.fetcher, () => NOW);
  assert.ok(quote);
  assert.deepEqual(c.paths().sort(), ["/v2/burn/USDC/fees/3/6?forward=true", "/v2/fastBurn/USDC/allowance", "rpc:eth_gasPrice"]);
  assert.equal(quote.provider, "cctp");
  assert.match(quote.requestId, /^0x[0-9a-f]{64}$/);
  assert.equal(quote.amountOut, "24984750");
  assert.equal(quote.minimumAmountOut, "24984750");
  assert.equal(quote.relayFee, "0.01525");
  assert.equal(quote.sourceGas, "0.000022");
  assert.equal(quote.totalImpactPercent, "-0.061");
  assert.equal(quote.timeEstimate, 25);
  assert.equal(quote.expiresAt, NOW + 45_000);
  assert.deepEqual(quote.approval, { token: ARBITRUM_USDC, spender: CCTP_TOKEN_MESSENGER, amount: "25000000" });
  assert.deepEqual(quote.transaction, { to: CCTP_TOKEN_MESSENGER, data: cctpBurnData(REQUEST, 15_250n), value: "0", chainId: 42161 });
  const args = decodeFunctionData({ abi: CCTP_BURN_ABI, data: quote.transaction.data }).args;
  assert.deepEqual([args[0], args[1], args[5], args[6], args[7]], [25_000_000n, 6, 15_250n, 1000, CCTP_FORWARD_HOOK]);
  assert.deepEqual(validateBridgeQuote(quote, REQUEST, NOW), quote);
  // every request is a plain GET or one read-only RPC call, with no redirects followed
  for (const call of c.calls) assert.equal(call.init.redirect, "error");
});

test("an Arc burn is Standard: no Fast capacity is asked, and Arc's 18-decimal balance receives it", async () => {
  const c = circle({ fees: [{ finalityThreshold: 2000, minimumFee: 0, forwardFee: { low: 54811, med: 62505, high: 63895 } }] });
  const request: BridgeQuoteRequest = { address: WALLET, originChainId: 5042, destinationChainId: 8453, destinationAsset: "USDC", amount: "25000000" };
  const quote = await getCctpQuote(request, c.fetcher, () => NOW);
  assert.ok(quote);
  assert.deepEqual(c.paths().sort(), ["/v2/burn/USDC/fees/26/6?forward=true", "rpc:eth_gasPrice"]);
  assert.equal(decodeFunctionData({ abi: CCTP_BURN_ABI, data: quote.transaction.data }).args[6], 2000);
  assert.equal(quote.approval?.token, ARC_USDC);
  assert.equal(quote.amountOut, (25_000_000n - 63_895n).toString());
  assert.equal(quote.timeEstimate, 15);
  const inbound = await getCctpQuote({ address: WALLET, originChainId: 8453, destinationChainId: 5042, originAsset: "USDC", amount: "25000000" }, circle().fetcher, () => NOW);
  assert.equal(inbound?.amountOut, ((25_000_000n - 15_250n) * 10n ** 12n).toString());
});

test("Circle offers nothing it cannot carry right now, without asking when the answer is already known", async () => {
  const none = circle();
  for (const request of [
    { ...REQUEST, destinationAsset: "ETH" as const },
    { ...REQUEST, originChainId: 4663 as const, originAsset: "USDG" as const },
    { ...REQUEST, amount: (CCTP_MAX_BURN + 1n).toString() },
  ]) assert.equal(await getCctpQuote(request, none.fetcher, () => NOW), null);
  assert.equal(none.calls.length, 0);
  // Fast capacity below the amount: Circle would fall back to Standard and charge the Fast fee
  assert.equal(await getCctpQuote(REQUEST, circle({ allowance: 24.999999 }).fetcher, () => NOW), null);
  assert.ok(await getCctpQuote(REQUEST, circle({ allowance: 25 }).fetcher, () => NOW));
  // above 5% in fees: 0.2 USDC pays a 0.012 forward
  assert.equal(await getCctpQuote({ ...REQUEST, amount: "200000" }, circle().fetcher, () => NOW), null);
});

test("Circle and RPC failures throw, and a failure is never reused", async () => {
  const busy = circle({ failFees: 429 });
  await assert.rejects(getCctpQuote(REQUEST, busy.fetcher, () => NOW), (error) => error instanceof BridgeApiError && error.status === 429);
  await assert.rejects(getCctpQuote(REQUEST, circle({ failFees: 500 }).fetcher, () => NOW), (error) => error instanceof BridgeApiError && error.status === 502);
  await assert.rejects(getCctpQuote(REQUEST, circle({ fees: [FEES[1]] }).fetcher, () => NOW), (error) => error instanceof BridgeApiError && error.status === 502);
  await assert.rejects(getCctpQuote(REQUEST, circle({ gas: "0x0" }).fetcher, () => NOW), BridgeApiError);
  await assert.rejects(getCctpQuote(REQUEST, circle({ gas: 1 }).fetcher, () => NOW), BridgeApiError);
  await assert.rejects(getCctpQuote(REQUEST, circle({ allowance: "lots" }).fetcher, () => NOW), BridgeApiError);
  await assert.rejects(getCctpQuote(REQUEST, busy.fetcher, () => NOW + 1), BridgeApiError);
  assert.equal(busy.paths().filter((path) => path.startsWith("/v2/burn")).length, 2);
});

test("Circle's answers are reused briefly and every caller shares one request budget", async () => {
  const c = circle();
  await getCctpQuote(REQUEST, c.fetcher, () => NOW);
  await getCctpQuote({ ...REQUEST, amount: "30000000" }, c.fetcher, () => NOW + 10_000);
  assert.equal(c.paths().filter((path) => path.startsWith("/v2/burn")).length, 1);
  assert.equal(c.paths().filter((path) => path.startsWith("/v2/fastBurn")).length, 1);
  await getCctpQuote(REQUEST, c.fetcher, () => NOW + 31_000);
  assert.equal(c.paths().filter((path) => path.startsWith("/v2/burn")).length, 2);

  const status = circle();
  const request = (n: number): CctpStatusRequest => ({ originChainId: 42161, destinationChainId: 8453, hash: `0x${n.toString(16).padStart(64, "0")}`, address: WALLET, amount: "25000000" });
  for (let n = 1; n <= CCTP_UPSTREAM_PER_MINUTE; n++) await getCctpStatus(request(n), status.fetcher, () => NOW);
  await assert.rejects(getCctpStatus(request(0), status.fetcher, () => NOW + 1_000), (error) => error instanceof BridgeApiError && error.status === 429);
  // a reused answer costs nothing, and the budget refills after a minute
  assert.deepEqual(await getCctpStatus(request(1), status.fetcher, () => NOW + 1_000), { status: "waiting", inTxHashes: [], txHashes: [] });
  await getCctpStatus(request(0), status.fetcher, () => NOW + 60_000);
  assert.equal(status.calls.length, CCTP_UPSTREAM_PER_MINUTE + 1);
});

test("the status route takes exactly one Circle burn: route, transaction, wallet and amount", () => {
  const hash = `0x${"AB".repeat(32)}`;
  const params = (patch: Record<string, string | null> = {}) => {
    const values: Record<string, string | null> = { provider: "cctp", origin: "42161", destination: "8453", hash, address: WALLET.toUpperCase().replace("0X", "0x"), amount: "25000000", ...patch };
    return new URLSearchParams(Object.entries(values).filter((entry): entry is [string, string] => entry[1] !== null));
  };
  assert.deepEqual(parseCctpStatusRequest(params()), { originChainId: 42161, destinationChainId: 8453, hash: hash.toLowerCase(), address: WALLET, amount: "25000000" });
  const duplicate = params();
  duplicate.append("hash", hash);
  for (const [name, value] of [
    ["provider", params({ provider: "relay" })],
    ["missing", params({ amount: null })],
    ["extra", new URLSearchParams([...params(), ["requestId", hash]])],
    ["duplicate", duplicate],
    ["not a Circle route", params({ origin: "4663" })],
    ["funding destination", params({ destination: "1" })],
    ["origin text", params({ origin: "42161.0" })],
    ["hash", params({ hash: "0x1234" })],
    ["zero address", params({ address: `0x${"0".repeat(40)}` })],
    ["address", params({ address: "0x1234" })],
    ["zero amount", params({ amount: "0" })],
    ["leading zero", params({ amount: "025000000" })],
    ["over the limit", params({ amount: (CCTP_MAX_BURN + 1n).toString() })],
  ] as const) assert.throws(() => parseCctpStatusRequest(value), (error) => error instanceof BridgeApiError && error.status === 400, name);
});

// Circle's record of a real forwarded burn, Ethereum USDC to Arc (transaction 0x0095…ce01), read on 2026-11-10.
const BURN_HASH = "0x009551050ec596b833a8957d635c759dbd22b63d45977c9d4cde5dcc79bece01" as const;
const MINT_HASH = "0xec343f34384181675084e7bb39863235c060fa075521984a2a22eedd05029531" as const;
const RECORD = {
  eventNonce: "0x355ab67f28b1f2bc40b323e4278f3995aba6858f3d7f7a2d6e161dd44bdbbaea", cctpVersion: 2, status: "complete",
  decodedMessage: {
    sourceDomain: "0", destinationDomain: "26", nonce: "0x355ab67f28b1f2bc40b323e4278f3995aba6858f3d7f7a2d6e161dd44bdbbaea",
    sender: "0x28b5a0e9c621a5badaa536219b3a228c8168cf5d", recipient: "0x28b5a0e9c621a5badaa536219b3a228c8168cf5d",
    destinationCaller: `0x${"0".repeat(64)}`, minFinalityThreshold: "1000", finalityThresholdExecuted: "1000",
    decodedMessageBody: {
      burnToken: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", mintRecipient: WALLET, amount: "2343317655", messageSender: WALLET,
      maxFee: "89262", feeExecuted: "89262", expirationBlock: "30692704", hookData: CCTP_FORWARD_HOOK,
    },
    decodedCctpXMessageBody: null,
  },
  delayReason: null, forwardState: "COMPLETE", forwardTxHash: MINT_HASH, destinationMintTxHash: MINT_HASH,
};
const STATUS_REQUEST: CctpStatusRequest = { originChainId: 1, destinationChainId: 5042, hash: BURN_HASH, address: WALLET, amount: "2343317655" };
type Record_ = typeof RECORD;
const record = (patch: Partial<Record_> = {}, body: Partial<Record_["decodedMessage"]["decodedMessageBody"]> = {}, message: Partial<Record_["decodedMessage"]> = {}) =>
  ({ ...RECORD, ...patch, decodedMessage: { ...RECORD.decodedMessage, ...message, decodedMessageBody: { ...RECORD.decodedMessage.decodedMessageBody, ...body } } });

test("Circle's record maps onto the bridge's statuses only when it is this wallet's burn", () => {
  const status = (value: unknown) => parseCctpStatus({ messages: [value] }, STATUS_REQUEST);
  assert.deepEqual(status(RECORD), { status: "success", inTxHashes: [BURN_HASH], txHashes: [MINT_HASH] });
  assert.equal(status(record({ forwardState: "PENDING", forwardTxHash: null as unknown as string })).status, "submitted");
  assert.equal(status(record({ forwardState: "FAILED", forwardTxHash: null as unknown as string })).status, "delayed");
  assert.equal(status(record({ forwardState: "PENDING", delayReason: "insufficient_fee" as unknown as null })).status, "delayed");
  assert.equal(status(record({ status: "pending_confirmations", forwardState: "PENDING" })).status, "pending");
  assert.equal(status(record({ status: "pending_confirmations", forwardState: "PENDING", delayReason: "insufficient_allowance_available" as unknown as null })).status, "delayed");
  // before Circle decodes the burn, a lone record only says it is pending
  assert.deepEqual(status({ status: "pending_confirmations", decodedMessage: null }), { status: "pending", inTxHashes: [BURN_HASH], txHashes: [] });
  for (const [name, value] of [
    ["recipient", record({}, { mintRecipient: "0x1111111111111111111111111111111111111111" })],
    ["sender", record({}, { messageSender: "0x1111111111111111111111111111111111111111" })],
    ["amount", record({}, { amount: "2343317656" })],
    ["token", record({}, { burnToken: ARBITRUM_USDC.toLowerCase() })],
    ["hook", record({}, { hookData: "0x" })],
    ["destination", record({}, {}, { destinationDomain: "6" })],
    ["source", record({}, {}, { sourceDomain: "3" })],
    ["finality", record({}, {}, { minFinalityThreshold: "2000" })],
    ["delivered without a hash", record({ forwardTxHash: "0x1234" })],
    ["unknown status", record({ status: "lost" })],
    ["undecoded and complete", { status: "complete", decodedMessage: null }],
  ] as const) assert.throws(() => status(value), (error) => error instanceof BridgeApiError && error.status === 502, name);
  assert.throws(() => parseCctpStatus({ messages: [RECORD, RECORD] }, STATUS_REQUEST), BridgeApiError);
  assert.throws(() => parseCctpStatus({ messages: [] }, STATUS_REQUEST), BridgeApiError);
  assert.deepEqual(parseCctpStatus({ messages: [record({}, { amount: "1" }), RECORD] }, STATUS_REQUEST).status, "success");
});

test("Circle status asks by source domain and transaction, and an unknown burn is still waiting", async () => {
  const unseen = circle();
  assert.deepEqual(await getCctpStatus(STATUS_REQUEST, unseen.fetcher, () => NOW), { status: "waiting", inTxHashes: [], txHashes: [] });
  assert.deepEqual(unseen.paths(), [`/v2/messages/0?transactionHash=${BURN_HASH}`]);
  assert.equal((await getCctpStatus(STATUS_REQUEST, circle({ message: { messages: [RECORD] } }).fetcher, () => NOW)).status, "success");
});

function relayAndCircle(circleAnswers: Answers, relayFails = false) {
  const { input, quote } = relayRouteFixture(8453, 5042, "USDC", "USDC");
  addApprovalFixture(quote, input);
  const relay = async (url: string) => {
    if (url.endsWith("/chains")) return Response.json(relayChainsFixture());
    return relayFails ? new Response("", { status: 500 }) : Response.json(quote);
  };
  return { input, relay, circle: circle(circleAnswers) };
}
// Base to Arc, 25 USDC: Relay delivers 24.94; Circle's Fast fee here is 0.325 bp plus the forward.
const BASE_ARC_FEES = (forward: number) => [{ finalityThreshold: 1000, minimumFee: 0.325, forwardFee: { low: forward, med: forward, high: forward } }];

test("the bridge quotes Relay and Circle together and offers whichever delivers more", async () => {
  const cheaper = relayAndCircle({ fees: BASE_ARC_FEES(18_959) });
  const viaCircle = await getBridgeQuote(cheaper.input, cheaper.relay, () => FIXTURE_NOW, cheaper.circle.fetcher);
  assert.equal(viaCircle.provider, "cctp");
  assert.equal(viaCircle.amountOut, ((25_000_000n - 813n - 18_959n) * 10n ** 12n).toString());

  const dearer = relayAndCircle({ fees: BASE_ARC_FEES(100_000) });
  const viaRelay = await getBridgeQuote(dearer.input, dearer.relay, () => FIXTURE_NOW, dearer.circle.fetcher);
  assert.equal(viaRelay.provider, undefined);
  assert.equal(viaRelay.amountOut, ((25_000_000n - 60_000n) * 10n ** 12n).toString());

  // one side failing leaves the other; Relay's error stands when neither can quote
  const relayDown = relayAndCircle({ fees: BASE_ARC_FEES(100_000) }, true);
  assert.equal((await getBridgeQuote(relayDown.input, relayDown.relay, () => FIXTURE_NOW, relayDown.circle.fetcher)).provider, "cctp");
  const circleDown = relayAndCircle({ failFees: 500 });
  assert.equal((await getBridgeQuote(circleDown.input, circleDown.relay, () => FIXTURE_NOW, circleDown.circle.fetcher)).provider, undefined);
  const bothDown = relayAndCircle({ failFees: 500 }, true);
  await assert.rejects(getBridgeQuote(bothDown.input, bothDown.relay, () => FIXTURE_NOW, bothDown.circle.fetcher), (error) => error instanceof BridgeApiError && /No bridge quote/.test(error.message));
});

test("routes Circle cannot carry never ask Circle, and injected fetchers leave Circle out by default", async () => {
  const c = circle();
  const { quote } = relayRouteFixture(8453, 4663);
  await getBridgeQuote(FIXTURE_INPUT, async (url) => Response.json(url.endsWith("/chains") ? relayChainsFixture() : quote), () => FIXTURE_NOW, c.fetcher);
  assert.equal(c.calls.length, 0);
  const { input, relay } = relayAndCircle({});
  assert.equal((await getBridgeQuote(input, relay, () => FIXTURE_NOW)).provider, undefined);
});


test("HTTP status boundary sends a malformed Circle request nowhere and answers privately", async () => {
  const hash = `0x${"ab".repeat(32)}`;
  const base = `provider=cctp&origin=42161&destination=8453&hash=${hash}&address=${WALLET}&amount=25000000`;
  for (const query of [`${base}&requestId=${hash}`, base.replace("cctp", "relay"), base.replace("8453", "4663"), base.replace("25000000", "0"), "provider=cctp"]) {
    const response = await STATUS(new Request(`https://openlaunch.example/api/bridge/status?${query}`, { headers: { "fly-client-ip": "bridge-cctp-status-invalid" } }));
    assert.equal(response.status, 400, query);
    assert.match(response.headers.get("cache-control")!, /private, no-store/);
  }
});
