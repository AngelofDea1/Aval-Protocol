// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface IReputation {
    struct Record {
        uint256 sumSquaredError; // accumulated (p - o)^2 in bps^2
        uint256 principalUnderwritten;
        uint256 totalSlashed;
        uint256 feesForfeited;
        uint64 predictions;
        uint64 defaults;
    }

    function record(
        address underwriter,
        uint16 pdBps,
        bool defaulted,
        uint256 principal,
        uint256 slashed,
        uint256 feeForfeited
    ) external;

    function getRecord(address underwriter) external view returns (Record memory);

    /// @notice Mean Brier score, scaled to 1e18 where 0 is perfect and 1e18 is worst possible.
    function brierScore(address underwriter) external view returns (uint256);

    /// @notice Realised default rate in bps.
    function realisedDefaultRateBps(address underwriter) external view returns (uint256);
}
