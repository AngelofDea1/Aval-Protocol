import { NextResponse } from "next/server";

// The real model. web/lib/underwriting holds byte-identical copies of the agent's scoring
// code, kept in step by script/sync-model-to-web.mjs and enforced by
// test/js/model-sync.test.mjs, which also asserts both copies score identically.
//
// Copies rather than cross-directory imports because Vercel builds with `web` as its root,
// and reaching outside it is a deploy that works locally and fails in CI. The drift this
// would normally introduce is caught by a test instead of hoped away.
import { UnderwritingModel } from "@/lib/underwriting/model.mjs";
import { buildFeatures } from "@/lib/underwriting/features.mjs";
import { priceDeal } from "@/lib/underwriting/pricing.mjs";
import { fetchFeeSeries, obligorAgeDays, temporalConcentration } from "@/lib/underwriting/defillama.mjs";
import artifact from "@/lib/underwriting/model.json";

/**
 * GET /api/price?slug=uniswap&face=50000
 *
 * Score a real business against its real revenue history and return what the AI would offer.
 *
 * WHY THIS IS A SERVER ROUTE
 *
 * The revenue source is a third-party API with no guarantee of browser access, and the model
 * artifact is 11KB that would otherwise be shipped to every visitor. Running it here avoids
 * both. It holds no state, stores nothing, and requires no key.
 *
 * WHAT THIS IS NOT
 *
 * It signs nothing and moves no money. Producing a real loan requires an underwriter to sign
 * an EIP-712 attestation with its own key and lock its own bond, which cannot happen in a
 * browser and should not. This is the opinion, not the commitment.
 *
 * The number it returns is genuinely the model's output. The `qualitative` stage of the full
 * pipeline is skipped here because it calls a language model, and the agent records that skip
 * too rather than pretending it ran.
 */

export const dynamic = "force-dynamic";
export const revalidate = 0;

const MAX_PD_UPPER_BPS = 3000; // DealManager.maxPdUpperBps()

export async function GET(request: Request) {
  const url = new URL(request.url);
  const slug = (url.searchParams.get("slug") || "").trim().toLowerCase();
  const face = Number(url.searchParams.get("face") || 50_000);

  if (!slug || !/^[a-z0-9][a-z0-9._-]{0,60}$/.test(slug)) {
    return json({ error: "Enter a business name, for example uniswap or aave." }, 400);
  }
  if (!Number.isFinite(face) || face <= 0 || face > 100_000_000) {
    return json({ error: "Requested amount must be between 1 and 100,000,000." }, 400);
  }

  let series;
  try {
    series = await fetchFeeSeries(slug);
  } catch {
    // Deliberately not leaking the upstream error: the only actionable cause is a name that
    // does not exist in the revenue source.
    return json(
      {
        error: `No revenue history found for "${slug}". Try a protocol listed on DefiLlama, such as uniswap, aave or lido.`,
      },
      404
    );
  }

  const values: number[] = series.values;
  if (values.length < 30) {
    return json(
      { error: `Only ${values.length} days of revenue history. The model needs at least 30 to say anything useful.` },
      422
    );
  }

  const model = new UnderwritingModel(artifact);

  // DefiLlama reports USD; the protocol counts in USDT base units (6 decimals). Mixing the
  // two collapses coverage by 1e6 and the model reports near-certain default while looking
  // perfectly well-formed. This is finding 7 in SECURITY.md.
  const SCALE = 1e6;
  const dueAmount = face * SCALE;

  const feats = buildFeatures(
    values.map((v) => v * SCALE),
    {
      concentration: temporalConcentration(values),
      obligorAgeDays: obligorAgeDays(series),
      dueAmount,
      horizonDays: 30,
    }
  );

  const prediction = model.predict(feats);
  const pdBps = Math.round(prediction.pd * 10_000);
  const pdUpperBps = Math.round(prediction.pdUpper * 10_000);
  const pricing = priceDeal({ pd: prediction.pd, pdUpper: prediction.pdUpper });

  const fundable = pdUpperBps <= MAX_PD_UPPER_BPS;
  const principal = Math.floor((face * pricing.advanceRateBps) / 10_000);

  const top: { feature: string; contribution: number }[] = model.contributions(feats).slice(0, 4);

  /*
   * The raw number is a log-odds contribution. Printed on its own it means nothing to a reader
   * and inviting them to interpret it would be worse than saying nothing.
   *
   * The RATIO between two of them is meaningful though, and it is the thing a reader actually
   * wants: which input moved this decision most. So each is published as a share of the
   * strongest driver in the set, which is honest about being relative and supports a bar the
   * eye can compare without anyone reading a single digit.
   */
  const strongest = Math.max(...top.map((c) => Math.abs(c.contribution)), Number.EPSILON);

  const contributions = top.map((c) => ({
    feature: READABLE[c.feature] ?? c.feature,
    direction: c.contribution < 0 ? "Lowers risk" : "Raises risk",
    /** Share of the strongest driver, 0 to 1. Relative within this quote, not comparable across quotes. */
    weight: Math.abs(c.contribution) / strongest,
  }));

  return json({
    slug,
    requested: face,
    dataPoints: values.length,
    historyDays: Math.round(obligorAgeDays(series)),
    source: series.source,

    pdBps,
    pdUpperBps,
    advanceRateBps: pricing.advanceRateBps,
    discountBps: pricing.discountBps,
    breakevenBps: pricing.breakevenBps,
    principal,

    fundable,
    rejectedBecause: fundable
      ? null
      : `The upper bound of the risk estimate is ${(pdUpperBps / 100).toFixed(2)}%, above the protocol ceiling of ${MAX_PD_UPPER_BPS / 100}%. No underwriter can fund this at any price.`,

    contributions,
    modelVersion: model.version,

    /*
     * `source` is the JSON endpoint the series came from, kept because an agent reading this
     * response wants the feed. A person does not: telling someone to "check it yourself" and
     * opening a wall of raw numbers is an invitation nobody can accept. So the readable page
     * travels alongside it and the interface links that instead.
     */
    sourceName: displayName(slug),
    sourcePage: `https://defillama.com/protocol/${encodeURIComponent(slug)}`,

    disclaimer:
      "An opinion, not an offer. Nothing is signed and no money moves until an underwriter signs this attestation and locks its own collateral behind it. The model is v0, trained on synthetic data, and has never seen a real default.",
  });
}

/**
 * Feature names as a person would say them.
 *
 * Short noun phrases, properly capitalised. These previously read as lowercase sentence
 * fragments ("how far revenue covers the amount"), which strung together with the direction
 * into "how far revenue covers the amount lowers the risk": grammatically broken and hard to
 * scan. A name and a badge is both shorter and clearer.
 */
/**
 * A slug turned back into something a person would write.
 *
 * The picker sends the display name it already has for anything on the roster; this is the
 * fallback for a slug typed in by hand, so the result panel never says "curve-dex" at a
 * reader who asked about Curve DEX.
 */
function displayName(slug: string) {
  return slug
    .split("-")
    .map((w) => (w.length <= 3 ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1)))
    .join(" ");
}

const READABLE: Record<string, string> = {
  coverage: "Revenue cover",
  rev_trend: "Revenue trend",
  rev_volatility: "Revenue stability",
  max_drawdown: "Worst past decline",
  concentration: "Reliance on peak days",
  log_scale: "Size of the business",
  obligor_age: "Length of track record",
  momentum: "Recent momentum",
};

function json(body: unknown, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { "cache-control": "no-store", "access-control-allow-origin": "*" },
  });
}
