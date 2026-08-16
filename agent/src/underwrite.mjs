// Orchestration: obligor + requested advance -> priced, signed, bonded underwriting decision.
//
// Pipeline:
//   ingest -> features -> structural model -> Venn-Abers interval
//          -> clamped LLM overlay -> pricing -> rationale -> EIP-712 attestation
//
// Every stage is recorded in the rationale document, whose hash is anchored onchain. A
// settled deal is therefore a permanent, attributable record of what the model saw, what it
// claimed, and why.

import { ethers } from "ethers";

import { buildFeatures, featureVectorString } from "./features.mjs";
import { applyAdjustment, getQualitativeAdjustment, MAX_ADJUSTMENT } from "./llm.mjs";
import { buildAttestation, hashTerms, preflight, signAttestation } from "./attestation.mjs";

export { DEFAULT_LGD, TARGET_SPREAD_BPS, LIMITS, priceDeal } from "./pricing.mjs";
import { priceDeal } from "./pricing.mjs";

export function makeDealId(obligor, nonce) {
  return ethers.keccak256(ethers.toUtf8Bytes(`aval:${obligor}:${nonce}`));
}

export function hashFeatures(feats) {
  return ethers.keccak256(ethers.toUtf8Bytes(featureVectorString(feats)));
}

/**
 * Produce a full underwriting decision.
 *
 * @param {object} input
 *   obligor          human-readable obligor id (e.g. defillama slug)
 *   series           historical periodic revenue, most recent last
 *   concentration    revenue concentration proxy in [0,1]
 *   obligorAgeDays   age of the obligor
 *   faceAmount       the cashflow being advanced against
 *   context          unstructured text for the LLM stage
 *
 * UNITS: `series` and `faceAmount` MUST be in the same units. If `faceAmount` is in USDT
 * base units (6dp), the revenue series must be too. A mismatch is silent and catastrophic:
 * coverage collapses by 10^6, the model reports near-certain default, and the output looks
 * entirely well-formed. `implausibleCoverage` below exists to catch exactly that.
 * @param {object} deps { model, publish }  `publish` uploads the rationale and returns a CID
 */
