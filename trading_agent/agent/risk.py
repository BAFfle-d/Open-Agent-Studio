"""Hard deterministic risk layer. No model output can raise a limit or bypass it.

Fail-closed: any error reading kill-switch state is treated as tripped.
Reduce-only orders (flattening) are always allowed through, even when tripped.
"""
from __future__ import annotations

import os
from dataclasses import dataclass

from .state_engine import Account


@dataclass(frozen=True)
class RiskLimits:
    max_drawdown: float = 0.15
    max_position_pct_equity: float = 0.25  # of equity, notional
    max_daily_loss_pct: float = 0.03
    max_order_pct_equity: float = 0.10
    max_spread_bps: float = 25.0


@dataclass(frozen=True)
class Order:
    side: str  # "buy" | "sell"
    qty: float
    px: float

    @property
    def signed(self) -> float:
        return self.qty if self.side == "buy" else -self.qty


@dataclass(frozen=True)
class Verdict:
    allowed: bool
    qty: float
    reason: str


class KillSwitch:
    """Latching. Trips on file presence, explicit trip(), or any read error."""

    def __init__(self, path: str):
        self.path = path
        self._tripped = False

    def trip(self, reason: str = "manual") -> None:
        self._tripped = True
        try:
            with open(self.path, "w") as f:
                f.write(reason)
        except OSError:
            pass  # in-memory latch already set

    @property
    def tripped(self) -> bool:
        if self._tripped:
            return True
        try:
            os.stat(self.path)
            self._tripped = True  # file present
        except FileNotFoundError:
            pass
        except (OSError, ValueError):
            self._tripped = True  # any other error: fail closed
        return self._tripped

    def reset(self) -> None:
        """Operator-only; the agent loop never calls this."""
        self._tripped = False
        if os.path.exists(self.path):
            os.remove(self.path)


def check_order(order: Order, acct: Account, limits: RiskLimits, kill: KillSwitch,
                spread_bps: float) -> Verdict:
    mid_pos = acct.position
    reducing = mid_pos != 0 and mid_pos * order.signed < 0  # opposes position; qty clipped to |pos|

    # Limit breaches latch the kill switch before anything else.
    if acct.drawdown >= limits.max_drawdown:
        kill.trip(f"max_drawdown {acct.drawdown:.3f}")
    if acct.daily_pnl <= -limits.max_daily_loss_pct * acct.day_start_equity:
        kill.trip(f"max_daily_loss {acct.daily_pnl:.2f}")

    if kill.tripped:
        if reducing:
            return Verdict(True, min(order.qty, abs(mid_pos)), "kill_switch_reduce_only")
        return Verdict(False, 0.0, "kill_switch")
    if order.qty <= 0 or order.px <= 0 or acct.equity <= 0:
        return Verdict(False, 0.0, "invalid")
    if reducing:
        return Verdict(True, min(order.qty, abs(mid_pos)), "reduce")
    if spread_bps > limits.max_spread_bps:
        return Verdict(False, 0.0, "spread_too_wide")

    max_order = limits.max_order_pct_equity * acct.equity / order.px
    max_room = (limits.max_position_pct_equity * acct.equity / order.px) - abs(mid_pos) * (
        1 if mid_pos * order.signed >= 0 else 0)
    qty = min(order.qty, max_order, max(max_room, 0.0))
    if qty <= 0:
        return Verdict(False, 0.0, "position_limit")
    return Verdict(True, qty, "ok" if qty == order.qty else "clipped")
