import assert from "node:assert/strict";
import { test } from "node:test";
import { encodeFunctionData, parseAbi, zeroAddress } from "viem";
import { APPROVAL_ABI, BridgeApiError, ERC20_DEPOSIT_ABI, RELAY_DEPOSITORY, parseBridgeRequest, validateRelayChains, validateRelayQuote } from "./validation.ts";
import { getOrderId, type Order } from "./relay-order.ts";
import { ARBITRUM_USDC, ARC_USDC, BASE_USDC, BRIDGE_ASSETS, BRIDGE_DESTINATION_IDS, BRIDGE_FUNDING_IDS, BRIDGE_INPUT_CURRENCIES, ETHEREUM_USDC, OPTIMISM_USDC, ROBINHOOD_USDG, bridgeCurrency, type BridgeAsset, type BridgeChainId } from "./types.ts";
import { BRIDGE_PRIVATE_HEADERS, bridgeErrorResponse, getBridgeQuote, getBridgeStatus, readBridgeJson } from "./relay.ts";
import { ARC_FIXTURE_NOW, ARC_FIXTURE_ORDER_ID, ARC_OUTBOUND_FIXTURE_NOW, ARC_OUTBOUND_ORDER_ID, BASE_USDC_FIXTURE_NOW, BASE_USDC_ORDER_ID, FIXTURE_INPUT, FIXTURE_NOW, FIXTURE_REQUEST_ID, addApprovalFixture, relayArcOutboundFixture, relayArcQuoteFixture, relayBaseUsdcFixture, relayChainsFixture, relayQuoteFixture, relayRouteFixture } from "./relay.fixture.ts";
import { parseBridgeQuoteRejection } from "./client.ts";

test("quote adapter uses only fixed provider endpoints and requests native verification data without app fees", async () => {
  const seen: { url: string; init: RequestInit }[] = [];
  const quote = await getBridgeQuote(FIXTURE_INPUT, async (url, init) => {
    seen.push({ url, init });
    return Response.json(url.endsWith("/chains") ? relayChainsFixture() : relayQuoteFixture());
  }, () => FIXTURE_NOW);
  assert.equal(quote.requestId, FIXTURE_REQUEST_ID);
  assert.deepEqual(seen.map((call) => call.url).sort(), ["https://api.relay.link/chains", "https://api.relay.link/quote/v2"]);
  const payload = JSON.parse(String(seen.find((call) => call.init.method === "POST")!.init.body));
  assert.equal(payload.recipient, FIXTURE_INPUT.address);
  assert.equal(payload.refundTo, FIXTURE_INPUT.address);
  assert.equal(payload.explicitDeposit, true);
  assert.equal(payload.includeProtocolData, true);
  assert.equal(payload.slippageTolerance, "50");
  assert.equal(payload.appFees, undefined);
  for (const call of seen) {
    assert.equal(call.init.cache, "no-store"); assert.equal(call.init.redirect, "error");
    assert.ok(call.init.signal instanceof AbortSignal);
  }
});

test("status rejects arbitrary identifiers before any upstream request", async () => {
  let requests = 0;
  await assert.rejects(getBridgeStatus("https://attacker.example", async () => { requests++; return Response.json({}); }), BridgeApiError);
  assert.equal(requests, 0);
  await getBridgeStatus(FIXTURE_REQUEST_ID, async (url) => {
    assert.equal(url, `https://api.relay.link/intents/status/v3?requestId=${FIXTURE_REQUEST_ID}`);
    return Response.json({ status: "waiting" });
  });
});

test("upstream failure messages never expose provider data or keys and responses remain private", async () => {
  const error: unknown = await getBridgeStatus(FIXTURE_REQUEST_ID, async () => new Response("secret upstream diagnostic", { status: 500 })).then(() => null, (error: unknown) => error);
  assert.ok(error instanceof BridgeApiError);
  const response = bridgeErrorResponse(error);
  assert.equal(response.status, 503);
  assert.ok(!(await response.text()).includes("secret"));
  assert.equal(response.headers.get("cache-control"), BRIDGE_PRIVATE_HEADERS["Cache-Control"]);
  const rate = bridgeErrorResponse(new BridgeApiError("Try later.", 429));
  assert.equal(rate.headers.get("retry-after"), "5");
});

test("bounded JSON rejects chunked oversized, malformed, and stalled bodies", async () => {
  const large = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode(" ".repeat(3000))); controller.close(); } });
  await assert.rejects(readBridgeJson(large, 2048), (e) => e instanceof BridgeApiError && e.status === 413);
  await assert.rejects(readBridgeJson(new Response("{").body, 2048), (e) => e instanceof BridgeApiError && e.status === 400);
  const stalled = new ReadableStream<Uint8Array>({});
  await assert.rejects(readBridgeJson(stalled, 2048, 10), (e) => e instanceof BridgeApiError && e.status === 504);
});

test("rejects oversized upstream JSON even when Content-Length is absent", async () => {
  await assert.rejects(getBridgeStatus(FIXTURE_REQUEST_ID, async () => new Response(" ".repeat(40_000))), BridgeApiError);
});

const supported = [8453, 4663, 5042] as BridgeChainId[];
for (const origin of supported) for (const destination of supported) {
  if (origin === destination) continue;
  test(`validates pinned-asset route ${origin}→${destination} with fees in source currency`, async () => {
    const { input, quote: fixture } = relayRouteFixture(origin, destination);
    const result = await getBridgeQuote(input, async (url, init) => {
      if (url.endsWith("/chains")) return Response.json(relayChainsFixture());
      const body = JSON.parse(String(init.body));
      assert.equal(body.originChainId, origin);
      assert.equal(body.destinationChainId, destination);
      assert.equal(body.refundTo, input.address);
      assert.equal(body.amount, input.amount);
      assert.equal(body.originCurrency, BRIDGE_INPUT_CURRENCIES[origin].address);
      assert.equal(body.destinationCurrency, zeroAddress);
      return Response.json(fixture);
    }, () => FIXTURE_NOW);
    assert.equal(result.transaction.value, origin === 5042 ? "0" : input.amount);
    assert.equal(result.transaction.chainId, origin);
    assert.equal(result.amountOut, fixture.details.currencyOut.amount);
    assert.equal(result.totalImpactPercent, fixture.details.totalImpact.percent);
    assert.equal(result.relayFee, origin === 5042 ? "0.06" : destination === 5042 ? "0.000024736726855049" : "0.000012330451724044");
    assert.deepEqual(result.approval, origin === 5042 ? { token: ARC_USDC, spender: RELAY_DEPOSITORY, amount: input.amount } : undefined);
  });
}

