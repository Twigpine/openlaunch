import "server-only";
import { formatEther, formatUnits, isAddress, parseUnits, toHex, type Hex } from "viem";
import { CCTP_FAST_FINALITY, CCTP_FORWARD_HOOK, CCTP_MAX_FEE_PERCENT, CCTP_TOKEN_MESSENGER, cctpAmountOut, cctpBurnData, cctpRoute, type CctpRoute } from "./cctp";
import { readBridgeJson } from "./read-json";
import { bridgeRpcUpstream } from "./rpc";
import { bridgeFeePercent, isBridgeChainId, type BridgeChainId, type BridgeQuote, type BridgeQuoteRequest, type BridgeStatus, type BridgeStatusResponse } from "./types";
import { BridgeApiError, QUOTE_TTL_MS, isRequestId } from "./validation";

/**
 * Circle's side of the bridge: a CCTP quote built entirely from pinned values plus Circle's published fee, and the
 * status of a burn read from Circle's attestation service. Circle never supplies calldata, an address or a recipient
 * here; its answers only set the fee (bounded below) and report progress. Any failure returns no Circle quote, so
 * Relay's quote or error stands exactly as before.
 */
const IRIS = "https://iris-api.circle.com";
const TIMEOUT_MS = 8_000;
type Fetcher = (url: string, init: RequestInit) => Promise<Response>;
type ObjectValue = Record<string, unknown>;

/** Circle burns at most 10,000,000 USDC per message (TokenMinterV2.burnLimitsPerMessage, read on all five networks). */
export const CCTP_MAX_BURN = 10_000_000_000_000n;
/** The fee tier never goes above 1% of the amount, nor the forwarding fee above $5, whatever the API says. */
const MAX_FEE_MICRO_BPS = 100_000_000n;
const MAX_FORWARD_FEE = 5_000_000n;
/** Gas a forwarded burn uses on the source network, for the estimate shown before the wallet is asked (~150k observed). */
export const CCTP_BURN_GAS = 220_000n;
/** Seconds to arrival: Fast attestation (about 8 s on the rollups, 20 s on Ethereum, 0.5 s on Arc) plus Circle's forward. */
const CCTP_SECONDS: Record<BridgeChainId, number> = { 8453: 25, 42161: 25, 10: 25, 1: 40, 5042: 15, 4663: 0 };

// Circle allows 40 requests a second per IP and blocks for five minutes past that. Every caller here shares one budget
// well under it, and answers are reused briefly, so many open panels can never get the server blocked.
export const CCTP_UPSTREAM_PER_MINUTE = 600;
const FEES_TTL_MS = 30_000;
const ALLOWANCE_TTL_MS = 15_000;
const STATUS_TTL_MS = 5_000;
type Cached<T> = { at: number; value: Promise<T> };
const caches = new WeakMap<Fetcher, Map<string, Cached<unknown>>>();
const budgets = new WeakMap<Fetcher, { at: number; used: number }>();

function ensure(condition: unknown, message = "Circle returned an unreadable answer."): asserts condition {
  if (!condition) throw new BridgeApiError(message, 502);
}
function object(value: unknown): ObjectValue {
  ensure(value && typeof value === "object" && !Array.isArray(value));
  return value as ObjectValue;
}
/** A JSON number as an exact decimal with at most `decimals` places: no exponents, no negatives. */
function decimal(value: unknown, decimals: number): bigint {
  ensure(typeof value === "number" && Number.isFinite(value) && value >= 0);
  const text = String(value);
  ensure(text.length <= 40 && (decimals > 0 ? new RegExp(`^\\d+(?:\\.\\d{1,${decimals}})?$`) : /^\d+$/).test(text));
  return parseUnits(text, decimals);
}

function spend(fetcher: Fetcher, at: number) {
  const budget = budgets.get(fetcher);
  if (budget && at - budget.at < 60_000 && at >= budget.at) {
    if (budget.used >= CCTP_UPSTREAM_PER_MINUTE) throw new BridgeApiError("Circle is busy. Please try again shortly.", 429);
    budget.used++;
  } else budgets.set(fetcher, { at, used: 1 });
}

