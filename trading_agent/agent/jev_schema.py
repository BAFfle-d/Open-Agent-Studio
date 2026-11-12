"""Typed decision schema scored by Jev on every candle.

The wire format to Jev (console.typesafe.ai) is NOT verified here; JevClient
is a Protocol and `to_spec()` emits a neutral description to be adapted once
the real API is read. Only the *semantics* below are binding.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

REGIMES = ("trending", "mean_reverting", "high_vol", "crisis")
DIRECTIONS = ("long", "short", "neutral")
# Spec said "toxic_flow is a noun"; interpreted as a categorical noun label.
TOXIC_FLOW = ("none", "sweep", "spoofing", "informed_flow")
RISK_STATES = ("safe", "near_limit", "reduce")
SETUP_QUALITY = (0, 1, 2, 3)

FIELDS = {
    "regime": REGIMES,
    "direction": DIRECTIONS,
    "toxic_flow": TOXIC_FLOW,
    "setup_quality": SETUP_QUALITY,
    "risk_state": RISK_STATES,
}


@dataclass(frozen=True)
class Choice:
    value: object
    confidence: float  # calibrated probability of this choice, [0, 1]


@dataclass(frozen=True)
class JevDecision:
    version: str
    regime: Choice
    direction: Choice
    toxic_flow: Choice
    setup_quality: Choice
    risk_state: Choice


class SchemaError(ValueError):
    pass


def to_spec(version: str, instrument: str, thesis_id: str) -> dict:
    return {
        "version": version,
        "instrument": instrument,
        "thesis_id": thesis_id,
        "fields": {k: list(v) for k, v in FIELDS.items()},
    }


def parse(version: str, raw: dict) -> JevDecision:
    """Validate a normalized response {field: {"value": v, "confidence": p}}.

    Anything off-schema raises; the caller treats that as HOLD.
    """
    out = {}
    for name, allowed in FIELDS.items():
        try:
            v, p = raw[name]["value"], float(raw[name]["confidence"])
        except (KeyError, TypeError, ValueError) as e:
            raise SchemaError(f"missing/invalid field {name}") from e
        if v not in allowed:
            raise SchemaError(f"{name}={v!r} not in {allowed}")
        if not 0.0 <= p <= 1.0 or p != p:
            raise SchemaError(f"{name} confidence {p} out of range")
        out[name] = Choice(v, p)
    return JevDecision(version=version, **out)


class JevClient(Protocol):
    def score(self, spec: dict, snapshot_text: str) -> dict: ...
