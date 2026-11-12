# Expanded security verification

Date: 12 November 2026

This pass follows the fixes at `91c0b0ae3bfbc2d447d533c6c135de0ce2811e03` on PR #135. It also verifies the changes combined with main `70e4fa2ac1dc18832982f4d7e33ae76b80c077d8`. Results below distinguish source analysis, synthetic execution, real local database/HTTP tests and read-only live-provider checks. Passing them is not a guarantee that no vulnerabilities remain.

## Fixes

### Chain text cannot stall launch indexing

Solidity strings can contain NUL. The actual Viem ABI decoder preserves it, while PostgreSQL text rejects it with SQLSTATE `22021`. A normally submitted factory launch containing that character in its name, symbol or metadata URI could therefore keep the poller retrying the same range without advancing. The metadata-healing path had the same name/symbol problem.

The indexer now removes only NUL at those persistence boundaries, retaining the existing name and symbol length limits. It stores the launch and processes subsequent events normally. It does not catch and skip a launch, advance past failed writes, or alter contract validation. This is a confirmed high-impact availability defect in indexing, not a demonstrated loss of on-chain funds.

Six failures were reproduced using the actual indexer entry points, real Viem ABI encoding/decoding, synthetic chain responses and isolated PostgreSQL. All six checks pass after the fix on both the PR branch and the combined-main source. Three committed runtime regressions cover all poisoned fields, later-event retention, cursor advancement, replay idempotency and metadata healing. Existing quote-token healing already strips NUL. Malformed names in the separate pair-listing flow remain a per-request unsupported-token boundary; no shared indexer impact was established there.

### Replayed signatures cannot drain wallet allowances

Signature verification alone did not establish that an edit or profile request was fresh. Reusing an otherwise valid signed request charged the wallet's allowance before rejecting its consumed nonce. The admin sign-in precheck prevented sequential reuse, but concurrent copies could all pass that read and charge the allowance before only one consumed the nonce.

All three paths now charge the wallet allowance only after atomic nonce consumption succeeds. Signature validation, wallet/admin authorization and the early IP limits remain. A fresh, correctly signed over-quota request consumes its nonce, and the existing clients obtain and sign a new nonce on retry. The edit nonce still shares a transaction with the metadata write, so a failed write rolls it back. Profile/admin nonce use remains separate from the subsequent write, as before.

These are availability issues requiring access to a valid signed payload within its accepted lifetime. They do not establish signature forgery or an attack using only a public wallet address. Old-code regressions reproduced the failures; the fixed branch passes both focused tests and real HTTP checks. An independent differential review checked the history, callers, SQL uniqueness/update predicates, rollback behavior and client retries, with no introduced authorization regression found.

## Executed verification

| Check | Result and boundary |
| --- | --- |
| Full PR application suite | 1,566 passed, 85 skipped, zero failed |
| Application suite combined with current main | 1,607 passed, 85 skipped, zero failed |
| Independent focused auth suite | 41 passed |
| Built Next application, HTTP, PostgreSQL and local EVM | 13 passed: edit/profile/admin signatures, concurrent nonce use, quota replay, username uniqueness, session lifecycle, bounded body and proxy-header accounting |
| Indexer with real PostgreSQL | Six baseline failure reproductions; six post-fix passes in each source tree |
| Actual mounted bridge hook in Chromium | 26 passed, zero page errors, zero external page requests |
| Public Relay quote routes | All 73 routes passed with a paced sweep; authenticated history skipped because no Relay API key is configured |
| Circle read-only live checks | Nine passed |
| Morpho read-only vault check | One passed |
| Contract offline verification | 46 Forge aggregate results passed; includes the previously unselected event suite and new invariant/assumption tests |
| Contract stateful campaign | 32,768 actions, zero unexpected reverts/discards |
| Existing live-fork contract tests | All 40 passed, including nine under official Circle Arc Foundry |
| Deployed executable comparison | Eight factory/locker runtimes and every immutable slot matched the pinned build/records under the documented metadata normalization |
| TypeScript and ESLint | Passed; five existing Open Graph image warnings |
| Production build combined with current main | Passed; three existing image-storage tracing warnings |

