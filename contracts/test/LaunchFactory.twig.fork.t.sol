// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {LaunchFactory} from "src/LaunchFactory.sol";
import {LaunchLocker} from "src/LaunchLocker.sol";
import {LaunchToken} from "src/LaunchToken.sol";

interface IERC20Meta {
    function decimals() external view returns (uint8);
    function symbol() external view returns (string memory);
    function totalSupply() external view returns (uint256);
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
    function transfer(address, uint256) external returns (bool);
}

/// TWIG, Twigpine's 1:1 GITLAWB wrapper (OpenZeppelin ERC20Wrapper, no owner).
interface ITwig is IERC20Meta {
    function underlying() external view returns (address);
    function depositFor(address account, uint256 value) external returns (bool);
    function withdrawTo(address account, uint256 value) external returns (bool);
}

/// Can a launch be quoted in TWIG (the quote the Base form offers in GITLAWB's place)? Against the LIVE Base factory
/// and the LIVE TWIG contract: GITLAWB is borrowed from the Uniswap v4 PoolManager via prank and wrapped 1:1 into
/// TWIG with the real depositFor. Then a token is launched priced in TWIG, bought with TWIG, sold back, and its fees
/// collected: burned as TWIG with no beneficiary, paid in TWIG to a named one (who can unwrap them to GITLAWB 1:1).
/// No mocks anywhere; TWIG stays fully backed throughout.
///   FORK_TESTS=true BASE_RPC_URL=… forge test --match-contract LaunchTwigQuote -vv
contract LaunchTwigQuote is Test {
    address constant FACTORY = 0x815542E8b392389A1389E22E588E4B62A67Ade72;
    address constant LOCKER = 0xcd1680D26922fcd9CabFbb8a56bA40C333fD842a;
    address constant PM = 0x498581fF718922c3f8e6A244956aF099B2652b2b;
    address constant GITLAWB = 0x5F980Dcfc4c0fa3911554cf5ab288ed0eb13DBa3; // Gitlawb (18 dec)
    address constant TWIG = 0x6aC18bcf4eDE02591d4917452700ea5eaAea13c1; // Twigpine (18 dec), 1:1 GITLAWB wrapper
    address constant DEAD = 0x000000000000000000000000000000000000dEaD;

    bool forked;
    LaunchFactory factory = LaunchFactory(FACTORY);
    PoolSwapTest router;
    address creator = makeAddr("twig-creator");
    address buyer = makeAddr("twig-buyer");

    function setUp() public {
        if (!vm.envOr("FORK_TESTS", false)) return;
        vm.createSelectFork(vm.envOr("BASE_RPC_URL", string("https://mainnet.base.org")));
        forked = true;
        router = new PoolSwapTest(IPoolManager(PM));
        vm.deal(creator, 1 ether);
        vm.deal(buyer, 1 ether);
        // borrow 200M GITLAWB (~$4.5K at $2.3e-5) from the PoolManager and wrap it into TWIG, 1:1, with the real wrapper
        uint256 pmBal = IERC20Meta(GITLAWB).balanceOf(PM);
        assertGt(pmBal, 200_000_000e18, "PoolManager holds GITLAWB (the v4 WETH/GITLAWB pool)");
        vm.prank(PM);
        IERC20Meta(GITLAWB).transfer(buyer, 200_000_000e18);
        vm.startPrank(buyer);
        IERC20Meta(GITLAWB).approve(TWIG, 200_000_000e18);
        assertTrue(ITwig(TWIG).depositFor(buyer, 200_000_000e18));
        vm.stopPrank();
        assertEq(IERC20Meta(TWIG).balanceOf(buyer), 200_000_000e18, "wrapped 1:1");
    }

    /// TWIG is fully backed: it holds at least one GITLAWB per TWIG. Not equality: GITLAWB sent straight to the
    /// wrapper (no deposit) over-backs it until someone recovers it, and that must not fail the test.
    function _assertBacked() internal view {
        assertLe(
            IERC20Meta(TWIG).totalSupply(), IERC20Meta(GITLAWB).balanceOf(TWIG), "every TWIG backed by one GITLAWB"
        );
    }

    function _launch(string memory name, string memory symbol, LaunchLocker.Recipient[] memory recipients)
        internal
        returns (address token, uint256 tokenId, PoolKey memory key)
    {
        LaunchFactory.LaunchParams memory p;
        p.name = name;
        p.symbol = symbol;
        p.quote = TWIG;
        p.lpFee = 10_000;
        // 1B supply at an FDV of 600M TWIG (≈ $14k): tokens per TWIG = 1e9/6e8 ≈ 1.667 → tick ≈ 5,108 → 5,200
        p.startTick = 5_200;
        p.recipients = recipients;
        (bytes32 salt,) = factory.findSalt(creator, keccak256(bytes(symbol)), p.name, p.symbol, 0, "", TWIG, 64);
        p.salt = salt;
        vm.prank(creator);
        (token, tokenId) = factory.launch(p);
        assertGt(uint160(token), uint160(TWIG), "token sorts above the quote");
        key = factory.poolKeyOf(token);
        assertEq(Currency.unwrap(key.currency0), TWIG, "TWIG is the pool's currency0");
    }

    /// Buy with 100M TWIG, then sell half the tokens back for TWIG.
    function _buyThenSellHalf(address token, PoolKey memory key) internal {
        vm.startPrank(buyer);
        IERC20Meta(TWIG).approve(address(router), 100_000_000e18);
        router.swap(
            key,
            SwapParams({
                zeroForOne: true, amountSpecified: -100_000_000e18, sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
        uint256 got = LaunchToken(token).balanceOf(buyer);
        assertGt(got, 100_000_000e18, "more than 100M tokens for 100M TWIG at about 1.6 tokens per TWIG");
        LaunchToken(token).approve(address(router), got / 2);
        uint256 twigBefore = IERC20Meta(TWIG).balanceOf(buyer);
        router.swap(
            key,
            SwapParams({
                zeroForOne: false, amountSpecified: -int256(got / 2), sqrtPriceLimitX96: TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
        vm.stopPrank();
        assertGt(IERC20Meta(TWIG).balanceOf(buyer), twigBefore, "got TWIG back");
    }

    function test_fork_twigIsThePlainWrapperWeExpect() public view {
        if (!forked) return;
        assertEq(IERC20Meta(TWIG).decimals(), 18);
        assertEq(IERC20Meta(TWIG).symbol(), "TWIG");
        assertEq(ITwig(TWIG).underlying(), GITLAWB);
        _assertBacked();
    }

    function test_fork_launchQuotedInTWIG_buySellBurn() public {
        if (!forked) return;
        // recipients empty = fees burned
        (address token, uint256 tokenId, PoolKey memory key) =
            _launch("Twig Fan Token", "TWIGFAN", new LaunchLocker.Recipient[](0));
        uint256 deadBefore = IERC20Meta(TWIG).balanceOf(DEAD);
        _buyThenSellHalf(token, key);

        // fees: 1% of the TWIG that came in, burned (no beneficiary) → lands at 0x…dEaD as TWIG
        (uint256 quoteOut,) = LaunchLocker(payable(LOCKER)).collect(tokenId);
        assertApproxEqRel(quoteOut, 1_000_000e18, 2e16, "about 1% of 100M TWIG collected");
        assertEq(IERC20Meta(TWIG).balanceOf(DEAD) - deadBefore, quoteOut, "every collected TWIG fee was burned");
        assertEq(IERC20Meta(TWIG).balanceOf(creator), 0, "creator got nothing: no beneficiary");
        _assertBacked();
    }

    function test_fork_launchQuotedInTWIG_feesPaidInTWIG_unwrapToGITLAWB() public {
        if (!forked) return;
        LaunchLocker.Recipient[] memory to = new LaunchLocker.Recipient[](1);
        to[0] = LaunchLocker.Recipient({payout: creator, bps: 10_000});
        (address token, uint256 tokenId, PoolKey memory key) = _launch("Twig Builder Token", "TWIGBLD", to);
        uint256 deadBefore = IERC20Meta(TWIG).balanceOf(DEAD);
        _buyThenSellHalf(token, key);

        (uint256 quoteOut,) = LaunchLocker(payable(LOCKER)).collect(tokenId);
        assertApproxEqRel(quoteOut, 1_000_000e18, 2e16, "about 1% of 100M TWIG collected");
        assertEq(IERC20Meta(TWIG).balanceOf(creator), quoteOut, "the named beneficiary got every collected TWIG fee");
        assertEq(IERC20Meta(TWIG).balanceOf(DEAD), deadBefore, "nothing burned when a beneficiary is named");

        // the fee is real GITLAWB: the beneficiary unwraps it 1:1, no fee
        uint256 glBefore = IERC20Meta(GITLAWB).balanceOf(creator);
        vm.prank(creator);
        assertTrue(ITwig(TWIG).withdrawTo(creator, quoteOut));
        assertEq(IERC20Meta(GITLAWB).balanceOf(creator) - glBefore, quoteOut, "unwrapped 1:1 to GITLAWB");
        assertEq(IERC20Meta(TWIG).balanceOf(creator), 0);
        _assertBacked();
    }
}
