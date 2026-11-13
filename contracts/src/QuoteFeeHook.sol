// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {SafeCast} from "@uniswap/v4-core/src/libraries/SafeCast.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {SwapParams, ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {
    BeforeSwapDelta,
    BeforeSwapDeltaLibrary,
    toBeforeSwapDelta
} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import {Math} from "openzeppelin-contracts/contracts/utils/math/Math.sol";
import {QuoteFeeVault} from "./QuoteFeeVault.sol";

/// @notice Fixed creator fees charged only in currency0 (the quote), with zero LP fees.
/// Settlement pattern informed by o1's MIT LaunchHook/FeeEscrow; see docs/QUOTE_FEES.md.
contract QuoteFeeHook is IHooks {
    using PoolIdLibrary for PoolKey;
    using SafeCast for uint256;
    uint160 public constant HOOK_FLAGS = Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG
        | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG;
    uint24 public constant MAX_CREATOR_FEE = 30_000;
    uint256 public constant DENOMINATOR = 1_000_000;
    IPoolManager public immutable poolManager;
    address public immutable factory;
    QuoteFeeVault public immutable vault;

    struct Config {
        uint24 feePips;
        bool registered;
        bool active;
    }
    mapping(PoolId => Config) public poolConfig;
    event QuoteSwap(
        PoolId indexed poolId,
        address indexed executor,
        bool zeroForOne,
        bool exactInput,
        uint256 quoteFee,
        int256 amount0,
        int256 amount1
    );
    error NotFactory();
    error NotPoolManager();
    error BadPool();
    error UnknownPool();
    error PartialFillUnsupported();
    error HookNotImplemented();
    error NativeQuoteUnsupported();

    constructor(IPoolManager pm, address factory_, QuoteFeeVault vault_) {
        poolManager = pm;
        factory = factory_;
        vault = vault_;
        Hooks.validateHookPermissions(this, getHookPermissions());
    }
    modifier onlyPoolManager() {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        _;
    }
    modifier onlyFactory() {
        if (msg.sender != factory) revert NotFactory();
        _;
    }

    /// @notice The permissions this hook's address must encode.
    function getHookPermissions() public pure returns (Hooks.Permissions memory p) {
        p.beforeInitialize = true;
        p.beforeSwap = true;
        p.afterSwap = true;
        p.beforeSwapReturnDelta = true;
        p.afterSwapReturnDelta = true;
    }

    /// @notice Record a pool the factory is about to initialize; swaps stay off until `activate`. Factory only.
    function register(PoolKey calldata key, uint24 feePips) external onlyFactory {
        if (block.chainid == 5042 && Currency.unwrap(key.currency0) == address(0)) revert NativeQuoteUnsupported();
        PoolId id = key.toId();
        if (
            poolConfig[id].registered || address(key.hooks) != address(this) || key.fee != 0 || key.tickSpacing != 200
                || feePips > MAX_CREATOR_FEE
                || uint160(Currency.unwrap(key.currency0)) >= uint160(Currency.unwrap(key.currency1))
        ) revert BadPool();
        poolConfig[id] = Config(feePips, true, false);
    }

    /// @notice Turn swaps on once the vault knows the pool's position. Factory only.
    function activate(PoolId id) external onlyFactory {
        if (!poolConfig[id].registered || poolConfig[id].active || vault.tokenIdOfPool(id) == 0) revert BadPool();
        poolConfig[id].active = true;
    }

    /// @notice Only the factory may initialize a registered pool with this hook.
    function beforeInitialize(address sender, PoolKey calldata key, uint160)
        external
        view
        onlyPoolManager
        returns (bytes4)
    {
        if (sender != factory || !poolConfig[key.toId()].registered) revert BadPool();
        return IHooks.beforeInitialize.selector;
    }

    /// @notice When the quote amount is specified, charge the fee up front as claims minted to the vault.
    function beforeSwap(address, PoolKey calldata key, SwapParams calldata params, bytes calldata)
        external
        onlyPoolManager
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        Config memory cfg = _config(key);
        if (!_quoteSpecified(params)) return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
        uint256 fee = feeAmount(_magnitude(params.amountSpecified), cfg.feePips, params.amountSpecified > 0);
        if (fee == 0) return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
        int128 signedFee = fee.toInt128();
        poolManager.mint(address(vault), key.currency0.toId(), fee);
        return (IHooks.beforeSwap.selector, toBeforeSwapDelta(signedFee, 0), 0);
    }

    /// @notice Charge the fee on the actual quote delta when the token amount was specified, require a full fill, and accrue it to the vault.
    function afterSwap(
        address sender,
        PoolKey calldata key,
        SwapParams calldata params,
        BalanceDelta delta,
        bytes calldata
    ) external onlyPoolManager returns (bytes4, int128) {
        Config memory cfg = _config(key);
        bool specifiedQuote = _quoteSpecified(params);
        bool exactOutput = params.amountSpecified > 0;
        uint256 fee = feeAmount(
            specifiedQuote ? _magnitude(params.amountSpecified) : _magnitude(int256(delta.amount0())),
            cfg.feePips,
            exactOutput
        );
        int128 signedFee = fee.toInt128();
        bool specified0 = params.amountSpecified < 0 ? params.zeroForOne : !params.zeroForOne;
        int256 actual = specified0 ? int256(delta.amount0()) : int256(delta.amount1());
        // Full fills only, in every direction. A quote-specified swap has its fee charged up front on the whole
        // amount, and an unfilled swap would otherwise move the price outside the liquidity range at no cost.
        if (actual != params.amountSpecified + (specifiedQuote ? int256(signedFee) : int256(0))) {
            revert PartialFillUnsupported();
        }
        if (fee != 0) {
            if (!specifiedQuote) poolManager.mint(address(vault), key.currency0.toId(), fee);
            vault.accrue(key.toId(), fee);
        }
        emit QuoteSwap(
            key.toId(),
            sender,
            params.zeroForOne,
            !exactOutput,
            fee,
            int256(delta.amount0()) - int256(signedFee),
            int256(delta.amount1())
        );
        return (IHooks.afterSwap.selector, specifiedQuote ? int128(0) : signedFee);
    }

    /// @notice The fee on a quote amount: a share of the amount for exact input, grossed up for exact output.
    function feeAmount(uint256 amount, uint24 feePips, bool exactOutput) public pure returns (uint256) {
        if (feePips > MAX_CREATOR_FEE) revert BadPool();
        return exactOutput
            ? Math.mulDiv(amount, feePips, DENOMINATOR - feePips, Math.Rounding.Ceil)
            : Math.mulDiv(amount, feePips, DENOMINATOR);
    }

    /// @dev The pool's config; reverts unless the pool is active.
    function _config(PoolKey calldata key) internal view returns (Config memory cfg) {
        cfg = poolConfig[key.toId()];
        if (!cfg.active) revert UnknownPool();
    }

    /// @dev Whether the swap's specified amount is the quote (currency0).
    function _quoteSpecified(SwapParams calldata p) internal pure returns (bool) {
        return (p.amountSpecified < 0) == p.zeroForOne;
    }

    /// @dev Absolute value, safe at the int256 minimum.
    function _magnitude(int256 amount) internal pure returns (uint256) {
        return amount < 0 ? uint256(-(amount + 1)) + 1 : uint256(amount);
    }

    /// @dev Not a permission of this hook.
    function afterInitialize(address, PoolKey calldata, uint160, int24) external pure returns (bytes4) {
        revert HookNotImplemented();
    }

    /// @dev Not a permission of this hook.
    function beforeAddLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        revert HookNotImplemented();
    }

    /// @dev Not a permission of this hook.
    function afterAddLiquidity(
        address,
        PoolKey calldata,
        ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) external pure returns (bytes4, BalanceDelta) {
        revert HookNotImplemented();
    }

    /// @dev Not a permission of this hook.
    function beforeRemoveLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        revert HookNotImplemented();
    }

    /// @dev Not a permission of this hook.
    function afterRemoveLiquidity(
        address,
        PoolKey calldata,
        ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) external pure returns (bytes4, BalanceDelta) {
        revert HookNotImplemented();
    }

    /// @dev Not a permission of this hook.
    function beforeDonate(address, PoolKey calldata, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        revert HookNotImplemented();
    }

    /// @dev Not a permission of this hook.
    function afterDonate(address, PoolKey calldata, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        revert HookNotImplemented();
    }
}
