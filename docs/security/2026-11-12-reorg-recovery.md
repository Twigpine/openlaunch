# Canonical index recovery

Scope after the PR split: the recovery implementation and rollout described here belong to the standalone security PR. Verification counts below are historical results for the combined bridge/security head `be857d86006ce7ded2e26fe9903a7d16f27c90fd`, not results for the reconstructed standalone branch. See the [PR split and branch-specific verification](2026-11-12-pr-split.md) for current scope and results.

The indexer previously treated transaction/log deduplication and an overlapping block scan as sufficient recovery. A replacement chain could leave orphan launches, trades, fee totals, holder balances and boosts in PostgreSQL. A real database reproduction diverged from a clean replacement-chain index in six tables.

## Recovery behavior

- The indexer persists block hashes for event-bearing blocks and scan endpoints. Every range, receipt and background enrichment runs under the same per-chain transaction lock. Observed hashes are checked again before commit.
- A changed checkpoint triggers a search for the last matching checkpoint, including forks deeper than the scan overlap. Raw facts after that boundary are removed atomically and retained facts reconstruct totals, prices and holders. RPC failures or incomplete capped-log results leave the cursor unchanged.
- Receipt ingestion shares the poller's transaction boundary. A launch affected by recovery has a known recovery route instead of an unexplained 404. Unknown token addresses still return 404.
- Removed event valuations are journaled. Reuse requires matching decoded fields, block number and timestamp, plus block hash when available. Large integers remain exact strings. A re-included pair payment whose historical value cannot be recovered stays explicitly unresolved; it is not silently repriced at today's spot rate.
- Points publication checks the persisted recovery generation before and after computation. A reorg invalidates computed seasons, including historical ones, and schedules them for recomputation. Authored season rules and dates remain intact.
- Payment quoting, review claims, expiry and repeat-review requests are fenced against payment recovery. Launch-based listing health checks cannot suspend a pair because its launch is temporarily absent during a rebuild.
- Signed posts, metadata, profiles, moderation, application decisions and hourly price observations are retained. Only canonical event facts and their derived accounting are reconstructed.

The launch form saves its returned transaction hash before waiting for a receipt. A timeout, failed sync or reload offers a check of that same hash, without another wallet submission. The journal is scoped to the browser session; when storage is denied, only the current page's in-memory protection remains. It is not a cross-tab wallet mutex.

## Deployment and first rebuild

The schema additions are idempotent and run through the existing migration mechanism. Existing index cursors have recovery version zero because their historical events have no stored block hashes. On first use, the new indexer journals valuations, clears that chain's unverified event facts and rebuilds from its configured deployment block in bounded ranges. A completed range commits independently, so interruption resumes from the saved cursor.

Deploy with all old indexer writers stopped before the first new writer starts. A rolling overlap with the old binary is unsafe: the old code does not take the new shared lock or respect recovery state. Do not downgrade writers against a partially rebuilt database. Keep a database backup and the previous deployment available for an operator-managed restore if needed.

Historical launch lists and markets can temporarily disappear during this one-time rebuild. Known token URLs display recovery; points and payment consumers wait for catch-up. Rebuild duration depends on history size, provider limits and deployment-block configuration. This change does not claim a production load benchmark or a zero-downtime migration.

Check recovery progress with read-only queries:

```sql
SELECT chain_id, cursor_block, head_block, reorg_version,
       reorg_generation, rebuilding_until, last_run_at, last_error
FROM bb_launch_sync_cursor ORDER BY chain_id;

SELECT chain_id, from_block, old_cursor, observed_head, reason, created_at
FROM bb_launch_reorgs ORDER BY id DESC LIMIT 20;

SELECT chain_id, tx_hash, log_index, application_id, block_number
FROM bb_pair_burns WHERE valuation_pending;

SELECT id, code, status, paid_usd, fee_usd
FROM bb_pair_applications WHERE payment_reorg;
```

A payment marked for reconciliation requires checking the canonical receipt and original application/quote evidence. Do not ask the applicant to burn again, clear the flag merely to unblock review, or substitute a current price without validating its historical basis. Removed payments remain flagged even if the replacement chain never includes them.

