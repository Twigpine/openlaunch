import { encodeFunctionData, zeroAddress } from "viem";
import { getOrderId, type Order } from "./relay-order";
import { BRIDGE_CHAINS, BRIDGE_CHAIN_IDS, BRIDGE_INPUT_CURRENCIES, bridgeCurrency, bridgeTokens, bridgesNativeCurrency, isDollarAsset, type BridgeAsset, type BridgeChainId, type BridgeQuoteRequest } from "./types";
import { APPROVAL_ABI, DEPOSIT_ABI, ERC20_DEPOSIT_ABI, RELAY_DEPOSITORY } from "./validation";

// Compact, read-only mainnet quote captured with Relay's public example account.
// Never executed. The fixed order hash provides an independent encoding vector.
export const FIXTURE_NOW = 1790141417000;
export const FIXTURE_ADDRESS = "0x03508bb71268bba25ecacc8f620e01866650532c";
export const FIXTURE_ORDER_ID = "0x821340c60739e51c1b86f8bd0b1a106b70be74cc79a7d38a69e859dd7f37c4b0";
export const FIXTURE_REQUEST_ID = "0x1789536717c461dc89176ca26a7699a6a97a50b64265140f4d11a52159491da8";
const router = "0xb92fe925dc43a0ecde6c8b1a2709c170ec4fff4f";
const extraData = `0x${router.slice(2).padStart(64, "0")}`;
export const FIXTURE_INPUT: BridgeQuoteRequest = { address: FIXTURE_ADDRESS, originChainId: 8453, destinationChainId: 4663, amount: "10000000000000000" };

export function relayChainsFixture() {
  return { chains: BRIDGE_CHAIN_IDS.map((id) => ({
    id, vmType: "evm", disabled: false, depositEnabled: true, blockProductionLagging: false,
    protocol: { v2: { chainId: BRIDGE_CHAINS[id].key, depository: RELAY_DEPOSITORY } },
    // as Relay lists them: Elysium's native HYPE is not bridgeable there, only its USDC
    currency: { address: zeroAddress, symbol: BRIDGE_CHAINS[id].symbol as string, decimals: 18, supportsBridging: bridgesNativeCurrency(id) },
    erc20Currencies: bridgeTokens(id).map((token) => ({ address: token.address.toLowerCase(), symbol: token.symbol as string, decimals: token.decimals as number, supportsBridging: true })),
    contracts: { erc20Router: router }, solverAddresses: ["0xf70da97812cb96acdf810712aa562db8dfa3dbef"],
  })) };
}

export function relayQuoteFixture() {
  const amountOut = "9987669548275956";
  const minimumAmount = "9937731200534577";
  const money = (chainId: number, amount: string) => ({ currency: { chainId, address: zeroAddress as string, symbol: chainId === 5042 ? "USDC" : "ETH", decimals: 18 }, amount });
  return {
    protocol: { v2: {
      orderId: FIXTURE_ORDER_ID, hubType: "onchain",
      orderData: {
        version: "v1", solverChainId: "base", solver: "0xf70da97812cb96acdf810712aa562db8dfa3dbef",
        salt: "0x63f4beb696db6675f6a0678edb29aa8e209fef9137317c5f73a2f8d3819f2e22",
        inputs: [{ payment: { chainId: "base", currency: zeroAddress as string, amount: FIXTURE_INPUT.amount, weight: "1" },
          refunds: ["base", "robinhood"].map((chainId) => ({ chainId, recipient: FIXTURE_ADDRESS, currency: zeroAddress as string, minimumAmount: "0", deadline: 1790141517, extraData })),
        }],
        output: { chainId: "robinhood", payments: [{ recipient: FIXTURE_ADDRESS, currency: zeroAddress as string, minimumAmount, expectedAmount: amountOut }], calls: [], deadline: 1790141517, extraData },
        fees: [],
      },
      paymentDetails: { chainId: "base", depository: RELAY_DEPOSITORY, currency: zeroAddress as string, amount: FIXTURE_INPUT.amount },
    } },
    steps: [{ id: "deposit", kind: "transaction", requestId: FIXTURE_REQUEST_ID, depositAddress: "", items: [{
      status: "incomplete", data: {
        from: FIXTURE_ADDRESS, to: RELAY_DEPOSITORY,
        data: `0x49290c1c${FIXTURE_ADDRESS.slice(2).padStart(64, "0")}${FIXTURE_ORDER_ID.slice(2)}`,
        value: FIXTURE_INPUT.amount, chainId: 8453,
      }, check: { endpoint: `/intents/status/v3?requestId=${FIXTURE_REQUEST_ID}`, method: "GET" },
    }] }],
    details: { sender: FIXTURE_ADDRESS, recipient: FIXTURE_ADDRESS, currencyIn: money(8453, FIXTURE_INPUT.amount), currencyOut: { ...money(4663, amountOut), minimumAmount }, totalImpact: { percent: "-0.12" }, timeEstimate: 1 },
    fees: { relayer: money(8453, "12330451724044"), gas: money(8453, "3000000000000"), app: money(8453, "0"), subsidized: money(8453, "0") },
  };
}

