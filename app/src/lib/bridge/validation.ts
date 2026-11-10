import "server-only";
import { getOrderId, type Order } from "./relay-order";
import { encodeFunctionData, formatEther, formatUnits, isAddress, parseAbi, zeroAddress, type Hex } from "viem";
import { BRIDGE_CHAINS, bridgeCurrency, bridgeFeePercent, isBridgeAssetSupported, isBridgeChainId, type BridgeCurrency, type BridgeChainId, type BridgeQuote, type BridgeQuoteRejection, type BridgeQuoteRequest, type BridgeStatus, type BridgeStatusResponse } from "./types";

// Independently pinned, then checked against GET /chains. Never trust a quote to
// supply the address against which that same quote is validated.
export const RELAY_DEPOSITORY = "0x4cd00e387622c35bddb9b4c962c136462338bc31";
// Relay's execution routers on Base, Robinhood Chain and Arc (the "Cancun" column of its contract-versions table,
// docs.relay.link/references/api/api_resources/contract-addresses): v3.2 first, then v3. Relay made v3.2 the default on
// 2026-10-26 and keeps both live through the transition, telling integrators who pin addresses to allow both. A router
// Relay publishes later is rejected until it is added here: every quote then fails closed, which the opt-in live tests
// (relay.live.test.ts) show at once.
export const RELAY_ROUTERS = ["0x0729e2a4716d9f7dd17858d5d504426d228697f7", "0xb92fe925dc43a0ecde6c8b1a2709c170ec4fff4f"] as const;
const isRelayRouter = (value: unknown) => RELAY_ROUTERS.some((router) => sameAddress(value, router));
/** An order names its router as one ABI word in extraData: twelve zero bytes, then the address. */
const isRelayRouterWord = (value: unknown) => RELAY_ROUTERS.some((router) => sameAddress(value, `0x${router.slice(2).padStart(64, "0")}`));
export const DEPOSIT_ABI = parseAbi(["function depositNative(address depositor, bytes32 id) payable"]);
export const ERC20_DEPOSIT_ABI = parseAbi(["function depositErc20(address depositor, address token, uint256 amount, bytes32 id)"]);
export const APPROVAL_ABI = parseAbi(["function approve(address spender, uint256 amount) returns (bool)"]);
export const QUOTE_TTL_MS = 45_000;
const DEADLINE_MARGIN_MS = 15_000;
const UINT256_MAX = (1n << 256n) - 1n;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const NATIVE_SYMBOLS = { 8453: "ETH", 4663: "ETH", 5042: "USDC" } as const;
const MAX_TOTAL_LOSS_PERCENT = 5;
type ObjectValue = Record<string, unknown>;

export class BridgeApiError extends Error {
  constructor(message: string, public readonly status = 502, public readonly quoteRejection?: BridgeQuoteRejection) { super(message); }
}

function ensure(condition: unknown): asserts condition {
  if (!condition) throw new BridgeApiError("The bridge returned an unverifiable quote. Please try again.");
}
function object(value: unknown): ObjectValue {
  ensure(value && typeof value === "object" && !Array.isArray(value));
  return value as ObjectValue;
}
function list(value: unknown, length?: number): unknown[] {
  ensure(Array.isArray(value) && (length === undefined || value.length === length));
  return value;
}
function sameAddress(value: unknown, expected: string): boolean {
  return typeof value === "string" && value.toLowerCase() === expected.toLowerCase();
}
function uint(value: unknown, positive = false): string {
  ensure(typeof value === "string" && /^(0|[1-9][0-9]{0,77})$/.test(value));
  ensure(BigInt(value) <= UINT256_MAX && (!positive || BigInt(value) > 0n));
  return value;
}
export function isRequestId(value: unknown): value is Hex {
  return typeof value === "string" && HASH.test(value) && !/^0x0{64}$/.test(value);
}

