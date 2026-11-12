// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {PositionManager} from "@uniswap/v4-periphery/src/PositionManager.sol";
import {IPositionDescriptor} from "@uniswap/v4-periphery/src/interfaces/IPositionDescriptor.sol";
import {IWETH9} from "@uniswap/v4-periphery/src/interfaces/external/IWETH9.sol";
import {Actions} from "@uniswap/v4-periphery/src/libraries/Actions.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";
import {DeployPermit2} from "permit2/test/utils/DeployPermit2.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {LaunchFactory} from "src/LaunchFactory.sol";
import {LaunchLocker} from "src/LaunchLocker.sol";
import {LaunchToken} from "src/LaunchToken.sol";

/// Conventional ERC20 accounting with recipient-specific false/revert failures.
/// No rebase, transfer fee, or misleading success return is modeled.
contract InvariantQuote is MockERC20 {
    mapping(address => uint8) public failureMode;

    constructor() MockERC20("Invariant quote", "IQ", 18) {}

    function setFailureMode(address account, uint8 mode) external {
        failureMode[account] = mode;
    }

    function transfer(address to, uint256 amount) public override returns (bool) {
        if (failureMode[to] == 1) return false;
        require(failureMode[to] != 2, "recipient blocked");
        return super.transfer(to, amount);
    }
}

contract InvariantRecipient {
    LaunchLocker public immutable locker;
    uint8 public mode;

    constructor(LaunchLocker locker_) {
        locker = locker_;
    }

    function setMode(uint8 mode_) external {
        mode = mode_;
    }

    receive() external payable {
        require(mode != 1, "payment rejected");
        if (mode == 2) locker.claim(address(0));
    }
}

