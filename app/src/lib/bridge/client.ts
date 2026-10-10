import { BaseError, decodeEventLog, decodeFunctionData, encodeFunctionData, InsufficientFundsError, isAddress, parseUnits, type Address, type Hex } from "viem";
import { friendlyError } from "../errors";
import { bridgeCurrency, bridgeFeePercent, defaultBridgeAsset, isBridgeAssetSupported, isBridgeChainId, type BridgeAsset, type BridgeChainId, type BridgeQuote, type BridgeQuoteRejection, type BridgeQuoteRequest, type BridgeStatus, type BridgeStatusResponse } from "./types";

export type BridgePhase = "idle" | "quoting" | "review" | "switching" | "confirming" | "pending" | "success" | "refund" | "failure" | "uncertain";
export type TrackedBridgeTransfer = BridgeQuoteRequest & {
  requestId: Hex;
  sourceHash?: Hex;
  destinationHashes: Hex[];
  status: BridgeStatus | "uncertain";
  createdAt: number;
  depositData?: Hex;
  depositKind?: "erc20";
  failureReason?: "source-reverted";
};

// Relay's explicit native deposit contract. This is deliberately independent of
// the server adapter: a response cannot turn the wallet request into an approval.
export const RELAY_DEPOSITORY = "0x4cd00e387622c35bddb9b4c962c136462338bc31" as const;
export const NATIVE_DEPOSIT_ABI = [{ type: "function", name: "depositNative", stateMutability: "payable", inputs: [{ name: "depositor", type: "address" }, { name: "orderId", type: "bytes32" }], outputs: [] }] as const;
// Only the exact-amount overload is supported, never the full-allowance overload.
export const ERC20_DEPOSIT_ABI = [{ type: "function", name: "depositErc20", stateMutability: "nonpayable", inputs: [{ name: "depositor", type: "address" }, { name: "token", type: "address" }, { name: "amount", type: "uint256" }, { name: "orderId", type: "bytes32" }], outputs: [] }] as const;
// https://docs.relay.link/references/protocol/contracts/evm-depository
export const NATIVE_DEPOSIT_EVENT = [{ type: "event", name: "RelayNativeDeposit", inputs: [{ name: "from", type: "address", indexed: false }, { name: "amount", type: "uint256", indexed: false }, { name: "id", type: "bytes32", indexed: false }] }] as const;
export const ERC20_DEPOSIT_EVENT = [{ type: "event", name: "RelayErc20Deposit", inputs: [{ name: "from", type: "address", indexed: false }, { name: "token", type: "address", indexed: false }, { name: "amount", type: "uint256", indexed: false }, { name: "id", type: "bytes32", indexed: false }] }] as const;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const UINT = /^(0|[1-9]\d*)$/;
const MAX_UINT = (1n << 256n) - 1n;
const STATUSES: readonly BridgeStatus[] = ["waiting", "depositing", "pending", "submitted", "delayed", "success", "refund", "failure"];

export function isHash(value: unknown): value is Hex {
  return typeof value === "string" && HASH.test(value);
}

function isWei(value: unknown, positive = false): value is string {
  return typeof value === "string" && value.length <= 78 && UINT.test(value) && BigInt(value) <= MAX_UINT && (!positive || BigInt(value) > 0n);
}

/** Strict decimal parsing: never round sub-wei digits or accept exponent syntax. */
export function parseBridgeAmount(value: string, decimals: 6 | 18 = 18): bigint | null {
  const text = value.trim();
  if (text.length > 100 || !new RegExp(`^(?:\\d+(?:\\.\\d{0,${decimals}})?|\\.\\d{1,${decimals}})$`).test(text)) return null;
  try {
    const amount = parseUnits(text, decimals);
    return amount > 0n && amount <= MAX_UINT ? amount : null;
  } catch { return null; }
}

export function bridgeRequest(address: Address | undefined, originChainId: BridgeChainId, amount: string, destinationChainId: BridgeChainId, originAsset?: BridgeAsset, destinationAsset?: BridgeAsset): BridgeQuoteRequest | null {
  if (!address || !isAddress(address) || !isBridgeChainId(originChainId) || !isBridgeChainId(destinationChainId) || originChainId === destinationChainId || !isBridgeAssetSupported(originChainId, originAsset ?? defaultBridgeAsset(originChainId)) || !isBridgeAssetSupported(destinationChainId, destinationAsset ?? defaultBridgeAsset(destinationChainId))) return null;
  const units = parseBridgeAmount(amount, bridgeCurrency(originChainId, originAsset, "input").decimals);
  return units === null ? null : { address, originChainId, destinationChainId, amount: units.toString(), ...(originAsset ? { originAsset } : {}), ...(destinationAsset ? { destinationAsset } : {}) };
}

