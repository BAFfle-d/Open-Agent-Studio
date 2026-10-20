# WHAT COULD I BE WRONG ABOUT?

Ordered by how likely each is to lose money.

1. **There is no demonstrated edge.** Nothing here has been backtested or paper-traded. Jev's
   70–500 ms latency and benchmark claims are vendor-reported (not independently verified); "calibrated"
   means nothing until *your* Brier score on *your* instruments says so. Default assumption: no edge.
2. **Costs.** `Trade.cost=12 bps` and the paper broker's 6 bps fee + 5 bps slippage are my guesses.
   With take=150 bps/stop=75 bps and ~50% hit rates, 12 bps round trip is a large share of edge; real
   spread/impact in thin alts can double it. Measure from fills before any live money.
3. **The 0.80 threshold and quarter-Kelly are only as good as calibration.** Kelly with an
   overconfident p oversizes. Mitigation: sizes are capped (10% order, 25% position), and `promote()`
   blocks schema changes without >=200 samples — but 200 correlated candles is far fewer independent bets.
4. **Label/horizon choice.** `review.label_decisions` scores direction over a fixed 300 s horizon vs. a
   cost threshold; the live trade exits on take/stop. These can disagree, so Brier may look better
   than P&L. The loop also has no exit logic yet — positions are only closed by kill switch; **this is a
   known gap, not a feature.**
5. **Gaps outside the code:** exchange outages, partial fills, funding payments, withdrawal/custody
   risk, API-key scope, clock skew, and overnight gaps in the price-based loss limits (limits are
   checked only when an order is evaluated, plus the loop's kill check each step — not by an
   independent watchdog process; add one).
6. **Overnight self-improvement can overfit.** A nightly rewrite chasing yesterday's data is the
   classic way to compound noise. Gate is conservative but a gate on in-sample-adjacent data is not proof.
7. **Is the edge organic?** Unknown; I have no thesis data. **Is the catalyst priced in?** Unknown.
   **Does value accrue to the token?** Unknown — research was not run (see RESEARCH.md).
8. **AgentKit and the Opus escalator are unverified/unwired.** Escalation defaults to veto, which is
   safe but means crisis/low-confidence states never trade.

Hard-limit audit: drawdown, position, order size, daily loss, spread and the kill switch are all in
`agent/risk.py`; the model can only choose among schema values and cannot touch them. The one
soft spot is #5 — limits are enforced in-process, so a crashed or hung process enforces nothing.

**Survival over profit:** run paper-only, assume no edge until fills prove otherwise, and treat the
15% drawdown cap as an expected cost of ruin-avoidance, not a target.
