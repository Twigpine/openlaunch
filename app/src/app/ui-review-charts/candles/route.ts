import { REVIEW_POOLS } from "../pools";
import { isInterval } from "@/lib/launchpad/candles";
import { memo } from "@/lib/launchpad/memo";
import { rateLimited } from "@/lib/launchpad/editServer";

export const dynamic = "force-dynamic";

/** Read-only, allowlisted preview data. Never exposed in production. */
export async function GET(request: Request) {
  if (process.env.NODE_ENV !== "development") return new Response(null, { status: 404 });
  const headers = { "cache-control": "no-store" };
  const input = new URL(request.url).searchParams;
  const pool = REVIEW_POOLS.find((item) => item.chain === input.get("chain") && item.token === input.get("token")?.toLowerCase());
  const interval = input.get("interval");
  const from = input.get("from");
  if (!pool || !isInterval(interval) || (from !== null && (!/^\d{1,11}$/.test(from) || Number(from) > Math.floor(Date.now() / 1000)))) return Response.json({ error: "Invalid preview request." }, { status: 400, headers });
  if (rateLimited("chart:review", 60)) return Response.json({ error: "Try again shortly." }, { status: 429, headers });
  // Construct a fresh allowlist; never forward wallet, cookies or credentials.
  const query = new URLSearchParams({ chain: pool.chain, token: pool.token, interval });
  if (from) query.set("from", from);
  try {
    const data = await memo("chart:review:" + query, 15_000, async () => {
      const response = await fetch("https://openlaunch.lol/api/launch/candles?" + query, {
        headers: { accept: "application/json" }, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error("Public preview unavailable.");
      return response.json();
    });
    return Response.json(data, { headers });
  } catch {
    return Response.json({ error: "Public preview data is temporarily unavailable." }, { status: 502, headers });
  }
}
