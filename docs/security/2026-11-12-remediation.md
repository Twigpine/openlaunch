# Application security fixes

Date: 12 November 2026

Scope after the PR split: this report preserves historical evidence from the combined bridge/security branch. Its source references and test counts below describe that original checkout. API disclosure and upload fixes belong to the standalone security PR; CCTP recovery and its bridge tests remain in PR #135. See the [PR split and branch-specific verification](2026-11-12-pr-split.md) for current scope and results.

Baseline: PR #135 at `a21a671bb35a76ae25ca0346ceddf009aa7238d6`.
Work branch: `codex/security-review-fixes`.

## Changes

### Public RPC error disclosure

Metadata failures and both sync exception paths now return fixed public errors. Per-chain sync failures return `sync_failed`. The health endpoint also replaces stored error text with `sync_failed`, including rows written before this fix. Health alerts, block lag, successful responses, validation errors, and metadata conflicts retain their behavior. The safe, generated explanation for a chain that has never been indexed remains available.

This closes public response disclosure of provider URLs, bearer credentials, and internal diagnostic text. Existing private logging and URL-redacted database diagnostics are unchanged. The review did not establish whether production credentials were previously exposed; historical exposure and credential rotation remain an operational follow-up.

### Anonymous upload quota interference

An unsigned wallet field no longer consumes a wallet-specific allowance. Uploads retain the existing 20-attempts-per-hour IP limit and use the shared client-IP helper, which prioritizes the deployment's Fly header and otherwise uses the last forwarded hop. Rotating a wallet value or prepending spoofed forwarding values does not grant another allowance.

The wallet field remains syntactically validated for API compatibility. Image size checks, byte validation, decoding, metadata stripping, random object keys, and logo/banner output are unchanged. Limits remain process-local; trusted-header behavior depends on the deployment ingress.

### CCTP recovery retention

Nonterminal CCTP records cannot be discarded on a timeout. The fresh record is checked again under the wallet lock, so stale UI state cannot bypass this rule. Circle burns have no Relay-style order deadline: even a complete empty scan cannot rule out a later confirmation.

Burn discovery now distinguishes a unique match, ambiguity, no match in a stated block range, and unavailable evidence. Successful scans include their bounds and completeness. Polling still adopts one verified matching burn, and a verified source revert remains a terminal result. Relay recovery and approval recovery retain their existing behavior.

The UI explains why recovery stays saved and provides a source-wallet explorer link when no hash is known. Searches remain bounded, and legacy or new records can lack a source block. Such records can remain blocked when their hash cannot be recovered; this change preserves recovery evidence rather than introducing a manual hash-attachment or unsafe reset flow.

## Regression evidence

Tests use synthetic data and mocked external providers/storage. No real transfers, uploads to a live bucket, or production writes were performed.

- RPC tests exercise the actual metadata, sync, and health handlers. The original implementation failed 13 of 23 checks; all 23 pass after the fix. Cases include a viem transport error, a plain error, thrown strings/objects, legacy health rows, and successful/validation/conflict controls.
- Upload tests exercise the actual multipart route, limiter, image decoder, and storage command. The original implementation failed victim-isolation checks for both invalid and valid uploads, plus a forwarded-header bypass check. The related fixed suite passes 37 tests.
- CCTP tests reproduce missing source blocks, ambiguous matches, out-of-range burns, and a complete empty scan. All four incorrectly permitted discard before the fix; the single-match control blocked it. The fixed bridge suite passes 88 tests, including execution of the actual hook's discard and polling closures against the real journal store.
- The existing admin route coverage test now normalizes path separators, so it checks the same route set on Windows and Linux.

## Validation

| Check | Result |
| --- | --- |
| Full application test suite | 1,511 passed, 84 skipped, 0 failed; no forced exit |
| TypeScript, `npm run typecheck` | Passed |
| ESLint, `npm run lint` | Passed; 5 existing image warnings in Open Graph routes |
| Production build | Passed; 3 existing dynamic-filesystem tracing warnings in image storage |
| Diff whitespace check | Passed |
| Independent source review | No additional actionable issues found in these changes |

Executed locally on Windows with Node 24.19.0 and the committed dependency lockfile. The first production-build attempt stalled in the restricted environment and was stopped; the network-enabled retry compiled and completed successfully. GitHub CI verifies the pushed commit separately on Node 22/Linux. The 84 skipped tests require explicit live-provider opt-in (and a Relay API key for the live history test). The hook tests execute controller closures without mounting React or reproducing browser lock contention. Live settlement, third-party protocol security, contracts, and deployment configuration are outside this fix verification.
