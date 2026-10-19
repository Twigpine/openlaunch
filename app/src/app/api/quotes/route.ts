import { NextResponse } from "next/server";
import { isChainKey } from "@/lib/chainPublic";
import { launchpad } from "@/lib/launchpad/config";
import { STOCK_SOURCE, baseStockList, ensureRegistry, refreshBaseRegistry, stockIssued, stockList, stockPrices } from "@/lib/launchpad/stocksServer";
import { searchStocks } from "@/lib/launchpad/stocks";
import { BASE_STOCK_SEARCH_LIMIT, searchBaseStocks, stockTileSvg } from "@/lib/launchpad/baseStocks";
import { memo } from "@/lib/launchpad/memo";
import { gitlawbUsd } from "@/lib/launchpad/gitlawbServer";
import { gitlawbLinkedUsd } from "@/lib/launchpad/twig";

export const dynamic = "force-dynamic";

type StockHit = { key: "stock"; address: string; symbol: string; name: string; decimals: number; usd: number | null; logo: string | null; issued: boolean | null };

/**
 * GET /api/quotes?chain=<base|robinhood|arc>[&q=AAPL] → quote assets the launch form may offer on that chain:
 * the fixed ones (ETH, USDG, USDC, TWIG, GITLAWB — TWIG and GITLAWB with GITLAWB's live USD) plus tokenized stocks from that chain's registry (with live USD where the stock has a price):
 * Coinbase tokenized stocks on Base, Robinhood Stock Tokens on Robinhood Chain, none on Arc.
 * `stocks` is one page of matches; `stocksMatched` is how many match the search in all and `stocksTotal` how many the chain's registry holds, so the form can say there are more.
 * Each stock's `issued` says whether any of it is in circulation: false = none yet (nobody can buy with it), null = not known (Robinhood, or no good read yet).
 * Only registry addresses are ever labelled as stocks.
 */
export async function GET(req: Request) {
  const u = new URL(req.url);
  const chain = u.searchParams.get("chain");
  if (!isChainKey(chain)) return NextResponse.json({ error: "bad chain" }, { status: 400 });
  const q = (u.searchParams.get("q") ?? "").slice(0, 12);
  const gl = await gitlawbUsd(); // one price for both chains: the Robinhood token is the Base token bridged 1:1
  const fixed = launchpad(chain).quotes.map((x) => {
    const linked = gitlawbLinkedUsd(x.key, gl); // GITLAWB, and TWIG (unwraps 1:1 to GITLAWB), take GITLAWB's live price
    return { ...x, usd: linked === undefined ? x.usd : linked };
  });
  const { stocks, stocksTotal, stocksMatched } = await memo(`quotes:stocks:${chain}:${q.toUpperCase()}`, 30_000, async (): Promise<{ stocks: StockHit[]; stocksTotal: number; stocksMatched: number }> => {
    let hits: { address: string; symbol: string; name: string; decimals: number; logo: string | null }[];
    let matched: number;
    // the total comes from the same list the search ran on: a registry refresh can land while prices are read below
    let total: number;
    const source = STOCK_SOURCE[chain];
    if (source === null) return { stocks: [], stocksTotal: 0, stocksMatched: 0 };
    if (source === "coinbase-b20") {
      void refreshBaseRegistry(); // background: the list as it stands answers now
      const list = baseStockList();
      const all = searchBaseStocks(q, Infinity, list);
      matched = all.length;
      total = list.length;
      hits = all.slice(0, BASE_STOCK_SEARCH_LIMIT).map((s) => ({ ...s, logo: stockTileSvg(s.symbol) }));
    } else {
      if (!(await ensureRegistry())) return { stocks: [], stocksTotal: 0, stocksMatched: 0 };
      const list = stockList(chain);
      const all = searchStocks(
        list.map((s) => ({ ...s, multiplier: 1 })),
        q,
        Infinity,
      );
      matched = all.length;
      total = list.length;
      hits = all.slice(0, 12);
    }
    const [px, issued] = await Promise.all([stockPrices(chain, hits.map((h) => h.address)), stockIssued(chain)]);
    return {
      stocks: hits.map((h) => ({ key: "stock" as const, address: h.address, symbol: h.symbol, name: h.name, decimals: h.decimals, usd: px.get(h.address) ?? null, logo: h.logo, issued: issued.get(h.address) ?? null })),
      stocksTotal: total,
      stocksMatched: matched,
    };
  });
  return NextResponse.json({ fixed, stocks, stocksTotal, stocksMatched }, { headers: { "cache-control": "no-store" } });
}
