// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @notice Hands ownership of every owned contract to a multisig.
///
///     NEW_OWNER=0x... forge script script/TransferOwnership.s.sol:TransferOwnership \
///       --rpc-url $XLAYER_RPC_URL --broadcast
///
/// Deploy.s.sol deliberately leaves ownership with the deployer so the seed step can run.
/// That is fine on testnet and unacceptable on mainnet: `setParams`, `setTermLimits`,
/// `setConsumer` and `pause` are all fund-relevant, and a single hot key holding them is a
/// single point of failure for everyone's money.
///
/// This is one-way. Once transferred, the deployer key cannot pause the protocol or change
/// parameters, so make certain the new owner is a multisig you actually control and can
/// transact from before running it.
contract TransferOwnership is Script {
    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address newOwner = vm.envAddress("NEW_OWNER");
        require(newOwner != address(0), "NEW_OWNER unset");

        address deployer = vm.addr(pk);
        require(newOwner != deployer, "NEW_OWNER is the deployer, that defeats the point");

        // Confirm the target can actually receive: an EOA typo here bricks governance.
        require(newOwner.code.length > 0 || vm.envOr("ALLOW_EOA_OWNER", false), "NEW_OWNER has no code. Set ALLOW_EOA_OWNER=true if this really is an EOA.");

        address[4] memory targets = [
            vm.envAddress("REGISTRY_ADDRESS"),
            vm.envAddress("REPUTATION_ADDRESS"),
            vm.envAddress("VAULT_ADDRESS"),
            vm.envAddress("DEAL_MANAGER_ADDRESS")
        ];
        string[4] memory names = ["UnderwriterRegistry", "Reputation", "SeniorVault", "DealManager"];

        console2.log("transferring ownership");
        console2.log("  from", deployer);
        console2.log("  to  ", newOwner);
        console2.log("");

        vm.startBroadcast(pk);
        for (uint256 i = 0; i < targets.length; i++) {
            Ownable target = Ownable(targets[i]);
            require(target.owner() == deployer, string.concat(names[i], ": deployer is not the current owner"));
            target.transferOwnership(newOwner);
        }
        vm.stopBroadcast();

        for (uint256 i = 0; i < targets.length; i++) {
            address actual = Ownable(targets[i]).owner();
            require(actual == newOwner, string.concat(names[i], ": transfer did not take effect"));
            console2.log(string.concat("  ok  ", names[i]));
        }

        console2.log("");
        console2.log("Adapters were deployed owned by OWNER_ADDRESS already; check them separately");
        console2.log("if that was not the multisig.");
    }
}
