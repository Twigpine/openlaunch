import { NextResponse } from "next/server";
import { getProtocolStatsCached } from "@/lib/stats/server";
import { parseStatsChain, parseStatsFormat, parseStatsWindow, statsCsv } from "@/lib/stats/stats";

export const dynamic = "force-dynamic";

/**
 * GET /api/stats?window=7d|30d|90d|all&chain=base|robinhood|arc|elysium&format=json|csv
 *
 * Protocol aggregates derived from the same index as the site. USD values are
 * fixed at each trade's or fee's own UTC hour; events with no price for that
 * hour are excluded and counted, not valued at today's price. `available:false`
 * means the database is unset or the read failed — the empty shapes are not
 * facts. The page and this endpoint share one 30 s memo.
 */
export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const window = parseStatsWindow(url.searchParams.get("window"));
  const chain = parseStatsChain(url.searchParams.get("chain"));
  const format = parseStatsFormat(url.searchParams.get("format"));
  const stats = await getProtocolStatsCached(window, chain);
  const headers = { "cache-control": "no-store" };

  if (format === "csv") {
    return new Response(statsCsv(stats), {
      status: 200,
      headers: {
        ...headers,
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="openlaunch-stats-${window}${chain ? `-${chain}` : ""}.csv"`,
      },
    });
  }

  return NextResponse.json(stats, { status: 200, headers });
}
