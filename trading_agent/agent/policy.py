"""Policy: Jev decision -> intent. Thresholds live here, never in the model.

The Opus escalation path may only VETO or REDUCE (see apply_escalation); it
cannot raise size or override the risk layer.
"""
from __future__ import annotations

from dataclasses import dataclass

from .jev_schema import JevDecision

MIN_SETUP_QUALITY = 2
MIN_DIRECTION_CONF = 0.80
ESCALATE_CONF = 0.60
KELLY_CAP = 0.25  # quarter Kelly


@dataclass(frozen=True)
class Trade:
    """Code-owned trade geometry. take/stop are fractions of entry price."""
    take: float = 0.015
    stop: float = 0.0075
    cost: float = 0.0012  # round-trip fees + slippage estimate (ESTIMATE, calibrate on fills)


@dataclass(frozen=True)
class Intent:
    action: str  # "enter" | "hold" | "escalate"
    side: str | None = None  # "buy" | "sell"
    size_frac: float = 0.0  # fraction of equity to risk-size into notional
    reason: str = ""


def kelly_fraction(p: float, trade: Trade) -> float:
    """Fractional Kelly for a bracket trade. b = net win / net loss, costs on both sides."""
    win = trade.take - trade.cost
    loss = trade.stop + trade.cost
    if win <= 0:
        return 0.0
    b = win / loss
    f = (p * b - (1.0 - p)) / b
    return max(0.0, min(f * KELLY_CAP, KELLY_CAP))


def decide(d: JevDecision, trade: Trade = Trade()) -> Intent:
    conf = d.direction.confidence
    if d.regime.value == "crisis":
        return Intent("escalate", reason="regime=crisis")
    if conf < ESCALATE_CONF:
        return Intent("escalate", reason=f"direction_conf={conf:.2f}<{ESCALATE_CONF}")
    if d.direction.value == "neutral":
        return Intent("hold", reason="neutral")
    if d.setup_quality.value < MIN_SETUP_QUALITY:
        return Intent("hold", reason="setup_quality")
    if conf <= MIN_DIRECTION_CONF:
        return Intent("hold", reason="direction_conf")
    if d.risk_state.value != "safe":
        return Intent("hold", reason=f"risk_state={d.risk_state.value}")
    if d.toxic_flow.value != "none":
        return Intent("hold", reason=f"toxic_flow={d.toxic_flow.value}")
    f = kelly_fraction(conf, trade)
    if f <= 0:
        return Intent("hold", reason="no_edge_after_costs")
    return Intent("enter", "buy" if d.direction.value == "long" else "sell", f, "gates_passed")


def apply_escalation(intent: Intent, verdict: str) -> Intent:
    """Opus deep-read result: only 'veto' or 'confirm_reduced' are honored."""
    if verdict == "confirm_reduced" and intent.action == "enter":
        return Intent("enter", intent.side, intent.size_frac * 0.5, "opus_reduced")
    return Intent("hold", reason=f"opus_{verdict}")
