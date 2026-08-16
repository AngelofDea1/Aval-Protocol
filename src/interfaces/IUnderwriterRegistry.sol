// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface IUnderwriterRegistry {
    struct Underwriter {
        bool active;
        uint32 modelVersion;
        uint64 registeredAt;
        bytes32 modelCommit;
        uint256 bondTotal;
        uint256 bondLocked;
        uint256 withdrawRequested;
        uint64 withdrawUnlockAt;
    }

    function bondToken() external view returns (address);
    function getUnderwriter(address underwriter) external view returns (Underwriter memory);
    function availableBond(address underwriter) external view returns (uint256);

    function lock(address underwriter, uint256 amount) external;
    function release(address underwriter, uint256 amount) external;
    function slash(address underwriter, uint256 amount, address recipient) external;
}
