# Application security follow-up

Date: 12 November 2026

Reviewed PR #135 at `d395b3a2208f834f0dea4dfbe2724edeb4d11a8b` together with main `70e4fa2ac1dc18832982f4d7e33ae76b80c077d8`. GitHub's combined tree was `725aaeeaee5b97dc019af66d6e0fcfcd9e477229`. These changes follow the initial RPC disclosure, upload quota and CCTP retention fixes.

## Remediated behavior

### Atomic posting policy

Concurrent signed requests could both pass the wallet's posting gap and daily quota before either inserted a post. The final policy read, single-use nonce insertion and post insertion now share a PostgreSQL transaction protected by a wallet-specific transaction lock. Wallet addresses are normalized, and the policy applies across chains. Signature and eligibility checks remain outside the lock. A quota refusal retains its nonce; a failed post insert rolls back its nonce.

An isolated PostgreSQL regression reproduces the previous race and verifies the final behavior across separate connections. It also checks the daily cap independently of the short posting gap, rollback and retry, invalid signatures, replay rejection and independent wallets.

### Authenticated reporting allowance

The reporting route previously spent a wallet allowance based on the unsigned wallet field. The allowance is now charged only after signature verification and successful consumption of a fresh nonce. Invalid requests and replays cannot exhaust another wallet's reporting allowance. The early IP limit and the 20-actions-per-minute wallet limit remain in place. A valid over-quota report consumes its nonce; the existing UI signs a fresh nonce on its next attempt.

### Consistent proxy-aware rate limits

Ten remaining routes now use the existing shared client-IP helper. The fallback uses the rightmost proxy-appended forwarding value, so changing a client-supplied prefix does not reset the same client's allowance. This applies to posting, reporting, moderation, edit/nonce, sync, metadata, chart discovery, RPC and presence.

This relies on ingress behavior: Fly must overwrite its client-IP header, or the reverse proxy must append the actual client to the forwarded chain. The helper cannot authenticate arbitrary headers on a directly exposed server. Process-local rate-limit storage remains process-local.

### Known-hash Circle recovery

An older identical Circle burn within the scan range could be adopted while the current wallet-returned transaction hash was unmined. Before replacing a known CCTP hash, recovery now verifies the original and candidate transaction share the same sender and nonce, then applies the existing burn validation. Unavailable or mismatched evidence preserves the current journal. A genuine same-nonce speed-up and settlement of the original hash still work.

This is a recovery-attribution defect with same-wallet/history or stale-head preconditions; the review did not establish an unauthenticated theft path. Hashless recovery remains dependent on bounded scan evidence. Dropped originals and smart-wallet rebundling with a different outer nonce can remain pending when replacement identity cannot be established.

### Merged-tree test compatibility

The RPC error regression fixture now supplies transaction calldata lookup, which main added to receipt processing. This fixes the application CI failure caused by combining the earlier tests with current main, without changing receipt processing itself.

## Verification

| Check | Result |
| --- | --- |
| Application tests on the PR branch plus fixes | 1,522 passed, 85 skipped, 0 failed |
| Application tests combined with current main | 1,563 passed, 85 skipped, 0 failed |
| Isolated PostgreSQL integration checks | 9 passed, 0 failed |
| Actual report-handler regressions | 4 passed; 3 failed against the original implementation |
| Actual bridge recovery-controller checks | 13 passed |
| TypeScript | Passed |
| ESLint | No errors; 5 existing Open Graph image warnings |
| Production build combined with current main | Passed; 3 existing image-storage tracing warnings |

Executed on Windows with Node 24.19.0. The merged production build used a dedicated locked dependency install; an initial attempt with a shared dependency junction failed Turbopack's filesystem boundary and was replaced by that install. GitHub CI separately verifies Node 22/Linux after push. The skipped tests comprise existing live-provider checks and the new explicit PostgreSQL opt-in test.

The PostgreSQL test requires an explicitly configured loopback `POSTS_TEST_DATABASE_URL` and `RUN_POSTS_DB_TESTS=1`. Run it from `app` with:

```sh
node node_modules/tsx/dist/cli.mjs --conditions=react-server --tsconfig tsconfig.posts-db-test.json --test src/lib/launchpad/postsServer.db.test.ts
```

It creates and removes only a randomly named test schema. Test adapters replace the external chain client while retaining real EOA signature verification and PostgreSQL transactions. No production database, funded wallet, live storage or transfer was used.

## Scanner evidence and limits

Semgrep 1.184.0 scanned a read-only combined-source snapshot using the installed Trail of Bits workflow, with telemetry disabled. Fifteen configurations completed; the generic YAML configuration failed to load, and the Next.js-specific configuration scanned no files. Applicable JavaScript, TypeScript, React, Node, secrets, GitHub Actions, Python, Docker and third-party rules were included. Rule timeouts and partial parsing remain coverage gaps, including Docker and several TSX files. The 190 deduplicated matches were reviewed as test harness patterns, formatting/performance preferences or false positives; none established an additional actionable vulnerability. No product suppressions were added.

The dependency collector assessed 30 direct and 513 registry-verified transitive packages at locked versions and reported no known advisories. Publisher and repository metadata coverage was partial; maintenance/concentration signals are not confirmed vulnerabilities. Transitive install scripts were not assessed.

These checks do not certify the application or deployed contracts. Deployment ingress, historical credential exposure, third-party protocols, live settlement, full contract invariant campaigns and unknown vulnerabilities remain outside the demonstrated results. Deployed contract sources, dependency pins and CI policy were not changed.