export type BridgeRouteInputs = { originChainId: BridgeChainId; destinationChainId: BridgeChainId; amount: string; originAsset?: BridgeAsset; destinationAsset?: BridgeAsset };
export type BridgeRouteChange = { side: "origin" | "destination"; chainId: BridgeChainId } | { side: "origin-asset" | "destination-asset"; asset: BridgeAsset } | { side: "reverse" };

/** Select/swap one distinct pair, clearing currency amounts when the source asset changes. */
export function changeBridgeRoute(current: BridgeRouteInputs, change: BridgeRouteChange): BridgeRouteInputs {
  let { originChainId, destinationChainId } = current;
  let originAsset = current.originAsset ?? defaultBridgeAsset(originChainId);
  let destinationAsset = current.destinationAsset ?? defaultBridgeAsset(destinationChainId);
  const previousOriginAsset = originAsset;
  const explicitAssets = current.originAsset !== undefined || current.destinationAsset !== undefined || change.side === "origin-asset" || change.side === "destination-asset";
  if (change.side === "reverse") {
    [originChainId, destinationChainId] = [destinationChainId, originChainId];
    [originAsset, destinationAsset] = [destinationAsset, originAsset];
  } else if (change.side === "origin-asset" || change.side === "destination-asset") {
    const chainId = change.side === "origin-asset" ? originChainId : destinationChainId;
    if (!isBridgeAssetSupported(chainId, change.asset)) return current;
    if (change.side === "origin-asset") originAsset = change.asset;
    else destinationAsset = change.asset;
  } else if ("chainId" in change) {
    if (!isBridgeChainId(change.chainId)) return current;
    if (change.side === "origin") {
      if (change.chainId === destinationChainId) { destinationChainId = originChainId; [originAsset, destinationAsset] = [destinationAsset, originAsset]; }
      originChainId = change.chainId;
    } else {
      if (change.chainId === originChainId) { originChainId = destinationChainId; [originAsset, destinationAsset] = [destinationAsset, originAsset]; }
      destinationChainId = change.chainId;
    }
  }
  if (!isBridgeAssetSupported(originChainId, originAsset)) originAsset = defaultBridgeAsset(originChainId);
  if (!isBridgeAssetSupported(destinationChainId, destinationAsset)) destinationAsset = defaultBridgeAsset(destinationChainId);
  const amount = previousOriginAsset === originAsset ? current.amount : "";
  return { originChainId, destinationChainId, amount, ...(explicitAssets ? { originAsset, destinationAsset } : {}) };
}

export function bridgeRequestKey(request: BridgeQuoteRequest | null): string {
  return request ? `${request.address.toLowerCase()}:${request.originChainId}:${request.originAsset ?? defaultBridgeAsset(request.originChainId)}:${request.destinationChainId}:${request.destinationAsset ?? defaultBridgeAsset(request.destinationChainId)}:${request.amount}` : "";
}

/** Arc's ERC-20 interface and native gas asset share one USDC balance. */
export function nativeSourceAmount(request: BridgeQuoteRequest): bigint {
  const currency = bridgeCurrency(request.originChainId, request.originAsset, "input");
  return request.originChainId === 5042 ? BigInt(request.amount) * 10n ** 12n : /^0x0{40}$/.test(currency.address) ? BigInt(request.amount) : 0n;
}

function validImpactPercent(value: unknown, lossLimit = 5n): boolean {
  if (typeof value !== "string" || value.length > 32 || !/^-?\d+(?:\.\d+)?$/.test(value)) return false;
  const negative = value.startsWith("-");
  const [whole, fractional = ""] = (negative ? value.slice(1) : value).split(".");
  const scaled = BigInt(whole + fractional);
  const scale = 10n ** BigInt(fractional.length);
  return scaled <= (negative ? lossLimit : 100n) * scale;
}

