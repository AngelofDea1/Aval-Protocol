"""Emit raw-series -> feature fixtures so the JS twin can be pinned to this implementation.

    python3 agent/model/export_feature_fixtures.py
"""

from __future__ import annotations

import json
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from features import build_features  # noqa: E402
from synth import simulate_revenue  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))


def main() -> None:
    rng = np.random.default_rng(21)
    cases = []

    for i in range(25):
        n_days = int(rng.integers(40, 260))
        series = simulate_revenue(rng, n_days)
        concentration = float(np.clip(rng.beta(2.0, 3.0), 0.0, 1.0))
        obligor_age_days = float(rng.integers(30, 2000))
        due_amount = float(np.mean(series[-30:]) * 30 * rng.uniform(0.4, 1.6)) if n_days >= 30 else 1000.0

        feats = build_features(
            series,
            concentration=concentration,
            obligor_age_days=obligor_age_days,
            due_amount=due_amount,
        )
        cases.append(
            {
                "series": [float(x) for x in series],
                "concentration": concentration,
                "obligor_age_days": obligor_age_days,
                "due_amount": due_amount,
                "expected": feats,
            }
        )

    # Degenerate inputs: short series, zeros, flat. These are where twin
    # implementations usually diverge.
    edge_cases = [
        [],
        [0.0],
        [0.0, 0.0, 0.0],
        [100.0, 100.0, 100.0, 100.0],
        [1.0, 2.0],
        [5.0] * 45,
    ]
    for series in edge_cases:
        feats = build_features(series, concentration=0.5, obligor_age_days=365.0, due_amount=1000.0)
        cases.append(
            {
                "series": series,
                "concentration": 0.5,
                "obligor_age_days": 365.0,
                "due_amount": 1000.0,
                "expected": feats,
            }
        )

    with open(os.path.join(HERE, "feature_fixtures.json"), "w") as f:
        json.dump(cases, f)
    print(f"wrote feature_fixtures.json ({len(cases)} cases, {len(edge_cases)} degenerate)")


if __name__ == "__main__":
    main()
