"""Nightly review: calibration + a promotion gate for the next schema version.

Inputs are the JSONL decision log written by loop.Agent plus a price series.
The outcome label for a decision is whether price moved in the predicted
direction by more than `cost_bps` over `horizon_s`. This module only MEASURES
and GATES; the Opus rewrite of the schema is a separate, AgentKit-gated step,
and a candidate never replaces the live schema without passing `promote()`.
"""
from __future__ import annotations

import json
from bisect import bisect_right
from dataclasses import dataclass


@dataclass(frozen=True)
class Scored:
    p: float
    y: int


def brier(scored: list[Scored]) -> float:
    return sum((s.p - s.y) ** 2 for s in scored) / len(scored) if scored else float("nan")


def calibration_bins(scored: list[Scored], n: int = 5) -> list[dict]:
    bins = [[] for _ in range(n)]
    for s in scored:
        bins[min(int(s.p * n), n - 1)].append(s)
    return [{"lo": i / n, "hi": (i + 1) / n, "n": len(b),
             "mean_p": sum(x.p for x in b) / len(b), "hit_rate": sum(x.y for x in b) / len(b)}
            for i, b in enumerate(bins) if b]


def label_decisions(log_lines: list[str], prices: list[tuple[float, float]],
                    horizon_s: float = 300.0, cost_bps: float = 12.0) -> list[Scored]:
    """prices: sorted (ts, mid). Neutral / unparseable / unresolved decisions are skipped."""
    ts_list = [t for t, _ in prices]
    out = []
    for line in log_lines:
        r = json.loads(line)
        d = r.get("jev", {}).get("direction")
        if not d or d["value"] == "neutral":
            continue
        t0, t1 = r["ts"], r["ts"] + horizon_s
        if t1 > ts_list[-1]:
            continue  # outcome not yet observable: never label with missing future
        p0 = prices[bisect_right(ts_list, t0) - 1][1]
        p1 = prices[bisect_right(ts_list, t1) - 1][1]
        move = (p1 / p0 - 1) * 1e4 * (1 if d["value"] == "long" else -1)
        out.append(Scored(float(d["confidence"]), int(move > cost_bps)))
    return out


def promote(candidate: list[Scored], incumbent: list[Scored], min_n: int = 200,
            min_improvement: float = 0.005) -> tuple[bool, str]:
    """Both scored on the SAME held-out decisions. Small samples never promote."""
    if min(len(candidate), len(incumbent)) < min_n:
        return False, f"insufficient samples (<{min_n})"
    bc, bi = brier(candidate), brier(incumbent)
    if bc > bi - min_improvement:
        return False, f"no material improvement (cand={bc:.4f}, inc={bi:.4f})"
    return True, f"improved Brier {bi:.4f} -> {bc:.4f}; still requires AgentKit ship approval"
