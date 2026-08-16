// Signed revenue attestations: how a business without public revenue borrows on Aval.
//
// A bakery's daily takings are as real as a protocol's fee stream, and the model handles them
// identically - both are a list of daily numbers. What the bakery cannot do is prove them.
// Point an agent at its dashboard and you get a screenshot, and a screenshot is a claim, not a
// proof; nothing stops a borrower showing a doctored one.
//
// So this source does not pretend to remove trust. It moves it somewhere accountable.
//
// A named attestor - a payment processor, an accounting platform, a bookkeeper - signs the
// revenue series with a key the pool has registered. The signature covers a hash of the
// numbers, so altering a single day invalidates it. If the figures were false, there is a
// specific party whose key signed them, recorded alongside the deal.
//
// That is exactly how trade finance already works, and it is the shape zkTLS and signed API
// feeds slot into later without changing anything downstream: same interface, stronger proof.
//
// WHAT THIS DELIBERATELY DOES NOT DO
//
// It does not make the attestor liable onchain. An attestor who signs fiction costs the
// underwriter its bond, and today the only consequence is that the underwriter stops
// accepting that key. Bonding attestors is the obvious next mechanism and it is NOT built.
// See SECURITY.md before treating an attested deal as equivalent to a public one.

import { ethers } from "ethers";
import { IngestError } from "./defillama.mjs";

export const ATTESTED_TRUST =
  "The named attestor who signed the figures. Their signature covers a hash of every daily " +
  "value, so the numbers cannot be edited after signing, but nothing here proves the attestor " +
  "was honest - only that they are identifiable and committed to what they said.";

export const EIP712_DOMAIN_NAME = "AvalRevenueAttestation";
export const EIP712_DOMAIN_VERSION = "1";

/**
 * Field order is consensus-critical in the same way the deal attestation's is: signer and
 * verifier must encode identically or every signature fails to recover.
 */
export const REVENUE_ATTESTATION_TYPES = {
  RevenueAttestation: [
    { name: "business", type: "string" },
    { name: "currency", type: "string" },
    { name: "startDate", type: "uint64" },
    { name: "days", type: "uint32" },
    { name: "seriesHash", type: "bytes32" },
    { name: "issuedAt", type: "uint64" },
  ],
};

/** An attestation older than this is refused: revenue data goes stale, and a signature does not. */
export const MAX_ATTESTATION_AGE_SECONDS = 7 * 86400;

/** Guards against a signer whose clock is wrong, or an attestation minted for the future. */
export const MAX_CLOCK_SKEW_SECONDS = 300;

const SECONDS_PER_DAY = 86400;

/**
 * Hash the revenue series.
 *
 * Values are MINOR UNITS AS INTEGERS - cents, not dollars. This is not fussiness. Hashing
 * floating point is a correctness bug waiting to happen: 0.1 + 0.2 does not serialise the way
 * anyone expects, two systems can disagree on the decimal representation of the same double,
 * and the resulting signature mismatch is invisible and maddening. Integers hash identically
 * everywhere.
 */
export function hashRevenueSeries(minorUnits) {
  if (!Array.isArray(minorUnits) || minorUnits.length === 0) {
    throw new IngestError("revenue series must be a non-empty array");
  }
  for (const v of minorUnits) {
    if (!Number.isInteger(v) || v < 0) {
      throw new IngestError("revenue values must be non-negative integers in minor units", { got: v });
    }
  }
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(["uint256[]"], [minorUnits.map((v) => BigInt(v))])
  );
}

/** The EIP-712 domain. Chain-bound, so an attestation for one deployment is invalid on another. */
export function revenueDomain(chainId) {
  return { name: EIP712_DOMAIN_NAME, version: EIP712_DOMAIN_VERSION, chainId: Number(chainId) };
}

/**
 * Sign a revenue attestation. Reference implementation for whoever operates the attestor key.
 *
 * Nothing in Aval calls this: it exists so an integrator has an exact, executable
 * specification rather than a paragraph of prose to reimplement from.
 */
export async function signRevenueAttestation(signer, attestation, chainId) {
  const message = {
    business: attestation.business,
    currency: attestation.currency,
    startDate: BigInt(attestation.startDate),
    days: attestation.minorUnits.length,
    seriesHash: hashRevenueSeries(attestation.minorUnits),
    issuedAt: BigInt(attestation.issuedAt),
  };
  const signature = await signer.signTypedData(revenueDomain(chainId), REVENUE_ATTESTATION_TYPES, message);
  return { ...attestation, chainId: Number(chainId), signature };
}