test("captured Arc quote binds the independent protocol order ID and 18-decimal native USDC", () => {
  const { input, quote } = relayArcQuoteFixture();
  const metadata = validateRelayChains(relayChainsFixture(), input);
  assert.equal(getOrderId(quote.protocol.v2.orderData as Order, metadata.vmTypes), ARC_FIXTURE_ORDER_ID);
  const result = validateRelayQuote(quote, input, metadata, ARC_FIXTURE_NOW);
  assert.equal(result.amountOut, "23805836914179393109");
  assert.equal(result.minimumAmountOut, "23686807729608496144");
  assert.equal(result.totalImpactPercent, "-0.68");
  assert.equal(result.sourceGas, "0.000000671181819574");
  assert.ok(BigInt(result.amountOut) > BigInt(input.amount), "different asset units must not be compared");
});

test("chain metadata validates only the route plus the Base solver hub", () => {
  const baseRobinhood = relayChainsFixture();
  baseRobinhood.chains[2].disabled = true;
  assert.doesNotThrow(() => validateRelayChains(baseRobinhood, FIXTURE_INPUT));
  const baseArc = relayRouteFixture(8453, 5042).input;
  assert.throws(() => validateRelayChains(baseRobinhood, baseArc), BridgeApiError);
  const unrelatedRobinhood = relayChainsFixture();
  unrelatedRobinhood.chains[1].disabled = true;
  assert.doesNotThrow(() => validateRelayChains(unrelatedRobinhood, baseArc));
  const robinhoodArc = relayRouteFixture(4663, 5042).input;
  const missingHub = relayChainsFixture();
  missingHub.chains = missingHub.chains.filter((chain) => chain.id !== 8453);
  assert.throws(() => validateRelayChains(missingHub, robinhoodArc), BridgeApiError);
  const differingSolvers = relayChainsFixture();
  differingSolvers.chains[1].solverAddresses = ["0x1111111111111111111111111111111111111111"];
  differingSolvers.chains[2].solverAddresses = ["0x2222222222222222222222222222222222222222"];
  assert.deepEqual(validateRelayChains(differingSolvers, robinhoodArc).solverAddresses, differingSolvers.chains[0].solverAddresses);
});

test("rejects wrong Arc native symbols, 6-decimal ERC20 assumptions, assets and testnet IDs", () => {
  const { input } = relayRouteFixture(8453, 5042);
  for (const mutation of [
    (chains: ReturnType<typeof relayChainsFixture>) => { chains.chains[2].currency.symbol = "ETH"; },
    (chains: ReturnType<typeof relayChainsFixture>) => { chains.chains[2].currency.decimals = 6; },
    (chains: ReturnType<typeof relayChainsFixture>) => { chains.chains[2].currency.address = "0x1111111111111111111111111111111111111111"; },
  ]) {
    const chains = relayChainsFixture(); mutation(chains);
    assert.throws(() => validateRelayChains(chains, input), BridgeApiError);
  }
  for (const field of ["symbol", "decimals", "address"] as const) {
    const { quote } = relayRouteFixture(8453, 5042);
    const currency = quote.details.currencyOut.currency as Record<string, unknown>;
    currency[field] = field === "symbol" ? "ETH" : field === "decimals" ? 6 : "0x1111111111111111111111111111111111111111";
    assert.throws(() => validateRelayQuote(quote, input, validateRelayChains(relayChainsFixture(), input), FIXTURE_NOW), BridgeApiError);
  }
  const { input: arcSource, quote } = relayRouteFixture(5042, 8453);
  quote.fees.relayer.currency.symbol = "ETH";
  assert.throws(() => validateRelayQuote(quote, arcSource, validateRelayChains(relayChainsFixture(), arcSource), FIXTURE_NOW), BridgeApiError);
  assert.throws(() => parseBridgeRequest({ ...input, destinationChainId: 5042002 }), (error) => error instanceof BridgeApiError && error.status === 400);
});

test("rejects missing, malformed, nonfinite and excessive total impact without changing raw amount units", async () => {
  for (const percent of [undefined, "NaN", "Infinity", "1e3", "+0", "+1", "-100.01", "100.01", "100.000000000000000001", "-5.01", "-5.000000000000000001", "0".repeat(33), 0]) {
    const { input, quote } = relayRouteFixture(8453, 5042);
    (quote.details.totalImpact as { percent: unknown }).percent = percent;
    assert.throws(() => validateRelayQuote(quote, input, validateRelayChains(relayChainsFixture(), input), FIXTURE_NOW), BridgeApiError, String(percent));
  }
  const { input, quote } = relayRouteFixture(8453, 5042);
  for (const percent of ["-5", "-5.000000000000000000", "-0", "0", "100", "100.000000000000000000"]) {
    quote.details.totalImpact.percent = percent;
    assert.doesNotThrow(() => validateRelayQuote(quote, input, validateRelayChains(relayChainsFixture(), input), FIXTURE_NOW));
  }
  quote.details.totalImpact.percent = "-5.01";
  await assert.rejects(getBridgeQuote(input, async (url) => Response.json(url.endsWith("/chains") ? relayChainsFixture() : quote), () => FIXTURE_NOW), (error) => error instanceof BridgeApiError && error.status === 422 && /more than 5%/.test(error.message));
});

