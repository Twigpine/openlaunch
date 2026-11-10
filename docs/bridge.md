# Base, Robinhood, Arc and Elysium bridge (funded from Ethereum, Arbitrum and Optimism)

The header's **Bridge** action opens a focused funding panel without leaving the current token or launch page; `/bridge` shows the same panel as a page. It moves funds between Base (8453), Robinhood Chain (4663), Arc mainnet (5042) and Elysium (99901), and into them from Ethereum (1), Arbitrum (42161) and Optimism (10), always to the same connected wallet address. The three funding networks send only: nothing is ever bridged to them. Base sends/receives ETH or official USDC; Robinhood sends/receives ETH or USDG (Global Dollar, the chain's main stablecoin and the launch form's default quote there). Arc receives native USDC and sends USDC through its ERC-20 interface. Elysium sends and receives its USDC only; HYPE, its gas token, is not bridged. Ethereum, Arbitrum and Optimism send ETH or Circle's native USDC. Relay converts between ETH, USDC and USDG at the reviewed quote. This does not add launched tokens or GITLAWB, change the launch-chain registry, or deploy contracts.

## Integration

- Relay supplies quotes and transfer status. For USDC to USDC into Base or Arc, Circle CCTP is quoted alongside and used when it delivers more (see Circle CCTP below). Openlaunch charges no application fee; the provider fee and source-network gas still cost money.
- `POST /api/bridge/quote` accepts `{ address, originChainId, destinationChainId, originAsset, destinationAsset, amount }`. Asset choices are allowlisted `ETH`, `USDC` or `USDG` for that chain, never arbitrary addresses. Omitted asset fields retain legacy defaults: Base/Robinhood ETH, Arc USDC, Elysium USDC. The integer amount uses 18 decimals for ETH inputs and **6 decimals for USDC and USDG inputs**. Outputs use 6 decimals for Base USDC, Robinhood USDG and Elysium USDC, 18 for ETH or Arc native USDC. `GET /api/bridge/status?requestId=…` returns normalized provider state and transaction hashes.
- Base USDC is Circle's `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`. Its ERC-20 balance and allowance are checked separately from native ETH gas. An approval and deposit both require an ETH reserve; a USDC balance cannot pay Base gas. The picker, fee labels, quote identity and recovery journal all retain the selected asset.
- Requests use a fixed upstream, timeout and streamed body-size bounds, existing per-IP limits, and private/no-store caching. The API does not need a wallet signature. Relay quotes/status stay server-side. Arc balance, allowance, gas and receipt reads go through the same-origin `/api/rpc?chain=arc` proxy (upstream `ARC_RPC_URL`, else the official public node), so the CSP gains no third-party origin and script restrictions are unchanged. The funding networks read the same way through `/api/rpc?chain=ethereum|arbitrum|optimism` (upstreams `ETHEREUM_RPC_URL`, `ARBITRUM_RPC_URL`, `OPTIMISM_RPC_URL`, else publicnode for Ethereum and the official Arbitrum and Optimism nodes), with the same read-only allowlist and per-IP budget. Public Base and Arc nodes rate-limit a single quote's burst of reads; the proxy turns rate-limit and malformed replies into HTTP 429/502 so viem retries them, and production should point `BASE_RPC_URL` and `ARC_RPC_URL` at keyed providers.
- Arc's native USDC (18 decimals) and ERC-20 interface `0x3600000000000000000000000000000000000000` (6 decimals) share one balance but are **not interchangeable transfer interfaces**. Input parsing, deposit verification and recovery distinguish them. Gas budgeting converts the USDC input into native units and leaves a reserve for network fees.
- `RELAY_API_KEY` is optional, server-only, and forwarded as `x-api-key` if configured. Read-only smoke tests passed without a key. Higher production traffic may require a Relay key or adjusted provider limits. Do not expose the key through a `NEXT_PUBLIC_` variable.
- The server reconstructs the order hash using a narrow EVM/v1-only extraction of the MIT-licensed `@relay-protocol/settlement-sdk` 0.0.143 schema, normalizer and hashing algorithm, with the existing Viem dependency. This avoids shipping the SDK's unrelated multi-chain dependency subtree and its known vulnerabilities. The exact npm tarball, gitHead, upstream source SHA-256 hashes, MIT notice and 256 official-SDK compatibility vectors are recorded in [the provenance notice](../app/src/lib/bridge/relay-order.NOTICE.md); unsupported protocol versions and non-EVM orders fail closed.

## Transfer safety

Quotes request `explicitDeposit`, `includeProtocolData`, and an explicit `refundTo` matching the connected wallet. The server verifies the order hash, route-specific chain metadata, independently pinned depository/router, exact input/output currencies, recipient/depositor, refund destinations, minimum output, deadline, and canonical calldata. ETH sources accept only `depositNative`. USDC sources accept only an exact-amount approval to the pinned Relay depository and the four-argument `depositErc20(depositor, currency, amount, orderId)`. Unlimited approvals, generic router/multicall transactions, extra steps, output calls and application fees are rejected. An unavailable route fails closed rather than silently changing assets. The provider is chosen only between Relay and Circle on USDC to USDC routes, and the panel names it.