/** One reused answer per key for `ttl`; a failure is never kept, so the next caller asks again. */
function cached<T>(fetcher: Fetcher, key: string, ttl: number, at: number, load: () => Promise<T>): Promise<T> {
  let cache = caches.get(fetcher);
  if (!cache) caches.set(fetcher, cache = new Map());
  const hit = cache.get(key) as Cached<T> | undefined;
  if (hit && at - hit.at < ttl && at >= hit.at) return hit.value;
  spend(fetcher, at);
  const value = load();
  if (cache.size >= 1_000) cache.clear();
  cache.set(key, { at, value });
  value.catch(() => { if (cache.get(key)?.value === value) cache.delete(key); });
  return value;
}

async function iris(path: string, fetcher: Fetcher, maxBytes: number): Promise<{ status: number; body: unknown }> {
  let response: Response;
  try {
    response = await fetcher(`${IRIS}${path}`, { method: "GET", cache: "no-store", redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS), headers: { Accept: "application/json" } });
  } catch { throw new BridgeApiError("Circle is unavailable right now.", 502); }
  if (response.status === 429) throw new BridgeApiError("Circle is busy. Please try again shortly.", 429);
  if (response.status === 404) { void response.body?.cancel().catch(() => {}); return { status: 404, body: null }; }
  if (!response.ok) { void response.body?.cancel().catch(() => {}); throw new BridgeApiError("Circle is unavailable right now.", 502); }
  return { status: response.status, body: await readBridgeJson(response.body, maxBytes, TIMEOUT_MS) };
}

export type CctpFee = { microBps: bigint; forwardFee: bigint };
/** Circle's fee for this route at the burn's finality: basis points (kept to six decimals) and the forwarding fee. */
export function parseCctpFees(value: unknown, finality: number): CctpFee {
  ensure(Array.isArray(value) && value.length > 0 && value.length <= 8);
  const entry = object(value.find((item) => object(item).finalityThreshold === finality));
  const microBps = decimal(entry.minimumFee, 6);
  // Circle recommends its middle tier or higher; the high tier costs fractions of a cent more and never under-pays a
  // forward when gas moves between the quote and the burn.
  const forwardFee = decimal(object(entry.forwardFee).high, 0);
  ensure(microBps <= MAX_FEE_MICRO_BPS && forwardFee <= MAX_FORWARD_FEE);
  return { microBps, forwardFee };
}

/** The whole fee a burn may take: Circle's fee on the amount, rounded up, plus the forward. */
export function cctpMaxFee(amount: bigint, fee: CctpFee): bigint {
  const protocol = (amount * fee.microBps + 10_000_000_000n - 1n) / 10_000_000_000n;
  return protocol + fee.forwardFee;
}