/// Handler exercises real pinned v4 contracts; it never edits locker/position storage.
contract LaunchLockerHandler is Test {
    LaunchFactory public immutable factory;
    LaunchLocker public immutable locker;
    PositionManager public immutable posm;
    PoolSwapTest public immutable router;
    InvariantQuote public immutable quote;
    InvariantRecipient[2] public recipients;
    address[4] public tokens;
    uint256[4] public ids;
    uint128[4] public initialLiquidity;
    mapping(address => uint256) public distributed;
    mapping(address => uint256) public initialBurnBalance;
    uint256 public successfulClaims;
    uint256 public rejectedClaims;
    uint256 public collections;
    uint256 public rejectedWithdrawals;

    constructor(LaunchFactory factory_, PositionManager posm_, PoolSwapTest router_) {
        factory = factory_;
        locker = factory_.locker();
        posm = posm_;
        router = router_;
        quote = new InvariantQuote();
        recipients[0] = new InvariantRecipient(locker);
        recipients[1] = new InvariantRecipient(locker);
        initialBurnBalance[address(0)] = locker.DEAD().balance;
        for (uint256 i; i < 4; ++i) {
            LaunchLocker.Recipient[] memory r = new LaunchLocker.Recipient[](3);
            r[0] = LaunchLocker.Recipient(address(recipients[0]), i % 2 == 0 ? 6_000 : 2_000);
            r[1] = LaunchLocker.Recipient(address(recipients[1]), i % 2 == 0 ? 3_000 : 7_000);
            r[2] = LaunchLocker.Recipient(locker.DEAD(), 1_000);
            LaunchFactory.LaunchParams memory p;
            p.name = "Invariant launch";
            p.symbol = "INV";
            p.startTick = 184_200;
            p.lpFee = 10_000;
            p.recipients = r;
            p.salt = bytes32(i + 1);
            if (i >= 2) {
                p.quote = address(quote);
                (p.salt,) = factory.findSalt(address(this), p.salt, p.name, p.symbol, 0, "", p.quote, 256);
            }
            (tokens[i], ids[i]) = factory.launch(p);
            initialLiquidity[i] = posm.getPositionLiquidity(ids[i]);
            initialBurnBalance[tokens[i]] = LaunchToken(tokens[i]).balanceOf(locker.DEAD());
            LaunchToken(tokens[i]).approve(address(router), type(uint256).max);
        }
        quote.approve(address(router), type(uint256).max);
    }

    receive() external payable {}

    function currencyAt(uint256 index) public view returns (address) {
        if (index == 0) return address(0);
        if (index == 1) return address(quote);
        return tokens[index - 2];
    }

    function balance(address currency, address account) public view returns (uint256) {
        return currency == address(0) ? account.balance : LaunchToken(currency).balanceOf(account);
    }

    function buy(uint256 positionSeed, uint96 amountSeed) public {
        uint256 i = positionSeed % 4;
        uint256 amount = bound(amountSeed, 1e12, 0.2 ether);
        if (i < 2) vm.deal(address(this), address(this).balance + amount);
        else quote.mint(address(this), amount);
        router.swap{value: i < 2 ? amount : 0}(
            factory.poolKeyOf(tokens[i]),
            SwapParams(true, -int256(amount), TickMath.MIN_SQRT_PRICE + 1),
            PoolSwapTest.TestSettings(false, false),
            ""
        );
    }

    function sell(uint256 positionSeed, uint96 amountSeed) public {
        uint256 i = positionSeed % 4;
        uint256 available = LaunchToken(tokens[i]).balanceOf(address(this));
        if (available == 0) return;
        uint256 amount = bound(amountSeed, 1, available);
        router.swap(
            factory.poolKeyOf(tokens[i]),
            SwapParams(false, -int256(amount), TickMath.MAX_SQRT_PRICE - 1),
            PoolSwapTest.TestSettings(false, false),
            ""
        );
    }

    function donate(uint256 currencySeed, uint96 amountSeed) public {
        address currency = currencyAt(currencySeed % 6);
        uint256 amount = bound(amountSeed, 1, 0.1 ether);
        if (currency == address(0)) {
            vm.deal(address(this), address(this).balance + amount);
            (bool ok,) = address(locker).call{value: amount}("");
            assertTrue(ok);
        } else if (currency == address(quote)) {
            quote.mint(address(locker), amount);
        } else {
            uint256 available = LaunchToken(currency).balanceOf(address(this));
            if (available == 0) return;
            amount = bound(amountSeed, 1, available);
            assertTrue(LaunchToken(currency).transfer(address(locker), amount));
        }
    }

    function setFailure(uint256 recipientSeed, uint8 modeSeed) public {
        uint256 i = recipientSeed % 2;
        uint8 mode = modeSeed % 3;
        recipients[i].setMode(mode);
        quote.setFailureMode(address(recipients[i]), mode);
    }

    function collect(uint256 positionSeed) public {
        uint256 i = positionSeed % 4;
        (uint256 quoteOut, uint256 tokenOut) = locker.collect(ids[i]);
        distributed[i < 2 ? address(0) : address(quote)] += quoteOut;
        distributed[tokens[i]] += tokenOut;
        collections++;
    }

    function claim(uint256 recipientSeed, uint256 currencySeed, bool claimFor) public {
        address account = address(recipients[recipientSeed % 2]);
        address currency = currencyAt(currencySeed % 6);
        uint256 credit = locker.claimable(account, currency);
        uint256 reserveBefore = locker.reserved(currency);
        uint256 accountBefore = balance(currency, account);
        uint256 lockerBefore = balance(currency, address(locker));
        bool shouldFail = credit > 0
            && ((currency == address(0) && recipients[recipientSeed % 2].mode() != 0)
                || (currency == address(quote) && quote.failureMode(account) != 0));
        bytes memory callData = claimFor
            ? abi.encodeCall(LaunchLocker.claimFor, (account, currency))
            : abi.encodeCall(LaunchLocker.claim, (currency));
        // Exercise both the account's claim and a stranger's claimFor.
        vm.prank(claimFor ? address(0xBEEF) : account);
        (bool ok, bytes memory result) = address(locker).call(callData);
        assertEq(ok, !shouldFail, "only configured payout failures may reject a claim");
        if (!ok) {
            rejectedClaims++;
            assertEq(locker.claimable(account, currency), credit, "failed claim keeps credit");
            assertEq(locker.reserved(currency), reserveBefore, "failed claim keeps reserve");
            assertEq(balance(currency, account), accountBefore, "failed claim pays nothing");
            assertEq(balance(currency, address(locker)), lockerBefore, "failed claim keeps funds");
        } else {
            if (credit > 0) successfulClaims++;
            assertEq(abi.decode(result, (uint256)), credit);
            assertEq(locker.claimable(account, currency), 0);
            assertEq(locker.reserved(currency), reserveBefore - credit);
            assertEq(balance(currency, account), accountBefore + credit, "only credited account paid");
            assertEq(balance(currency, address(locker)), lockerBefore - credit);
        }
    }

    function rejectWithdrawal(uint256 positionSeed) public {
        uint256 id = ids[positionSeed % 4];
        (bool moved,) = address(posm)
            .call(abi.encodeWithSignature("transferFrom(address,address,uint256)", address(locker), address(this), id));
        assertFalse(moved, "outsider cannot move the NFT");
        (bool approved,) = address(posm).call(abi.encodeWithSignature("approve(address,uint256)", address(this), id));
        assertFalse(approved, "outsider cannot approve the NFT");
        bytes[] memory params = new bytes[](1);
        params[0] = abi.encode(id, uint256(1), uint128(0), uint128(0), bytes(""));
        (bool decreased,) = address(posm)
            .call(
                abi.encodeWithSignature(
                    "modifyLiquidities(bytes,uint256)",
                    abi.encode(abi.encodePacked(uint8(Actions.DECREASE_LIQUIDITY)), params),
                    block.timestamp
                )
            );
        assertFalse(decreased, "outsider cannot remove principal");
        rejectedWithdrawals++;
    }

    function assertAccounting() public view {
        for (uint256 i; i < 6; ++i) {
            address currency = currencyAt(i);
            uint256 credits =
                locker.claimable(address(recipients[0]), currency) + locker.claimable(address(recipients[1]), currency);
            assertEq(locker.reserved(currency), credits, "reserve equals all outstanding credits");
            assertGe(balance(currency, address(locker)), credits, "credits remain fully backed");
            uint256 paidAndBurned = balance(currency, address(recipients[0]))
                + balance(currency, address(recipients[1])) + balance(currency, locker.DEAD())
                - initialBurnBalance[currency];
            assertEq(distributed[currency], paidAndBurned + credits, "every distributed unit is paid or credited");
        }
    }

    function assertLocked() public view {
        for (uint256 i; i < 4; ++i) {
            assertEq(posm.ownerOf(ids[i]), address(locker));
            assertEq(posm.getApproved(ids[i]), address(0));
            assertEq(posm.getPositionLiquidity(ids[i]), initialLiquidity[i]);
            assertEq(locker.tokenIdOf(tokens[i]), ids[i]);
            assertEq(locker.tokenOf(ids[i]), tokens[i]);
        }
    }
}