/** Rejections are display-only, request-bound and never usable as wallet quotes. */
export function parseBridgeQuoteRejection(value: unknown, request: BridgeQuoteRequest): BridgeQuoteRejection | null {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const rejected = value as BridgeQuoteRejection;
    const allowed = ["address", "originChainId", "destinationChainId", "originAsset", "destinationAsset", "amount", "reason", "relayFee", "relayFeePercent", "sourceGas", "totalImpactPercent"];
    if (Object.keys(value).some((key) => !allowed.includes(key)) || !isAddress(rejected.address ?? "") || !isBridgeChainId(rejected.originChainId) || !isBridgeChainId(rejected.destinationChainId) || rejected.originChainId === rejected.destinationChainId || !isWei(rejected.amount, true)) return null;
    if ((rejected.originAsset !== undefined && !isBridgeAssetSupported(rejected.originChainId, rejected.originAsset)) || (rejected.destinationAsset !== undefined && !isBridgeAssetSupported(rejected.destinationChainId, rejected.destinationAsset)) || bridgeRequestKey(rejected) !== bridgeRequestKey(request)) return null;
    const decimals = bridgeCurrency(rejected.originChainId, rejected.originAsset, "input").decimals;
    for (const [fee, precision] of [[rejected.relayFee, decimals], [rejected.sourceGas, 18]] as const) {
      if (typeof fee !== "string" || fee.length > 100 || !new RegExp(`^\\d+(?:\\.\\d{1,${precision}})?$`).test(fee) || parseUnits(fee, precision) > MAX_UINT) return null;
    }
    const fee = parseUnits(rejected.relayFee, decimals);
    const amount = BigInt(rejected.amount);
    if (fee >= amount || rejected.relayFeePercent !== bridgeFeePercent(fee, amount) || !validImpactPercent(rejected.totalImpactPercent, 100n)) return null;
    const reason = fee * 100n > amount * 5n ? "relay-fee" : !validImpactPercent(rejected.totalImpactPercent) ? "total-impact" : null;
    if (reason === null || rejected.reason !== reason) return null;
    // Copy only the display schema, never retain untrusted object references.
    return { address: rejected.address, originChainId: rejected.originChainId, destinationChainId: rejected.destinationChainId, ...(rejected.originAsset === undefined ? {} : { originAsset: rejected.originAsset }), ...(rejected.destinationAsset === undefined ? {} : { destinationAsset: rejected.destinationAsset }), amount: rejected.amount, reason, relayFee: rejected.relayFee, relayFeePercent: rejected.relayFeePercent, sourceGas: rejected.sourceGas, totalImpactPercent: rejected.totalImpactPercent };
  } catch { return null; }
}

