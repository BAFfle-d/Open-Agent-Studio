# trading_agent — BRAIN/REFLEX crypto agent (PAPER ONLY)

Stdlib-only Python. `python3 -m unittest discover -s tests -t .` (19 tests).

| Layer | File | Owns |
|---|---|---|
| State engine | `agent/state_engine.py` | mid, spread, imbalance, realized vol, inventory, drawdown; causal checks; <400-token render |
| Schema | `agent/jev_schema.py` | typed fields Jev scores; strict off-schema rejection |
| Policy | `agent/policy.py` | gates (quality>=2, conf>0.80, risk safe), quarter-Kelly sizing, escalation (conf<0.60 or crisis) |
| Risk | `agent/risk.py` | 15% max DD, position/order/daily-loss caps, latching fail-closed kill switch |
| Loop | `agent/loop.py` | one step per book; any exception => HOLD; paper broker only |
| Review | `agent/review.py` | Brier, calibration bins, no-future labeling, promotion gate |

Not done / unverified: the Jev wire format (`JevClient` is a Protocol), the Opus escalation call
(default escalator = veto), any live broker, any market data feed. See `docs/`.