### Reconcile a verified re-included payment

This is an operator procedure for a database maintainer, not a public API or an automatic repricing path. Review the evidence and proposed changes before executing them, and rehearse the transaction on a restored database copy. A valid historical valuation must be established first; the application does not supply missing evidence or grant approval simply because a row is marked pending.

1. **Find both the current facts and the archive.** A removed burn no longer appears in `bb_pair_burns`. The following read-only queries associate archived evidence with the affected application, including a payment whose transaction never returned to the canonical chain:

   ```sql
   SELECT a.id, a.code, a.status, a.fee_usd, a.paid_usd, a.created_at,
          a.quote_price_usd, a.quote_at, a.quote_until, a.last_quote_until,
          r.chain_id, r.tx_hash, r.log_index, r.block_number, r.block_time,
          r.block_hash, r.payload, r.usd, r.priced_by
   FROM bb_pair_applications a
   JOIN bb_launch_replay_values r
     ON r.kind = 'pair' AND r.payload->>'application_id' = a.id::text
   WHERE a.payment_reorg
   ORDER BY a.id, r.tx_hash, r.log_index, r.block_number;

   SELECT b.*, c.block_hash
   FROM bb_pair_burns b
   JOIN bb_pair_applications a ON a.id = b.application_id
   LEFT JOIN bb_launch_blocks c
     ON c.chain_id = b.chain_id AND c.block_number = b.block_number
   WHERE a.payment_reorg
   ORDER BY b.application_id, b.tx_hash, b.log_index;
   ```

2. **Verify the payment independently.** Fees are TWIG burns on Base, even when the application lists a pair on another chain. Check the successful canonical receipt, block hash/time, TWIG contract, burn destination, sender, application tag, log index and whole-TWIG amount against `pairBurnFromTransfer` and the original application. Require the canonical burn time to be at or after the application's creation time, and exclude configured locker senders as `pairBurnFromTransfer(skip)` does. Validate the sender against the canonical event; it does not have to be the applicant. The current indexed event must match that receipt. Archive rows describe prior observations; their presence does not prove current canonical inclusion. If the burn is absent, still pending, or has a different application/tag, keep reconciliation blocked and preserve the archive. Never insert an archived event as a new canonical fact.

3. **Establish the historical USD value.** A locked quote is usable only with retained evidence of its price and validity interval covering the canonical burn time. A `live` valuation needs verifiable evidence of the historical price used under the fee policy. Recalculate from the verified whole-TWIG amount and that price using `pairBurnUsd`'s rules; require a finite positive result. Current application quote fields may have been cleared when the original payment consumed the quote, so they are not a substitute for the original quote evidence. Do not infer a new quote window, copy an archive's USD value solely because its hash matches, or use today's market price. Without sufficient evidence, leave `valuation_pending` and `payment_reorg` set.

4. **Apply the reviewed repair atomically.** Pause all application/indexer/payment-review writers and maintenance jobs, take a backup, then use one transaction with the same lock order as `withIndexLock`: the `launch-index:base` advisory lock, the raw-event table locks, the Base cursor row, and the affected application row. Confirm recovery version 1, `rebuilding_until IS NULL`, and the reviewed recovery generation/checkpoint. Recheck the canonical receipt/block before committing; abort if identity, placement or recovery generation changed. Within that transaction:
   - Update only the verified current burn's `usd` and `priced_by` (`quote` or `live` according to the evidence), and set its `valuation_pending` to false. Match the complete reviewed row identity and prior values, and require exactly one affected row. Retain all archive evidence.
   - Recompute the application's `paid_usd` from `COALESCE(sum(usd), 0)` over its **current** `bb_pair_burns`, never from the archive or the previous aggregate. Check every remaining `valuation_pending` row for the application.
   - Clear `payment_reorg` only if no pending valuations remain and the current total meets `fee_usd * (1 - PAIR_FEE_TOLERANCE)` (currently 0.98 of the fee). Otherwise keep it true. A verified but insufficient payment does not authorize another burn or an automatic waiver.
   - Apply the payment-state transitions used by `settleApplication`/rollback: an `open` application meeting the fee may become `paid`, setting `paid_at` if absent; a `paid` application falling below the fee becomes `open` with `paid_at = NULL`. Preserve authored `changes`, `approved`, `rejected` and `expired` decisions, review counts and decision metadata. Normal review APIs still enforce their existing eligibility checks.
   - Using the original application status captured under the row lock, clear an open application's consumed `quote_twig`, `quote_price_usd`, `quote_at` and `quote_until`, before applying any open-to-paid transition, as `valueBurn` does, while preserving `last_quote_until`. Record the before/after rows and evidence in the operator's change record. Roll back the entire transaction on any failed check.

