// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {UnderwriterRegistry} from "../src/UnderwriterRegistry.sol";
import {Reputation} from "../src/Reputation.sol";
import {SeniorVault} from "../src/SeniorVault.sol";
import {DealManager} from "../src/DealManager.sol";
import {ProtocolRevenueAdapter} from "../src/adapters/ProtocolRevenueAdapter.sol";
import {InvoiceAdapter} from "../src/adapters/InvoiceAdapter.sol";

/// @notice Deploys and wires the protocol, then asserts the wiring actually landed.
///
///     forge script script/Deploy.s.sol:Deploy --rpc-url xlayer_testnet --broadcast
///
/// Required env: PRIVATE_KEY, USDT_ADDRESS, OWNER_ADDRESS
/// Optional env: MIN_BOND (default 10,000 USDT at 6dp)
///
/// The post-deploy assertions are the point of this script. Access control here is set in
/// three separate calls after construction, and a silently-missed one produces a system that
/// deploys cleanly, verifies cleanly, and then reverts on the first real deal.
contract Deploy is Script {
    struct Deployment {
        address registry;
        address reputation;
        address vault;
        address dealManager;
        address protocolRevenueAdapter;
        address invoiceAdapter;
    }

    function run() external returns (Deployment memory d) {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address usdt = vm.envAddress("USDT_ADDRESS");
        address owner = vm.envAddress("OWNER_ADDRESS");
        uint256 minBond = vm.envOr("MIN_BOND", uint256(10_000e6));

        require(usdt != address(0), "USDT_ADDRESS unset");
        require(owner != address(0), "OWNER_ADDRESS unset");

        address deployer = vm.addr(pk);
        console2.log("chain id ", block.chainid);
        console2.log("deployer ", deployer);
        console2.log("owner    ", owner);
        console2.log("usdt     ", usdt);

        vm.startBroadcast(pk);

        // Deploy with the deployer as interim owner so wiring can happen in one broadcast,
        // then hand ownership over at the end.
        UnderwriterRegistry registry = new UnderwriterRegistry(usdt, minBond, deployer);
        Reputation reputation = new Reputation(deployer);
        SeniorVault vault = new SeniorVault(IERC20(usdt), "Aval Senior USDT", "avUSDT", deployer);
        DealManager dealManager = new DealManager(IERC20(usdt), registry, reputation, vault, deployer);

        ProtocolRevenueAdapter revenueAdapter = new ProtocolRevenueAdapter(owner);
        InvoiceAdapter invoiceAdapter = new InvoiceAdapter(owner);

        // Wiring - all three are mandatory.
        registry.setConsumer(address(dealManager), true);
        reputation.setConsumer(address(dealManager), true);
        vault.setDealManager(address(dealManager));

        vm.stopBroadcast();

        // ---- verify the wiring rather than assuming it -----------------------
        require(registry.consumers(address(dealManager)), "WIRING: registry consumer not set");
        require(reputation.consumers(address(dealManager)), "WIRING: reputation consumer not set");
        require(vault.dealManager() == address(dealManager), "WIRING: vault dealManager not set");
        require(address(dealManager.registry()) == address(registry), "WIRING: dealManager registry mismatch");
        require(address(dealManager.vault()) == address(vault), "WIRING: dealManager vault mismatch");
        require(address(dealManager.reputation()) == address(reputation), "WIRING: dealManager reputation mismatch");
        require(registry.bondToken() == usdt, "WIRING: registry bond token mismatch");
        require(vault.asset() == usdt, "WIRING: vault asset mismatch");

        d = Deployment({
            registry: address(registry),
            reputation: address(reputation),
            vault: address(vault),
            dealManager: address(dealManager),
            protocolRevenueAdapter: address(revenueAdapter),
            invoiceAdapter: address(invoiceAdapter)
        });

        console2.log("");
        console2.log("UnderwriterRegistry    ", d.registry);
        console2.log("Reputation             ", d.reputation);
        console2.log("SeniorVault            ", d.vault);
        console2.log("DealManager            ", d.dealManager);
        console2.log("ProtocolRevenueAdapter ", d.protocolRevenueAdapter);
        console2.log("InvoiceAdapter         ", d.invoiceAdapter);
        console2.log("");
        console2.log("EIP-712 domain separator:");
        console2.logBytes32(dealManager.domainSeparator());

        _writeDeployment(d);

        console2.log("");
        console2.log("NEXT STEPS (not done automatically):");
        console2.log(" 1. transfer ownership of registry/reputation/vault/dealManager to OWNER");
        console2.log(" 2. seed the vault with a small deposit before opening it");
        console2.log(" 3. set reporters on the adapters");
        console2.log(" 4. verify contracts on the explorer");

        return d;
    }

    function _writeDeployment(Deployment memory d) internal {
        string memory dir = "deployments";
        string memory path = string.concat(dir, "/", vm.toString(block.chainid), ".json");

        string memory json = string.concat(
            "{\n",
            '  "chainId": ', vm.toString(block.chainid), ",\n",
            '  "registry": "', vm.toString(d.registry), '",\n',
            '  "reputation": "', vm.toString(d.reputation), '",\n',
            '  "vault": "', vm.toString(d.vault), '",\n',
            '  "dealManager": "', vm.toString(d.dealManager), '",\n',
            '  "protocolRevenueAdapter": "', vm.toString(d.protocolRevenueAdapter), '",\n',
            '  "invoiceAdapter": "', vm.toString(d.invoiceAdapter), '"\n',
            "}\n"
        );

        vm.createDir(dir, true);
        vm.writeFile(path, json);
        console2.log("");
        console2.log("wrote", path);
    }
}