The client binds the quote to the displayed account, direction and amount, rejects changed/expired quotes, then rechecks the wallet and source balance with fresh gas estimates before asking the wallet to send. Quotes are available for at most 45 seconds, with 0.5% output slippage. It rejects Relay fees above 5% of input and provider-reported total value loss above 5%. The latter is Relay's market estimate, not an independent fair-price oracle. ETH and USDC raw amounts are never subtracted from one another. No wallet request happens automatically. Inputs must leave room for source gas.

While the panel is open and no approval or transfer is in progress, valid amount/route edits automatically request an unsigned quote after a 700 ms pause. Inputs remain editable during loading. A new edit, account/network change or dismissal cancels old quote work; late responses cannot replace the current quote or error. Background balance polling does not request new quotes, and errors do not trigger a retry loop. An expired quote still needs an explicit refresh. Approval confirmation automatically loads a fresh quote, but approval and deposit remain separate, explicit wallet actions.

Fee-limit rejections include display-only costs after all protocol and currency checks pass. The panel shows the actual Relay fee and percentage, with native source gas separate. HTTP 422 diagnostics contain no transaction, approval or request ID and are checked against the current wallet/route/amount again in the client. The 5% limits are unchanged; a $1 input is not inherently blocked, but a small amount can fail when the quoted fee is too large relative to it.

Base and Arc USDC sends check the exact allowance. If it is insufficient, approval is a separate user action with its own durable recovery record and transaction hash. Approval alone does not create a bridge transfer. Once approval confirms, the user reviews a **fresh quote** and explicitly confirms the deposit. An interrupted approval response must be resolved before another approval is requested. An unspent approval remains on-chain until used or revoked; rejection of a later deposit does not revoke it.

An approval without a returned hash can be recovered using the actual mined transaction hash from the wallet. Recovery verifies the saved source chain, exact token/spender/amount, transaction or canonical approval event, receipt, fresh allowance, and a block timestamp no earlier than 30 seconds before the saved attempt. That clock check is a bounded heuristic, not unique nonce proof. Allowance alone cannot resolve an unknown broadcast; replaced or cancelled transactions without a matching recoverable hash remain blocked for manual investigation. Approval gas is additional to the later deposit gas estimate.

Before asking the wallet to send, the app stores a versioned, per-wallet recovery record locally. Pending transfers resume when Bridge is reopened with that wallet. Local storage and Web Locks are required to protect against duplicate submissions in multiple tabs. Private browsing or restrictive browser policies can prevent a transfer from starting.

An interrupted wallet response is **uncertain**, not failed. The app must not silently resend. A provider outage or missing receipt is not evidence that funds were lost. Relay's transfer page and verified explorer links remain available for recovery. Provider-reported success and refund states are labeled accordingly; a refund can arrive on either route chain.

## Limits and rollout

- Four launch networks both ways and three funding networks one way, same-wallet recipient only. ETH on Base/Robinhood, USDC on Base/Arc/Elysium, USDG on Robinhood, and ETH or native USDC from Ethereum/Arbitrum/Optimism. No arbitrary tokens, recipients, unlimited allowances, deposits from exchanges, custom swap calls, bridged USDC.e, HYPE, or other networks.
- Robinhood USDC remains unavailable. On 2026-09-16, the official canonical gateway mapped Ethereum USDC to bridged `0x80e0e24718dbFcad49ECAA6F1e6C89A190586cA8` (6 decimals); this is not Circle-native issuance. Read-only Relay probes at 25 USDC returned roughly 21% loss outbound, while inbound routes were rejected for roughly 92% swap impact. Outbound responses required an approval-proxy/swap flow, not our validated direct deposit. Do not enable this asset or loosen safeguards without fresh route validation and separately reviewed support. USDG is offered as its own named asset, never as a silent stand-in for USDC.
- Relay is a third-party bridge protocol. Its availability, liquidity, estimates and settlement are not guaranteed by Openlaunch. Provider response changes fail closed until reviewed.
- Funds never pass through an Openlaunch wallet or new Openlaunch contract.
- A user can keep a wallet approval prompt open beyond a quote's validity. The app cannot retract that wallet prompt; the protocol deadline and provider recovery process still apply.
- A sped-up or cancelled-and-replaced deposit is adopted automatically: when the wallet's hash is unmined and Relay reports a different source hash, the app verifies that hash is this wallet's exact deposit for the same order before tracking it.
- A record with no deposit anywhere can be discarded by the user after 15 minutes, and only while Relay still reports `waiting` with no transaction hashes and the source chain has no receipt for the wallet's hash, checked within the last minute. The same wait applies to an unmined approval, which if mined later only grants the exact allowance the next deposit re-reads. Any on-chain evidence keeps the record until it settles. Unknown broadcasts and replaced transactions that Relay cannot match still need manual investigation via Relay and the source explorer.
- Quote validity travels as a remaining duration (`ttlMs`) and is anchored on the browser's own clock at request time, so device clock skew cannot expire or extend a quote.
- Real-money coverage so far: on 2026-09-16 a maintainer completed Base USDC → Arc with their own wallet (exact 9 USDC approval, fresh quote, deposit, delivery). Other directions, a deliberate wallet rejection, and refresh recovery still need the same small-amount check before this is described as fully exercised. Do not describe the feature as independently audited or risk-free.