test("rejects excessive source fees even when provider impact claims no loss", () => {
  const { input, quote } = relayRouteFixture(5042, 8453);
  quote.fees.relayer.amount = (BigInt(input.amount) * 5n / 100n + 1n).toString();
  quote.details.totalImpact.percent = "0";
  assert.throws(() => validateRelayQuote(quote, input, validateRelayChains(relayChainsFixture(), input), FIXTURE_NOW), (error) => error instanceof BridgeApiError && error.status === 422);
});

test("verified fee rejection returns request-bound cost diagnostics but never executable quote data", async () => {
  const { input, quote } = relayRouteFixture(5042, 8453, "USDC", "ETH");
  quote.fees.relayer.amount = "1875000";
  quote.details.totalImpact.percent = "-8.12";
  let caught: unknown;
  try { await getBridgeQuote(input, async (url) => Response.json(url.endsWith("/chains") ? relayChainsFixture() : quote), () => FIXTURE_NOW); }
  catch (error) { caught = error; }
  assert.ok(caught instanceof BridgeApiError);
  const response = bridgeErrorResponse(caught);
  assert.equal(response.status, 422);
  assert.match(response.headers.get("cache-control")!, /private, no-store/);
  const body = await response.json();
  assert.deepEqual(Object.keys(body).sort(), ["error", "quoteRejection"]);
  assert.deepEqual(body.quoteRejection, { ...input, reason: "relay-fee", relayFee: "1.875", relayFeePercent: "7.5", sourceGas: "0.003", totalImpactPercent: "-8.12" });
  assert.deepEqual(parseBridgeQuoteRejection(body.quoteRejection, input), body.quoteRejection);
  assert.doesNotMatch(JSON.stringify(body), /transaction|approval|requestId|orderId|calldata/);
});

test("unverifiable quotes never gain trusted cost diagnostics just because their fees exceed the cap", async () => {
  for (const mutate of [
    (quote: ReturnType<typeof relayQuoteFixture>) => { quote.fees.app.amount = "1"; },
    (quote: ReturnType<typeof relayQuoteFixture>) => { quote.details.totalImpact.percent = "NaN"; },
    (quote: ReturnType<typeof relayQuoteFixture>) => { quote.details.timeEstimate = 86401; },
    (quote: ReturnType<typeof relayQuoteFixture>) => { quote.fees.gas.currency.decimals = 6; },
    (quote: ReturnType<typeof relayQuoteFixture>) => { quote.fees.relayer.currency.decimals = 18; },
    (quote: ReturnType<typeof relayQuoteFixture>) => { quote.steps[0].items[0].data.to = zeroAddress; },
  ]) {
    const { input, quote } = relayRouteFixture(5042, 8453);
    quote.fees.relayer.amount = "1875000";
    mutate(quote);
    let caught: unknown;
    try { validateRelayQuote(quote, input, validateRelayChains(relayChainsFixture(), input), FIXTURE_NOW); }
    catch (error) { caught = error; }
    assert.ok(caught instanceof BridgeApiError);
    assert.equal(caught.status, 502);
    assert.equal(caught.quoteRejection, undefined);
    assert.deepEqual(Object.keys(await bridgeErrorResponse(caught).json()), ["error"]);
  }
});

test("both safety thresholds stay inclusive at 5% and impact-only rejection has its own reason", () => {
  const { input, quote } = relayRouteFixture(5042, 8453);
  const metadata = validateRelayChains(relayChainsFixture(), input);
  quote.fees.relayer.amount = "1250000";
  quote.details.totalImpact.percent = "-5";
  assert.doesNotThrow(() => validateRelayQuote(quote, input, metadata, FIXTURE_NOW));
  quote.details.totalImpact.percent = "-5.000000000000000001";
  assert.throws(() => validateRelayQuote(quote, input, metadata, FIXTURE_NOW), (error) => error instanceof BridgeApiError && error.status === 422 && error.quoteRejection?.reason === "total-impact" && error.quoteRejection.relayFeePercent === "5");
  quote.details.totalImpact.percent = "0";
  quote.fees.relayer.amount = "1250001";
  assert.throws(() => validateRelayQuote(quote, input, metadata, FIXTURE_NOW), (error) => error instanceof BridgeApiError && error.quoteRejection?.reason === "relay-fee" && error.quoteRejection.relayFeePercent === "5.000004");
});

test("captured Arc ERC-20 quote binds the independent order hash and exact approval", () => {
  const { input, quote } = relayArcOutboundFixture();
  const metadata = validateRelayChains(relayChainsFixture(), input);
  assert.equal(getOrderId(quote.protocol.v2.orderData as Order, metadata.vmTypes), ARC_OUTBOUND_ORDER_ID);
  const result = validateRelayQuote(quote, input, metadata, ARC_OUTBOUND_FIXTURE_NOW);
  assert.equal(result.amount, "25000000");
  assert.equal(result.transaction.value, "0");
  assert.equal(result.relayFee, "0.054943");
  assert.equal(result.sourceGas, "0.00329427");
  assert.deepEqual(result.approval, { token: ARC_USDC, spender: RELAY_DEPOSITORY, amount: "25000000" });
  quote.steps.shift(); // Relay may omit approval when allowance is already enough.
  assert.deepEqual(validateRelayQuote(quote, input, metadata, ARC_OUTBOUND_FIXTURE_NOW), result);
});

