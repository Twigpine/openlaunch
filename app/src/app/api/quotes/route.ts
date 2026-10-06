import { NextResponse } from "next/server";
import { isChainKey } from "@/lib/chainPublic";
import { launchpad } from "@/lib/launchpad/config";
import { STOCK_SOURCE, ensureRegistry, stockList, stockPrices } from "@/lib/launchpad/stocksServer";
import { searchStocks } from "@/lib/launchpad/stocks";
import { searchBaseStocks, stockTileSvg } from "@/lib/launchpad/baseStocks";
import { memo } from "@/lib/launchpad/memo";
import { gitlawbUsd } from "@/lib/launchpad/gitlawbServer";
import { twigUsdFromGitlawb } from "@/lib/launchpad/twig";

export const dynamic = "force-dynamic";

/**
 * GET /api/quotes?chain=<base|robinhood|arc>[&q=AAPL] → quote assets the launch form may offer on that chain:
 * the fixed ones (ETH, USDG, USDC, TWIG, GITLAWB — TWIG and GITLAWB with GITLAWB's live USD) plus tokenized stocks from that chain's registry (with live USD):
 * Coinbase tokenized stocks on Base, Robinhood Stock Tokens on Robinhood Chain, none on Arc.
 * Only registry addresses are ever labelled as stocks.
 */
export async function GET(req: Request) {
  const u = new URL(req.url);
  const chain = u.searchParams.get("chain");
  if (!isChainKey(chain)) return NextResponse.json({ error: "bad chain" }, { status: 400 });
  const q = (u.searchParams.get("q") ?? "").slice(0, 12);
  const gl = await gitlawbUsd(); // one price for both chains: the Robinhood token is the Base token bridged 1:1
  const fixed = launchpad(chain).quotes.map((x) => ({ ...x, usd: x.key === "gitlawb" ? gl : x.key === "twig" ? twigUsdFromGitlawb(gl) : x.usd })); // TWIG unwraps 1:1 to GITLAWB
  const stocks = await memo(`quotes:stocks:${chain}:${q.toUpperCase()}`, 30_000, async () => {
    let hits: { address: string; symbol: string; name: string; decimals: number; logo: string | null }[];
    const source = STOCK_SOURCE[chain];
    if (source === null) return [];
    if (source === "coinbase-b20") hits = searchBaseStocks(q, 13).map((s) => ({ ...s, logo: stockTileSvg(s.symbol) }));
    else {
      if (!(await ensureRegistry())) return [];
      hits = searchStocks(
        stockList(chain).map((s) => ({ ...s, multiplier: 1 })),
        q,
        12,
      );
    }
    const px = await stockPrices(chain, hits.map((h) => h.address));
    return hits.map((h) => ({ key: "stock" as const, address: h.address, symbol: h.symbol, name: h.name, decimals: h.decimals, usd: px.get(h.address) ?? null, logo: h.logo }));
  });
  return NextResponse.json({ fixed, stocks }, { headers: { "cache-control": "no-store" } });
}
