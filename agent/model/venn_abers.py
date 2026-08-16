"""Venn-Abers predictor: distribution-free probability intervals for binary outcomes.

Why this and not a plain point estimate:

A logistic model outputs a number between 0 and 1 and calls it a probability, but nothing
forces that number to be calibrated - and here it sizes a bonded credit decision. Venn-Abers
produces an *interval* [p0, p1] that is automatically valid under exchangeability alone: no
distributional assumptions, no assumption the model is well-specified.

The protocol uses the lower edge for the point estimate it is scored on and the upper edge
for the risk ceiling policy check, so model uncertainty tightens underwriting rather than
being silently discarded.

Reference: Vovk & Petej, "Venn-Abers Predictors" (2012).

PAVA is hand-rolled rather than taken from sklearn so that agent/src/model.mjs can
reproduce it exactly. Parity is asserted by agent/test/parity.test.mjs.
"""

from __future__ import annotations

import numpy as np


def pava(labels: np.ndarray) -> np.ndarray:
    """Pool Adjacent Violators. Returns the isotonic (non-decreasing) fit of `labels`.

    Inputs are assumed already sorted by their predictor score.
    """
    n = len(labels)
    if n == 0:
        return np.array([], dtype=float)

    # Each block: (sum, count). Merge backwards while the mean order is violated.
    block_sum = []
    block_len = []
    for y in labels:
        block_sum.append(float(y))
        block_len.append(1)
        while len(block_sum) > 1 and block_sum[-2] / block_len[-2] > block_sum[-1] / block_len[-1]:
            s = block_sum.pop()
            c = block_len.pop()
            block_sum[-1] += s
            block_len[-1] += c

    out = np.empty(n, dtype=float)
    idx = 0
    for s, c in zip(block_sum, block_len):
        out[idx : idx + c] = s / c
        idx += c
    return out


class VennAbers:
    """Calibrator fitted on held-out (score, label) pairs."""

    def __init__(self, scores: np.ndarray, labels: np.ndarray):
        order = np.argsort(scores, kind="mergesort")
        self.scores = np.asarray(scores, dtype=float)[order]
        self.labels = np.asarray(labels, dtype=float)[order]

    def predict(self, score: float) -> tuple[float, float]:
        """Return (p0, p1), the Venn-Abers interval for a test score."""
        # Insertion point keeps the combined sequence sorted by score.
        pos = int(np.searchsorted(self.scores, score, side="right"))

        def fit_with(label: float) -> float:
            combined = np.insert(self.labels, pos, label)
            return float(pava(combined)[pos])

        p0 = fit_with(0.0)
        p1 = fit_with(1.0)
        # p0 <= p1 always holds mathematically; clamp defensively against float noise.
        return (min(p0, p1), max(p0, p1))

    def merged(self, score: float) -> float:
        """Single calibrated probability from the interval (Vovk's merging rule)."""
        p0, p1 = self.predict(score)
        denom = 1.0 - p0 + p1
        if denom <= 0:
            return p1
        return p1 / denom

    def to_dict(self) -> dict:
        return {"scores": self.scores.tolist(), "labels": self.labels.tolist()}