test("rejects wrong Arc approval target, spender, amount, chain, value and encoding", () => {
  const other = "0x2222222222222222222222222222222222222222";
  const approval = (spender: typeof RELAY_DEPOSITORY | typeof other, amount: bigint) => encodeFunctionData({ abi: APPROVAL_ABI, functionName: "approve", args: [spender, amount] });
  const mutations: Record<string, (tx: ReturnType<typeof relayQuoteFixture>["steps"][number]["items"][number]["data"]) => void> = {
    "wrong token": (tx) => { tx.to = other; },
    "native alias": (tx) => { tx.to = zeroAddress; },
    "wrong owner": (tx) => { tx.from = other; },
    "wrong chain": (tx) => { tx.chainId = 8453; },
    "nonzero value": (tx) => { tx.value = "1"; },
    "wrong spender": (tx) => { tx.data = approval(other, 25000000n); },
    "unlimited amount": (tx) => { tx.data = approval(RELAY_DEPOSITORY, (1n << 256n) - 1n); },
    "zero amount": (tx) => { tx.data = approval(RELAY_DEPOSITORY, 0n); },
    "partial amount": (tx) => { tx.data = approval(RELAY_DEPOSITORY, 24999999n); },
    "trailing bytes": (tx) => { tx.data += "00"; },
  };
  for (const [name, mutate] of Object.entries(mutations)) {
    const { input, quote } = relayArcOutboundFixture();
    mutate(quote.steps[0].items[0].data);
    assert.throws(() => validateRelayQuote(quote, input, validateRelayChains(relayChainsFixture(), input), ARC_OUTBOUND_FIXTURE_NOW), BridgeApiError, name);
  }
});

test("rejects extra, reordered, mismatched or signature approval steps", () => {
  for (const mutate of [
    (quote: ReturnType<typeof relayQuoteFixture>) => { quote.steps.push(structuredClone(quote.steps[0])); },
    (quote: ReturnType<typeof relayQuoteFixture>) => { quote.steps.reverse(); },
    (quote: ReturnType<typeof relayQuoteFixture>) => { quote.steps[0].kind = "signature"; },
    (quote: ReturnType<typeof relayQuoteFixture>) => { quote.steps[0].requestId = FIXTURE_REQUEST_ID; },
    (quote: ReturnType<typeof relayQuoteFixture>) => { quote.steps[0].items.push(structuredClone(quote.steps[0].items[0])); },
  ]) {
    const { input, quote } = relayArcOutboundFixture(); mutate(quote);
    assert.throws(() => validateRelayQuote(quote, input, validateRelayChains(relayChainsFixture(), input), ARC_OUTBOUND_FIXTURE_NOW), BridgeApiError);
  }
  const quote = relayQuoteFixture();
  addApprovalFixture(quote, FIXTURE_INPUT);
  assert.throws(() => validateRelayQuote(quote, FIXTURE_INPUT, validateRelayChains(relayChainsFixture()), FIXTURE_NOW), BridgeApiError);
});

test("rejects Arc deposit full-allowance overload, swapped arguments and native value", () => {
  for (const variant of ["full allowance", "swapped arguments", "wrong amount", "wrong token", "native value", "trailing data"]) {
    const { input, quote } = relayArcOutboundFixture();
    const tx = quote.steps[1].items[0].data;
    if (variant === "full allowance") tx.data = encodeFunctionData({ abi: parseAbi(["function depositErc20(address depositor,address token,bytes32 id)"]), functionName: "depositErc20", args: [input.address, ARC_USDC, ARC_OUTBOUND_ORDER_ID] });
    if (variant === "swapped arguments") tx.data = encodeFunctionData({ abi: ERC20_DEPOSIT_ABI, functionName: "depositErc20", args: [ARC_USDC, input.address, BigInt(input.amount), ARC_OUTBOUND_ORDER_ID] });
    if (variant === "wrong amount") tx.data = encodeFunctionData({ abi: ERC20_DEPOSIT_ABI, functionName: "depositErc20", args: [input.address, ARC_USDC, BigInt(input.amount) + 1n, ARC_OUTBOUND_ORDER_ID] });
    if (variant === "wrong token") tx.data = encodeFunctionData({ abi: ERC20_DEPOSIT_ABI, functionName: "depositErc20", args: [input.address, zeroAddress, BigInt(input.amount), ARC_OUTBOUND_ORDER_ID] });
    if (variant === "native value") tx.value = input.amount;
    if (variant === "trailing data") tx.data += "00";
    assert.throws(() => validateRelayQuote(quote, input, validateRelayChains(relayChainsFixture(), input), ARC_OUTBOUND_FIXTURE_NOW), BridgeApiError, variant);
  }
});

test("Arc input, relay fee and refund use USDC6 while gas and output retain native18", () => {
  for (const mutate of [
    (quote: ReturnType<typeof relayQuoteFixture>) => { quote.protocol.v2.orderData.inputs[0].payment.currency = zeroAddress; },
    (quote: ReturnType<typeof relayQuoteFixture>) => { quote.protocol.v2.orderData.inputs[0].refunds[0].currency = zeroAddress; },
    (quote: ReturnType<typeof relayQuoteFixture>) => { quote.protocol.v2.orderData.inputs[0].refunds[1].currency = ARC_USDC; },
    (quote: ReturnType<typeof relayQuoteFixture>) => { quote.protocol.v2.paymentDetails.currency = zeroAddress; },
    (quote: ReturnType<typeof relayQuoteFixture>) => { quote.details.currencyIn.currency.decimals = 18; },
    (quote: ReturnType<typeof relayQuoteFixture>) => { quote.details.currencyIn.currency.address = zeroAddress; },
    (quote: ReturnType<typeof relayQuoteFixture>) => { quote.fees.relayer.currency.decimals = 18; },
    (quote: ReturnType<typeof relayQuoteFixture>) => { quote.fees.gas.currency.decimals = 6; },
    (quote: ReturnType<typeof relayQuoteFixture>) => { quote.fees.gas.currency.address = ARC_USDC; },
  ]) {
    const { input, quote } = relayArcOutboundFixture(); mutate(quote);
    const metadata = validateRelayChains(relayChainsFixture(), input);
    const orderId = getOrderId(quote.protocol.v2.orderData as Order, metadata.vmTypes);
    quote.protocol.v2.orderId = orderId;
    quote.steps[1].items[0].data.data = encodeFunctionData({ abi: ERC20_DEPOSIT_ABI, functionName: "depositErc20", args: [input.address, ARC_USDC, BigInt(input.amount), orderId] });
    assert.throws(() => validateRelayQuote(quote, input, metadata, ARC_OUTBOUND_FIXTURE_NOW), BridgeApiError);
  }
});

