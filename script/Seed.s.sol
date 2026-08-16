// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";

import {UnderwriterRegistry} from "../src/UnderwriterRegistry.sol";
import {Reputation} from "../src/Reputation.sol";
import {SeniorVault} from "../src/SeniorVault.sol";
import {DealManager} from "../src/DealManager.sol";
import {AvalAttestation} from "../src/libraries/AvalAttestation.sol";
import {ProtocolRevenueAdapter} from "../src/adapters/ProtocolRevenueAdapter.sol";
import {MockUSDT} from "../src/mocks/MockUSDT.sol";

/// @notice Testnet fixture. Produces a demo-ready state in one run.
///
///     forge script script/Seed.s.sol:Seed --rpc-url $XLAYER_TESTNET_RPC_URL --broadcast
///
/// TESTNET ONLY. It mints MockUSDT and refuses to run against mainnet.
///
/// Creates three loans in deliberately different states so the demo can show the whole
/// lifecycle without waiting 30 days:
///
///   1. live      funded, in flight, bond locked
///   2. repaid    funded and repaid in full, settled, underwriter paid a Brier-scored fee
///   3. defaulted funded, short maturity, left UNSETTLED on purpose
///
/// Leaving the third unsettled is the point. Calling settle() on it live is the demo: the
/// bond is slashed on screen, lenders are made whole, and the Brier score visibly degrades.
///
/// Everything the helpers need lives in storage rather than being passed around. Solidity's
/// stack limit is 16 slots and threading contracts, keys and terms through a single call
/// blows it, which is exactly what happened the first time this ran.
contract Seed is Script {
    uint256 constant LP_CAPITAL = 500_000e6;
    uint256 constant BOND = 60_000e6;
    uint256 constant PRINCIPAL = 50_000e6;
    uint16 constant DISCOUNT_BPS = 900;

    // Set once in run(), read by the helpers.
    DealManager dm;
    UnderwriterRegistry registry;
    SeniorVault vault;
    Reputation reputation;
    ProtocolRevenueAdapter adapter;
    MockUSDT usdt;

    uint256 deployerPk;
    uint256 uwPk;
    address deployer;
    address underwriter;
    bytes32 modelCommit;
    bytes32 obligorId;

    function run() external {
        require(block.chainid != 196, "Seed: refusing to run on mainnet");

        deployerPk = vm.envUint("PRIVATE_KEY");
        uwPk = vm.envUint("UNDERWRITER_PRIVATE_KEY");
        deployer = vm.addr(deployerPk);
        underwriter = vm.addr(uwPk);
        modelCommit = vm.envBytes32("MODEL_COMMIT");

        usdt = MockUSDT(vm.envAddress("USDT_ADDRESS"));
        dm = DealManager(vm.envAddress("DEAL_MANAGER_ADDRESS"));
        registry = UnderwriterRegistry(vm.envAddress("REGISTRY_ADDRESS"));
        vault = SeniorVault(vm.envAddress("VAULT_ADDRESS"));
        reputation = Reputation(vm.envAddress("REPUTATION_ADDRESS"));
        adapter = ProtocolRevenueAdapter(vm.envAddress("ADAPTER_ADDRESS"));
        obligorId = keccak256("demo-protocol-revenue");

        console2.log("seeding on chain", block.chainid);
        console2.log("deployer   ", deployer);
        console2.log("underwriter", underwriter);

        _setupCapital();

        _fund(keccak256("seed:live"), 700, false);
        console2.log("deal 1 (live) funded");

        bytes32 repaidId = keccak256("seed:repaid");
        _fund(repaidId, 400, false);
        _repayAndSettle(repaidId);
        console2.log("deal 2 (repaid) settled");

        bytes32 defaultedId = keccak256("seed:defaulted");
        _fund(defaultedId, 500, true);
        console2.log("deal 3 (defaulted) funded, left unsettled on purpose");

        console2.log("");
        console2.log("vault total assets", vault.totalAssets());
        console2.log("underwriter bond  ", registry.getUnderwriter(underwriter).bondTotal);
        console2.log("brier score       ", reputation.brierScore(underwriter));
        console2.log("");
        console2.log("DEMO: once deal 3 is past maturity plus grace, call settle with");
        console2.logBytes32(defaultedId);
        console2.log("The bond is slashed on screen and the Brier score degrades.");
    }

    function _setupCapital() internal {
        vm.startBroadcast(deployerPk);
        usdt.mint(deployer, LP_CAPITAL + 300_000e6); // pool plus repayment float
        usdt.mint(underwriter, BOND);

        usdt.approve(address(vault), LP_CAPITAL);
        vault.deposit(LP_CAPITAL, deployer);

        adapter.setReporter(deployer, true);
        adapter.registerObligor(obligorId, keccak256("defillama:demo"), "Demo protocol revenue");
        vm.stopBroadcast();

        vm.startBroadcast(uwPk);
        usdt.approve(address(registry), BOND);
        registry.register(modelCommit, BOND);
        vm.stopBroadcast();

        console2.log("vault capital", vault.totalAssets());
        console2.log("bond posted  ", registry.getUnderwriter(underwriter).bondTotal);
    }

    /// @param shortTerm true for the deal that should become settleable during the demo
    function _fund(bytes32 dealId, uint16 pdBps, bool shortTerm) internal {
        DealManager.DealParams memory p = DealManager.DealParams({
            dealId: dealId,
            borrower: deployer,
            adapter: address(adapter),
            principal: PRINCIPAL,
            discountBps: DISCOUNT_BPS,
            // Foundry bakes block.timestamp in at SIMULATION time and broadcasts later, so
            // a two minute window is already in the past by the time the transaction lands
            // and fundDeal correctly rejects it. Fifteen minutes survives the lag while
            // still being settleable during a demo.
            maturity: uint64(block.timestamp + (shortTerm ? 15 minutes : 30 days)),
            gracePeriod: shortTerm ? uint64(0) : uint64(7 days)
        });

        bytes memory sig = _sign(p, pdBps);

        vm.startBroadcast(deployerPk);
        adapter.linkDeal(dealId, obligorId);
        dm.fundDeal(p, _attestation(p, pdBps), sig);
        vm.stopBroadcast();
    }

    /// @dev Split out so fundDeal's arguments and the signature never share a stack frame.
    function _attestation(DealManager.DealParams memory p, uint16 pdBps)
        internal
        view
        returns (AvalAttestation.Attestation memory)
    {
        return AvalAttestation.Attestation({
            dealId: p.dealId,
            termsHash: dm.hashTerms(p),
            underwriter: underwriter,
            pdBps: pdBps,
            pdUpperBps: pdBps + 300,
            advanceRateBps: 8_500,
            modelCommit: modelCommit,
            featureHash: keccak256(abi.encodePacked("seed-features:", p.dealId)),
            rationaleCID: keccak256(abi.encodePacked("seed-rationale:", p.dealId)),
            issuedAt: uint64(block.timestamp),
            expiresAt: uint64(block.timestamp + 1 hours)
        });
    }

    function _sign(DealManager.DealParams memory p, uint16 pdBps) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(uwPk, dm.hashAttestation(_attestation(p, pdBps)));
        return abi.encodePacked(r, s, v);
    }

    function _repayAndSettle(bytes32 dealId) internal {
        uint256 due = dm.getDeal(dealId).dueAmount;
        vm.startBroadcast(deployerPk);
        usdt.approve(address(dm), due);
        dm.repay(dealId, due);
        dm.settle(dealId);
        vm.stopBroadcast();
    }
}
