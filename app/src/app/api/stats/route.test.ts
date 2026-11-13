import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import { clearMemo } from "@/lib/launchpad/memo";
import { GET } from "./route.ts";

function request(query = ""): Request {
  return new Request(`http://localhost/api/stats${query}`);
}

beforeEach(() => clearMemo());

test("GET returns the stats shape and defaults to 30d for unknown values", async () => {
  const res = await GET(request("?window=7d&chain=base"));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "no-store");
  const body = (await res.json()) as { window: string; chain: string | null; available: boolean; by_chain: Array<{ chain: string }>; series: unknown[]; top: unknown[]; totals: { launches: number } };
  // The test database is the in-memory mock: it answers with no rows, so the window is honestly empty.
  assert.equal(body.window, "7d");
  assert.equal(body.chain, "base");
  assert.equal(body.available, true);
  assert.deepEqual(body.by_chain.map((c) => c.chain), ["base"]);
  assert.equal(body.series.length, 7);
  assert.deepEqual(body.top, []);
  assert.equal(body.totals.launches, 0);

  const fallback = (await (await GET(request("?window=forever&chain=ethereum"))).json()) as { window: string; chain: string | null; by_chain: unknown[] };
  assert.equal(fallback.window, "30d");
  assert.equal(fallback.chain, null);
  assert.equal(fallback.by_chain.length, 4);
});

test("format=csv serves one header row and a download filename", async () => {
  const res = await GET(request("?window=7d&chain=base&format=csv"));
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /^text\/csv/);
  assert.equal(res.headers.get("content-disposition"), 'attachment; filename="openlaunch-stats-7d-base.csv"');
  const lines = (await res.text()).trimEnd().split("\n");
  assert.equal(lines.length, 8);
  assert.equal(lines[0], "chain,day,launches,launchers,trades,traders,volume_usd,fees_collected_usd,fees_burned_usd,unpriced_trades,unpriced_fee_events");
  for (const line of lines.slice(1)) assert.match(line, /^base,\d{4}-\d{2}-\d{2},0,0,0,0,0,0,0,0,0$/);

  const all = await GET(request("?format=csv"));
  assert.equal(all.headers.get("content-disposition"), 'attachment; filename="openlaunch-stats-30d.csv"');
});