export function validateBridgeQuote(value: unknown, request: BridgeQuoteRequest, now: number): BridgeQuote {
  if (!value || typeof value !== "object") throw new Error("The bridge returned an invalid quote. Request a new quote.");
  const quote = value as BridgeQuote;
  if (!isAddress(quote.address ?? "") || !isBridgeChainId(quote.originChainId) || !isBridgeChainId(quote.destinationChainId) || !isBridgeAssetSupported(quote.originChainId, quote.originAsset ?? defaultBridgeAsset(quote.originChainId)) || !isBridgeAssetSupported(quote.destinationChainId, quote.destinationAsset ?? defaultBridgeAsset(quote.destinationChainId)) || bridgeRequestKey(quote) !== bridgeRequestKey(request) || quote.destinationChainId === quote.originChainId) {
    throw new Error("The quote no longer matches this wallet, amount, or route. Review a new quote.");
  }
  if (!isHash(quote.requestId) || !isWei(quote.amount, true) || !isWei(quote.amountOut, true) || !isWei(quote.minimumAmountOut, true) || BigInt(quote.minimumAmountOut) > BigInt(quote.amountOut)) {
    throw new Error("The bridge returned invalid transfer amounts.");
  }
  if (!Number.isFinite(quote.expiresAt) || quote.expiresAt <= now || quote.expiresAt > now + 120_000) throw new Error("This quote expired. Request a new quote and review it before continuing.");
  const inputCurrency = bridgeCurrency(request.originChainId, request.originAsset, "input");
  const inputDecimals = inputCurrency.decimals;
  if (!Number.isFinite(quote.timeEstimate) || quote.timeEstimate < 0 || ![[quote.relayFee, inputDecimals], [quote.sourceGas, 18]].every(([fee, decimals]) => typeof fee === "string" && new RegExp(`^\\d+(?:\\.\\d{1,${decimals}})?$`).test(fee) && fee.length <= 100 && parseUnits(fee, Number(decimals)) <= MAX_UINT)) {
    throw new Error("The bridge returned invalid fee details.");
  }
  if (parseUnits(quote.relayFee, inputDecimals) * 100n > BigInt(quote.amount) * 5n) {
    throw new Error("The relay fee exceeds the 5% limit. Try a different amount.");
  }
  if (!validImpactPercent(quote.totalImpactPercent)) {
    throw new Error("The quote's total impact is unavailable or exceeds the 5% loss limit. Try a different amount.");
  }
  const tx = quote.transaction;
  const erc20 = !/^0x0{40}$/.test(inputCurrency.address);
  if (erc20 && BigInt(request.amount) === MAX_UINT) throw new Error("Unlimited USDC approvals are not supported. Enter an exact transfer amount.");
  if (erc20 ? !quote.approval || quote.approval.token?.toLowerCase() !== inputCurrency.address.toLowerCase() || quote.approval.spender?.toLowerCase() !== RELAY_DEPOSITORY || quote.approval.amount !== request.amount : quote.approval !== undefined) {
    throw new Error("The approval did not match the exact USDC deposit on this network.");
  }
  if (!tx || tx.chainId !== request.originChainId || typeof tx.to !== "string" || tx.to.toLowerCase() !== RELAY_DEPOSITORY || tx.value !== (erc20 ? "0" : request.amount) || typeof tx.data !== "string" || !new RegExp(`^0x[0-9a-fA-F]{${erc20 ? 264 : 136}}$`).test(tx.data)) {
    throw new Error("The bridge transaction did not pass the deposit safety check.");
  }
  try {
    const orderId = erc20 ? decodeFunctionData({ abi: ERC20_DEPOSIT_ABI, data: tx.data }).args[3] : decodeFunctionData({ abi: NATIVE_DEPOSIT_ABI, data: tx.data }).args[1];
    const canonical = erc20
      ? encodeFunctionData({ abi: ERC20_DEPOSIT_ABI, functionName: "depositErc20", args: [request.address, inputCurrency.address, BigInt(request.amount), orderId] })
      : encodeFunctionData({ abi: NATIVE_DEPOSIT_ABI, functionName: "depositNative", args: [request.address, orderId] });
    if (/^0x0+$/.test(orderId) || canonical.toLowerCase() !== tx.data.toLowerCase()) throw new Error("binding");
  } catch { throw new Error("The bridge transaction did not match this wallet's exact deposit."); }
  return quote;
}

/**
 * The server states how long a quote stays valid; only this device's clock
 * decides when that runs out. Anchoring on the request time also absorbs the
 * round trip, so a skewed phone clock cannot expire (or extend) a fresh quote.
 */
export function anchorQuoteExpiry(value: unknown, requestedAt: number): unknown {
  if (!value || typeof value !== "object") return value;
  const { ttlMs } = value as { ttlMs?: unknown };
  if (typeof ttlMs !== "number" || !Number.isFinite(ttlMs) || ttlMs < 0 || ttlMs > 120_000) throw new Error("The bridge returned an invalid quote validity. Request a new quote.");
  return { ...value, expiresAt: requestedAt + ttlMs };
}

/** AbortSignal.any/timeout are missing in older in-app wallet browsers; link the signals by hand. */
export function linkedTimeoutSignal(parent: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException("The request timed out.", "TimeoutError")), timeoutMs);
  controller.signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
  if (parent?.aborted) controller.abort(parent.reason);
  else if (parent) {
    // Detach once this signal is done (a timeout included), so a long-lived parent does not collect a listener per request.
    const onParentAbort = () => controller.abort(parent.reason);
    parent.addEventListener("abort", onParentAbort, { once: true });
    controller.signal.addEventListener("abort", () => parent.removeEventListener("abort", onParentAbort), { once: true });
  }
  return controller.signal;
}

/**
 * The provider hash to verify and adopt as this transfer's source hash: any
 * reported hash when the wallet returned none, or a different hash when the
 * wallet's own was replaced (speed-up/cancel) and is not mined. A mined or
 * still-reported wallet hash is never swapped; a mismatch then keeps retrying.
 */
