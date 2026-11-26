#!/usr/bin/env python3
"""Install an unsigned staged program version alongside previous versions, apart from data."""
import argparse
from pathlib import Path
import re
import shutil
import tempfile


def install_version(staged: Path, root: Path, version: str) -> Path:
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,99}", version):
        raise ValueError("Use a single program version name")
    suffix = ".exe" if (staged / "moss-launcher.exe").is_file() else ""
    launcher = staged / f"moss-launcher{suffix}"
    for name in ("moss-launcher", "moss-app", "moss-server", "moss-db"):
        if not (staged / f"{name}{suffix}").is_file():
            raise ValueError(f"Missing {name}")
    versions = root / "versions"
    versions.mkdir(parents=True, exist_ok=True)
    target = versions / version
    if target.exists():
        raise ValueError("This program version is already installed")
    # Build a complete folder before it can be selected. A failed copy never changes current.
    temporary = Path(tempfile.mkdtemp(prefix=".version-", dir=root))
    try:
        shutil.copytree(staged, temporary / "payload", symlinks=True)
        (temporary / "payload").rename(target)
        stable = root / launcher.name
        if not stable.exists():
            shutil.copy2(launcher, temporary / launcher.name)
            (temporary / launcher.name).replace(stable)
        # The stable launcher protocol is kept backwards compatible. Updaters must not replace
        # a running launcher on Windows. Its own upgrade belongs to the native package step.
        selector = temporary / "current"
        selector.write_text(version + "\n")
        selector.replace(root / "current")
    finally:
        shutil.rmtree(temporary)
    return target


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--staged", type=Path, required=True)
    parser.add_argument("--programs", type=Path, required=True)
    parser.add_argument("--version", required=True)
    args = parser.parse_args()
    print(install_version(args.staged.resolve(), args.programs.resolve(), args.version))
