"""Publication is tested with a recording transport, never a GitHub write."""
import importlib.util
from pathlib import Path
import tempfile
import os
import subprocess
import sys
import unittest

SPEC = importlib.util.spec_from_file_location("release_transport", Path(__file__).with_name("release_transport.py"))

class Publication(unittest.TestCase):
    def test_non_dispatch_cannot_publish(self):
        with tempfile.TemporaryDirectory() as folder:
            (Path(folder)/"packages").mkdir()
            result=subprocess.run([sys.executable,str(Path(__file__).with_name("release_transport.py")),folder,"owner/repo","42"],capture_output=True,text=True,env=os.environ|{"GITHUB_EVENT_NAME":"pull_request","PATH":""})
            self.assertNotEqual(result.returncode,0)
            self.assertIn("manual dispatch",result.stderr,"Expected refusal: publication outside manual dispatch")

    def test_compiled_installer_is_uploaded_before_snapshot(self):
        module = importlib.util.module_from_spec(SPEC)
        SPEC.loader.exec_module(module)
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder) / "registry"
            (root / "packages").mkdir(parents=True)
            binary = Path(folder) / "moss-bundle-bootstrap"
            binary.write_bytes(b"compiled installer")
            calls = []
            module.publish(root, "owner/repo", "42", calls.append, bootstrap=binary)
            self.assertIn("bootstrap-linux-", Path(calls[0][3]).name)
            self.assertEqual(Path(calls[-1][3]).name, "registry.zip")

    def test_failed_package_upload_never_replaces_snapshot(self):
        module = importlib.util.module_from_spec(SPEC)
        SPEC.loader.exec_module(module)
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / "packages").mkdir()
            (root / "packages" / ("a" * 64 + ".mosspkg")).write_bytes(b"package")
            calls = []
            def fail(args):
                calls.append(args)
                raise RuntimeError("upload failed")
            with self.assertRaisesRegex(RuntimeError, "upload failed"):
                module.publish(root, "owner/repo", "42", fail)
            self.assertEqual(len(calls), 1)
            self.assertNotIn("registry.zip", calls[0][3])

    def test_resume_skips_previously_uploaded_immutable_assets(self):
        module = importlib.util.module_from_spec(SPEC)
        SPEC.loader.exec_module(module)
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / "packages").mkdir()
            name = "a" * 64 + ".mosspkg"
            (root / "packages" / name).write_bytes(b"package")
            calls = []
            module.publish(root, "owner/repo", "42", calls.append, existing_names=[name])
            self.assertEqual(len(calls), 1)
            self.assertEqual(Path(calls[0][3]).name, "registry.zip")

    def test_packages_precede_single_snapshot_swap(self):
        module = importlib.util.module_from_spec(SPEC)
        SPEC.loader.exec_module(module)
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / "packages").mkdir()
            (root / "packages" / ("a" * 64 + ".mosspkg")).write_bytes(b"package")
            (root / "packages" / ("a" * 64 + ".mosspkg.sig")).write_bytes(b"signature")
            for name in ("registry.json", "registry.json.sig", "index.json", "index.json.sig", "bundle.json", "bundle.json.sig"):
                (root / name).write_bytes(b"metadata")
            calls = []
            module.publish(root, "owner/repo", "42", lambda args: calls.append(args))
            self.assertTrue(all("rust-modules" in c for c in calls))
            uploads = [c for c in calls if c[:2] == ["release", "upload"]]
            self.assertIn(".mosspkg", str(uploads[0]))
            self.assertEqual(Path(uploads[-1][3]).name, "registry.zip")
            self.assertIn("--clobber", uploads[-1])
            self.assertFalse(any("--clobber" in c for c in uploads[:-1]))

if __name__ == "__main__":
    unittest.main()