/**
 * Verify an attestation and recover the attestor.
 *
 * Order matters. The series hash is recomputed from the values actually supplied BEFORE the
 * signature is checked, so a payload whose numbers were edited after signing fails on the
 * mismatch rather than on a confusing recovery to some unrelated address.
 */
export function verifyRevenueAttestation(payload, { chainId, now = Math.floor(Date.now() / 1000) } = {}) {
  const { business, currency, startDate, minorUnits, issuedAt, signature } = payload ?? {};

  if (typeof business !== "string" || business.trim() === "") {
    throw new IngestError("attestation is missing a business identifier");
  }
  if (typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency)) {
    throw new IngestError("currency must be a three-letter uppercase code", { currency });
  }
  if (!Number.isInteger(startDate) || startDate <= 0) {
    throw new IngestError("startDate must be a unix timestamp in seconds", { startDate });
  }
  if (!Number.isInteger(issuedAt) || issuedAt <= 0) {
    throw new IngestError("issuedAt must be a unix timestamp in seconds", { issuedAt });
  }
  if (typeof signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(signature)) {
    throw new IngestError("signature must be a 65-byte hex string");
  }

  if (issuedAt > now + MAX_CLOCK_SKEW_SECONDS) {
    throw new IngestError("attestation is dated in the future", { issuedAt, now });
  }
  const age = now - issuedAt;
  if (age > MAX_ATTESTATION_AGE_SECONDS) {
    throw new IngestError(
      `attestation is ${Math.floor(age / 86400)} days old; refusing anything older than ${MAX_ATTESTATION_AGE_SECONDS / 86400} days`,
      { issuedAt, now }
    );
  }

  // Recomputed, never taken from the payload. A supplied seriesHash would let a caller sign
  // one series and present another.
  const seriesHash = hashRevenueSeries(minorUnits);

  const message = {
    business,
    currency,
    startDate: BigInt(startDate),
    days: minorUnits.length,
    seriesHash,
    issuedAt: BigInt(issuedAt),
  };

  let attestor;
  try {
    attestor = ethers.verifyTypedData(revenueDomain(chainId), REVENUE_ATTESTATION_TYPES, message, signature);
  } catch (err) {
    throw new IngestError(`signature did not recover: ${err.shortMessage ?? err.message}`);
  }

  return { attestor, seriesHash, business, currency, startDate, issuedAt, days: minorUnits.length };
}

/**
 * Fetch a revenue series from a signed attestation.
 *
 * `ref` is the attestation object itself rather than a URL. Aval does not go and get this: the
 * borrower brings it, the same way an exporter brings a bill of lading. Nothing is fetched
 * over the network, so there is no endpoint to spoof and no availability to depend on.
 */
export async function fetchAttestedSeries(ref, { chainId, attestors, now } = {}) {
  if (chainId === undefined || chainId === null) {
    throw new IngestError("an attested series needs a chainId: attestations are bound to one deployment");
  }
  if (!(attestors instanceof Map) && !Array.isArray(attestors)) {
    throw new IngestError("an attested series needs the pool's registered attestors");
  }

  const registry =
    attestors instanceof Map
      ? new Map([...attestors].map(([a, n]) => [ethers.getAddress(a), n]))
      : new Map(attestors.map((a) => [ethers.getAddress(a), a]));

  if (registry.size === 0) {
    throw new IngestError("no attestors are registered, so no attestation can be accepted");
  }

  const v = verifyRevenueAttestation(ref, { chainId, now });

  if (!registry.has(v.attestor)) {
    throw new IngestError(
      "attestation is validly signed, but not by an attestor this pool has registered",
      { attestor: v.attestor, registered: [...registry.keys()] }
    );
  }

  // Dates are derived from startDate and the index, so the series is contiguous daily by
  // construction. There is no gap for a caller to hide a missing week in.
  const points = ref.minorUnits.map((minor, i) => ({
    timestamp: v.startDate + i * SECONDS_PER_DAY,
    value: minor / 100,
  }));

  const last = points.at(-1).timestamp;
  const nowSec = now ?? Math.floor(Date.now() / 1000);
  if (last > nowSec + MAX_CLOCK_SKEW_SECONDS) {
    throw new IngestError("the series runs into the future", { lastDay: last, now: nowSec });
  }

  return {
    slug: v.business,
    source: `signed by ${registry.get(v.attestor)} (${v.attestor})`,
    attestor: v.attestor,
    attestorName: registry.get(v.attestor),
    currency: v.currency,
    seriesHash: v.seriesHash,
    fetchedAt: nowSec,
    points,
    values: points.map((p) => p.value),
  };
}
