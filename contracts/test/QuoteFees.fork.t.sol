// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;
import {Test} from "forge-std/Test.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IPositionManager} from "@uniswap/v4-periphery/src/interfaces/IPositionManager.sol";
import {IV4Quoter} from "@uniswap/v4-periphery/src/interfaces/IV4Quoter.sol";
import {IV4Router} from "@uniswap/v4-periphery/src/interfaces/IV4Router.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PathKey} from "@uniswap/v4-periphery/src/libraries/PathKey.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";
import {HookMiner} from "@uniswap/v4-periphery/test/shared/HookMiner.sol";
import {QuoteLaunchFactory} from "src/QuoteLaunchFactory.sol";
import {QuoteFeeHook} from "src/QuoteFeeHook.sol";
import {LaunchLocker, IERC721Owner} from "src/LaunchLocker.sol";
import {LaunchToken} from "src/LaunchToken.sol";

interface IQuoteRouter {
    function execute(bytes calldata, bytes[] calldata, uint256) external payable;
}

interface IQuoteERC20 {
    function approve(address, uint256) external returns (bool);
    function balanceOf(address) external view returns (uint256);
    function decimals() external view returns (uint8);
}

/// Real routers, quoters, Permit2 and PoolManager. Opt in with FORK_TESTS=true.
/// Arc requires ARC_FORK_TESTS=true and Circle's runtime. B20 requires B20_FORK_TESTS=true and Base's runtime.
abstract contract QuoteFeesFork is Test {
    using PoolIdLibrary for PoolKey;
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    QuoteLaunchFactory factory;
    address buyer = makeAddr("quote-v2-fork-buyer");
    address recipient = makeAddr("quote-v2-fork-recipient");
    bool forked;

    struct V1Params {
        PoolKey poolKey;
        bool zeroForOne;
        uint128 amountIn;
        uint128 amountOutMinimum;
        bytes hookData;
    }

    /// Multi-hop exact input in the same original layout (no minHopPriceX36): what eth-route.ts encodes for Base.
    struct V1ExactInput {
        Currency currencyIn;
        PathKey[] path;
        uint128 amountIn;
        uint128 amountOutMinimum;
    }
    function network()
        internal
        view
        virtual
        returns (
            uint256 id,
            string memory rpc,
            address pm,
            address posm,
            address router,
            address quoter,
            address quote,
            bool v2
        );
    receive() external payable {}

    function setUp() public {
        (uint256 id, string memory rpc, address pm, address posm,,,,) = network();
        if (!vm.envOr("FORK_TESTS", false) || (id == 5042 && !vm.envOr("ARC_FORK_TESTS", false))) return;
        vm.createSelectFork(rpc);
        forked = true;
        assertEq(block.chainid, id);
        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)));
        address vault = vm.computeCreateAddress(predicted, 2);
        (, bytes32 salt) =
            HookMiner.find(predicted, 0x20cc, type(QuoteFeeHook).creationCode, abi.encode(pm, predicted, vault));
        factory = new QuoteLaunchFactory(IPoolManager(pm), IPositionManager(posm), IAllowanceTransfer(PERMIT2), salt);
    }

    function _launch(address quote, bool burn) internal returns (address token, uint256 id) {
        QuoteLaunchFactory.LaunchParams memory p;
        p.name = "Quote Fork";
        p.symbol = "QFORK";
        p.quote = quote;
        uint8 decimals = quote == address(0) ? 18 : IQuoteERC20(quote).decimals();
        p.startTick = decimals == 18 ? int24(184200) : decimals == 8 ? int24(345400) : int24(391400);
        p.creatorFeePips = 10000;
        if (!burn) {
            p.recipients = new LaunchLocker.Recipient[](1);
            p.recipients[0] = LaunchLocker.Recipient(recipient, 10000);
        }
        (p.salt,) =
            factory.findSalt(address(this), keccak256(abi.encode(quote, burn)), p.name, p.symbol, 0, "", quote, 256);
        return factory.launch(p);
    }

    function _swap(PoolKey memory key, bool buy, uint128 amount, uint128 minimum, address router, bool v2) internal {
        bytes[] memory params = new bytes[](3);
        params[0] = v2
            ? abi.encode(IV4Router.ExactInputSingleParams(key, buy, amount, minimum, 0, ""))
            : abi.encode(V1Params(key, buy, amount, minimum, ""));
        address input = Currency.unwrap(buy ? key.currency0 : key.currency1);
        params[1] = abi.encode(input, uint256(amount));
        params[2] = abi.encode(buy ? key.currency1 : key.currency0, uint256(minimum));
        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(hex"060c0f", params);
        vm.startPrank(buyer);
        if (input != address(0)) {
            IQuoteERC20(input).approve(PERMIT2, type(uint256).max);
            IAllowanceTransfer(PERMIT2).approve(input, router, type(uint160).max, uint48(block.timestamp + 30 days));
        }
        IQuoteRouter(router).execute{value: input == address(0) ? amount : 0}(hex"10", inputs, block.timestamp + 600);
        vm.stopPrank();
    }

    function _roundTrip(address quote, bool burn) internal {
        (uint256 chainId,,, address posm, address router, address quoter,, bool v2) = network();
        (address token, uint256 id) = _launch(quote, burn);
        address payee = burn ? factory.DEAD() : recipient;
        uint256 beforeTokenFees = LaunchToken(token).balanceOf(payee);
        PoolKey memory key = factory.poolKeyOf(token);
        assertEq(key.fee, 0);
        assertEq(IERC721Owner(posm).ownerOf(id), address(factory.locker()));
        uint256 unit = quote == address(0) ? 1 ether : 10 ** IQuoteERC20(quote).decimals();
        uint128 amount = quote == address(0) ? uint128(0.1 ether) : uint128(100 * unit);
        if (chainId == 5042) {
            vm.deal(buyer, 1000 ether);
        } else if (quote == address(0)) {
            vm.deal(buyer, 10 ether);
        } else if (quote == 0xb200000000000000000000C2e324d24d7eEcd1fb) {
            // Native B20 calls do not participate in stdStorage's SLOAD recording.
            // base/base-std test/lib/mocks/MockB20Storage.sol: base.b20 + BALANCES_OFFSET (4).
            uint256 location = 0xc78b71fee795ddd74aff64ea9b2474194c938c3196430e10bb5f01ed48434000;
            vm.store(quote, keccak256(abi.encode(buyer, location + 4)), bytes32(1000 * unit));
            assertEq(IQuoteERC20(quote).balanceOf(buyer), 1000 * unit, "B20 fixture layout changed");
        } else {
            deal(quote, buyer, 1000 * unit);
        }
        (uint256 out,) =
            IV4Quoter(quoter).quoteExactInputSingle(IV4Quoter.QuoteExactSingleParams(key, true, amount, ""));
        assertEq(factory.vault().pendingFees(id), 0);
        _swap(key, true, amount, uint128(out), router, v2);
        assertEq(LaunchToken(token).balanceOf(buyer), out);
        assertEq(factory.vault().pendingFees(id), amount / 100);
        uint128 tokenIn = uint128(out / 2);
        (uint256 sellOut,) =
            IV4Quoter(quoter).quoteExactInputSingle(IV4Quoter.QuoteExactSingleParams(key, false, tokenIn, ""));
        uint256 beforeQuote = quote == address(0) ? buyer.balance : IQuoteERC20(quote).balanceOf(buyer);
        _swap(key, false, tokenIn, uint128(sellOut), router, v2);
        assertEq((quote == address(0) ? buyer.balance : IQuoteERC20(quote).balanceOf(buyer)) - beforeQuote, sellOut);
        uint256 pending = factory.vault().pendingFees(id);
        assertGt(pending, amount / 100);
        uint256 beforePay = quote == address(0) ? payee.balance : IQuoteERC20(quote).balanceOf(payee);
        uint256 liq = IPositionManager(posm).getPositionLiquidity(id);
        (uint256 collected, uint256 tokenFees) = factory.vault().collect(id);
        assertEq(collected, pending);
        assertEq(tokenFees, 0);
        assertEq((quote == address(0) ? payee.balance : IQuoteERC20(quote).balanceOf(payee)) - beforePay, pending);
        assertEq(LaunchToken(token).balanceOf(payee), beforeTokenFees);
        assertEq(IPositionManager(posm).getPositionLiquidity(id), liq);
    }

    function test_fork_realRouterQuoteBuySellCollect() public {
        vm.skip(!forked);
        (,,,,,, address quote,) = network();
        _roundTrip(quote, false);
    }

    function test_fork_realQuoteBurn() public {
        vm.skip(!forked);
        (,,,,,, address quote,) = network();
        _roundTrip(quote, true);
    }
}

