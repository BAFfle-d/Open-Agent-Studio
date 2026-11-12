# AgentKit build plan (six phases, approval gate each)

**Caveat:** I could not find agentkit.xyz in a web search on 2026-10-20 (results were unrelated kits:
WyStack Agent Kit, ClaudeKit). Confirm it exists and what it installs before relying on it. The
phase/gate structure below is tool-agnostic; if AgentKit's file layout differs, keep the *gates*.

| # | Phase | Deliverable (path) | Gate (operator approves) |
|---|---|---|---|
| 1 | Spec | `trading_agent/specs/SPEC.md` — instruments, venue, limits, success metrics, kill criteria | Limits & capital at risk signed off |
| 2 | Architecture | `trading_agent/specs/ARCH.md` — module boundaries, failure modes, venue API contract | No limit lives in a model call |
| 3 | Plan | `trading_agent/specs/PLAN.md` — task list, test list first | Test list covers every hard limit |
| 4 | Test-first build | `trading_agent/tests/`, `trading_agent/agent/` (done for core; TODO: venue adapter `agent/venues/<name>.py`, Jev adapter `agent/jev_http.py`, Opus escalator `agent/escalate_opus.py`, feed `agent/feed.py`) | CI green |
| 5 | Review | adversarial review incl. replay of `tests/` under fault injection (stale feed, partial fills, venue 5xx, clock skew) | Findings closed |
| 6 | Ship | paper -> tiny-size live. Promotion requires: >=30 days paper, >=200 resolved decisions, fills' realized costs within 25% of the `Trade.cost` estimate, Brier beats a 'always predict base rate' baseline | Operator flips live flag by hand |

Nightly loop (`agent/review.py` + a cron/agent job at e.g. 23:30 UTC, not yet written):
1. Load day's `decisions.jsonl` and fills; `label_decisions` (no-future labels).
2. Opus drafts schema v(n+1) + threshold *proposals* into `specs/candidates/vN.json`.
3. `promote(candidate, incumbent)` on held-out decisions; failure => keep incumbent.
4. Passing candidates go through phases 5–6 gates. **Nothing auto-deploys; risk limits are never in the candidate file.**
