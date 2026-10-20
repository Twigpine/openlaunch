import { NextResponse } from "next/server";
import { b20RpcUrl, rpcUrl } from "@/lib/chain";
import { clientIp, readJsonValue, readTextLimited } from "@/lib/http";
import { responseHasB20Error } from "@/lib/launchpad/baseStocks";
import { CHAINS, DEFAULT_CHAIN, isChainKey } from "@/lib/chainPublic";
import { takeToken } from "@/lib/rateLimit";
import { upstreamStatus } from "@/lib/rpc-proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Same-origin JSON-RPC proxy for the browser (wagmi transport) → per-chain upstream
 * (BASE_RPC_URL / ROBINHOOD_RPC_URL, else the chain's public RPC).
 * Keeps the API key server-side. Read-only allowlist: wallets send transactions
 * through their own provider, so nothing here can move funds. Small per-IP
 * token bucket so one tab cannot burn the whole Alchemy quota.
 */
const ALLOWED = new Set([
  "eth_chainId",
  "eth_blockNumber",
  "eth_call",
  "eth_estimateGas",
  "eth_gasPrice",
  "eth_maxPriorityFeePerGas",
  "eth_feeHistory",
  "eth_getBalance",
  "eth_getCode",
  "eth_getTransactionCount",
  "eth_getTransactionByHash",
  "eth_getTransactionReceipt",
  "eth_getBlockByNumber",
  "eth_getBlockByHash",
  "eth_getLogs",
  "net_version",
]);
const BUCKET_CAP = 120; // requests
const BUCKET_REFILL_PER_S = 4;
// a 20-call batch of ordinary calldata fits; a huge body is refused before it is buffered
const MAX_BODY_BYTES = 256 * 1024;
// eth_getLogs can answer with megabytes; the proxy must not buffer an unbounded one
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

type Req = { id?: unknown; jsonrpc?: string; method?: string; params?: unknown };

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export async function POST(req: Request) {
  const c = new URL(req.url).searchParams.get("chain") ?? DEFAULT_CHAIN;
  // every chain: the same read allowlist and per-IP bucket, its own upstream (the keyed *_RPC_URL, else the chain's
  // official public node) so browsers never hit a public RPC directly and the API key stays server-side
  if (!isChainKey(c)) return NextResponse.json({ error: "bad chain" }, { status: 400 });
  const upstream = rpcUrl(c) ?? CHAINS[c].rpcUrls.default.http[0];
  if (!upstream) return NextResponse.json({ error: "rpc unconfigured" }, { status: 503 });
  const ip = clientIp(req);
  if (!takeToken(ip, BUCKET_CAP, BUCKET_REFILL_PER_S)) return NextResponse.json({ error: "rate limited" }, { status: 429, headers: { "retry-after": "2" } });
  // A JSON-RPC batch is an array, so this one uses the value reader instead of readJson's object-only contract.
  const parsed = await readJsonValue(req, MAX_BODY_BYTES);
  if (parsed === undefined) return NextResponse.json({ error: "bad json" }, { status: 400 });
  const body = parsed as Req | Req[];
  const batch = Array.isArray(body);
  const list: Req[] = Array.isArray(body) ? body : [body];
  if (list.length === 0) return NextResponse.json({ error: "empty batch" }, { status: 400 });
  if (list.length > 20) return NextResponse.json({ error: "batch too large" }, { status: 400 });
  // A method outside the allowlist gets a JSON-RPC "method not found" in its
  // slot, never an HTTP error for the whole batch: viem then falls back (it
  // probes eth_fillTransaction for fee estimates) and the other reads succeed.
  const denied = new Map<number, unknown>();
  const forward: Req[] = [];
  list.forEach((r, i) => {
    if (typeof r?.method !== "string" || !ALLOWED.has(r.method)) denied.set(i, { jsonrpc: "2.0", id: r?.id ?? null, error: { code: -32601, message: `method not allowed: ${String(r?.method)}` } });
    else forward.push(r);
  });
  const reply = (items: unknown[]) => NextResponse.json(batch ? items : items[0], { headers: { "cache-control": "no-store" } });
  if (forward.length === 0) return reply(list.map((_, i) => denied.get(i)));
  try {
    const payload = JSON.stringify(batch ? forward : forward[0]);
    const res = await fetch(upstream, { method: "POST", headers: { "content-type": "application/json" }, body: payload, signal: AbortSignal.timeout(15_000) });
    const read = await readTextLimited(res, MAX_RESPONSE_BYTES);
    if (!read.ok) {
      return NextResponse.json(
        { error: read.tooLarge ? "The network RPC returned too much data. Try again." : "The network RPC is temporarily unavailable. Try again." },
        { status: 502, headers: { "cache-control": "no-store" } },
      );
    }
    let text = read.text;
    let status = res.status;
    // Base-native B20 tokens (Coinbase stocks) are precompiles the primary provider may not execute
    // ("EVM error OpcodeNotFound"): replay the batch on a node that can, transparently to the wallet.
    if (c === "base" && status === 200 && text.includes("Opcode") && responseHasB20Error(safeJson(text))) {
      const alt = await fetch(b20RpcUrl(), { method: "POST", headers: { "content-type": "application/json" }, body: payload, signal: AbortSignal.timeout(15_000) });
      if (alt.ok) {
        const altRead = await readTextLimited(alt, MAX_RESPONSE_BYTES);
        if (altRead.ok) {
          text = altRead.text;
          status = alt.status;
        }
      }
    }
    // Rate limiting and malformed bodies become 429/502 so viem retries with backoff
    // instead of surfacing "unknown RPC error" or throwing inside its batch scheduler.
    status = upstreamStatus(text, batch, forward.length, status, forward.map((r) => r.id));
    if (status !== 200) {
      // viem accepts a JSON-RPC error envelope even on HTTP 429/502. Returning
      // an upstream single error object for a batch would still crash its
      // scheduler. A non-RPC body forces the transport's HTTP retry path.
      return NextResponse.json({ error: status === 429 ? "The network is busy. Try again in a moment." : "The network returned an unavailable or invalid RPC response. Try again." }, {
        status, headers: { "cache-control": "no-store", ...(status === 429 ? { "retry-after": "1" } : {}) },
      });
    }
    if (denied.size === 0) return new NextResponse(text, { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
    const upstreamItems = JSON.parse(text) as unknown[]; // upstreamStatus verified an array of forward.length
    let next = 0;
    return reply(list.map((_, i) => denied.get(i) ?? upstreamItems[next++]));
  } catch {
    return NextResponse.json({ error: "The network RPC is temporarily unavailable. Try again." }, { status: 502, headers: { "cache-control": "no-store" } });
  }
}
