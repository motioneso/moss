"""Offline checks: python3 -B -m unittest discover -s tools/jev-pilot -v."""

import argparse
from contextlib import redirect_stdout
from copy import deepcopy
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import urllib.error

import pilot


def response():
    answers = {}
    for name, options in (("activity", pilot.ACTIVITIES), ("alignment", pilot.ALIGNMENTS)):
        chosen = next(iter(options))
        answers[name] = {
            "type": "choice", "choice": chosen, "confidence": 0.8,
            "probabilities": {key: float(key == chosen) for key in options},
        }
    return {"model": "jev-latest", "answers": answers,
            "usage": {"input_tokens": 100, "output_tokens": 30}}


class PilotCheck(unittest.TestCase):
    def test_allowlist_and_permission_fail_closed(self):
        raw = {"status": "ok", "bundle_id": "example.editor", "app": "Editor", "title": "Private"}
        self.assertIsNone(pilot.observation(raw, {"another.app"}, True))
        self.assertEqual(pilot.observation(raw, {"example.editor"}, False)["title"], "")
        raw["status"] = "permission_denied"
        self.assertIsNone(pilot.observation(raw, {"example.editor"}, True))

    def test_minimize_observation_before_network(self):
        text = "Title https://example.com/private?token=secret me@example.com /Users/person/file token=abc " + "x" * 30
        cleaned = pilot.clean(text)
        for secret in ("example.com", "person", "abc", "x" * 30):
            self.assertNotIn(secret, cleaned)
        self.assertEqual(len(pilot.clean("a" * 10 + " " + "b " * 200)), 120)
        self.assertNotIn("\x1b", pilot.clean("Title\x1b[0m"))

    def test_request_has_documented_choice_contract(self):
        request = pilot.payload({"app": "Editor", "title": "Estimate"}, "Write estimate", [], 15)
        self.assertEqual(set(request), {"model", "state", "questions"})
        self.assertEqual(request["questions"]["alignment"]["type"], "choice")
        self.assertEqual(set(request["questions"]["alignment"]["criteria"]), set(pilot.ALIGNMENTS))

    def test_response_without_goal_abstains(self):
        result = pilot.parse_answers(response(), False)
        self.assertEqual(result["activity"], "research_reading")
        self.assertEqual(result["alignment"], "insufficient_evidence")
        self.assertIsNone(result["alignment_probability"])

    def test_malformed_responses_are_rejected(self):
        for bad in (None, [], {}, {"answers": []}):
            with self.assertRaises(ValueError):
                pilot.parse_answers(bad, True)
        for field, value in (("choice", "execute_shell"), ("choice", []),
                             ("confidence", float("nan")), ("confidence", True),
                             ("probabilities", {}), ("type", "noul")):
            bad = deepcopy(response())
            bad["answers"]["activity"][field] = value
            with self.assertRaises(ValueError):
                pilot.parse_answers(bad, True)
        bad = response()
        bad["answers"]["activity"]["probabilities"]["coding"] = 0.5
        with self.assertRaises(ValueError):
            pilot.parse_answers(bad, True)

    def test_http_body_and_headers_are_not_reported(self):
        request = pilot.payload({"app": "Editor", "title": ""}, "", [], 0)
        with patch("urllib.request.build_opener") as factory:
            factory.return_value.open.side_effect = urllib.error.HTTPError(
                pilot.ENDPOINT, 401, "sensitive-provider-body", {}, None)
            with self.assertRaisesRegex(ValueError, "^http_401$"):
                pilot.evaluate(request, "test-secret")
        self.assertIsNone(pilot.NoRedirect().redirect_request(None, None, 302, "", {}, "https://other.invalid"))

    def test_real_request_serialization_with_mock_transport(self):
        request = pilot.payload({"app": "Editor", "title": ""}, "", [], 0)
        with patch("urllib.request.build_opener") as factory:
            factory.return_value.open.return_value.__enter__.return_value.read.return_value = json.dumps(response()).encode()
            result = pilot.evaluate(request, "test-key")
            sent = factory.return_value.open.call_args.args[0]
        self.assertEqual(sent.full_url, pilot.ENDPOINT)
        self.assertEqual(json.loads(sent.data), request)
        self.assertEqual(result["usage"]["input_tokens"], 100)

    def test_preview_never_calls_network(self):
        with patch("pilot.evaluate") as evaluate, redirect_stdout(io.StringIO()) as output:
            pilot.main(["--demo", "--titles", "--goal", "Write estimate"])
        evaluate.assert_not_called()
        self.assertIn("PREVIEW ONLY", output.getvalue())
        request = json.loads(output.getvalue().splitlines()[-1])
        self.assertEqual(request["state"]["current"]["title"], "Project estimate")

    def test_stale_result_dropped_and_budget_still_enforced(self):
        args = argparse.Namespace(minutes=1, demo=False, allow={"example.editor"}, titles=True,
                                  once=False, interval=60, live=True, goal="Write", max_calls=1)
        raw = {"status": "ok", "app": "Editor", "bundle_id": "example.editor", "title": "Estimate"}
        log = io.StringIO()
        # The app changes between request and response; even a dropped call spends budget.
        with patch("pilot.capture", side_effect=[raw, {"status": "excluded"}]), \
                patch("pilot.time.monotonic", side_effect=[0, 0, 0, 10, 10]), \
                patch("pilot.time.sleep"), patch("pilot.evaluate", return_value={"activity": "coding"}), \
                redirect_stdout(io.StringIO()) as output:
            args.once = True  # Immediate classification keeps the test independent of timer tuning.
            pilot.run(args, Path("unused"), "test-key", log)
        self.assertEqual(log.getvalue(), "")
        self.assertIn("Dropped stale result", output.getvalue())
        self.assertIn("Session call budget reached", output.getvalue())

    def test_saved_summary_labels_samples_not_time(self):
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / "session.jsonl"
            file.write_text(json.dumps({"activity": "coding", "alignment": "focused"}) + "\n")
            with redirect_stdout(io.StringIO()) as output:
                pilot.summary(file)
        self.assertIn('"coding": 1', output.getvalue())
        self.assertIn("not measured time", output.getvalue())


if __name__ == "__main__":
    unittest.main()
