// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, Vm} from "forge-std/Test.sol";
import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {PositionManager} from "@uniswap/v4-periphery/src/PositionManager.sol";
import {IPositionManager} from "@uniswap/v4-periphery/src/interfaces/IPositionManager.sol";
import {IPositionDescriptor} from "@uniswap/v4-periphery/src/interfaces/IPositionDescriptor.sol";
import {IWETH9} from "@uniswap/v4-periphery/src/interfaces/external/IWETH9.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";
import {DeployPermit2} from "permit2/test/utils/DeployPermit2.sol";

import {QuoteLaunchFactory} from "src/QuoteLaunchFactory.sol";
import {QuoteFeeHook} from "src/QuoteFeeHook.sol";
import {QuoteFeeVault} from "src/QuoteFeeVault.sol";
import {HookMiner} from "@uniswap/v4-periphery/test/shared/HookMiner.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {CustomRevert} from "@uniswap/v4-core/src/libraries/CustomRevert.sol";
import {V4Quoter} from "@uniswap/v4-periphery/src/lens/V4Quoter.sol";
import {IV4Quoter} from "@uniswap/v4-periphery/src/interfaces/IV4Quoter.sol";
import {LaunchLocker} from "src/LaunchLocker.sol";
import {LaunchToken} from "src/LaunchToken.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";

contract QuoteBadToken is MockERC20 {
    bool public reject;
    address public immutable payoutSender;

    constructor(address sender) MockERC20("Quote", "QUOTE", 6) {
        payoutSender = sender;
    }

    function setReject(bool value) external {
        reject = value;
    }

    function transfer(address to, uint256 amount) public override returns (bool) {
        super.transfer(to, amount);
        return !(reject && msg.sender == payoutSender); // payout moves funds and then returns false
    }
}

contract QuoteReentrant {
    QuoteFeeVault public vault;
    uint256 public id;

    function configure(QuoteFeeVault v, uint256 i) external {
        vault = v;
        id = i;
    }

    receive() external payable {
        vault.collect(id);
    }
}

contract QuoteCanReceive {
    bool public reject = true;

    function allow() external {
        reject = false;
    }

    receive() external payable {
        require(!reject);
    }
}

contract QuoteGasConsumer {
    receive() external payable {
        assembly {
            for {} 1 {} {}
        }
    }
}

/// @dev A recipient that rejects underfunded calls and can spend gas before another recipient is paid.
contract QuoteGasRequirement {
    uint256 private immutable _work;

    constructor(uint256 work) {
        _work = work;
    }

    receive() external payable {
        require(gasleft() >= 180_000, "payout underfunded");
        uint256 until = gasleft() - _work;
        while (gasleft() > until) {}
    }
}