export function replacementSourceHash(transfer: TrackedBridgeTransfer, status: BridgeStatusResponse, walletHashUnmined: boolean): Hex | null {
  const known = transfer.sourceHash?.toLowerCase();
  const candidate = status.inTxHashes.find((hash) => hash.toLowerCase() !== known) ?? null;
  if (!candidate || !transfer.sourceHash) return candidate;
  const knownReported = status.inTxHashes.some((hash) => hash.toLowerCase() === known);
  return walletHashUnmined && !knownReported ? candidate : null;
}

export type BridgeActivity = { key: string; phase: "idle" | "quoting" | "switching" | "confirming" };
/** An aborted quote never runs its own idle reset; wallet changes clear it here and leave wallet prompts alone. */
export function activityAfterWalletChange(activity: BridgeActivity): BridgeActivity {
  return activity.phase === "quoting" ? { key: "", phase: "idle" } : activity;
}

export const DISCARD_AFTER_MS = 15 * 60_000;
export type ProviderObservation = { requestId: Hex; status: BridgeStatusResponse; sourceMined: boolean; observedAt: number };

/**
 * Bounded escape hatch for a deposit that never happened: the provider still
 * reports "waiting" with no deposit, no wallet hash is mined, and the order
 * deadline (about a minute) is long past. A record with any on-chain evidence,
 * or a stale observation, keeps blocking until it settles.
 */
export function transferCanDiscard(transfer: TrackedBridgeTransfer | null, observation: ProviderObservation | null, now: number): boolean {
  if (!transfer || transferIsTerminal(transfer) || !observation || observation.requestId !== transfer.requestId) return false;
  if (observation.status.status !== "waiting" || observation.status.inTxHashes.length > 0 || observation.status.txHashes.length > 0 || observation.sourceMined) return false;
  return now - transfer.createdAt >= DISCARD_AFTER_MS && now - observation.observedAt <= 60_000 && now >= observation.observedAt;
}

export function validateBridgeStatus(value: unknown): BridgeStatusResponse {
  if (!value || typeof value !== "object") throw new Error("Transfer status is temporarily unavailable.");
  const status = value as BridgeStatusResponse;
  if (!STATUSES.includes(status.status) || !Array.isArray(status.inTxHashes) || !Array.isArray(status.txHashes) || status.inTxHashes.length > 50 || status.txHashes.length > 50 || ![...status.inTxHashes, ...status.txHashes].every(isHash)) {
    throw new Error("Transfer status is temporarily unavailable.");
  }
  return status;
}

export function transferIsTerminal(transfer: TrackedBridgeTransfer | null): boolean {
  return !!transfer && ["success", "refund", "failure"].includes(transfer.status);
}

export function transferPhase(transfer: TrackedBridgeTransfer): BridgePhase {
  return transferIsTerminal(transfer) ? transfer.status as "success" | "refund" | "failure" : transfer.status === "uncertain" ? "uncertain" : "pending";
}

export function mergeBridgeStatus(transfer: TrackedBridgeTransfer, status: BridgeStatusResponse): TrackedBridgeTransfer {
  // A delayed response must not roll an already settled transfer backwards.
  if (transferIsTerminal(transfer)) return transfer;
  const sourceHash = transfer.sourceHash;
  const matchingHash = sourceHash && status.inTxHashes.some((hash) => hash.toLowerCase() === sourceHash.toLowerCase());
  if ((["success", "refund", "failure"].includes(status.status) && !matchingHash) || (sourceHash && status.inTxHashes.length > 0 && !matchingHash)) {
    throw new Error("Relay's update has not yet been matched to your source transaction. Tracking will retry.");
  }
  return {
    ...transfer,
    sourceHash,
    destinationHashes: matchingHash ? [...new Set([...transfer.destinationHashes, ...status.txHashes])] : transfer.destinationHashes,
    // "waiting" alone cannot prove whether a wallet broadcast an unknown send.
    status: transfer.status === "uncertain" && !sourceHash ? "uncertain" : status.status,
  };
}

/** Recovery without a wallet-returned hash must bind the provider's hash on-chain. */
export function isMatchingSourceDeposit(transfer: TrackedBridgeTransfer, transaction: { from: Address; to: Address | null; input: Hex; value: bigint }): boolean {
  return !!transfer.depositData && transaction.from.toLowerCase() === transfer.address.toLowerCase() && transaction.to?.toLowerCase() === RELAY_DEPOSITORY && transaction.value.toString() === (transfer.depositKind === "erc20" ? "0" : transfer.amount) && transaction.input.toLowerCase() === transfer.depositData.toLowerCase();
}

