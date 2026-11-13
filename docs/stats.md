# Protocol stats

`/stats` is the public protocol page; `/api/stats` is the same aggregate as JSON or CSV. Both read the site's Postgres
index of factory, locker and Uniswap v4 PoolManager events. The chain is the source of truth; the index lags by a few
blocks.

```
GET /api/stats?window=7d|30d|90d|all&chain=base|robinhood|arc|elysium&format=json|csv
```

- `window` defaults to `30d`.
- `chain` is optional; omitted means every configured chain.
- `format=csv` returns the daily series as `text/csv` with a filename. The default is JSON.
- The endpoint is `no-store`; the server memoizes one read per window/chain for 30 seconds.
- `available: false` means `DATABASE_URL` is unset or the aggregate read failed. The empty shapes are not zero facts.

## What is counted

| field | source | meaning |
| --- | --- | --- |
| `launches` | `bb_launches` | LaunchFactory launches whose `block_time` is in the window |
| `launchers` | `bb_launches` | Distinct launcher wallets |
| `trades` | `bb_launch_swaps` | Indexed PoolManager swaps |
| `traders` | `bb_launch_swaps` | Distinct `trader` values; unknown traders are not counted |
| `volume_usd` | `bb_launch_swaps.usd` | Sum of trade-time USD |
| `fees_collected_usd` | `bb_launch_fee_events` (`collected`) | Quote-side fees collected |
| `fees_burned_usd` | `bb_launch_fee_events` (`burned`) | Quote-side fees burned |
| `fees_to_creators_usd` | derived | `collected - burned` |
| `unpriced_trades` | `bb_launch_swaps` | Trades with no USD price for their own hour |
| `unpriced_fee_events` | `bb_launch_fee_events` | Quote-side fee events with no USD price for their own hour |
| `usd_partial` | derived | True when either unpriced count is above zero |

`fees_burned_usd` only includes burns in the launch's quote currency. A burn of the launched token has no USD value
here; it is still in the raw on-chain events.

## Trade-time USD

USD is fixed at each event's own UTC hour from `bb_quote_usd_hourly`: the live price the indexer saw during that hour,
or a historical close filled in by `scripts/usd-backfill.ts`. It is not "today's price applied to old volume". Events
with no price for their hour are excluded from the USD sums and counted in `unpriced_*`; the page shows a warning when
that happens.

The home page hero uses the same stored trade-time values, but additionally falls back to the current quote price for
events with no hourly value. That makes the hero's all-time USD figure slightly more complete than `/stats` when a
feed was down. The difference is exactly the `unpriced_*` counts.

## Response shape

```json
{
  "window": "30d",
  "chain": null,
  "available": true,
  "since": "2026-10-15",
  "until": "2026-11-13",
  "generated_at": "2026-11-13T12:00:00.000Z",
  "totals": {
    "launches": 0,
    "launchers": 0,
    "trades": 0,
    "traders": 0,
    "volume_usd": 0,
    "fees_collected_usd": 0,
    "fees_burned_usd": 0,
    "fees_to_creators_usd": 0,
    "unpriced_trades": 0,
    "unpriced_fee_events": 0,
    "usd_partial": false
  },
  "by_chain": [{ "chain": "base", "launches": 0 }],
  "series": [{ "day": "2026-10-15", "launches": 0 }],
  "top": [{ "chain": "base", "token": "0x…", "name": "…", "symbol": "…", "trades": 0, "volume_usd": 0, "holders": 0, "launched_at": "…" }]
}
```

`by_chain` contains every configured chain when no `chain` filter is set, and only the selected chain otherwise.
`series` is filled day by day from `since` through `until`; days with no activity are zeros, not gaps. Launches are
bucketed by launch time and trades by trade time, so a launch older than the window can still add trades and volume
to it. `top` is the ten launches with the most trade-time USD volume in the window (all-time stored volume when
`window=all`).

The CSV is the `series` only, one row per UTC day, with a `chain` column (`all` or the selected key).

## Why these choices

- **Facts, not scores.** There is no safety score, no ranking of "quality", no estimate for missing prices.
- **Trade-time USD.** Valuing old volume at today's price makes a chart move when the quote moves, not when people
  trade. The index already stores each event's value; the stats read it rather than recomputing.
- **Day buckets are UTC.** `to_char(date_trunc('day', block_time AT TIME ZONE 'UTC'), 'YYYY-MM-DD')` in every series
  query; the page labels the axis accordingly.
- **One read per window/chain.** `getProtocolStatsCached` memoizes for 30 seconds; the page and the API share the memo,
  so a refresh does not multiply database queries.
- **Fail soft, but never fake zeros.** A read failure returns `available: false` and empty shapes, and the page says
  so instead of drawing a zero chart.

## Code

- `app/src/lib/stats/stats.ts` — pure window parsing, UTC day buckets, series fill, totals derivation and CSV.
- `app/src/lib/stats/server.ts` — the three aggregate reads (`GROUPING SETS` per chain + global), daily series and top
  launches; `available: false` on failure.
- `app/src/app/api/stats/route.ts` — JSON/CSV endpoint, query parsing and headers.
- `app/src/app/stats/page.tsx` — the page: cards, daily charts, per-chain table, top launches and method notes.
- `app/src/components/stats/StatsChart.tsx` — server-rendered SVG bars plus the exact figures in a disclosure.
- `app/src/lib/stats/stats.test.ts` — window, fill, CSV and URL tests.

## Tests

```
cd app && npm test
```

The stats cases are `src/lib/stats/stats.test.ts` and `src/app/api/stats/route.test.ts`.