const usdcRoutes: [BridgeChainId, BridgeChainId, BridgeAsset, BridgeAsset][] = [
  [8453, 4663, "USDC", "ETH"], [4663, 8453, "ETH", "USDC"],
  [8453, 5042, "USDC", "USDC"], [5042, 8453, "USDC", "USDC"],
];
for (const [origin, destination, originAsset, destinationAsset] of usdcRoutes) {
  test(`selected assets ${origin}:${originAsset}→${destination}:${destinationAsset} bind provider request, fee units and approval`, async () => {
    const { input, quote } = relayRouteFixture(origin, destination, originAsset, destinationAsset);
    const inputCurrency = bridgeCurrency(origin, originAsset, "input");
    const outputCurrency = bridgeCurrency(destination, destinationAsset, "output");
    if (inputCurrency.address !== zeroAddress) addApprovalFixture(quote, input);
    const result = await getBridgeQuote(input, async (url, init) => {
      if (url.endsWith("/chains")) return Response.json(relayChainsFixture());
      const body = JSON.parse(String(init.body));
      assert.equal(body.originCurrency, inputCurrency.address);
      assert.equal(body.destinationCurrency, outputCurrency.address);
      assert.equal(body.amount, input.amount);
      return Response.json(quote);
    }, () => FIXTURE_NOW);
    assert.equal(result.originAsset, originAsset);
    assert.equal(result.destinationAsset, destinationAsset);
    assert.equal(result.transaction.value, originAsset === "USDC" ? "0" : input.amount);
    assert.equal(result.relayFee, originAsset === "USDC" ? "0.06" : "0.000024736726855049");
    assert.deepEqual(result.approval, originAsset === "USDC" ? { token: inputCurrency.address, spender: RELAY_DEPOSITORY, amount: input.amount } : undefined);
  });
}

test("request selections preserve legacy defaults but reject unsupported or injected asset fields", () => {
  assert.deepEqual(parseBridgeRequest(FIXTURE_INPUT), FIXTURE_INPUT);
  const selected = { ...FIXTURE_INPUT, amount: "25000000", originAsset: "USDC" as const, destinationAsset: "ETH" as const };
  assert.deepEqual(parseBridgeRequest(selected), selected);
  assert.deepEqual(parseBridgeRequest({ ...FIXTURE_INPUT, originAsset: "ETH" }), { ...FIXTURE_INPUT, originAsset: "ETH" });
  for (const mutation of [
    { originAsset: null }, { originAsset: "usdc" }, { originAsset: "USDT" }, { originAsset: BASE_USDC },
    { destinationAsset: "USDC" }, { destinationAsset: 1 }, { originChainId: 5042, originAsset: "ETH" },
    { token: BASE_USDC }, { approval: { token: BASE_USDC } },
  ]) assert.throws(() => parseBridgeRequest({ ...FIXTURE_INPUT, ...mutation }), (error) => error instanceof BridgeApiError && error.status === 400);
});

test("captured Base USDC6→Arc USDC18 quote preserves exact normalized fee equality and independent hash", () => {
  const { input, quote } = relayBaseUsdcFixture();
  const metadata = validateRelayChains(relayChainsFixture(), input);
  assert.equal(getOrderId(quote.protocol.v2.orderData as Order, metadata.vmTypes), BASE_USDC_ORDER_ID);
  const result = validateRelayQuote(quote, input, metadata, BASE_USDC_FIXTURE_NOW);
  assert.equal(result.amountOut, "24939066000000000000");
  assert.equal(result.relayFee, "0.060934");
  assert.equal(result.sourceGas, "0.000001868564641196");
  assert.equal(result.approval?.token, BASE_USDC);
  assert.equal(BigInt(input.amount) - 60934n, BigInt(result.amountOut) / 10n ** 12n);
});

test("request amount maximum remains valid for native ETH but never an ERC20 approval", async () => {
  const maximum = (1n << 256n) - 1n;
  const native = { ...FIXTURE_INPUT, amount: maximum.toString() };
  assert.deepEqual(parseBridgeRequest(native), native);
  const baseUsdc = { ...native, originAsset: "USDC" as const };
  assert.equal(parseBridgeRequest({ ...baseUsdc, amount: (maximum - 1n).toString() }).amount, (maximum - 1n).toString());
  let requests = 0;
  for (const input of [baseUsdc, { ...native, originChainId: 5042 as const }, { ...native, originChainId: 5042 as const, originAsset: "USDC" as const }]) {
    assert.throws(() => parseBridgeRequest(input), (error) => error instanceof BridgeApiError && error.status === 400);
    await assert.rejects(getBridgeQuote(input, async () => { requests++; return Response.json({}); }), (error) => error instanceof BridgeApiError && error.status === 400);
  }
  assert.equal(requests, 0);
});

test("quote validation cannot normalize a matching ERC20 maximum into unlimited approval", () => {
  for (const origin of [8453, 5042] as const) {
    const { input, quote } = relayRouteFixture(origin, 4663, "USDC", "ETH");
    input.amount = ((1n << 256n) - 1n).toString();
    quote.protocol.v2.orderData.inputs[0].payment.amount = input.amount;
    quote.protocol.v2.paymentDetails.amount = input.amount;
    quote.details.currencyIn.amount = input.amount;
    const metadata = validateRelayChains(relayChainsFixture(), input);
    const orderId = getOrderId(quote.protocol.v2.orderData as Order, metadata.vmTypes);
    quote.protocol.v2.orderId = orderId;
    quote.steps[0].items[0].data.data = encodeFunctionData({ abi: ERC20_DEPOSIT_ABI, functionName: "depositErc20", args: [input.address, bridgeCurrency(origin, "USDC", "input").address, BigInt(input.amount), orderId] });
    addApprovalFixture(quote, input);
    assert.throws(() => validateRelayQuote(quote, input, metadata, FIXTURE_NOW), BridgeApiError);
  }
});

