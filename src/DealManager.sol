// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

import {IUnderwriterRegistry} from "./interfaces/IUnderwriterRegistry.sol";
import {IReputation} from "./interfaces/IReputation.sol";
import {AvalAttestation} from "./libraries/AvalAttestation.sol";
import {ScoringRule} from "./libraries/ScoringRule.sol";
import {SeniorVault} from "./SeniorVault.sol";

/// @title DealManager
/// @notice Lifecycle of a bonded advance against a real-world cashflow.
///
/// Funding requires a signed underwriting attestation from a registered underwriter whose
/// declared model version matches the registry. At funding, a fixed first-loss bond is
/// locked. At settlement:
///
///   - the bond absorbs loss up to its size, paid into the senior vault
///   - the underwriter is paid a Brier-scored fee, so honest probability reporting is its
///     dominant strategy and miscalibration forfeits fees to LPs
///   - the prediction and its realised outcome are written to the permanent onchain record
/// Pause semantics, deliberately asymmetric: origination can be halted, but repayment and
/// settlement never can. A pause that could trap an underwriter's bond - or block a borrower
/// from repaying - would be a worse failure than whatever prompted the pause.
contract DealManager is EIP712, Ownable, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using AvalAttestation for AvalAttestation.Attestation;

    enum Status {
        None,
        Funded,
        Settled
    }

    struct Deal {
        address borrower;
        address adapter;
        address underwriter;
        uint256 principal;
        uint256 dueAmount;
        uint256 avalLocked;
        uint256 repaid;
        uint64 maturity;
        uint64 gracePeriod;
        uint16 pdBps;
        Status status;
        bool defaulted;
    }

    struct DealParams {
        bytes32 dealId;
        address borrower;
        address adapter;
        uint256 principal;
        uint16 discountBps; // interest charged to the borrower over the term
        uint64 maturity;
        uint64 gracePeriod;
    }

    IERC20 public immutable asset;
    IUnderwriterRegistry public immutable registry;
    IReputation public immutable reputation;
    SeniorVault public immutable vault;

    /// @notice First-loss bond as a share of principal. Deliberately independent of the
    ///         underwriter's own PD estimate - see ScoringRule for why.
    uint16 public firstLossBps = 1_500;

    /// @notice Maximum underwriter fee as a share of principal, before Brier scoring.
    uint16 public underwriterFeeBps = 100;

    /// @notice Deals with a conformal upper PD above this are not fundable.
    uint16 public maxPdUpperBps = 3_000;

    /// @notice Longest term a deal may carry, measured from funding.
    /// @dev Bounds how long senior capital can be locked up. Without a ceiling, an
    ///      underwriter posting only the minimum bond could originate deals with an absurd
    ///      maturity and strand a multiple of that bond in LP capital indefinitely - the
    ///      bond is slashable, but the principal would never become recoverable.
    uint64 public maxTermSeconds = 365 days;

    /// @notice Longest grace period a deal may carry. Same lockup reasoning.
    uint64 public maxGraceSeconds = 90 days;

    /// @notice Smallest fundable advance.
    /// @dev Also enforced indirectly by requiring a non-zero bond: below
    ///      10_000 / firstLossBps base units the aval rounds to zero and the deal would
    ///      carry no first loss at all.
    uint256 public minPrincipal = 1e6;

    mapping(bytes32 => Deal) public deals;

    event DealFunded(
        bytes32 indexed dealId,
        address indexed borrower,
        address indexed underwriter,
        uint256 principal,
        uint256 dueAmount,
        uint256 avalLocked,
        uint16 pdBps
    );

    /// @notice Model provenance for a funded deal, emitted separately so indexers can
    ///         reconstruct exactly which model version saw which inputs and said what.
    event AttestationAnchored(
        bytes32 indexed dealId,
        address indexed underwriter,
        uint16 pdBps,
        uint16 pdUpperBps,
        uint16 advanceRateBps,
        bytes32 modelCommit,
        bytes32 featureHash,
        bytes32 rationaleCID
    );
    event Repaid(bytes32 indexed dealId, address indexed payer, uint256 amount, uint256 totalRepaid);
    event Settled(
        bytes32 indexed dealId,
        bool defaulted,
        uint256 repaid,
        uint256 slashed,
        uint256 feePaid,
        uint256 feeForfeited
    );
    event ParamsUpdated(uint16 firstLossBps, uint16 underwriterFeeBps, uint16 maxPdUpperBps);
    event TermLimitsUpdated(uint64 maxTermSeconds, uint64 maxGraceSeconds, uint256 minPrincipal);

    error DealExists();
    error TermsMismatch();
    error MaturityInPast();
    error TermTooLong();
    error GraceTooLong();
    error PrincipalTooSmall();
    error ZeroAval();
    error DealNotFound();
    error AlreadySettled();
    error AttestationExpired();
    error AttestationMismatch();
    error BadSigner();
    error StaleModelCommit();
    error PdAbovePolicy();
    error PdOutOfRange();
    error PdAboveOwnUpperBound();
    error DiscountTooHigh();
    error NotYetSettleable();
    error ZeroPrincipal();

    constructor(
        IERC20 asset_,
        IUnderwriterRegistry registry_,
        IReputation reputation_,
        SeniorVault vault_,
        address owner_
    ) EIP712("AvalProtocol", "1") Ownable(owner_) {
        asset = asset_;
        registry = registry_;
        reputation = reputation_;
        vault = vault_;
    }

    // ---------------------------------------------------------------- admin

    /// @notice Halt new originations. Repayment and settlement remain available.
    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    function setParams(uint16 firstLossBps_, uint16 underwriterFeeBps_, uint16 maxPdUpperBps_) external onlyOwner {
        require(firstLossBps_ <= 10_000 && underwriterFeeBps_ <= 10_000 && maxPdUpperBps_ <= 10_000, "bad bps");
        firstLossBps = firstLossBps_;
        underwriterFeeBps = underwriterFeeBps_;
        maxPdUpperBps = maxPdUpperBps_;
        emit ParamsUpdated(firstLossBps_, underwriterFeeBps_, maxPdUpperBps_);
    }

    function setTermLimits(uint64 maxTermSeconds_, uint64 maxGraceSeconds_, uint256 minPrincipal_)
        external
        onlyOwner
    {
        require(maxTermSeconds_ > 0 && minPrincipal_ > 0, "bad limits");
        maxTermSeconds = maxTermSeconds_;
        maxGraceSeconds = maxGraceSeconds_;
        minPrincipal = minPrincipal_;
        emit TermLimitsUpdated(maxTermSeconds_, maxGraceSeconds_, minPrincipal_);
    }

    // ----------------------------------------------------------------- core

    /// @notice Fund a deal against a signed underwriting attestation.
    function fundDeal(DealParams calldata p, AvalAttestation.Attestation calldata a, bytes calldata signature)
        external
        nonReentrant
        whenNotPaused
    {
        if (p.principal == 0) revert ZeroPrincipal();
        if (p.principal < minPrincipal) revert PrincipalTooSmall();

        // Time bounds. A maturity in the past would make the deal instantly settleable and
        // instantly defaulted - slashing the bond and gifting the borrower the principal in
        // a single transaction. The terms are signed, so this can only happen through an
        // underwriter-side bug (a seconds/milliseconds mix-up is the obvious one), which is
        // exactly the case worth refusing outright rather than trusting the signer.
        if (p.maturity <= block.timestamp) revert MaturityInPast();
        if (p.maturity - block.timestamp > maxTermSeconds) revert TermTooLong();
        if (p.gracePeriod > maxGraceSeconds) revert GraceTooLong();

        if (deals[p.dealId].status != Status.None) revert DealExists();
        if (a.dealId != p.dealId) revert AttestationMismatch();
        // The signature must bind the economic terms, not just the deal id, otherwise a
        // valid attestation could be replayed against substituted params.
        if (a.termsHash != hashTerms(p)) revert TermsMismatch();
        if (block.timestamp > a.expiresAt) revert AttestationExpired();
        if (a.pdUpperBps > maxPdUpperBps) revert PdAbovePolicy();

        /// CRITICAL. `pdBps` is stored and only used at settlement, where
        /// ScoringRule.squaredError requires it to be at most 10_000. Without this check a
        /// deal could be funded declaring, say, 20000 bps: valid for a uint16, past every
        /// guard above, and then `settle()` reverts for everyone forever. The principal is
        /// already with the borrower, the bond stays locked, `vault.deployedAssets` never
        /// falls, and the vault permanently counts unrecoverable capital as an asset. Any
        /// registered underwriter could strand lender funds at will.
        ///
        /// Validate where the value enters, not where it is consumed. See SECURITY.md #8.
        if (a.pdBps > 10_000) revert PdOutOfRange();

        /// A point estimate above its own upper bound is incoherent. Venn-Abers cannot
        /// produce it (Vovk's merged probability is p1/(1-p0+p1) with p0 <= p1, so the
        /// denominator is at least 1), so this only ever rejects a malformed attestation.
        if (a.pdBps > a.pdUpperBps) revert PdAboveOwnUpperBound();

        /// Bounds what a borrower can be made to owe. Not exploitable against a third party,
        /// since an underwriter writing an absurd discount only guarantees its own default
        /// and loses its own bond, but an unbounded uint16 here permits a due amount of 6.5x
        /// principal, which is not a number this protocol should be able to express. The
        /// agent's own ceiling is 4_000 bps.
        if (p.discountBps > 10_000) revert DiscountTooHigh();

        address signer = ECDSA.recover(_hashTypedDataV4(a.hash()), signature);
        if (signer != a.underwriter) revert BadSigner();

        // The attestation must name the model version the registry currently holds, so a
        // settled deal always maps to a specific, declared model.
        IUnderwriterRegistry.Underwriter memory u = registry.getUnderwriter(a.underwriter);
        if (u.modelCommit != a.modelCommit) revert StaleModelCommit();

        uint256 aval = (p.principal * firstLossBps) / 10_000;
        // A deal small enough that the bond rounds to zero would carry no first loss while
        // still counting as a bonded prediction.
        if (aval == 0) revert ZeroAval();
        uint256 due = p.principal + (p.principal * p.discountBps) / 10_000;
        registry.lock(a.underwriter, aval);

        deals[p.dealId] = Deal({
            borrower: p.borrower,
            adapter: p.adapter,
            underwriter: a.underwriter,
            principal: p.principal,
            dueAmount: due,
            avalLocked: aval,
            repaid: 0,
            maturity: p.maturity,
            gracePeriod: p.gracePeriod,
            pdBps: a.pdBps,
            status: Status.Funded,
            defaulted: false
        });

        vault.deployTo(p.borrower, p.principal);

        emit DealFunded(p.dealId, p.borrower, a.underwriter, p.principal, due, aval, a.pdBps);
        _anchorAttestation(a);
    }

    /// @dev Isolated to keep `fundDeal`'s stack within the legacy codegen limit.
    function _anchorAttestation(AvalAttestation.Attestation calldata a) private {
        emit AttestationAnchored(
            a.dealId,
            a.underwriter,
            a.pdBps,
            a.pdUpperBps,
            a.advanceRateBps,
            a.modelCommit,
            a.featureHash,
            a.rationaleCID
        );
    }

    /// @notice Repay a deal. Anyone may pay on the borrower's behalf.
    function repay(bytes32 dealId, uint256 amount) external nonReentrant {
        Deal storage d = deals[dealId];
        if (d.status == Status.None) revert DealNotFound();
        if (d.status == Status.Settled) revert AlreadySettled();

        asset.safeTransferFrom(msg.sender, address(vault), amount);
        d.repaid += amount;

        emit Repaid(dealId, msg.sender, amount, d.repaid);
    }

    /// @notice Settle a deal once repaid in full, or once maturity plus grace has elapsed.
    function settle(bytes32 dealId) external nonReentrant {
        Deal storage d = deals[dealId];
        if (d.status == Status.None) revert DealNotFound();
        if (d.status == Status.Settled) revert AlreadySettled();

        bool paidInFull = d.repaid >= d.dueAmount;
        bool pastGrace = block.timestamp > uint256(d.maturity) + uint256(d.gracePeriod);
        if (!paidInFull && !pastGrace) revert NotYetSettleable();

        bool defaulted = !paidInFull;
        uint256 slashed;

        if (defaulted) {
            uint256 loss = d.dueAmount - d.repaid;
            slashed = loss > d.avalLocked ? d.avalLocked : loss;
            // Slashed collateral is paid into the senior vault before its principal is retired,
            // so LPs only wear the shortfall beyond the bond.
            registry.slash(d.underwriter, slashed, address(vault));
        }

        registry.release(d.underwriter, d.avalLocked);

        // Brier-scored compensation: the underwriter keeps the portion of its fee justified
        // by the accuracy of its prediction and forfeits the rest to LPs.
        uint256 feeBase = (d.principal * underwriterFeeBps) / 10_000;
        uint256 fee = ScoringRule.brierFee(feeBase, d.pdBps, defaulted);
        uint256 feeForfeited = feeBase - fee;

        vault.closeDeal(d.principal);
        if (fee > 0 && vault.idleAssets() >= fee) {
            vault.payFee(d.underwriter, fee);
        } else {
            // Fee is skipped rather than reverting: settlement must never be blockable by
            // a temporarily illiquid vault.
            feeForfeited = feeBase;
            fee = 0;
        }

        d.status = Status.Settled;
        d.defaulted = defaulted;

        reputation.record(d.underwriter, d.pdBps, defaulted, d.principal, slashed, feeForfeited);

        emit Settled(dealId, defaulted, d.repaid, slashed, fee, feeForfeited);
    }

    // ---------------------------------------------------------------- views

    function getDeal(bytes32 dealId) external view returns (Deal memory) {
        return deals[dealId];
    }

    /// @notice Canonical commitment to a deal's economic terms, signed inside the attestation.
    /// @dev The offchain agent MUST compute this identically. Any change to DealParams or to
    ///      this encoding is a breaking change for the signer.
    function hashTerms(DealParams calldata p) public pure returns (bytes32) {
        return keccak256(
            abi.encode(p.dealId, p.borrower, p.adapter, p.principal, p.discountBps, p.maturity, p.gracePeriod)
        );
    }

    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    function hashAttestation(AvalAttestation.Attestation calldata a) external view returns (bytes32) {
        return _hashTypedDataV4(a.hash());
    }
}
