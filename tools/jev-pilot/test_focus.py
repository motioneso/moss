import unittest

from focus import FocusTracker


class FocusCheck(unittest.TestCase):
    def sample(self, tracker, start, end, verdict="distracted", probability=0.9, context="page"):
        for now in range(start, end + 1, 5):
            tracker.observe(now, context)
        return tracker.vote(end, verdict, probability)

    def test_five_minutes_not_five_samples_and_one_flag_per_episode(self):
        tracker = FocusTracker()
        for now in range(0, 300, 60):
            self.assertFalse(self.sample(tracker, max(0, now - 55), now))
        self.assertEqual(tracker.seconds, 240)
        self.assertTrue(self.sample(tracker, 245, 300))
        self.assertFalse(self.sample(tracker, 305, 360))

    def test_uncertainty_never_adds_or_backfills_time(self):
        tracker = FocusTracker()
        self.sample(tracker, 0, 0)
        self.sample(tracker, 5, 60)
        self.sample(tracker, 65, 120, probability=0.52)
        self.sample(tracker, 125, 180)
        self.assertEqual(tracker.seconds, 60)
        self.sample(tracker, 185, 240)
        self.assertEqual(tracker.seconds, 120)

    def test_detour_resets_only_when_clear(self):
        tracker = FocusTracker()
        self.sample(tracker, 0, 0)
        self.sample(tracker, 5, 60)
        self.sample(tracker, 65, 120, "necessary_detour", 0.6)
        self.assertEqual(tracker.seconds, 60)
        self.sample(tracker, 125, 180, "necessary_detour", 0.95)
        self.assertEqual(tracker.seconds, 0)

    def test_page_switch_or_exclusion_does_not_credit_interval(self):
        for context in ("new page", None):
            tracker = FocusTracker()
            self.sample(tracker, 0, 0)
            self.sample(tracker, 5, 60)
            tracker.observe(65, context)
            self.sample(tracker, 70, 120)
            self.assertEqual(tracker.seconds, 60)

    def test_idle_sleep_long_uncertainty_and_network_failure(self):
        tracker = FocusTracker()
        self.sample(tracker, 0, 0)
        self.sample(tracker, 5, 60)
        tracker.uncertain()  # Failed call invalidates the pending interval.
        self.sample(tracker, 65, 120)
        self.assertEqual(tracker.seconds, 60)
        tracker.observe(125, None, idle=True)
        self.assertEqual(tracker.seconds, 0)
        self.sample(tracker, 130, 180)
        self.sample(tracker, 185, 240)
        tracker.observe(300, "page")  # Process suspension / missing capture ticks.
        self.assertEqual(tracker.seconds, 0)
        self.sample(tracker, 305, 360)
        self.sample(tracker, 365, 420)
        self.sample(tracker, 425, 480, probability=0.5)
        self.sample(tracker, 485, 540, probability=0.5)
        self.sample(tracker, 545, 600, probability=0.5)
        self.assertEqual(tracker.seconds, 0)

    def test_cooldown_survives_focus_reset(self):
        tracker = FocusTracker(threshold=60, cooldown=180)
        self.sample(tracker, 0, 0)
        self.assertTrue(self.sample(tracker, 5, 60))
        self.sample(tracker, 65, 120, "focused")
        self.sample(tracker, 125, 180)
        self.assertTrue(self.sample(tracker, 185, 240))
        self.sample(tracker, 245, 250, "focused")
        self.sample(tracker, 255, 260)
        self.assertFalse(self.sample(tracker, 265, 320))

    def test_without_goal_or_context_no_flag(self):
        tracker = FocusTracker(threshold=1)
        self.assertFalse(tracker.vote(0, "distracted", 1))
        self.sample(tracker, 0, 60, "insufficient_evidence", None)
        self.assertEqual(tracker.seconds, 0)