test("selected USDC assets reject rehashed output/refund substitutions and decimal rounding attacks", () => {
  for (const mutate of [
    (quote: ReturnType<typeof relayQuoteFixture>) => { quote.protocol.v2.orderData.inputs[0].payment.currency = ARC_USDC; },
    (quote: ReturnType<typeof relayQuoteFixture>) => { quote.protocol.v2.orderData.inputs[0].refunds[0].currency = zeroAddress; },
    (quote: ReturnType<typeof relayQuoteFixture>) => { quote.protocol.v2.orderData.inputs[0].refunds[1].currency = ARC_USDC; },
    (quote: ReturnType<typeof relayQuoteFixture>) => { quote.protocol.v2.orderData.output.payments[0].currency = ARC_USDC; },
    (quote: ReturnType<typeof relayQuoteFixture>) => { quote.protocol.v2.orderData.output.payments[0].expectedAmount = (BigInt(quote.details.currencyOut.amount) + 1n).toString(); quote.details.currencyOut.amount = quote.protocol.v2.orderData.output.payments[0].expectedAmount; },
    (quote: ReturnType<typeof relayQuoteFixture>) => { quote.fees.relayer.amount = "60935"; },
    (quote: ReturnType<typeof relayQuoteFixture>) => { quote.fees.relayer.currency.decimals = 18; },
    (quote: ReturnType<typeof relayQuoteFixture>) => { quote.fees.gas.currency.address = BASE_USDC; quote.fees.gas.currency.symbol = "USDC"; quote.fees.gas.currency.decimals = 6; },
  ]) {
    const { input, quote } = relayBaseUsdcFixture(); mutate(quote);
    const metadata = validateRelayChains(relayChainsFixture(), input);
    const orderId = getOrderId(quote.protocol.v2.orderData as Order, metadata.vmTypes);
    quote.protocol.v2.orderId = orderId;
    quote.steps[1].items[0].data.data = encodeFunctionData({ abi: ERC20_DEPOSIT_ABI, functionName: "depositErc20", args: [input.address, BASE_USDC, BigInt(input.amount), orderId] });
    assert.throws(() => validateRelayQuote(quote, input, metadata, BASE_USDC_FIXTURE_NOW), BridgeApiError);
  }
  const { input, quote } = relayRouteFixture(4663, 8453, "ETH", "USDC");
  quote.details.currencyOut.currency.decimals = 18;
  assert.throws(() => validateRelayQuote(quote, input, validateRelayChains(relayChainsFixture(), input), FIXTURE_NOW), BridgeApiError);
});

test("Base USDC approval cannot borrow Arc's token, use unlimited amount or redirect spender", () => {
  for (const variant of ["Arc token", "native token", "unlimited", "wrong spender", "wrong chain"]) {
    const { input, quote } = relayBaseUsdcFixture();
    const tx = quote.steps[0].items[0].data;
    if (variant === "Arc token") tx.to = ARC_USDC;
    if (variant === "native token") tx.to = zeroAddress;
    if (variant === "wrong chain") tx.chainId = 5042;
    if (variant === "unlimited") tx.data = encodeFunctionData({ abi: APPROVAL_ABI, functionName: "approve", args: [RELAY_DEPOSITORY, (1n << 256n) - 1n] });
    if (variant === "wrong spender") tx.data = encodeFunctionData({ abi: APPROVAL_ABI, functionName: "approve", args: [input.address, BigInt(input.amount)] });
    assert.throws(() => validateRelayQuote(quote, input, validateRelayChains(relayChainsFixture(), input), BASE_USDC_FIXTURE_NOW), BridgeApiError, variant);
  }
});

const USDG_ROUTES: [BridgeChainId, BridgeChainId, BridgeAsset, BridgeAsset][] = [
  [8453, 4663, "USDC", "USDG"], [8453, 4663, "ETH", "USDG"], [5042, 4663, "USDC", "USDG"],
  [4663, 8453, "USDG", "USDC"], [4663, 8453, "USDG", "ETH"], [4663, 5042, "USDG", "USDC"],
];

test("Robinhood USDG routes verify in both directions with an exact approval of the right token", () => {
  for (const [origin, destination, originAsset, destinationAsset] of USDG_ROUTES) {
    const route = `${origin}:${originAsset}→${destination}:${destinationAsset}`;
    const { input, quote } = relayRouteFixture(origin, destination, originAsset, destinationAsset);
    const validated = validateRelayQuote(quote, input, validateRelayChains(relayChainsFixture(), input), FIXTURE_NOW);
    assert.equal(validated.transaction.to, RELAY_DEPOSITORY, route);
    const sent = bridgeCurrency(origin, originAsset, "input");
    if (sent.address === zeroAddress) {
      assert.equal(validated.approval, undefined, route);
      assert.equal(validated.transaction.value, input.amount, route);
    } else {
      // a token source approves exactly the amount, of its own chain's token, to the pinned depository
      assert.deepEqual(validated.approval, { token: sent.address, spender: RELAY_DEPOSITORY, amount: input.amount }, route);
      assert.equal(validated.transaction.value, "0", route);
    }
    if (originAsset === "USDG") assert.equal(validated.approval?.token, ROBINHOOD_USDG, route);
  }
});