/** Smart wallets may deposit through an internal call rather than the outer tx. */
export function hasMatchingDepositEvent(transfer: TrackedBridgeTransfer, receipt: { status: "success" | "reverted"; logs: readonly { address: Address; data: Hex; topics: readonly Hex[] }[] }): boolean {
  if (!transfer.depositData || receipt.status !== "success") return false;
  try {
    const erc20 = transfer.depositKind === "erc20";
    const orderId = erc20 ? decodeFunctionData({ abi: ERC20_DEPOSIT_ABI, data: transfer.depositData }).args[3] : decodeFunctionData({ abi: NATIVE_DEPOSIT_ABI, data: transfer.depositData }).args[1];
    return receipt.logs.some((log) => {
      if (log.address.toLowerCase() !== RELAY_DEPOSITORY || log.topics.length !== 1 || !new RegExp(`^0x[0-9a-fA-F]{${erc20 ? 256 : 192}}$`).test(log.data)) return false;
      try {
        const event = decodeEventLog({ abi: erc20 ? ERC20_DEPOSIT_EVENT : NATIVE_DEPOSIT_EVENT, data: log.data, topics: [log.topics[0]], strict: true });
        if (!event.args) return false;
        if (erc20 && (!("token" in event.args) || event.args.token.toLowerCase() !== bridgeCurrency(transfer.originChainId, transfer.originAsset, "input").address.toLowerCase())) return false;
        return event.args.from.toLowerCase() === transfer.address.toLowerCase() && event.args.amount.toString() === transfer.amount && event.args.id.toLowerCase() === orderId.toLowerCase();
      } catch { return false; }
    });
  } catch { return false; }
}

/** An estimate is only a preflight, with room for changing gas prices. */
export function bridgeGasBudget(value: bigint, balance: bigint, gasEstimate: bigint, maxFeePerGas: bigint, additionalFeeReserve = 0n, symbol = "ETH"): { gas: bigint; reserve: bigint } {
  if (value < 0n || balance < 0n || gasEstimate <= 0n || maxFeePerGas <= 0n || additionalFeeReserve < 0n) throw new Error("Could not estimate network fees. Try again.");
  const gas = (gasEstimate * 120n + 99n) / 100n;
  const reserve = gas * maxFeePerGas + (additionalFeeReserve * 120n + 99n) / 100n;
  if (balance < value + reserve) throw new Error(`Not enough ${symbol} for this amount and network gas. Reduce the amount and request a new quote.`);
  return { gas, reserve };
}

const GENERIC_RPC_MESSAGE = /^(An unknown RPC error occurred\.|HTTP request failed\.|An internal error was received\.|The request took too long to respond\.)$/;

/**
 * Wallet and RPC errors go through the app's shared copy. viem's generic
 * wrappers hide the provider's own text in `details`; surface it so a user
 * (and support) can see "Unrecognized chain ID" rather than "unknown error".
 */
export function bridgeErrorMessage(error: unknown, fallback: string, gasSymbol = "ETH"): string {
  if (error instanceof BaseError) {
    const short = error.shortMessage || error.message;
    const details = typeof error.details === "string" ? error.details.replace(/\s+/g, " ").trim() : "";
    if (error.walk((e) => e instanceof InsufficientFundsError) || /insufficient funds/i.test(`${short} ${details}`)) return `Not enough ${gasSymbol} for this transaction plus gas.`;
    if (/unrecognized chain|wallet_addEthereumChain|chain .* not (?:been )?added/i.test(details)) return "Your wallet doesn't have this network yet. Add it in the wallet, then try again.";
    if (/rate limit|too many requests/i.test(`${short} ${details}`)) return "The network is busy right now. Try again in a moment.";
    const message = friendlyError(error);
    if (!GENERIC_RPC_MESSAGE.test(message) || !details) return message;
    return `${message} ${details.length > 160 ? `${details.slice(0, 160)}…` : details}`;
  }
  return error instanceof Error ? error.message : fallback;
}

export function isWalletRejection(error: unknown): boolean {
  let current = error;
  const seen = new Set<unknown>();
  for (let i = 0; current && typeof current === "object" && i < 8 && !seen.has(current); i++) {
    seen.add(current);
    const node = current as { code?: unknown; cause?: unknown };
    if (node.code === 4001 || node.code === "ACTION_REJECTED") return true;
    current = node.cause;
  }
  return false;
}