contract QuoteFeesBaseFork is QuoteFeesFork {
    function network()
        internal
        view
        override
        returns (uint256, string memory, address, address, address, address, address, bool)
    {
        return (
            8453,
            vm.envOr("BASE_RPC_URL", string("https://mainnet.base.org")),
            0x498581fF718922c3f8e6A244956aF099B2652b2b,
            0x7C5f5A4bBd8fD63184577525326123B519429bDc,
            0x6fF5693b99212Da76ad316178A184AB56D299b43,
            0x0d5e0F971ED27FBfF6c2837bf31316121532048D,
            0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913,
            false
        );
    }

    function test_fork_nativeRouterBuySellCollect() public {
        vm.skip(!forked);
        _roundTrip(address(0), false);
    }

    function test_fork_gitlawbRouterBuySellCollect() public {
        vm.skip(!forked);
        _roundTrip(0x5F980Dcfc4c0fa3911554cf5ab288ed0eb13DBa3, false);
    }

    address constant WETH = 0x4200000000000000000000000000000000000006;
    address constant GITLAWB = 0x5F980Dcfc4c0fa3911554cf5ab288ed0eb13DBa3;
    address constant TWIG = 0x6aC18bcf4eDE02591d4917452700ea5eaAea13c1;
    IHooks constant GITLAWB_POOL_HOOK = IHooks(0xbB7784A4d481184283Ed89619A3e3ed143e1Adc0);
    IHooks constant TWIG_WRAP_HOOK = IHooks(0xf7423f48886F86F551B517254d21AF4267732888);

    /// A quote-only launch priced in TWIG, at the start tick the TWIG launch tests use (1B supply at about 600M TWIG).
    function _launchTwig() internal returns (address token, uint256 id) {
        QuoteLaunchFactory.LaunchParams memory p;
        p.name = "Twig Quote Fork";
        p.symbol = "TQF";
        p.quote = TWIG;
        p.startTick = 5_200;
        p.creatorFeePips = 10000;
        p.recipients = new LaunchLocker.Recipient[](1);
        p.recipients[0] = LaunchLocker.Recipient(recipient, 10000);
        (p.salt,) = factory.findSalt(address(this), keccak256("eth-route"), p.name, p.symbol, 0, "", TWIG, 256);
        return factory.launch(p);
    }

    /// The app's "Buy with ETH" route (app/src/lib/launchpad/eth-route.ts) ending in a quote-only pool: one Universal
    /// Router call wraps the ETH and swaps WETH -> GITLAWB -> TWIG -> token, the last hop through the fee hook.
    function test_fork_ethRouteBuysTwigQuotedLaunchInOneCall() public {
        vm.skip(!forked);
        (,,, address posm, address router, address quoter,,) = network();
        (address token, uint256 id) = _launchTwig();
        PoolKey memory key = factory.poolKeyOf(token);
        PathKey[] memory path = new PathKey[](3);
        path[0] = PathKey(Currency.wrap(GITLAWB), 0x800000, 200, GITLAWB_POOL_HOOK, "");
        path[1] = PathKey(Currency.wrap(TWIG), 0, 1, TWIG_WRAP_HOOK, "");
        path[2] = PathKey(Currency.wrap(token), key.fee, key.tickSpacing, key.hooks, "");
        uint128 amount = 0.01 ether;
        (uint256 out,) =
            IV4Quoter(quoter).quoteExactInput(IV4Quoter.QuoteExactParams(Currency.wrap(WETH), path, amount));
        // the TWIG that reaches the launch's pool is hop 1's GITLAWB output, wrapped 1:1 by hop 2
        PoolKey memory gitlawbPool =
            PoolKey(Currency.wrap(WETH), Currency.wrap(GITLAWB), 0x800000, 200, GITLAWB_POOL_HOOK);
        (uint256 twigIn,) =
            IV4Quoter(quoter).quoteExactInputSingle(IV4Quoter.QuoteExactSingleParams(gitlawbPool, true, amount, ""));

        bytes[] memory params = new bytes[](3);
        params[0] = abi.encode(V1ExactInput(Currency.wrap(WETH), path, amount, uint128(out)));
        params[1] = abi.encode(WETH, uint256(0), false); // SETTLE the open WETH delta from the router's own balance
        params[2] = abi.encode(token, out); // TAKE_ALL
        bytes[] memory inputs = new bytes[](2);
        inputs[0] = abi.encode(address(2), uint256(amount)); // WRAP_ETH to the router itself
        inputs[1] = abi.encode(hex"070b0f", params); // SWAP_EXACT_IN, SETTLE, TAKE_ALL
        vm.deal(buyer, 1 ether);
        vm.prank(buyer);
        IQuoteRouter(router).execute{value: amount}(hex"0b10", inputs, block.timestamp + 600);

        assertEq(LaunchToken(token).balanceOf(buyer), out, "the quoter priced the whole route, hook fee included");
        uint256 fee = factory.vault().pendingFees(id);
        assertEq(fee, factory.hook().feeAmount(twigIn, 10000, false), "1% of the TWIG that entered the pool");
        uint256 liq = IPositionManager(posm).getPositionLiquidity(id);
        (uint256 collected,) = factory.vault().collect(id);
        assertEq(collected, fee);
        assertEq(IQuoteERC20(TWIG).balanceOf(recipient), fee, "paid in TWIG");
        assertEq(IPositionManager(posm).getPositionLiquidity(id), liq);
    }

    function test_fork_coinbaseStockRouterBuySellCollect() public {
        vm.skip(!forked || !vm.envOr("B20_FORK_TESTS", false));
        _roundTrip(0xb200000000000000000000C2e324d24d7eEcd1fb, false);
    }
}

