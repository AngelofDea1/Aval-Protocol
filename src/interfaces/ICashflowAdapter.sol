// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title ICashflowAdapter
/// @notice Describes a class of real-world cashflow that can be advanced against.
///
/// Adapters keep the protocol asset-agnostic. The demo ships two:
///   - ProtocolRevenueAdapter: advances against a protocol's forward fee revenue
///     (live, free, independently verifiable data)
///   - InvoiceAdapter: advances against SME trade receivables (institutional path)
interface ICashflowAdapter {
    /// @notice Short machine-readable label, e.g. "protocol-revenue-v1"
    function adapterId() external view returns (bytes32);

    /// @notice Whether this adapter will accept an advance for the given obligor.
    function isEligible(bytes32 obligorId) external view returns (bool);

    /// @notice Cumulative cash observed as received for a given deal, in asset decimals.
    /// @dev Used by the monitor agent and by settlement to determine realised repayment.
    ///      Adapters that cannot observe cash onchain should return 0 and rely on
    ///      explicit repay() calls instead.
    function observedInflow(bytes32 dealId) external view returns (uint256);
}
