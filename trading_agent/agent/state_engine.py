"""Deterministic state engine: order book -> one compact numeric snapshot.

Everything here is computed in code. Jev never sees raw books, only the
rendered snapshot. Causality: a book is only accepted if its exchange
timestamp is <= the local clock and not older than the previous accepted
book, and every windowed statistic uses only observations with ts <= now.
"""
from __future__ import annotations

import math
from collections import deque
from dataclasses import dataclass, field

MAX_SNAPSHOT_TOKENS = 400
DEPTH_LEVELS = 5


class CausalityError(ValueError):
    pass


@dataclass(frozen=True)
class Book:
    ts: float  # exchange timestamp, seconds
    bids: tuple  # ((price, size), ...) best first
    asks: tuple  # ((price, size), ...) best first


@dataclass
class Account:
    equity: float
    position: float = 0.0  # signed base units
    peak_equity: float = 0.0
    day_start_equity: float = 0.0

    def __post_init__(self):
        self.peak_equity = max(self.peak_equity, self.equity)
        self.day_start_equity = self.day_start_equity or self.equity

    def mark(self, equity: float) -> None:
        self.equity = equity
        self.peak_equity = max(self.peak_equity, equity)

    @property
    def drawdown(self) -> float:
        return 0.0 if self.peak_equity <= 0 else 1.0 - self.equity / self.peak_equity

    @property
    def daily_pnl(self) -> float:
        return self.equity - self.day_start_equity


@dataclass
class StateEngine:
    vol_window_s: float = 300.0
    max_book_age_s: float = 2.0
    _mids: deque = field(default_factory=deque)  # (ts, mid)
    _last_ts: float = float("-inf")

    def update(self, book: Book, account: Account, now: float) -> dict:
        self._validate(book, now)
        bid, ask = book.bids[0][0], book.asks[0][0]
        mid = (bid + ask) / 2.0
        self._last_ts = book.ts
        self._mids.append((book.ts, mid))
        cutoff = book.ts - self.vol_window_s
        while self._mids and self._mids[0][0] < cutoff:
            self._mids.popleft()

        bid_depth = sum(s for _, s in book.bids[:DEPTH_LEVELS])
        ask_depth = sum(s for _, s in book.asks[:DEPTH_LEVELS])
        total = bid_depth + ask_depth
        return {
            "ts": round(book.ts, 3),
            "mid": mid,
            "spread_bps": (ask - bid) / mid * 1e4,
            "imbalance": 0.0 if total == 0 else (bid_depth - ask_depth) / total,
            "ret_1m_bps": self._ret_bps(book.ts, 60.0),
            "ret_5m_bps": self._ret_bps(book.ts, 300.0),
            "rvol_bps": self._realized_vol_bps(),
            "inventory_notional": account.position * mid,
            "inventory_pct_equity": 0.0 if account.equity <= 0 else account.position * mid / account.equity,
            "drawdown": account.drawdown,
            "daily_pnl_pct": 0.0 if account.day_start_equity <= 0 else account.daily_pnl / account.day_start_equity,
            "n_obs": len(self._mids),
        }

    def _validate(self, book: Book, now: float) -> None:
        if not book.bids or not book.asks:
            raise ValueError("empty side")
        if book.ts > now:
            raise CausalityError(f"book ts {book.ts} is in the future of {now}")
        if now - book.ts > self.max_book_age_s:
            raise CausalityError(f"stale book: {now - book.ts:.2f}s old")
        if book.ts < self._last_ts:
            raise CausalityError("out-of-order book")
        if book.bids[0][0] >= book.asks[0][0]:
            raise ValueError("crossed book")

    def _ret_bps(self, ts: float, horizon: float) -> float:
        target = ts - horizon
        ref = None
        for t, m in self._mids:
            if t <= target:
                ref = m
            else:
                break
        if ref is None:
            return 0.0
        return (self._mids[-1][1] / ref - 1.0) * 1e4

    def _realized_vol_bps(self) -> float:
        px = [m for _, m in self._mids]
        if len(px) < 3:
            return 0.0
        rets = [math.log(b / a) for a, b in zip(px, px[1:])]
        mean = sum(rets) / len(rets)
        var = sum((r - mean) ** 2 for r in rets) / (len(rets) - 1)
        return math.sqrt(var) * 1e4


def render(snapshot: dict) -> str:
    """Compact single-line text for Jev. Hard-fails if over the token budget."""
    parts = []
    for k, v in snapshot.items():
        parts.append(f"{k}={v:.4f}" if isinstance(v, float) else f"{k}={v}")
    text = " ".join(parts)
    if estimate_tokens(text) > MAX_SNAPSHOT_TOKENS:
        raise ValueError("snapshot exceeds token budget")
    return text


def estimate_tokens(text: str) -> int:
    # Conservative: 1 token per 3 chars (real tokenizers average ~4 on numerics-heavy text).
    return math.ceil(len(text) / 3)
