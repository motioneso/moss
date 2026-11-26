#!/usr/bin/env python3
"""Build unsigned PG/pgvector from verified archives; all caches live outside the repo.

Unix prerequisites: C compiler, make, bison, flex, Perl, ICU development files.
Windows: VS developer shell, CI requirements, MSYS bison/flex, CMake, Perl.
ICU on Windows is built from its pinned source, never borrowed from runner Postgres.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import tarfile
import urllib.request
import zipfile

HERE = Path(__file__).resolve().parent
SOURCES = json.loads((HERE / "sources.json").read_text())
TOOLS = ("postgres", "initdb", "pg_ctl", "psql", "pg_dump", "pg_restore", "pg_config")


def digest(path):
    with path.open("rb") as file:
        return hashlib.file_digest(file, "sha256").hexdigest()


def run(*args, cwd=None, env=None):
    command = [str(arg) for arg in args]
    print("+", subprocess.list2cmdline(command), flush=True)
    subprocess.run(command, cwd=cwd, env=env, check=True)


def source(name, cache, build):
    pin = SOURCES[name]
    archive = cache / pin["sha256"]
    cache.mkdir(parents=True, exist_ok=True)
    if not archive.exists():
        temporary = archive.with_suffix(".partial")
        try:
            urllib.request.urlretrieve(pin["url"], temporary)
            if digest(temporary) != pin["sha256"]:
                raise ValueError(f"Source hash mismatch: {name}")
            temporary.replace(archive)
        finally:
            temporary.unlink(missing_ok=True)
    if digest(archive) != pin["sha256"]:
        raise ValueError(f"Cached source hash mismatch: {name}")
    target = build / name
    target.mkdir()
    if zipfile.is_zipfile(archive):
        with zipfile.ZipFile(archive) as file:
            file.extractall(target)
    else:
        with tarfile.open(archive) as file:
            file.extractall(target, filter="data")
    return next(target.iterdir())


def unix_build(pg, vector, out, jobs):
    env = dict(os.environ, CFLAGS="-O2 -g0", CXXFLAGS="-O2 -g0")
    if platform.system() == "Linux":
        env["LDFLAGS"] = "-Wl,--disable-new-dtags"
    run(pg / "configure", f"--prefix={out}", "--without-readline", "--with-icu",
        "--without-openssl", "--without-zlib", cwd=pg, env=env)
    flags = ["rpathdir=$$ORIGIN/../lib"] if platform.system() == "Linux" else []
    run("make", f"-j{jobs}", *flags, cwd=pg, env=env)
    run("make", "install", *flags, cwd=pg, env=env)
    run("make", f"-j{jobs}", f"PG_CONFIG={out / 'bin/pg_config'}", "OPTFLAGS=", cwd=vector)
    run("make", "install", f"PG_CONFIG={out / 'bin/pg_config'}", cwd=vector)
    module = pg.parent.parent / "moss_nodump"
    shutil.copytree(HERE.parent / "pg-module", module)
    run("make", "install", f"PG_CONFIG={out / 'bin/pg_config'}", cwd=module)
    if platform.system() == "Darwin":
        relocate_mac(out)
    else:
        # libpq already has relative rpath. Include ICU and its C++ runtime closure.
        pending = [out / "bin/postgres", out / "bin/pg_dump"]
        copied = set()
        while pending:
            result = subprocess.check_output(["ldd", str(pending.pop())], text=True)
            for line in result.splitlines():
                parts = line.split()
                if len(parts) < 3 or parts[1] != "=>" or not parts[2].startswith("/"):
                    continue
                path = Path(parts[2])
                if path.name.startswith(("libc.so", "libm.so", "libpthread.so", "libdl.so", "librt.so")):
                    continue
                if path.name not in copied and not path.is_relative_to(out):
                    copied.add(path.name)
                    dest = out / "lib" / path.name
                    shutil.copy2(path, dest)
                    pending.append(dest)


def relocate_mac(out):
    # Rewrite dependencies recursively, including Homebrew ICU's C++ dependency.
    pending = list((out / "bin").iterdir()) + list((out / "lib").rglob("*.dylib")) + list((out / "lib").rglob("*.so"))
    seen = set()
    while pending:
        file = pending.pop()
        if file in seen or file.is_symlink():
            continue
        seen.add(file)
        result = subprocess.run(["otool", "-L", str(file)], capture_output=True, text=True)
        if result.returncode:
            continue
        for line in result.stdout.splitlines()[1:]:
            dep = line.strip().split(" (", 1)[0]
            if not dep.startswith("/") or dep.startswith(("/usr/lib/", "/System/")):
                continue
            target = out / "lib" / Path(dep).name
            if not target.exists():
                shutil.copy2(dep, target)
                pending.append(target)
            relative = os.path.relpath(target, file.parent)
            run("install_name_tool", "-change", dep, f"@loader_path/{relative}", file)
        if file.suffix == ".dylib":
            run("install_name_tool", "-id", f"@loader_path/{file.name}", file)
    # Ad-hoc only: required to execute modified Mach-O on arm64; no signing identity.
    for file in seen:
        if subprocess.run(["otool", "-h", str(file)], capture_output=True).returncode == 0:
            run("codesign", "--force", "--sign", "-", file)


def windows_build(pg, vector, out, build, cache, jobs):
    icu = source("icu_windows", cache, build)
    run("msbuild", icu / "source/allinone/allinone.sln", "/m:1", "/p:Configuration=Release",
        "/p:Platform=x64", "/p:SkipUWP=true")
    # CMake FindICU recognises ICU_ROOT's include/, lib64/ and bin64/ layout.
    env = dict(os.environ, ICU_ROOT=str(icu), PGROOT=str(out))
    env["PATH"] = str(icu / "bin64") + os.pathsep + env["PATH"]
    run("meson", "setup", build / "pg-build", pg, f"--prefix={out}",
        "--buildtype=release", "--auto-features=disabled", "-Dicu=enabled", "-Dssl=none",
        cwd=build, env=env)
    run("meson", "compile", "-C", build / "pg-build", f"-j{jobs}", env=env)
    run("meson", "install", "-C", build / "pg-build", env=env)
    for dll in (icu / "bin64").glob("*.dll"):
        shutil.copy2(dll, out / "bin" / dll.name)
    run("nmake", "/NOLOGO", "/F", "Makefile.win", cwd=vector, env=env)
    run("nmake", "/NOLOGO", "/F", "Makefile.win", "install", cwd=vector, env=env)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--scratch", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--jobs", type=int, default=1)
    args = parser.parse_args()
    scratch, out = args.scratch.resolve(), args.out.resolve()
    repo = HERE.parents[2]
    if scratch.is_relative_to(repo) or out.is_relative_to(repo):
        raise ValueError("Build caches and output must stay outside the repository")
    if out.exists() or (scratch / "build").exists():
        raise ValueError("Choose fresh build/output folders; downloads may be reused")
    build, cache = scratch / "build", scratch / "downloads"
    build.mkdir(parents=True)
    pg, vector = source("postgres", cache, build), source("pgvector", cache, build)
    if os.name == "nt":
        windows_build(pg, vector, out, build, cache, args.jobs)
    else:
        unix_build(pg, vector, out, args.jobs)
    suffix = ".exe" if os.name == "nt" else ""
    tools = {name: digest(out / "bin" / (name + suffix)) for name in TOOLS}
    (out / "bundle.json").write_text(json.dumps({
        "format": 1, "signed": False, "system": platform.system(),
        "sources": SOURCES, "tools": tools,
    }, indent=2) + "\n")
    print(f"Built pinned unsigned database bundle: {out}")


if __name__ == "__main__":
    main()
