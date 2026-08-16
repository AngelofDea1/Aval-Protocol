// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

import {UnderwriterRegistry} from "../src/UnderwriterRegistry.sol";
import {Reputation} from "../src/Reputation.sol";
import {SeniorVault} from "../src/SeniorVault.sol";
import {DealManager} from "../src/DealManager.sol";
import {AvalAttestation} from "../src/libraries/AvalAttestation.sol";
import {ScoringRule} from "../src/libraries/ScoringRule.sol";
import {MockUSDT} from "../src/mocks/MockUSDT.sol";
import {MockCashflowAdapter} from "../src/mocks/MockCashflowAdapter.sol";

contract AvalProtocolTest is Test {
    MockUSDT usdt;
    UnderwriterRegistry registry;
    Reputation reputation;
    SeniorVault vault;
    DealManager dm;
    MockCashflowAdapter adapter;

    uint256 constant UW_PK = 0xA11CE;
    address underwriter;
    address owner = address(0xB0B);
    address lp = address(0x11);
    address borrower = address(0x22);

    bytes32 constant MODEL_COMMIT = keccak256("aval-underwriter-v0.1.0");

    uint256 constant LP_CAPITAL = 1_000_000e6;
    uint256 constant BOND = 50_000e6;
    uint256 constant PRINCIPAL = 100_000e6;
    uint16 constant DISCOUNT_BPS = 800;

    function setUp() public {
        underwriter = vm.addr(UW_PK);

        usdt = new MockUSDT();
        registry = new UnderwriterRegistry(address(usdt), 10_000e6, owner);
        reputation = new Reputation(owner);
        vault = new SeniorVault(IERC20(address(usdt)), "Aval Senior USDT", "avUSDT", owner);
        dm = new DealManager(IERC20(address(usdt)), registry, reputation, vault, owner);
        adapter = new MockCashflowAdapter(keccak256("protocol-revenue-v1"));

        vm.startPrank(owner);
        registry.setConsumer(address(dm), true);
        reputation.setConsumer(address(dm), true);
        vault.setDealManager(address(dm));
        vm.stopPrank();

        usdt.mint(lp, LP_CAPITAL);
        usdt.mint(underwriter, BOND);
        usdt.mint(borrower, 500_000e6);

        vm.startPrank(lp);
        usdt.approve(address(vault), LP_CAPITAL);
        vault.deposit(LP_CAPITAL, lp);
        vm.stopPrank();

        vm.startPrank(underwriter);
        usdt.approve(address(registry), BOND);
        registry.register(MODEL_COMMIT, BOND);
        vm.stopPrank();
    }

    // ------------------------------------------------------------- helpers

    function _params(bytes32 dealId, uint256 principal) internal view returns (DealManager.DealParams memory) {
        return DealManager.DealParams({
            dealId: dealId,
            borrower: borrower,
            adapter: address(adapter),
            principal: principal,
            discountBps: DISCOUNT_BPS,
            maturity: uint64(block.timestamp + 30 days),
            gracePeriod: 7 days
        });
    }

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
            pdUpperBps: pdBps + 200,
            advanceRateBps: 8_500,
            modelCommit: MODEL_COMMIT,
            featureHash: keccak256("features"),
            rationaleCID: keccak256("ipfs"),
            issuedAt: uint64(block.timestamp),
            expiresAt: uint64(block.timestamp + 1 hours)
        });
    }

    function _sign(AvalAttestation.Attestation memory a, uint256 pk) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, dm.hashAttestation(a));
        return abi.encodePacked(r, s, v);
    }

    /// @dev Solidity assigns memory structs by reference, so `b = a` aliases rather than
    ///      copies. Mutating the "copy" would silently corrupt the original.
    function _copy(DealManager.DealParams memory p) internal pure returns (DealManager.DealParams memory) {
        return DealManager.DealParams({
            dealId: p.dealId,
            borrower: p.borrower,
            adapter: p.adapter,
            principal: p.principal,
            discountBps: p.discountBps,
            maturity: p.maturity,
            gracePeriod: p.gracePeriod
        });
    }

    function _fund(bytes32 dealId, uint16 pdBps) internal returns (DealManager.DealParams memory p) {
        p = _params(dealId, PRINCIPAL);
        AvalAttestation.Attestation memory a = _attestation(p, pdBps);
        dm.fundDeal(p, a, _sign(a, UW_PK));
    }

    // -------------------------------------------------------------- funding

    function test_FundDeal_MovesPrincipalAndLocksBond() public {
        uint256 before = usdt.balanceOf(borrower);
        DealManager.DealParams memory p = _fund(keccak256("d1"), 500);

        DealManager.Deal memory d = dm.getDeal(p.dealId);
        assertEq(d.principal, PRINCIPAL, "principal");
        assertEq(d.dueAmount, PRINCIPAL + (PRINCIPAL * DISCOUNT_BPS) / 10_000, "due");
        assertEq(d.avalLocked, (PRINCIPAL * 1_500) / 10_000, "aval");
        assertEq(usdt.balanceOf(borrower) - before, PRINCIPAL, "borrower funded");
        assertEq(vault.totalAssets(), LP_CAPITAL, "funding must not change total assets");
        assertEq(vault.deployedAssets(), PRINCIPAL, "deployed");
        assertEq(registry.getUnderwriter(underwriter).bondLocked, (PRINCIPAL * 1_500) / 10_000, "locked");
    }

    // NOTE on all expectRevert tests below: `_sign` makes an external call to
    // `dm.hashAttestation`. Foundry applies `vm.expectRevert` to the *next* call, and
    // arguments are evaluated first - so signing inline would arm the cheatcode against
    // `hashAttestation` (which succeeds) rather than `fundDeal`. Always hoist the signature.

    function test_RejectsForgedSignature() public {
        DealManager.DealParams memory p = _params(keccak256("d2"), PRINCIPAL);
        AvalAttestation.Attestation memory a = _attestation(p, 500);
        bytes memory sig = _sign(a, 0xBADBAD);

        vm.expectRevert(DealManager.BadSigner.selector);
        dm.fundDeal(p, a, sig);
    }

    function test_RejectsStaleModelCommit() public {
        DealManager.DealParams memory p = _params(keccak256("d3"), PRINCIPAL);
        AvalAttestation.Attestation memory a = _attestation(p, 500);
        a.modelCommit = keccak256("other-model");
        bytes memory sig = _sign(a, UW_PK);

        vm.expectRevert(DealManager.StaleModelCommit.selector);
        dm.fundDeal(p, a, sig);
    }

    function test_RejectsPdAbovePolicy() public {
        DealManager.DealParams memory p = _params(keccak256("d4"), PRINCIPAL);
        AvalAttestation.Attestation memory a = _attestation(p, 500);
        a.pdUpperBps = 5_000;
        bytes memory sig = _sign(a, UW_PK);

        vm.expectRevert(DealManager.PdAbovePolicy.selector);
        dm.fundDeal(p, a, sig);
    }

    function test_RejectsExpiredAttestation() public {
        DealManager.DealParams memory p = _params(keccak256("d5"), PRINCIPAL);
        AvalAttestation.Attestation memory a = _attestation(p, 500);
        bytes memory sig = _sign(a, UW_PK);
        vm.warp(block.timestamp + 2 hours);
        vm.expectRevert(DealManager.AttestationExpired.selector);
        dm.fundDeal(p, a, sig);
    }

    /// The attestation must bind the economic terms, not just the deal id. Without this an
    /// observer could replay a valid signature with their own borrower and a principal up to
    /// the vault's entire idle balance.
    function test_RejectsTermsSubstitution() public {
        DealManager.DealParams memory honest = _params(keccak256("d6"), PRINCIPAL);
        AvalAttestation.Attestation memory a = _attestation(honest, 500);
        bytes memory sig = _sign(a, UW_PK);

        DealManager.DealParams memory looted = _copy(honest);
        looted.borrower = address(0xDEAD);
        looted.principal = 800_000e6;

        vm.expectRevert(DealManager.TermsMismatch.selector);
        dm.fundDeal(looted, a, sig);
        assertEq(vault.deployedAssets(), 0, "vault untouched");

        // A single unit of difference is still a mismatch.
        DealManager.DealParams memory nudged = _copy(honest);
        nudged.principal = PRINCIPAL + 1;
        vm.expectRevert(DealManager.TermsMismatch.selector);
        dm.fundDeal(nudged, a, sig);

        dm.fundDeal(honest, a, sig);
        assertEq(vault.deployedAssets(), PRINCIPAL, "intended terms still fund");
    }

    function test_RejectsDuplicateDeal() public {
        DealManager.DealParams memory p = _params(keccak256("d7"), PRINCIPAL);
        AvalAttestation.Attestation memory a = _attestation(p, 500);
        bytes memory sig = _sign(a, UW_PK);
        dm.fundDeal(p, a, sig);
        vm.expectRevert(DealManager.DealExists.selector);
        dm.fundDeal(p, a, sig);
    }

    // ------------------------------------------------------------ settlement

    function test_HappyPath_PaysBrierFeeAndReleasesBond() public {
        DealManager.DealParams memory p = _fund(keccak256("h1"), 500);
        DealManager.Deal memory d = dm.getDeal(p.dealId);

        vm.startPrank(borrower);
        usdt.approve(address(dm), d.dueAmount);
        dm.repay(p.dealId, d.dueAmount);
        vm.stopPrank();

        dm.settle(p.dealId);

        uint256 feeBase = (PRINCIPAL * 100) / 10_000;
        assertEq(usdt.balanceOf(underwriter), ScoringRule.brierFee(feeBase, 500, false), "brier fee");
        assertEq(registry.getUnderwriter(underwriter).bondLocked, 0, "bond released");
        assertEq(vault.deployedAssets(), 0, "deployed cleared");
        assertGt(vault.totalAssets(), LP_CAPITAL, "LPs earned");

        Reputation.Record memory r = reputation.getRecord(underwriter);
        assertEq(r.predictions, 1);
        assertEq(r.defaults, 0);
        assertEq(r.sumSquaredError, ScoringRule.squaredError(500, false));
    }

    function test_Default_SlashesBondIntoVault() public {
        DealManager.DealParams memory p = _fund(keccak256("x1"), 500);
        DealManager.Deal memory d = dm.getDeal(p.dealId);
        uint256 aval = d.avalLocked;

        vm.expectRevert(DealManager.NotYetSettleable.selector);
        dm.settle(p.dealId);

        vm.warp(block.timestamp + 38 days);
        dm.settle(p.dealId);

        assertTrue(dm.getDeal(p.dealId).defaulted, "defaulted");
        assertEq(registry.getUnderwriter(underwriter).bondTotal, BOND - aval, "bond slashed");
        assertEq(registry.getUnderwriter(underwriter).bondLocked, 0, "lock cleared");

        // LPs wear only the shortfall beyond the bond, less the underwriter's residual fee.
        uint256 feeBase = (PRINCIPAL * 100) / 10_000;
        uint256 fee = ScoringRule.brierFee(feeBase, 500, true);
        assertEq(vault.totalAssets(), LP_CAPITAL - PRINCIPAL + aval - fee, "LP loss bounded by bond");

        Reputation.Record memory r = reputation.getRecord(underwriter);
        assertEq(r.defaults, 1);
        assertEq(r.totalSlashed, aval);
    }

    function test_SettleTwiceReverts() public {
        DealManager.DealParams memory p = _fund(keccak256("s1"), 500);
        vm.warp(block.timestamp + 38 days);
        dm.settle(p.dealId);
        vm.expectRevert(DealManager.AlreadySettled.selector);
        dm.settle(p.dealId);
    }

    // ------------------------------------------------------------ properness

    /// The fee must reward honest reporting: on a default, a higher declared PD earns more;
    /// on a repayment, a lower one does. Neither bias wins in both states, which is what
    /// makes truthful reporting optimal.
    function testFuzz_ScoringRuleIsProper(uint16 low, uint16 high) public pure {
        low = uint16(bound(low, 0, 4_999));
        high = uint16(bound(high, 5_001, 10_000));
        uint256 base = 1_000e6;

        assertGt(ScoringRule.brierFee(base, high, true), ScoringRule.brierFee(base, low, true), "default state");
        assertGt(ScoringRule.brierFee(base, low, false), ScoringRule.brierFee(base, high, false), "repaid state");
    }

    function testFuzz_BrierFeeBounded(uint16 pdBps, bool defaulted) public pure {
        pdBps = uint16(bound(pdBps, 0, 10_000));
        uint256 base = 1_000e6;
        uint256 fee = ScoringRule.brierFee(base, pdBps, defaulted);
        assertLe(fee, base, "fee never exceeds base");
    }

    function testFuzz_PerfectPredictionEarnsFullFee(bool defaulted) public pure {
        uint256 base = 1_000e6;
        assertEq(ScoringRule.brierFee(base, defaulted ? 10_000 : 0, defaulted), base);
    }

    // -------------------------------------------------------------- accounting

    function testFuzz_VaultAccountingHolds(uint256 principal, uint16 discountBps) public {
        // Bond, not vault liquidity, is the binding constraint: aval is 15% of principal and
        // the underwriter has posted 50k, so principal above ~333k cannot be bonded.
        principal = bound(principal, 1e6, 300_000e6);
        discountBps = uint16(bound(discountBps, 0, 5_000));

        DealManager.DealParams memory p = _params(keccak256("f1"), principal);
        p.discountBps = discountBps;
        AvalAttestation.Attestation memory a = _attestation(p, 500);
        dm.fundDeal(p, a, _sign(a, UW_PK));

        assertEq(vault.totalAssets(), usdt.balanceOf(address(vault)) + vault.deployedAssets(), "invariant");
        assertLe(registry.getUnderwriter(underwriter).bondLocked, registry.getUnderwriter(underwriter).bondTotal);

        vm.warp(block.timestamp + 38 days);
        dm.settle(p.dealId);

        assertEq(vault.deployedAssets(), 0, "deployed cleared");
        assertEq(vault.totalAssets(), usdt.balanceOf(address(vault)), "no phantom assets");
        assertLe(registry.getUnderwriter(underwriter).bondLocked, registry.getUnderwriter(underwriter).bondTotal);
    }

    /// Concurrent deals from one underwriter with an interleaved default: the bond must
    /// remain sufficient for every deal still outstanding.
    function test_ConcurrentDeals_BondRemainsSufficient() public {
        uint256 size = 100_000e6; // aval 15k each, bond 50k -> 3 deals fit
        DealManager.DealParams memory p1 = _params(keccak256("c1"), size);
        DealManager.DealParams memory p2 = _params(keccak256("c2"), size);
        DealManager.DealParams memory p3 = _params(keccak256("c3"), size);

        AvalAttestation.Attestation memory a1 = _attestation(p1, 500);
        AvalAttestation.Attestation memory a2 = _attestation(p2, 500);
        AvalAttestation.Attestation memory a3 = _attestation(p3, 500);

        dm.fundDeal(p1, a1, _sign(a1, UW_PK));
        dm.fundDeal(p2, a2, _sign(a2, UW_PK));
        dm.fundDeal(p3, a3, _sign(a3, UW_PK));

        UnderwriterRegistry.Underwriter memory u = registry.getUnderwriter(underwriter);
        assertEq(u.bondLocked, 45_000e6);
        assertLe(u.bondLocked, u.bondTotal);

        // First deal defaults and is slashed while the other two are still live.
        vm.warp(block.timestamp + 38 days);
        dm.settle(p1.dealId);

        u = registry.getUnderwriter(underwriter);
        assertLe(u.bondLocked, u.bondTotal, "remaining deals still fully bonded");
        assertEq(u.bondLocked, 30_000e6, "two deals still locked");

        dm.settle(p2.dealId);
        dm.settle(p3.dealId);

        u = registry.getUnderwriter(underwriter);
        assertEq(u.bondLocked, 0);
        assertLe(u.bondLocked, u.bondTotal);
    }

    // ------------------------------------------------------------------ bond

    function test_CannotWithdrawLockedBond() public {
        _fund(keccak256("w1"), 500);

        vm.prank(underwriter);
        vm.expectRevert(UnderwriterRegistry.InsufficientAvailableBond.selector);
        registry.requestWithdraw(BOND);
    }

    function test_WithdrawRespectsCooldown() public {
        vm.prank(underwriter);
        registry.requestWithdraw(10_000e6);

        vm.prank(underwriter);
        vm.expectRevert(UnderwriterRegistry.CooldownActive.selector);
        registry.executeWithdraw();

        vm.warp(block.timestamp + 7 days + 1);
        vm.prank(underwriter);
        registry.executeWithdraw();
        assertEq(registry.getUnderwriter(underwriter).bondTotal, BOND - 10_000e6);
    }

    function test_ModelUpdateIsVisibleAndVersioned() public {
        vm.prank(underwriter);
        registry.updateModel(keccak256("v2"));

        UnderwriterRegistry.Underwriter memory u = registry.getUnderwriter(underwriter);
        assertEq(u.modelVersion, 2, "version bumped");
        assertEq(u.modelCommit, keccak256("v2"));

        // Attestations naming the old commit stop verifying.
        DealManager.DealParams memory p = _params(keccak256("m1"), PRINCIPAL);
        AvalAttestation.Attestation memory a = _attestation(p, 500);
        bytes memory sig = _sign(a, UW_PK);

        vm.expectRevert(DealManager.StaleModelCommit.selector);
        dm.fundDeal(p, a, sig);
    }

    // ----------------------------------------------------------- time bounds

    /// A maturity in the past makes a deal instantly settleable AND instantly defaulted:
    /// the bond is slashed and the borrower keeps the principal, in one transaction. The
    /// terms are signed, so this can only arrive via an underwriter-side bug - a
    /// seconds/milliseconds mix-up being the obvious one - which is exactly the case worth
    /// refusing outright rather than trusting the signer on.
    function test_RejectsMaturityInPast() public {
        DealManager.DealParams memory p = _params(keccak256("t1"), PRINCIPAL);
        p.maturity = uint64(block.timestamp - 1);
        AvalAttestation.Attestation memory a = _attestation(p, 500);
        bytes memory sig = _sign(a, UW_PK);

        vm.expectRevert(DealManager.MaturityInPast.selector);
        dm.fundDeal(p, a, sig);
    }

    /// Without a term ceiling, an underwriter posting only the minimum bond could strand a
    /// multiple of it in senior capital indefinitely - the bond is slashable, but the
    /// principal would never become recoverable.
    function test_RejectsExcessiveTerm() public {
        DealManager.DealParams memory p = _params(keccak256("t2"), PRINCIPAL);
        p.maturity = uint64(block.timestamp + 400 days);
        AvalAttestation.Attestation memory a = _attestation(p, 500);
        bytes memory sig = _sign(a, UW_PK);

        vm.expectRevert(DealManager.TermTooLong.selector);
        dm.fundDeal(p, a, sig);
    }

    function test_RejectsExcessiveGrace() public {
        DealManager.DealParams memory p = _params(keccak256("t3"), PRINCIPAL);
        p.gracePeriod = 200 days;
        AvalAttestation.Attestation memory a = _attestation(p, 500);
        bytes memory sig = _sign(a, UW_PK);

        vm.expectRevert(DealManager.GraceTooLong.selector);
        dm.fundDeal(p, a, sig);
    }

    function test_RejectsDustPrincipal() public {
        DealManager.DealParams memory p = _params(keccak256("t4"), 1);
        AvalAttestation.Attestation memory a = _attestation(p, 500);
        bytes memory sig = _sign(a, UW_PK);

        vm.expectRevert(DealManager.PrincipalTooSmall.selector);
        dm.fundDeal(p, a, sig);
    }

    /// Every funded deal must carry a non-zero first loss, however small. A deal whose bond
    /// rounds to zero would count as a bonded prediction while carrying no collateral.
    function testFuzz_EveryDealCarriesNonZeroBond(uint256 principal) public {
        principal = bound(principal, dm.minPrincipal(), 300_000e6);
        DealManager.DealParams memory p = _params(keccak256("t5"), principal);
        AvalAttestation.Attestation memory a = _attestation(p, 500);
        dm.fundDeal(p, a, _sign(a, UW_PK));
        assertGt(dm.getDeal(p.dealId).avalLocked, 0, "bond rounded to zero");
    }

    // ----------------------------------------------------------------- pause

    /// A pause must stop origination without ever trapping a bond or blocking a repayment.
    function test_Pause_StopsOriginationButNotSettlement() public {
        DealManager.DealParams memory live = _fund(keccak256("p1"), 500);

        vm.prank(owner);
        dm.pause();

        DealManager.DealParams memory blocked = _params(keccak256("p2"), PRINCIPAL);
        AvalAttestation.Attestation memory a = _attestation(blocked, 500);
        bytes memory sig = _sign(a, UW_PK);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        dm.fundDeal(blocked, a, sig);

        // The in-flight deal must still be repayable and settleable while paused.
        DealManager.Deal memory d = dm.getDeal(live.dealId);
        vm.startPrank(borrower);
        usdt.approve(address(dm), d.dueAmount);
        dm.repay(live.dealId, d.dueAmount);
        vm.stopPrank();

        dm.settle(live.dealId);
        assertEq(registry.getUnderwriter(underwriter).bondLocked, 0, "bond must never be trapped by a pause");

        vm.prank(owner);
        dm.unpause();
        dm.fundDeal(blocked, a, sig);
        assertEq(dm.getDeal(blocked.dealId).principal, PRINCIPAL, "origination resumes");
    }

    function test_Pause_VaultBlocksDepositsNotWithdrawals() public {
        vm.prank(owner);
        vault.pause();

        usdt.mint(lp, 1_000e6);
        vm.startPrank(lp);
        usdt.approve(address(vault), 1_000e6);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        vault.deposit(1_000e6, lp);

        // Exits must remain open. A vault that can trap capital is not depositable.
        uint256 shares = vault.balanceOf(lp) / 10;
        vault.redeem(shares, lp, lp);
        vm.stopPrank();
        assertGt(usdt.balanceOf(lp), 1_000e6, "LP could still exit");
    }

    function test_Pause_OnlyOwner() public {
        vm.expectRevert();
        dm.pause();
        vm.expectRevert();
        vault.pause();
    }

    // ------------------------------------------------------------ reputation

    function test_BrierScoreReflectsCalibration() public {
        // A confident prediction that turns out wrong should score badly.
        DealManager.DealParams memory p = _fund(keccak256("b1"), 200);
        vm.warp(block.timestamp + 38 days);
        dm.settle(p.dealId);

        uint256 score = reputation.brierScore(underwriter);
        assertGt(score, 0.9e18, "confidently wrong scores near the maximum");
        assertEq(reputation.realisedDefaultRateBps(underwriter), 10_000);
    }

    function test_BrierScoreZeroWithNoHistory() public view {
        assertEq(reputation.brierScore(address(0xFEE)), 0);
        assertEq(reputation.getRecord(address(0xFEE)).predictions, 0);
    }
}
