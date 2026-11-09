"""Packaging boundary tests. These fixtures are not native app or DB startup proof."""
import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

from linux_runtime import dependencies, stage_runtime
from uninstall import uninstall


def load_stage():
    spec = importlib.util.spec_from_file_location("stage_install", Path(__file__).with_name("stage-install.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.stage


class InstallTests(unittest.TestCase):
    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory(prefix="moss-package-")
        self.addCleanup(self.scratch.cleanup)
        self.root = Path(self.scratch.name)
        self.install = self.root / "install with spaces"
        self.install.mkdir()

    def inventory(self, names):
        files = {name: hashlib.sha256((self.install / name).read_bytes()).hexdigest() for name in names}
        (self.install / "install-manifest.json").write_text(json.dumps({"format": 1, "files": files}))

    def test_uninstall_retains_instances_inside_and_outside_install(self):
        for folder in (self.install / "servers/default", self.root / "data/servers/default"):
            folder.mkdir(parents=True)
            (folder / "keep").write_bytes(b"user instance")
        (self.install / "moss-shell").write_bytes(b"program")
        (self.install / "web").mkdir()
        (self.install / "web/index.html").write_bytes(b"page")
        (self.install / "web/user-note").write_bytes(b"keep this too")
        self.inventory(["moss-shell", "web/index.html"])
        self.assertEqual(len(uninstall(self.install)), 2)
        for file in (self.install / "servers/default/keep", self.root / "data/servers/default/keep"):
            self.assertEqual(file.read_bytes(), b"user instance")
        self.assertEqual((self.install / "web/user-note").read_bytes(), b"keep this too")
        self.assertFalse((self.install / "moss-shell").exists())

    def test_changed_file_refuses_before_removing_anything(self):
        for name in ("moss-shell", "moss-db"):
            (self.install / name).write_bytes(b"program")
        self.inventory(["moss-shell", "moss-db"])
        (self.install / "moss-db").write_bytes(b"changed")
        with self.assertRaisesRegex(ValueError, "changed"):
            uninstall(self.install)
        self.assertTrue((self.install / "moss-shell").exists())

    def test_redirected_directory_refuses_without_touching_target(self):
        (self.install / "web").mkdir()
        (self.install / "web/index.html").write_bytes(b"page")
        self.inventory(["web/index.html"])
        (self.install / "web").rename(self.root / "saved-web")
        (self.install / "web").symlink_to(self.root / "saved-web", target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "symbolic link"):
            uninstall(self.install)
        self.assertEqual((self.root / "saved-web/index.html").read_bytes(), b"page")

    def test_manifest_cannot_inventory_instance_or_parent_paths(self):
        for name in ("servers/default/keep", "../keep", "/tmp/keep"):
            (self.install / "install-manifest.json").write_text(json.dumps({"format": 1, "files": {name: ""}}))
            with self.assertRaisesRegex(ValueError, "outside"):
                uninstall(self.install)

    def test_running_real_executable_refuses(self):
        shutil.copy2("/bin/sleep", self.install / "moss-shell")
        self.inventory(["moss-shell"])
        process = subprocess.Popen([str(self.install / "moss-shell"), "30"])
        try:
            with self.assertRaisesRegex(ValueError, "Quit Moss"):
                uninstall(self.install)
        finally:
            process.terminate()
            process.wait(timeout=5)
        uninstall(self.install)
        self.assertFalse(self.install.exists())

    def test_stage_rejects_escaping_postgres_link_atomically(self):
        dist = self.root / "dist"
        pg = self.root / "pg"
        for name in ("moss-app", "moss-shell", "moss-db"):
            dist.mkdir(exist_ok=True)
            shutil.copy2("/bin/true", dist / name)
        (dist / "web").mkdir()
        (dist / "web/index.html").write_text("page")
        for name in ("bin/postgres", "bin/initdb", "bin/pg_ctl", "share/postgresql/extension/vector.control", "lib/postgresql/vector.so", "lib/postgresql/moss_nodump.so"):
            file = pg / name
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_text("fixture")
        (pg / "escape").symlink_to(dist / "moss-db")
        target = self.root / "new-stage"
        with self.assertRaisesRegex(ValueError, "link outside"):
            load_stage()(dist, pg, target)
        self.assertFalse(target.exists())
        self.assertEqual(list(self.root.glob(".moss-stage-*")), [])

    def test_runtime_executes_real_openssl_with_its_configuration(self):
        for name in ("moss-shell", "moss-db"):
            shutil.copy2("/bin/true", self.install / name)
        (self.install / "postgres").mkdir()
        stage_runtime(self.install, Path("/usr/bin/openssl"), Path("/etc/ssl/certs/ca-certificates.crt"))
        result = subprocess.run([str(self.install / "moss-run"), "openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=Moss test", "-days", "1", "-keyout", str(self.root / "key.pem"), "-out", str(self.root / "cert.pem")], capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(b"BEGIN CERTIFICATE", (self.root / "cert.pem").read_bytes())
        self.assertTrue((self.install / "runtime/lib/libcrypto.so.3").exists())

    def test_missing_library_is_not_a_successful_closure(self):
        source = self.root / "probe.c"
        source.write_text("int probe(void) { return 0; }")
        library = self.root / "libmissing_moss.so"
        subprocess.run(["cc", "-shared", "-fPIC", str(source), "-o", str(library)], check=True)
        source.write_text("extern int probe(void); int main(void) { return probe(); }")
        program = self.root / "probe"
        subprocess.run(["cc", str(source), "-L" + str(self.root), "-lmissing_moss", "-Wl,-rpath," + str(self.root), "-o", str(program)], check=True)
        self.assertIn(library, dependencies(program))
        library.unlink()
        with self.assertRaisesRegex(ValueError, "Unresolved"):
            dependencies(program)

    def test_postgres_style_plugin_finds_its_bundled_library(self):
        source = self.root / "plugin.c"
        source.write_text("int probe(void) { return 0; }")
        library = self.root / "libmoss_package_probe.so"
        subprocess.run(["cc", "-shared", "-fPIC", str(source), "-o", str(library)], check=True)
        source.write_text("extern int probe(void); int main(void) { return probe(); }")
        program = self.root / "probe"
        subprocess.run(["cc", str(source), "-L" + str(self.root), "-lmoss_package_probe", "-o", str(program)], check=True)
        with self.assertRaisesRegex(ValueError, "Unresolved"):
            dependencies(program)
        self.assertIn(library, dependencies(program, self.root))


if __name__ == "__main__":
    unittest.main()