/** Synthetic routes retain the complete native / exact ERC-20 deposit structure. */
export function relayRouteFixture(originChainId: BridgeChainId, destinationChainId: BridgeChainId, originAsset?: BridgeAsset, destinationAsset?: BridgeAsset) {
  const source = BRIDGE_CHAINS[originChainId].key;
  const destination = BRIDGE_CHAINS[destinationChainId].key;
  const inputCurrency = bridgeCurrency(originChainId, originAsset, "input");
  const outputCurrency = bridgeCurrency(destinationChainId, destinationAsset, "output");
  const erc20 = inputCurrency.address !== zeroAddress;
  // USDC and USDG are both dollars: a dollar route delivers the input less its fee, in the output's own decimals
  const dollarIn = isDollarAsset(inputCurrency.symbol);
  const dollarOut = isDollarAsset(outputCurrency.symbol);
  const amount = dollarIn ? "25000000" : FIXTURE_INPUT.amount;
  const feeAmount = dollarIn ? "60000" : dollarOut ? "24736726855049" : "12330451724044";
  const amountOut = inputCurrency.symbol === outputCurrency.symbol || (dollarIn && dollarOut)
    ? ((BigInt(amount) - BigInt(feeAmount)) * 10n ** BigInt(outputCurrency.decimals) / 10n ** BigInt(inputCurrency.decimals)).toString()
    : dollarOut ? (238n * 10n ** BigInt(outputCurrency.decimals) / 10n).toString() : "10400000000000000";
  const minimumAmount = (BigInt(amountOut) * 9950n / 10000n).toString();
  const input: BridgeQuoteRequest = { address: FIXTURE_ADDRESS, originChainId, destinationChainId, amount, ...(originAsset === undefined ? {} : { originAsset }), ...(destinationAsset === undefined ? {} : { destinationAsset }) };
  const quote = relayQuoteFixture();
  const order = quote.protocol.v2.orderData;
  order.inputs[0].payment = { chainId: source, currency: inputCurrency.address, amount, weight: "1" };
  order.inputs[0].refunds = [source, destination].map((chainId) => ({ chainId, recipient: input.address, currency: chainId === source ? inputCurrency.address : outputCurrency.address, minimumAmount: "0", deadline: order.output.deadline, extraData }));
  order.output.chainId = destination;
  order.output.payments[0] = { recipient: input.address, currency: outputCurrency.address, minimumAmount, expectedAmount: amountOut };
  quote.protocol.v2.paymentDetails.chainId = source;
  quote.protocol.v2.paymentDetails.currency = inputCurrency.address;
  quote.protocol.v2.paymentDetails.amount = amount;
  quote.steps[0].items[0].data.chainId = originChainId;
  quote.steps[0].items[0].data.value = erc20 ? "0" : amount;
  quote.details.currencyIn.currency.chainId = originChainId;
  quote.details.currencyIn.currency.symbol = inputCurrency.symbol;
  quote.details.currencyIn.currency.address = inputCurrency.address;
  quote.details.currencyIn.currency.decimals = inputCurrency.decimals;
  quote.details.currencyIn.amount = amount;
  quote.details.currencyOut.currency.chainId = destinationChainId;
  quote.details.currencyOut.currency.symbol = outputCurrency.symbol;
  quote.details.currencyOut.currency.address = outputCurrency.address;
  quote.details.currencyOut.currency.decimals = outputCurrency.decimals;
  quote.details.currencyOut.amount = amountOut;
  quote.details.currencyOut.minimumAmount = minimumAmount;
  quote.details.totalImpact.percent = originChainId === 5042 || destinationChainId === 5042 ? "-0.68" : "-0.12";
  for (const fee of Object.values(quote.fees)) {
    fee.currency.chainId = originChainId;
    fee.currency.symbol = inputCurrency.symbol;
    fee.currency.address = inputCurrency.address;
    fee.currency.decimals = inputCurrency.decimals;
  }
  quote.fees.gas.currency.address = zeroAddress;
  quote.fees.gas.currency.decimals = 18;
  quote.fees.gas.currency.symbol = BRIDGE_CHAINS[originChainId].symbol;
  quote.fees.relayer.amount = feeAmount;
  quote.fees.gas.amount = originChainId === 5042 ? "3000000000000000" : "671181819574";
  const orderId = getOrderId(order as Order, Object.fromEntries(BRIDGE_CHAIN_IDS.map((id) => [BRIDGE_CHAINS[id].key, "ethereum-vm" as const])));
  quote.protocol.v2.orderId = orderId;
  quote.steps[0].items[0].data.data = erc20
    ? encodeFunctionData({ abi: ERC20_DEPOSIT_ABI, functionName: "depositErc20", args: [input.address, inputCurrency.address, BigInt(amount), orderId] })
    : encodeFunctionData({ abi: DEPOSIT_ABI, functionName: "depositNative", args: [input.address, orderId] });
  return { input, quote };
}

