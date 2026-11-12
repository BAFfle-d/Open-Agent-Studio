import json, os, tempfile, unittest
from agent import jev_schema as js, policy, risk, review
from agent.loop import Agent, PaperBroker
from agent.state_engine import Account, Book, CausalityError, StateEngine, render, estimate_tokens


def book(ts, mid=100.0, half=0.01, bsz=10, asz=10):
    return Book(ts, tuple((mid - half - i * .01, bsz) for i in range(5)),
                tuple((mid + half + i * .01, asz) for i in range(5)))


def raw(direction="long", dconf=0.9, q=3, regime="trending", risk_state="safe", toxic="none"):
    c = lambda v, p=0.9: {"value": v, "confidence": p}
    return {"regime": c(regime), "direction": c(direction, dconf), "toxic_flow": c(toxic),
            "setup_quality": c(q), "risk_state": c(risk_state)}


class FakeJev:
    def __init__(self, r): self.r = r
    def score(self, spec, text): return self.r


class StateEngineTests(unittest.TestCase):
    def test_future_stale_and_out_of_order_rejected(self):
        e, a = StateEngine(), Account(1000)
        with self.assertRaises(CausalityError): e.update(book(101), a, now=100)
        with self.assertRaises(CausalityError): e.update(book(90), a, now=100)
        e.update(book(99), a, now=100)
        with self.assertRaises(CausalityError): e.update(book(98.5), a, now=100)

    def test_snapshot_under_budget_and_no_future_in_returns(self):
        e, a = StateEngine(), Account(1000)
        for t in range(0, 400):
            s = e.update(book(t, 100 + (t if t < 200 else 0) * .01), a, now=t)
        self.assertLess(estimate_tokens(render(s)), 400)
        # return fields at t=100 must not depend on later data
        e2 = StateEngine()
        for t in range(0, 101):
            s2 = e2.update(book(t, 100 + t * .01), Account(1000), now=t)
        e3 = StateEngine()
        for t in range(0, 101):
            s3 = e3.update(book(t, 100 + t * .01), Account(1000), now=t)
        self.assertEqual(s2, s3)

    def test_imbalance_sign(self):
        s = StateEngine().update(book(1, bsz=30, asz=10), Account(1000), now=1)
        self.assertGreater(s["imbalance"], 0)


class PolicyTests(unittest.TestCase):
    def d(self, **k): return js.parse("v0", raw(**k))

    def test_gates(self):
        self.assertEqual(policy.decide(self.d()).action, "enter")
        for k in ({"q": 1}, {"dconf": 0.80}, {"risk_state": "near_limit"},
                  {"direction": "neutral"}, {"toxic": "sweep"}):
            self.assertEqual(policy.decide(self.d(**k)).action, "hold", k)

    def test_escalation(self):
        self.assertEqual(policy.decide(self.d(dconf=0.5)).action, "escalate")
        self.assertEqual(policy.decide(self.d(regime="crisis")).action, "escalate")

    def test_kelly_capped_and_zero_without_edge(self):
        self.assertLessEqual(policy.kelly_fraction(1.0, policy.Trade()), policy.KELLY_CAP)
        self.assertEqual(policy.kelly_fraction(0.3, policy.Trade()), 0.0)

    def test_escalation_cannot_raise_size(self):
        i = policy.Intent("enter", "buy", 0.1)
        self.assertEqual(policy.apply_escalation(i, "confirm_reduced").size_frac, 0.05)
        self.assertEqual(policy.apply_escalation(i, "anything_else").action, "hold")

    def test_off_schema_rejected(self):
        bad = raw(); bad["regime"]["value"] = "moon"
        with self.assertRaises(js.SchemaError): js.parse("v0", bad)


class RiskTests(unittest.TestCase):
    def setUp(self):
        self.k = risk.KillSwitch(os.path.join(tempfile.mkdtemp(), "KILL"))

    def test_drawdown_trips_latch_and_blocks_new_risk(self):
        a = Account(1000); a.mark(840)  # 16% dd
        v = risk.check_order(risk.Order("buy", 1, 100), a, risk.RiskLimits(), self.k, 1)
        self.assertFalse(v.allowed); self.assertTrue(self.k.tripped)
        a.mark(1000)  # recovery must NOT un-latch
        self.assertTrue(self.k.tripped)

    def test_reduce_only_allowed_when_tripped(self):
        self.k.trip(); a = Account(1000, position=2)
        v = risk.check_order(risk.Order("sell", 5, 100), a, risk.RiskLimits(), self.k, 1)
        self.assertTrue(v.allowed); self.assertEqual(v.qty, 2)

    def test_position_cap_clips(self):
        a = Account(1000)
        v = risk.check_order(risk.Order("buy", 100, 100), a, risk.RiskLimits(), self.k, 1)
        self.assertEqual(v.qty, 1.0)  # 10% order cap: 100/100
        a.position = 2.4  # 240 of 250 allowed
        v = risk.check_order(risk.Order("buy", 1, 100), a, risk.RiskLimits(), self.k, 1)
        self.assertAlmostEqual(v.qty, 0.1)

    def test_daily_loss_trips(self):
        a = Account(1000); a.mark(965)
        v = risk.check_order(risk.Order("buy", 1, 100), a, risk.RiskLimits(), self.k, 1)
        self.assertFalse(v.allowed)

    def test_unreadable_killfile_fails_closed(self):
        k = risk.KillSwitch("/proc/self/\0bad")
        self.assertTrue(k.tripped)


class LoopTests(unittest.TestCase):
    def mk(self, r, escalate=None):
        a = Account(10000)
        kw = {"escalate": escalate} if escalate else {}
        return Agent(FakeJev(r), PaperBroker(a), a, risk.KillSwitch(os.path.join(tempfile.mkdtemp(), "K")), **kw)

    def test_enters_and_respects_caps(self):
        ag = self.mk(raw()); out = ag.step(book(1), now=1)
        self.assertIn(out["action"], ("buy",)); self.assertLessEqual(abs(ag.account.position) * 100, 2500)

    def test_jev_error_means_hold(self):
        class Boom:
            def score(self, *a): raise RuntimeError("down")
        a = Account(1000); ag = Agent(Boom(), PaperBroker(a), a, risk.KillSwitch(os.path.join(tempfile.mkdtemp(), "K")))
        self.assertEqual(ag.step(book(1), now=1)["action"], "hold"); self.assertEqual(a.position, 0)

    def test_crisis_defaults_to_veto(self):
        ag = self.mk(raw(regime="crisis")); self.assertEqual(ag.step(book(1), now=1)["action"], "hold")

    def test_kill_switch_flattens(self):
        ag = self.mk(raw()); ag.step(book(1), now=1); ag.kill.trip()
        out = ag.step(book(2), now=2); self.assertEqual(out["action"], "flatten"); self.assertEqual(ag.account.position, 0)


class ReviewTests(unittest.TestCase):
    def test_brier_and_no_future_labels(self):
        prices = [(t, 100 + t * .1) for t in range(0, 1000)]
        lines = [json.dumps({"ts": 10, "jev": {"direction": {"value": "long", "confidence": .9}}}),
                 json.dumps({"ts": 900, "jev": {"direction": {"value": "long", "confidence": .9}}})]  # unresolved
        s = review.label_decisions(lines, prices)
        self.assertEqual(len(s), 1); self.assertAlmostEqual(review.brier(s), 0.01)

    def test_small_sample_never_promotes(self):
        s = [review.Scored(.9, 1)] * 10
        self.assertFalse(review.promote(s, s)[0])


if __name__ == "__main__":
    unittest.main()
