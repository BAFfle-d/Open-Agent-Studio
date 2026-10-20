"""Live loop (PAPER ONLY). One step per candle/book update.

There is deliberately no live-exchange broker in this module. A live broker
must implement `Broker` and be added only after the AgentKit ship gate and a
sustained paper run (see docs/AGENTKIT_PLAN.md).
"""
from __future__ import annotations

import json
import time
from dataclasses import dataclass, field
from typing import Callable, Protocol

from . import jev_schema, policy, risk
from .state_engine import Account, Book, StateEngine, render


class Broker(Protocol):
    def submit(self, order: risk.Order, mid: float) -> float: ...  # returns filled qty


@dataclass
class PaperBroker:
    """Fills at mid +/- slippage, charges taker fee. Mutates the account."""
    account: Account
    fee_bps: float = 6.0       # ESTIMATE
    slippage_bps: float = 5.0  # ESTIMATE
    cash_adj: float = 0.0

    def submit(self, order: risk.Order, mid: float) -> float:
        slip = self.slippage_bps / 1e4
        px = mid * (1 + slip) if order.side == "buy" else mid * (1 - slip)
        fee = abs(order.qty) * px * self.fee_bps / 1e4
        # Equity impact of crossing: slippage + fee vs mid. Position marks at mid.
        self.account.mark(self.account.equity - abs(order.qty) * abs(px - mid) - fee)
        self.account.position += order.signed
        return order.qty


Escalator = Callable[[dict, jev_schema.JevDecision], str]


def default_escalator(snapshot: dict, decision: jev_schema.JevDecision) -> str:
    return "veto"  # fail safe until the Opus deep-read is wired in


@dataclass
class Agent:
    jev: jev_schema.JevClient
    broker: Broker
    account: Account
    kill: risk.KillSwitch
    limits: risk.RiskLimits = field(default_factory=risk.RiskLimits)
    engine: StateEngine = field(default_factory=StateEngine)
    escalate: Escalator = default_escalator
    schema_version: str = "v0"
    instrument: str = "BTC-USD"
    thesis_id: str = "baseline"
    log_path: str | None = None

    def step(self, book: Book, now: float | None = None) -> dict:
        now = time.time() if now is None else now
        snap = self.engine.update(book, self.account, now)
        rec = {"ts": snap["ts"], "snapshot": snap, "action": "hold", "reason": ""}
        try:
            if self.kill.tripped:
                self._flatten(snap, rec)
                return self._emit(rec)
            raw = self.jev.score(jev_schema.to_spec(self.schema_version, self.instrument, self.thesis_id),
                                 render(snap))
            decision = jev_schema.parse(self.schema_version, raw)
            rec["jev"] = raw
            intent = policy.decide(decision)
            if intent.action == "escalate":
                intent = policy.apply_escalation(
                    policy.Intent("hold", reason=intent.reason), self.escalate(snap, decision))
                rec["escalated"] = True
            rec["reason"] = intent.reason
            if intent.action == "enter":
                self._enter(intent, snap, rec)
        except Exception as e:  # any failure => hold; never trade on an error path
            rec.update(action="hold", reason=f"error:{type(e).__name__}:{e}")
        return self._emit(rec)

    def _enter(self, intent: policy.Intent, snap: dict, rec: dict) -> None:
        mid = snap["mid"]
        qty = intent.size_frac * self.account.equity / mid
        v = risk.check_order(risk.Order(intent.side, qty, mid), self.account, self.limits,
                             self.kill, snap["spread_bps"])
        rec["risk"] = v.reason
        if v.allowed:
            self.broker.submit(risk.Order(intent.side, v.qty, mid), mid)
            rec.update(action=intent.side, qty=v.qty)

    def _flatten(self, snap: dict, rec: dict) -> None:
        pos = self.account.position
        rec["reason"] = "kill_switch"
        if pos:
            o = risk.Order("sell" if pos > 0 else "buy", abs(pos), snap["mid"])
            v = risk.check_order(o, self.account, self.limits, self.kill, snap["spread_bps"])
            if v.allowed:
                self.broker.submit(risk.Order(o.side, v.qty, o.px), snap["mid"])
                rec.update(action="flatten", qty=v.qty)

    def _emit(self, rec: dict) -> dict:
        if self.log_path:
            with open(self.log_path, "a") as f:
                f.write(json.dumps(rec) + "\n")
        return rec