contract QuoteFeesRobinhoodFork is QuoteFeesFork {
    function network()
        internal
        view
        override
        returns (uint256, string memory, address, address, address, address, address, bool)
    {
        return (
            4663,
            vm.envOr("ROBINHOOD_RPC_URL", string("https://rpc.mainnet.chain.robinhood.com")),
            0x8366a39CC670B4001A1121B8F6A443A643e40951,
            0x58daec3116aae6D93017bAAea7749052E8a04fA7,
            0x8876789976dEcBfCbBbe364623C63652db8C0904,
            0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94,
            0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168,
            true
        );
    }

    function test_fork_nativeRouterBuySellCollect() public {
        vm.skip(!forked);
        _roundTrip(address(0), false);
    }

    function test_fork_gitlawbRouterBuySellCollect() public {
        vm.skip(!forked);
        _roundTrip(0xd1b0d44E4f6ed940fcC7A9F59Bf30Daf62cCFe3D, false);
    }

    function test_fork_robinhoodStockRouterBuySellCollect() public {
        vm.skip(!forked);
        _roundTrip(0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9, false);
    }
}

contract QuoteFeesArcFork is QuoteFeesFork {
    function network()
        internal
        view
        override
        returns (uint256, string memory, address, address, address, address, address, bool)
    {
        return (
            5042,
            vm.envOr("ARC_RPC_URL", string("https://rpc.mainnet.arc.io")),
            0x8366a39CC670B4001A1121B8F6A443A643e40951,
            0x6049c9a0e26405C0985f9E3685C87d0aE917f82B,
            0x4fcA4a51Ab4F23A7447b3284fBd7D73289A89Fb1,
            0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94,
            0x3600000000000000000000000000000000000000,
            true
        );
    }
}
