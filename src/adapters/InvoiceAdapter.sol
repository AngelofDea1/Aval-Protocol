// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ICashflowAdapter} from "../interfaces/ICashflowAdapter.sol";

/// @title InvoiceAdapter
/// @notice SME trade receivables - the institutional path.
///
/// Present to demonstrate the rails are asset-agnostic: the same bond, scoring rule and
/// settlement waterfall price an invoice exactly as they price protocol revenue, with only
/// the adapter and the feature pipeline differing.
///
/// SCOPE: v0 records invoice commitments and their settlement status. It does NOT verify
/// that an invoice exists, that the buyer acknowledged it, or that it has not been financed
/// elsewhere - double-financing being the classic fraud in receivables. Real deployment
/// needs buyer confirmation and a central registry check. Documented rather than glossed,
/// because an unverified invoice is exactly the risk this asset class is known for.
contract InvoiceAdapter is ICashflowAdapter, Ownable {
    struct Invoice {
        bool exists;
        bool settled;
        uint64 dueDate;
        uint256 faceAmount;
        uint256 collected;
        bytes32 obligorId; // the buyer, who ultimately pays
        bytes32 documentHash; // hash of the invoice document
    }

    bytes32 private constant ADAPTER_ID = keccak256("invoice-v1");

    mapping(bytes32 => Invoice) public invoices; // dealId => invoice
    mapping(bytes32 => bool) public approvedBuyers;
    mapping(address => bool) public reporters;

    event BuyerApproved(bytes32 indexed obligorId, bool approved);
    event InvoiceRecorded(
        bytes32 indexed dealId, bytes32 indexed obligorId, uint256 faceAmount, uint64 dueDate, bytes32 documentHash
    );
    event CollectionReported(bytes32 indexed dealId, uint256 collected, address indexed reporter);
    event ReporterSet(address indexed reporter, bool allowed);

    error NotReporter();
    error BuyerNotApproved();
    error InvoiceExists();
    error UnknownInvoice();
    error CollectionMustNotDecrease();

    modifier onlyReporter() {
        if (!reporters[msg.sender]) revert NotReporter();
        _;
    }

    constructor(address owner_) Ownable(owner_) {}

    function adapterId() external pure override returns (bytes32) {
        return ADAPTER_ID;
    }

    function setReporter(address reporter, bool allowed) external onlyOwner {
        reporters[reporter] = allowed;
        emit ReporterSet(reporter, allowed);
    }

    function setBuyerApproved(bytes32 obligorId, bool approved) external onlyOwner {
        approvedBuyers[obligorId] = approved;
        emit BuyerApproved(obligorId, approved);
    }

    function recordInvoice(
        bytes32 dealId,
        bytes32 obligorId,
        uint256 faceAmount,
        uint64 dueDate,
        bytes32 documentHash
    ) external onlyReporter {
        if (!approvedBuyers[obligorId]) revert BuyerNotApproved();
        if (invoices[dealId].exists) revert InvoiceExists();

        invoices[dealId] = Invoice({
            exists: true,
            settled: false,
            dueDate: dueDate,
            faceAmount: faceAmount,
            collected: 0,
            obligorId: obligorId,
            documentHash: documentHash
        });

        emit InvoiceRecorded(dealId, obligorId, faceAmount, dueDate, documentHash);
    }

    function reportCollection(bytes32 dealId, uint256 collected) external onlyReporter {
        Invoice storage inv = invoices[dealId];
        if (!inv.exists) revert UnknownInvoice();
        if (collected < inv.collected) revert CollectionMustNotDecrease();

        inv.collected = collected;
        if (collected >= inv.faceAmount) inv.settled = true;

        emit CollectionReported(dealId, collected, msg.sender);
    }

    function isEligible(bytes32 obligorId) external view override returns (bool) {
        return approvedBuyers[obligorId];
    }

    function observedInflow(bytes32 dealId) external view override returns (uint256) {
        return invoices[dealId].collected;
    }
}
