// GENERATED FILE. DO NOT EDIT.
//
// Copied verbatim from agent/src/model.mjs by script/sync-model-to-web.mjs.
// Edit the original, then run: npm run sync:model
//
// test/js/model-sync.test.mjs fails if this file differs from its source, so the two cannot
// drift apart without the test suite going red.

// Inference for the deployed underwriting model.
//
// Loads the artifact produced by agent/model/train.py and reproduces its scoring exactly:
// standardise -> logistic -> Venn-Abers calibration.
//
// PAVA is hand-rolled here to match venn_abers.py bit for bit rather than pulling a
// library whose tie-breaking might differ. Pinned by agent/test/parity.test.mjs.

// Deliberately imports nothing from node. This file has to run in three places: the CLI, the
// test suite, and the browser, where the same model prices a borrower live. A single
// `import fs` at the top would break the third, so file loading lives in model-node.mjs.
import { FEATURE_ORDER, toVector } from "./features.mjs";

/// Pool Adjacent Violators. Input assumed sorted by predictor score.
export function pava(labels) {
  const n = labels.length;
  if (n === 0) return [];

  const blockSum = [];
  const blockLen = [];
  for (const y of labels) {
    blockSum.push(Number(y));
    blockLen.push(1);
    while (
      blockSum.length > 1 &&
      blockSum[blockSum.length - 2] / blockLen[blockLen.length - 2] >
        blockSum[blockSum.length - 1] / blockLen[blockLen.length - 1]
    ) {
      const s = blockSum.pop();
      const c = blockLen.pop();
      blockSum[blockSum.length - 1] += s;
      blockLen[blockLen.length - 1] += c;
    }
  }

  const out = new Array(n);
  let idx = 0;
  for (let b = 0; b < blockSum.length; b++) {
    const v = blockSum[b] / blockLen[b];
    for (let k = 0; k < blockLen[b]; k++) out[idx++] = v;
  }
  return out;
}

/// Rightmost insertion point, matching numpy.searchsorted(side="right").
function searchSortedRight(sorted, value) {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] <= value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export class VennAbers {
  constructor(scores, labels) {
    this.scores = scores;
    this.labels = labels;
  }

  /// Distribution-free probability interval [p0, p1] for a test score.
  predict(score) {
    const pos = searchSortedRight(this.scores, score);
    const fitWith = (label) => {
      const combined = this.labels.slice(0, pos).concat([label], this.labels.slice(pos));
      return pava(combined)[pos];
    };
    const p0 = fitWith(0);
    const p1 = fitWith(1);
    return [Math.min(p0, p1), Math.max(p0, p1)];
  }

  /// Vovk's merging rule: a single calibrated probability from the interval.
  merged(score) {
    const [p0, p1] = this.predict(score);
    const denom = 1 - p0 + p1;
    return denom <= 0 ? p1 : p1 / denom;
  }
}

export class UnderwritingModel {
  constructor(artifact) {
    this.artifact = artifact;
    this.version = artifact.version;

    if (JSON.stringify(artifact.feature_order) !== JSON.stringify(FEATURE_ORDER)) {
      throw new Error(
        `model.json feature_order does not match features.mjs FEATURE_ORDER.\n` +
          `  artifact: ${artifact.feature_order.join(",")}\n` +
          `  code:     ${FEATURE_ORDER.join(",")}\n` +
          `Retrain, or the coefficients are being applied to the wrong features.`
      );
    }

    this.mean = artifact.scaler.mean;
    this.scale = artifact.scaler.scale;
    this.coef = artifact.logistic.coef;
    this.intercept = artifact.logistic.intercept;
    this.va = new VennAbers(artifact.calibration.scores, artifact.calibration.labels);
  }

  /// Raw logistic decision function (log-odds), pre-calibration.
  score(feats) {
    const x = toVector(feats);
    let z = this.intercept;
    for (let i = 0; i < x.length; i++) z += ((x[i] - this.mean[i]) / this.scale[i]) * this.coef[i];
    return z;
  }

  /// Uncalibrated probability. Reported for comparison; not what the protocol uses.
  rawProbability(feats) {
    return 1 / (1 + Math.exp(-this.score(feats)));
  }

  /**
   * Full prediction.
   *
   * `pd` is the merged Venn-Abers probability (the point estimate the underwriter is
   * scored on). `pdUpper` is the interval's upper edge, used for the protocol's risk
   * ceiling - so model uncertainty tightens underwriting instead of being discarded.
   */
  predict(feats) {
    const s = this.score(feats);
    const [p0, p1] = this.va.predict(s);
    return {
      score: s,
      pRaw: 1 / (1 + Math.exp(-s)),
      p0,
      p1,
      pd: this.va.merged(s),
      pdUpper: p1,
      intervalWidth: p1 - p0,
    };
  }

  /// Per-feature contribution to the log-odds. Drives the human-readable rationale, and
  /// makes the model auditable rather than an unexplained number.
  contributions(feats) {
    const x = toVector(feats);
    return FEATURE_ORDER.map((name, i) => ({
      feature: name,
      value: x[i],
      standardised: (x[i] - this.mean[i]) / this.scale[i],
      contribution: ((x[i] - this.mean[i]) / this.scale[i]) * this.coef[i],
    })).sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));
  }
}
