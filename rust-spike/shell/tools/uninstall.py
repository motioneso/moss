#!/usr/bin/env python3
"""Remove only inventoried, unchanged Moss install files; retain all instance and app data.

Quit the app, disable start at login and stop its servers before uninstalling. Requires
Python 3 on the machine running this maintenance command. Never run this as an admin.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath


def uninstall(root: Path) -> list[str]:
    if root.is_symlink() or root != root.resolve() or not root.is_dir():
        raise ValueError("Use the real install directory, without symbolic links")
    if root.stat().st_uid != os.getuid() or os.getuid() == 0:
        raise ValueError("Uninstall must run as the install's ordinary owner")
    manifest = root / "install-manifest.json"
    if manifest.is_symlink():
        raise ValueError("The install manifest must not be a symbolic link")
    inventory = json.loads(manifest.read_text())
    if inventory.get("format") != 1 or not isinstance(inventory.get("files"), dict):
        raise ValueError("Unrecognized install manifest")
    # Refuse a live executable before deleting any dependency it may still need.
    for process in Path("/proc").iterdir():
        if not process.name.isdecimal():
            continue
        try:
            executable = (process / "exe").resolve(strict=True)
        except (OSError, RuntimeError):
            continue
        if executable.is_relative_to(root):
            raise ValueError("Quit Moss and stop its servers before uninstalling")
    paths = []
    for name, digest in inventory["files"].items():
        relative = PurePosixPath(name)
        # Fixed install namespaces; a manifest can never inventory servers/ or app/ data.
        allowed = relative.parts and relative.parts[0] in {
            "moss-app", "moss-shell", "moss-db", "moss-run", "uninstall.py",
            "postgres", "schema", "web", "runtime",
        }
        if not allowed or relative.is_absolute() or ".." in relative.parts or "\\" in name:
            raise ValueError("Manifest contains a path outside the install namespaces")
        path = root / relative
        if any(parent.is_symlink() for parent in path.parents if parent != root and parent.is_relative_to(root)):
            raise ValueError("An install directory was replaced by a symbolic link")
        if path.is_symlink():
            # Staged PG links may target other inventoried install files, never user data.
            target = path.resolve()
            if not target.is_relative_to(root) or str(target.relative_to(root)) not in inventory["files"]:
                raise ValueError("An install link no longer targets an inventoried file")
        if path.exists() and (not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest() != digest):
            raise ValueError(f"Install file changed; nothing removed: {name}")
        if path.exists() or path.is_symlink():
            paths.append(path)
    # All checks precede deletion. Unlisted files and nonempty folders survive.
    for path in paths:
        path.unlink()
    manifest.unlink()
    parents = {parent for path in paths for parent in path.parents if parent.is_relative_to(root)}
    for parent in sorted(parents, key=lambda path: len(path.parts), reverse=True):
        try:
            parent.rmdir()
        except OSError:
            pass
    return [str(path.relative_to(root)) for path in paths]


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--install", type=Path, default=Path(__file__).absolute().parent)
    args = parser.parse_args()
    try:
        removed = uninstall(args.install.absolute())
    except (ValueError, OSError) as error:
        parser.exit(1, f"Cannot uninstall: {error}\n")
    print(f"Removed {len(removed)} install files. User data and unlisted files were retained.")
