"""Offline Clef-probe checks; no real images or credentials leave this process."""

import io
import json
from pathlib import Path
import tempfile
import unittest
import unittest.mock
from unittest.mock import patch
import urllib.error

import clef_probe

PNG = b"\x89PNG\r\n\x1a\n" + b"\0" * 16


class FakeResponse(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class ClefProbeCheck(unittest.TestCase):
    def test_image_url_sniffs_type_and_refuses_others(self):
        with tempfile.TemporaryDirectory() as directory:
            png = Path(directory) / "a.png"
            png.write_bytes(PNG)
            self.assertTrue(clef_probe.image_url(png).startswith("data:image/png;base64,"))
            gif = Path(directory) / "a.gif"
            gif.write_bytes(b"GIF89a")
            with self.assertRaises(ValueError):
                clef_probe.image_url(gif)

    def test_image_over_4_mib_is_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            big = Path(directory) / "big.png"
            big.write_bytes(PNG + b"\0" * clef_probe.PER_IMAGE)
            with self.assertRaisesRegex(ValueError, "image_over_4_MiB"):
                clef_probe.image_url(big)

    def test_body_keeps_jev_shape_with_images_and_both_questions(self):
        body = clef_probe.clef_body("clef-flash", "Write the report", ["data:image/png;base64,AA=="])
        self.assertEqual(set(body), {"model", "images", "state", "questions"})
        self.assertEqual(set(body["questions"]), {"activity", "alignment"})
        self.assertIn("attached screenshot", body["questions"]["activity"]["instructions"])
        self.assertEqual(body["state"]["goal"], "Write the report")

    def test_call_unwraps_cloudflare_envelope(self):
        reply = {"result": {"model": "clef", "answers": {"a": {"type": "noul", "noul": 0.9}},
                            "usage": {"input_tokens": 3}}, "success": True, "errors": []}
        opener = unittest.mock.Mock()
        opener.open.return_value = FakeResponse(json.dumps(reply).encode())
        with patch("urllib.request.build_opener", return_value=opener):
            result, _ = clef_probe.call_clef({"model": "clef"}, "a" * 32, "t")
        self.assertEqual(result["answers"]["a"]["noul"], 0.9)
        request = opener.open.call_args.args[0]
        self.assertTrue(request.full_url.endswith("/accounts/" + "a" * 32 + "/ai/run/@cf/cloudflare/clef"))

    def test_call_reports_unsuccessful_envelope_and_http_errors(self):
        opener = unittest.mock.Mock()
        opener.open.return_value = FakeResponse(json.dumps({"success": False}).encode())
        with patch("urllib.request.build_opener", return_value=opener):
            with self.assertRaisesRegex(ValueError, "unexpected_envelope"):
                clef_probe.call_clef({"model": "clef"}, "a" * 32, "t")
        body = io.BytesIO(json.dumps({"errors": [{"code": 10000}]}).encode())
        opener.open.side_effect = urllib.error.HTTPError("u", 401, "no", {}, body)
        with patch("urllib.request.build_opener", return_value=opener):
            with self.assertRaisesRegex(ValueError, "http_401"):
                clef_probe.call_clef({"model": "clef"}, "a" * 32, "t")

    def test_summary_ranks_top_two(self):
        answers = {"activity": {"probabilities": {"coding": 0.1, "shopping": 0.85, "other": 0.05}}}
        self.assertEqual(clef_probe.summarize(answers), {"activity": "shopping 0.85 > coding 0.10"})


if __name__ == "__main__":
    unittest.main()
