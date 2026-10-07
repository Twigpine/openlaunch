// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;
import {Script, console} from "forge-std/Script.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IPositionManager} from "@uniswap/v4-periphery/src/interfaces/IPositionManager.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";
import {HookMiner} from "@uniswap/v4-periphery/test/shared/HookMiner.sol";
import {QuoteFeeHook} from "src/QuoteFeeHook.sol";
import {QuoteLaunchFactory} from "src/QuoteLaunchFactory.sol";

/// Atomic deployment: mine the hook salt for the deployer's next CREATE factory address.
/// Dry-run first. Any deployer nonce change requires rerunning mining and simulation.
contract DeployQuoteLaunchFactory is Script {
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

    /// Known PoolManager and PositionManager per chain; zero where a chain must pass its own.
    function _known(uint256 chainId) internal pure returns (address pm, address posm) {
        if (chainId == 8453) {
            return (0x498581fF718922c3f8e6A244956aF099B2652b2b, 0x7C5f5A4bBd8fD63184577525326123B519429bDc);
        }
        if (chainId == 4663) {
            return (0x8366a39CC670B4001A1121B8F6A443A643e40951, 0x58daec3116aae6D93017bAAea7749052E8a04fA7);
        }
        if (chainId == 5042) {
            // Uniswap/contracts deployments/5042.md — same PoolManager address as Robinhood, a different PositionManager
            return (0x8366a39CC670B4001A1121B8F6A443A643e40951, 0x6049c9a0e26405C0985f9E3685C87d0aE917f82B);
        }
        return (address(0), address(0));
    }

    /// Mine the hook salt for the deployer's next CREATE address and deploy the whole suite in one transaction.
    function run() external returns (QuoteLaunchFactory factory) {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        (address pmDefault, address posmDefault) = _known(block.chainid);
        IPoolManager pm = IPoolManager(vm.envOr("POOL_MANAGER", pmDefault));
        IPositionManager posm = IPositionManager(vm.envOr("POSITION_MANAGER", posmDefault));
        address predictedFactory = vm.computeCreateAddress(vm.addr(pk), vm.getNonce(vm.addr(pk)));
        address predictedVault = vm.computeCreateAddress(predictedFactory, 2);
        (address predictedHook, bytes32 salt) = HookMiner.find(
            predictedFactory,
            uint160(0x20cc),
            type(QuoteFeeHook).creationCode,
            abi.encode(pm, predictedFactory, predictedVault)
        );
        vm.startBroadcast(pk);
        factory = new QuoteLaunchFactory(pm, posm, IAllowanceTransfer(PERMIT2), salt);
        vm.stopBroadcast();
        require(
            address(factory) == predictedFactory && address(factory.hook()) == predictedHook
                && address(factory.vault()) == predictedVault,
            "deployment prediction mismatch"
        );
        console.log("Chain:", block.chainid);
        console.log("QuoteLaunchFactory:", address(factory));
        console.log("LaunchLocker:", address(factory.locker()));
        console.log("QuoteFeeVault:", address(factory.vault()));
        console.log("QuoteFeeHook:", address(factory.hook()));
        console.logBytes32(salt);
    }
}
