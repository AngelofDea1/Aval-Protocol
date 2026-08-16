"""Feature engineering for cashflow underwriting.

CRITICAL: this module has a JavaScript twin at agent/src/features.mjs. Inference runs in
JS; only training runs here. If the two drift, the deployed model silently scores garbage
and the resulting PD is meaningless - while still being signed, bonded, and trusted.

agent/test/parity.test.mjs asserts the two implementations agree to 1e-9 on fixtures.
Any change here must be mirrored there, and the parity test must pass.
"""

from __future__ import annotations

import numpy as np

# Order is consensus-critical: model coefficients are positional.
FEATURE_ORDER = [
    "log_scale",
    "rev_trend",
    "rev_volatility",
    "max_drawdown",
    "concentration",
    "obligor_age",
    "coverage",
    "momentum",
]

EPS = 1e-9


def _safe_log(x: np.ndarray) -> np.ndarray:
    return np.log(np.maximum(x, EPS))


def revenue_trend(series: np.ndarray) -> float:
    """OLS slope of log revenue against time, normalised by mean level.

    Normalising makes the feature scale-free, so a $10k/day protocol and a $10M/day
    protocol with identical growth shapes produce the same value.
    """
    n = len(series)
    if n < 3:
        return 0.0
    y = _safe_log(series)
    x = np.arange(n, dtype=float)
    x_c = x - x.mean()
    denom = float((x_c**2).sum())
    if denom < EPS:
        return 0.0
    slope = float((x_c * (y - y.mean())).sum() / denom)
    return slope * n  # total log-growth across the window


def revenue_volatility(series: np.ndarray) -> float:
    """Std dev of log first-differences. The classic dispersion measure for cashflows."""
    if len(series) < 3:
        return 0.0
    returns = np.diff(_safe_log(series))
    if len(returns) == 0:
        return 0.0
    return float(np.std(returns))


def max_drawdown(series: np.ndarray) -> float:
    """Deepest peak-to-trough decline in cumulative revenue, in [0, 1]."""
    if len(series) < 2:
        return 0.0
    cum = np.cumsum(series)
    peak = np.maximum.accumulate(cum)
    with np.errstate(divide="ignore", invalid="ignore"):
        dd = np.where(peak > EPS, (peak - cum) / np.maximum(peak, EPS), 0.0)
    return float(np.max(dd))


def momentum(series: np.ndarray, recent: int = 30, base: int = 90) -> float:
    """Recent mean over trailing mean. Above 1 means accelerating."""
    if len(series) < recent + 1:
        return 1.0
    recent_mean = float(np.mean(series[-recent:]))
    tail = series[-(recent + base) : -recent]
    if len(tail) == 0:
        return 1.0
    base_mean = float(np.mean(tail))
    if base_mean < EPS:
        return 1.0
    return recent_mean / base_mean


def build_features(
    series,
    *,
    concentration: float,
    obligor_age_days: float,
    due_amount: float,
    horizon_days: int = 30,
) -> dict:
    """Build the feature dict for one underwriting decision.

    `series` is historical periodic revenue (most recent last), same units as due_amount.
    `coverage` is the single most predictive feature: projected revenue over the advance
    horizon divided by the amount owed.
    """
    s = np.asarray(series, dtype=float)
    s = np.maximum(s, 0.0)

    recent_rate = float(np.mean(s[-30:])) if len(s) >= 30 else float(np.mean(s)) if len(s) else 0.0
    projected = recent_rate * horizon_days
    coverage = projected / due_amount if due_amount > EPS else 0.0

    return {
        "log_scale": float(np.log(max(recent_rate, EPS))),
        "rev_trend": revenue_trend(s),
        "rev_volatility": revenue_volatility(s),
        "max_drawdown": max_drawdown(s),
        "concentration": float(concentration),
        "obligor_age": float(np.log(max(obligor_age_days, 1.0))),
        "coverage": float(coverage),
        "momentum": float(momentum(s)),
    }


def to_vector(feats: dict) -> np.ndarray:
    return np.array([feats[k] for k in FEATURE_ORDER], dtype=float)