## Development and verification

From `app/`, run `npm test`, `npm run lint`, `npm run typecheck`, and `npm run build`. The optional live tests use Relay's public documentation example address and only request quotes/status:

```powershell
$env:RUN_BRIDGE_LIVE_TESTS='1'
npx tsx --conditions=react-server --tsconfig tsconfig.test.json --test src/lib/bridge/relay.live.test.ts src/lib/bridge/cctp.live.test.ts
```

These tests never connect a wallet or submit a transaction.

`/ui-review-bridge` is a development-only visual fixture with disconnected, quote, quoting, high-fee, expired, error, pending, success, uncertain and refund states, plus approval/recovery states. Its synthetic data cannot execute a transaction, and the route returns 404 outside development. The real header action uses the actual integration.

### Elysium (2026-11-10)

Elysium (99901, gas in HYPE) is the fourth launch chain, so the bridge now sends from and delivers to it like Base, Robinhood and Arc. It carries one asset there: USDC `0xb47c4C8F73F009CC0C0d3f92B388d13E293F0B65` (symbol and name USDC, 6 decimals, checked on-chain), the same contract the launch form quotes. It moves through Relay alone, since Elysium has no Circle CCTP domain. With Elysium, the bridge has sixty-two routes: twenty-six between the launch chains and thirty-six from the funding networks.

- **HYPE is not carried.** Relay's chain listing marks HYPE as not bridgeable. Read-only probes on 2026-11-10 showed why its routes need their own design:
  - Quotes into HYPE refund on Elysium in USDC, not HYPE. The validator requires a destination refund in the output currency, so these quotes fail closed. Arc USDC to HYPE also guaranteed less than 99.5% of its own estimate.
  - Quotes out of HYPE take payment in USDC through Relay's router (`0x0729…97f7`) with a different call, not the depository deposit this bridge verifies.
- **Chain check.** For every other chain, Relay must still list the native currency as bridgeable. Elysium is the one chain whose native currency the bridge never sends or receives. There, the check instead requires Relay to list exactly this USDC (address, symbol and decimals) as bridgeable, beside the usual depository, router, status and VM checks. A Base or Robinhood listing with its native currency not bridgeable still fails. The quote checks are unchanged: exact currencies both ways, refunds in those currencies on both chains, gas paid in the origin's native currency (HYPE when sending from Elysium), and an exact approval of Elysium USDC to the pinned depository.
- **Gas.** Sending from Elysium needs HYPE, which the panel shows as "For gas". A route notice and the /bridge page say HYPE is not bridged and that some is needed on Elysium to use or send the USDC. Bridge, then buy reads the HYPE balance on Elysium and suggests Elysium USDC as a source only beside some HYPE. It does not offer to bridge for a buy paid in HYPE.
- **Launch gate.** The bridge offers Elysium whether or not its launch factory is configured, so funds can be moved there before its first launch.
- **Live cost** (read-only, 25 USDC or USDG, or 0.01 ETH; 2026-11-10). All sixteen Elysium routes passed the server validator:

