# Base, Robinhood and Arc bridge

The header's **Bridge** action opens a focused funding panel without leaving the current token or launch page. It supports Base (8453), Robinhood Chain (4663), and Arc mainnet (5042), to the same connected wallet address. Base sends/receives ETH or official USDC; Robinhood sends/receives ETH or USDG (Global Dollar, the chain's main stablecoin and the launch form's default quote there). Arc receives native USDC and sends USDC through its ERC-20 interface. Relay converts between ETH, USDC and USDG at the reviewed quote. This does not add launched tokens or GITLAWB, change the launch-chain registry, or deploy contracts.

## Integration

- Relay supplies quotes and transfer status. Openlaunch charges no application fee; Relay and source-network gas still cost money.
- `POST /api/bridge/quote` accepts `{ address, originChainId, destinationChainId, originAsset, destinationAsset, amount }`. Asset choices are allowlisted `ETH`, `USDC` or `USDG` for that chain, never arbitrary addresses. Omitted asset fields retain legacy defaults: Base/Robinhood ETH, Arc USDC. The integer amount uses 18 decimals for ETH inputs and **6 decimals for USDC and USDG inputs**. Outputs use 6 decimals for Base USDC and Robinhood USDG, 18 for ETH or Arc native USDC. `GET /api/bridge/status?requestId=…` returns normalized provider state and transaction hashes.
- Base USDC is Circle's `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`. Its ERC-20 balance and allowance are checked separately from native ETH gas. An approval and deposit both require an ETH reserve; a USDC balance cannot pay Base gas. The picker, fee labels, quote identity and recovery journal all retain the selected asset.
- Requests use a fixed upstream, timeout and streamed body-size bounds, existing per-IP limits, and private/no-store caching. The API does not need a wallet signature. Relay quotes/status stay server-side. Arc balance, allowance, gas and receipt reads go through the same-origin `/api/rpc?chain=arc` proxy (upstream `ARC_RPC_URL`, else the official public node), so the CSP gains no third-party origin and script restrictions are unchanged. Public Base and Arc nodes rate-limit a single quote's burst of reads; the proxy turns rate-limit and malformed replies into HTTP 429/502 so viem retries them, and production should point `BASE_RPC_URL` and `ARC_RPC_URL` at keyed providers.
- Arc's native USDC (18 decimals) and ERC-20 interface `0x3600000000000000000000000000000000000000` (6 decimals) share one balance but are **not interchangeable transfer interfaces**. Input parsing, deposit verification and recovery distinguish them. Gas budgeting converts the USDC input into native units and leaves a reserve for network fees.
- `RELAY_API_KEY` is optional, server-only, and forwarded as `x-api-key` if configured. Read-only smoke tests passed without a key. Higher production traffic may require a Relay key or adjusted provider limits. Do not expose the key through a `NEXT_PUBLIC_` variable.
- The server reconstructs the order hash using a narrow EVM/v1-only extraction of the MIT-licensed `@relay-protocol/settlement-sdk` 0.0.143 schema, normalizer and hashing algorithm, with the existing Viem dependency. This avoids shipping the SDK's unrelated multi-chain dependency subtree and its known vulnerabilities. The exact npm tarball, gitHead, upstream source SHA-256 hashes, MIT notice and 256 official-SDK compatibility vectors are recorded in [the provenance notice](../app/src/lib/bridge/relay-order.NOTICE.md); unsupported protocol versions and non-EVM orders fail closed.

## Transfer safety

Quotes request `explicitDeposit`, `includeProtocolData`, and an explicit `refundTo` matching the connected wallet. The server verifies the order hash, route-specific chain metadata, independently pinned depository/router, exact input/output currencies, recipient/depositor, refund destinations, minimum output, deadline, and canonical calldata. ETH sources accept only `depositNative`. USDC sources accept only an exact-amount approval to the pinned Relay depository and the four-argument `depositErc20(depositor, currency, amount, orderId)`. Unlimited approvals, generic router/multicall transactions, extra steps, output calls and application fees are rejected. An unavailable route fails closed rather than silently changing assets or providers.

The client binds the quote to the displayed account, direction and amount, rejects changed/expired quotes, then rechecks the wallet and source balance with fresh gas estimates before asking the wallet to send. Quotes are available for at most 45 seconds, with 0.5% output slippage. It rejects Relay fees above 5% of input and provider-reported total value loss above 5%. The latter is Relay's market estimate, not an independent fair-price oracle. ETH and USDC raw amounts are never subtracted from one another. No wallet request happens automatically. Inputs must leave room for source gas.

While the panel is open and no approval or transfer is in progress, valid amount/route edits automatically request an unsigned quote after a 700 ms pause. Inputs remain editable during loading. A new edit, account/network change or dismissal cancels old quote work; late responses cannot replace the current quote or error. Background balance polling does not request new quotes, and errors do not trigger a retry loop. An expired quote still needs an explicit refresh. Approval confirmation automatically loads a fresh quote, but approval and deposit remain separate, explicit wallet actions.

Fee-limit rejections include display-only costs after all protocol and currency checks pass. The panel shows the actual Relay fee and percentage, with native source gas separate. HTTP 422 diagnostics contain no transaction, approval or request ID and are checked against the current wallet/route/amount again in the client. The 5% limits are unchanged; a $1 input is not inherently blocked, but a small amount can fail when the quoted fee is too large relative to it.

Base and Arc USDC sends check the exact allowance. If it is insufficient, approval is a separate user action with its own durable recovery record and transaction hash. Approval alone does not create a bridge transfer. Once approval confirms, the user reviews a **fresh quote** and explicitly confirms the deposit. An interrupted approval response must be resolved before another approval is requested. An unspent approval remains on-chain until used or revoked; rejection of a later deposit does not revoke it.

An approval without a returned hash can be recovered using the actual mined transaction hash from the wallet. Recovery verifies the saved source chain, exact token/spender/amount, transaction or canonical approval event, receipt, fresh allowance, and a block timestamp no earlier than 30 seconds before the saved attempt. That clock check is a bounded heuristic, not unique nonce proof. Allowance alone cannot resolve an unknown broadcast; replaced or cancelled transactions without a matching recoverable hash remain blocked for manual investigation. Approval gas is additional to the later deposit gas estimate.

Before asking the wallet to send, the app stores a versioned, per-wallet recovery record locally. Pending transfers resume when Bridge is reopened with that wallet. Local storage and Web Locks are required to protect against duplicate submissions in multiple tabs. Private browsing or restrictive browser policies can prevent a transfer from starting.

An interrupted wallet response is **uncertain**, not failed. The app must not silently resend. A provider outage or missing receipt is not evidence that funds were lost. Relay's transfer page and verified explorer links remain available for recovery. Provider-reported success and refund states are labeled accordingly; a refund can arrive on either route chain.

## Limits and rollout

- Three mainnet networks, same-wallet recipient only. ETH on Base/Robinhood, USDC on Base/Arc and USDG on Robinhood. No arbitrary tokens, recipients, unlimited allowances, deposits from exchanges, custom swap calls, or extra networks.
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
npx tsx --conditions=react-server --tsconfig tsconfig.test.json --test src/lib/bridge/relay.live.test.ts
```

These tests never connect a wallet or submit a transaction.

`/ui-review-bridge` is a development-only visual fixture with disconnected, quote, quoting, high-fee, expired, error, pending, success, uncertain and refund states, plus approval/recovery states. Its synthetic data cannot execute a transaction, and the route returns 404 outside development. The real header action uses the actual integration.

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