export function addApprovalFixture(quote: ReturnType<typeof relayQuoteFixture>, input: BridgeQuoteRequest) {
  const approval = structuredClone(quote.steps[0]);
  approval.id = "approve";
  approval.items[0].data.to = bridgeCurrency(input.originChainId, input.originAsset, "input").address;
  approval.items[0].data.value = "0";
  approval.items[0].data.data = encodeFunctionData({ abi: APPROVAL_ABI, functionName: "approve", args: [RELAY_DEPOSITORY, BigInt(input.amount)] });
  quote.steps.unshift(approval);
}

// Independent unsigned Base→Arc capture: the order ID came directly from Relay.
export const ARC_FIXTURE_NOW = 1790145902000;
export const ARC_FIXTURE_ORDER_ID = "0x3d2084d45de6c676747a09dc5e303c772b4300e1d27f3a8bfbd2a269192023b0";
export function relayArcQuoteFixture() {
  const { input, quote } = relayRouteFixture(8453, 5042);
  const address = "0x1111111111111111111111111111111111111111";
  input.address = address;
  const order = quote.protocol.v2.orderData;
  order.salt = "0xed669f2a03277b9e00687ed0e243e5cb195d2b86c0327ba6bb88cd479b5b4f54";
  order.output.deadline = 1790146002;
  order.output.payments[0] = { recipient: address, currency: zeroAddress, minimumAmount: "23686807729608496144", expectedAmount: "23805836914179393109" };
  for (const refund of order.inputs[0].refunds) { refund.recipient = address; refund.deadline = order.output.deadline; }
  quote.protocol.v2.orderId = ARC_FIXTURE_ORDER_ID;
  quote.steps[0].requestId = "0x17895412021a6804d2f81161357b456285dc32fddbb5691a414b174584cfe949";
  quote.steps[0].items[0].data.from = address;
  quote.steps[0].items[0].data.data = encodeFunctionData({ abi: DEPOSIT_ABI, functionName: "depositNative", args: [address, ARC_FIXTURE_ORDER_ID] });
  quote.steps[0].items[0].check.endpoint = `/intents/status/v3?requestId=${quote.steps[0].requestId}`;
  quote.details.sender = address;
  quote.details.recipient = address;
  quote.details.currencyOut.amount = order.output.payments[0].expectedAmount;
  quote.details.currencyOut.minimumAmount = order.output.payments[0].minimumAmount;
  return { input, quote };
}

