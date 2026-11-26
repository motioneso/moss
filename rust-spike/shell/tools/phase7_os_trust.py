#!/usr/bin/env python3
"""Prove OS trust with a disposable CA; restore trust settings and any mutation on exit.

Linux uses SSL_CERT_FILE/SSL_CERT_DIR (the platform loader's process-local root store).
macOS uses a temporary user keychain and user trust setting. Windows uses CurrentUser\\Root.
Never runs a database, changes the machine-wide root store, or installs a tool.
"""
import argparse
import contextlib
import hashlib
import os
from pathlib import Path
import shlex
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[3]


def run(args, **kwargs):
    return subprocess.run([str(a) for a in args], check=True, **kwargs)


def certificate(folder, name, *, ca=None, san="IP:127.0.0.1,DNS:localhost", days="2"):
    key, pem = folder / f"{name}.key", folder / f"{name}.pem"
    csr = folder / f"{name}.csr"
    run(["openssl", "req", "-new", "-newkey", "rsa:2048", "-nodes", "-keyout", key,
         "-out", csr, "-subj", f"/CN={name}"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    ext = folder / f"{name}.ext"
    ext.write_text("basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=" + san + "\n")
    args = ["openssl", "x509", "-req", "-in", csr, "-out", pem, "-days", days,
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
def trusted_ca(folder, env):
    ca = folder / "ca.pem"
    if sys.platform == "darwin":
        keychain = folder / "fixture.keychain-db"
        previous = shlex.split(subprocess.check_output(["security", "list-keychains", "-d", "user"], text=True))
        run(["security", "create-keychain", "-p", "", keychain])
        try:
            run(["security", "list-keychains", "-d", "user", "-s", *previous, keychain])
            run(["security", "add-trusted-cert", "-r", "trustRoot", "-k", keychain, ca])
            yield
        finally:
            try:
                run(["security", "remove-trusted-cert", ca])
            finally:
                try:
                    run(["security", "list-keychains", "-d", "user", "-s", *previous])
                finally:
                    run(["security", "delete-keychain", keychain])
    elif os.name == "nt":
        der = subprocess.check_output(["openssl", "x509", "-in", str(ca), "-outform", "DER"])
        thumbprint = hashlib.sha1(der).hexdigest()
        run(["certutil", "-user", "-addstore", "Root", ca])
        try:
            yield
        finally:
            run(["certutil", "-user", "-delstore", "Root", thumbprint])
    else:
        empty = folder / "empty-roots"
        empty.mkdir()
        env.update(SSL_CERT_FILE=str(ca), SSL_CERT_DIR=str(empty))
        yield


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--negative-control", action="store_true",
                        help="disable OS verification in the source temporarily; require the same runner to fail")
    args = parser.parse_args()
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
        certificate(folder, "expired", ca="ca", days="-1")
        certificate(folder, "untrusted", ca="unknown-ca")
        certificate(folder, "self-signed")
        certificate(folder, "changed-self-signed")
        env["MOSS_OS_TRUST_FIXTURES"] = str(folder)
        source = ROOT / "rust-spike/shell/connect/src/reach.rs"
        original = source.read_bytes()
        marker = "return platform.verify_server_cert(end_entity, intermediates, server_name, ocsp, now);"
        command = ["cargo", "+1.95.0", "test", "--locked", "--manifest-path", str(ROOT / "rust-spike/shell/Cargo.toml"),
                   "-p", "moss-app", "reach::phase7_os_trust::phase7_os_trust", "--", "--ignored", "--exact", "--nocapture", "--test-threads=1"]
        try:
            if args.negative_control:
                text = original.decode()
                if text.count(marker) != 1:
                    raise RuntimeError("OS trust mutation marker must occur exactly once")
                source.write_text(text.replace(marker, 'return Err(rustls::Error::General("OS trust disabled by negative control".into()));'))
            with trusted_ca(folder, env):
                print("COMMAND:", shlex.join(command), flush=True)
                process = subprocess.Popen(command, env=env, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
                output = []
                for line in process.stdout:
                    output.append(line)
                    print(line, end="", flush=True)
                code = process.wait()
                output = "".join(output)
                print(f"CARGO_EXIT={code}", flush=True)
                if args.negative_control:
                    # A compile/tool failure does not count: the successful-connection assertion must fail.
                    if code == 0 or "OS-trusted CA connects WITHOUT a pin" not in output or "test result: FAILED" not in output:
                        raise RuntimeError("negative control did not fail at the public CA connection assertion")
                    print("PASS: disabled OS trust made the public-CA connection fail", flush=True)
                elif code:
                    return code
        finally:
            if args.negative_control:
                source.write_bytes(original)
    return 0


if __name__ == "__main__":
    sys.exit(main())
