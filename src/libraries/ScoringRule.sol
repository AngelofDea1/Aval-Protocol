// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title ScoringRule
/// @notice Strictly proper scoring rule used to compensate AI underwriters.
///
/// The underwriter reports a probability of default `p` (in basis points) before a deal
/// is funded. After settlement the realised outcome `o` is known (1 = default, 0 = repaid).
///
/// Its fee is paid according to the Brier (quadratic) scoring rule:
///
///     S(p, o) = 1 - (p - o)^2
///
/// This rule is *strictly proper*: the underwriter's expected fee is uniquely maximised
/// by reporting its true subjective probability. Shading the number in either direction
/// is strictly loss-making in expectation, so honest calibration is a dominant strategy
/// rather than something the protocol has to trust or police.
///
/// Solvency is handled separately by a fixed first-loss bond (see UnderwriterRegistry).
/// Deliberately NOT scaling the bond with `p`, which would pay the underwriter to
/// under-report risk in order to post less collateral.
library ScoringRule {
    /// @dev Probabilities are expressed in basis points: 10_000 bps == 1.0
    uint256 internal constant ONE_BPS = 10_000;

    /// @dev Maximum value of (p - o)^2 in bps^2, i.e. ONE_BPS^2
    uint256 internal constant MAX_SQ_ERROR = ONE_BPS * ONE_BPS; // 1e8

    /// @notice Squared error of a prediction against a realised binary outcome.
    /// @param pdBps Predicted probability of default, in bps (0..10_000)
    /// @param defaulted Realised outcome
    /// @return sqError (p - o)^2 expressed in bps^2, range 0..1e8
    function squaredError(uint16 pdBps, bool defaulted) internal pure returns (uint256 sqError) {
        require(pdBps <= ONE_BPS, "ScoringRule: pd out of range");
        uint256 p = uint256(pdBps);
        uint256 o = defaulted ? ONE_BPS : 0;
        uint256 diff = p > o ? p - o : o - p;
        sqError = diff * diff;
    }

    /// @notice Fee earned under the Brier scoring rule.
    /// @param feeBase The maximum fee, earned only by a perfectly accurate prediction
    /// @param pdBps Predicted probability of default, in bps
    /// @param defaulted Realised outcome
    /// @return fee feeBase * (1 - (p - o)^2)
    /// @dev Any shortfall between `fee` and `feeBase` is forfeited by the underwriter and
    ///      accrues to senior lenders, so poor calibration directly subsidises LPs.
    function brierFee(uint256 feeBase, uint16 pdBps, bool defaulted) internal pure returns (uint256 fee) {
        uint256 sqError = squaredError(pdBps, defaulted);
        fee = (feeBase * (MAX_SQ_ERROR - sqError)) / MAX_SQ_ERROR;
    }
}
