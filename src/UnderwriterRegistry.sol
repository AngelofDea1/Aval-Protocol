// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IUnderwriterRegistry} from "./interfaces/IUnderwriterRegistry.sol";

/// @title UnderwriterRegistry
/// @notice Identity and first-loss bond for AI underwriters.
///
/// An underwriter is an offchain model operator. To underwrite, it must post a bond that
/// is locked per-deal and slashed on default. This is the solvency leg of the mechanism:
/// it makes an AI opinion cost real money when it is wrong.
///
/// `modelCommit` pins the exact model version an underwriter is claiming to run. Changing
/// it is permitted but always emits an event and bumps a version counter, so a model
/// cannot be silently swapped underneath an accumulated reputation.
contract UnderwriterRegistry is IUnderwriterRegistry, Ownable {
    using SafeERC20 for IERC20;

    /// @notice Cooldown between requesting and executing a bond withdrawal.
    uint64 public constant WITHDRAW_COOLDOWN = 7 days;

    address public immutable override bondToken;

    /// @notice Contracts permitted to lock, release and slash bonds (i.e. DealManager).
    mapping(address => bool) public consumers;

    mapping(address => Underwriter) private _underwriters;

    uint256 public minBond;

    event UnderwriterRegistered(address indexed underwriter, bytes32 modelCommit, uint256 bond);
    event BondToppedUp(address indexed underwriter, uint256 amount, uint256 newTotal);
    event ModelUpdated(address indexed underwriter, bytes32 oldCommit, bytes32 newCommit, uint32 version);
    event WithdrawRequested(address indexed underwriter, uint256 amount, uint64 unlockAt);
    event WithdrawExecuted(address indexed underwriter, uint256 amount);
    event BondLocked(address indexed underwriter, uint256 amount, uint256 totalLocked);
    event BondReleased(address indexed underwriter, uint256 amount, uint256 totalLocked);
    event BondSlashed(address indexed underwriter, uint256 amount, address indexed recipient);
    event ConsumerSet(address indexed consumer, bool allowed);
    event MinBondSet(uint256 minBond);

    error NotConsumer();
    error NotRegistered();
    error AlreadyRegistered();
    error BondTooSmall();
    error InsufficientAvailableBond();
    error NothingRequested();
    error CooldownActive();

    modifier onlyConsumer() {
        if (!consumers[msg.sender]) revert NotConsumer();
        _;
    }

    constructor(address bondToken_, uint256 minBond_, address owner_) Ownable(owner_) {
        bondToken = bondToken_;
        minBond = minBond_;
    }

    // ---------------------------------------------------------------- admin

    function setConsumer(address consumer, bool allowed) external onlyOwner {
        consumers[consumer] = allowed;
        emit ConsumerSet(consumer, allowed);
    }

    function setMinBond(uint256 minBond_) external onlyOwner {
        minBond = minBond_;
        emit MinBondSet(minBond_);
    }

    // ------------------------------------------------------- underwriter ops

    function register(bytes32 modelCommit, uint256 amount) external {
        Underwriter storage u = _underwriters[msg.sender];
        if (u.registeredAt != 0) revert AlreadyRegistered();
        if (amount < minBond) revert BondTooSmall();

        IERC20(bondToken).safeTransferFrom(msg.sender, address(this), amount);

        u.active = true;
        u.modelVersion = 1;
        u.registeredAt = uint64(block.timestamp);
        u.modelCommit = modelCommit;
        u.bondTotal = amount;

        emit UnderwriterRegistered(msg.sender, modelCommit, amount);
    }

    function topUp(uint256 amount) external {
        Underwriter storage u = _underwriters[msg.sender];
        if (u.registeredAt == 0) revert NotRegistered();

        IERC20(bondToken).safeTransferFrom(msg.sender, address(this), amount);
        u.bondTotal += amount;

        emit BondToppedUp(msg.sender, amount, u.bondTotal);
    }

    /// @notice Rotate to a new model version. Always visible onchain.
    function updateModel(bytes32 newCommit) external {
        Underwriter storage u = _underwriters[msg.sender];
        if (u.registeredAt == 0) revert NotRegistered();

        bytes32 old = u.modelCommit;
        u.modelCommit = newCommit;
        u.modelVersion += 1;

        emit ModelUpdated(msg.sender, old, newCommit, u.modelVersion);
    }

    function requestWithdraw(uint256 amount) external {
        Underwriter storage u = _underwriters[msg.sender];
        if (u.registeredAt == 0) revert NotRegistered();
        if (amount > _available(u)) revert InsufficientAvailableBond();

        u.withdrawRequested = amount;
        u.withdrawUnlockAt = uint64(block.timestamp) + WITHDRAW_COOLDOWN;

        emit WithdrawRequested(msg.sender, amount, u.withdrawUnlockAt);
    }

    function executeWithdraw() external {
        Underwriter storage u = _underwriters[msg.sender];
        uint256 amount = u.withdrawRequested;
        if (amount == 0) revert NothingRequested();
        if (block.timestamp < u.withdrawUnlockAt) revert CooldownActive();
        // Re-check: bond may have been locked or slashed during the cooldown.
        if (amount > _available(u)) revert InsufficientAvailableBond();

        u.withdrawRequested = 0;
        u.withdrawUnlockAt = 0;
        u.bondTotal -= amount;
        if (u.bondTotal < minBond) u.active = false;

        IERC20(bondToken).safeTransfer(msg.sender, amount);
        emit WithdrawExecuted(msg.sender, amount);
    }

    // ---------------------------------------------------------- consumer ops

    function lock(address underwriter, uint256 amount) external override onlyConsumer {
        Underwriter storage u = _underwriters[underwriter];
        if (!u.active) revert NotRegistered();
        if (amount > _available(u)) revert InsufficientAvailableBond();

        u.bondLocked += amount;
        emit BondLocked(underwriter, amount, u.bondLocked);
    }

    function release(address underwriter, uint256 amount) external override onlyConsumer {
        Underwriter storage u = _underwriters[underwriter];
        u.bondLocked -= amount;
        emit BondReleased(underwriter, amount, u.bondLocked);
    }

    function slash(address underwriter, uint256 amount, address recipient) external override onlyConsumer {
        Underwriter storage u = _underwriters[underwriter];
        // Caller is responsible for releasing the corresponding lock.
        u.bondTotal -= amount;
        if (u.bondTotal < minBond) u.active = false;

        IERC20(bondToken).safeTransfer(recipient, amount);
        emit BondSlashed(underwriter, amount, recipient);
    }

    // ---------------------------------------------------------------- views

    function getUnderwriter(address underwriter) external view override returns (Underwriter memory) {
        return _underwriters[underwriter];
    }

    function availableBond(address underwriter) external view override returns (uint256) {
        return _available(_underwriters[underwriter]);
    }

    function _available(Underwriter storage u) private view returns (uint256) {
        return u.bondTotal > u.bondLocked ? u.bondTotal - u.bondLocked : 0;
    }
}
