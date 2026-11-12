# Contract verification — 12 November 2026

This follow-up verifies the immutable launch contracts with their deployed dependency pins. It adds tests, not contract changes. All execution used local EVMs or local forks backed by public read-only RPC calls. No transaction was broadcast, no funded wallet was loaded, and no production state was changed.

## Source and tool identity

- All 12 SHA-256 entries in `contracts/deployed.lock` match the reviewed checkout, including the four source files, compiler configuration, remappings and deployment records.
- `forge-std`: `886b4f8b63409ef474542de6394d25a9b5908ed3`.
- `v4-periphery`: `07336f2144f522874e2c3c85e04d1d3f8d5fa471`.
- Its `v4-core`: `59d3ecf53afa9264a16bba0e38f4c5d2231f80bc`.
- Its Permit2: `cc56ad0f3439c502c246fc5cfcc3db92bb8b7219`.
- Existing populated submodules were verified clean at their pins before being copied into the isolated audit tree. Product dependencies and library pins were not changed.
- Offline verification: upstream Forge `1.8.3`, commit `cae51ad458f6abb64852b7709eb784352429825d`; Solc `0.8.26`, via IR, optimizer 200, Cancun.
- Static analysis: Slither `0.11.6`, installed only in an audit virtual environment.

Raw logs, tool downloads, machine-readable reports and the read-only bytecode comparison script are under the separate audit workspace `security-deep-20261112/contracts-followup/`; they are not product dependencies.

## Offline execution and properties

All 42 pre-existing offline tests passed: 33 factory tests (including both 256-case fuzz tests), two Arc native-quote guard tests and seven event/indexer contract tests. The event suite previously was not selected by CI's two explicit paths.

The final combined run, including the new tests below, passed all five offline suites: Forge 1.8.3 reports 46 results because it groups the two invariant properties into one campaign result. There are 45 ordinary/fuzz test functions and two invariant properties; none failed or skipped.

`contracts/test/LaunchLocker.invariant.t.sol` adds a stateful handler using the real pinned PoolManager, PositionManager and Permit2. Four launches share a locker: two native-quoted positions and two ERC20-quoted positions, with different payout proportions, two changeable recipient behaviors and a burn recipient. The handler performs buys, sells, donations, collections, failure-mode changes, both `claim` and third-party `claimFor`, and unauthorized NFT transfer/approval/principal withdrawal attempts.

The fixed-seed campaign passed **256 sequences × 128 actions = 32,768 handler calls**, with **zero unexpected reverts and zero discarded calls**, seed `0x20261112`. Its properties are:

1. Every position stays owned by the locker, has no approved spender, and retains exactly its initial liquidity.
2. For each of six currencies (native, the quote ERC20 and four launch tokens), `reserved` equals the sum of every modeled recipient's credit. This is stronger than `reserved >= total credits`.
3. The locker balance covers all credits for each currency.
4. Cumulative amounts returned by collection equal recipient balances plus burns plus outstanding credits. Initial launch-token rounding dust at the burn address is excluded.
5. A failed claim leaves the recipient balance, locker balance, credit and reserve unchanged. A successful claim pays exactly the credited account, consumes its full credit and releases exactly that reserve.

A deterministic sequence forces failed native payments, attempted reentrant native payments, ERC20 `false` returns, ERC20 reverts, failed claims, later successful claims, cross-position collections, token/native donations, and withdrawal rejections. It asserts four rejected claims followed by four successful positive claims, avoiding reliance on random selection to reach recovery paths.

The handler does not rewrite locker, pool or NFT storage. Native funding and mintable quote funding are test fixtures. Its ERC20 model assumes conventional balance accounting: no rebase, transfer tax or false success return. Those token behaviors are not established as safe by this campaign. State-space exploration is finite, not a formal proof.

Run the complete offline set from `contracts/` after initializing the pinned submodules:

```sh
FOUNDRY_INVARIANT_FAIL_ON_REVERT=true \
FOUNDRY_INVARIANT_RUNS=256 \
FOUNDRY_INVARIANT_DEPTH=128 \
forge test --no-match-path 'test/*.fork.t.sol' --fuzz-seed 0x20261112 -vv
```

`fail_on_revert=true` is necessary: handler assertions must fail the campaign rather than count as discarded action reverts. Existing fork suites are excluded entirely, because several return early when `FORK_TESTS` is absent; an apparent passing fork without that flag is not live-chain evidence. The Arc guard suite is an ordinary offline test and remains included.

## Confirmed availability and quote assumptions