export function parseBridgeRequest(value: unknown): BridgeQuoteRequest {
  try {
    const b = object(value);
    const required = ["address", "originChainId", "destinationChainId", "amount"];
    ensure(required.every((key) => Object.hasOwn(b, key)) && Object.keys(b).every((key) => [...required, "originAsset", "destinationAsset"].includes(key)));
    ensure(typeof b.address === "string" && isAddress(b.address, { strict: false }) && !sameAddress(b.address, zeroAddress));
    ensure(isBridgeChainId(b.originChainId) && isBridgeChainId(b.destinationChainId) && b.originChainId !== b.destinationChainId);
    ensure(b.originAsset === undefined || isBridgeAssetSupported(b.originChainId, b.originAsset));
    ensure(b.destinationAsset === undefined || isBridgeAssetSupported(b.destinationChainId, b.destinationAsset));
    const amount = uint(b.amount, true);
    // ERC20 max is an unlimited-allowance sentinel, never an exact approval.
    ensure(sameAddress(bridgeCurrency(b.originChainId, b.originAsset, "input").address, zeroAddress) || BigInt(amount) < UINT256_MAX);
    return { address: b.address as BridgeQuoteRequest["address"], originChainId: b.originChainId, destinationChainId: b.destinationChainId, amount, ...(b.originAsset === undefined ? {} : { originAsset: b.originAsset }), ...(b.destinationAsset === undefined ? {} : { destinationAsset: b.destinationAsset }) };
  } catch {
    throw new BridgeApiError("Enter a valid wallet, amount, and supported bridge route.", 400);
  }
}

export type RelayChainMetadata = {
  vmTypes: Record<string, "ethereum-vm">;
  solverAddresses: string[];
};

export function validateRelayChains(value: unknown, route: Pick<BridgeQuoteRequest, "originChainId" | "destinationChainId"> = { originChainId: 8453, destinationChainId: 4663 }): RelayChainMetadata {
  const chains = list(object(value).chains);
  // Base hosts the solver hub even for Robinhood↔Arc. Unrelated route outages
  // must not disable otherwise valid routes, so only inspect these chains.
  const required = [...new Set<BridgeChainId>([8453, route.originChainId, route.destinationChainId])];
  const selected = required.map((id) => {
    const matches = chains.filter((chain) => object(chain).id === id);
    const chain = object(list(matches, 1)[0]);
    const v2 = object(object(chain.protocol).v2);
    const currency = object(chain.currency);
    const contracts = object(chain.contracts);
    ensure(chain.vmType === "evm" && chain.disabled === false && chain.depositEnabled === true && chain.blockProductionLagging !== true);
    ensure(v2.chainId === BRIDGE_CHAINS[id].key && sameAddress(v2.depository, RELAY_DEPOSITORY));
    ensure(sameAddress(currency.address, zeroAddress) && currency.decimals === 18 && currency.symbol === NATIVE_SYMBOLS[id] && currency.supportsBridging === true);
    ensure(isRelayRouter(contracts.erc20Router));
    return chain;
  });
  const solvers = list(selected.find((chain) => chain.id === 8453)!.solverAddresses);
  ensure(solvers.length > 0 && solvers.every((v) => typeof v === "string" && isAddress(v, { strict: false })));
  return { vmTypes: Object.fromEntries(required.map((id) => [BRIDGE_CHAINS[id].key, "ethereum-vm" as const])), solverAddresses: solvers as string[] };
}