5. **Verify before resuming normal operation.** Read the repaired burn, the recomputed total, the remaining pending valuations and the application's flags/status in the transaction, then verify them again after commit. Resume the current writer version and confirm the application page no longer reports reconciliation only when the above eligibility conditions hold. Approval/listing still goes through the normal signed review flow; this procedure never directly lists a pair. Do not simply clear `valuation_pending` and wait for the background repricer: that would value the payment with a new price, and `revaluePairBurns` intentionally excludes pending valuations.

If the payment was not re-included, or its historical price cannot be verified, this procedure has no successful repair branch. Keep the application blocked with its original transaction evidence for an explicit maintainer resolution; do not erase the reconciliation flags to manufacture eligibility.

## Reproducible verification

| Check | Result |
| --- | --- |
| Complete application unit suite | 1,645 passed, 86 explicit opt-in skips, zero failures |
| Real PostgreSQL recovery suite | 26 passed: 25 scenarios plus the parent suite; includes 24 generated sparse-checkpoint layouts |
| Actual launch/recovery components in Chromium | 16 passed; zero browser errors or external page requests |
| Built Next application with real local PostgreSQL | Six passed: known recovery, unknown 404, rebuild view, atomic re-inclusion, authored metadata preservation and immediate visibility after a prior 404 |
| TypeScript and ESLint | Passed; five pre-existing Open Graph image warnings |
| Production build | Passed; three pre-existing image-storage tracing warnings |

The committed opt-in integration suite uses PostgreSQL, the actual schema and actual indexer, with ABI-encoded synthetic RPC events. Each scenario owns a random schema in an explicitly supplied loopback database. It disables external fetches, performs no wallet operations and compares recovered accounting with an independently populated clean replacement-chain database. The default unit run skips it unless enabled.

From `app`, against a disposable local PostgreSQL instance:

```powershell
$env:RUN_REORG_DB_TESTS = '1'
$env:REORG_TEST_DATABASE_URL = 'postgres://TEST_USER:TEST_PASSWORD@127.0.0.1:TEST_PORT/TEST_DATABASE'
npx tsx --conditions=react-server --tsconfig tsconfig.reorg-db-test.json --test src/lib/launchpad/indexer.reorg.db.test.ts
```

Coverage includes shallow/deep forks, replay idempotency, re-included transactions, hashless legacy recovery and restart, receipt-triggered rollback, orphan routes, retained historical USD values, null-token fees, values beyond JavaScript integer precision, holder reconstruction, cross-chain application payments, repeated unresolved payments, historical points invalidation, actual concurrent writer locking, mid-ingestion forks, stale attribution receipts and injected SQL/RPC failures.

Separate Chromium checks mount the actual launch/recovery components with synthetic wallet and RPC boundaries. They cover failed/limited sync, uncertain receipt, reload, duplicate clicks, no-resend recovery, verified reverts, storage failure and refresh cleanup. These are not real-wallet or mainnet transaction tests.

## Limits

Canonical checks depend on the configured RPC providing honest, consistent block hashes and complete event results. They do not independently verify consensus or prove that a provider did not omit logs. A node behind recorded history fails closed without deleting data based solely on a shorter head. Recovery protects index accounting; it does not reverse on-chain actions or guarantee permanent finality.

No production database, deployed contract, funded wallet or live bridge transfer was modified during verification. This fixes demonstrated accounting failures and adds regression coverage; it does not certify the application as vulnerability-free.
