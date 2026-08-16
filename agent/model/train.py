"""Train, walk-forward backtest, calibrate, and export the underwriting model.

    python3 agent/model/train.py

Outputs:
    agent/model/model.json          deployed artifact, consumed by agent/src/model.mjs
    agent/model/fixtures.json       parity fixtures for agent/test/parity.test.mjs
    agent/model/report.json         backtest metrics, for the submission write-up

Design decisions, and why:

* Logistic regression is the deployed model, not gradient boosting. On a dataset this size
  the trees do not reliably beat a linear model out-of-time, and interpretability is a real
  feature when the output sizes a bonded credit decision. GBM is trained anyway and
  reported alongside, so the choice is evidenced rather than asserted.

* Evaluation is walk-forward by decision time. Random k-fold on time-series data leaks the
  future into the past and produces flattering, meaningless numbers.

* Reported headline metric is the Brier score, because that is exactly what the protocol
  pays the underwriter on. Train and evaluate the thing you are scored on.
"""

from __future__ import annotations

import json
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from features import FEATURE_ORDER, to_vector  # noqa: E402
from synth import make_dataset  # noqa: E402
from venn_abers import VennAbers  # noqa: E402

from sklearn.ensemble import GradientBoostingClassifier  # noqa: E402
from sklearn.linear_model import LogisticRegression  # noqa: E402
from sklearn.metrics import brier_score_loss, log_loss, roc_auc_score  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
MODEL_VERSION = "aval-underwriter-v0.1.0"
MAX_CALIBRATION_POINTS = 800


def standardise(X: np.ndarray, mean: np.ndarray, scale: np.ndarray) -> np.ndarray:
    return (X - mean) / scale


def metrics(y_true: np.ndarray, p: np.ndarray) -> dict:
    out = {
        "n": int(len(y_true)),
        "base_rate": float(np.mean(y_true)),
        "brier": float(brier_score_loss(y_true, p)),
    }
    # AUC and log loss are undefined / unstable on a single-class fold.
    if len(np.unique(y_true)) > 1:
        out["auc"] = float(roc_auc_score(y_true, p))
        out["log_loss"] = float(log_loss(y_true, np.clip(p, 1e-6, 1 - 1e-6)))
    return out


def reliability(y_true: np.ndarray, p: np.ndarray, bins: int = 10) -> list:
    """Reliability curve data. A calibration claim without this is just a claim."""
    edges = np.linspace(0.0, 1.0, bins + 1)
    rows = []
    for i in range(bins):
        lo, hi = edges[i], edges[i + 1]
        mask = (p >= lo) & (p < hi) if i < bins - 1 else (p >= lo) & (p <= hi)
        if mask.sum() == 0:
            continue
        rows.append(
            {
                "bin": [round(float(lo), 3), round(float(hi), 3)],
                "n": int(mask.sum()),
                "mean_predicted": float(np.mean(p[mask])),
                "observed_rate": float(np.mean(y_true[mask])),
            }
        )
    return rows