`contracts/test/LaunchFactory.assumptions.t.sol` contains two finite reproductions of current behavior:

| Behavior | Demonstrated consequence | Boundary |
| --- | --- | --- |
| An unrelated account initializes the v4 pool for a predicted CREATE2 launch-token address before token code exists. | The pending launch reverts with `PoolAlreadyInitialized`. Token creation, position numbering and factory/locker registration roll back. A fresh salt launches successfully. | Availability/gas grief against an exposed prediction; no ownership change or principal theft demonstrated. Simulation cannot guarantee ordering after simulation. |
| An unsupported quote returns a one-byte transfer result for one recipient. | ABI decoding in `_tryPay` reverts the whole collection, including an earlier healthy recipient's payment. Funds remain in the locker and NFT ownership/liquidity are unchanged. Restoring a valid return permits collection. | A malformed return is not treated like a normal `false`/revert result. The latter are covered by the stateful credit/recovery tests. No supported live quote was shown to produce malformed returns. |

These tests document boundaries of already-deployed immutable code. They do not label a malicious/nonstandard quote token as a flaw in a supported quote, and they do not imply a safe in-place contract upgrade exists. Any contract-level behavior change would require a new deployment/version. Caller-selected quotes also retain external issuer/blocklist, balance-accounting and transfer-semantic assumptions.

## Existing non-Arc fork suites

All **31** tests in all existing non-Arc fork suites passed with `FORK_TESTS=true`:

| Suite | Tests | Public fork block |
| --- | ---: | ---: |
| Base factory lifecycle, including USDC | 3 | 56,488,946 |
| Base live locker ownership/approval/principal attempts | 6 | 56,487,518 |
| Robinhood locker and USDG launch | 4 | 112,540,717 |
| Base GITLAWB quote | 1 | 56,488,541–56,488,546 (shared batch) |
| Robinhood GITLAWB quote and bridge wiring | 2 | 112,542,707–112,542,716 (shared batch) |
| Base TWIG quote, payout and unwrap | 3 | 56,488,541–56,488,546 (shared batch) |
| Robinhood AAPL stock quote | 1 | 112,542,707–112,542,716 (shared batch) |
| Elysium factory, HYPE/USDC quotes, lock, both router layouts | 11 | 5,343,192 |

Fork tests locally simulate launches, swaps and collection against fetched chain state. They do not submit these actions to a network. These are snapshots and do not guarantee later issuer or dependency behavior.

## Fresh deployed-code comparison

Read-only `eth_chainId`, `eth_blockNumber` and fixed-block `eth_getCode` calls verified both deployed contracts on each chain:

| Chain | Block | Factory and locker executable comparison | Immutable slots |
| --- | ---: | --- | --- |
| Base | 56,489,591 | Both match | All match deployment record |
| Robinhood | 112,544,782 | Both match | All match deployment record |
| Elysium | 5,345,543 | Both match | All match deployment record |
| Arc | 30,863,382 | Both match, using LaunchFactoryArc | All match deployment record |

The comparison normalizes only compiler-declared immutable byte ranges and exact Solc 0.8.26 IPFS CBOR metadata digests, including embedded LaunchToken metadata. Every full immutable word (including leading zero padding) is then checked separately against the recorded PoolManager, PositionManager, Permit2, factory and locker addresses. All other runtime bytes and runtime lengths must match. This is executable equivalence under those explicitly checked normalizations, not a claim of byte-identical metadata or a fresh source-verification-service attestation. It does not recursively audit deployed Uniswap/Permit2 implementations or every launched token.

## Slither and standards checks

Slither analyzed 59 compiled contracts with 102 detectors, excluding dependency-only findings and test/script paths. It emitted 32 first-party signals: 13 Medium, 14 Low and five Informational; no High. Detector severities are scanner labels, not confirmed exploit severity. Triage:

