"""Build all declared Rust first-party packages, sequentially, using existing packers."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tomllib

ROOT = Path(__file__).resolve().parents[3]
TARGET = Path(os.environ["CARGO_TARGET_DIR"]).resolve()
OUT = Path(sys.argv[1]).resolve()
if not os.environ.get("RUSTUP_HOME"):
    raise SystemExit("Set RUSTUP_HOME explicitly")
SYSROOT = Path(subprocess.check_output(["rustc", "+1.95.0", "--print", "sysroot"], text=True).strip())
for required in ("wasm32-unknown-unknown", "wasm32-wasip2"):
    if not (SYSROOT / "lib/rustlib" / required / "lib").is_dir():
        raise SystemExit(f"Missing {required} standard library in the declared Rust 1.95.0 toolchain")
OUT.mkdir(parents=True, exist_ok=False)
BASE = os.environ.copy()
BASE.update(CARGO_BUILD_JOBS="2", CARGO_PROFILE_DEV_DEBUG="0", CARGO_PROFILE_TEST_DEBUG="0",
            CARGO_PROFILE_RELEASE_DEBUG="0", CARGO_INCREMENTAL="0")

# RUSTC_WRAPPER is not part of Cargo's output fingerprint. Isolate its cache by
# source digest so introducing/changing it cannot reuse old, path-dependent crates.
wrapper_source = ROOT / "rust-spike/module-publisher/tools/repro-rustc.rs"
wrapper_digest = hashlib.sha256(wrapper_source.read_bytes()).hexdigest()[:16]
REPRO_TARGET = TARGET / f"repro-{wrapper_digest}"
REPRO_TARGET.mkdir(parents=True, exist_ok=True)
wrapper = REPRO_TARGET / ("repro-rustc.exe" if os.name == "nt" else "repro-rustc")
subprocess.run(["rustc", "+1.95.0", "--edition=2021", "-Cdebuginfo=0",
                str(wrapper_source), "-o", str(wrapper)], env=BASE, check=True)

def cargo(manifest, args, target=TARGET, flags=None, extra=None):
    env = BASE | {"CARGO_TARGET_DIR": str(target)} | (extra or {})
    if flags:
        env["RUSTC_WRAPPER"] = str(wrapper)
        remaps = [f"--remap-path-prefix={source}={dest}" for source, dest in (
            (ROOT, "/moss/source"), (Path(env.get("CARGO_HOME", Path.home() / ".cargo")), "/moss/cargo"),
            (SYSROOT, "/moss/rust"), (target, "/moss/target"))]
        env["CARGO_ENCODED_RUSTFLAGS"] = "\x1f".join([*remaps, *flags])
    subprocess.run(["cargo", "+1.95.0", *args[:1], "--locked", "--manifest-path", str(manifest), *args[1:]],
                   cwd=ROOT, env=env, check=True)

def crate_name(manifest):
    return tomllib.loads(manifest.read_text())["package"]["name"].replace("-", "_")

def ui(module):
    source = ROOT / "modules" / module
    manifest = source / "ui/Cargo.toml"
    target = REPRO_TARGET / f"{module}-ui"
    cargo(manifest, ["build", "--release", "--lib", "--target", "wasm32-unknown-unknown",
                     "--no-default-features", "--features", "csr"], target, ["-Cdebuginfo=0"])
    cargo(ROOT / "rust-spike/ui/bindgen/Cargo.toml", ["build", "--release"], TARGET / "bindgen")
    dest = OUT / f"{module}-ui"
    dest.mkdir()
    suffix = ".exe" if os.name == "nt" else ""
    subprocess.run([str(TARGET / f"bindgen/release/ui-bindgen{suffix}"),
                    str(target / f"wasm32-unknown-unknown/release/{crate_name(manifest)}.wasm"),
                    str(dest), module], check=True)
    for file in (source / "ui/web").iterdir():
        if file.is_file():
            shutil.copyfile(file, dest / file.name)
    shutil.copyfile(ROOT / "rust-spike/module-ui/web/guest-bridge.mjs", dest / "guest-bridge.mjs")
    if module in ("email", "connectors"):
        shutil.copyfile(source / "ui/web/index.html", dest / "settings.html")
        shutil.copyfile(source / "ui/web/layout.css", dest / f"{module}.css")
    if module == "calendar":
        shutil.copyfile(source / "ui/web/index.html", dest / "settings.html")
        shutil.copyfile(source / "ui/web/index.html", dest / "today.html")
        styles=[ROOT / "apps/web/src/styles/kit-calendar.css",source / "ui/web/layout.css"]
        styles += [ROOT / f"apps/web/src/styles/{name}.css" for name in ("kit-today","kit-today-misc","kit-today-timeline","kit-briefing-reader","kit-day-plan-review")]
        (dest / "calendar.css").write_bytes(b"".join(path.read_bytes() for path in styles))
    return dest

for manifest in sorted((ROOT / "modules").glob("*/moss.module.json")):
    module = manifest.parent.name
    if not (manifest.parent / "src/Cargo.toml").exists():
        raise SystemExit(f"Missing Rust builder for {module}")
    guest = REPRO_TARGET / f"{module}-guest"
    core_manifest = manifest.parent / "src/Cargo.toml"
    component = OUT / f"{module}.wasm"
    package = OUT / f"{module}.mosspkg"
    args = ["build", "--release", "--lib", "--target", "wasm32-unknown-unknown"]
    flags = ["-Cdebuginfo=0"]
    if module in ("calendar", "email", "connectors", "memory", "people", "notes"):
        flags += ["-Clink-arg=--import-memory", "-Clink-arg=--initial-memory=2097152", "-Clink-arg=--max-memory=67108864"]
    if module == "people":
        args += ["--features", "component"]
    if module == "notes":
        args = ["rustc", "--release", "--lib", "--target", "wasm32-wasip2", "--features", "write-tools", "--", "-C", "link-arg=--skip-wit-component"]
    cargo(core_manifest, args, guest, flags)
    wasm_target = "wasm32-wasip2" if module == "notes" else "wasm32-unknown-unknown"
    core = guest / f"{wasm_target}/release/{crate_name(core_manifest)}.wasm"
    bindings = manifest.parent / "bindings/Cargo.toml"
    extra = {}
    if bindings.exists():
        cargo(bindings, ["run", "--bin", f"{module}-component", "--", str(core), str(component)], TARGET / "encoders")
    elif module in ("people", "notes"):
        example = "wrap_guest" if module == "people" else "wrap_generated_guest"
        cargo(ROOT / "rust-spike/module-host/Cargo.toml", ["run", "--example", example, "--", str(core), str(component)])
    else:
        component = core  # These existing packers wrap their own compiled core.
    if module in ("people", "email", "connectors", "calendar"):
        assets = ui(module)
        extra[f"{module.upper()}_UI_DIR"] = str(assets)
    if module == "people":
        cargo(ROOT / "rust-spike/module-host/Cargo.toml", ["run", "--example", "pack_people", "--", str(component), str(assets), str(package)])
    else:
        tool = "tools" if module in ("notes", "tasks") else "host"
        binary = f"{module}-pack" if tool == "tools" else f"{module}-package"
        cargo(manifest.parent / f"{tool}/Cargo.toml", ["run", "--bin", binary, "--", str(component), str(package)], extra=extra)
