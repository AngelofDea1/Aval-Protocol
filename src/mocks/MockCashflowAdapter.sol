// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ICashflowAdapter} from "../interfaces/ICashflowAdapter.sol";

contract MockCashflowAdapter is ICashflowAdapter {
    bytes32 private immutable _adapterId;
    mapping(bytes32 => bool) public eligible;
    mapping(bytes32 => uint256) public inflow;

    constructor(bytes32 adapterId_) {
        _adapterId = adapterId_;
    }

    function adapterId() external view override returns (bytes32) {
        return _adapterId;
    }

    function isEligible(bytes32 obligorId) external view override returns (bool) {
        return eligible[obligorId];
    }

    function observedInflow(bytes32 dealId) external view override returns (uint256) {
        return inflow[dealId];
    }

    function setEligible(bytes32 obligorId, bool v) external {
        eligible[obligorId] = v;
    }

    function setInflow(bytes32 dealId, uint256 v) external {
        inflow[dealId] = v;
    }
}
