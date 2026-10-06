import { isChartPool } from "@/lib/launchpad/chart-pool";
import { lookupGeckoPool } from "@/lib/launchpad/geckoterminal";
import { createGeckoCache } from "@/lib/launchpad/gecko-cache";
import { rateLimited } from "@/lib/launchpad/editServer";

export const dynamic = "force-dynamic";
const lookup = createGeckoCache(lookupGeckoPool, () => Date.now());

export async function GET(request: Request) {
  const headers = { "cache-control": "no-store" };
  const ip = (request.headers.get("fly-client-ip") || request.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "0.0.0.0";
  if (rateLimited(`chart:ip:${ip}`, 60)) return Response.json({ error: "Too many chart requests. Try again shortly." }, { status: 429, headers: { ...headers, "retry-after": "60" } });
  const query = new URL(request.url).searchParams;
  const pool = { chain: query.get("chain"), token: query.get("token"), poolId: query.get("pool"), quote: query.get("quote") };
  if (!isChartPool(pool)) return Response.json({ error: "Invalid pool." }, { status: 400, headers });
  try {
    return Response.json({ status: await lookup(pool) }, { headers });
  } catch {
    return Response.json({ error: "GeckoTerminal could not be checked. On-chain history is still available." }, { status: 503, headers: { ...headers, "retry-after": "60" } });
  }
}
