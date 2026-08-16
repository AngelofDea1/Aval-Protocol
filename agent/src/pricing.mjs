// Risk-based pricing. Pure arithmetic, no imports.
//
// Split out of underwrite.mjs so it can be used by the website, which prices a borrower live
// and must produce exactly what the agent would. underwrite.mjs pulls in ethers, the LLM
// overlay and the signer, none of which belong in a browser-facing path.
//
// Kept byte-identical to the copy in web/lib/underwriting by test/js/model-sync.test.mjs.

/// Loss given default. Conservative: assumes most of a defaulted advance is unrecoverable
/// beyond the bond, because a protocol whose revenue collapsed has little left to seize.
export const DEFAULT_LGD = 0.85;

/// Minimum spread the senior vault earns above expected loss, in bps.
export const TARGET_SPREAD_BPS = 300;

export const LIMITS = {
  minAdvanceRateBps: 3_000,
  maxAdvanceRateBps: 9_000,
  minDiscountBps: 100,
  maxDiscountBps: 4_000,
};

/**
 * Risk-based pricing.
 *
 * advanceRate falls as the *upper* bound of the PD interval rises, so model uncertainty
 * tightens the advance rather than being discarded.
 *
 * discount is priced off the point estimate to cover expected loss plus a target spread:
 *   required = (pd * LGD + spread) / (1 - pd)
 * The (1 - pd) denominator reflects that the yield is only collected in the surviving state.
 */
export function priceDeal({ pd, pdUpper, lgd = DEFAULT_LGD, targetSpreadBps = TARGET_SPREAD_BPS }) {
  const advanceRate = 1 - pdUpper * lgd;
  const advanceRateBps = Math.max(
    LIMITS.minAdvanceRateBps,
    Math.min(LIMITS.maxAdvanceRateBps, Math.round(advanceRate * 10_000))
  );

  const expectedLoss = pd * lgd;
  const survival = Math.max(1 - pd, 0.05);
  const required = (expectedLoss + targetSpreadBps / 10_000) / survival;
  const discountBps = Math.max(
    LIMITS.minDiscountBps,
    Math.min(LIMITS.maxDiscountBps, Math.round(required * 10_000))
  );

  return { advanceRateBps, discountBps, expectedLoss, breakevenBps: Math.round((expectedLoss / survival) * 10_000) };
}
