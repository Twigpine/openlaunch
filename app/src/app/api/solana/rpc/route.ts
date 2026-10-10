import { configuredSolana, solanaRpcUrl } from "@/lib/solana/server";
import { allowedSolanaRpc } from "@/lib/solana/rpc-policy";
import { boundedJson } from "@/lib/solana/bounded-json";
import { rpcBudget } from "@/lib/solana/rpc-budget";
import { sameOriginRequest } from "@/lib/solana/same-origin";
import { solanaRpcError } from "@/lib/solana/rpc-errors";
import { clientIp } from "@/lib/profiles/http";
import { rateLimited } from "@/lib/launchpad/editServer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
let network: { url: string; cluster: string; expires: number } | null = null;
const GENESIS = {
  "mainnet-beta": "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
  devnet: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
};
const headers = { "cache-control": "no-store" };
/**
 * An open pool tab polls one call every 8 s, and a pending transaction adds about 45 calls a minute while it confirms,
 * so a few tabs behind one address (an office, a carrier NAT) stay well inside this.
 */
const PER_IP_PER_MINUTE = 240;
/** The signing path draws on its own budget, so background polling can never starve a simulation, send or status check. */
const SIGNING = new Set([
  "sendTransaction",
  "simulateTransaction",
  "getLatestBlockhash",
  "getFeeForMessage",
  "getSignatureStatuses",
  "getBlockHeight",
  "getEpochInfo",
]);
const reads = rpcBudget(16, 900);
const signing = rpcBudget(8, 300);
const busy = () =>
  Response.json(
    { error: "Solana RPC is busy. Please retry shortly." },
    { status: 429, headers: { ...headers, "retry-after": "5" } },
  );

export async function POST(req: Request) {
  const config = configuredSolana();
  const upstream = solanaRpcUrl();
  if (!config || !upstream)
    return Response.json(
      { error: "Solana is not enabled." },
      { status: 503, headers },
    );
  if (!sameOriginRequest(req))
    return Response.json({ error: "Origin denied." }, { status: 403, headers });
  if (Number(req.headers.get("content-length") ?? 0) > 12_000)
    return Response.json(
      { error: "Request too large." },
      { status: 413, headers },
    );
  // The shared helper keys on Fly's client IP or the last forwarded hop: a spoofed header never buys a fresh bucket.
  if (rateLimited(`solana-rpc:${clientIp(req).slice(0, 64)}`, PER_IP_PER_MINUTE))
    return Response.json(
      { error: "Please wait before retrying." },
      { status: 429, headers: { ...headers, "retry-after": "10" } },
    );
  const now = Date.now();
  let body: unknown;
  try {
    body = await boundedJson(req.body, 12_000);
  } catch {
    return Response.json(
      { error: "Invalid request." },
      { status: 400, headers },
    );
  }
  if (!allowedSolanaRpc(body, config.programId))
    return Response.json(
      {
        jsonrpc: "2.0",
        id: typeof body === "object" && body && "id" in body ? body.id : null,
        error: { code: -32601, message: "Method or parameters not allowed." },
      },
      { headers },
    );
  const release = (SIGNING.has(body.method) ? signing : reads)();
  if (!release) return busy();
  try {
    if (
      !network ||
      network.url !== upstream ||
      network.cluster !== config.cluster ||
      network.expires < now
    ) {
      const check = await fetch(upstream, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "getGenesisHash",
          params: [],
        }),
        signal: AbortSignal.timeout(8_000),
        cache: "no-store",
      });
      // Throttled before the request was even forwarded: busy, not unavailable.
      if (check.status === 429) {
        await check.body?.cancel().catch(() => {});
        return busy();
      }
      const result = (await boundedJson(check.body, 4_096)) as {
        result?: unknown;
      };
      if (!check.ok || result.result !== GENESIS[config.cluster])
        throw new Error("Wrong cluster");
      network = {
        url: upstream,
        cluster: config.cluster,
        expires: now + 30_000,
      };
    }
    const response = await fetch(upstream, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
      cache: "no-store",
    });
    // A provider 429 is a refusal before processing: say so, so a refused send is not mistaken for an uncertain one.
    if (response.status === 429) {
      await response.body?.cancel().catch(() => {});
      return busy();
    }
    if (!response.ok) throw new Error("Upstream unavailable");
    const result = (await boundedJson(response.body, 4 * 1024 * 1024)) as {
      jsonrpc?: unknown;
      id?: unknown;
      result?: unknown;
      error?: unknown;
    };
    if (
      !result ||
      result.jsonrpc !== "2.0" ||
      result.id !== body.id ||
      (!("result" in result) && !("error" in result))
    )
      throw new Error("Invalid RPC response");
    if (result.error)
      return Response.json(
        {
          jsonrpc: "2.0",
          id: body.id,
          error: solanaRpcError(result.error, body.method),
        },
        { headers },
      );
    return Response.json(result, { headers });
  } catch {
    network = null;
    return Response.json(
      {
        jsonrpc: "2.0",
        id: body.id,
        error: {
          code: -32000,
          message:
            "Solana RPC is unavailable or on the wrong network. A submitted transaction may still confirm; check its signature before trying again.",
        },
      },
      { status: 503, headers },
    );
  } finally {
    release();
  }
}
