import "server-only";
import { BridgeApiError, isRequestId, parseBridgeRequest, parseRelayStatus, validateRelayChains, validateRelayQuote } from "./validation";
import { bridgeCurrency, type BridgeQuote, type BridgeQuoteRequest, type BridgeStatusResponse } from "./types";
import { parseRelayHistory, type BridgeHistoryResponse } from "./history";
import { readBridgeJson } from "./read-json";
import { cctpRoute } from "./cctp";
import { getCctpQuote } from "./cctp-server";

export { readBridgeJson };

const RELAY_API = "https://api.relay.link";
const UPSTREAM_TIMEOUT_MS = 12_000;
export const BRIDGE_PRIVATE_HEADERS = { "Cache-Control": "private, no-store, max-age=0", "CDN-Cache-Control": "no-store" };
type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

async function relayJson(path: string, init: RequestInit, maxBytes: number, fetcher: Fetcher): Promise<unknown> {
  try {
    const response = await fetcher(`${RELAY_API}${path}`, {
      ...init, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      headers: { "Content-Type": "application/json", ...(process.env.RELAY_API_KEY ? { "x-api-key": process.env.RELAY_API_KEY } : {}) },
    });
    if (response.status === 429) throw new BridgeApiError("The bridge is busy. Please try again shortly.", 429);
    if (response.status === 404) throw new BridgeApiError("Bridge status is not available yet. Please try again.", 404);
    if (!response.ok) throw new BridgeApiError("No bridge quote is available for this amount. Please try again.", response.status >= 500 ? 503 : 422);
    return await readBridgeJson(response.body, maxBytes, UPSTREAM_TIMEOUT_MS);
  } catch (error) {
    if (error instanceof BridgeApiError && [429, 404, 422, 503].includes(error.status)) throw error;
    throw new BridgeApiError("The bridge service is unavailable. Please try again.", 502);
  }
}

// The chain catalogue changes rarely and is large. One copy per fetcher for a
// minute serves concurrent quotes; a failed or unverifiable copy is dropped so
// the next quote refetches rather than repeating the same rejection.
export const RELAY_CHAINS_TTL_MS = 60_000;
const chainsCache = new WeakMap<Fetcher, { at: number; value: Promise<unknown> }>();
function relayChains(fetcher: Fetcher, now: number): Promise<unknown> {
  const cached = chainsCache.get(fetcher);
  if (cached && now - cached.at < RELAY_CHAINS_TTL_MS && now >= cached.at) return cached.value;
  const value = relayJson("/chains", { method: "GET" }, 2_000_000, fetcher);
  chainsCache.set(fetcher, { at: now, value });
  value.catch(() => forgetChains(fetcher, value));
  return value;
}
function forgetChains(fetcher: Fetcher, value: Promise<unknown>) {
  if (chainsCache.get(fetcher)?.value === value) chainsCache.delete(fetcher);
}

/**
 * The better of Relay's and Circle's quotes. A USDC to USDC route between Circle networks also asks Circle; its quote
 * wins only when it delivers strictly more. Circle failing, or declining the route, changes nothing: Relay's quote or
 * error stands. `circle` reaches Circle and the source RPC; it is the real network only when Relay's fetcher is, so a
 * test that fakes Relay never reaches Circle by accident.
 */
export async function getBridgeQuote(request: BridgeQuoteRequest, fetcher: Fetcher = fetch, now: () => number = Date.now, circle: Fetcher | null = fetcher === fetch ? fetch : null): Promise<BridgeQuote> {
  const input = parseBridgeRequest(request);
  if (!circle || !cctpRoute(input)) return getRelayQuote(input, fetcher, now);
  const [relay, cctp] = await Promise.allSettled([getRelayQuote(input, fetcher, now), getCctpQuote(input, circle, now)]);
  const viaCircle = cctp.status === "fulfilled" ? cctp.value : null;
  if (relay.status === "rejected") {
    if (viaCircle) return viaCircle;
    throw relay.reason;
  }
  return viaCircle && BigInt(viaCircle.amountOut) > BigInt(relay.value.amountOut) ? viaCircle : relay.value;
}