def main() -> None:
    print("building dataset...")
    data = make_dataset()
    X = np.array([to_vector(f) for f in data["features"]], dtype=float)
    y = data["labels"].astype(int)
    t = data["times"]

    order = np.argsort(t, kind="mergesort")
    X, y, t = X[order], y[order], t[order]
    print(f"  {len(y)} decisions, default rate {y.mean():.3f}")

    # ---------------------------------------------------------- walk-forward
    print("\nwalk-forward evaluation (expanding window, 5 folds)")
    n = len(y)
    fold_edges = [int(n * f) for f in (0.5, 0.6, 0.7, 0.8, 0.9, 1.0)]
    folds = []
    for i in range(len(fold_edges) - 1):
        tr_end, te_end = fold_edges[i], fold_edges[i + 1]
        X_tr, y_tr = X[:tr_end], y[:tr_end]
        X_te, y_te = X[tr_end:te_end], y[tr_end:te_end]
        if len(np.unique(y_tr)) < 2 or len(y_te) == 0:
            continue

        mean, scale = X_tr.mean(axis=0), X_tr.std(axis=0)
        scale[scale < 1e-9] = 1.0

        lr = LogisticRegression(max_iter=2000, C=1.0)
        lr.fit(standardise(X_tr, mean, scale), y_tr)
        p_lr = lr.predict_proba(standardise(X_te, mean, scale))[:, 1]

        gb = GradientBoostingClassifier(n_estimators=120, max_depth=3, random_state=0)
        gb.fit(X_tr, y_tr)
        p_gb = gb.predict_proba(X_te)[:, 1]

        m_lr, m_gb = metrics(y_te, p_lr), metrics(y_te, p_gb)
        folds.append({"fold": i + 1, "train_n": int(tr_end), "logistic": m_lr, "gbm": m_gb})
        print(
            f"  fold {i+1}: n={m_lr['n']:4d}  "
            f"logistic brier={m_lr['brier']:.4f} auc={m_lr.get('auc', float('nan')):.3f}   |   "
            f"gbm brier={m_gb['brier']:.4f} auc={m_gb.get('auc', float('nan')):.3f}"
        )

    mean_lr = float(np.mean([f["logistic"]["brier"] for f in folds]))
    mean_gb = float(np.mean([f["gbm"]["brier"] for f in folds]))
    print(f"\n  mean out-of-time Brier   logistic {mean_lr:.4f}   gbm {mean_gb:.4f}")
    print(f"  -> deploying logistic ({'better' if mean_lr <= mean_gb else 'worse but interpretable'})")

    # ------------------------------------------------- final fit + calibration
    # Train on the first 70%, calibrate Venn-Abers on the next 15%, hold out the last 15%.
    i_fit, i_cal = int(n * 0.70), int(n * 0.85)
    X_fit, y_fit = X[:i_fit], y[:i_fit]
    X_cal, y_cal = X[i_fit:i_cal], y[i_fit:i_cal]
    X_ho, y_ho = X[i_cal:], y[i_cal:]

    mean, scale = X_fit.mean(axis=0), X_fit.std(axis=0)
    scale[scale < 1e-9] = 1.0

    model = LogisticRegression(max_iter=2000, C=1.0)
    model.fit(standardise(X_fit, mean, scale), y_fit)

    s_cal = model.decision_function(standardise(X_cal, mean, scale))
    if len(s_cal) > MAX_CALIBRATION_POINTS:
        keep = np.linspace(0, len(s_cal) - 1, MAX_CALIBRATION_POINTS).astype(int)
        s_cal, y_cal = s_cal[keep], y_cal[keep]

    va = VennAbers(s_cal, y_cal)

    s_ho = model.decision_function(standardise(X_ho, mean, scale))
    p_raw = model.predict_proba(standardise(X_ho, mean, scale))[:, 1]
    p_merged = np.array([va.merged(s) for s in s_ho])
    intervals = np.array([va.predict(s) for s in s_ho])

    print("\nheld-out (never seen in fitting or calibration)")
    m_raw, m_cal = metrics(y_ho, p_raw), metrics(y_ho, p_merged)
    print(f"  uncalibrated  brier={m_raw['brier']:.4f}  auc={m_raw.get('auc', float('nan')):.3f}")
    print(f"  venn-abers    brier={m_cal['brier']:.4f}  auc={m_cal.get('auc', float('nan')):.3f}")
    print(f"  mean interval width {float(np.mean(intervals[:, 1] - intervals[:, 0])):.4f}")

    # ------------------------------------------------------------------ export
    artifact = {
        "version": MODEL_VERSION,
        "kind": "logistic+venn_abers",
        "feature_order": FEATURE_ORDER,
        "scaler": {"mean": mean.tolist(), "scale": scale.tolist()},
        "logistic": {"coef": model.coef_[0].tolist(), "intercept": float(model.intercept_[0])},
        "calibration": va.to_dict(),
        "trained_on": {
            "source": "synthetic (agent/model/synth.py) - NOT REAL DEFAULT DATA",
            "n_fit": int(len(y_fit)),
            "n_calibration": int(len(y_cal)),
            "n_holdout": int(len(y_ho)),
            "base_rate": float(np.mean(y)),
        },
    }
    with open(os.path.join(HERE, "model.json"), "w") as f:
        json.dump(artifact, f, indent=2)

    report = {
        "model_version": MODEL_VERSION,
        "data_source": "synthetic - replace before claiming accuracy",
        "walk_forward_folds": folds,
        "mean_out_of_time_brier": {"logistic": mean_lr, "gbm": mean_gb},
        "holdout": {"uncalibrated": m_raw, "venn_abers": m_cal},
        "mean_interval_width": float(np.mean(intervals[:, 1] - intervals[:, 0])),
        "reliability_venn_abers": reliability(y_ho, p_merged),
    }
    with open(os.path.join(HERE, "report.json"), "w") as f:
        json.dump(report, f, indent=2)

    # Fixtures pin the JS implementation to this exact Python behaviour.
    fixture_idx = np.linspace(0, len(X_ho) - 1, min(60, len(X_ho))).astype(int)
    fixtures = []
    for i in fixture_idx:
        p0, p1 = va.predict(float(s_ho[i]))
        fixtures.append(
            {
                "features": {k: float(v) for k, v in zip(FEATURE_ORDER, X_ho[i])},
                "score": float(s_ho[i]),
                "p_raw": float(p_raw[i]),
                "p0": float(p0),
                "p1": float(p1),
                "p_merged": float(p_merged[i]),
            }
        )
    with open(os.path.join(HERE, "fixtures.json"), "w") as f:
        json.dump(fixtures, f, indent=2)

    print(f"\nwrote model.json, report.json, fixtures.json ({len(fixtures)} fixtures)")


if __name__ == "__main__":
    main()
