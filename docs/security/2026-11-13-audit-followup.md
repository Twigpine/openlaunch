# Security audit follow-up

This follows the independent review of PR #145 at `8b31a63` and preserves the API and indexer hardening subsequently merged into main.

## Application changes

- Creating or renewing a pair fee quote now requires the applicant's signature over the action, application, wallet, nonce and timestamp. Nonce consumption and reservation changes commit atomically. Existing quotes remain public and anyone can sponsor their payment. New unpaid reservations cannot extend past the application's 48-hour payment window; already-issued quotes and their settlement grace remain honored. Recorded payments retain top-up support.
- A historical burn valued at the live price no longer consumes a newer quote. Only a burn valued under that quote consumes it; the settlement timestamp remains recorded.
- A separately synced collection receipt is left unconsumed until its launch is indexed. Normal replay can then apply the fee exactly once. Out-of-order holder transfers also lower `first_block` correctly.
- Over-cap transfer recovery validates a complete block receipt set. When bulk receipts are unavailable or incomplete, it reads individual receipts with concurrency capped at four. Missing, malformed or inconsistent evidence still stops cursor advancement.
- Concurrent post reports lock the post before inserting, counting and updating. Deduplication and existing moderation state remain intact.
- Metadata creation and signed editing share one HTTPS URL policy for images, banners and websites. It rejects local/special literal destinations, local host names, URL credentials and overlong URLs rather than truncating them. It does not resolve DNS or validate redirect targets; server-side image fetching still uses the owned-image restriction.
- Public transaction sync requires a transaction hash. Full-chain polling remains in the server loop, so an empty public request cannot initiate polling and healing across every chain.
- Main's trusted-proxy policy, bounded rate limiter and 8 MiB RPC response cap are retained. The shared stream reader also keeps this PR's immediate chunk copying, bounded allocations and nonblocking cancellation.
- The boost authorization assertion now checks that the real admin gate exists before comparing its position. `.gitattributes` keeps text checkouts in LF on Windows.

## Operator considerations

### Pair clients

Clients creating fee reservations must sign `buildPairQuoteMessage` and POST the signed intent to the quote endpoint. Reading an application and sponsoring an existing quote remain public. See [pair listing documentation](../pairs.md). Quote signatures authorize a reservation only; they do not send funds.

### Derived accounting

These changes do not move funds or alter deployed contracts. Previously understated collected-fee totals may require the existing reviewed totals rebuild after confirming affected records. Follow [the canonical recovery runbook](2026-11-12-reorg-recovery.md); do not run a production rebuild merely because a test reproduced the issue.

Holder rebuilds now require explicit configuration instead of a second hardcoded address list. From `app/`, supply the same public factory/locker configuration used by the application and generate SQL:

```sh
npx tsx scripts/rebuild-holders.ts > rebuild-holders.generated.sql
```

This command emits SQL and public addresses only. Review the output before executing it on the intended database using `psql -v ON_ERROR_STOP=1`. The template alone fails without configuration; the generated script also refuses to modify data if a stored launch chain is not covered. It locks launches before transfers and holders, matching canonical writer ordering. No production rebuild is performed as part of application deployment by this change.

### Proxy trust

Configure `TRUSTED_PROXY_HOPS` for the actual ingress chain and prevent direct access around it. Fly-specific headers are trusted only in a Fly runtime; other deployments use the forwarded chain. Process-local quotas remain process-local, not a fleet-wide guarantee.

## Verification scope

Regression coverage includes real PostgreSQL concurrent signed reports, signed quote requests and replay/rollback, reservation expiry and settlement, historical/current burn valuation, collection receipts preceding their launch, individual-receipt recovery, chain-aware holder rebuilds and maintenance lock ordering. Database tests require explicit loopback endpoints, use random owned schemas and clean them up. Unit tests cover URL canonicalization, response-stream cancellation, request caps and recovery evidence validation.

The report's guard-bypass claim was not reproduced: the named operational scripts already require owner review. Adding further hard blocks, changing nonce namespaces, imposing a new token-ID uniqueness constraint or introducing a distributed limiter are separate hardening decisions, not prerequisites established by that claim. Large historical points/holder reads remain performance work; this patch does not silently truncate their accounting inputs.

Passing tests and dependency checks are not a guarantee that no vulnerabilities remain. Live funded transactions, production ingress behavior and production database contents are outside these regressions.
