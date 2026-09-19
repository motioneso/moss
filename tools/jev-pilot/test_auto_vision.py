import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import auto_vision


MATCH = {"status": "ok", "app": "Safari", "bundle_id": "com.apple.Safari",
         "title": "Liverpool hotels", "window_id": 42}
PNG = b"\x89PNG\r\n\x1a\nsynthetic"


def write_screenshot(command, **_kwargs):
    Path(command[-1]).write_bytes(PNG)


def write_then_fail(command, **_kwargs):
    Path(command[-1]).write_bytes(PNG)
    raise auto_vision.subprocess.CalledProcessError(1, "screencapture")


class AutoVisionCheck(unittest.TestCase):
    def test_metadata_invocation_requests_window_id_and_titles(self):
        completed = type("Completed", (), {"stdout": json.dumps(MATCH).encode()})()
        with patch("auto_vision.subprocess.run", return_value=completed) as run:
            self.assertEqual(auto_vision.capture_metadata("capture", {"com.apple.Safari"}, 600), MATCH)
        command = run.call_args.args[0]
        self.assertIn("--titles", command)
        self.assertIn("--window-id", command)
        self.assertIn("--idle-seconds", command)

    def test_screenshot_is_deleted_after_success(self):
        with tempfile.TemporaryDirectory() as folder:
            with patch("auto_vision.capture_metadata", return_value=MATCH), \
                 patch("auto_vision.subprocess.run", side_effect=write_screenshot):
                result = auto_vision.screenshot_bytes(
                    "capture", {"com.apple.Safari"}, auto_vision.context_key(MATCH), 600,
                    Path(folder), auto_vision.threading.Event())
            self.assertEqual(result[0], PNG)
            self.assertEqual(list(Path(folder).iterdir()), [])

    def test_screenshot_is_deleted_after_capture_error(self):
        with tempfile.TemporaryDirectory() as folder:
            with patch("auto_vision.capture_metadata", return_value=MATCH), \
                 patch("auto_vision.subprocess.run", side_effect=write_then_fail):
                with self.assertRaisesRegex(ValueError, "screen_capture_failed"):
                    auto_vision.screenshot_bytes(
                        "capture", {"com.apple.Safari"}, auto_vision.context_key(MATCH), 600,
                        Path(folder), auto_vision.threading.Event())
            self.assertEqual(list(Path(folder).iterdir()), [])

    def test_cleanup_failure_is_reported(self):
        with patch.object(Path, "unlink", side_effect=OSError):
            with self.assertRaisesRegex(ValueError, "screenshot_cleanup_failed"):
                auto_vision._delete_image(Path("generated.png"))

    def test_context_change_before_visual_upload_skips_provider(self):
        changed = {**MATCH, "window_id": 43}
        with tempfile.TemporaryDirectory() as folder, \
             patch("auto_vision.capture_metadata", side_effect=[MATCH, changed]), \
             patch("auto_vision.subprocess.run", side_effect=write_screenshot), \
             patch("auto_vision.evaluate_vision") as vision:
            result = auto_vision.classify_window(
                "capture", {"com.apple.Safari"}, auto_vision.context_key(MATCH), 600,
                Path(folder), auto_vision.MODELS[0], "openrouter", "typesafe", "goal",
                auto_vision.threading.Event())
        self.assertTrue(result["stale"])
        vision.assert_not_called()

    def test_context_change_during_vision_blocks_jev(self):
        changed = {**MATCH, "window_id": 43}
        visual = {"observation": {"scene": "hotel", "relevant_text": "Liverpool",
                                   "uncertainties": "none"}, "usage": {}}
        with tempfile.TemporaryDirectory() as folder, \
             patch("auto_vision.capture_metadata", side_effect=[MATCH, MATCH, changed]), \
             patch("auto_vision.subprocess.run", side_effect=write_screenshot), \
             patch("auto_vision.evaluate_vision", return_value=visual), \
             patch("auto_vision.evaluate_jev") as jev:
            result = auto_vision.classify_window(
                "capture", {"com.apple.Safari"}, auto_vision.context_key(MATCH), 600,
                Path(folder), auto_vision.MODELS[0], "openrouter", "typesafe", "goal",
                auto_vision.threading.Event())
        self.assertTrue(result["stale"])
        jev.assert_not_called()

    def test_preview_never_calls_network(self):
        with tempfile.TemporaryDirectory() as folder, \
             patch("auto_vision.capture_metadata", side_effect=[MATCH, MATCH]), \
             patch("auto_vision.subprocess.run", side_effect=write_screenshot), \
             patch("auto_vision.evaluate_vision") as vision, \
             patch("auto_vision.evaluate_jev") as jev:
            result = auto_vision.classify_window(
                "capture", {"com.apple.Safari"}, auto_vision.context_key(MATCH), 600,
                Path(folder), auto_vision.MODELS[0], "", "", "goal",
                auto_vision.threading.Event())
        self.assertTrue(result["preview_only"])
        vision.assert_not_called()
        jev.assert_not_called()

    def test_run_waits_for_stable_dwell_before_submit(self):
        class Clock:
            value = 0

            def monotonic(self):
                self.value += 5
                return self.value

        class Future:
            def done(self):
                return True

            def result(self):
                return {"preview_only": True, "captured_at": 30, "captured_at_utc": "now"}

        class Executor:
            def __init__(self):
                self.submits = 0

            def submit(self, *args):
                self.submits += 1
                return Future()

            def shutdown(self, **_kwargs):
                pass

        args = type("Args", (), {
            "minutes": 1, "allow": {"com.apple.Safari"}, "idle_minutes": 10,
            "interval": 60, "max_calls": 1, "flag_after_minutes": 5,
            "distraction_probability": 0.7, "cooldown_minutes": 30,
            "once": False, "live": False, "model": auto_vision.MODELS[0],
            "goal": "goal", "screenshot_dir": Path(tempfile.mkdtemp()),
        })()
        clock = Clock()
        executor = Executor()
        with patch("auto_vision.time.monotonic", side_effect=clock.monotonic), \
             patch("auto_vision.time.sleep"), \
             patch("auto_vision.ThreadPoolExecutor", return_value=executor), \
             patch("auto_vision.capture_metadata", return_value=MATCH), \
             patch("builtins.print"):
            auto_vision.run(args, "capture", "", "")
        self.assertEqual(executor.submits, 1)
        # The first sample starts the dwell; submission occurs after the 15-second gate.
        self.assertGreaterEqual(clock.value, 20)

    def test_run_credits_completed_distracted_samples_and_flags(self):
        class Clock:
            value = 0

            def monotonic(self):
                self.value += 5
                return self.value

        class Future:
            def __init__(self, result):
                self._result = result

            def done(self):
                return True

            def result(self):
                return self._result

        result = {"captured_at": 20, "captured_at_utc": "now", "vision_elapsed_seconds": 1,
                  "visual": {"cost_credits": 0, "usage": {}},
                  "jev": {"alignment": "distracted", "alignment_probability": 0.9,
                          "activity": "entertainment", "activity_probability": 0.9,
                          "activity_confidence": 0.9, "activity_probabilities": {},
                          "alignment_confidence": 0.9, "alignment_probabilities": {}}}
        second = {**result, "captured_at": 80}

        class Executor:
            def __init__(self):
                self.results = iter((result, second))
                self.submits = 0

            def submit(self, *args):
                self.submits += 1
                return Future(next(self.results))

            def shutdown(self, **_kwargs):
                pass

        args = type("Args", (), {
            "minutes": 2, "allow": {"com.apple.Safari"}, "idle_minutes": 10,
            "interval": 60, "max_calls": 2, "flag_after_minutes": 1,
            "distraction_probability": 0.7, "cooldown_minutes": 30,
            "once": False, "live": True, "model": auto_vision.MODELS[0],
            "goal": "goal", "screenshot_dir": Path(tempfile.mkdtemp()),
        })()
        clock = Clock()
        executor = Executor()
        with patch("auto_vision.time.monotonic", side_effect=clock.monotonic), \
             patch("auto_vision.time.sleep"), \
             patch("auto_vision.ThreadPoolExecutor", return_value=executor), \
             patch("auto_vision.capture_metadata", return_value=MATCH), \
             patch("builtins.print") as printed:
            auto_vision.run(args, "capture", "openrouter", "typesafe")
        self.assertEqual(executor.submits, 2)
        self.assertTrue(any("FOCUS FLAG" in str(call) for call in printed.call_args_list))

    def test_once_waits_through_excluded_foreground_then_captures_allowed_window(self):
        class Clock:
            value = 0

            def monotonic(self):
                self.value += 5
                return self.value

        class Future:
            def done(self):
                return True

            def result(self):
                return {"preview_only": True, "captured_at": 20, "captured_at_utc": "now"}

        class Executor:
            def __init__(self):
                self.submits = 0

            def submit(self, *args):
                self.submits += 1
                return Future()

            def shutdown(self, **_kwargs):
                pass

        args = type("Args", (), {
            "minutes": 1, "allow": {"com.apple.Safari"}, "idle_minutes": 10,
            "interval": 60, "max_calls": 1, "flag_after_minutes": 5,
            "distraction_probability": 0.7, "cooldown_minutes": 30,
            "once": True, "live": False, "model": auto_vision.MODELS[0],
            "goal": "goal", "screenshot_dir": Path(tempfile.mkdtemp()),
        })()
        excluded = {"status": "excluded"}
        clock = Clock()
        executor = Executor()
        with patch("auto_vision.time.monotonic", side_effect=clock.monotonic), \
             patch("auto_vision.time.sleep"), \
             patch("auto_vision.ThreadPoolExecutor", return_value=executor), \
             patch("auto_vision.capture_metadata", side_effect=[excluded] + [MATCH] * 10), \
             patch("builtins.print"):
            auto_vision.run(args, "capture", "", "")
        self.assertEqual(executor.submits, 1)
        self.assertGreaterEqual(clock.value, 20)

    def test_exclusion_invalidates_pending_result_even_if_context_returns(self):
        class Clock:
            value = 0

            def monotonic(self):
                self.value += 5
                return self.value

        class Future:
            def __init__(self):
                self.checks = 0

            def done(self):
                self.checks += 1
                return self.checks > 1

            def result(self):
                return {"preview_only": True, "captured_at": 20, "captured_at_utc": "now"}

        class Executor:
            def __init__(self):
                self.future = Future()

            def submit(self, *args):
                return self.future

            def shutdown(self, **_kwargs):
                pass

        args = type("Args", (), {
            "minutes": 1, "allow": {"com.apple.Safari"}, "idle_minutes": 10,
            "interval": 60, "max_calls": 1, "flag_after_minutes": 5,
            "distraction_probability": 0.7, "cooldown_minutes": 30,
            "once": True, "live": False, "model": auto_vision.MODELS[0],
            "goal": "goal", "screenshot_dir": Path(tempfile.mkdtemp()),
        })()
        excluded = {"status": "excluded"}
        clock = Clock()
        executor = Executor()
        with patch("auto_vision.time.monotonic", side_effect=clock.monotonic), \
             patch("auto_vision.time.sleep"), \
             patch("auto_vision.ThreadPoolExecutor", return_value=executor), \
             patch("auto_vision.capture_metadata", side_effect=[MATCH, MATCH, MATCH, excluded] + [MATCH] * 10), \
             patch("builtins.print") as printed:
            auto_vision.run(args, "capture", "", "")
        self.assertTrue(any("Dropped stale result." in str(call) for call in printed.call_args_list))


if __name__ == "__main__":
    unittest.main()
