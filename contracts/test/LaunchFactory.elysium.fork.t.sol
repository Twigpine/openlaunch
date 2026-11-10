// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, console} from "forge-std/Test.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {IPositionManager} from "@uniswap/v4-periphery/src/interfaces/IPositionManager.sol";
import {IV4Router} from "@uniswap/v4-periphery/src/interfaces/IV4Router.sol";
import {Actions} from "@uniswap/v4-periphery/src/libraries/Actions.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";

import {LaunchFactory} from "src/LaunchFactory.sol";
import {LaunchLocker, IERC721Owner} from "src/LaunchLocker.sol";
import {LaunchToken} from "src/LaunchToken.sol";

interface IERC20Min {
    function decimals() external view returns (uint8);
    function symbol() external view returns (string memory);
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
}

interface IERC721Full {
    function ownerOf(uint256) external view returns (address);
    function getApproved(uint256) external view returns (address);
    function transferFrom(address, address, uint256) external;
    function approve(address, uint256) external;
}

interface IUniversalRouter {
    function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable;
}

interface IPosmWiring {
    function poolManager() external view returns (address);
    function permit2() external view returns (address);
}

/// Elysium (Kinetiq's Arbitrum Orbit L2 for Hyperliquid, chain 99901, settles to HyperEVM, gas is HYPE). The deployed,
/// unmodified LaunchFactory / LaunchLocker / LaunchToken against the LIVE Uniswap v4 deployment there
/// (github.com/Uniswap/contracts deployments/99901.md; WHYPE / USDC from elysium.kinetiq.xyz/docs/contract-addresses).
///
/// Plain LaunchFactory, not LaunchFactoryArc: HYPE is an ordinary native gas asset with no ERC-20 face sharing its balance
/// (WHYPE is a separate WETH9-style wrapper), so the two-ledger hazard that forced the Arc guard does not exist here.
///
/// Before the deploy, setUp deploys the factory from the real deployer at its nonce 0 (it lands at the Base / Robinhood /
/// Arc addresses); once the factory is live, the same suite runs against the live deployment instead.
///   FORK_TESTS=true ELYSIUM_RPC_URL=… forge test --match-contract LaunchFactoryElysiumFork -vv
/// Verified 2026-11-10 against the public RPC before the deploy and again against the live deployment (block 3986599), all green.
contract LaunchFactoryElysiumFork is Test {
    address constant PM = 0xE2e105d3F7209A9DA11f83cCf3E7398a753823F1;
    address constant POSM = 0x1d1C51b9d07fD27d36412A2b66CC23D19Eb3E518;
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    /// "UniversalRouter" in 99901.md (v2.1.2): the one the app trades through.
    address constant ROUTER = 0xA13f7611115752DEB2B13813BDDE16A5073e4b45;
    /// "UniversalRouter#v2.2" in 99901.md: also live; probed so a later switch knows its layout.
    address constant ROUTER_V22 = 0x1B341FDD55d56F8E08409A2C25DDFad93Eb03C1a;
    address constant USDC = 0xb47c4C8F73F009CC0C0d3f92B388d13E293F0B65;
    address constant DEPLOYER = 0x63F300b7b21FbA52A8D874D90F7E1B301AE858c4;
    address constant FACTORY = 0x815542E8b392389A1389E22E588E4B62A67Ade72;
    address constant LOCKER = 0xcd1680D26922fcd9CabFbb8a56bA40C333fD842a;
    int24 constant HYPE_START_TICK = 158_200; // ≈ 7.45e6 token per HYPE: ~$10k FDV for 1B supply at HYPE ≈ $74.5
    int24 constant USD_START_TICK = 391_400; // ≈ $10k FDV for 1B supply against a 6-dec dollar quote

    IPoolManager manager = IPoolManager(PM);
    IPositionManager posm = IPositionManager(POSM);
    PoolSwapTest swapRouter;
    LaunchFactory factory;
    LaunchLocker locker;
    bool forked;

    address alice = makeAddr("launchpad-elysium-alice");
    address bob = makeAddr("launchpad-elysium-bob");
    address buyer = makeAddr("launchpad-elysium-buyer");

    /// The pre-minHopPriceX36 layout (Base's Universal Router 2.0).
    struct ExactInputSingleParamsV1 {
        PoolKey poolKey;
        bool zeroForOne;
        uint128 amountIn;
        uint128 amountOutMinimum;
        bytes hookData;
    }

    function setUp() public {
        if (!vm.envOr("FORK_TESTS", false)) return;
        vm.createSelectFork(vm.envOr("ELYSIUM_RPC_URL", string("https://rpc.elysium.kinetiq.xyz")));
        forked = true;
        assertEq(block.chainid, 99901, "rpc points at Elysium mainnet");
        swapRouter = new PoolSwapTest(manager);
        if (FACTORY.code.length == 0) {
            // pre-deploy: exactly what script/DeployLaunchFactory.s.sol broadcasts, from the real deployer
            assertEq(vm.getNonce(DEPLOYER), 0, "deployer nonce is still 0 on Elysium (else the addresses differ)");
            vm.prank(DEPLOYER);
            factory = new LaunchFactory(manager, posm, IAllowanceTransfer(PERMIT2));
        } else {
            factory = LaunchFactory(FACTORY);
        }
        locker = factory.locker();
        vm.deal(buyer, 1_000 ether);
        deal(USDC, buyer, 1_000e6);
        assertEq(alice.code.length + bob.code.length + buyer.code.length, 0, "test accounts are empty EOAs");
    }

    function _params(address quote, int24 tick, string memory sym, LaunchLocker.Recipient[] memory r)
        internal
        view
        returns (LaunchFactory.LaunchParams memory p)
    {
        p.name = "Elysium Coin";
        p.symbol = sym;
        p.metadataURI = "ipfs://elysium";
        p.quote = quote;
        p.startTick = tick;
        p.lpFee = 10_000;
        p.recipients = r;
        (bytes32 salt,) =
            factory.findSalt(address(this), keccak256(bytes(sym)), p.name, p.symbol, 0, p.metadataURI, quote, 64);
        p.salt = salt;
    }

    function _split() internal view returns (LaunchLocker.Recipient[] memory r) {
        r = new LaunchLocker.Recipient[](2);
        r[0] = LaunchLocker.Recipient(alice, 6_000);
        r[1] = LaunchLocker.Recipient(bob, 4_000);
    }

    function _buy(PoolKey memory key, uint256 amountIn) internal {
        SwapParams memory sp =
            SwapParams({zeroForOne: true, amountSpecified: -int256(amountIn), sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1});
        PoolSwapTest.TestSettings memory ts = PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false});
        vm.startPrank(buyer);
        if (Currency.unwrap(key.currency0) == address(0)) {
            swapRouter.swap{value: amountIn}(key, sp, ts, "");
        } else {
            IERC20Min(Currency.unwrap(key.currency0)).approve(address(swapRouter), amountIn);
            swapRouter.swap(key, sp, ts, "");
        }
        vm.stopPrank();
    }

    // ── the chain and the deployment ─────────────────────────────────────────────────────────────────────────────

    function test_fork_elysium_sameAddressesAsTheOtherChains() public {
        vm.skip(!forked);
        assertEq(address(factory), FACTORY, "factory at 0x8155...de72, as on Base / Robinhood Chain / Arc");
        assertEq(address(locker), LOCKER, "locker at 0xcd16...842a");
        assertEq(address(factory.poolManager()), PM);
        assertEq(address(factory.positionManager()), POSM);
        assertEq(address(factory.permit2()), PERMIT2);
        assertEq(locker.factory(), FACTORY);
        assertEq(address(locker.positionManager()), POSM);
    }

    function test_fork_elysium_liveContractsPresent() public {
        vm.skip(!forked);
        assertGt(PM.code.length, 0, "PoolManager deployed");
        assertGt(POSM.code.length, 0, "PositionManager deployed");
        assertGt(PERMIT2.code.length, 0, "Permit2 deployed");
        assertGt(ROUTER.code.length, 0, "Universal Router deployed");
        assertEq(IPosmWiring(POSM).poolManager(), PM, "PositionManager uses this PoolManager");
        assertEq(IPosmWiring(POSM).permit2(), PERMIT2, "PositionManager uses canonical Permit2");
        assertGt(posm.nextTokenId(), 1, "PositionManager is live");
        assertEq(IERC20Min(USDC).decimals(), 6);
        assertEq(IERC20Min(USDC).symbol(), "USDC");
    }

    // ── launch → buy → collect ───────────────────────────────────────────────────────────────────────────────────

    function test_fork_elysium_launchWithNativeHypeBuyCollect() public {
        vm.skip(!forked);
        (address token, uint256 tokenId) = factory.launch(_params(address(0), HYPE_START_TICK, "ELYH", _split()));
        LaunchToken t = LaunchToken(token);
        assertEq(IERC721Owner(POSM).ownerOf(tokenId), address(locker), "real posm minted to locker");
        assertEq(t.balanceOf(PM) + t.balanceOf(factory.DEAD()), t.totalSupply(), "all supply in pool");
        assertEq(locker.quoteOf(tokenId), address(0));

        uint256 quoteIn = 10 ether; // 10 HYPE
        _buy(factory.poolKeyOf(token), quoteIn);
        assertGt(t.balanceOf(buyer), 0, "bought with native HYPE");

        (uint256 quoteOut,) = locker.collect(tokenId);
        assertApproxEqRel(quoteOut, quoteIn / 100, 1e15, "1% fee in HYPE");
        assertEq(alice.balance, (quoteOut * 6_000) / 10_000, "alice paid in HYPE, directly");
        assertEq(bob.balance, quoteOut - (quoteOut * 6_000) / 10_000, "bob got the rest");
    }

    function test_fork_elysium_burnModeSendsHypeFeesToDead() public {
        vm.skip(!forked);
        (address token, uint256 tokenId) =
            factory.launch(_params(address(0), HYPE_START_TICK, "ELYB", new LaunchLocker.Recipient[](0)));
        _buy(factory.poolKeyOf(token), 10 ether);
        uint256 before = factory.DEAD().balance;
        (uint256 quoteOut,) = locker.collect(tokenId);
        assertGt(quoteOut, 0);
        assertEq(factory.DEAD().balance - before, quoteOut, "the whole HYPE fee was burned to dEaD");
    }

    function test_fork_elysium_launchWithUsdcQuoteBuyCollect() public {
        vm.skip(!forked);
        (address token, uint256 tokenId) = factory.launch(_params(USDC, USD_START_TICK, "ELYU", _split()));
        _buy(factory.poolKeyOf(token), 100e6);
        assertGt(LaunchToken(token).balanceOf(buyer), 0, "bought with USDC");
        assertEq(IERC20Min(USDC).balanceOf(buyer), 900e6, "paid 100 USDC");
        (uint256 quoteOut,) = locker.collect(tokenId);
        assertApproxEqRel(quoteOut, 1e6, 1e15, "1% fee in USDC");
        assertEq(IERC20Min(USDC).balanceOf(alice), (quoteOut * 6_000) / 10_000, "alice paid in USDC, directly");
        assertEq(IERC20Min(USDC).balanceOf(bob), quoteOut - (quoteOut * 6_000) / 10_000, "bob got the rest");
    }

    function test_fork_elysium_launchGas() public {
        vm.skip(!forked);
        LaunchFactory.LaunchParams memory p = _params(address(0), HYPE_START_TICK, "ELYG", _split());
        uint256 g = gasleft();
        factory.launch(p);
        console.log("launch gas (execution):", g - gasleft());
    }

    // ── the Universal Router the app trades through (app/src/lib/launchpad/config.ts swapLayout) ─────────────────

    function _v4SwapInput(bytes memory swapParams, PoolKey memory key, uint128 amountIn)
        internal
        pure
        returns (bytes memory)
    {
        bytes memory actions =
            abi.encodePacked(uint8(Actions.SWAP_EXACT_IN_SINGLE), uint8(Actions.SETTLE_ALL), uint8(Actions.TAKE_ALL));
        bytes[] memory params = new bytes[](3);
        params[0] = swapParams;
        params[1] = abi.encode(key.currency0, uint256(amountIn));
        params[2] = abi.encode(key.currency1, uint256(0));
        return abi.encode(actions, params);
    }

    function _inputV1(PoolKey memory key, uint128 amountIn) internal pure returns (bytes[] memory inputs) {
        inputs = new bytes[](1);
        inputs[0] = _v4SwapInput(
            abi.encode(
                ExactInputSingleParamsV1({
                    poolKey: key, zeroForOne: true, amountIn: amountIn, amountOutMinimum: 0, hookData: ""
                })
            ),
            key,
            amountIn
        );
    }

    function _inputV2(PoolKey memory key, uint128 amountIn) internal pure returns (bytes[] memory inputs) {
        inputs = new bytes[](1);
        inputs[0] = _v4SwapInput(
            abi.encode(
                IV4Router.ExactInputSingleParams({
                    poolKey: key,
                    zeroForOne: true,
                    amountIn: amountIn,
                    amountOutMinimum: 0,
                    minHopPriceX36: 0,
                    hookData: ""
                })
            ),
            key,
            amountIn
        );
    }

    /// The layout is probed on a USDC pool on purpose. In a NATIVE-quoted pool currency0 is address(0), and BOTH layouts
    /// go through: decoded with the wrong struct, the hookData offset lands on that zero word and reads as empty bytes.
    /// So a wrong swapLayout would pass every HYPE trade and break only ERC-20-quoted ones.
    function _assertDecodesV2Only(address router) internal {
        (address token,) = factory.launch(_params(USDC, USD_START_TICK, "ELYL", _split()));
        PoolKey memory key = factory.poolKeyOf(token);
        uint128 amountIn = 50e6;
        vm.startPrank(buyer);
        IERC20Min(USDC).approve(PERMIT2, type(uint256).max);
        IAllowanceTransfer(PERMIT2).approve(USDC, router, type(uint160).max, uint48(block.timestamp + 30 days));

        vm.expectRevert();
        IUniversalRouter(router).execute(abi.encodePacked(uint8(0x10)), _inputV1(key, amountIn), block.timestamp + 600);

        IUniversalRouter(router).execute(abi.encodePacked(uint8(0x10)), _inputV2(key, amountIn), block.timestamp + 600);
        vm.stopPrank();
        assertGt(LaunchToken(token).balanceOf(buyer), 0, "router swap delivered tokens");
        assertEq(IERC20Min(USDC).balanceOf(buyer), 950e6, "router pulled exactly amountIn through Permit2");
    }

    function test_fork_elysium_universalRouterDecodesV2Layout() public {
        vm.skip(!forked);
        _assertDecodesV2Only(ROUTER);
    }

    function test_fork_elysium_universalRouterV22DecodesV2Layout() public {
        vm.skip(!forked);
        _assertDecodesV2Only(ROUTER_V22);
    }

    /// The app's default buy: native HYPE through the router as msg.value, v2 layout.
    function test_fork_elysium_universalRouterNativeHypeBuy() public {
        vm.skip(!forked);
        (address token,) = factory.launch(_params(address(0), HYPE_START_TICK, "ELYN", _split()));
        PoolKey memory key = factory.poolKeyOf(token);
        uint256 before = buyer.balance;
        vm.prank(buyer);
        IUniversalRouter(ROUTER).execute{value: 1 ether}(
            abi.encodePacked(uint8(0x10)), _inputV2(key, 1 ether), block.timestamp + 600
        );
        assertGt(LaunchToken(token).balanceOf(buyer), 0, "router swap delivered tokens");
        assertEq(before - buyer.balance, 1 ether, "router took exactly 1 HYPE");
    }

    // ── rug attempts against Elysium's PositionManager ───────────────────────────────────────────────────────────
    // Same assertions as LaunchLockerRugFork / LaunchLockerRugRobinhood / the Arc suite.

    function _tryDecrease(address who, uint256 tokenId, address token) internal {
        uint128 liq = posm.getPositionLiquidity(tokenId);
        bytes memory actions = abi.encodePacked(uint8(Actions.DECREASE_LIQUIDITY), uint8(Actions.TAKE_PAIR));
        bytes[] memory params = new bytes[](2);
        params[0] = abi.encode(tokenId, liq, uint128(0), uint128(0), bytes(""));
        params[1] = abi.encode(Currency.wrap(address(0)), Currency.wrap(token), who);
        bytes memory data = abi.encode(actions, params);
        uint256 deadline = block.timestamp + 1;
        vm.prank(who);
        vm.expectRevert();
        posm.modifyLiquidities(data, deadline);
    }

    function test_fork_elysium_lockerOwnsThePositionAndNobodyCanMoveOrShrinkIt() public {
        vm.skip(!forked);
        (address token, uint256 tokenId) = factory.launch(_params(address(0), HYPE_START_TICK, "ELYR", _split()));
        IERC721Full nft = IERC721Full(POSM);
        assertEq(nft.ownerOf(tokenId), address(locker), "position minted to the locker");
        assertEq(nft.getApproved(tokenId), address(0), "no operator approved");
        address stranger = makeAddr("launchpad-elysium-stranger");
        vm.prank(DEPLOYER);
        vm.expectRevert();
        nft.transferFrom(address(locker), DEPLOYER, tokenId);
        vm.prank(stranger);
        vm.expectRevert();
        nft.transferFrom(address(locker), stranger, tokenId);
        vm.prank(stranger);
        vm.expectRevert();
        nft.approve(stranger, tokenId);
        _tryDecrease(DEPLOYER, tokenId, token);
        _tryDecrease(stranger, tokenId, token);
        // only the factory can register, and only once
        vm.prank(stranger);
        vm.expectRevert(LaunchLocker.NotFactory.selector);
        locker.register(tokenId, token, address(0), _split());
        // collect never touches liquidity
        uint128 before = posm.getPositionLiquidity(tokenId);
        locker.collect(tokenId);
        assertEq(posm.getPositionLiquidity(tokenId), before, "liquidity untouched by collect");
        assertEq(nft.ownerOf(tokenId), address(locker));
    }

    function test_fork_elysium_noAdminSurface() public {
        vm.skip(!forked);
        (address token,) = factory.launch(_params(address(0), HYPE_START_TICK, "ELYA", _split()));
        (bool ok,) = address(locker).call(abi.encodeWithSignature("owner()"));
        assertFalse(ok, "locker has no owner");
        (ok,) = address(factory).call(abi.encodeWithSignature("owner()"));
        assertFalse(ok, "factory has no owner");
        (ok,) = token.call(abi.encodeWithSignature("mint(address,uint256)", address(this), 1));
        assertFalse(ok, "token cannot mint");
        (ok,) = token.call(abi.encodeWithSignature("pause()"));
        assertFalse(ok, "token cannot pause");
    }
}
