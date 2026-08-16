"""Synthetic bootstrap dataset for protocol-revenue advances.

THIS IS NOT REAL DATA. It exists so the pipeline is end-to-end runnable and testable before
a real default history exists, and so the walk-forward harness can be validated on a process
whose ground truth is known.

Replace with real observations before making any claim about model accuracy. Anything the
model learns here is a property of this generator, not of the world. Documented plainly
because presenting synthetic-data metrics as real performance is the fastest way to lose
credibility in review.

The generator is built so the label is genuinely uncertain given the features: future
revenue is stochastic, so coverage is informative but never decisive, and volatility,
drawdown and trend carry real signal.
"""

from __future__ import annotations

import numpy as np

from features import build_features


def simulate_revenue(rng: np.random.Generator, n_days: int) -> np.ndarray:
    """Daily protocol fee revenue with drift, vol, regime breaks and spikes."""
    level = float(np.exp(rng.normal(9.0, 1.5)))  # ~$8k/day median, wide spread
    drift = rng.normal(0.0005, 0.004)
    vol = float(np.exp(rng.normal(-2.4, 0.5)))  # ~9% daily log vol

    series = np.empty(n_days, dtype=float)
    for t in range(n_days):
        # Regime break: a protocol losing product-market fit.
        if rng.random() < 0.0015:
            drift -= abs(rng.normal(0.006, 0.004))
        # Incentive campaign or a market-wide volume spike.
        shock = 1.0
        if rng.random() < 0.01:
            shock = float(np.exp(abs(rng.normal(0.5, 0.4))))

        level *= float(np.exp(drift + rng.normal(0.0, vol)))
        level = max(level, 1.0)
        series[t] = level * shock
    return series


def make_dataset(n_obligors: int = 900, seed: int = 7) -> dict:
    """Build (X, y, t) where each row is one advance decision at a point in time."""
    rng = np.random.default_rng(seed)

    history = 180
    horizon = 30
    rows, labels, times, meta = [], [], [], []

    for i in range(n_obligors):
        n_days = history + horizon + int(rng.integers(0, 220))
        series = simulate_revenue(rng, n_days)
        obligor_age = float(rng.integers(60, 1500))
        concentration = float(np.clip(rng.beta(2.2, 3.0), 0.0, 1.0))

        # Sample a few decision points per obligor, always leaving a full horizon ahead.
        max_start = n_days - horizon - history
        n_points = max(1, min(3, max_start // 45))
        for _ in range(n_points):
            start = int(rng.integers(0, max(1, max_start)))
            hist = series[start : start + history]
            future = series[start + history : start + history + horizon]

            # Advance is sized off recent run-rate, with a randomised advance rate so the
            # dataset contains both conservative and aggressive underwriting.
            recent_rate = float(np.mean(hist[-30:]))
            advance_rate = float(rng.uniform(0.45, 0.95))
            principal = recent_rate * horizon * advance_rate
            due = principal * (1.0 + float(rng.uniform(0.03, 0.12)))
            if due < 1.0:
                continue

            feats = build_features(
                hist,
                concentration=concentration,
                obligor_age_days=obligor_age + start,
                due_amount=due,
                horizon_days=horizon,
            )
            realised = float(np.sum(future))
            defaulted = 1 if realised < due else 0

            rows.append(feats)
            labels.append(defaulted)
            times.append(start + history)  # decision time, for walk-forward ordering
            meta.append({"principal": principal, "due": due, "realised": realised})

    return {"features": rows, "labels": np.array(labels), "times": np.array(times), "meta": meta}
