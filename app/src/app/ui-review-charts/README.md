# GeckoTerminal chart preview

Run `npm run dev -- --hostname 127.0.0.1 --port 3005` from `app`, then open
[the preview](http://127.0.0.1:3005/ui-review-charts?pool=solv).

This is the production TokenChart component, not a separate mock. The surrounding
page is deliberately read-only and has no swap panel. Real token pages retain
their existing trade panel, token data and conversations.

## Cases

| Preset | Purpose at the September 13, 2026 audit |
| --- | --- |
| solv | Actively traded Base pool, primary advanced chart |
| rfly | Actively traded Robinhood pool |
| ocat | Arc USDC-quoted pool; exact Gecko identity and USD pricing verified September 16, 2026 |
| sky | Sparse ETH-quoted history |
| quiver | Stock quote, sparse history |
| unpriced | GITLAWB quote with trades but no Gecko USD price |
| inverted | Gecko lists GITLAWB first; use the launched token’s native history |
| new | No indexed trades; empty state with no synthetic candles |

Statuses and prices can change. Preview candles come from Openlaunch’s public
API through an allowlisted development-only proxy. No database credentials,
wallet addresses or cookies are sent. Both this page and its candle proxy return
404 outside development. Regular token pages use their local indexed candle API.

## Manual verification

- Test dark and light themes. Gecko uses supported `bg_color`, `light_chart`
  and `grayscale=1` options; its attribution must remain visible.
- Confirm real candles, volume, interval selection, Indicators and drawing tools.
- Use **On-chain** and return to **Advanced**. A provider lookup or frame failure
  must not disable trading or claim the token has no trades.
- Inspect unpriced and reversed examples: quote symbols and token orientation must
  stay correct. An unavailable USD conversion must not become a fake dollar price.
- Check the Arc preset: its quote is the 6-decimal USDC ERC-20 at `0x3600…0000`,
  not the native zero-address asset. **On-chain** must keep USDC as its quote unit.
- Verify **No trades yet**, sparse ranges and native chart refresh.
- Check 400px mobile, 720px workspace and 1440px desktop widths, with no page-level
  horizontal overflow. Provider controls are responsive and may collapse.
- Navigate into a token page from another route to exercise the initial document’s CSP.

## Limits and ownership

Gecko owns hosted chart data, UI, storage and uptime. Pool metadata does not prove
every chart has candles; **On-chain** remains the escape hatch. Reloads, theme and
source changes can reset drawings. No CSS filters, overlays, clipping or hidden
branding are applied.

The September 13 audit covered Base and Robinhood, before Arc was added. The
Arc preset was verified separately; it is not a full Arc-pool coverage audit.
The saved audit checked 1,012 pool identities, not every candle or every rendered
iframe. 988 had exact orientation; 314 of those had a positive USD price, while
674 did not. Seven listings were reversed and 17 were absent. These are
point-in-time observations, not a production coverage guarantee.