| Route | Receives | Cost |
|---|---|---|
| Base, Ethereum, Arbitrum or Optimism USDC to Elysium | 24.9718 USDC | 0.11% |
| Robinhood USDG to Elysium | 24.9628 USDC | 0.13% |
| Arc USDC to Elysium | 24.9618 USDC | 0.15% |
| ETH from Base, Robinhood, Ethereum, Arbitrum or Optimism to Elysium | 20.59 to 20.61 USDC | 0.21% to 0.30% (Relay's estimate) |
| Elysium to Base USDC | 24.6642 USDC | 1.34% |
| Elysium to Arc USDC | 24.6620 USDC | 1.35% |
| Elysium to Robinhood USDG | 24.6533 USDG | 1.36% |
| Elysium to Base or Robinhood ETH | 0.011893 ETH | 1.76% (Relay's estimate) |

  Cost is Relay's fee as a share of what is sent, or Relay's own total estimate where ETH converts. Leaving Elysium costs more than ten times as much as arriving. Sending from Elysium also took about 0.000043 HYPE in gas.
- **Not built.** HYPE routes in either direction, including a gas top-up that delivers some HYPE with the USDC.
- **Verification.** Tests cover the registry, Relay's Elysium listing (and every way it can be wrong), each Elysium route, refunds and outputs in HYPE (both refused), HYPE gas, approvals, history rows, links, the signal board and the bridge-then-buy source rule. No wallet signed anything. A small real transfer each way is still needed before this is described as exercised.

### Circle CCTP (2026-11-10)

USDC to USDC into Base or Arc is also quoted through Circle's Cross-Chain Transfer Protocol v2. For these routes both quotes are requested together and the panel offers whichever delivers more. Every other route is Relay alone, exactly as before. The panel names the provider in use: the Route row, the fee label, the approval notice, the footer and the transfer steps.

- **What is sent.** One transaction, `depositForBurnWithHook` on Circle's TokenMessengerV2 `0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d` (the same address on Ethereum, Optimism, Arbitrum, Base and Arc). It burns the exact amount for the same wallet on the destination, with a zero destination caller, Fast finality (1000) and Circle's Forwarding Service hook (`cctp-forward`, version 0, no payload). Arc has no Fast Transfer as a source, so a burn from Arc asks for Standard (2000); Arc blocks are final in about half a second. Circle attests and mints on the destination itself: there is no second wallet step and no destination gas. Domains, read on-chain with `localDomain()`: Ethereum 0, Optimism 2, Arbitrum 3, Base 6, Arc 26.
- **Fee and amount.** The fee is Circle's published fee for the route at the burn's finality (`GET /v2/burn/USDC/fees/{src}/{dst}?forward=true`, in basis points, rounded up) plus the high tier of its forwarding fee, set as the burn's `maxFee`. With forwarding, Circle takes the whole `maxFee` (every live forwarded burn checked had `feeExecuted` equal to `maxFee`), so the quote shows one fixed fee and the exact amount received, with no slippage. The server refuses a rate above 1% or a forward above $5 before using them, and the client applies the same 5% ceiling as for Relay.
- **What Circle decides.** Only the fee, within those bounds, and progress. The server builds the calldata from pinned values (`lib/bridge/cctp.ts`), and the browser rebuilds it byte for byte from the wallet, amount and route before the wallet is asked (`validateCctpQuote` in `lib/bridge/client.ts`). Approval is the same exact-amount flow; Circle's messenger is the only spender allowed besides Relay's depository.
- **When Circle is not offered.** A route other than USDC to USDC into Base or Arc (Robinhood has a Circle domain, 35, but no live USDC route); more than 10,000,000 USDC, Circle's per-burn limit; Circle's global Fast Transfer allowance below the amount (Circle would fall back to Standard and still charge the Fast fee); a fee outside the bounds; or Circle or the source RPC failing. In each case Relay's quote, or its error, stands as before.
- **Status and recovery.** A Circle transfer is tracked by its source transaction. `GET /api/bridge/status?provider=cctp&origin=…&destination=…&hash=…&address=…&amount=…` reads Circle's message record and accepts it only when it names this wallet as sender and recipient, this amount, token, route, finality and hook. Not found yet is waiting. Attested with the forward complete is arrived, with the destination mint hash. A reported delay or a forward that is neither pending nor complete is delayed. The recovery record (version 4) keeps the burn calldata and the source block from before the wallet was asked. A burn whose hash the wallet never returned, or a sped-up replacement, is then found from the messenger's own `DepositForBurn` event: within 9,999 blocks, and only when exactly one burn matches. History rows carry the provider and show "Circle" where Relay rows link to Relay.
- **Requests.** Circle allows 40 requests a second per IP and blocks for five minutes past that. The server shares one budget of 600 a minute across all callers and reuses fees for 30 seconds, the Fast allowance for 15 and a status for 5. Circle needs no API key.
- **Cost.** Live on 2026-11-10, fees in USDC: Relay's quoted loss, then Circle's fee and forward.

  | Route | $10 | $100 | $1,000 | $10,000 |
  |---|---|---|---|---|
  | Base to Arc | 0.0226 / 0.0161 | 0.0406 / 0.0190 | 0.2206 / 0.0483 | 2.0207 / 0.3408 |
  | Ethereum to Arc | 0.0226 / 0.0165 | 0.0406 / 0.0187 | 0.2206 / 0.0412 | 2.0206 / 0.2662 |
  | Arbitrum to Arc | 0.0226 / 0.0166 | 0.0406 / 0.0197 | 0.2206 / 0.0512 | 2.0206 / 0.3662 |
  | Optimism to Arc | 0.0226 / 0.0166 | 0.0406 / 0.0195 | 0.2206 / 0.0487 | 2.0206 / 0.3412 |
  | Arc to Base | 0.0259 / 0.0542 | 0.0709 / 0.0542 | 0.5209 / 0.0542 | 5.0209 / 0.0542 |
  | Ethereum to Base | 0.0219 / 0.0552 | 0.0309 / 0.0642 | 0.1209 / 0.1542 | 1.0209 / 1.0542 |
  | Arbitrum to Base | 0.0219 / 0.0556 | 0.0309 / 0.0682 | 0.1209 / 0.1942 | 1.0209 / 1.4542 |
  | Optimism to Base | 0.0219 / 0.0555 | 0.0309 / 0.0672 | 0.1209 / 0.1842 | 1.0209 / 1.3542 |

  Circle delivers more on every route into Arc and from Arc to Base above about $30. Relay delivers more from Ethereum, Arbitrum and Optimism into Base, where Circle's Fast fee is 1 to 1.4 basis points plus a $0.054 forward. Relay quoted about a second for most routes; Circle's estimate is 25 seconds (40 from Ethereum, 15 from Arc). The choice is by amount delivered alone, and the arrival estimate is shown on the quote.
- **Not built.** A manual mint (`receiveMessage` with Circle's attestation) when Circle's forward stalls: the transfer shows Delayed and tracking continues. Elysium, which has no Circle domain. Near the crossover amount a quote can move between providers, and the approval's spender with it, so an exact approval granted for one can be followed by a second approval step for the other.
- Checked with unit tests for the route rules, the calldata and every tampered field, the event match, the fee parser and its bounds, quote selection, the status mapping against Circle's real record, the stored record, the approval spender and the log search. The opt-in live test quotes all eight routes from Circle, matches a real forwarded Ethereum to Arc burn (`0x0095…ce01`) against this bridge's own calldata, and reads it from Circle as delivered with its mint hash. `/ui-review-bridge` has a "quote from: Circle" toggle for its quote, pending and arrived scenes, and a Circle row in the history board. No wallet signed anything; a small real Circle transfer is still needed before this is described as exercised.

### Bridge, then buy (2026-11-10)

A buyer on a token page who is short of what the buy pays with is offered the bridge, then the buy. These are two separate steps with two separate wallet prompts. An atomic bridge-and-buy is not built: a Relay destination call runs from Relay's contract, not the buyer's wallet, so it would need its own reviewed design.

- **When it shows.** The trade panel's buy side, with a wallet connected and the token tradable, when the wallet holds none of the pay asset on this chain or less than the buy needs (the gas reserve included). Only buys paid with something the bridge delivers qualify: ETH on Base and Robinhood, USDC on Arc, USDC on Base and USDG on Robinhood (`bridgeAssetForPay` in `lib/bridge/fund.ts`). A token priced in TWIG, GITLAWB or another quote token shows nothing.
- **Where the funds are.** The card reads the wallet's balance of every bridge asset on every other bridge network, including Ethereum, Arbitrum and Optimism, through the wallet config's transports, once per wallet and page while the buyer is short. Each read stands alone, so a network that does not answer is left out rather than counted as empty.
- **What it suggests.** It suggests the largest holding worth at least $1, comparing ETH and dollars with the page's ETH price. With no price, it picks the largest holding of the buy's own kind, with an ETH floor of 0.0005. A token holding counts only where the wallet also has ETH for gas; on Arc, USDC is the gas. The button opens the header's bridge on that route (network and asset at both ends) through its guarded pickers. The route carries no amount; the card states how much the buy is short. With nothing found, it opens the default route and says no funds were found.
- **Following the transfer.** The card follows the newest transfer into this network from this browser's history ledger. It must be from the last two hours, sent to this wallet and not hidden. While that transfer is unsettled, the card wakes the one bridge controller closed, so tracking continues without opening the panel. When it arrives, the trade panel reads its balances once, straight away, and step two says to buy with the button above. A refund, failure or unknown status sends the buyer to the bridge before sending again. A finished transfer can be hidden for the session.
- **What it never does.** It never makes a wallet call, sends anything, starts a second bridge controller or buys. The provider now takes a route from inside the app (`useOpenBridge()(link)`), and asking for the same route twice applies it again.
- Checked with `/ui-review-bridge`'s fund scenes (short with and without a source, checking, nothing elsewhere, moving, delayed, arrived, refunded) on desktop and phone widths in both themes. Tests cover the asset mapping, the holdings reader, the source choice, the follow window and the guards. The real trade panel with a connected wallet has not been exercised. No wallet signed anything.

### Transfer history (2026-11-10)

`/bridge` ends with **Your transfers**, a departures board for the connected wallet: time, route (the Signal board's network codes), amount sent, amount received, status, and links to Relay and both explorers. The header panel's footer links to it. It reads two sources and sends nothing.

- **This browser.** A small ledger (`openlaunch.bridge.history.v1:<wallet>`, `lib/bridge/history-store.ts`) beside the recovery record, never instead of it. The bridge controller writes a transfer there once it has a source transaction hash or a settled status, so a cancelled wallet prompt never appears, and removes it again if the transfer is discarded as never sent. It keeps the 20 newest per wallet, drops any stored row that fails validation on its own, and a storage failure only shows a notice: it never throws into a transfer. The recovery record and its rules are unchanged.
- **Relay.** `GET /api/bridge/history?address=` reads `GET /requests/v3?user=…` with `RELAY_API_KEY` in the `x-api-key` header (never in the URL). Relay retires the keyless `/requests/v2` on 2026-11-24 and v3 requires a key, so **without `RELAY_API_KEY` the route answers `{ relay: "off" }` and calls nothing**; the board then says it shows what this browser saved. With a key, v3 returns requests made under openlaunch's key plus Relay's public keyless ones, so transfers made here before the key was set appear too. One wallet's answer is reused for 20 seconds, upstream calls share a budget of 120 a minute (Relay's keyed limit is 200), and the route allows 30 requests a minute per IP.
- **One set of rules.** `lib/bridge/history.ts` turns both sources into the same row. A Relay request becomes a row only when the wallet sent it and both ends are this bridge's networks and tokens, matched by currency address with matching decimals; anything else is left out. A settled status is never replaced by an unsettled one, a delivered amount beats a quoted one, and the browser re-validates every row the server sends.
- **What it says.** Status is a word (Arrived, In transit, Delayed, Refunded, Failed, Reverted, Checking). The received column shows Relay's delivered amount, or the accepted quote's amount labelled "Quoted"; a refund or failure shows no destination amount, since nothing is known to have arrived. A transfer sent to another address names that address.
- Checked with `/ui-review-bridge`'s history scenes on desktop and phone widths in both themes; tests cover the parser against Relay's published schema, the ledger, the route and the key handling. The opt-in live test (`RUN_BRIDGE_LIVE_TESTS=1` with `RELAY_API_KEY`) reads recent Robinhood requests from v3 through the same parser. It has not run yet, because there is no key.

### Signal panel and the /bridge page (2026-11-10)

The panel was redesigned without touching the transfer logic: `useBridge`, the validators and every wallet guard are unchanged.

- **Signal board.** A dot-matrix strip at the top of the form, the approval view and the transfer view spells the two networks (`BASE`, `HOOD`, `ARC`, `ETH`, `ARB`, `OP`) and runs lights along the route. What it shows is a pure function of the transfer state (`lib/bridge/signal.ts`): a sweeping light while a quote loads, a slow pulse for a live quote, lights knocking at the source while the wallet is asked, packets in transit only for a tracked pending transfer, green on a reported arrival, amber and reversed for a refund, amber for anything unknown or failed. It is decorative (`aria-hidden`); the panel's status text carries the same meaning in words. It is drawn on a canvas, stops animating under reduced motion, and stays a dark plate in the light theme.
- **Dot numerals.** The amount you send and the estimated output are set in Doto (SIL Open Font Licence), loaded through `next/font` with the lazily loaded panel only and never preloaded site-wide.
- **Slide to confirm.** When, and only when, the next step is the deposit itself, a coin can be dragged across a rail to confirm it. The rules are pure (`lib/bridge/slide.ts`): only letting go, or pressing Enter, at the far end confirms; letting go anywhere else puts the coin back and requests nothing. The slide and the ordinary button call one shared function with the same guards, and the button never goes away. Approvals, quotes and refreshes are never slid. The coin shows the token sent and turns to the token received when they differ.
- **/bridge.** The same panel as a page, with the networks, steps, costs and limits beside it. The page does not start a second bridge: it registers an empty element (`components/bridge/bridge-slot.ts`) and the header's one controller renders the panel into it, so a transfer is quoted, sent and tracked once. While the page is open the header button focuses the page's panel instead of opening the dialog.
- **Shareable links.** `/bridge?from=arbitrum&to=base&asset=USDC&toAsset=USDC` preselects a route (`lib/bridge/link.ts`). `to` is required and must be a launch chain; `from` defaults to Base, or Ethereum when Base is the destination. A link carries no amount and no address, is applied once through the pickers' own guarded setters (which refuse during an approval or a transfer), and is ignored whole if any value in it is unknown, repeated or unsupported.
- Checked in the browser on desktop and phone widths in both themes through the development-only `/ui-review-bridge` fixture and the real panel without a wallet: a half drag resets with "Nothing was sent", a full drag confirms, and the board follows each scene. No wallet signed anything.

### Funding from Ethereum, Arbitrum and Optimism (2026-11-10)

- The three networks are sources only. A request, quote, saved transfer or status naming one as the destination is refused (server and client), the reverse button is disabled while one is the source, and the destination picker lists the launch chains alone. Picking the destination as the source moves the destination to another launch chain instead of swapping a funding network into it.
- Each sends ETH or Circle's native USDC, read on-chain as symbol `USDC`, name `USD Coin`, 6 decimals: Ethereum `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48`, Arbitrum `0xaf88d065e77c8cC2239327C5EDb3A432268e5831`, Optimism `0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85`. Bridged USDC.e is not offered. A USDC source uses the same exact approval, fresh quote and `depositErc20` flow as Base USDC, with ETH kept for gas.
- Relay's `GET /chains` lists all three with protocol.v2 names `ethereum`, `arbitrum` and `optimism`, the pinned depository and the v3.2 router, and their quotes return the same direct-deposit orders settled through the Base solver hub. No rule was loosened; the validator checks the funding network's catalogue entry exactly as it checks a launch chain's.
- The wallet config adds the three chains so the wallet can switch to them; their reads go through the RPC proxy. A wallet already on one of them is offered a one-tap "Send from" shortcut in the panel. The wallet menu names the network and links its explorer, without the unsupported-network warning.
- Thirty routes are new, forty-six in all (sixteen between the launch chains, thirty from the funding networks). All forty-six passed the read-only live tests. No wallet signed anything; a small real transfer from each funding network is still needed before this is described as exercised.

### USDG on Robinhood Chain (2026-11-10)

- USDG is `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` on Robinhood Chain: read on-chain as symbol `USDG`, name `Global Dollar`, 6 decimals, and the same contract the launch form already prices in (`lib/launchpad/config.ts`; a test keeps the two equal). It is issued by Paxos ([USDG mainnet addresses](https://docs.paxos.com/guides/stablecoin/usdg/mainnet)) and is one of the two currencies Relay's solver holds on that chain.
- Six routes are new, sixteen in all: USDG to and from Base ETH, Base USDC and Arc USDC. Each returns the same direct-deposit order as the existing routes (`depositNative`, or an exact approval then `depositErc20`), so no rule was loosened to admit them.
- A USDG source works like Base USDC: an exact approval of USDG to the pinned depository as its own wallet action, a fresh quote, then the deposit, with ETH kept separately for gas. Approvals are journaled per chain and each chain has one ERC-20 (USDC on Base and Arc, USDG on Robinhood); a test fails if a chain ever gets a second.
- USDC and USDG are both dollars, so a dollar-to-dollar route is also checked in units, without the provider's price estimate: the guaranteed minimum is never under 95% of the amount sent and the expected output never over 105%.
- Changing a network keeps a dollar a dollar where it can: Base or Arc USDC becomes Robinhood USDG, and back. The amount is still cleared.
- All sixteen directed routes passed the read-only live tests through the unchanged validator. Browser check: the Robinhood token menu lists ETH and USDG, and picking USDG shows the conversion note. No wallet signed anything; a small real transfer in each direction is still needed before this is described as exercised.

### Relay router v3.2 (2026-11-10)

- Relay made its v3.2 router (`0x0729e2a4716d9f7dd17858d5d504426d228697f7`) the default on 2026-10-26: Get Chains reports it as `contracts.erc20Router` and every order names it in `extraData`. Only v3 (`0xb92fe925dc43a0ecde6c8b1a2709c170ec4fff4f`) was pinned, so from that day every quote was refused as unverifiable and the bridge could not be used. Nothing was sent: the check fails closed.
- Both routers are now allowed, as Relay's [contract addresses](https://docs.relay.link/references/api/api_resources/contract-addresses) page asks of integrators who pin them: the chain catalogue, the order's output and both refunds must each name one of the two. The depository, the deposit calldata and every other check are unchanged.
- After the change all ten directed routes passed the read-only live tests again. No wallet signed anything.
- The live tests are opt-in, so nothing noticed the outage for two weeks. A scheduled run of `relay.live.test.ts` would have; that is a workflow change, which belongs to the maintainers.

### Wallet test findings (2026-09-16)

- Approval recovery now distinguishes a transaction missing from the queried node, an earlier nonce blocking it, a fee cap below the current base fee, and an RPC outage. These are advisory observations, never permission to resubmit or proof that a missing transaction failed. A fresh matching receipt and allowance are still required.
- Before a new approval or deposit, the source RPC's pending and latest nonce counts are checked. A visible queue or inconsistent read stops submission before journaling or requesting the approval/deposit signature. A wallet network-switch prompt may happen first. This cannot see every node's mempool or wallet-private queue, and it deliberately never overrides a nonce.
- A wallet speed-up can change the approval hash. Both uncertain and pending approvals accept a user-supplied mined replacement after validating chain, hash, recent block time, exact owner/token/spender/amount (or canonical USDC Approval event), receipt and current allowance. Verification sends no transaction. A stale poll cannot overwrite a completed recovery.
- For a stuck approval, inspect the earliest pending transaction in the wallet on the source network. Do not clear wallet history or repeatedly approve. Discarding a saved UI record neither cancels a transaction nor resolves a nonce queue. Any wallet replacement/cancellation remains a user-controlled action.

- Phantom cannot add Arc or Robinhood (fixed EVM network list), so its chain switch fails; MetaMask adds both from the wallet config. The error copy now names this case.
- viem probes `eth_fillTransaction` when estimating Base fees. The read proxy used to answer HTTP 403 for the whole batch, which failed every Base read; it now returns a per-item JSON-RPC `-32601` so viem falls back and the other reads succeed. Production ran the same proxy, so Base-origin bridges would have failed there too.
- Public Base and Arc nodes rate-limit one quote's burst of reads inside 200 bodies. The proxy maps those and malformed bodies to 429/502 so viem retries; Arc reads are proxied with `ARC_RPC_URL`. base-rpc.publicnode.com is unsuitable as an upstream because it refuses receipt lookups without a token, which stalls approval and transfer tracking.

### Base USDC extension verification (2026-09-16)

- All ten supported directed asset routes passed live unsigned Relay quote/status checks: the six original routes plus Base USDC in both directions with Arc USDC and Robinhood ETH.
- The actual development HTTP API returned validated, `no-store` quotes for all four new directions and rejected Robinhood USDC with HTTP 400.
- Full regression suite: 612 tests, 602 passed, 10 opt-in live tests skipped. TypeScript and the local production build passed. Lint retained only the two existing token OG-image warnings; existing image-store tracing warnings remain.
- Browser checks covered Base's send and receive token menus, clearing stale amounts when the input asset changes, reversing routes, six-decimal Base output, separate ETH gas, nested Escape focus, and phone layouts in both themes. The UI keeps the existing themed Base UI menu treatment rather than native token selects.
- Recovery retains legacy native/v2 Arc records; explicit-asset records are version 3. Tests distinguish old Arc native amounts (18 decimals) from ERC-20 amounts (6 decimals) without changing stored amounts. Maximum-integer approvals are explicitly rejected.
- A separate code review checked token/native balance separation, approval and deposit bindings, cross-tab locks, stale quote handling and legacy recovery. No wallet signing or real settlement was tested; a maintainer-controlled small-value transfer remains necessary before rollout.

### Arc extension verification (2026-09-16)

- Full suite: 579 tests, 573 passed, 6 opt-in live tests skipped. The separate live provider run passed all six directed routes across Base, Robinhood and Arc.
- Typecheck and production build passed. Lint: no errors, the two existing token OG-image warnings. The existing image-store tracing warnings remain in the build.
- Local production-build HTTP smoke: all six routes returned HTTP 200 validated quotes and `waiting` status. Arc-source quotes carried exact-amount approval metadata; ETH-source quotes did not. Responses were `no-store`; the synthetic review route returned 404.
- Browser checks covered route collision/reversal, clearing amounts across asset changes, Arc-to-Robinhood approval/review/deposit states, manual-hash recovery UI, six-decimal USDC display, keyboard dismissal, and the narrow mobile sheet in light and dark themes. Synthetic previews were used; they did not exercise a real wallet broadcast.
- A separate code review checked quote/call validation, shared-balance gas math, approval and deposit journals, manual hash recovery, cross-tab locking and stale reviews. No blocking findings; this is not a protocol audit. No funds were sent or wallet transactions signed.

### Native-only baseline verification (2026-09-16, before Arc extension)

- Full suite: 530 tests, 528 passed, 2 opt-in live tests skipped. The separate provider run passed both live directions.
- Typecheck and production build passed. Lint had no errors and only the two existing token OG-image warnings; the build retained the existing image-store tracing warnings.
- Production dependency audit: zero reported vulnerabilities. The bridge adds no runtime dependency.
- Local production-build HTTP smoke: both 0.01 ETH quote directions returned validated quotes and `waiting` status; the synthetic review route returned 404.
- Browser checks covered desktop/mobile, inherited light/dark themes, route reversal, shared wallet-picker return, accessible full-recipient disclosure, and pending/recovery UI. Wallet signing and actual settlement remain untested.
- A separate code review covered quote validation, transaction recovery, cross-tab locking, and the vendored encoder. This is not an independent protocol audit.

## Primary references

- [Relay input validation](https://docs.relay.link/references/api/api_core_concepts/input-validation)
- [Relay quote API](https://docs.relay.link/references/api/get-quote-v2)
- [Relay refunds](https://docs.relay.link/references/api/api_core_concepts/refunds)
- [Relay status API](https://docs.relay.link/references/api/get-intents-status-v3)
- [Relay transfer recovery](https://support.relay.link/en/articles/9260724-how-do-i-find-my-transaction)
- [Relay depository and explicit-amount ERC-20 deposit](https://docs.relay.link/references/protocol/contracts/evm-depository)
- [Arc mainnet connection details](https://docs.arc.io/arc/references/connect-to-arc)
- [Arc native USDC and ERC-20 semantics](https://docs.arc.io/arc/concepts/stablecoin-native-model)
- [Circle USDC contract registry](https://developers.circle.com/stablecoins/usdc-contract-addresses)
- [Robinhood canonical bridge and token mapping](https://docs.robinhood.com/chain/bridging/)
- [Robinhood official gateway contracts](https://docs.robinhood.com/chain/protocol-contracts/)