async function gasPrice(chainId: BridgeChainId, fetcher: Fetcher): Promise<bigint> {
  const upstream = bridgeRpcUpstream(chainId);
  ensure(upstream, "No RPC for this network.");
  const response = await fetcher(upstream, { method: "POST", cache: "no-store", redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS), headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_gasPrice", params: [] }) });
  ensure(response.ok);
  const result = object(await readBridgeJson(response.body, 4_096, TIMEOUT_MS)).result;
  ensure(typeof result === "string" && /^0x[0-9a-fA-F]{1,32}$/.test(result));
  const price = BigInt(result);
  ensure(price > 0n && price < 10n ** 15n);
  return price;
}

const randomId = (): Hex => toHex(crypto.getRandomValues(new Uint8Array(32)));

/**
 * A Circle quote for a USDC to USDC route between Circle networks, or null when Circle cannot carry it right now:
 * not a Circle route, above the per-burn limit, more than 5% in fees, or Fast Transfer capacity below the amount.
 * Throws only when Circle or the source RPC fails; the caller then keeps Relay's answer.
 */
export async function getCctpQuote(input: BridgeQuoteRequest, fetcher: Fetcher, now: () => number = Date.now): Promise<BridgeQuote | null> {
  const route = cctpRoute(input);
  const amount = BigInt(input.amount);
  if (!route || amount <= 0n || amount > CCTP_MAX_BURN) return null;
  const at = now();
  const [fees, allowance, price] = await Promise.all([
    cached(fetcher, `fees:${route.sourceDomain}:${route.destinationDomain}`, FEES_TTL_MS, at, () => iris(`/v2/burn/USDC/fees/${route.sourceDomain}/${route.destinationDomain}?forward=true`, fetcher, 8_192).then(({ status, body }) => { ensure(status === 200); return parseCctpFees(body, route.finality); })),
    // Fast Transfer draws on one global allowance; a Standard burn (Arc) does not.
    route.finality === CCTP_FAST_FINALITY ? cached(fetcher, "allowance", ALLOWANCE_TTL_MS, at, () => iris("/v2/fastBurn/USDC/allowance", fetcher, 1_024).then(({ status, body }) => { ensure(status === 200); return decimal(object(body).allowance, 6); })) : Promise.resolve(null),
    gasPrice(input.originChainId, fetcher),
  ]);
  if (allowance !== null && allowance < amount) return null;
  const maxFee = cctpMaxFee(amount, fees);
  if (maxFee <= 0n || maxFee >= amount || maxFee * 100n > amount * CCTP_MAX_FEE_PERCENT) return null;
  return cctpQuoteFrom(input, route, maxFee, price, at);
}

/** The quote itself, from pinned contracts and the bounded fee alone. */
export function cctpQuoteFrom(input: BridgeQuoteRequest, route: CctpRoute, maxFee: bigint, gasPriceWei: bigint, at: number): BridgeQuote {
  const amount = BigInt(input.amount);
  const amountOut = cctpAmountOut(amount, maxFee, route.outputDecimals).toString();
  const expiresAt = at + QUOTE_TTL_MS;
  return {
    ...input, provider: "cctp", requestId: randomId(), amountOut, minimumAmountOut: amountOut,
    relayFee: formatUnits(maxFee, 6), sourceGas: formatEther(gasPriceWei * CCTP_BURN_GAS),
    totalImpactPercent: `-${bridgeFeePercent(maxFee, amount)}`,
    approval: { token: route.burnToken, spender: CCTP_TOKEN_MESSENGER, amount: input.amount },
    timeEstimate: CCTP_SECONDS[input.originChainId], expiresAt, ttlMs: QUOTE_TTL_MS,
    transaction: { to: CCTP_TOKEN_MESSENGER, data: cctpBurnData(input, maxFee), value: "0", chainId: input.originChainId },
  };
}

export type CctpStatusRequest = { originChainId: BridgeChainId; destinationChainId: BridgeChainId; hash: Hex; address: Hex; amount: string };

/** The status route's Circle parameters, exactly: provider, origin, destination, hash, address and amount. */
export function parseCctpStatusRequest(params: URLSearchParams): CctpStatusRequest {
  const keys = ["provider", "origin", "destination", "hash", "address", "amount"];
  const invalid = () => new BridgeApiError("Invalid Circle transfer.", 400);
  if (params.size !== keys.length || !keys.every((key) => params.getAll(key).length === 1) || params.get("provider") !== "cctp") throw invalid();
  const originChainId = Number(params.get("origin"));
  const destinationChainId = Number(params.get("destination"));
  const hash = params.get("hash")!;
  const address = params.get("address")!;
  const amount = params.get("amount")!;
  if (!/^\d{1,6}$/.test(params.get("origin")!) || !/^\d{1,6}$/.test(params.get("destination")!) || !isBridgeChainId(originChainId) || !isBridgeChainId(destinationChainId)) throw invalid();
  if (!cctpRoute({ originChainId, destinationChainId, originAsset: "USDC", destinationAsset: "USDC" })) throw invalid();
  if (!isRequestId(hash) || !isAddress(address, { strict: false }) || /^0x0{40}$/i.test(address) || !/^[1-9]\d{0,77}$/.test(amount) || BigInt(amount) > CCTP_MAX_BURN) throw invalid();
  return { originChainId, destinationChainId, hash: hash.toLowerCase() as Hex, address: address.toLowerCase() as Hex, amount };
}

const lower = (value: unknown) => typeof value === "string" ? value.toLowerCase() : null;

/**
 * Circle's record of one burn, mapped onto the bridge's statuses. Not found yet is "waiting". A record must name this
 * wallet, amount, token, route and the forwarding hook before it counts; one that names anything else is an error,
 * never progress. Delivered means attested, and the mint forwarded with a destination transaction hash.
 */
export function parseCctpStatus(value: unknown, request: CctpStatusRequest): BridgeStatusResponse {
  const route = cctpRoute({ ...request, originAsset: "USDC", destinationAsset: "USDC" })!;
  const messages = object(value).messages;
  ensure(Array.isArray(messages) && messages.length >= 1 && messages.length <= 10);
  const matches = messages.map(object).filter((message) => {
    const decoded = message.decodedMessage;
    if (!decoded || typeof decoded !== "object") return false;
    const m = decoded as ObjectValue;
    const body = m.decodedMessageBody && typeof m.decodedMessageBody === "object" ? m.decodedMessageBody as ObjectValue : null;
    return !!body && m.sourceDomain === String(route.sourceDomain) && m.destinationDomain === String(route.destinationDomain)
      && lower(body.burnToken) === route.burnToken.toLowerCase() && lower(body.mintRecipient) === request.address && lower(body.messageSender) === request.address
      && body.amount === request.amount && lower(body.hookData) === CCTP_FORWARD_HOOK && m.minFinalityThreshold === String(route.finality);
  });
  // Before attestation Circle may not have decoded the burn yet; a lone undecoded record only says it is pending.
  if (matches.length === 0) {
    const pending = messages.length === 1 && !object(messages[0]).decodedMessage && ["pending_confirmations", "pending"].includes(String(object(messages[0]).status));
    ensure(pending, "Circle's record does not match this transfer.");
    return { status: "pending", inTxHashes: [request.hash], txHashes: [] };
  }
  ensure(matches.length === 1, "Circle's record does not match this transfer.");
  const message = matches[0];
  const delayed = typeof message.delayReason === "string" && message.delayReason.length > 0;
  let status: BridgeStatus;
  const txHashes: Hex[] = [];
  if (message.status === "complete") {
    const forwardHash = message.forwardTxHash;
    if (message.forwardState === "COMPLETE") {
      ensure(isRequestId(forwardHash));
      status = "success";
      txHashes.push(forwardHash);
    } else status = delayed || (message.forwardState !== undefined && message.forwardState !== null && message.forwardState !== "PENDING") ? "delayed" : "submitted";
  } else {
    ensure(["pending_confirmations", "pending"].includes(String(message.status)));
    status = delayed ? "delayed" : "pending";
  }
  return { status, inTxHashes: [request.hash], txHashes };
}

export async function getCctpStatus(request: CctpStatusRequest, fetcher: Fetcher = fetch, now: () => number = Date.now): Promise<BridgeStatusResponse> {
  const domain = cctpRoute({ ...request, originAsset: "USDC", destinationAsset: "USDC" })!.sourceDomain;
  const key = `status:${domain}:${request.hash}:${request.address}:${request.amount}:${request.destinationChainId}`;
  return cached(fetcher, key, STATUS_TTL_MS, now(), async () => {
    const { status, body } = await iris(`/v2/messages/${domain}?transactionHash=${request.hash}`, fetcher, 64_000);
    if (status === 404) return { status: "waiting", inTxHashes: [], txHashes: [] } satisfies BridgeStatusResponse;
    return parseCctpStatus(body, request);
  });
}
