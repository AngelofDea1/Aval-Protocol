// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IReputation} from "./interfaces/IReputation.sol";
import {ScoringRule} from "./libraries/ScoringRule.sol";

/// @title Reputation
/// @notice Permissionless, onchain calibration record for AI underwriters.
///
/// This is the part of the protocol that does not exist anywhere else. Every prediction an
/// underwriter makes and every realised outcome is recorded, and the contract maintains a
/// running Brier score - the mean squared error of its probability estimates.
///
/// The result is a public, comparable, unfalsifiable track record of model quality. Capital
/// can route to whichever model demonstrates the best realised calibration instead of the
/// best marketing. A low Brier score is expensive to fake: it can only be earned by making
/// bonded predictions that turned out to be right.
contract Reputation is IReputation, Ownable {
    /// @dev 1e18-scaled worst possible mean score corresponds to ScoringRule.MAX_SQ_ERROR.
    uint256 private constant WAD = 1e18;

    mapping(address => bool) public consumers;
    mapping(address => Record) private _records;

    event PredictionRecorded(
        address indexed underwriter,
        uint16 pdBps,
        bool defaulted,
        uint256 squaredError,
        uint256 principal,
        uint256 slashed,
        uint256 feeForfeited
    );
    event ConsumerSet(address indexed consumer, bool allowed);

    error NotConsumer();

    modifier onlyConsumer() {
        if (!consumers[msg.sender]) revert NotConsumer();
        _;
    }

    constructor(address owner_) Ownable(owner_) {}

    function setConsumer(address consumer, bool allowed) external onlyOwner {
        consumers[consumer] = allowed;
        emit ConsumerSet(consumer, allowed);
    }

    function record(
        address underwriter,
        uint16 pdBps,
        bool defaulted,
        uint256 principal,
        uint256 slashed,
        uint256 feeForfeited
    ) external override onlyConsumer {
        uint256 sqError = ScoringRule.squaredError(pdBps, defaulted);

        Record storage r = _records[underwriter];
        r.sumSquaredError += sqError;
        r.principalUnderwritten += principal;
        r.totalSlashed += slashed;
        r.feesForfeited += feeForfeited;
        r.predictions += 1;
        if (defaulted) r.defaults += 1;

        emit PredictionRecorded(underwriter, pdBps, defaulted, sqError, principal, slashed, feeForfeited);
    }

    function getRecord(address underwriter) external view override returns (Record memory) {
        return _records[underwriter];
    }

    /// @notice Mean Brier score scaled to 1e18. 0 == perfectly calibrated, 1e18 == maximally wrong.
    /// @dev Returns 0 for underwriters with no settled predictions; always check `predictions`
    ///      alongside this value, since a single lucky call is not a track record.
    function brierScore(address underwriter) external view override returns (uint256) {
        Record storage r = _records[underwriter];
        if (r.predictions == 0) return 0;
        return (r.sumSquaredError * WAD) / (uint256(r.predictions) * ScoringRule.MAX_SQ_ERROR);
    }

    function realisedDefaultRateBps(address underwriter) external view override returns (uint256) {
        Record storage r = _records[underwriter];
        if (r.predictions == 0) return 0;
        return (uint256(r.defaults) * 10_000) / uint256(r.predictions);
    }
}
