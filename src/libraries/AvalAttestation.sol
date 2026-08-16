// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title AvalAttestation
/// @notice EIP-712 typed data for a signed underwriting opinion.
///
/// The offchain agent produces this payload, signs it with the underwriter key, and it is
/// verified onchain at funding time. `modelCommit` binds the opinion to a specific model
/// version and `featureHash` binds it to the exact inputs, so a settled deal is a
/// permanent, attributable record of what the model saw and what it claimed.
library AvalAttestation {
    struct Attestation {
        bytes32 dealId;
        /// @dev Commitment to the exact economic terms being underwritten. Without this the
        ///      signature only binds the deal id, and anyone observing a valid attestation
        ///      could fund it with substituted params - their own borrower address and a
        ///      principal up to the vault's entire idle balance.
        bytes32 termsHash;
        address underwriter;
        uint16 pdBps; // point estimate, probability of default
        uint16 pdUpperBps; // conformal upper bound on PD
        uint16 advanceRateBps; // recommended advance against face value
        bytes32 modelCommit; // hash of model weights + inference code
        bytes32 featureHash; // hash of the feature snapshot fed to the model
        bytes32 rationaleCID; // IPFS CID of the human-readable rationale
        uint64 issuedAt;
        uint64 expiresAt;
    }

    bytes32 internal constant ATTESTATION_TYPEHASH = keccak256(
        "Attestation(bytes32 dealId,bytes32 termsHash,address underwriter,uint16 pdBps,uint16 pdUpperBps,uint16 advanceRateBps,bytes32 modelCommit,bytes32 featureHash,bytes32 rationaleCID,uint64 issuedAt,uint64 expiresAt)"
    );

    function hash(Attestation memory a) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                ATTESTATION_TYPEHASH,
                a.dealId,
                a.termsHash,
                a.underwriter,
                a.pdBps,
                a.pdUpperBps,
                a.advanceRateBps,
                a.modelCommit,
                a.featureHash,
                a.rationaleCID,
                a.issuedAt,
                a.expiresAt
            )
        );
    }
}
