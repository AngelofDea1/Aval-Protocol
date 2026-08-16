// Reference implementation of the Aval attestation signer.
//
// This is the single highest-risk integration point in the system: if the offchain signer
// and the contract disagree by one field, one type, or one byte of encoding, every call to
// fundDeal reverts with BadSigner() or TermsMismatch() and the cause is invisible.
//
// The logic below is byte-identical to what the passing test suite exercises against the
// deployed bytecode (test/js/aval.test.mjs). Do not "clean it up" - field order in
// ATTESTATION_TYPES is consensus-critical and must match the struct in
// src/libraries/AvalAttestation.sol exactly.

import { ethers } from "ethers";

export const EIP712_DOMAIN_NAME = "AvalProtocol";
export const EIP712_DOMAIN_VERSION = "1";

/// Field order MUST match AvalAttestation.Attestation and ATTESTATION_TYPEHASH.
export const ATTESTATION_TYPES = {
  Attestation: [
    { name: "dealId", type: "bytes32" },
    { name: "termsHash", type: "bytes32" },
    { name: "underwriter", type: "address" },
    { name: "pdBps", type: "uint16" },
    { name: "pdUpperBps", type: "uint16" },
    { name: "advanceRateBps", type: "uint16" },
    { name: "modelCommit", type: "bytes32" },
    { name: "featureHash", type: "bytes32" },
    { name: "rationaleCID", type: "bytes32" },
    { name: "issuedAt", type: "uint64" },
    { name: "expiresAt", type: "uint64" },
  ],
};

/// Mirror of DealManager.hashTerms(DealParams).
/// Any change to the DealParams struct is a breaking change here.
export function hashTerms(p) {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["bytes32", "address", "address", "uint256", "uint16", "uint64", "uint64"],
      [p.dealId, p.borrower, p.adapter, p.principal, p.discountBps, p.maturity, p.gracePeriod]
    )
  );
}

export function domain(chainId, dealManagerAddress) {
  return {
    name: EIP712_DOMAIN_NAME,
    version: EIP712_DOMAIN_VERSION,
    chainId,
    verifyingContract: dealManagerAddress,
  };
}

/**
 * Build an attestation for a set of deal terms.
 *
 * @param {object} p          DealParams (dealId, borrower, adapter, principal, discountBps,
 *                            maturity, gracePeriod)
 * @param {object} opinion    { pdBps, pdUpperBps, advanceRateBps, modelCommit, featureHash,
 *                              rationaleCID }
 * @param {number} ttlSeconds How long the opinion stays fundable. Keep this short - a stale
 *                            credit opinion is a liability, and the bond is the signer's.
 */
export function buildAttestation(p, opinion, underwriterAddress, ttlSeconds = 3600) {
  const now = Math.floor(Date.now() / 1000);
  return {
    dealId: p.dealId,
    termsHash: hashTerms(p),
    underwriter: underwriterAddress,
    pdBps: opinion.pdBps,
    pdUpperBps: opinion.pdUpperBps,
    advanceRateBps: opinion.advanceRateBps,
    modelCommit: opinion.modelCommit,
    featureHash: opinion.featureHash,
    rationaleCID: opinion.rationaleCID,
    issuedAt: now,
    expiresAt: now + ttlSeconds,
  };
}

export async function signAttestation(signer, chainId, dealManagerAddress, attestation) {
  return signer.signTypedData(domain(chainId, dealManagerAddress), ATTESTATION_TYPES, attestation);
}

/**
 * Verify locally before broadcasting. Cheap, and turns an opaque onchain revert into a
 * clear local failure.
 */
export function recoverSigner(chainId, dealManagerAddress, attestation, signature) {
  return ethers.verifyTypedData(domain(chainId, dealManagerAddress), ATTESTATION_TYPES, attestation, signature);
}

/**
 * Pre-flight every constraint fundDeal enforces, so failures surface here with a reason
 * instead of as a bare revert.
 */
export function preflight(p, attestation, signature, chainId, dealManagerAddress, registryView, policy) {
  const problems = [];

  if (attestation.dealId !== p.dealId) problems.push("dealId mismatch");
  if (attestation.termsHash !== hashTerms(p)) problems.push("termsHash does not commit to these DealParams");
  if (attestation.expiresAt <= Math.floor(Date.now() / 1000)) problems.push("attestation already expired");
  if (attestation.pdUpperBps > policy.maxPdUpperBps) {
    problems.push(`pdUpperBps ${attestation.pdUpperBps} exceeds policy ${policy.maxPdUpperBps}`);
  }
  if (attestation.pdBps > 10_000 || attestation.pdUpperBps > 10_000) problems.push("probability above 100%");
  if (attestation.pdBps > attestation.pdUpperBps) problems.push("point estimate above its own upper bound");

  const recovered = recoverSigner(chainId, dealManagerAddress, attestation, signature);
  if (recovered.toLowerCase() !== attestation.underwriter.toLowerCase()) problems.push("signature does not recover to underwriter");

  if (registryView) {
    if (!registryView.active) problems.push("underwriter not active in registry");
    if (registryView.modelCommit !== attestation.modelCommit) problems.push("modelCommit is stale vs registry");
    const required = (BigInt(p.principal) * BigInt(policy.firstLossBps)) / 10_000n;
    const available = BigInt(registryView.bondTotal) - BigInt(registryView.bondLocked);
    if (available < required) problems.push(`insufficient free bond: need ${required}, have ${available}`);
  }

  return problems;
}