async function getRelayQuote(input: BridgeQuoteRequest, fetcher: Fetcher, now: () => number): Promise<BridgeQuote> {
  const chainsPromise = relayChains(fetcher, now());
  const [chains, quote] = await Promise.all([
    chainsPromise,
    relayJson("/quote/v2", { method: "POST", body: JSON.stringify({
      user: input.address, recipient: input.address, refundTo: input.address, originChainId: input.originChainId,
      destinationChainId: input.destinationChainId, originCurrency: bridgeCurrency(input.originChainId, input.originAsset, "input").address,
      destinationCurrency: bridgeCurrency(input.destinationChainId, input.destinationAsset, "output").address, amount: input.amount, tradeType: "EXACT_INPUT",
      explicitDeposit: true, includeProtocolData: true, slippageTolerance: "50",
    }) }, 128_000, fetcher),
  ]);
  try {
    let metadata;
    try { metadata = validateRelayChains(chains, input); }
    catch (error) { forgetChains(fetcher, chainsPromise); throw error; }
    return validateRelayQuote(quote, input, metadata, now());
  } catch (error) {
    if (error instanceof BridgeApiError && error.status === 422) throw error;
    throw new BridgeApiError("The bridge returned an unverifiable quote. Please try again.");
  }
}

export async function getBridgeStatus(requestId: string, fetcher: Fetcher = fetch): Promise<BridgeStatusResponse> {
  if (!isRequestId(requestId)) throw new BridgeApiError("Invalid bridge request ID.", 400);
  const response = await relayJson(`/intents/status/v3?requestId=${encodeURIComponent(requestId)}`, { method: "GET" }, 32_000, fetcher);
  try { return parseRelayStatus(response); }
  catch { throw new BridgeApiError("The bridge returned an unreadable status. Please try again."); }
}

// Wallet history comes from GET /requests/v3, which only answers with an API key (Relay retires the keyless v2 on
// 2026-11-24). Without RELAY_API_KEY the route says so and the board shows what this browser saved. With a key, one
// wallet's list is reused for a short while and upstream calls share one budget under Relay's 200 a minute.
export const BRIDGE_HISTORY_TTL_MS = 20_000;
export const BRIDGE_HISTORY_UPSTREAM_PER_MINUTE = 120;
const WALLET = /^0x[0-9a-fA-F]{40}$/;
const historyCache = new WeakMap<Fetcher, Map<string, { at: number; value: Promise<BridgeHistoryResponse> }>>();
const historyBudget = new WeakMap<Fetcher, { at: number; used: number }>();

export async function getBridgeHistory(address: string, fetcher: Fetcher = fetch, now: () => number = Date.now): Promise<BridgeHistoryResponse> {
  if (!WALLET.test(address)) throw new BridgeApiError("Invalid wallet address.", 400);
  if (!process.env.RELAY_API_KEY) return { relay: "off" };
  const wallet = address.toLowerCase();
  const at = now();
  let cache = historyCache.get(fetcher);
  if (!cache) historyCache.set(fetcher, cache = new Map());
  const cached = cache.get(wallet);
  if (cached && at - cached.at < BRIDGE_HISTORY_TTL_MS && at >= cached.at) return cached.value;
  const budget = historyBudget.get(fetcher);
  if (budget && at - budget.at < 60_000 && at >= budget.at) {
    if (budget.used >= BRIDGE_HISTORY_UPSTREAM_PER_MINUTE) throw new BridgeApiError("Relay history is busy. Please try again shortly.", 429);
    budget.used++;
  } else historyBudget.set(fetcher, { at, used: 1 });
  // Ask for in-flight transfers too. The parser drops requests without a chain-matched transaction hash.
  const query = new URLSearchParams({ user: wallet, limit: "50", includePendingRequests: "true", sortBy: "createdAt", sortDirection: "desc" });
  const value = relayJson(`/requests/v3?${query}`, { method: "GET" }, 1_000_000, fetcher).then(
    (body): BridgeHistoryResponse => ({ relay: "on", transfers: parseRelayHistory(body, wallet) }),
    (error: unknown) => { throw error instanceof BridgeApiError && error.status === 429 ? error : new BridgeApiError("Relay history is unavailable right now.", 503); },
  ).catch((error: unknown) => {
    if (cache.get(wallet)?.value === value) cache.delete(wallet);
    throw error instanceof BridgeApiError ? error : new BridgeApiError("Relay history could not be read.", 503);
  });
  if (cache.size >= 500) cache.clear();
  cache.set(wallet, { at, value });
  return value;
}

export function bridgeErrorResponse(error: unknown): Response {
  const known = error instanceof BridgeApiError ? error : new BridgeApiError("The bridge service is unavailable. Please try again.");
  return Response.json({ error: known.message, ...(known.status === 422 && known.quoteRejection ? { quoteRejection: known.quoteRejection } : {}) }, { status: known.status, headers: { ...BRIDGE_PRIVATE_HEADERS, ...(known.status === 429 ? { "Retry-After": "5" } : {}) } });
}