test("USDG cannot be swapped for another token, another chain's dollar or other decimals, even when rehashed", () => {
  const rebound = (origin: BridgeChainId, destination: BridgeChainId, originAsset: BridgeAsset, destinationAsset: BridgeAsset, mutate: (quote: ReturnType<typeof relayQuoteFixture>) => void) => {
    const { input, quote } = relayRouteFixture(origin, destination, originAsset, destinationAsset);
    mutate(quote);
    const metadata = validateRelayChains(relayChainsFixture(), input);
    const orderId = getOrderId(quote.protocol.v2.orderData as Order, metadata.vmTypes);
    quote.protocol.v2.orderId = orderId;
    const sent = bridgeCurrency(origin, originAsset, "input");
    if (sent.address !== zeroAddress) quote.steps[0].items[0].data.data = encodeFunctionData({ abi: ERC20_DEPOSIT_ABI, functionName: "depositErc20", args: [input.address, sent.address, BigInt(input.amount), orderId] });
    return () => validateRelayQuote(quote, input, metadata, FIXTURE_NOW);
  };
  // receiving USDG: the output and the destination refund must be the pinned USDG contract
  for (const mutate of [
    (quote: ReturnType<typeof relayQuoteFixture>) => { quote.protocol.v2.orderData.output.payments[0].currency = BASE_USDC; },
    (quote: ReturnType<typeof relayQuoteFixture>) => { quote.protocol.v2.orderData.output.payments[0].currency = zeroAddress; },
    (quote: ReturnType<typeof relayQuoteFixture>) => { quote.protocol.v2.orderData.inputs[0].refunds[1].currency = zeroAddress; },
    (quote: ReturnType<typeof relayQuoteFixture>) => { quote.details.currencyOut.currency.symbol = "USDC"; },
    (quote: ReturnType<typeof relayQuoteFixture>) => { quote.details.currencyOut.currency.decimals = 18; },
  ]) assert.throws(rebound(8453, 4663, "USDC", "USDG", mutate), BridgeApiError);
  // sending USDG: the payment, the source refund and the fee stay in USDG
  for (const mutate of [
    (quote: ReturnType<typeof relayQuoteFixture>) => { quote.protocol.v2.orderData.inputs[0].payment.currency = BASE_USDC; },
    (quote: ReturnType<typeof relayQuoteFixture>) => { quote.protocol.v2.orderData.inputs[0].refunds[0].currency = zeroAddress; },
    (quote: ReturnType<typeof relayQuoteFixture>) => { quote.fees.relayer.currency.symbol = "USDC"; },
    (quote: ReturnType<typeof relayQuoteFixture>) => { quote.fees.gas.currency.address = ROBINHOOD_USDG; quote.fees.gas.currency.symbol = "USDG"; quote.fees.gas.currency.decimals = 6; },
  ]) assert.throws(rebound(4663, 8453, "USDG", "USDC", mutate), BridgeApiError);
  assert.doesNotThrow(rebound(8453, 4663, "USDC", "USDG", () => {}));
  assert.doesNotThrow(rebound(4663, 8453, "USDG", "USDC", () => {}));
});

test("funding networks verify into every launch chain, approving exactly their own native USDC", () => {
  const usdc = { 1: ETHEREUM_USDC, 42161: ARBITRUM_USDC, 10: OPTIMISM_USDC } as const;
  let routes = 0;
  for (const origin of BRIDGE_FUNDING_IDS) for (const destination of BRIDGE_DESTINATION_IDS) {
    for (const originAsset of BRIDGE_ASSETS[origin]) for (const destinationAsset of BRIDGE_ASSETS[destination]) {
      const route = `${origin}:${originAsset}→${destination}:${destinationAsset}`;
      const { input, quote } = relayRouteFixture(origin, destination, originAsset, destinationAsset);
      const metadata = validateRelayChains(relayChainsFixture(), input);
      // the solver hub (Base) is always checked alongside the two ends
      assert.deepEqual(Object.keys(metadata.vmTypes).sort(), [...new Set(["base", quote.protocol.v2.orderData.inputs[0].payment.chainId, quote.protocol.v2.orderData.output.chainId])].sort(), route);
      const validated = validateRelayQuote(quote, input, metadata, FIXTURE_NOW);
      assert.equal(validated.transaction.to, RELAY_DEPOSITORY, route);
      assert.equal(validated.transaction.chainId, origin, route);
      if (originAsset === "USDC") assert.deepEqual(validated.approval, { token: usdc[origin], spender: RELAY_DEPOSITORY, amount: input.amount }, route);
      else assert.equal(validated.approval, undefined, route);
      routes++;
    }
  }
  assert.equal(routes, 30);
});

test("a funding network is never a destination, and its USDC cannot be swapped for another network's", () => {
  for (const destinationChainId of BRIDGE_FUNDING_IDS) {
    for (const originChainId of [8453, 4663, 5042, ...BRIDGE_FUNDING_IDS.filter((id) => id !== destinationChainId)] as BridgeChainId[]) {
      assert.throws(() => parseBridgeRequest({ address: FIXTURE_INPUT.address, originChainId, destinationChainId, amount: "1000000" }), (error: unknown) => error instanceof BridgeApiError && error.status === 400);
    }
  }
  assert.equal(parseBridgeRequest({ address: FIXTURE_INPUT.address, originChainId: 42161, destinationChainId: 4663, originAsset: "USDC", destinationAsset: "USDG", amount: "1000000" }).originChainId, 42161);
  const rebound = (token: string) => {
    const { input, quote } = relayRouteFixture(1, 8453, "USDC", "USDC");
    quote.protocol.v2.orderData.inputs[0].payment.currency = token;
    quote.protocol.v2.orderData.inputs[0].refunds[0].currency = token;
    const metadata = validateRelayChains(relayChainsFixture(), input);
    const orderId = getOrderId(quote.protocol.v2.orderData as Order, metadata.vmTypes);
    quote.protocol.v2.orderId = orderId;
    quote.steps[0].items[0].data.data = encodeFunctionData({ abi: ERC20_DEPOSIT_ABI, functionName: "depositErc20", args: [input.address, token as `0x${string}`, BigInt(input.amount), orderId] });
    return () => validateRelayQuote(quote, input, metadata, FIXTURE_NOW);
  };
  for (const token of [ARBITRUM_USDC, OPTIMISM_USDC, BASE_USDC, zeroAddress]) assert.throws(rebound(token), BridgeApiError, token);
  assert.doesNotThrow(rebound(ETHEREUM_USDC));
});

