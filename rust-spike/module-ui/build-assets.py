#!/usr/bin/env python3
"""Build the shared module stylesheet from authored Park Press sources, not copied rules."""
from pathlib import Path
import re
import shutil
import sys

ROOT = Path(__file__).resolve().parents[2]
IMPORT = re.compile(r'@import\s+"([^"]+)";')


def flatten(path: Path, seen: set[Path]) -> str:
    path = path.resolve()
    if path in seen:
        return ""
    seen.add(path)
    return IMPORT.sub(lambda m: flatten(path.parent / m.group(1), seen), path.read_text())


def build(out: Path) -> None:
    out.mkdir(parents=True, exist_ok=True)
    seen: set[Path] = set()
    css = "\n".join(flatten(p, seen) for p in [
        ROOT / "apps/web/src/styles/tokens.css",
        ROOT / "packages/ui/src/styles.css",
        ROOT / "rust-spike/module-ui/web/base.css",
    ])
    css = css.replace('url("/fonts/', 'url("/module-shared/fonts/')
    (out / "park-press.css").write_text(css)
    shutil.copytree(ROOT / "apps/web/public/fonts", out / "fonts", dirs_exist_ok=True)


if __name__ == "__main__":
    build(Path(sys.argv[1]))
