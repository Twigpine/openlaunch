# Canonical index recovery

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
