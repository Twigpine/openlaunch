import { configuredSolana, solanaRpcUrl } from "@/lib/solana/server";
import { allowedSolanaRpc } from "@/lib/solana/rpc-policy";
import { boundedJson } from "@/lib/solana/bounded-json";
import { rpcBudget } from "@/lib/solana/rpc-budget";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const buckets = new Map<string, { at: number; count: number }>();
let network: { url: string; cluster: string; expires: number } | null = null;
const GENESIS = {
  "mainnet-beta": "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
  devnet: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
};
const headers = { "cache-control": "no-store" };
const acquire = rpcBudget();

export async function POST(req: Request) {
  const config = configuredSolana();
  const upstream = solanaRpcUrl();
  if (!config || !upstream)
    return Response.json(
      { error: "Solana is not enabled." },
      { status: 503, headers },
    );
  const origin = req.headers.get("origin");
  if (origin && origin !== new URL(req.url).origin)
    return Response.json({ error: "Origin denied." }, { status: 403, headers });
  if (Number(req.headers.get("content-length") ?? 0) > 12_000)
    return Response.json(
      { error: "Request too large." },
      { status: 413, headers },
    );
  const ip =
    req.headers.get("fly-client-ip") ??
    req.headers.get("x-forwarded-for")?.split(",")[0] ??
    "local";
  const now = Date.now();
  const bucket = buckets.get(ip);
  if (bucket && now - bucket.at < 60_000 && bucket.count >= 100)
    return Response.json(
      { error: "Please wait before retrying." },
      { status: 429, headers: { ...headers, "retry-after": "10" } },
    );
  if (buckets.size > 10_000) buckets.clear();
  buckets.set(
    ip,
    bucket && now - bucket.at < 60_000
      ? { at: bucket.at, count: bucket.count + 1 }
      : { at: now, count: 1 },
  );
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
  const release = acquire();
  if (!release)
    return Response.json(
      { error: "Solana RPC is busy. Please retry shortly." },
      { status: 429, headers: { ...headers, "retry-after": "10" } },
    );
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
          error: {
            code: -32000,
            message:
              "Solana RPC rejected this request. Check the transaction status before retrying.",
          },
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
