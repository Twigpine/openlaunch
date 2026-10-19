// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// Runs only inside an eth_call, with its runtime code placed at a real holder's address by a state override, so the
/// token sees that holder (and its real balance) as the sender. Never deployed.
/// probe(token, to, amount, dead) returns:
///   received: how much `to` gained from `amount` (less = a fee on transfer)
///   deadOk:   whether a transfer of 1 unit to `dead` succeeded (launch fees are burned there)
///   holder:   the holder's balance before
contract TransferProbe {
    function probe(address token, address to, uint256 amount, address dead) external returns (uint256 received, bool deadOk, uint256 holder) {
        holder = _bal(token, address(this));
        uint256 before = _bal(token, to);
        (bool ok, bytes memory ret) = token.call(abi.encodeWithSelector(0xa9059cbb, to, amount));
        require(ok && (ret.length == 0 || abi.decode(ret, (bool))), "transfer reverted");
        received = _bal(token, to) - before;
        (bool ok2, bytes memory ret2) = token.call(abi.encodeWithSelector(0xa9059cbb, dead, uint256(1)));
        deadOk = ok2 && (ret2.length == 0 || abi.decode(ret2, (bool)));
    }

    function _bal(address token, address who) private view returns (uint256) {
        (bool ok, bytes memory ret) = token.staticcall(abi.encodeWithSelector(0x70a08231, who));
        require(ok && ret.length >= 32, "balanceOf failed");
        return abi.decode(ret, (uint256));
    }
}