contract LaunchLockerInvariantTest is Test, DeployPermit2 {
    LaunchLockerHandler internal handler;

    function setUp() public {
        IPoolManager manager = IPoolManager(address(new PoolManager(address(this))));
        IAllowanceTransfer permit2 = IAllowanceTransfer(deployPermit2());
        PositionManager posm =
            new PositionManager(manager, permit2, 50_000, IPositionDescriptor(address(0)), IWETH9(address(0)));
        LaunchFactory factory = new LaunchFactory(manager, posm, permit2);
        handler = new LaunchLockerHandler(factory, posm, new PoolSwapTest(manager));
        bytes4[] memory selectors = new bytes4[](7);
        selectors[0] = handler.buy.selector;
        selectors[1] = handler.sell.selector;
        selectors[2] = handler.donate.selector;
        selectors[3] = handler.setFailure.selector;
        selectors[4] = handler.collect.selector;
        selectors[5] = handler.claim.selector;
        selectors[6] = handler.rejectWithdrawal.selector;
        targetSelector(FuzzSelector(address(handler), selectors));
        targetContract(address(handler));
    }

    function invariant_reservesAndPayoutsRemainConserved() public view {
        handler.assertAccounting();
    }

    function invariant_positionsKeepOwnershipAndLiquidity() public view {
        handler.assertLocked();
    }

    /// Forces non-vacuous failure/recovery paths in addition to random sequences.
    function test_failureRecoveryAndCrossPositionSequence() public {
        handler.setFailure(0, 1);
        handler.setFailure(1, 2);
        for (uint256 i; i < 4; ++i) {
            handler.buy(i, 0.1 ether);
            handler.sell(i, 1e18);
            handler.donate(i < 2 ? 0 : 1, 1e16);
            handler.donate(i + 2, 1e16);
            handler.collect(i);
            handler.rejectWithdrawal(i);
            handler.assertAccounting();
            handler.assertLocked();
        }
        handler.claim(0, 0, false);
        handler.claim(1, 0, true);
        handler.claim(0, 1, true);
        handler.claim(1, 1, false);
        assertEq(handler.rejectedClaims(), 4);
        handler.setFailure(0, 0);
        handler.setFailure(1, 0);
        for (uint256 i; i < 2; ++i) {
            handler.claim(i, 0, i == 0);
            handler.claim(i, 1, i != 0);
        }
        assertEq(handler.successfulClaims(), 4);
        assertEq(handler.rejectedWithdrawals(), 4);
        handler.assertAccounting();
        handler.assertLocked();
    }
}
