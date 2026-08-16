// GENERATED FILE. DO NOT EDIT.
//
// Copied verbatim from agent/src/features.mjs by script/sync-model-to-web.mjs.
// Edit the original, then run: npm run sync:model
//
// test/js/model-sync.test.mjs fails if this file differs from its source, so the two cannot
// drift apart without the test suite going red.

// JavaScript twin of agent/model/features.py.
//
// Training happens in Python; inference happens here. If these two drift, the deployed
// model scores garbage - and the resulting PD is still signed, bonded, and trusted by the
// contract. There is no runtime check that would catch it.
//
// agent/test/parity.test.mjs pins this to the Python implementation on 31 fixtures
// including degenerate inputs. Any change here must be mirrored in features.py and the
// parity test must pass.

/// Order is consensus-critical: model coefficients are positional.
export const FEATURE_ORDER = [
  "log_scale",
  "rev_trend",
  "rev_volatility",
  "max_drawdown",
  "concentration",
  "obligor_age",
  "coverage",
  "momentum",
];

const EPS = 1e-9;

const safeLog = (x) => Math.log(Math.max(x, EPS));
const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);

/// OLS slope of log revenue against time, scaled by window length.
export function revenueTrend(series) {
  const n = series.length;
  if (n < 3) return 0;
  const y = series.map(safeLog);
  const yBar = mean(y);
  const xBar = (n - 1) / 2;

  let num = 0;
  let denom = 0;
  for (let i = 0; i < n; i++) {
    const xc = i - xBar;
    num += xc * (y[i] - yBar);
    denom += xc * xc;
  }
  if (denom < EPS) return 0;
  return (num / denom) * n;
}

/// Std dev of log first-differences (population, matching numpy's default ddof=0).
export function revenueVolatility(series) {
  if (series.length < 3) return 0;
  const logs = series.map(safeLog);
  const returns = [];
  for (let i = 1; i < logs.length; i++) returns.push(logs[i] - logs[i - 1]);
  if (returns.length === 0) return 0;
  const m = mean(returns);
  return Math.sqrt(mean(returns.map((r) => (r - m) ** 2)));
}

/// Deepest peak-to-trough decline in cumulative revenue, in [0, 1].
export function maxDrawdown(series) {
  if (series.length < 2) return 0;
  let cum = 0;
  let peak = 0;
  let worst = 0;
  for (const v of series) {
    cum += v;
    if (cum > peak) peak = cum;
    const dd = peak > EPS ? (peak - cum) / Math.max(peak, EPS) : 0;
    if (dd > worst) worst = dd;
  }
  return worst;
}

/// Recent mean over trailing mean. Above 1 means accelerating.
export function momentum(series, recent = 30, base = 90) {
  if (series.length < recent + 1) return 1;
  const recentSlice = series.slice(-recent);
  const recentMean = mean(recentSlice);
  const start = Math.max(0, series.length - recent - base);
  const tail = series.slice(start, series.length - recent);
  if (tail.length === 0) return 1;
  const baseMean = mean(tail);
  if (baseMean < EPS) return 1;
  return recentMean / baseMean;
}

/**
 * Build the feature object for one underwriting decision.
 *
 * @param {number[]} rawSeries historical periodic revenue, most recent last
 * @param {object} opts { concentration, obligorAgeDays, dueAmount, horizonDays }
 */
export function buildFeatures(rawSeries, { concentration, obligorAgeDays, dueAmount, horizonDays = 30 }) {
  const series = (rawSeries ?? []).map((v) => Math.max(Number(v) || 0, 0));

  let recentRate = 0;
  if (series.length >= 30) recentRate = mean(series.slice(-30));
  else if (series.length > 0) recentRate = mean(series);

  const projected = recentRate * horizonDays;
  const coverage = dueAmount > EPS ? projected / dueAmount : 0;

  return {
    log_scale: Math.log(Math.max(recentRate, EPS)),
    rev_trend: revenueTrend(series),
    rev_volatility: revenueVolatility(series),
    max_drawdown: maxDrawdown(series),
    concentration: Number(concentration),
    obligor_age: Math.log(Math.max(obligorAgeDays, 1)),
    coverage,
    momentum: momentum(series),
  };
}

export function toVector(feats) {
  return FEATURE_ORDER.map((k) => feats[k]);
}

/// Stable hash of the exact inputs the model saw. Anchored onchain as `featureHash`, so a
/// settled deal is a permanent record of what was scored.
export function featureVectorString(feats) {
  return FEATURE_ORDER.map((k) => `${k}=${Number(feats[k]).toExponential(12)}`).join("|");
}