// Independent unsigned Arc ERC-20→Robinhood capture, including exact approval.
export const ARC_OUTBOUND_FIXTURE_NOW = 1790146668000;
export const ARC_OUTBOUND_ORDER_ID = "0xd2ca55b2630a781450fc62ab5b2b81df6582302a9367ddc98c1c477c6d34e6df";
export function relayArcOutboundFixture() {
  const { input, quote } = relayRouteFixture(5042, 4663);
  const address = "0x1111111111111111111111111111111111111111";
  input.address = address;
  const order = quote.protocol.v2.orderData;
  order.salt = "0x1a2c24137231b17e3c2a87b07ecc7c69a4d76b14c96db341891ec4d338eb9387";
  order.output.deadline = 1790146768;
  order.output.payments[0] = { recipient: address, currency: zeroAddress, minimumAmount: "10328979931861476", expectedAmount: "10380884353629624" };
  for (const refund of order.inputs[0].refunds) { refund.recipient = address; refund.deadline = order.output.deadline; }
  quote.protocol.v2.orderId = ARC_OUTBOUND_ORDER_ID;
  quote.steps[0].requestId = "0x1789541968421d7d023d7da7b4c7d60e90ac1ec9df50ef9c4690920a660929a8";
  quote.steps[0].items[0].data.from = address;
  quote.steps[0].items[0].data.data = encodeFunctionData({ abi: ERC20_DEPOSIT_ABI, functionName: "depositErc20", args: [address, BRIDGE_INPUT_CURRENCIES[5042].address, BigInt(input.amount), ARC_OUTBOUND_ORDER_ID] });
  quote.steps[0].items[0].check.endpoint = `/intents/status/v3?requestId=${quote.steps[0].requestId}`;
  quote.details.sender = address;
  quote.details.recipient = address;
  quote.details.currencyOut.amount = order.output.payments[0].expectedAmount;
  quote.details.currencyOut.minimumAmount = order.output.payments[0].minimumAmount;
  quote.details.totalImpact.percent = "-0.36";
  quote.fees.relayer.amount = "54943";
  quote.fees.gas.amount = "3294270000000000";
  addApprovalFixture(quote, input);
  return { input, quote };
}

// Independent unsigned Base USDC6→Arc USDC18 capture. Never executed.
export const BASE_USDC_FIXTURE_NOW = 1790149219000;
export const BASE_USDC_ORDER_ID = "0xa920a0c66c66329f3391358ac14496a8b2a576f1072abb0df4279a80f15080c7";
export function relayBaseUsdcFixture() {
  const { input, quote } = relayRouteFixture(8453, 5042, "USDC", "USDC");
  const address = "0x1111111111111111111111111111111111111111";
  input.address = address;
  const order = quote.protocol.v2.orderData;
  order.salt = "0x95de789cfc639ead6fae81c33d5b3e269d76b825a6df03b1abd9f1d6e4c1c56d";
  order.output.deadline = 1790149319;
  order.output.payments[0] = { recipient: address, currency: zeroAddress, minimumAmount: "24814370670000000000", expectedAmount: "24939066000000000000" };
  for (const refund of order.inputs[0].refunds) { refund.recipient = address; refund.deadline = order.output.deadline; }
  quote.protocol.v2.orderId = BASE_USDC_ORDER_ID;
  quote.steps[0].requestId = "0x17895445192847f7ef9504f2228cf0fcf6c2c6aa4b11d659cd3ea1667e7cb439";
  quote.steps[0].items[0].data.from = address;
  quote.steps[0].items[0].data.data = encodeFunctionData({ abi: ERC20_DEPOSIT_ABI, functionName: "depositErc20", args: [address, bridgeCurrency(8453, "USDC", "input").address, BigInt(input.amount), BASE_USDC_ORDER_ID] });
  quote.steps[0].items[0].check.endpoint = `/intents/status/v3?requestId=${quote.steps[0].requestId}`;
  quote.details.sender = address;
  quote.details.recipient = address;
  quote.details.currencyOut.amount = order.output.payments[0].expectedAmount;
  quote.details.currencyOut.minimumAmount = order.output.payments[0].minimumAmount;
  quote.details.totalImpact.percent = "-0.24";
  quote.fees.relayer.amount = "60934";
  quote.fees.gas.amount = "1868564641196";
  addApprovalFixture(quote, input);
  return { input, quote };
}
