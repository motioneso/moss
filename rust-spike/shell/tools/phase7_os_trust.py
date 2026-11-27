#!/usr/bin/env python3
"""Prove OS trust with a disposable CA; revoke test trust and restore any mutation on exit.

Linux uses SSL_CERT_FILE/SSL_CERT_DIR (the platform loader's process-local root store).
macOS uses a temporary user keychain (CI may opt into administrator trust settings to avoid
GUI authorization). Windows uses CurrentUser\\Root locally and LocalMachine\\Root on disposable CI
(to avoid its root-enrollment consent dialog). Never runs a database or installs a tool.
"""
import argparse
import contextlib
import hashlib
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[3]


def run(args, **kwargs):
    return subprocess.run([str(a) for a in args], check=True, timeout=120, **kwargs)


def certificate(folder, name, *, ca=None, san="IP:127.0.0.1,DNS:localhost", expired=False):
    key, pem = folder / f"{name}.key", folder / f"{name}.pem"
    csr = folder / f"{name}.csr"
    run(["openssl", "req", "-new", "-newkey", "rsa:2048", "-nodes", "-keyout", key,
         "-out", csr, "-subj", f"/CN={name}"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    ext = folder / f"{name}.ext"
    ext.write_text("basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=" + san + "\n")
    if expired:
        # New OpenSSL releases refuse negative -days. Use explicit historical dates instead.
        index, serial = folder / "index", folder / "serial"
        index.write_text("")
        serial.write_text("1000\n")
        config = folder / "ca.conf"
        values = {"database": index, "serial": serial, "new_certs_dir": folder,
                  "certificate": folder / f"{ca}.pem", "private_key": folder / f"{ca}.key"}
        config.write_text("[ca]\ndefault_ca=issuer\n[issuer]\n" +
                          "".join(f'{k}="{v.as_posix()}"\n' for k, v in values.items()) +
                          "default_md=sha256\ndefault_days=2\npolicy=subject\n[subject]\ncommonName=supplied\n")
        run(["openssl", "ca", "-batch", "-notext", "-config", config, "-in", csr,
             "-out", pem, "-extfile", ext, "-startdate", "20200101000000Z", "-enddate", "20200102000000Z"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        return
    args = ["openssl", "x509", "-req", "-in", csr, "-out", pem, "-days", "2",
            "-extfile", ext, "-sha256"]
    args += ["-CA", folder / f"{ca}.pem", "-CAkey", folder / f"{ca}.key", "-CAcreateserial"] if ca else ["-signkey", key]
    run(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def ca_certificate(folder, name):
    run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2",
         "-keyout", folder / f"{name}.key", "-out", folder / f"{name}.pem",
         "-subj", f"/CN=Moss disposable OS trust {name}",
         "-addext", "basicConstraints=critical,CA:TRUE",
         "-addext", "keyUsage=critical,keyCertSign,cRLSign"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


@contextlib.contextmanager
def trusted_ca(folder, env, ci_system_trust=False):
    ca = folder / "ca.pem"
    if sys.platform == "darwin":
        keychain = folder / "fixture.keychain-db"
        previous = shlex.split(subprocess.check_output(["security", "list-keychains", "-d", "user"], text=True))
        security = ["sudo", "-n", "security"] if ci_system_trust else ["security"]
        domain = ["-d"] if ci_system_trust else []
        run(["security", "create-keychain", "-p", "", keychain])
        try:
            run(["security", "list-keychains", "-d", "user", "-s", *previous, keychain])
            run([*security, "add-trusted-cert", *domain, "-r", "trustRoot", "-k", keychain, ca])
            yield
        finally:
            try:
                if ci_system_trust:
                    # Removing the final admin entry requires interactive authorization on macOS.
                    # A deny entry revokes this root without that prompt; only deny metadata remains
                    # on the disposable runner after its temporary keychain is deleted.
                    run([*security, "add-trusted-cert", *domain, "-r", "deny", "-k", keychain, ca])
                else:
                    run([*security, "remove-trusted-cert", *domain, ca])
            finally:
                try:
                    run(["security", "list-keychains", "-d", "user", "-s", *previous])
                finally:
                    run(["security", "delete-keychain", keychain])
    elif os.name == "nt":
        der = subprocess.check_output(["openssl", "x509", "-in", str(ca), "-outform", "DER"])
        thumbprint = hashlib.sha1(der).hexdigest()
        domain = [] if ci_system_trust else ["-user"]
        try:
            run(["certutil", *domain, "-f", "-addstore", "Root", ca])
            yield
        finally:
            run(["certutil", *domain, "-delstore", "Root", thumbprint])
    else:
        empty = folder / "empty-roots"
        empty.mkdir()
        previous = {key: env.get(key) for key in ("SSL_CERT_FILE", "SSL_CERT_DIR")}
        env.update(SSL_CERT_FILE=str(ca), SSL_CERT_DIR=str(empty))
        try:
            yield
        finally:
            for key, value in previous.items():
                if value is None:
                    env.pop(key, None)
                else:
                    env[key] = value


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    controls = parser.add_mutually_exclusive_group()
    controls.add_argument("--negative-control", action="store_true",
                        help="disable OS verification in the source temporarily; require the same runner to fail")
    controls.add_argument("--negative-accept-invalid", action="store_true",
                          help="bypass OS validation temporarily; require the invalid-certificate assertion to fail")
    parser.add_argument("--ci-system-trust", action="store_true",
                        help="on disposable native CI only, enroll the test root without a GUI consent prompt")
    args = parser.parse_args()
    if args.ci_system_trust and (sys.platform not in ("darwin", "win32") or os.environ.get("GITHUB_ACTIONS") != "true"):
        parser.error("--ci-system-trust is only for disposable macOS/Windows GitHub Actions runners")
    mutation = args.negative_control or args.negative_accept_invalid
    env = os.environ.copy()
    if not env.get("RUSTUP_HOME") or not env.get("CARGO_TARGET_DIR"):
        parser.error("set RUSTUP_HOME and an isolated CARGO_TARGET_DIR explicitly")
    env.update(CARGO_BUILD_JOBS="1", CARGO_PROFILE_DEV_DEBUG="0", CARGO_PROFILE_TEST_DEBUG="0", CARGO_INCREMENTAL="0")
    with tempfile.TemporaryDirectory(prefix="moss-phase7-os-trust-") as temp:
        folder = Path(temp)
        ca_certificate(folder, "ca")
        ca_certificate(folder, "unknown-ca")
        for name in ["valid", "renewed"]:
            certificate(folder, name, ca="ca")
        certificate(folder, "wrong-host", ca="ca", san="DNS:other.invalid")
        certificate(folder, "expired", ca="ca", expired=True)
        certificate(folder, "untrusted", ca="unknown-ca")
        certificate(folder, "self-signed")
        certificate(folder, "changed-self-signed")
        env["MOSS_OS_TRUST_FIXTURES"] = str(folder)
        source = ROOT / "rust-spike/shell/connect/src/reach.rs"
        original = source.read_bytes()
        marker = "return platform.verify_server_cert(end_entity, intermediates, server_name, ocsp, now);"
        build_command = ["cargo", "+1.95.0", "test", "--locked", "--manifest-path", str(ROOT / "rust-spike/shell/Cargo.toml"),
                         "-p", "moss-app", "--no-run", "--message-format=json"]
        try:
            if mutation:
                text = original.decode()
                if text.count(marker) != 1:
                    raise RuntimeError("OS trust mutation marker must occur exactly once")
                replacement = ('return Err(rustls::Error::General("OS trust disabled by negative control".into()));'
                               if args.negative_control else 'return Ok(ServerCertVerified::assertion());')
                source.write_bytes(text.replace(marker, replacement).encode())
            # Build before enrolling the test CA. Cargo downloads must use normal system trust,
            # while only the test executable gets the process-local Linux fixture root store.
            print("BUILD_COMMAND:", shlex.join(build_command), flush=True)
            build = subprocess.run(build_command, env=env, text=True, stdout=subprocess.PIPE)
            executable = None
            for line in build.stdout.splitlines():
                event = json.loads(line)
                if event.get("reason") == "compiler-message":
                    print(event["message"].get("rendered", ""), end="", flush=True)
                if (event.get("reason") == "compiler-artifact" and event["target"]["name"] == "moss-app"
                        and event["profile"]["test"] and event.get("executable")):
                    executable = event["executable"]
            print(f"BUILD_EXIT={build.returncode}", flush=True)
            if build.returncode:
                return build.returncode
            if not executable:
                raise RuntimeError("Cargo did not report the moss-app test executable")
            command = [executable, "reach::phase7_os_trust::phase7_os_trust", "--ignored", "--exact", "--nocapture", "--test-threads=1"]
            with trusted_ca(folder, env, args.ci_system_trust):
                print("TEST_COMMAND:", shlex.join(command), flush=True)
                process = subprocess.Popen(command, env=env, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
                output = []
                for line in process.stdout:
                    output.append(line)
                    print(line, end="", flush=True)
                code = process.wait()
                output = "".join(output)
                print(f"TEST_EXIT={code}", flush=True)
                if args.negative_control:
                    # A compile/tool failure does not count: the successful-connection assertion must fail.
                    if code == 0 or "OS-trusted CA connects WITHOUT a pin" not in output or "test result: FAILED" not in output:
                        raise RuntimeError("negative control did not fail at the public CA connection assertion")
                    print("PASS: disabled OS trust made the public-CA connection fail", flush=True)
                elif args.negative_accept_invalid:
                    if code == 0 or "invalid wrong-host certificate selected OS trust" not in output or "test result: FAILED" not in output:
                        raise RuntimeError("bypass control did not fail at the invalid-certificate assertion")
                    print("PASS: bypassing OS validation made the invalid-certificate assertion fail", flush=True)
                elif code:
                    return code
            if not mutation:
                cleanup_command = [executable, "reach::phase7_os_trust::phase7_os_trust_after_cleanup",
                                   "--ignored", "--exact", "--nocapture", "--test-threads=1"]
                print("CLEANUP_COMMAND:", shlex.join(cleanup_command), flush=True)
                cleanup = subprocess.run(cleanup_command, env=env)
                print(f"CLEANUP_EXIT={cleanup.returncode}", flush=True)
                if cleanup.returncode:
                    return cleanup.returncode
        finally:
            if mutation:
                source.write_bytes(original)
    return 0


if __name__ == "__main__":
    sys.exit(main())