export type PreparedBridgeGas = { gas: bigint; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint };
export type DepositDependencies = {
  now: () => number;
  currentRequest: () => BridgeQuoteRequest | null;
  readWallet: () => Promise<{ address?: Address; chainId?: number }>;
  switchChain: (chainId: BridgeChainId) => Promise<unknown>;
  prepare: (quote: BridgeQuote) => Promise<PreparedBridgeGas>;
  readTransfer: (address: Address) => TrackedBridgeTransfer | null;
  saveTransfer: (transfer: TrackedBridgeTransfer) => void;
  removeTransfer: (address: Address) => void;
  send: (quote: BridgeQuote, gas: PreparedBridgeGas) => Promise<Hex>;
  phase: (phase: "switching" | "confirming") => void;
};
export type DepositResult = { kind: "sent"; transfer: TrackedBridgeTransfer } | { kind: "rejected" } | { kind: "uncertain"; transfer: TrackedBridgeTransfer };

/** The actual send workflow, dependency-injected so tests exercise its async boundaries. */
export async function submitBridgeDeposit(quote: BridgeQuote, deps: DepositDependencies): Promise<DepositResult> {
  const request = deps.currentRequest();
  if (!request) throw new Error("Reconnect this wallet and review a new quote.");
  const checkRequest = () => {
    if (bridgeRequestKey(deps.currentRequest()) !== bridgeRequestKey(request)) throw new Error("The wallet or bridge inputs changed. Review a new quote.");
    validateBridgeQuote(quote, request, deps.now());
  };
  checkRequest();
  const existing = deps.readTransfer(request.address);
  if (existing && !transferIsTerminal(existing)) throw new Error("A transfer is already being tracked for this wallet. Check its status before starting another.");
  let wallet = await deps.readWallet();
  if (wallet.address?.toLowerCase() !== request.address.toLowerCase()) throw new Error("The connected wallet changed. Review a new quote.");
  if (wallet.chainId !== request.originChainId) {
    deps.phase("switching");
    await deps.switchChain(request.originChainId);
  }
  checkRequest();
  const gas = await deps.prepare(quote);
  wallet = await deps.readWallet();
  checkRequest();
  if (wallet.address?.toLowerCase() !== request.address.toLowerCase() || wallet.chainId !== request.originChainId) throw new Error("Your wallet account or network changed. Review a new quote.");
  const latest = deps.readTransfer(request.address);
  if (latest && !transferIsTerminal(latest)) throw new Error("Another transfer is now being tracked for this wallet. Check its status before continuing.");
  const tracked: TrackedBridgeTransfer = { ...request, requestId: quote.requestId, destinationHashes: [], status: "uncertain", createdAt: deps.now(), depositData: quote.transaction.data, ...(quote.approval ? { depositKind: "erc20" as const } : {}) };
  // This write must succeed before invoking the wallet. A reload during its
  // prompt resumes read-only tracking by requestId, even without a tx hash.
  try { deps.saveTransfer(tracked); } catch {
    // No wallet call happened. Clear a partially written record when storage
    // permits it; never continue signing without durable recovery details.
    try { deps.removeTransfer(request.address); } catch { /* retain recovery warning */ }
    throw new Error("Could not save bridge recovery details. No transaction was requested. Enable site storage before trying again.");
  }
  deps.phase("confirming");
  let hash: Hex;
  try {
    hash = await deps.send(quote, gas);
    if (!isHash(hash)) throw new Error("Wallet returned no transaction hash");
  } catch (error) {
    if (isWalletRejection(error)) {
      const current = deps.readTransfer(request.address);
      if (current?.requestId === tracked.requestId) deps.removeTransfer(request.address);
      return { kind: "rejected" };
    }
    // An RPC timeout is not proof of failure. Never automatically resubmit.
    return { kind: "uncertain", transfer: tracked };
  }
  const sent: TrackedBridgeTransfer = { ...tracked, sourceHash: hash, status: "pending" };
  // If this second write fails, the durable pre-send record still prevents a
  // duplicate and lets Relay recover the hash. The store retains the hash in memory.
  try { deps.saveTransfer(sent); } catch { /* recovered using the first write */ }
  return { kind: "sent", transfer: sent };
}

