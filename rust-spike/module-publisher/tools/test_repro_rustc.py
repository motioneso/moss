"""Compile real Wasm with native and Windows-style source paths; never rewrite output."""
import hashlib
import os
from pathlib import Path
import subprocess
import tempfile

WRAPPER = Path(__file__).with_name("repro-rustc.rs").resolve()
COMPILER = subprocess.check_output(["rustup", "which", "--toolchain", "1.95.0", "rustc"], text=True).strip()
with tempfile.TemporaryDirectory(prefix="moss-repro-paths-") as scratch:
    root = Path(scratch)
    wrapper = root / ("wrapper.exe" if os.name == "nt" else "wrapper")
    subprocess.run(["rustc", "+1.95.0", "--edition=2021", "-Cdebuginfo=0",
                    str(WRAPPER), "-o", str(wrapper)], check=True)
    outputs = []
    for case, filename in (("native source", "nested/lib.rs"), ("windows source", "nested\\lib.rs"),
                           ("cargo argfile", "nested\\lib.rs")):
        source_root = root / case
        source = source_root / filename
        source.parent.mkdir(parents=True)
        source.write_text('#[no_mangle] pub fn path() -> *const u8 { file!().as_ptr() }\n'
                          '#[no_mangle] pub fn length() -> usize { file!().len() }\n')
        # Enough source mappings to exceed Windows' direct command-line limit.
        for index in range(400):
            (source_root / f"unused-source-location-{index:04}.rs").write_text("")
        output = source_root / "fixture.wasm"
        env = os.environ | {"CARGO_MANIFEST_DIR": str(source_root),
                            "CARGO_PKG_NAME": "path-fixture", "CARGO_PKG_VERSION": "0.1.0"}
        env.pop("OUT_DIR", None)
        arguments = ["--edition=2021", "--cfg", 'feature="fixture"',
                        "-Cmetadata=" + ("cargo-input" if case == "cargo argfile" else "direct-input"),
                        "--crate-name", "fixture", "--crate-type", "cdylib",
                        "--target", "wasm32-unknown-unknown", "-Cdebuginfo=0",
                        f"--remap-path-prefix={source_root}=/moss/source",
                        str(source), "-o", str(output)]
        if case == "cargo argfile":
            argfile = source_root / "cargo arguments.txt"
            # Cargo's line-based format, including paths with spaces and quotes in cfgs.
            argfile.write_text("\n".join(arguments) + "\n", newline="\n")
            arguments = ["@" + str(argfile)]
        subprocess.run([str(wrapper), COMPILER, *arguments], env=env, check=True)
        data = output.read_bytes()
        assert b"/moss/source/nested/lib.rs" in data, "Compiler lost the stable source location"
        outputs.append(data)
        print(case, hashlib.sha256(data).hexdigest(), flush=True)
    assert outputs[0] == outputs[1], "Native and Windows-style source paths changed compiled Wasm"
    print("PASS: compiled Wasm preserves the same source location across path separators")
