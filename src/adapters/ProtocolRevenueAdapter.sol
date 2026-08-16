// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ICashflowAdapter} from "../interfaces/ICashflowAdapter.sol";

/// @title ProtocolRevenueAdapter
/// @notice Advances against a protocol's forward fee revenue.
///
/// This is the demo asset because the underlying data (DefiLlama fee series) is free, live,
/// and independently verifiable by anyone reviewing a deal - a property worth more here than
/// a richer private feed would be.
///
/// TRUST ASSUMPTION, stated plainly: offchain revenue is not natively observable onchain, so
/// an authorised reporter posts observed inflow per deal. That reporter is trusted for
/// *reporting*, though not for underwriting - the bond, the scoring rule and the settlement
/// waterfall are all independent of it. Every report is evented, so misreporting is
/// detectable after the fact by comparing against the public source.
///
/// The honest path to removing this assumption is routing revenue through an onchain
/// collection address the adapter can read directly. Out of scope for v0; noted so nobody
/// mistakes the current design for trustless.
contract ProtocolRevenueAdapter is ICashflowAdapter, Ownable {
    struct Obligor {
        bool registered;
        uint64 registeredAt;
        bytes32 sourceRef; // hash of the canonical data source identifier (e.g. defillama slug)
        string label;
    }

    bytes32 private constant ADAPTER_ID = keccak256("protocol-revenue-v1");

    mapping(bytes32 => Obligor) public obligors;
    mapping(bytes32 => uint256) private _inflow;
    mapping(bytes32 => bytes32) public dealObligor;
    mapping(address => bool) public reporters;

    event ObligorRegistered(bytes32 indexed obligorId, bytes32 sourceRef, string label);
    event ObligorDeregistered(bytes32 indexed obligorId);
    event DealLinked(bytes32 indexed dealId, bytes32 indexed obligorId);
    event InflowReported(bytes32 indexed dealId, uint256 cumulativeInflow, address indexed reporter);
    event ReporterSet(address indexed reporter, bool allowed);

    error NotReporter();
    error UnknownObligor();
    error DealAlreadyLinked();
    error InflowMustNotDecrease();

    modifier onlyReporter() {
        if (!reporters[msg.sender]) revert NotReporter();
        _;
    }

    constructor(address owner_) Ownable(owner_) {}

    function adapterId() external pure override returns (bytes32) {
        return ADAPTER_ID;
    }

    // ---------------------------------------------------------------- admin

    function setReporter(address reporter, bool allowed) external onlyOwner {
        reporters[reporter] = allowed;
        emit ReporterSet(reporter, allowed);
    }

    function registerObligor(bytes32 obligorId, bytes32 sourceRef, string calldata label) external onlyOwner {
        obligors[obligorId] =
            Obligor({registered: true, registeredAt: uint64(block.timestamp), sourceRef: sourceRef, label: label});
        emit ObligorRegistered(obligorId, sourceRef, label);
    }

    function deregisterObligor(bytes32 obligorId) external onlyOwner {
        obligors[obligorId].registered = false;
        emit ObligorDeregistered(obligorId);
    }

    // ------------------------------------------------------------- reporting

    function linkDeal(bytes32 dealId, bytes32 obligorId) external onlyReporter {
        if (!obligors[obligorId].registered) revert UnknownObligor();
        if (dealObligor[dealId] != bytes32(0)) revert DealAlreadyLinked();
        dealObligor[dealId] = obligorId;
        emit DealLinked(dealId, obligorId);
    }

    /// @notice Report cumulative observed revenue for a deal.
    /// @dev Monotonic by construction: cumulative inflow can never decrease, so a bad report
    ///      cannot be quietly walked back - only corrected upward and visibly.
    function reportInflow(bytes32 dealId, uint256 cumulativeInflow) external onlyReporter {
        if (cumulativeInflow < _inflow[dealId]) revert InflowMustNotDecrease();
        _inflow[dealId] = cumulativeInflow;
        emit InflowReported(dealId, cumulativeInflow, msg.sender);
    }

    // ---------------------------------------------------------------- views

    function isEligible(bytes32 obligorId) external view override returns (bool) {
        return obligors[obligorId].registered;
    }

    function observedInflow(bytes32 dealId) external view override returns (uint256) {
        return _inflow[dealId];
    }

    /// @notice Canonical obligor id for a data-source slug, e.g. keccak256("uniswap").
    function obligorIdFor(string calldata slug) external pure returns (bytes32) {
        return keccak256(bytes(slug));
    }
}