export function parseStoredTransfer(raw: string, address: Address): TrackedBridgeTransfer {
  const entry = JSON.parse(raw) as TrackedBridgeTransfer & { version?: unknown };
  const erc20 = entry?.depositKind === "erc20";
  const assetsValid = isBridgeChainId(entry?.originChainId) && isBridgeChainId(entry?.destinationChainId) && isBridgeAssetSupported(entry.originChainId, entry.originAsset) && isBridgeAssetSupported(entry.destinationChainId, entry.destinationAsset);
  const legacyAssets = entry?.originAsset === undefined && entry?.destinationAsset === undefined;
  const validVersion = (entry?.version === 1 && legacyAssets && entry.depositKind === undefined) || (entry?.version === 2 && legacyAssets && erc20 && entry.originChainId === 5042 && typeof entry.depositData === "string") || (entry?.version === 3 && assetsValid && typeof entry.depositData === "string" && (entry.depositKind === undefined || erc20) && erc20 === !/^0x0{40}$/.test(bridgeCurrency(entry.originChainId, entry.originAsset, "input").address));
  if (!validVersion || typeof entry.address !== "string" || entry.address.toLowerCase() !== address.toLowerCase() || !isAddress(entry.address) || !isBridgeChainId(entry.originChainId) || !isBridgeChainId(entry.destinationChainId) || entry.destinationChainId === entry.originChainId || !isHash(entry.requestId) || !isWei(entry.amount, true) || !Number.isFinite(entry.createdAt) || entry.createdAt <= 0 || (entry.sourceHash !== undefined && !isHash(entry.sourceHash)) || !Array.isArray(entry.destinationHashes) || entry.destinationHashes.length > 50 || !entry.destinationHashes.every(isHash) || (entry.status !== "uncertain" && !STATUSES.includes(entry.status)) || (entry.depositData !== undefined && !new RegExp(`^0x[0-9a-fA-F]{${erc20 ? 264 : 136}}$`).test(entry.depositData)) || (entry.failureReason !== undefined && entry.failureReason !== "source-reverted")) {
    throw new Error("Saved bridge recovery data could not be read. Check your transfer on Relay before trying again.");
  }
  if (erc20) {
    try {
      const order = decodeFunctionData({ abi: ERC20_DEPOSIT_ABI, data: entry.depositData! }).args[3];
      const canonical = encodeFunctionData({ abi: ERC20_DEPOSIT_ABI, functionName: "depositErc20", args: [entry.address, bridgeCurrency(entry.originChainId, entry.originAsset, "input").address, BigInt(entry.amount), order] });
      if (/^0x0+$/.test(order) || canonical.toLowerCase() !== entry.depositData!.toLowerCase()) throw new Error("binding");
    } catch { throw new Error("Saved USDC deposit details could not be verified. Check Relay before trying again."); }
  } else if (entry.depositData) {
    try {
      const order = decodeFunctionData({ abi: NATIVE_DEPOSIT_ABI, data: entry.depositData }).args[1];
      const canonical = encodeFunctionData({ abi: NATIVE_DEPOSIT_ABI, functionName: "depositNative", args: [entry.address, order] });
      if (/^0x0+$/.test(order) || canonical.toLowerCase() !== entry.depositData.toLowerCase()) throw new Error("binding");
    } catch { throw new Error("Saved native deposit details could not be verified. Check Relay before trying again."); }
  }
  return { address: entry.address, originChainId: entry.originChainId, destinationChainId: entry.destinationChainId, ...(entry.originAsset ? { originAsset: entry.originAsset } : {}), ...(entry.destinationAsset ? { destinationAsset: entry.destinationAsset } : {}), amount: entry.amount, requestId: entry.requestId, sourceHash: entry.sourceHash, destinationHashes: entry.destinationHashes, status: entry.status, createdAt: entry.createdAt, ...(entry.depositData ? { depositData: entry.depositData } : {}), ...(erc20 ? { depositKind: "erc20" as const } : {}), ...(entry.failureReason ? { failureReason: entry.failureReason } : {}) };
}

export function serializeTransfer(transfer: TrackedBridgeTransfer): string {
  const explicitAssets = transfer.originAsset !== undefined || transfer.destinationAsset !== undefined;
  return JSON.stringify({ ...transfer, ...(explicitAssets ? { originAsset: transfer.originAsset ?? defaultBridgeAsset(transfer.originChainId), destinationAsset: transfer.destinationAsset ?? defaultBridgeAsset(transfer.destinationChainId) } : {}), version: explicitAssets ? 3 : transfer.depositKind === "erc20" ? 2 : 1 });
}