test("a funding network missing from Relay's catalogue, or not yet on the pinned router, fails closed", () => {
  const input = { address: FIXTURE_INPUT.address, originChainId: 42161, destinationChainId: 8453, amount: "1000000" } as const;
  const missing = relayChainsFixture();
  missing.chains = missing.chains.filter((chain) => chain.id !== 42161);
  assert.throws(() => validateRelayChains(missing, input), BridgeApiError);
  const moved = relayChainsFixture();
  moved.chains.find((chain) => chain.id === 42161)!.contracts.erc20Router = "0x000000000000000000000000000000000000dead";
  assert.throws(() => validateRelayChains(moved, input), BridgeApiError);
  const renamed = relayChainsFixture();
  renamed.chains.find((chain) => chain.id === 42161)!.protocol.v2.chainId = "arbitrum-nova";
  assert.throws(() => validateRelayChains(renamed, input), BridgeApiError);
  assert.doesNotThrow(() => validateRelayChains(relayChainsFixture(), input));
});

test("a dollar is counted against a dollar: USDC and USDG routes never guarantee under 95% or claim over 105%", () => {
  // the provider's own impact estimate stays a mild -0.12% throughout, so only the unit comparison can refuse these
  const delivering = (origin: BridgeChainId, destination: BridgeChainId, originAsset: BridgeAsset, destinationAsset: BridgeAsset, percent: bigint) => {
    const { input, quote } = relayRouteFixture(origin, destination, originAsset, destinationAsset);
    const received = bridgeCurrency(destination, destinationAsset, "output");
    const expected = BigInt(input.amount) * 10n ** BigInt(received.decimals - 6) * percent / 100n;
    const minimum = expected * 9950n / 10000n;
    const payment = quote.protocol.v2.orderData.output.payments[0];
    payment.expectedAmount = expected.toString();
    payment.minimumAmount = minimum.toString();
    quote.details.currencyOut.amount = expected.toString();
    quote.details.currencyOut.minimumAmount = minimum.toString();
    quote.details.totalImpact.percent = "-0.12";
    const metadata = validateRelayChains(relayChainsFixture(), input);
    const orderId = getOrderId(quote.protocol.v2.orderData as Order, metadata.vmTypes);
    quote.protocol.v2.orderId = orderId;
    quote.steps[0].items[0].data.data = encodeFunctionData({ abi: ERC20_DEPOSIT_ABI, functionName: "depositErc20", args: [input.address, bridgeCurrency(origin, originAsset, "input").address, BigInt(input.amount), orderId] });
    return () => validateRelayQuote(quote, input, metadata, FIXTURE_NOW);
  };
  // six decimals on both sides, and six against Arc's eighteen
  for (const [origin, destination, originAsset, destinationAsset] of [[8453, 4663, "USDC", "USDG"], [4663, 8453, "USDG", "USDC"], [4663, 5042, "USDG", "USDC"], [5042, 4663, "USDC", "USDG"]] as [BridgeChainId, BridgeChainId, BridgeAsset, BridgeAsset][]) {
    const route = `${origin}:${originAsset}→${destination}:${destinationAsset}`;
    for (const percent of [96n, 100n, 104n]) assert.doesNotThrow(delivering(origin, destination, originAsset, destinationAsset, percent), `${route} at ${percent}%`);
    // 95% expected leaves a guaranteed minimum under 95%
    for (const percent of [50n, 90n, 95n, 106n, 1000n]) assert.throws(delivering(origin, destination, originAsset, destinationAsset, percent), BridgeApiError, `${route} at ${percent}%`);
  }
});

test("the chain catalogue is reused per fetcher within its TTL and refetched after it or after a failure", async () => {
  const calls: string[] = [];
  let chainsBody: unknown = relayChainsFixture();
  const fetcher = async (url: string) => {
    calls.push(url);
    return Response.json(url.endsWith("/chains") ? chainsBody : relayQuoteFixture());
  };
  const chainsCalls = () => calls.filter((url) => url.endsWith("/chains")).length;
  let now = FIXTURE_NOW - 100_000; // the fixture order deadline is FIXTURE_NOW + 100 s; keep every step inside it
  await Promise.all([getBridgeQuote(FIXTURE_INPUT, fetcher, () => now), getBridgeQuote(FIXTURE_INPUT, fetcher, () => now)]);
  assert.equal(chainsCalls(), 1); // concurrent quotes share one in-flight catalogue
  now += 59_000;
  await getBridgeQuote(FIXTURE_INPUT, fetcher, () => now);
  assert.equal(chainsCalls(), 1);
  now += 2_000;
  await getBridgeQuote(FIXTURE_INPUT, fetcher, () => now);
  assert.equal(chainsCalls(), 2);
  // A copy that fails verification is dropped, not served again for a minute.
  chainsBody = { chains: [] };
  now += 61_000;
  await assert.rejects(getBridgeQuote(FIXTURE_INPUT, fetcher, () => now), (error) => error instanceof BridgeApiError);
  assert.equal(chainsCalls(), 3);
  chainsBody = relayChainsFixture();
  await getBridgeQuote(FIXTURE_INPUT, fetcher, () => now);
  assert.equal(chainsCalls(), 4);
  // Another fetcher never sees this fetcher's copy.
  await getBridgeQuote(FIXTURE_INPUT, async (url) => { calls.push(`other:${url}`); return Response.json(url.endsWith("/chains") ? relayChainsFixture() : relayQuoteFixture()); }, () => now);
  assert.equal(calls.filter((url) => url.startsWith("other:") && url.endsWith("/chains")).length, 1);
});
