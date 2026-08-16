// The revenue source registry.
//
// Aval prices revenue a business has ALREADY earned, so the whole protocol turns on one
// question that has nothing to do with modelling: can a stranger check that the revenue
// happened, without taking the borrower's word for it?
//
// That question has different answers for different businesses, and each answer costs a
// different amount of trust. A Uniswap fee stream costs none - the numbers are public and a
// judge can pull them independently. A bakery's daily takings are just as real and cost a
// signature from somebody willing to put their name on them.
//
// So a source here is not just a fetch function. Every source MUST declare `trust`: the
// sentence a lender has to accept before believing anything the model says about a borrower
// scored through it. A source with no stated trust assumption does not load - see the
// validation at the bottom of this file, which runs at import time.
//
// That is deliberate. An unstated trust assumption is the failure mode this entire protocol
// exists to price, and it would be absurd to reproduce it in our own data layer.
//
// ---------------------------------------------------------------------------------------
// THE CONTRACT
//
// Every source's `fetch(ref, opts)` resolves to:
//
//   {
//     slug:      string   stable identifier for the obligor
//     source:    string   where this came from, printable and ideally checkable by a human
//     fetchedAt: number   unix seconds
//     points:    [{ timestamp: number, value: number }]   oldest first, one per day
//     values:    number[]                                  points.map(p => p.value)
//     trust:     string   copied from the source, so it travels with the data
//   }
//
// `values` is what reaches the model, and the model is trained on DAILY revenue. A source
// returning quarterly or monthly figures would be silently mis-scaled - the trend and
// volatility features are per-period - and would produce a confident, wrong probability on a
// decision somebody is about to post collateral against. Hence `period: "daily"` is asserted,
// not assumed.

import { IngestError, fetchFeeSeries, obligorAgeDays, temporalConcentration } from "./defillama.mjs";
import { fetchAttestedSeries, ATTESTED_TRUST } from "./attested.mjs";

export { IngestError, obligorAgeDays, temporalConcentration };

/** Minimum daily observations before the model is allowed to say anything. */
export const MIN_OBSERVATIONS = 30;

export const SOURCES = {
  defillama: {
    id: "defillama",
    label: "Public protocol revenue",
    period: "daily",
    /** What a lender has to believe. */
    trust: "Nobody. The fee history is public and any lender can pull the same numbers from the same URL.",
    /** What a borrower has to supply. */
    ref: "A DefiLlama protocol slug, for example uniswap or aave.",
    fetch: (ref, opts) => fetchFeeSeries(ref, opts),
  },

  attested: {
    id: "attested",
    label: "Signed revenue attestation",
    period: "daily",
    trust: ATTESTED_TRUST,
    ref: "A signed revenue attestation from an attestor the pool has registered.",
    fetch: (ref, opts) => fetchAttestedSeries(ref, opts),
  },
};

export const SOURCE_IDS = Object.keys(SOURCES);

/**
 * Fetch a revenue series from a named source.
 *
 * The source id is validated against the registry rather than used to build a path or a URL,
 * so an attacker-supplied id cannot reach anything that was not deliberately registered here.
 */
export async function fetchRevenueSeries(sourceId, ref, opts = {}) {
  const source = SOURCES[sourceId];
  if (!source) {
    throw new IngestError(`unknown revenue source "${sourceId}"`, { known: SOURCE_IDS });
  }

  const series = await source.fetch(ref, opts);

  // A source that returns nothing usable must fail here rather than downstream. An empty
  // series flows into the feature functions as "zero revenue", which the model reads as a
  // business earning nothing, which reads as near-certain default. Failing loudly is the
  // difference between an error message and a confidently wrong bonded price.
  if (!Array.isArray(series?.values) || series.values.length === 0) {
    throw new IngestError(`source "${sourceId}" returned no usable datapoints`, { ref });
  }

  if (series.values.length < MIN_OBSERVATIONS) {
    throw new IngestError(
      `only ${series.values.length} daily observations from "${sourceId}"; the model needs at least ${MIN_OBSERVATIONS}`,
      { ref, got: series.values.length, need: MIN_OBSERVATIONS }
    );
  }

  return { ...series, sourceId, trust: source.trust };
}

/*
 * Import-time validation.
 *
 * A source added without a trust statement, or one that reports a non-daily period, is a bug
 * that would otherwise surface as a plausible-looking risk number. It is cheaper to refuse to
 * start.
 */
for (const [id, s] of Object.entries(SOURCES)) {
  if (typeof s.trust !== "string" || s.trust.trim().length < 20) {
    throw new Error(`ingest source "${id}" must declare a written trust assumption`);
  }
  if (s.period !== "daily") {
    throw new Error(
      `ingest source "${id}" reports period "${s.period}"; the model is trained on daily revenue ` +
        `and feeding it another frequency mis-scales the trend and volatility features`
    );
  }
  if (typeof s.fetch !== "function") {
    throw new Error(`ingest source "${id}" has no fetch function`);
  }
}
