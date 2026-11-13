import { NextResponse } from "next/server";
import { SITE_URL } from "@/lib/chainPublic";
import { clientIp, readJsonValue } from "@/lib/http";
import { rateLimited } from "@/lib/rateLimit";
import { APP_VERSION } from "@/lib/version";
import { originAllowed } from "@/lib/mcp/origin";
import { failure, RPC_ERRORS, type JsonRpcResponse } from "@/lib/mcp/protocol";
import { createMcpServer } from "@/lib/mcp/server";
import { createMcpTools } from "@/lib/mcp/tools";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** One JSON-RPC message, not a batch: MCP 2025-06-18 removed batching. */
const MAX_BODY = 65_536;
/** Requests per IP per minute. A tool call is several indexed reads, not a scrape. */
const RATE_LIMIT = 120;
const RATE_WINDOW_MS = 60_000;

const HEADERS = {
  "cache-control": "no-store",
  // MCP clients POST JSON-RPC; a browser fetch from this site is the only
  // cross-origin case we allow (originAllowed), and no CORS headers are served.
  "content-type": "application/json; charset=utf-8",
  "x-content-type-options": "nosniff",
} as const;

const server = createMcpServer({
  tools: createMcpTools(),
  serverInfo: { name: "openlaunch", version: APP_VERSION ?? "0.0.0" },
  instructions:
    "Read-only tools for openlaunch.lol, a free token launchpad on Base, Robinhood Chain, Arc and Elysium. " +
    "Every token is a fixed-supply ERC-20 launched through the open-source factory; there is no platform fee and no owner. " +
    "Use list_launches or search_launches to find a token, then get_launch, get_token_holders and get_token_trades for its facts. " +
    "Amounts in the launch rows are already in display units; raw on-chain values are strings where the API says so. " +
    "No tool can sign, trade, launch or write. Indexing lags the chain by a few blocks; a very new launch may not be indexed yet.",
  onToolError: (tool, error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[mcp] ${tool} failed: ${message}`);
  },
});

function json(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: HEADERS });
}

function rpcError(status: number, code: number, message: string): NextResponse {
  const body: JsonRpcResponse = failure(null, code, message);
  return json(body, status);
}

/** POST /api/mcp — one stateless MCP JSON-RPC exchange. */
export async function POST(req: Request): Promise<Response> {
  const origin = req.headers.get("origin");
  if (!originAllowed(origin, SITE_URL, { dev: process.env.NODE_ENV !== "production" })) {
    return rpcError(403, RPC_ERRORS.invalidRequest, "origin not allowed");
  }

  const contentType = (req.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (contentType !== "application/json") {
    return rpcError(415, RPC_ERRORS.invalidRequest, "content-type must be application/json");
  }

  const declared = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_BODY) {
    return rpcError(413, RPC_ERRORS.invalidRequest, "request body too large");
  }

  const ip = clientIp(req);
  if (rateLimited(`mcp:ip:${ip}`, RATE_LIMIT, RATE_WINDOW_MS)) {
    return NextResponse.json(
      failure(null, RPC_ERRORS.invalidRequest, "too many requests; retry in a minute"),
      { status: 429, headers: { ...HEADERS, "retry-after": "60" } },
    );
  }

  const value = await readJsonValue(req, MAX_BODY);
  if (value === undefined) return rpcError(400, RPC_ERRORS.parse, "parse error");

  const response = await server.handle(value);
  // A JSON-RPC notification gets 202 and no body, as the transport requires.
  if (response === null) return new Response(null, { status: 202, headers: HEADERS });
  return json(response);
}

/** No server-initiated SSE stream: this server is stateless and request/response only. */
export function GET(): Response {
  return new Response(JSON.stringify({ error: "POST a JSON-RPC message to this endpoint" }), {
    status: 405,
    headers: { ...HEADERS, allow: "POST" },
  });
}

export function OPTIONS(): Response {
  return new Response(null, { status: 204, headers: { allow: "POST" } });
}
