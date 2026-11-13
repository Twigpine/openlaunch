# MCP server

openlaunch serves a small, read-only Model Context Protocol (MCP) server over HTTP at

```
https://openlaunch.lol/api/mcp
```

It exists for the same reason `/llms.txt` and the JSON API do: the interface is optional. An MCP client can read
launch facts, trades, holders, posts, community pairs, the points board and protocol totals without scraping the
site. No API key, no account, no session, and no write path.

The server is stateless. It answers one JSON-RPC 2.0 message per POST with a JSON response, never opens an SSE
stream, and never sends server-to-client requests. That is a valid MCP Streamable HTTP transport: the spec allows a
server to answer with `application/json` instead of `text/event-stream`.

## Connect

Most clients take a small JSON block:

```json
{
  "mcpServers": {
    "openlaunch": {
      "type": "http",
      "url": "https://openlaunch.lol/api/mcp"
    }
  }
}
```

Claude Code, for example:

```sh
claude mcp add --transport http openlaunch https://openlaunch.lol/api/mcp
```

For a raw check, initialize the session and list the tools:

```sh
curl -s https://openlaunch.lol/api/mcp \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"1"}}}'

curl -s https://openlaunch.lol/api/mcp \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
```

The server is stateless, so the `Mcp-Session-Id` header is neither issued nor required.

## Protocol

- JSON-RPC 2.0, one message per POST. Batches are rejected: MCP `2025-06-18` removed them.
- Supported protocol versions: `2025-06-18` (latest), `2025-03-26`, `2024-11-05`. `initialize` echoes a version it
  speaks and otherwise offers `2025-06-18`.
- Methods: `initialize`, `ping`, `tools/list`, `tools/call`. A notification (a message without `id`) gets HTTP
  `202` and no body; unknown notifications are ignored, as JSON-RPC requires.
- A tool that rejects its arguments, or cannot find the requested record, returns a normal JSON-RPC result with
  `isError: true` and a plain-text explanation. The client's model can correct itself and retry. Protocol-level
  faults (unknown method, malformed envelope) are JSON-RPC errors.
- Tool results are `content: [{type: "text", text: "<JSON>"}]`. No `outputSchema` is advertised, so no
  `structuredContent` is promised.
- No resources, prompts, sampling, elicitation, logging or completions. Only tools.

## Tools

All tools are read-only (`readOnlyHint: true`) and call the same server-side read model as the site. Arguments with
a default can be omitted. Unknown arguments are rejected.

### `list_launches`

Browse launches with the site's own sorts.

| argument | type | default | notes |
| --- | --- | --- | --- |
| `chain` | string | all | `base`, `robinhood`, `arc`, `elysium` |
| `sort` | string | `live` | `live`, `new`, `mcap`, `volume`, `gainers`, `holders` |
| `window` | string | `all` | `1h`, `24h`, `all` (for `sort=volume`) |
| `mcap` | string | `all` | `all`, or `filtered` for the site's browsing filter |
| `filter` | string | — | `fee0`, `burn`, `usdg`, `usdc` |
| `launcher` | address | — | one wallet's launches |
| `limit` | integer | `10` | 1–25 |
| `offset` | integer | `0` | 0–10000 |

Returns `{eth_usd, has_more, launches}`. Rows are the JSON API's launch rows: price, FDV, USD values, volume
windows, holder counts and the market-cap classification facts.

### `get_launch`

`{chain, token}` → `{eth_usd, launch}`. The full indexed record for one launch. Errors with `isError` when the
address is not an openlaunch launch on that chain.

### `search_launches`

`{query, chain?, order?, limit?}` → `{query, eth_usd, launches}`.

- `query`: name or symbol substring, or an exact token address (1–80 characters).
- `order`: `newest` (default) or `holders`.
- `limit`: 1–25, default 10.

### `get_token_trades`

`{chain, token, limit?}` → `{chain, token, trades}`. Newest swaps first. `limit` 1–50, default 20. Raw amounts are
decimal integer strings; `price_quote` is in the token's quote asset.

### `get_token_holders`

`{chain, token}` → holder distribution and trust facts: top holders, top-10 share, pool share, creator bought/sold,
launch-window snipers, and the panel's plain-language notes. Facts only; there is no score.

### `get_recent_activity`

`{limit?}` → `{eth_usd, activity}`. Newest launches and swaps across chains, merged newest first (the home page's
live tape shape). `limit` 1–50, default 20.

### `list_posts`

`{scope?, chain?, token?, limit?, before_id?}`.

- `scope=feed` (default): newest top-level community posts across the site.
- `scope=token`: one token's posts; requires `chain` and `token`; returns a `nextCursor` for older pages.
- `limit` 1–50, default 20.

Hidden and reported posts are never returned.

### `list_community_pairs`

`{chain?}` → `{count, pairs}`. Listed community tokens only; suspended and delisted pairs are excluded. A listing
is not an endorsement.

### `get_points_leaderboard`

`{board?, limit?}` → `{season, board, rows, names}`.

- `board`: `creator` (default) or `scout`.
- `limit`: 1–100, default 25.
- `season` is `null` before a season is public.

Points are computed hourly from chain activity; the public season row says whether the board is final.

### `get_protocol_totals`

`{}` → `{eth_usd, totals}`. All-time launches, trades, USD volume, fees paid to creators, fees burned, and per-chain
counts. USD volume is valued at each trade's own hour; a quote with no price is reported as a partial figure, never
guessed.

## Data semantics

The same caveats as the JSON API apply:

- The chain is the source of truth; these tables are an index. Indexing lags by a few blocks, and a very new launch
  may not be visible yet. `POST /api/launch/sync?chain=…&tx=…` asks the site to index a transaction immediately.
- Amounts are display-unit numbers in launch and trade rows; raw on-chain values are strings where the API says so.
  Use the row's `quote_decimals` for quote amounts, not a blanket 18.
- USD figures can be `null` or partial when the price feed is down. The response says when it is partial.
- There are no platform fees, no owner, and no write tools. A read-only MCP server cannot launch, trade or sign.

## Limits and security

- 120 requests per IP per minute, shared by the endpoint. A `429` carries `retry-after: 60`.
- 64 KB request body.
- `content-type: application/json` required.
- Browser requests with an `Origin` header are allowed only from `openlaunch.lol`, `www.openlaunch.lol`, and in
  development from localhost. Non-browser MCP clients send no `Origin` and are allowed. This is the MCP
  specification's DNS-rebinding guidance; it is not authentication.
- No CORS headers are served. The endpoint is public and read-only, but a browser page on another origin cannot use
  a visitor's browser as a proxy to it.
- The endpoint is stateless: no cookies, no session, no per-user data.

## Code

- `app/src/lib/mcp/protocol.ts` — versions, JSON-RPC envelopes, error codes.
- `app/src/lib/mcp/schema.ts` — the tiny JSON Schema subset and its validator.
- `app/src/lib/mcp/server.ts` — transport-independent dispatcher (`initialize`, `ping`, `tools/list`, `tools/call`).
- `app/src/lib/mcp/tools.ts` — the ten tools and their dependency-injected read functions.
- `app/src/lib/mcp/origin.ts` — the browser-origin policy.
- `app/src/app/api/mcp/route.ts` — the HTTP transport, rate limit and headers.

Run the tests with `cd app && npm test` (the MCP cases are `src/lib/mcp/*.test.ts` and
`src/app/api/mcp/route.test.ts`).