export async function underwrite(input, { model, publish, llmOptions = {} } = {}) {
  const { obligor, series, concentration, obligorAgeDays, faceAmount, context = "", horizonDays = 30 } = input;

  if (!model) throw new Error("underwrite() requires a model");
  if (!Number.isFinite(faceAmount) || faceAmount <= 0) throw new Error("faceAmount must be a positive number");
  if (!Array.isArray(series) || series.length === 0) throw new Error("series must be a non-empty array");

  // ---- stage 1: structural model -----------------------------------------
  // Priced against the face amount first; the advance is then sized off the result.
  const features = buildFeatures(series, {
    concentration,
    obligorAgeDays,
    dueAmount: faceAmount,
    horizonDays,
  });

  // A units mismatch between `series` and `faceAmount` shows up here and nowhere else.
  // Coverage outside this band is not a credit signal, it is almost always a bug.
  const implausibleCoverage = features.coverage < 0.01 || features.coverage > 100;
  if (implausibleCoverage) {
    console.warn(
      `[underwrite] implausible coverage ${features.coverage.toExponential(3)} for "${obligor}". ` +
        `Projected ${horizonDays}d revenue and faceAmount are probably in different units ` +
        `(faceAmount=${faceAmount}, recent daily revenue~${(series.slice(-30).reduce((s, v) => s + v, 0) / Math.min(30, series.length)).toExponential(3)}). ` +
        `Proceeding, but treat this PD as unreliable.`
    );
  }

  const structural = model.predict(features);
  const contributions = model.contributions(features);

  // ---- stage 2: clamped qualitative overlay -------------------------------
  const llm = await getQualitativeAdjustment({
    obligor,
    basePd: structural.pd,
    features,
    context,
    ...llmOptions,
  });
  const adjusted = applyAdjustment(structural.pd, llm.adjustment);

  // The interval is shifted by the same multiplier so the overlay cannot silently collapse
  // the model's own uncertainty.
  const pd = adjusted.adjustedPd;
  const pdUpper = Math.max(
    pd,
    Math.min(0.9999, structural.pdUpper * (1 + adjusted.effectiveMultiplier))
  );

  // ---- stage 3: pricing ---------------------------------------------------
  const pricing = priceDeal({ pd, pdUpper });
  const principal = Math.floor((faceAmount * pricing.advanceRateBps) / 10_000);

  const rationale = {
    schema: "aval.rationale.v1",
    obligor,
    generatedAt: new Date().toISOString(),
    model: { version: model.version, kind: model.artifact.kind },
    dataProvenance: {
      observations: series.length,
      horizonDays,
      note: "Feature inputs are hashed into the onchain attestation as featureHash.",
    },
    structural: {
      pd: structural.pd,
      pdUpper: structural.pdUpper,
      interval: [structural.p0, structural.p1],
      intervalWidth: structural.intervalWidth,
      uncalibratedPd: structural.pRaw,
      method: "logistic regression, Venn-Abers calibrated (distribution-free interval)",
    },
    qualitative: {
      applied: llm.ok,
      reason: llm.ok ? undefined : llm.reason,
      rawAdjustment: llm.adjustment,
      maxAdjustment: MAX_ADJUSTMENT,
      effectiveMultiplier: adjusted.effectiveMultiplier,
      hitClamp: adjusted.hitClamp,
      confidence: llm.confidence,
      rationale: llm.rationale,
      riskFactors: llm.riskFactors,
      mitigants: llm.mitigants,
    },
    final: { pd, pdUpper },
    warnings: implausibleCoverage
      ? [`Coverage ${features.coverage.toExponential(3)} is outside the plausible band; check that the revenue series and faceAmount share units.`]
      : [],
    pricing: { ...pricing, faceAmount, principal },
    topContributions: contributions.slice(0, 5),
    features,
    caveats: [
      "Model is v0, trained on a synthetic bootstrap dataset. Reported accuracy does not " +
        "reflect performance on real defaults.",
      "The qualitative overlay is bounded to +/-30% of the base probability and cannot " +
        "originate a deal the structural model would refuse.",
      "Concentration is a temporal proxy, not counterparty concentration.",
    ],
  };

  return {
    features, structural, llm, adjusted, pd, pdUpper, pricing, principal, rationale, contributions,
    implausibleCoverage,
  };
}

/**
 * Turn a decision into a signed, pre-flighted attestation ready for fundDeal.
 *
 * @param {object} decision  output of underwrite()
 * @param {object} terms     { dealId, borrower, adapter, maturity, gracePeriod }
 * @param {object} ctx       { signer, chainId, dealManager, modelCommit, rationaleCID,
 *                             registryView, policy, ttlSeconds }
 */
export async function attest(decision, terms, ctx) {
  const { signer, chainId, dealManager, modelCommit, rationaleCID, registryView, policy, ttlSeconds } = ctx;

  const dealParams = {
    dealId: terms.dealId,
    borrower: terms.borrower,
    adapter: terms.adapter,
    principal: BigInt(decision.principal),
    discountBps: decision.pricing.discountBps,
    maturity: terms.maturity,
    gracePeriod: terms.gracePeriod,
  };

  const opinion = {
    pdBps: Math.round(decision.pd * 10_000),
    pdUpperBps: Math.round(decision.pdUpper * 10_000),
    advanceRateBps: decision.pricing.advanceRateBps,
    modelCommit,
    featureHash: hashFeatures(decision.features),
    rationaleCID,
  };

  const attestation = buildAttestation(dealParams, opinion, await signer.getAddress(), ttlSeconds ?? 3600);
  const signature = await signAttestation(signer, chainId, dealManager, attestation);

  const problems = preflight(dealParams, attestation, signature, chainId, dealManager, registryView, policy);

  return { dealParams, attestation, signature, problems, termsHash: hashTerms(dealParams) };
}
