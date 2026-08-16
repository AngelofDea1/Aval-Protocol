// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";

import {DealManager} from "../src/DealManager.sol";
import {AvalAttestation} from "../src/libraries/AvalAttestation.sol";
import {ProtocolRevenueAdapter} from "../src/adapters/ProtocolRevenueAdapter.sol";

/// @notice Funds the single loan used for the live slash demo. Idempotent and safe to run
///         against an already-seeded deployment.
///
///     forge script script/SeedDemoLoan.s.sol:SeedDemoLoan --rpc-url $XLAYER_TESTNET_RPC_URL --broadcast
///
/// Why this exists separately from Seed.s.sol:
///
/// Foundry simulates a whole script against one `block.timestamp`, then broadcasts the
/// transactions afterwards. Anything computed from `block.timestamp` during simulation is
/// baked in, so a maturity of "now + 2 minutes" is already in the past by the time the
/// transaction lands ten transactions later, and `fundDeal` correctly rejects it with
/// MaturityInPast().
///
/// So the window has to be wide enough to survive the simulate-to-broadcast delay while
/// still being short enough to settle during a demo. Fifteen minutes with no grace period
/// gives both.
contract SeedDemoLoan is Script {
    uint256 constant PRINCIPAL = 50_000e6;
    uint16 constant DISCOUNT_BPS = 900;
    uint16 constant PD_BPS = 500;

    /// Long enough to survive broadcast lag, short enough to demo the same session.
    uint64 constant TERM = 15 minutes;

    function run() external {
        require(block.chainid != 196, "SeedDemoLoan: refusing to run on mainnet");

        uint256 deployerPk = vm.envUint("PRIVATE_KEY");
        uint256 uwPk = vm.envUint("UNDERWRITER_PRIVATE_KEY");
        address deployer = vm.addr(deployerPk);
        address underwriter = vm.addr(uwPk);
        bytes32 modelCommit = vm.envBytes32("MODEL_COMMIT");

        DealManager dm = DealManager(vm.envAddress("DEAL_MANAGER_ADDRESS"));
        ProtocolRevenueAdapter adapter = ProtocolRevenueAdapter(vm.envAddress("ADAPTER_ADDRESS"));

        bytes32 dealId = keccak256("seed:defaulted");
        bytes32 obligorId = keccak256("demo-protocol-revenue");

        require(dm.getDeal(dealId).status == DealManager.Status.None, "demo loan already funded");

        DealManager.DealParams memory p = DealManager.DealParams({
            dealId: dealId,
            borrower: deployer,
            adapter: address(adapter),
            principal: PRINCIPAL,
            discountBps: DISCOUNT_BPS,
            maturity: uint64(block.timestamp) + TERM,
            gracePeriod: 0
        });

        AvalAttestation.Attestation memory a = AvalAttestation.Attestation({
            dealId: dealId,
            termsHash: dm.hashTerms(p),
            underwriter: underwriter,
            pdBps: PD_BPS,
            pdUpperBps: PD_BPS + 300,
            advanceRateBps: 8_500,
            modelCommit: modelCommit,
            featureHash: keccak256("demo-features"),
            rationaleCID: keccak256("demo-rationale"),
            issuedAt: uint64(block.timestamp),
            expiresAt: uint64(block.timestamp) + 1 hours
        });

        (uint8 v, bytes32 r, bytes32 s) = vm.sign(uwPk, dm.hashAttestation(a));

        vm.startBroadcast(deployerPk);
        // Seed.s.sol may already have linked this deal before its fundDeal reverted.
        if (adapter.dealObligor(dealId) == bytes32(0)) {
            adapter.linkDeal(dealId, obligorId);
        }
        dm.fundDeal(p, a, abi.encodePacked(r, s, v));
        vm.stopBroadcast();

        console2.log("demo loan funded");
        console2.log("  principal      ", PRINCIPAL);
        console2.log("  declared risk  ", uint256(PD_BPS), "bps");
        console2.log("  bond locked    ", dm.getDeal(dealId).avalLocked);
        console2.log("  settleable at  ", p.maturity);
        console2.log("");
        console2.log("Wait until that timestamp, then run:");
        console2.log("  bash script/slash-demo.sh");
    }
}
