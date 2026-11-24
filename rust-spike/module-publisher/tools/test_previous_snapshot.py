"""Retry interrupted first publication without treating a lost public index as empty."""
from pathlib import Path
import importlib.util
import json
import subprocess
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location("previous_snapshot", Path(__file__).with_name("previous_snapshot.py"))

class PreviousSnapshot(unittest.TestCase):
    def fetch(self, draft, assets):
        module = importlib.util.module_from_spec(SPEC)
        SPEC.loader.exec_module(module)
        calls = []
        def run(args, **kwargs):
            calls.append(args)
            return subprocess.CompletedProcess(args, 0, json.dumps({"draft": draft, "assets": assets}), "")
        with tempfile.TemporaryDirectory() as folder:
            module.fetch("owner/repo", Path(folder)/"previous", run)
        return calls

    def test_draft_without_snapshot_is_retryable(self):
        self.assertEqual(len(self.fetch(True, [])), 1)

    def test_public_release_without_snapshot_refuses_history_reset(self):
        with self.assertRaisesRegex(SystemExit, "missing.*history", msg="Expected refusal: lost public history"):
            self.fetch(False, [])

if __name__ == "__main__":
    unittest.main()
