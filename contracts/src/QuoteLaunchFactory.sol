// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {IPositionManager} from "@uniswap/v4-periphery/src/interfaces/IPositionManager.sol";
import {Actions} from "@uniswap/v4-periphery/src/libraries/Actions.sol";
import {LiquidityAmounts} from "@uniswap/v4-periphery/src/libraries/LiquidityAmounts.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";

import {LaunchToken} from "./LaunchToken.sol";
import {LaunchLocker} from "./LaunchLocker.sol";
import {QuoteFeeHook} from "./QuoteFeeHook.sol";
import {QuoteFeeVault} from "./QuoteFeeVault.sol";

/// @title LaunchFactory
/// @notice Permissionless token launches with immutable fees in the quote asset only.
/// LP NFTs remain permanently held by a fresh LaunchLocker. The hook charges the
/// creator fee and QuoteFeeVault owns the matching PoolManager claims.
contract QuoteLaunchFactory {
    using PoolIdLibrary for PoolKey;

    struct LaunchParams {
        string name;
        string symbol;
        string metadataURI;
        address quote; // address(0) = native ETH; else any ERC20 (USDG, a stock token, WETH…)
        uint256 supply; // 0 → DEFAULT_SUPPLY
        int24 startTick; // multiple of TICK_SPACING; price = 1.0001^tick token per quote unit
        uint24 creatorFeePips; // pips, 0 ≤ creatorFeePips ≤ MAX_CREATOR_FEE (10_000 = 1%); 0 = feeless pool
        bytes32 salt; // scoped to msg.sender; token address must sort above `quote` (see findSalt)
        LaunchLocker.Recipient[] recipients; // bps must sum to 10_000; empty = [DEAD: 100%] (fees burned)
    }

    struct Info {
        uint256 tokenId;
        address launcher;
        address quote;
        int24 startTick;
        uint24 creatorFeePips;
    }

    int24 public constant TICK_SPACING = 200;
    uint24 public constant MAX_CREATOR_FEE = 30_000; // 3%
    uint256 public constant DEFAULT_SUPPLY = 1_000_000_000e18;
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;

    IPoolManager public immutable poolManager;
    IPositionManager public immutable positionManager;
    IAllowanceTransfer public immutable permit2;
    LaunchLocker public immutable locker;
    QuoteFeeVault public immutable vault;
    QuoteFeeHook public immutable hook;

    mapping(address token => Info) public infoOf;
    uint256 public launchCount;

    event QuoteLaunched(
        address indexed token,
        uint256 indexed tokenId,
        address indexed launcher,
        address quote,
        PoolId poolId,
        int24 startTick,
        uint24 creatorFeePips,
        uint256 supply,
        string metadataURI
    );

    error BadSupply();
    error BadFee();
    error BadTick();
    error NoLiquidity();
    error SaltUsed();
    error QuoteOrdering();
    error NoSaltFound();
    error NativeQuoteUnsupported();
    error BadDeployment();

    constructor(
        IPoolManager poolManager_,
        IPositionManager positionManager_,
        IAllowanceTransfer permit2_,
        bytes32 hookSalt
    ) {
        if (
            address(poolManager_).code.length == 0 || address(positionManager_).code.length == 0
                || address(permit2_).code.length == 0
        ) revert BadDeployment();
        poolManager = poolManager_;
        positionManager = positionManager_;
        permit2 = permit2_;
        locker = new LaunchLocker(positionManager_);
        // This contract's second CREATE child is the vault. CREATE2 hook creation is third.
        address predictedVault =
            address(uint160(uint256(keccak256(abi.encodePacked(hex"d694", address(this), hex"02")))));
        bytes32 hookHash = keccak256(
            abi.encodePacked(type(QuoteFeeHook).creationCode, abi.encode(poolManager_, address(this), predictedVault))
        );
        address expectedHook =
            address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), hookSalt, hookHash)))));
        vault = new QuoteFeeVault(poolManager_, positionManager_, locker, address(this), expectedHook);
        hook = new QuoteFeeHook{salt: hookSalt}(poolManager_, address(this), vault);
        if (address(vault) != predictedVault || address(hook) != expectedHook) revert BadDeployment();
    }

    /// @notice Deploy a token and lock 100% of it as single-sided liquidity.
    function launch(LaunchParams calldata p) external returns (address token, uint256 tokenId) {
        if (block.chainid == 5042 && p.quote == address(0)) revert NativeQuoteUnsupported();
        uint256 supply = p.supply == 0 ? DEFAULT_SUPPLY : p.supply;
        if (supply > type(uint128).max) revert BadSupply();
        if (p.creatorFeePips > MAX_CREATOR_FEE) revert BadFee();

        int24 tickLower = TickMath.minUsableTick(TICK_SPACING);
        if (
            p.startTick % TICK_SPACING != 0 || p.startTick <= tickLower
                || p.startTick > TickMath.maxUsableTick(TICK_SPACING)
        ) revert BadTick();

        // 1. token — full supply lands on this contract. A CREATE2 collision
        //    would burn the entire gas limit, so pre-check the address instead.
        bytes32 salt = keccak256(abi.encode(msg.sender, p.salt));
        {
            address predicted = _predict(salt, p.name, p.symbol, supply, msg.sender, p.metadataURI);
            if (predicted.code.length != 0) revert SaltUsed();
            // quote must be currency0: strictly lower address than the token
            if (uint160(predicted) <= uint160(p.quote)) revert QuoteOrdering();
        }
        token = address(new LaunchToken{salt: salt}(p.name, p.symbol, supply, msg.sender, p.metadataURI));

        // 2. pool at the start price
        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(p.quote),
            currency1: Currency.wrap(token),
            fee: 0,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(address(hook))
        });
        hook.register(key, p.creatorFeePips);
        uint160 sqrtUpper = TickMath.getSqrtPriceAtTick(p.startTick);
        poolManager.initialize(key, sqrtUpper);

        // 3. single-sided position [minTick, startTick]; current tick == upper → token-only
        uint128 liquidity =
            LiquidityAmounts.getLiquidityForAmount1(TickMath.getSqrtPriceAtTick(tickLower), sqrtUpper, supply);
        if (liquidity == 0) revert NoLiquidity();

        LaunchToken(token).approve(address(permit2), supply);
        permit2.approve(token, address(positionManager), uint160(supply), uint48(block.timestamp));

        tokenId = positionManager.nextTokenId();
        bytes memory actions = abi.encodePacked(uint8(Actions.MINT_POSITION), uint8(Actions.SETTLE_PAIR));
        bytes[] memory params = new bytes[](2);
        params[0] = abi.encode(
            key, tickLower, p.startTick, uint256(liquidity), uint128(0), uint128(supply), address(locker), bytes("")
        );
        params[1] = abi.encode(key.currency0, key.currency1);
        positionManager.modifyLiquidities(abi.encode(actions, params), block.timestamp);

        // hygiene: drop the allowance, burn whatever rounding left behind
        LaunchToken(token).approve(address(permit2), 0);
        uint256 dust = LaunchToken(token).balanceOf(address(this));
        if (dust > 0) require(LaunchToken(token).transfer(DEAD, dust), "dust burn failed");

        // 4. fee routing — no beneficiary named ⇒ every fee is burned
        if (p.recipients.length == 0) {
            LaunchLocker.Recipient[] memory burn = new LaunchLocker.Recipient[](1);
            burn[0] = LaunchLocker.Recipient({payout: DEAD, bps: uint16(locker.BPS())});
            locker.register(tokenId, token, p.quote, burn);
            vault.register(tokenId, token, p.quote, key.toId(), burn);
        } else {
            locker.register(tokenId, token, p.quote, p.recipients);
            vault.register(tokenId, token, p.quote, key.toId(), p.recipients);
        }

        hook.activate(key.toId());
        infoOf[token] = Info({
            tokenId: tokenId,
            launcher: msg.sender,
            quote: p.quote,
            startTick: p.startTick,
            creatorFeePips: p.creatorFeePips
        });
        unchecked {
            ++launchCount;
        }
        emit QuoteLaunched(
            token, tokenId, msg.sender, p.quote, key.toId(), p.startTick, p.creatorFeePips, supply, p.metadataURI
        );
    }

    // ── Views ────────────────────────────────────────────────────────────────

    /// @notice The pool key for a token launched here (reverts if unknown).
    function poolKeyOf(address token) external view returns (PoolKey memory) {
        Info memory i = infoOf[token];
        if (i.tokenId == 0) revert BadTick();
        return PoolKey({
            currency0: Currency.wrap(i.quote),
            currency1: Currency.wrap(token),
            fee: 0,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(address(hook))
        });
    }

    /// @notice Pre-compute the token address a `launch()` from `launcher` would produce.
    function predictToken(
        address launcher,
        bytes32 salt,
        string calldata name,
        string calldata symbol,
        uint256 supply,
        string calldata metadataURI
    ) external view returns (address) {
        if (supply == 0) supply = DEFAULT_SUPPLY;
        return _predict(keccak256(abi.encode(launcher, salt)), name, symbol, supply, launcher, metadataURI);
    }

    /// @notice Find a salt (derived from `baseSalt`) whose token address sorts
    /// above `quote`, so the launch passes the currency-ordering check. Pure
    /// hashing, so one `eth_call` is enough; ~50% of candidates qualify, and
    /// `maxTries` bounds the loop. Returns the salt to pass in `LaunchParams`.
    function findSalt(
        address launcher,
        bytes32 baseSalt,
        string calldata name,
        string calldata symbol,
        uint256 supply,
        string calldata metadataURI,
        address quote,
        uint256 maxTries
    ) external view returns (bytes32 salt, address token) {
        if (supply == 0) supply = DEFAULT_SUPPLY;
        for (uint256 i; i < maxTries; ++i) {
            salt = i == 0 ? baseSalt : keccak256(abi.encode(baseSalt, i));
            token = _predict(keccak256(abi.encode(launcher, salt)), name, symbol, supply, launcher, metadataURI);
            if (uint160(token) > uint160(quote) && token.code.length == 0) return (salt, token);
        }
        revert NoSaltFound();
    }

    function _predict(
        bytes32 scopedSalt,
        string memory name,
        string memory symbol,
        uint256 supply,
        address launcher,
        string memory metadataURI
    ) internal view returns (address) {
        bytes32 initHash = keccak256(
            abi.encodePacked(type(LaunchToken).creationCode, abi.encode(name, symbol, supply, launcher, metadataURI))
        );
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), scopedSalt, initHash)))));
    }
}