/** Implements Relay's protocol.v2 input validation for allowlisted ETH / USDC. */
export function validateRelayQuote(value: unknown, input: BridgeQuoteRequest, chains: RelayChainMetadata, now = Date.now()): BridgeQuote {
  const quote = object(value);
  const protocol = object(object(quote.protocol).v2);
  const order = object(protocol.orderData);
  const source = BRIDGE_CHAINS[input.originChainId].key;
  const destination = BRIDGE_CHAINS[input.destinationChainId].key;
  const inputCurrency = bridgeCurrency(input.originChainId, input.originAsset, "input");
  const outputCurrency = bridgeCurrency(input.destinationChainId, input.destinationAsset, "output");
  const erc20Input = !sameAddress(inputCurrency.address, zeroAddress);
  ensure(!erc20Input || BigInt(uint(input.amount, true)) < UINT256_MAX);
  const sameAsset = inputCurrency.symbol === outputCurrency.symbol;
  const inputScale = 10n ** BigInt(inputCurrency.decimals);
  const outputScale = 10n ** BigInt(outputCurrency.decimals);
  ensure(protocol.hubType === "onchain" && order.version === "v1" && order.solverChainId === "base");
  ensure(chains.solverAddresses.some((solver) => sameAddress(order.solver, solver)) && isRequestId(order.salt));
  const orderInput = object(list(order.inputs, 1)[0]);
  const payment = object(orderInput.payment);
  ensure(payment.chainId === source && sameAddress(payment.currency, inputCurrency.address) && uint(payment.amount, true) === input.amount && payment.weight === "1");
  const output = object(order.output);
  ensure(output.chainId === destination && list(output.calls, 0) && list(order.fees, 0));
  ensure(isRelayRouterWord(output.extraData));
  ensure(typeof output.deadline === "number" && Number.isSafeInteger(output.deadline));
  const expiresAt = Math.min(now + QUOTE_TTL_MS, output.deadline * 1000 - DEADLINE_MARGIN_MS);
  ensure(expiresAt >= now + 5_000);
  const outputPayment = object(list(output.payments, 1)[0]);
  ensure(sameAddress(outputPayment.recipient, input.address) && sameAddress(outputPayment.currency, outputCurrency.address));
  const amountOut = uint(outputPayment.expectedAmount, true);
  const minimumAmountOut = uint(outputPayment.minimumAmount, true);
  ensure(BigInt(minimumAmountOut) <= BigInt(amountOut));
  if (sameAsset) ensure(BigInt(amountOut) * inputScale <= BigInt(input.amount) * outputScale);
  ensure(BigInt(minimumAmountOut) >= BigInt(amountOut) * 9950n / 10000n);
  // A failed fill may refund on either chain, but can never redirect the refund.
  const refunds = list(orderInput.refunds, 2).map(object);
  ensure(new Set(refunds.map((refund) => refund.chainId)).size === 2);
  for (const refund of refunds) {
    ensure((refund.chainId === source || refund.chainId === destination) && sameAddress(refund.recipient, input.address));
    const refundCurrency = refund.chainId === source ? inputCurrency.address : outputCurrency.address;
    ensure(sameAddress(refund.currency, refundCurrency) && uint(refund.minimumAmount) === "0" && refund.deadline === output.deadline && isRelayRouterWord(refund.extraData));
  }
  const paymentDetails = object(protocol.paymentDetails);
  ensure(paymentDetails.chainId === source && sameAddress(paymentDetails.depository, RELAY_DEPOSITORY) && sameAddress(paymentDetails.currency, inputCurrency.address) && uint(paymentDetails.amount) === input.amount);
  ensure(isRequestId(protocol.orderId));
  // Use the provider's maintained encoding, never a locally invented order hash.
  const computedOrderId = getOrderId(order as unknown as Order, chains.vmTypes);
  ensure(sameAddress(computedOrderId, protocol.orderId));

  const steps = list(quote.steps);
  ensure(steps.length === 1 || (erc20Input && steps.length === 2));
  const step = object(steps[steps.length - 1]);
  ensure(step.id === "deposit" && step.kind === "transaction" && isRequestId(step.requestId) && !step.depositAddress);
  if (steps.length === 2) {
    const approvalStep = object(steps[0]);
    ensure(approvalStep.id === "approve" && approvalStep.kind === "transaction" && approvalStep.requestId === step.requestId && !approvalStep.depositAddress);
    const approvalItem = object(list(approvalStep.items, 1)[0]);
    ensure(approvalItem.status === "incomplete");
    const approvalTx = object(approvalItem.data);
    const approvalData = encodeFunctionData({ abi: APPROVAL_ABI, functionName: "approve", args: [RELAY_DEPOSITORY, BigInt(input.amount)] });
    ensure(sameAddress(approvalTx.from, input.address) && sameAddress(approvalTx.to, inputCurrency.address) && approvalTx.chainId === input.originChainId && uint(approvalTx.value) === "0" && sameAddress(approvalTx.data, approvalData));
  }
  const item = object(list(step.items, 1)[0]);
  ensure(item.status === "incomplete");
  const tx = object(item.data);
  const depositValue = erc20Input ? "0" : input.amount;
  ensure(sameAddress(tx.from, input.address) && sameAddress(tx.to, RELAY_DEPOSITORY) && tx.chainId === input.originChainId && uint(tx.value) === depositValue);
  const calldata = erc20Input
    ? encodeFunctionData({ abi: ERC20_DEPOSIT_ABI, functionName: "depositErc20", args: [input.address, inputCurrency.address, BigInt(input.amount), computedOrderId] })
    : encodeFunctionData({ abi: DEPOSIT_ABI, functionName: "depositNative", args: [input.address, computedOrderId] });
  ensure(sameAddress(tx.data, calldata)); // exact encoding also rejects trailing bytes
  const check = object(item.check);
  ensure(check.method === "GET" && check.endpoint === `/intents/status/v3?requestId=${step.requestId}`);

  const details = object(quote.details);
  ensure(sameAddress(details.sender, input.address) && sameAddress(details.recipient, input.address));
  const checkCurrency = (value: unknown, chainId: BridgeChainId, amount: string, expected: BridgeCurrency) => {
    const money = object(value);
    const currency = object(money.currency);
    ensure(currency.chainId === chainId && sameAddress(currency.address, expected.address) && currency.decimals === expected.decimals && currency.symbol === expected.symbol && uint(money.amount) === amount);
    return money;
  };
  checkCurrency(details.currencyIn, input.originChainId, input.amount, inputCurrency);
  ensure(checkCurrency(details.currencyOut, input.destinationChainId, amountOut, outputCurrency).minimumAmount === minimumAmountOut);
  const fees = object(quote.fees);
  const relayerAmount = uint(object(fees.relayer).amount);
  const gasAmount = uint(object(fees.gas).amount);
  checkCurrency(fees.relayer, input.originChainId, relayerAmount, inputCurrency);
  checkCurrency(fees.gas, input.originChainId, gasAmount, { address: zeroAddress, decimals: 18, symbol: NATIVE_SYMBOLS[input.originChainId] });
  ensure(BigInt(relayerAmount) < BigInt(input.amount));
  // Same-symbol USDC still has 6/18-decimal interfaces. Cross multiplication
  // preserves exact fee equality without truncating either amount. ETH↔USDC
  // instead uses the bounded source fee and Relay's market-impact estimate.
  if (sameAsset) ensure(BigInt(relayerAmount) * outputScale === BigInt(input.amount) * outputScale - BigInt(amountOut) * inputScale);
  ensure(uint(object(fees.app).amount) === "0");
  if (fees.subsidized !== undefined) ensure(uint(object(fees.subsidized).amount) === "0");
  const totalImpactPercent = object(details.totalImpact).percent;
  ensure(typeof totalImpactPercent === "string" && totalImpactPercent.length <= 32 && /^-?\d+(?:\.\d+)?$/.test(totalImpactPercent));
  const negativeImpact = totalImpactPercent.startsWith("-");
  const [wholeImpact, fractionalImpact = ""] = (negativeImpact ? totalImpactPercent.slice(1) : totalImpactPercent).split(".");
  const impactMagnitude = BigInt(wholeImpact + fractionalImpact);
  const impactScale = 10n ** BigInt(fractionalImpact.length);
  ensure(impactMagnitude <= 100n * impactScale);
  ensure(typeof details.timeEstimate === "number" && Number.isFinite(details.timeEstimate) && details.timeEstimate >= 0 && details.timeEstimate <= 86400);
  // Complete every structural, currency and order check before exposing costs.
  // A rejected quote never exposes its approval, deposit calldata or request ID.
  const relayFee = formatUnits(BigInt(relayerAmount), inputCurrency.decimals);
  const sourceGas = formatEther(BigInt(gasAmount));
  const reason = BigInt(relayerAmount) * 100n > BigInt(input.amount) * BigInt(MAX_TOTAL_LOSS_PERCENT) ? "relay-fee"
    : negativeImpact && impactMagnitude > BigInt(MAX_TOTAL_LOSS_PERCENT) * impactScale ? "total-impact" : null;
  if (reason) {
    const quoteRejection: BridgeQuoteRejection = { ...input, reason, relayFee, relayFeePercent: bridgeFeePercent(BigInt(relayerAmount), BigInt(input.amount)), sourceGas, totalImpactPercent };
    throw new BridgeApiError(reason === "relay-fee"
      ? "This quote charges more than 5% in bridge fees. Try a different amount or wait for a better quote."
      : "This quote loses more than 5% in fees and price impact. Try a different amount or wait for a better quote.", 422, quoteRejection);
  }
  return {
    ...input, requestId: step.requestId, amountOut, minimumAmountOut,
    relayFee, sourceGas, totalImpactPercent,
    ...(erc20Input ? { approval: { token: inputCurrency.address, spender: RELAY_DEPOSITORY, amount: input.amount } } : {}),
    timeEstimate: details.timeEstimate, expiresAt, ttlMs: expiresAt - now,
    transaction: { to: RELAY_DEPOSITORY, data: calldata, value: depositValue, chainId: input.originChainId },
  };
}

export function parseRelayStatus(value: unknown): BridgeStatusResponse {
  const response = object(value);
  const statuses: BridgeStatus[] = ["waiting", "depositing", "pending", "submitted", "delayed", "success", "refund", "failure"];
  ensure(statuses.includes(response.status as BridgeStatus));
  for (const key of ["originChainId", "destinationChainId"]) {
    if (response[key] !== undefined) ensure(isBridgeChainId(response[key]));
  }
  const hashes = (value: unknown): Hex[] => {
    if (value === undefined) return [];
    const values = list(value);
    ensure(values.length <= 20 && values.every(isRequestId));
    return values as Hex[];
  };
  return { status: response.status as BridgeStatus, inTxHashes: hashes(response.inTxHashes), txHashes: hashes(response.txHashes) };
}