contract QuoteFeesTest is Test, DeployPermit2 {
    using StateLibrary for IPoolManager;
    using PoolIdLibrary for PoolKey;

    IPoolManager manager;
    IAllowanceTransfer permit2;
    PositionManager posm;
    PoolSwapTest swapRouter;
    QuoteLaunchFactory factory;
    LaunchLocker locker;
    QuoteFeeVault vault;
    QuoteFeeHook hook;

    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address buyer = makeAddr("buyer");

    // 1 ETH = 100M tokens (both 18 dec) → tick ≈ 184,200; 1B supply ≈ 10 ETH FDV
    int24 constant START_TICK = 184_200;
    uint24 constant LP_FEE = 10_000; // 1%

    receive() external payable {}

    function setUp() public {
        manager = IPoolManager(address(new PoolManager(address(this))));
        permit2 = IAllowanceTransfer(deployPermit2());
        posm = new PositionManager(manager, permit2, 50_000, IPositionDescriptor(address(0)), IWETH9(address(0)));
        swapRouter = new PoolSwapTest(manager);
        address predictedFactory = vm.computeCreateAddress(address(this), vm.getNonce(address(this)));
        address predictedVault = vm.computeCreateAddress(predictedFactory, 2);
        (, bytes32 hookSalt) = HookMiner.find(
            predictedFactory,
            uint160(
                Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG
                    | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG
            ),
            type(QuoteFeeHook).creationCode,
            abi.encode(manager, predictedFactory, predictedVault)
        );
        factory = new QuoteLaunchFactory(manager, posm, permit2, hookSalt);
        vault = factory.vault();
        hook = factory.hook();
        locker = factory.locker();
        vm.deal(buyer, 100 ether);
    }

    // ── helpers ──────────────────────────────────────────────────────────────

    function _recipients() internal view returns (LaunchLocker.Recipient[] memory r) {
        r = new LaunchLocker.Recipient[](2);
        r[0] = LaunchLocker.Recipient(alice, 6_000);
        r[1] = LaunchLocker.Recipient(bob, 4_000);
    }

    function _params(bytes32 salt, LaunchLocker.Recipient[] memory r)
        internal
        pure
        returns (QuoteLaunchFactory.LaunchParams memory p)
    {
        p.name = "Trend Coin";
        p.symbol = "TREND";
        p.metadataURI = "ipfs://meta";
        p.supply = 0;
        p.startTick = START_TICK;
        p.creatorFeePips = LP_FEE;
        p.salt = salt;
        p.recipients = r;
    }

    function _launch(bytes32 salt) internal returns (address token, uint256 tokenId) {
        return factory.launch(_params(salt, _recipients()));
    }

    function _key(address token) internal view returns (PoolKey memory) {
        return factory.poolKeyOf(token);
    }

    function _buy(address token, uint256 ethIn) internal returns (BalanceDelta) {
        PoolKey memory key = _key(token);
        vm.prank(buyer);
        return swapRouter.swap{value: ethIn}(
            key,
            SwapParams({
                zeroForOne: true, amountSpecified: -int256(ethIn), sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
    }

    function _sell(address token, uint256 tokenIn) internal returns (BalanceDelta) {
        PoolKey memory key = _key(token);
        vm.startPrank(buyer);
        LaunchToken(token).approve(address(swapRouter), tokenIn);
        BalanceDelta d = swapRouter.swap(
            key,
            SwapParams({
                zeroForOne: false, amountSpecified: -int256(tokenIn), sqrtPriceLimitX96: TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
        vm.stopPrank();
        return d;
    }

    function test_launchLockedAndFixed() public {
        (address token, uint256 id) = _launch("locked");
        PoolKey memory key = _key(token);
        assertEq(key.fee, 0);
        assertEq(address(key.hooks), address(hook));
        assertEq(posm.ownerOf(id), address(locker));
        assertGt(posm.getPositionLiquidity(id), 0);
        assertEq(vault.quoteOf(id), address(0));
        vm.expectRevert();
        posm.transferFrom(address(locker), buyer, id);
    }

    function test_buyAndSellOnlyPayQuote() public {
        (address token, uint256 id) = _launch("both");
        _buy(token, 1 ether);
        assertEq(vault.pendingFees(id), 0.01 ether);
        uint256 amount = LaunchToken(token).balanceOf(buyer) / 2;
        uint256 beforeFees = vault.pendingFees(id);
        BalanceDelta d = _sell(token, amount);
        uint256 sellFee = vault.pendingFees(id) - beforeFees;
        assertGt(sellFee, 0);
        assertApproxEqAbs(sellFee, uint256(uint128(d.amount0())) / 99, 1);
        (uint256 paid, uint256 tokens) = vault.collect(id);
        assertEq(tokens, 0);
        assertEq(alice.balance + bob.balance, paid);
        assertEq(LaunchToken(token).balanceOf(alice), 0);
        assertEq(manager.balanceOf(address(vault), 0), 0);
        assertEq(vault.pendingFees(id), 0);
        (uint256 again,) = vault.collect(id);
        assertEq(again, 0);
    }

    function test_exactOutputBuyAndSell() public {
        (address token, uint256 id) = _launch("exactout");
        uint256 tokens = 1_000_000e18;
        PoolKey memory key = _key(token);
        vm.prank(buyer);
        BalanceDelta d = swapRouter.swap{value: 1 ether}(
            key,
            SwapParams(true, int256(tokens), TickMath.MIN_SQRT_PRICE + 1),
            PoolSwapTest.TestSettings(false, false),
            ""
        );
        assertEq(LaunchToken(token).balanceOf(buyer), tokens);
        uint256 buyFee = vault.pendingFees(id);
        assertGt(buyFee, 0);
        assertApproxEqAbs(buyFee, uint256(uint128(-d.amount0())) / 100, 1);
        vm.startPrank(buyer);
        LaunchToken(token).approve(address(swapRouter), tokens);
        d = swapRouter.swap(
            _key(token),
            SwapParams(false, int256(0.001 ether), TickMath.MAX_SQRT_PRICE - 1),
            PoolSwapTest.TestSettings(false, false),
            ""
        );
        vm.stopPrank();
        assertEq(d.amount0(), int128(0.001 ether));
        assertEq(vault.pendingFees(id) - buyFee, hook.feeAmount(0.001 ether, 10_000, true));
    }

    function test_quoterIncludesHookFeeAndRollsBack() public {
        (address token, uint256 id) = _launch("quoter");
        V4Quoter q = new V4Quoter(manager);
        (uint256 quote,) = q.quoteExactInputSingle(IV4Quoter.QuoteExactSingleParams(_key(token), true, 1 ether, ""));
        assertEq(vault.pendingFees(id), 0);
        assertEq(manager.balanceOf(address(vault), 0), 0);
        BalanceDelta d = _buy(token, 1 ether);
        assertEq(quote, uint256(uint128(d.amount1())));
    }

    function test_partialFillRollsBackBeforeFee() public {
        (address token, uint256 id) = _launch("partial");
        PoolKey memory key = _key(token);
        vm.expectRevert();
        vm.prank(buyer);
        swapRouter.swap{value: 1 ether}(
            key,
            SwapParams(true, -int256(1 ether), TickMath.getSqrtPriceAtTick(START_TICK - 200)),
            PoolSwapTest.TestSettings(false, false),
            ""
        );
        assertEq(vault.pendingFees(id), 0);
        assertEq(manager.balanceOf(address(vault), 0), 0);
    }

    function test_zeroFillSellCannotMovePrice() public {
        (address token,) = _launch("zero-fill");
        PoolKey memory key = _key(token);
        (uint160 priceBefore,,,) = manager.getSlot0(key.toId());
        // No quote in the pool yet: a sell fills nothing and would only drag the price to its limit.
        vm.expectRevert(
            abi.encodeWithSelector(
                CustomRevert.WrappedError.selector,
                address(hook),
                IHooks.afterSwap.selector,
                abi.encodeWithSelector(QuoteFeeHook.PartialFillUnsupported.selector),
                abi.encodeWithSelector(Hooks.HookCallFailed.selector)
            )
        );
        vm.prank(buyer);
        swapRouter.swap(
            key,
            SwapParams(false, -int256(1 ether), TickMath.MAX_SQRT_PRICE - 1),
            PoolSwapTest.TestSettings(false, false),
            ""
        );
        (uint160 priceAfter,,,) = manager.getSlot0(key.toId());
        assertEq(priceAfter, priceBefore);
    }

    function test_sharedQuotePoolsCannotCollectEachOther() public {
        (address a, uint256 aId) = _launch("a");
        (address b, uint256 bId) = _launch("b");
        _buy(a, 1 ether);
        _buy(b, 2 ether);
        vault.collect(aId);
        assertEq(vault.pendingFees(bId), 0.02 ether);
        assertEq(manager.balanceOf(address(vault), 0), 0.02 ether);
        vault.collect(bId);
        assertEq(alice.balance + bob.balance, 0.03 ether);
    }

    function test_failedPayoutCreditCanBeClaimed() public {
        QuoteCanReceive r = new QuoteCanReceive();
        LaunchLocker.Recipient[] memory recipients = new LaunchLocker.Recipient[](2);
        recipients[0] = LaunchLocker.Recipient(address(r), 5000);
        recipients[1] = LaunchLocker.Recipient(bob, 5000);
        (address token, uint256 id) = factory.launch(_params("credit", recipients));
        _buy(token, 1 ether);
        vault.collect(id);
        assertEq(vault.claimable(id, address(r)), 0.005 ether);
        assertEq(vault.reserved(address(0)), 0.005 ether);
        assertEq(bob.balance, 0.005 ether);
        r.allow();
        vault.claimFor(id, address(r));
        assertEq(address(r).balance, 0.005 ether);
        assertEq(vault.reserved(address(0)), 0);
        assertEq(vault.claimable(id, address(r)), 0);
        assertEq(vault.claimFor(id, address(r)), 0);
    }

    function test_burnAndPartialSplit() public {
        LaunchLocker.Recipient[] memory recipients = new LaunchLocker.Recipient[](2);
        recipients[0] = LaunchLocker.Recipient(alice, 6000);
        recipients[1] = LaunchLocker.Recipient(vault.DEAD(), 4000);
        (address token, uint256 id) = factory.launch(_params("burn", recipients));
        _buy(token, 1 ether);
        uint256 beforeDead = vault.DEAD().balance;
        vault.collect(id);
        assertEq(alice.balance, 0.006 ether);
        assertEq(vault.DEAD().balance - beforeDead, 0.004 ether);
    }

    function test_emptyRecipientsBurnAll() public {
        (address token, uint256 id) = factory.launch(_params("empty", new LaunchLocker.Recipient[](0)));
        _buy(token, 1 ether);
        uint256 beforeDead = vault.DEAD().balance;
        vault.collect(id);
        assertEq(vault.DEAD().balance - beforeDead, 0.01 ether);
    }

    function test_unexpectedBalancesAreNotRevenue() public {
        (address token, uint256 id) = _launch("gift");
        vm.deal(address(vault), 1 ether);
        _buy(token, 1 ether);
        vault.collect(id);
        assertEq(alice.balance + bob.balance, 0.01 ether);
        assertEq(address(vault).balance, 1 ether);
    }

    function test_zeroFee() public {
        QuoteLaunchFactory.LaunchParams memory p = _params("free", _recipients());
        p.creatorFeePips = 0;
        (address token, uint256 id) = factory.launch(p);
        _buy(token, 1 ether);
        _sell(token, LaunchToken(token).balanceOf(buyer) / 2);
        assertEq(vault.pendingFees(id), 0);
        (uint256 q, uint256 t) = vault.collect(id);
        assertEq(q + t, 0);
    }

    function test_unauthorizedCalls() public {
        vm.expectRevert(QuoteFeeVault.NotHook.selector);
        vault.accrue(PoolId.wrap(bytes32(0)), 1);
        vm.expectRevert(QuoteFeeVault.NotSelf.selector);
        vault.executePayout(address(0), buyer, 1);
        vm.expectRevert(QuoteFeeVault.NotPoolManager.selector);
        vault.unlockCallback("");
        vm.expectRevert(QuoteFeeHook.NotFactory.selector);
        hook.activate(PoolId.wrap(bytes32(0)));
    }

    function test_arcNativeQuoteRejected() public {
        vm.chainId(5042);
        vm.expectRevert(QuoteLaunchFactory.NativeQuoteUnsupported.selector);
        factory.launch(_params("arc", _recipients()));
    }

    function testFuzz_buyFeeAndAllocation(uint96 input, uint16 share) public {
        uint256 amount = bound(uint256(input), 1000, 10 ether);
        uint16 bps = uint16(bound(share, 1, 9999));
        LaunchLocker.Recipient[] memory r = new LaunchLocker.Recipient[](2);
        r[0] = LaunchLocker.Recipient(alice, bps);
        r[1] = LaunchLocker.Recipient(bob, 10000 - bps);
        (address token, uint256 id) = factory.launch(_params("fuzz", r));
        _buy(token, amount);
        uint256 fee = amount / 100;
        assertEq(vault.pendingFees(id), fee);
        vault.collect(id);
        assertEq(alice.balance, fee * bps / 10000);
        assertEq(alice.balance + bob.balance, fee);
    }

    function _erc20Launch(bytes32 salt, LaunchLocker.Recipient[] memory recipients)
        internal
        returns (QuoteBadToken quote, address token, uint256 id)
    {
        QuoteBadToken implementation = new QuoteBadToken(address(vault));
        vm.etch(address(0x10000), address(implementation).code);
        quote = QuoteBadToken(address(0x10000));
        QuoteLaunchFactory.LaunchParams memory p = _params(salt, recipients);
        p.quote = address(quote);
        p.startTick = 391_400;
        (p.salt,) = factory.findSalt(address(this), salt, p.name, p.symbol, 0, p.metadataURI, p.quote, 64);
        (token, id) = factory.launch(p);
        quote.mint(buyer, 1000e6);
    }

    function _buyQuote(QuoteBadToken quote, address token, uint256 amount) internal {
        PoolKey memory key = _key(token);
        vm.startPrank(buyer);
        quote.approve(address(swapRouter), amount);
        swapRouter.swap(
            key,
            SwapParams(true, -int256(amount), TickMath.MIN_SQRT_PRICE + 1),
            PoolSwapTest.TestSettings(false, false),
            ""
        );
        vm.stopPrank();
    }

    function test_erc20QuoteBuySellCollect() public {
        (QuoteBadToken quote, address token, uint256 id) = _erc20Launch("erc20", _recipients());
        _buyQuote(quote, token, 100e6);
        assertEq(vault.pendingFees(id), 1e6);
        _sell(token, LaunchToken(token).balanceOf(buyer) / 2);
        uint256 pending = vault.pendingFees(id);
        assertGt(pending, 1e6);
        uint256 liquidity = posm.getPositionLiquidity(id);
        vault.collect(id);
        assertEq(quote.balanceOf(alice) + quote.balanceOf(bob), pending);
        assertEq(LaunchToken(token).balanceOf(alice) + LaunchToken(token).balanceOf(bob), 0);
        assertEq(posm.getPositionLiquidity(id), liquidity);
        assertEq(manager.balanceOf(address(vault), uint160(address(quote))), 0);
    }

    function test_falseReturnAfterTransferCreditsWithoutDoublePay() public {
        (QuoteBadToken quote, address token, uint256 id) = _erc20Launch("false", _recipients());
        _buyQuote(quote, token, 100e6);
        quote.setReject(true);
        vault.collect(id);
        assertEq(quote.balanceOf(alice) + quote.balanceOf(bob), 0);
        assertEq(quote.balanceOf(address(vault)), 1e6);
        assertEq(vault.claimable(id, alice), 600000);
        assertEq(vault.reserved(address(quote)), 1e6);
        vm.expectRevert();
        vault.claimFor(id, alice);
        assertEq(vault.claimable(id, alice), 600000);
        quote.setReject(false);
        vault.claimFor(id, alice);
        vault.claimFor(id, bob);
        assertEq(quote.balanceOf(alice) + quote.balanceOf(bob), 1e6);
        assertEq(vault.reserved(address(quote)), 0);
    }

    function test_failedBurnRevertsWholeCollection() public {
        (QuoteBadToken quote, address token, uint256 id) = _erc20Launch("burn-fail", new LaunchLocker.Recipient[](0));
        _buyQuote(quote, token, 100e6);
        quote.setReject(true);
        vm.expectRevert();
        vault.collect(id);
        assertEq(vault.pendingFees(id), 1e6);
        assertEq(quote.balanceOf(address(vault)), 0);
        assertEq(manager.balanceOf(address(vault), uint160(address(quote))), 1e6);
    }

    function test_reentrantRecipientCannotConsumeOtherFees() public {
        QuoteReentrant r = new QuoteReentrant();
        LaunchLocker.Recipient[] memory recipients = new LaunchLocker.Recipient[](2);
        recipients[0] = LaunchLocker.Recipient(address(r), 5000);
        recipients[1] = LaunchLocker.Recipient(bob, 5000);
        (address token, uint256 id) = factory.launch(_params("reenter", recipients));
        r.configure(vault, id);
        _buy(token, 1 ether);
        vault.collect(id);
        assertEq(vault.claimable(id, address(r)), 0.005 ether);
        assertEq(bob.balance, 0.005 ether);
        assertEq(address(vault).balance, vault.reserved(address(0)));
    }

    function test_hookFlagsAndImmutables() public view {
        assertEq(uint160(address(hook)) & Hooks.ALL_HOOK_MASK, hook.HOOK_FLAGS());
        assertEq(address(hook.vault()), address(vault));
        assertEq(vault.hook(), address(hook));
        assertEq(hook.factory(), address(factory));
        assertEq(vault.factory(), address(factory));
    }

    function test_protocolFeesRemainSeparate() public {
        (address token, uint256 id) = _launch("protocol");
        manager.setProtocolFeeController(address(this));
        manager.setProtocolFee(_key(token), uint24(1000 | (1000 << 12)));
        _buy(token, 1 ether);
        assertEq(vault.pendingFees(id), 0.01 ether);
        assertGt(manager.protocolFeesAccrued(Currency.wrap(address(0))), 0);
        _sell(token, LaunchToken(token).balanceOf(buyer) / 2);
        assertGt(manager.protocolFeesAccrued(Currency.wrap(token)), 0);
        uint256 pending = vault.pendingFees(id);
        vault.collect(id);
        assertEq(alice.balance + bob.balance, pending);
    }

    function test_gasConsumingRecipientGetsCreditWhileOthersArePaid() public {
        QuoteGasConsumer receiver = new QuoteGasConsumer();
        LaunchLocker.Recipient[] memory r = new LaunchLocker.Recipient[](2);
        r[0] = LaunchLocker.Recipient(address(receiver), 5000);
        r[1] = LaunchLocker.Recipient(bob, 5000);
        (address token, uint256 id) = factory.launch(_params("gas", r));
        _buy(token, 1 ether);
        vault.collect(id);
        assertEq(vault.claimable(id, address(receiver)), 0.005 ether);
        assertEq(bob.balance, 0.005 ether);
        assertEq(address(vault).balance, vault.reserved(address(0)));
    }

    function test_underfundedCollectCannotForceNativeCredit() public {
        QuoteGasRequirement receiver = new QuoteGasRequirement(0);
        LaunchLocker.Recipient[] memory r = new LaunchLocker.Recipient[](1);
        r[0] = LaunchLocker.Recipient(address(receiver), 10_000);
        (address token, uint256 id) = factory.launch(_params("low-gas-native", r));
        _buy(token, 1 ether);

        (bool ok, bytes memory reason) = address(vault).call{gas: 180_000}(abi.encodeCall(vault.collect, (id)));
        assertFalse(ok, "underfunded collection must revert instead of creating a credit");
        assertEq(reason, abi.encodeWithSelector(QuoteFeeVault.TransferFailed.selector));
        assertEq(vault.pendingFees(id), 0.01 ether);
        assertEq(manager.balanceOf(address(vault), 0), 0.01 ether);
        assertEq(vault.claimable(id, address(receiver)), 0);
        assertEq(vault.reserved(address(0)), 0);
        assertEq(address(vault).balance, 0);
        assertEq(address(receiver).balance, 0);

        vault.collect(id);
        assertEq(address(receiver).balance, 0.01 ether);
        assertEq(vault.pendingFees(id), 0);
        assertEq(vault.claimable(id, address(receiver)), 0);
    }

    function test_underfundedLaterPayoutRollsBackEarlierPayments() public {
        QuoteGasRequirement receiver = new QuoteGasRequirement(90_000);
        LaunchLocker.Recipient[] memory r = new LaunchLocker.Recipient[](2);
        r[0] = LaunchLocker.Recipient(address(receiver), 5000);
        r[1] = LaunchLocker.Recipient(bob, 5000);
        (address token, uint256 id) = factory.launch(_params("low-gas-later", r));
        _buy(token, 1 ether);

        // The first payment executes in both attempts; the low-gas attempt fails before the second payment.
        vm.expectCall(address(receiver), 0.005 ether, bytes(""), 2);
        (bool ok, bytes memory reason) = address(vault).call{gas: 350_000}(abi.encodeCall(vault.collect, (id)));
        assertFalse(ok, "each payout must receive its full gas budget");
        assertEq(reason, abi.encodeWithSelector(QuoteFeeVault.TransferFailed.selector));
        assertEq(address(receiver).balance, 0);
        assertEq(bob.balance, 0);
        assertEq(vault.pendingFees(id), 0.01 ether);
        assertEq(manager.balanceOf(address(vault), 0), 0.01 ether);
        assertEq(vault.claimable(id, address(receiver)) + vault.claimable(id, bob), 0);
        assertEq(vault.reserved(address(0)), 0);
        assertEq(address(vault).balance, 0);

        vault.collect(id);
        assertEq(address(receiver).balance, 0.005 ether);
        assertEq(bob.balance, 0.005 ether);
        assertEq(vault.pendingFees(id), 0);
    }

    function test_underfundedERC20CollectRevertsAndCanBeRetried() public {
        (QuoteBadToken quote, address token, uint256 id) = _erc20Launch("low-gas-erc20", _recipients());
        _buyQuote(quote, token, 100e6);

        (bool ok, bytes memory reason) = address(vault).call{gas: 180_000}(abi.encodeCall(vault.collect, (id)));
        assertFalse(ok, "ERC20 payouts need the same full self-call budget");
        assertEq(reason, abi.encodeWithSelector(QuoteFeeVault.TransferFailed.selector));
        assertEq(vault.pendingFees(id), 1e6);
        assertEq(manager.balanceOf(address(vault), uint160(address(quote))), 1e6);
        assertEq(vault.claimable(id, alice) + vault.claimable(id, bob), 0);
        assertEq(vault.reserved(address(quote)), 0);
        assertEq(quote.balanceOf(address(vault)) + quote.balanceOf(alice) + quote.balanceOf(bob), 0);

        vault.collect(id);
        assertEq(quote.balanceOf(alice), 600_000);
        assertEq(quote.balanceOf(bob), 400_000);
        assertEq(vault.pendingFees(id), 0);
    }

    function test_badRateAndRecipientsRollbackLaunch() public {
        QuoteLaunchFactory.LaunchParams memory p = _params("bad", _recipients());
        p.creatorFeePips = 30001;
        vm.expectRevert(QuoteLaunchFactory.BadFee.selector);
        factory.launch(p);
        p.creatorFeePips = 30000;
        p.recipients[0].bps = 5999;
        vm.expectRevert();
        factory.launch(p);
        assertEq(factory.launchCount(), 0);
    }

    function _fourDirectionsERC20(uint8 decimals, int24 startTick) internal {
        MockERC20 implementation = new MockERC20("Quote", "QUOTE", decimals);
        vm.etch(address(0x10000), address(implementation).code);
        MockERC20 quote = MockERC20(address(0x10000));
        QuoteLaunchFactory.LaunchParams memory p = _params("four-directions", _recipients());
        p.quote = address(quote);
        p.startTick = startTick;
        (p.salt,) = factory.findSalt(address(this), p.salt, p.name, p.symbol, 0, p.metadataURI, p.quote, 64);
        (address token, uint256 id) = factory.launch(p);
        PoolKey memory key = _key(token);
        uint256 unit = 10 ** decimals;
        quote.mint(buyer, 100 * unit);
        vm.startPrank(buyer);
        quote.approve(address(swapRouter), type(uint256).max);
        BalanceDelta d = swapRouter.swap(
            key,
            SwapParams(true, -int256(unit), TickMath.MIN_SQRT_PRICE + 1),
            PoolSwapTest.TestSettings(false, false),
            ""
        );
        assertEq(d.amount0(), -int128(int256(unit)));
        assertEq(vault.pendingFees(id), unit / 100);
        uint256 pending = vault.pendingFees(id);
        uint256 exactTokens = LaunchToken(token).balanceOf(buyer) / 10;
        d = swapRouter.swap(
            key,
            SwapParams(true, int256(exactTokens), TickMath.MIN_SQRT_PRICE + 1),
            PoolSwapTest.TestSettings(false, false),
            ""
        );
        assertEq(d.amount1(), int128(int256(exactTokens)));
        assertApproxEqAbs(vault.pendingFees(id) - pending, uint256(uint128(-d.amount0())) / 100, 1);
        pending = vault.pendingFees(id);
        LaunchToken(token).approve(address(swapRouter), type(uint256).max);
        d = swapRouter.swap(
            key,
            SwapParams(false, int256(unit / 100), TickMath.MAX_SQRT_PRICE - 1),
            PoolSwapTest.TestSettings(false, false),
            ""
        );
        assertEq(d.amount0(), int128(int256(unit / 100)));
        assertEq(vault.pendingFees(id) - pending, hook.feeAmount(unit / 100, 10000, true));
        pending = vault.pendingFees(id);
        d = swapRouter.swap(
            key,
            SwapParams(false, -int256(LaunchToken(token).balanceOf(buyer) / 2), TickMath.MAX_SQRT_PRICE - 1),
            PoolSwapTest.TestSettings(false, false),
            ""
        );
        uint256 sellFee = vault.pendingFees(id) - pending;
        assertEq(sellFee, (uint256(uint128(d.amount0())) + sellFee) / 100);
        vm.stopPrank();
        pending = vault.pendingFees(id);
        assertEq(manager.balanceOf(address(vault), uint160(address(quote))), pending);
        vault.collect(id);
        assertEq(quote.balanceOf(alice) + quote.balanceOf(bob), pending);
        assertEq(vault.pendingFees(id), 0);
        assertEq(manager.balanceOf(address(vault), uint160(address(quote))), 0);
    }

    function test_erc20SixDecimalsAllDirections() public {
        _fourDirectionsERC20(6, 391400);
    }

    function test_erc20EightDecimalsAllDirections() public {
        _fourDirectionsERC20(8, 345400);
    }

    function test_erc20EighteenDecimalsAllDirections() public {
        _fourDirectionsERC20(18, START_TICK);
    }

    function testFuzz_interleavedPoolsConserveClaimsAndCredits(uint128 actions, uint24 rate) public {
        rate = uint24(bound(rate, 0, 30000));
        QuoteCanReceive receiver = new QuoteCanReceive();
        LaunchLocker.Recipient[] memory r = new LaunchLocker.Recipient[](1);
        r[0] = LaunchLocker.Recipient(address(receiver), 10000);
        QuoteLaunchFactory.LaunchParams memory p = _params("invariant-a", r);
        p.creatorFeePips = rate;
        (address a, uint256 aId) = factory.launch(p);
        p.salt = "invariant-b";
        (address b, uint256 bId) = factory.launch(p);
        uint256 accrued;
        uint256 collected;
        for (uint256 i; i < 16; ++i) {
            uint256 action = (uint256(actions) >> (i * 2)) & 3;
            if (action < 2) {
                _buy(action == 0 ? a : b, 0.01 ether);
                accrued += uint256(0.01 ether) * uint256(rate) / 1e6;
            } else {
                (uint256 amount,) = vault.collect(action == 2 ? aId : bId);
                collected += amount;
            }
            uint256 pending = vault.pendingFees(aId) + vault.pendingFees(bId);
            assertEq(accrued, collected + pending);
            assertEq(manager.balanceOf(address(vault), 0), pending);
            assertEq(vault.reserved(address(0)), collected);
            assertEq(address(vault).balance, collected);
            assertEq(vault.claimable(aId, address(receiver)) + vault.claimable(bId, address(receiver)), collected);
        }
        vault.collectMany(_ids(aId, bId));
        receiver.allow();
        vault.claimFor(aId, address(receiver));
        vault.claimFor(bId, address(receiver));
        assertEq(address(receiver).balance, accrued);
        assertEq(vault.reserved(address(0)), 0);
        assertEq(manager.balanceOf(address(vault), 0), 0);
    }

    function _ids(uint256 a, uint256 b) internal pure returns (uint256[] memory ids) {
        ids = new uint256[](2);
        ids[0] = a;
        ids[1] = b;
    }

    function testFuzz_rounding(uint128 amount, uint24 rate) public view {
        rate = uint24(bound(rate, 0, 30000));
        uint256 inputFee = hook.feeAmount(amount, rate, false);
        assertEq(inputFee, uint256(amount) * rate / 1e6);
        uint256 outputFee = hook.feeAmount(amount, rate, true);
        uint256 gross = uint256(amount) + outputFee;
        // Gross-up always covers the chosen rate; at most one unit is lost to rounding.
        assertGe(outputFee * 1e6, gross * rate);
        assertLt(outputFee * 1e6 - gross * rate, 1e6);
    }
}
