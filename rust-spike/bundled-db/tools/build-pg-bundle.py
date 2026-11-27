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

from bundle_libraries import MACHO

HERE = Path(__file__).resolve().parent
SOURCES = json.loads((HERE / "sources.json").read_text())

# Same bytes from a second host, tried only when the pinned URL fails. The pinned hash still
# decides. Kept out of sources.json so the bundle manifest does not change.

MIRRORS = {
    "zlib_windows": ["https://github.com/madler/zlib/releases/download/v1.3.1/zlib-1.3.1.tar.gz"],
}

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
            for url in [pin["url"], *MIRRORS.get(name, [])]:
                try:
                    urllib.request.urlretrieve(url, temporary)
                except OSError as error:
                    print(f"{name}: {url} failed: {error}", flush=True)
                    continue
                if digest(temporary) == pin["sha256"]:
                    temporary.replace(archive)
                    break
                print(f"{name}: {url} did not match the pinned hash", flush=True)
            else:
                raise ValueError(f"Source hash mismatch: {name}")
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
    run(pg / "configure", f"--prefix={out}", "--without-readline", "--with-icu",
        "--without-openssl", "--with-zlib", "--with-zstd", cwd=pg, env=env)
    # DT_RPATH is inherited by ICU's indirect dependencies. DT_RUNPATH would
    # silently borrow libicudata/libstdc++ from the build machine instead.
    flags = ["rpath=-Wl,-rpath,'$$ORIGIN/../lib',--disable-new-dtags"] if platform.system() == "Linux" else []
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
                if "=>" not in line:
                    continue
                location = line.split("=>", 1)[1].rsplit(" (", 1)[0].strip()
                if not location.startswith("/"):
                    raise ValueError(f"Unresolved runtime dependency: {line}")
                path = Path(location)
                if path.name.startswith(("libc.so", "libm.so", "libpthread.so", "libdl.so", "librt.so")):
                    continue
                if path.name not in copied and not path.is_relative_to(out):
                    copied.add(path.name)
                    dest = out / "lib" / path.name
                    shutil.copy2(path, dest)
                    pending.append(dest)


def relocate_mac(out):
    # Rewrite dependencies recursively, including Homebrew ICU's C++ dependency.
    pending = []
    # PG also installs executables under lib/postgresql/pgxs. Match the audit's
    # Mach-O coverage, rather than guessing native files from names or folders.
    for file in out.rglob("*"):
        if file.is_file() and not file.is_symlink():
            with file.open("rb") as stream:
                if stream.read(4) in MACHO:
                    pending.append(file)
    seen = set()
    originals = {}
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
            if dep.startswith("@loader_path/") and file in originals:
                source = originals[file].parent / dep.removeprefix("@loader_path/")
            elif dep.startswith("/") and not dep.startswith(("/usr/lib/", "/System/")):
                source = Path(dep)
            else:
                continue
            target = out / "lib" / source.name
            if not target.exists():
                shutil.copy2(source, target)
                target.chmod(target.stat().st_mode | 0o200)
                # Homebrew ICU also uses loader-relative sibling dependencies.
                # Resolve those against the original library before copying them.
                originals[target] = source.resolve()
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
    deps = build / "dependencies"
    for name, subdir, options in [
        ("zlib_windows", "", []),
        ("zstd_windows", "build/cmake", ["-DZSTD_BUILD_PROGRAMS=OFF", "-DZSTD_BUILD_TESTS=OFF",
                                          "-DZSTD_BUILD_STATIC=OFF", "-DZSTD_BUILD_SHARED=ON"]),
    ]:
        src = source(name, cache, build)
        directory = build / (name + "-build")
        run("cmake", "-S", src / subdir, "-B", directory, "-G", "Ninja",
            "-DCMAKE_BUILD_TYPE=Release", f"-DCMAKE_INSTALL_PREFIX={deps}", *options)
        run("cmake", "--build", directory, "--parallel", str(jobs))
        run("cmake", "--install", directory)
    icu = source("icu_windows", cache, build)
    run("msbuild", icu / "source/allinone/allinone.sln", "/m:1", "/p:Configuration=Release",
        "/p:Platform=x64", "/p:SkipUWP=true")
    # CMake FindICU recognises ICU_ROOT's include/, lib64/ and bin64/ layout.
    # PG's layout changes with the prefix name. Always install to a prefix
    # containing 'postgres', matching pgvector's fixed MSVC include/lib/share layout.
    prefix = build / "postgres-install"
    env = dict(os.environ, ICU_ROOT=str(icu), ZLIB_ROOT=str(deps), PGROOT=str(prefix),
               CC="cl", CXX="cl", PKG_CONFIG_PATH="", PKG_CONFIG_LIBDIR=str(build / "no-pkgconfig"))
    env["PATH"] = os.pathsep.join((str(icu / "bin64"), str(deps / "bin"), env["PATH"]))
    run("meson", "setup", build / "pg-build", pg, f"--prefix={prefix}",
        "--buildtype=release", "--auto-features=disabled", "-Dicu=enabled", "-Dssl=none",
        "-Dzlib=enabled", "-Dzstd=enabled", f"--cmake-prefix-path={deps}", "--wrap-mode=nodownload",
        cwd=build, env=env)
    run("meson", "compile", "-C", build / "pg-build", f"-j{jobs}", env=env)
    run("meson", "install", "-C", build / "pg-build", env=env)
    for name in ("icudt76.dll", "icuuc76.dll", "icuin76.dll"):
        shutil.copy2(icu / "bin64" / name, prefix / "bin" / name)
    for dll in (deps / "bin").glob("*.dll"):
        shutil.copy2(dll, prefix / "bin" / dll.name)
    # The VS compiler's runtime is redistributable, not part of Windows. Ship it
    # app-local rather than relying on the runner's installed redistributable.
    redist = Path(os.environ["VCToolsRedistDir"]) / "x64"
    crt = list(redist.glob("Microsoft.VC*.CRT"))
    if len(crt) != 1 or not (crt[0] / "vcruntime140.dll").is_file():
        raise ValueError("Expected one x64 Visual C++ runtime in VCToolsRedistDir")
    for dll in crt[0].glob("*.dll"):
        shutil.copy2(dll, prefix / "bin" / dll.name)
    run("nmake", "/NOLOGO", "/F", "Makefile.win", cwd=vector, env=env)
    run("nmake", "/NOLOGO", "/F", "Makefile.win", "install", cwd=vector, env=env)
    for name in ("lib/vector.dll", "share/extension/vector.control", "share/extension/vector--0.8.7.sql"):
        if not (prefix / name).is_file():
            raise ValueError(f"Incomplete Windows vector installation: {name}")
    shutil.move(prefix, out)


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
