// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

/// @title SeniorVault
/// @notice Pooled senior capital. ERC-4626 over the stablecoin used for advances.
///
/// Senior lenders sit behind the underwriter's first-loss bond: on default the bond is
/// slashed into this vault first, and only the shortfall beyond it touches LP principal.
///
/// The share token is a standard ERC-20, which makes it the tradeable representation of
/// the portfolio and the natural venue for secondary liquidity.
contract SeniorVault is ERC4626, Ownable, Pausable {
    using SafeERC20 for IERC20;

    /// @notice Assets currently advanced out to live deals.
    uint256 public deployedAssets;

    /// @notice Maximum share of total assets that may be deployed at once, in bps.
    uint16 public maxUtilizationBps = 8_000;

    address public dealManager;

    event DealManagerSet(address indexed dealManager);
    event MaxUtilizationSet(uint16 bps);
    event Deployed(address indexed to, uint256 amount, uint256 deployedTotal);
    event DealClosed(uint256 principal, uint256 deployedTotal);
    event LossAbsorbed(uint256 amount);
    event FeePaid(address indexed underwriter, uint256 amount);

    error NotDealManager();
    error UtilizationExceeded();
    error InsufficientIdle();

    modifier onlyDealManager() {
        if (msg.sender != dealManager) revert NotDealManager();
        _;
    }

    constructor(IERC20 asset_, string memory name_, string memory symbol_, address owner_)
        ERC20(name_, symbol_)
        ERC4626(asset_)
        Ownable(owner_)
    {}

    // ---------------------------------------------------------------- admin

    function setDealManager(address dealManager_) external onlyOwner {
        dealManager = dealManager_;
        emit DealManagerSet(dealManager_);
    }

    function setMaxUtilization(uint16 bps) external onlyOwner {
        require(bps <= 10_000, "SeniorVault: bad bps");
        maxUtilizationBps = bps;
        emit MaxUtilizationSet(bps);
    }

    /// @notice Halt new deposits. Withdrawals stay open by design - pausing an LP's exit
    ///         is a far worse failure mode than whatever prompted the pause, and a vault
    ///         that can trap capital is not one anyone should deposit into.
    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    /// @dev Gating `_deposit` covers both deposit() and mint(); `_withdraw` is untouched,
    ///      so withdraw() and redeem() remain live while paused.
    function _deposit(address caller, address receiver, uint256 assets, uint256 shares)
        internal
        override
        whenNotPaused
    {
        super._deposit(caller, receiver, assets, shares);
    }

    // ------------------------------------------------------------ accounting

    /// @dev Idle stablecoins plus principal currently out on loan.
    function totalAssets() public view override returns (uint256) {
        return IERC20(asset()).balanceOf(address(this)) + deployedAssets;
    }

    function idleAssets() public view returns (uint256) {
        return IERC20(asset()).balanceOf(address(this));
    }

    function utilizationBps() external view returns (uint256) {
        uint256 total = totalAssets();
        if (total == 0) return 0;
        return (deployedAssets * 10_000) / total;
    }

    // ------------------------------------------------------- deal manager ops

    /// @notice Advance principal to a borrower. Total assets are unchanged: idle falls,
    ///         deployed rises.
    function deployTo(address to, uint256 amount) external onlyDealManager {
        if (amount > idleAssets()) revert InsufficientIdle();
        uint256 total = totalAssets();
        // Defensive: unreachable while DealManager rejects zero principal, but a division by
        // zero here would be a confusing revert deep in the funding path.
        if (total == 0) revert InsufficientIdle();
        uint256 newDeployed = deployedAssets + amount;
        if ((newDeployed * 10_000) / total > maxUtilizationBps) revert UtilizationExceeded();

        deployedAssets = newDeployed;
        IERC20(asset()).safeTransfer(to, amount);
        emit Deployed(to, amount, newDeployed);
    }

    /// @notice Retire a deal's principal from the deployed balance at settlement.
    /// @dev Cash (repayments and any slashed bond) has already been transferred in by then,
    ///      so any shortfall shows up as a fall in totalAssets, i.e. a loss to LPs.
    function closeDeal(uint256 principal) external onlyDealManager {
        deployedAssets -= principal;
        emit DealClosed(principal, deployedAssets);
    }

    function payFee(address underwriter, uint256 amount) external onlyDealManager {
        if (amount > idleAssets()) revert InsufficientIdle();
        IERC20(asset()).safeTransfer(underwriter, amount);
        emit FeePaid(underwriter, amount);
    }
}
