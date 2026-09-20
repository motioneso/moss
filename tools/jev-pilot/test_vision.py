"""Offline screenshot-probe checks; no real images or credentials leave this process."""

from contextlib import redirect_stdout
from copy import deepcopy
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import urllib.error

import vision


class VisionCheck(unittest.TestCase):
    def test_watch_skips_existing_waits_for_writes_and_processes_once(self):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            old = folder / "old.png"
            old.write_bytes(b"old")
            new = folder / "new.png"
            later = folder / "later.JPG"
            ticks = []

            def tick(_):
                ticks.append(1)
                n = len(ticks)
                if n == 1:
                    new.write_bytes(b"partial")
                    old.write_bytes(b"overwritten")
                    (folder / "link.png").symlink_to(old)
                    (folder / "note.txt").write_text("ignore")
                if n == 2:
                    new.write_bytes(b"finished image")
                if n == 4:
                    new.write_bytes(b"changed after processing")
                    later.write_bytes(b"another image")
                if n > 5:
                    raise AssertionError("watcher did not yield expected image")

            with patch("vision.time.sleep", side_effect=tick), redirect_stdout(io.StringIO()):
                images = vision.new_images(folder)
                self.assertEqual(next(images), new)
                self.assertEqual(len(ticks), 3)
                self.assertEqual(next(images), later)
                self.assertEqual(len(ticks), 5)
                images.close()

    def test_watch_limit_and_auth_failure_stop_calls(self):
        with tempfile.TemporaryDirectory() as directory:
            paths = [Path(directory) / "one.png", Path(directory) / "two.png"]
            with patch("sys.argv", ["vision.py", "--watch", directory, "--max-images", "1"]), \
                    patch("vision.new_images", return_value=iter(paths)), \
                    patch("vision.process_image", return_value=0) as process, redirect_stdout(io.StringIO()):
                self.assertEqual(vision.main(), 0)
                process.assert_called_once_with(paths[0], vision.MODELS[0], None)
            with patch("sys.argv", ["vision.py", "--watch", directory, "--live"]), \
                    patch.dict("os.environ", {"OPENROUTER_API_KEY": "test-key"}), \
                    patch("vision.new_images", return_value=iter(paths)), \
                    patch("vision.process_image", side_effect=ValueError("http_401")) as process, \
                    redirect_stdout(io.StringIO()):
                self.assertEqual(vision.main(), 1)
                self.assertEqual(process.call_count, 1)

    def test_preview_never_calls_provider_or_reads_key(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "sample.png"
            path.write_bytes(b"\x89PNG\r\n\x1a\nsynthetic")
            with patch("sys.argv", ["vision.py", str(path)]), patch("vision.evaluate") as call, \
                    patch("vision.getpass.getpass") as key, redirect_stdout(io.StringIO()) as output:
                self.assertEqual(vision.main(), 0)
                call.assert_not_called()
                key.assert_not_called()
            self.assertNotIn("base64", output.getvalue())
            path.write_bytes(b"not an image")
            with self.assertRaisesRegex(ValueError, "PNG_or_JPEG"):
                vision.image_data(path)
            with patch("vision.LIMIT", 2):
                with self.assertRaisesRegex(ValueError, "over_8_MiB"):
                    vision.image_data(path)

    def test_jev_preview_never_calls_either_provider_or_prompts(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "sample.png"
            path.write_bytes(b"\x89PNG\r\n\x1a\nsynthetic")
            with patch("sys.argv", ["vision.py", str(path), "--jev", "--goal", "Work"]), \
                    patch("vision.evaluate") as openrouter, \
                    patch("vision.evaluate_jev") as jev, \
                    patch("vision.getpass.getpass") as prompt, \
                    redirect_stdout(io.StringIO()) as output:
                self.assertEqual(vision.main(), 0)
            openrouter.assert_not_called()
            jev.assert_not_called()
            prompt.assert_not_called()
            self.assertIn('"jev_enabled": true', output.getvalue())

    def test_live_jev_startup_names_typesafe_visual_payload(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "one.png"
            with patch("sys.argv", ["vision.py", "--watch", directory, "--live", "--jev",
                                     "--goal", "Work", "--max-images", "1"]), \
                    patch.dict("os.environ", {"OPENROUTER_API_KEY": "openrouter",
                                                "TYPESAFE_API_KEY": "typesafe"}), \
                    patch("vision.new_images", return_value=iter([path])), \
                    patch("vision.process_image", return_value=0), \
                    redirect_stdout(io.StringIO()) as output:
                self.assertEqual(vision.main(), 0)
            self.assertIn("bounded visual description and supplied goal", output.getvalue())

    def test_transport_and_billed_usage(self):
        observation = {"scene": "Hotel search", "relevant_text": "Liverpool", "uncertainties": "Dates unclear"}
        data = {"choices": [{"finish_reason": "stop", "message": {"content": json.dumps(observation)}}],
                "usage": {"prompt_tokens": 1000, "completion_tokens": 100, "cost": 0.000043}}
        with patch("vision.urllib.request.build_opener") as factory:
            factory.return_value.open.return_value.__enter__.return_value.read.return_value = json.dumps(data).encode()
            result = vision.evaluate(vision.request_body(b"image", "image/png", vision.MODELS[0]), "test-key")
            request = factory.return_value.open.call_args.args[0]
            body = json.loads(request.data)
            self.assertEqual(request.full_url, vision.ENDPOINT)
            self.assertEqual(body["max_tokens"], 256)
            self.assertFalse(body["reasoning"]["enabled"])
            self.assertFalse(body["provider"]["allow_fallbacks"])
            self.assertTrue(body["messages"][1]["content"][1]["image_url"]["url"].startswith("data:image/png;base64,"))
            self.assertEqual(result["observation"], observation)
            self.assertEqual(result["cost_credits"], 0.000043)
        for content in ("broken", "[]", '{"scene": 123}', json.dumps({**observation, "scene": "a" * 601})):
            data["choices"][0]["message"]["content"] = content
            result = vision.parse_result(data)
            self.assertIn("error", result)
            self.assertEqual(result["cost_credits"], 0.000043)
            self.assertNotIn("observation", result)
        data["choices"][0].update(finish_reason="length", message={"content": json.dumps(observation)})
        self.assertIn("error", vision.parse_result(data))
        self.assertIsNone(vision.parse_result({"usage": {"cost": float("nan")}})["cost_credits"])

    def test_jev_receives_bounded_screenshot_evidence_and_result_is_nested(self):
        observation = {"scene": "Tripadvisor hotel results", "relevant_text": "Liverpool hotels",
                       "uncertainties": "Dates are partly obscured"}
        vision_result = {"observation": observation, "cost_credits": 0.0001,
                         "usage": {"prompt_tokens": 10, "completion_tokens": 20}}
        jev_result = {"activity": "planning_admin", "activity_probability": 0.8,
                      "activity_confidence": 0.7, "activity_probabilities": {},
                      "alignment": "focused", "alignment_probability": 0.9,
                      "alignment_confidence": 0.8, "alignment_probabilities": {},
                      "usage": {"input_tokens": 100, "output_tokens": 20}}
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "sample.png"
            path.write_bytes(b"\x89PNG\r\n\x1a\nsynthetic")
            with patch("vision.evaluate", return_value=vision_result), \
                    patch("vision.evaluate_jev", return_value=jev_result) as jev, \
                    redirect_stdout(io.StringIO()) as output:
                self.assertEqual(vision.process_image(path, vision.MODELS[0], "openrouter",
                                                       jev_key="typesafe", goal="Liverpool trip"), 0)
            row = json.loads(output.getvalue())
            self.assertEqual(row["observation"], observation)
            self.assertEqual(row["cost_credits"], 0.0001)
            self.assertEqual(row["jev"], jev_result)
            request = jev.call_args.args[0]
            self.assertEqual(request["state"]["evidence"], "screenshot_description")
            self.assertEqual(request["state"]["goal"], "Liverpool trip")
            self.assertEqual(request["state"]["current"]["visual"], observation)
            self.assertNotIn("app", request["state"]["current"])
            self.assertNotEqual(request["questions"], vision.QUESTIONS)

    def test_screenshot_payload_bounds_redacts_and_does_not_mutate_questions(self):
        original_questions = deepcopy(vision.QUESTIONS)
        observation = {
            "scene": "A" * 1000 + " https://private.example/path",
            "relevant_text": "jane@example.com /Users/ben/private " + "B" * 1000,
            "uncertainties": "token=super-secret " + "C" * 1000,
        }
        payload = vision.screenshot_payload(observation, "password=hidden " + "D" * 1000)
        visual = payload["state"]["current"]["visual"]
        self.assertLessEqual(len(visual["scene"]), 420)
        self.assertLessEqual(len(visual["relevant_text"]), 420)
        self.assertLessEqual(len(visual["uncertainties"]), 300)
        self.assertLessEqual(len(payload["state"]["goal"]), 240)
        for value in visual.values():
            self.assertNotIn("private.example", value)
            self.assertNotIn("jane@example.com", value)
            self.assertNotIn("super-secret", value)
        self.assertNotIn("hidden", payload["state"]["goal"])
        self.assertEqual(vision.QUESTIONS, original_questions)

    def test_invalid_vision_result_never_calls_jev(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "sample.png"
            path.write_bytes(b"\x89PNG\r\n\x1a\nsynthetic")
            with patch("vision.evaluate", return_value={"error": "invalid_or_truncated_observation",
                                                         "cost_credits": 0.0002}), \
                    patch("vision.evaluate_jev") as jev, \
                    redirect_stdout(io.StringIO()) as output:
                self.assertEqual(vision.process_image(path, vision.MODELS[0], "openrouter",
                                                       jev_key="typesafe", goal="Work"), 1)
            jev.assert_not_called()
            row = json.loads(output.getvalue())
            self.assertNotIn("jev", row)
            self.assertEqual(row["cost_credits"], 0.0002)

    def test_jev_failure_keeps_vision_result_and_fatal_watcher_status(self):
        observation = {"scene": "A game", "relevant_text": "Level 1", "uncertainties": "Small text"}
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "sample.png"
            path.write_bytes(b"\x89PNG\r\n\x1a\nsynthetic")
            with patch("vision.evaluate", return_value={"observation": observation,
                                                         "cost_credits": 0.0002}), \
                    patch("vision.evaluate_jev", side_effect=ValueError("http_402")), \
                    redirect_stdout(io.StringIO()) as output:
                self.assertEqual(vision.process_image(path, vision.MODELS[0], "openrouter",
                                                       jev_key="typesafe", goal="Work"), 2)
            row = json.loads(output.getvalue())
            self.assertEqual(row["observation"], observation)
            self.assertEqual(row["cost_credits"], 0.0002)
            self.assertEqual(row["jev_error"], "http_402")

    def test_goal_requires_jev(self):
        with patch("sys.argv", ["vision.py", "sample.png", "--goal", "Work"]), \
                self.assertRaises(SystemExit):
            vision.main()

    def test_http_errors_do_not_echo_provider_secrets_or_retry(self):
        with patch("vision.urllib.request.build_opener") as factory:
            factory.return_value.open.side_effect = urllib.error.HTTPError(
                vision.ENDPOINT, 401, "sensitive-provider-body", {}, None)
            with self.assertRaisesRegex(ValueError, "^http_401$"):
                vision.evaluate({}, "test-key")
            self.assertEqual(factory.return_value.open.call_count, 1)


if __name__ == "__main__":
    unittest.main()
