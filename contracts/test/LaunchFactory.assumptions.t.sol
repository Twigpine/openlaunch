// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {Pool} from "@uniswap/v4-core/src/libraries/Pool.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {PositionManager} from "@uniswap/v4-periphery/src/PositionManager.sol";
import {IPositionDescriptor} from "@uniswap/v4-periphery/src/interfaces/IPositionDescriptor.sol";
import {IWETH9} from "@uniswap/v4-periphery/src/interfaces/external/IWETH9.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";
import {DeployPermit2} from "permit2/test/utils/DeployPermit2.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {LaunchFactory} from "src/LaunchFactory.sol";
import {LaunchLocker} from "src/LaunchLocker.sol";

/// An unsupported quote that violates ERC20's boolean return ABI for one recipient.
contract MalformedQuote is MockERC20 {
    address public blocked;

    constructor() MockERC20("Malformed quote", "BAD", 18) {}

    function setBlocked(address account) external {
        blocked = account;
    }

    function transfer(address to, uint256 amount) public override returns (bool) {
        if (to == blocked) {
            assembly {
                mstore(0, 1)
                return(31, 1)
            }
        }
        return super.transfer(to, amount);
    }
}

/// Characterizes trust/availability boundaries of the immutable deployment.
/// These tests deliberately assert current behavior rather than modifying live code.
contract LaunchFactoryAssumptionsTest is Test, DeployPermit2 {
    IPoolManager internal manager;
    PositionManager internal posm;
    LaunchFactory internal factory;
    LaunchLocker internal locker;
    address internal alice = makeAddr("assumptions-alice");
    address internal bob = makeAddr("assumptions-bob");

    function setUp() public {
        manager = IPoolManager(address(new PoolManager(address(this))));
        IAllowanceTransfer permit2 = IAllowanceTransfer(deployPermit2());
        posm = new PositionManager(manager, permit2, 50_000, IPositionDescriptor(address(0)), IWETH9(address(0)));
        factory = new LaunchFactory(manager, posm, permit2);
        locker = factory.locker();
    }

    function params() internal view returns (LaunchFactory.LaunchParams memory p) {
        p.name = "Assumptions";
        p.symbol = "ASM";
        p.startTick = 184_200;
        p.lpFee = 10_000;
        p.salt = keccak256("public pending salt");
        p.recipients = new LaunchLocker.Recipient[](2);
        p.recipients[0] = LaunchLocker.Recipient(alice, 5_000);
        p.recipients[1] = LaunchLocker.Recipient(bob, 5_000);
    }

    function test_preinitializedPredictedPoolRevertsAtomicallyAndFreshSaltRecovers() public {
        LaunchFactory.LaunchParams memory p = params();
        address predicted = factory.predictToken(address(this), p.salt, p.name, p.symbol, 0, "");
        PoolKey memory key = PoolKey(
            Currency.wrap(address(0)), Currency.wrap(predicted), p.lpFee, factory.TICK_SPACING(), IHooks(address(0))
        );
        // An unrelated account can initialize a token's pool before token code exists.
        vm.prank(makeAddr("initializer"));
        manager.initialize(key, TickMath.getSqrtPriceAtTick(p.startTick));
        uint256 nextId = posm.nextTokenId();
        vm.expectRevert(Pool.PoolAlreadyInitialized.selector);
        factory.launch(p);
        assertEq(predicted.code.length, 0, "failed launch rolls back CREATE2 deployment");
        assertEq(factory.launchCount(), 0);
        assertEq(posm.nextTokenId(), nextId);
        assertEq(locker.tokenIdOf(predicted), 0);

        p.salt = keccak256("fresh retry salt");
        (address token, uint256 id) = factory.launch(p);
        assertTrue(token != predicted);
        assertEq(posm.ownerOf(id), address(locker));
        assertGt(posm.getPositionLiquidity(id), 0);
    }

    function test_malformedQuoteReturnRevertsCollectionAtomically() public {
        MalformedQuote quote = new MalformedQuote();
        LaunchFactory.LaunchParams memory p = params();
        p.quote = address(quote);
        (p.salt,) = factory.findSalt(address(this), p.salt, p.name, p.symbol, 0, "", p.quote, 256);
        (, uint256 id) = factory.launch(p);
        uint128 liquidity = posm.getPositionLiquidity(id);
        quote.mint(address(locker), 10 ether);
        // Alice is paid first; Bob's malformed ABI return rolls Alice's payment back too.
        quote.setBlocked(bob);
        vm.expectRevert();
        locker.collect(id);
        assertEq(quote.balanceOf(alice), 0);
        assertEq(quote.balanceOf(bob), 0);
        assertEq(quote.balanceOf(address(locker)), 10 ether);
        assertEq(locker.reserved(address(quote)), 0);
        assertEq(locker.claimable(bob, address(quote)), 0);
        assertEq(posm.ownerOf(id), address(locker));
        assertEq(posm.getPositionLiquidity(id), liquidity);

        quote.setBlocked(address(0));
        locker.collect(id);
        assertEq(quote.balanceOf(alice), 5 ether);
        assertEq(quote.balanceOf(bob), 5 ether);
    }
}