| Detector | Count | Disposition |
| --- | ---: | --- |
| `incorrect-equality` | 5 | Zero amount and empty-return checks intentionally distinguish no work / ERC20 no-return success; they are not exact target-balance gates. The separate malformed-return boundary above remains real. |
| `uninitialized-local` | 2 | Solidity initializes value-type locals `total` and `settled` to zero. Conservation and recipient validation exercise these accumulators. |
| `unused-return` | 6 | Four `approve` calls target the freshly deployed, fixed OpenZeppelin LaunchToken implementation, which returns true or reverts. Two `initialize` tick returns are unused; input price determines the position. Preinitialization availability is separately reproduced above. |
| `missing-zero-check` | 1 | `launcher` is informational token metadata; the factory passes its nonzero `msg.sender`. No withdrawal authority or recipient is derived from this unchecked constructor argument. |
| `calls-loop` | 8 | Payout recipient count is bounded to seven; native pushes have a 50,000 gas cap and failure credits. Caller-selected `collectMany` size and arbitrary ERC20 execution can still cause gas/revert failures. Collection remains individually callable. |
| `reentrancy-benign` | 2 | Factory calls the fixed trusted v4/Permit2/LaunchToken contracts, with hooks forced to zero. The initial position is token-only; pinned v4 settlement returns early for the zero quote debt. There is no mutable dependency setter or withdrawal authority. Locker payment entry points are guarded. This is not a proof for malicious replacement dependencies supplied to a different factory deployment. |
| `reentrancy-events` | 3 | Two factory event-order signals follow the same trusted path; the locker burn path runs under collection's reentrancy guard. Existing seven-event tests and failure-recovery tests passed. |
| `low-level-calls` | 3 | Deliberate push/claim/burn calls. Native push failure becomes a credit; claim failure rolls back; token ABI assumptions are separately recorded. |
| `too-many-digits` | 2 | Compiler-generated `LaunchToken.creationCode` inside CREATE2 prediction, not an incorrectly typed financial literal. |

The generated `inheritance-graph.dot`, `function-summary` and `vars-and-auth` outputs were reviewed. They show the factory has no inherited authority module, the locker inherits ReentrancyGuard, registration checks `msg.sender == factory`, fee collection/claims are permissionless, and LaunchToken inherits the pinned ERC20/permit implementation. No first-party proxy, `delegatecall`, upgrade function, administrative setter, oracle or randomness source was found. Consequently a proxy upgradeability check has no applicable proxy/implementation pair.

`slither-check-erc` passed the ERC20 surface/event checks and ERC2612 checks for LaunchToken. ERC20 additionally reports the standard allowance-replacement race warning; the token intentionally preserves OpenZeppelin ERC20 approval semantics. This is a user allowance-management property, not an owner-only mint or locker escape. Permit cryptography and replay protection are inherited from the pinned OpenZeppelin implementation; these static checks are not formal cryptographic verification.

Manual review confirmed caller-scoped CREATE2 salt hashing, public metadata rather than private on-chain secrets, zero hooks, fixed single-sided launch construction, bounded supply and recipients, and fee-only `DECREASE_LIQUIDITY(0)` collection. Price formation and launch-order availability remain economic/integration assumptions; these checks do not promise a fair launch price or MEV protection.

## Arc execution

All **nine existing Arc fork tests passed** using [Circle's official Arc Foundry v0.8.0-4 release](https://github.com/circlefin/arc-foundry/releases/tag/v0.8.0-4), bringing the complete existing fork suite to **40 passing tests**. The Linux x86_64 archive's SHA-256 was checked against the official GitHub release digest before execution:

```text
78330505af7dc0d2c9b55fc1aed00d9d063581bb57054949d31ef1c1b4bdbc5e
forge 1.7.1-dev
commit 3e95efaeaaaca64d6ac9c1ee988968683dbd0d22
build 2026-11-02T15:38:59.688300050Z
```

The engine ran from the audit directory in an ephemeral existing Linux container. Its effective configuration was independently checked: `network=arc`, Solc 0.8.26, Cancun, via IR, optimizer 200. `FOUNDRY_PROFILE=arc FORK_TESTS=true` selected the existing suite against `https://rpc.mainnet.arc.io`; no production transaction was submitted. The Arc suite uses local factories against deployed Arc dependencies, and the separate fixed-block bytecode check establishes equivalence of the deployed factory and locker executables.

The nine checks cover native/ERC20 USDC balance aliasing, USDC launch/buy/collect, burning, NFT ownership/liquidity and unauthorized withdrawal attempts, no admin surface, v2 Universal Router decoding, and both sides of the native-quote guard regression. The deliberately unguarded local factory reproduces the reserve-sweep hazard; the actual guarded factory rejects the native-quoted launch and preserves the credited USDC. Upstream Forge was not used to claim Arc USDC transfer correctness.

Remaining limits are finite state exploration, conventional ERC20 accounting assumptions, external issuer/dependency behavior, unpinned latest-state fork timing (apart from the separately pinned bytecode snapshots), and the two documented availability boundaries. No principal-withdrawal or reserve-conservation violation was demonstrated for the deployed configuration and modeled supported-token behavior.
