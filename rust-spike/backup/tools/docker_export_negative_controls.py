#!/usr/bin/env python3
"""Remove each protection in source, rebuild singly, observe the real runner fail, restore.

No bypass switch is shipped in the exporter. These controls use generated throwaway data only.
"""
import argparse
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from phase7_docker_export import REPO, build

SOURCE = REPO / "rust-spike/backup/src/docker.rs"
RUNNER = REPO / "rust-spike/backup/tools/phase7_docker_export.py"


def control(original, name):
    if name == "no-restart-fence":
        start = original.index("        // Change ALL policies")
        end = original.index("        for info in &inventory[..", start)
        modified = original[:start] + original[end:]
        modified = modified.replace('if !stopped(&Docker.inspect(id(info))?) {',
                                    'if Docker.inspect(id(info))?["State"]["Running"] != false {')
        modified = modified.replace("        check_fence(&receipt)?;\n", "")
        assert modified != original and "turn off a source container restart policy" not in modified
        return modified, "reboot-condition replay leaves old app and worker stopped with persisted restart=no"
    anchor = "        show_words(&recovery)?;\n"
    if name == "diagnostics":
        assert original.count(anchor) == 1
        return original.replace(anchor, '        println!("{} {}", credentials, recovery.words().join(" "));\n' + anchor), "export diagnostics contain no generated credential"
    assert original.count(anchor) == 1
    return original.replace(anchor,
                            '        out.write_all(credentials.to_string().as_bytes()).unwrap();\n'
                            '        out.flush().unwrap();\n' + anchor), "byte search finds no plaintext credential or recovery words in the archive"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--only", choices=["no-restart-fence", "plaintext", "diagnostics"])
    args = parser.parse_args()
    original = SOURCE.read_text()
    runner_original = RUNNER.read_text()
    try:
        for name in ([args.only] if args.only else ["no-restart-fence", "plaintext", "diagnostics"]):
            modified, assertion = control(original, name)
            SOURCE.write_text(modified)
            # With the policy change removed, its deliberate command-failure probe cannot
            # trigger. Skip that probe only in the temporary mutated runner, so the independent
            # reboot assertion observes the missing protection instead of an earlier refusal.
            runner = runner_original
            if name == "no-restart-fence":
                start = runner.index("        for operation, reason in [")
                end = runner.index("            shim.write_text", start)
                runner = runner[:start] + "        for operation, reason in []:\n" + runner[end:]
            RUNNER.write_text(runner)
            build()
            result = subprocess.run([sys.executable, str(RUNNER), "--no-build"], capture_output=True, text=True)
            # Runner output includes assertion names only. Never echo raw build/application output.
            if result.returncode != 1 or f"FAIL: {assertion}" not in result.stderr:
                raise AssertionError(f"{name} did not fail its intended assertion (exit {result.returncode})")
            print(f"negative control {name}: runner exit {result.returncode}; observed FAIL: {assertion}", flush=True)
            SOURCE.write_text(original)
            RUNNER.write_text(runner_original)
    finally:
        SOURCE.write_text(original)
        RUNNER.write_text(runner_original)
        build()
    print("Docker exporter negative controls: PASS; production protections restored", flush=True)


if __name__ == "__main__":
    main()