The default app suite's skips are explicit live-provider/database opt-ins, not failed tests counted as passes. The PostgreSQL and provider runs above execute separately. Windows tests use Node 24.19.0; GitHub CI checks the pushed commit on Node 22/Linux.

The HTTP harness uses a disposable local database, newly generated test identities, a local Anvil EVM and the built application. It verifies cookie attributes and session behavior, but does not exercise browser cookie enforcement against the production domain. An initial sandboxed HTTP attempt could not reach the local services; the rerun with loopback access passed. A read-only production request observed CSP with a nonce, `object-src 'none'`, `frame-ancestors 'none'`, HSTS and `nosniff`. It does not prove that every deployment path overwrites forwarded headers or that the origin is inaccessible directly.

The browser harness mounts the real React `useBridge` hook with Wagmi, React Query, Viem, browser storage, reloads, Web Locks and two actual tabs. It covers account/chain changes, stale quotes, cancellation, duplicate confirmations, storage failures, approval/deposit races and uncertain-broadcast recovery. Wallet, RPC, Relay and Circle boundaries are synthetic. It is not a full application visual test, a real extension test or evidence of successful mainnet settlement.

The first unpaced Relay sweep hit keyless HTTP 429 responses and one transient rejected response. No quote-safety validation was relaxed. The optional live test now spaces requests by 1.5 seconds; the complete subsequent sweep passed. It still surfaces provider failures rather than retrying until a green result. Authenticated Relay history remains unverified locally.

Full contract methodology, exact blocks/tools, limitations and the reproducible invariant command are in [Contract verification](2026-11-12-contract-verification.md). Existing CI selects only two explicit contract test paths. The expanded offline command was run separately; this PR does not change that workflow. Repository policy requires workflow changes in their own maintainer PR. No deployed source, dependency pin, lock or guard policy changed.

## Strix and static analysis

The expanded Strix v1.7.1 run completed 150 model calls against a sanitized 694-file combined-source snapshot. It independently identified the indexer text issue above. Its proposed high-severity/medium-confidence source finding was confirmed by separate runtime testing before fixing it. A suggested skip-on-error approach was rejected because losing events would corrupt accounting.

The terminal sandbox had no network, provider key or host credentials; only the sanitized source was mounted. The approved Anthropic model connection ran outside it. Strix did not execute the application, wallet, database or live provider flows. Those checks are separate evidence, not capabilities attributed to the source-only scan.

Tracked cost was $6.8245321 for the expanded run and $11.2517602 including the earlier pilot, within the authorized $200 budget. These are configured usage estimates, not a reconciled provider invoice. Low spend is not evidence of either complete or incomplete coverage.

Targeted Semgrep OSS reruns cleared all 18 prior reconstruction-rule timeouts and the React-rule timeout. Five literal JSX-text ampersands still caused parser warnings in exact source; separately hashed audit copies using equivalent `&amp;` text parsed successfully without findings. Product source was not modified for the scanner. One upstream Apiiro rule still fails compilation. Pro cross-file analysis was unavailable without authentication and is not counted as completed. Slither ran 102 detectors; all 32 first-party signals were triaged in the contract report.

Raw reports, source manifests, trace archives, negative-control logs and local integration harnesses are retained in the separate `security-deep-20261112` audit workspace, outside this PR. They contain no funded-wallet activity or production database changes.

## Remaining limits

- Authenticated Relay history needs an API key. Public quotes and mocked history tests cannot substitute for that integration check.
- Canonical-chain reconciliation remains a separate indexer correctness concern. Confirmation margins and overlapping reads are not a proof of rollback/reconciliation after a reorg. This pass does not claim that problem is fixed; its evidence and implementation requirements are retained in the private audit workspace.
- Rate-limit counters remain process-local. The nonce fixes prevent replay charging but do not provide a distributed quota or prove deployment ingress trust.
- Existing immutable contracts retain the documented preinitialization availability and external-token behavior assumptions. No tested principal-withdrawal or reserve-conservation violation was demonstrated; finite tests and bytecode comparisons are not formal proofs.
- Real wallet extensions, mobile/hardware wallets, actual cross-chain settlement, third-party incident behavior, production load limits, historical credential exposure and unknown vulnerabilities remain outside these results.

The verification narrows specific risks and fixes demonstrated failures. It does not certify the whole application as vulnerability-free.
