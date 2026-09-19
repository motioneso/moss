"""Offline screenshot-probe checks; no real images or credentials leave this process."""

from contextlib import redirect_stdout
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import urllib.error

import vision


class VisionCheck(unittest.TestCase):
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

    def test_http_errors_do_not_echo_provider_secrets_or_retry(self):
        with patch("vision.urllib.request.build_opener") as factory:
            factory.return_value.open.side_effect = urllib.error.HTTPError(
                vision.ENDPOINT, 401, "sensitive-provider-body", {}, None)
            with self.assertRaisesRegex(ValueError, "^http_401$"):
                vision.evaluate({}, "test-key")
            self.assertEqual(factory.return_value.open.call_count, 1)


if __name__ == "__main__":
    unittest.main()
