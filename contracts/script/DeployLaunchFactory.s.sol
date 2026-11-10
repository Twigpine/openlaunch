// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IPositionManager} from "@uniswap/v4-periphery/src/interfaces/IPositionManager.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";
import {LaunchFactory} from "src/LaunchFactory.sol";
import {LaunchFactoryArc} from "src/LaunchFactoryArc.sol";

/// Deploys the fee-free LaunchFactory (+ its LaunchLocker) against the canonical
/// Uniswap v4 deployment of the current chain (Base 8453, Robinhood Chain 4663, Arc 5042, Elysium 99901).
/// On Arc it deploys LaunchFactoryArc (src/LaunchFactoryArc.sol: the same contract plus the native-quote guard).
/// There is nothing to configure: no fee recipient, no bps, no owner.
///
/// Env:
///   DEPLOYER_PRIVATE_KEY   required
///   POOL_MANAGER / POSITION_MANAGER  optional overrides (required on other chains)
///
/// Run:
///   forge script script/DeployLaunchFactory.s.sol --rpc-url https://mainnet.base.org --broadcast
///   forge script script/DeployLaunchFactory.s.sol --rpc-url https://rpc.mainnet.chain.robinhood.com --broadcast
///   forge script script/DeployLaunchFactory.s.sol --rpc-url $ARC_RPC_URL --broadcast   (Arc: gas is paid in USDC; fund the deployer with USDC)
///   forge script script/DeployLaunchFactory.s.sol --rpc-url $ELYSIUM_RPC_URL --broadcast   (Elysium: gas is paid in HYPE; fund the deployer with HYPE)
/// Then verify factory + locker (constructor args: factory = pm, posm, permit2;
/// locker = posm) and point the app at the factory address.
contract DeployLaunchFactory is Script {
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

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
        if (chainId == 99901) {
            // Elysium (Kinetiq's Arbitrum Orbit L2 for Hyperliquid): Uniswap/contracts deployments/99901.md. Plain LaunchFactory:
            // HYPE is an ordinary native asset with no ERC-20 face sharing its balance (test/LaunchFactory.elysium.fork.t.sol)
            return (0xE2e105d3F7209A9DA11f83cCf3E7398a753823F1, 0x1d1C51b9d07fD27d36412A2b66CC23D19Eb3E518);
        }
        return (address(0), address(0));
    }

    uint256 constant ARC_CHAIN_ID = 5042;

    function run() external returns (address factory, address locker) {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        (address pmDefault, address posmDefault) = _known(block.chainid);
        address pm = vm.envOr("POOL_MANAGER", pmDefault);
        address posm = vm.envOr("POSITION_MANAGER", posmDefault);
        require(pm != address(0) && posm != address(0), "unknown chain: set POOL_MANAGER + POSITION_MANAGER");
        require(pm.code.length > 0 && posm.code.length > 0 && PERMIT2.code.length > 0, "v4 not deployed here");
        // Base and Robinhood Chain got the factory from the deployer's first transaction (nonce 0; the locker is created by the
        // factory's constructor), which is what makes the addresses identical across chains. Refuse to deploy from any other
        // nonce unless explicitly allowed, so a stray transaction cannot silently put a new chain on different addresses.
        address deployer = vm.addr(pk);
        uint64 nonce = vm.getNonce(deployer);
        console.log("Deployer:       ", deployer);
        console.log("Deployer nonce: ", nonce);
        require(
            nonce == 0 || vm.envOr("ALLOW_NONZERO_NONCE", false),
            "deployer nonce is not 0: addresses would differ from Base/Robinhood (ALLOW_NONZERO_NONCE=true to override)"
        );

        vm.startBroadcast(pk);
        if (block.chainid == ARC_CHAIN_ID) {
            LaunchFactoryArc f =
                new LaunchFactoryArc(IPoolManager(pm), IPositionManager(posm), IAllowanceTransfer(PERMIT2));
            (factory, locker) = (address(f), address(f.locker()));
        } else {
            LaunchFactory f = new LaunchFactory(IPoolManager(pm), IPositionManager(posm), IAllowanceTransfer(PERMIT2));
            (factory, locker) = (address(f), address(f.locker()));
        }
        vm.stopBroadcast();

        console.log("Chain ID:       ", block.chainid);
        console.log("PoolManager:    ", pm);
        console.log("PositionManager:", posm);
        console.log(block.chainid == ARC_CHAIN_ID ? "LaunchFactoryArc:" : "LaunchFactory:  ", factory);
        console.log("LaunchLocker:   ", locker);
        console.log("Platform fee:    none (no fee address exists)");
    }
}
