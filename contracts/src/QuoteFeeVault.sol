// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IPositionManager} from "@uniswap/v4-periphery/src/interfaces/IPositionManager.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "openzeppelin-contracts/contracts/utils/math/Math.sol";
import {ReentrancyGuard} from "openzeppelin-contracts/contracts/utils/ReentrancyGuard.sol";
import {LaunchLocker, IERC721Owner} from "./LaunchLocker.sol";

/// @notice Quote trading fees, backed by PoolManager claims until collected.
/// Each pool owns its recorded pending fees; failed payouts are reserved per recipient and launch.
/// No owner, setters, liquidity operations, arbitrary destinations, or balance sweeps.
contract QuoteFeeVault is IUnlockCallback, ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct Position {
        address token;
        address quote;
        PoolId poolId;
        uint256 pending;
        LaunchLocker.Recipient[] recipients;
    }

    uint256 public constant BPS = 10_000;
    uint256 public constant MAX_RECIPIENTS = 7;
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;
    uint256 public constant PAYOUT_GAS = 200_000;
    IPoolManager public immutable poolManager;
    IPositionManager public immutable positionManager;
    LaunchLocker public immutable locker;
    address public immutable factory;
    address public immutable hook;
    mapping(uint256 => Position) internal _positions;
    mapping(PoolId => uint256) public tokenIdOfPool;
    mapping(uint256 => mapping(address => uint256)) public claimable;
    mapping(address => uint256) public reserved;
    bool private _redeeming;

    event Registered(uint256 indexed tokenId, address indexed token, address indexed quote, PoolId poolId);
    event Collected(uint256 indexed tokenId, address indexed token, uint256 quoteAmount, uint256 tokenAmount);
    event Paid(uint256 indexed tokenId, address indexed account, address indexed currency, uint256 amount);
    event Credited(uint256 indexed tokenId, address indexed account, address indexed currency, uint256 amount);
    event Claimed(uint256 indexed tokenId, address indexed account, address indexed currency, uint256 amount);
    event Burned(uint256 indexed tokenId, address indexed currency, uint256 amount);
    error NotFactory();
    error NotHook();
    error NotSelf();
    error NotPoolManager();
    error UnknownPosition();
    error BadRegistration();
    error BadRecipients();
    error TransferFailed();
    error BadRedemption();

    constructor(IPoolManager pm, IPositionManager posm, LaunchLocker custody, address factory_, address hook_) {
        poolManager = pm;
        positionManager = posm;
        locker = custody;
        factory = factory_;
        hook = hook_;
    }

    receive() external payable {
        if (msg.sender != address(poolManager) || !_redeeming) revert BadRedemption();
    }

    /// @notice Bind a position minted to the locker to its pool and fee recipients. Factory only, once per position.
    function register(
        uint256 tokenId,
        address token,
        address quote,
        PoolId poolId,
        LaunchLocker.Recipient[] calldata recipients
    ) external {
        if (msg.sender != factory) revert NotFactory();
        if (
            _positions[tokenId].token != address(0) || tokenIdOfPool[poolId] != 0 || tokenId == 0 || token == address(0)
                || IERC721Owner(address(positionManager)).ownerOf(tokenId) != address(locker)
                || locker.tokenOf(tokenId) != token || locker.quoteOf(tokenId) != quote
        ) revert BadRegistration();
        if (recipients.length == 0 || recipients.length > MAX_RECIPIENTS) revert BadRecipients();
        Position storage p = _positions[tokenId];
        p.token = token;
        p.quote = quote;
        p.poolId = poolId;
        uint256 sum;
        for (uint256 i; i < recipients.length; ++i) {
            if (recipients[i].payout == address(0) || recipients[i].bps == 0) revert BadRecipients();
            sum += recipients[i].bps;
            p.recipients.push(recipients[i]);
        }
        if (sum != BPS) revert BadRecipients();
        tokenIdOfPool[poolId] = tokenId;
        emit Registered(tokenId, token, quote, poolId);
    }

    /// @notice Record a fee the hook minted to this vault as claims. Hook only.
    function accrue(PoolId poolId, uint256 amount) external {
        if (msg.sender != hook) revert NotHook();
        uint256 tokenId = tokenIdOfPool[poolId];
        if (tokenId == 0) revert UnknownPosition();
        if (amount == 0) return;
        _positions[tokenId].pending += amount;
    }

    /// @notice Quote fees accrued to a position and not yet collected.
    function pendingFees(uint256 tokenId) external view returns (uint256) {
        return _position(tokenId).pending;
    }

    /// @notice The position's fixed fee recipients.
    function recipientsOf(uint256 tokenId) external view returns (LaunchLocker.Recipient[] memory) {
        return _position(tokenId).recipients;
    }

    /// @notice The position's quote asset.
    function quoteOf(uint256 tokenId) external view returns (address) {
        return _position(tokenId).quote;
    }

    /// @notice The position's launched token.
    function tokenOf(uint256 tokenId) external view returns (address) {
        return _position(tokenId).token;
    }

    /// @notice Redeem a position's pending claims and pay them to its recipients; a failed payout becomes a credit. Anyone may call.
    function collect(uint256 tokenId) public nonReentrant returns (uint256 quoteOut, uint256 tokenOut) {
        Position storage p = _position(tokenId);
        quoteOut = p.pending;
        if (quoteOut == 0) return (0, 0);
        p.pending = 0;
        uint256 beforeBalance = _balance(p.quote);
        _redeeming = true;
        poolManager.unlock(abi.encode(p.quote, quoteOut));
        _redeeming = false;
        if (_balance(p.quote) != beforeBalance + quoteOut) revert BadRedemption();
        uint256 remaining = quoteOut;
        for (uint256 i; i < p.recipients.length; ++i) {
            LaunchLocker.Recipient storage r = p.recipients[i];
            uint256 share = i == p.recipients.length - 1 ? remaining : Math.mulDiv(quoteOut, r.bps, BPS);
            remaining -= share;
            if (share == 0) continue;
            if (r.payout == DEAD) {
                _pay(p.quote, DEAD, share);
                emit Burned(tokenId, p.quote, share);
            } else {
                // The self-call rolls back a token that transfers but returns false/malformed data.
                (bool ok,) =
                    address(this).call{gas: PAYOUT_GAS}(abi.encodeCall(this.executePayout, (p.quote, r.payout, share)));
                if (ok) {
                    emit Paid(tokenId, r.payout, p.quote, share);
                } else {
                    claimable[tokenId][r.payout] += share;
                    reserved[p.quote] += share;
                    emit Credited(tokenId, r.payout, p.quote, share);
                }
            }
        }
        emit Collected(tokenId, p.token, quoteOut, 0);
        return (quoteOut, 0);
    }

    /// @notice `collect` for several positions in one transaction.
    function collectMany(uint256[] calldata tokenIds) external {
        for (uint256 i; i < tokenIds.length; ++i) {
            collect(tokenIds[i]);
        }
    }

    /// @dev One payout in its own call frame, so a token that transfers but returns false or malformed data is rolled back and credited. Self only.
    function executePayout(address currency, address account, uint256 amount) external {
        if (msg.sender != address(this)) revert NotSelf();
        _pay(currency, account, amount);
    }

    /// @notice Withdraw the caller's credited share of a position.
    function claim(uint256 tokenId) external nonReentrant returns (uint256) {
        return _claim(tokenId, msg.sender);
    }

    /// @notice Push `account`'s credited share of a position to `account`. Anyone may call.
    function claimFor(uint256 tokenId, address account) external nonReentrant returns (uint256) {
        return _claim(tokenId, account);
    }

    /// @dev Pay a credit and release its reserve.
    function _claim(uint256 tokenId, address account) internal returns (uint256 amount) {
        Position storage p = _position(tokenId);
        amount = claimable[tokenId][account];
        if (amount == 0) return 0;
        claimable[tokenId][account] = 0;
        reserved[p.quote] -= amount;
        _pay(p.quote, account, amount);
        emit Claimed(tokenId, account, p.quote, amount);
    }

    /// @notice PoolManager callback during `collect`: burn exactly the redeemed claims and take the asset.
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        if (!_redeeming) revert BadRedemption();
        (address quote, uint256 amount) = abi.decode(data, (address, uint256));
        Currency currency = Currency.wrap(quote);
        poolManager.burn(address(this), currency.toId(), amount);
        poolManager.take(currency, address(this), amount);
        return "";
    }

    /// @dev The registered position; reverts for an unknown id.
    function _position(uint256 tokenId) internal view returns (Position storage p) {
        p = _positions[tokenId];
        if (p.token == address(0)) revert UnknownPosition();
    }

    /// @dev This contract's balance of a currency, native or ERC-20.
    function _balance(address currency) internal view returns (uint256) {
        return currency == address(0) ? address(this).balance : IERC20(currency).balanceOf(address(this));
    }

    /// @dev Transfer `amount` of `currency` to `account`, reverting on failure.
    function _pay(address currency, address account, uint256 amount) internal {
        if (currency == address(0)) {
            (bool ok,) = account.call{value: amount}("");
            if (!ok) revert TransferFailed();
        } else {
            IERC20(currency).safeTransfer(account, amount);
        }
    }
}
