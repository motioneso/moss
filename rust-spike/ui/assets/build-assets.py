#!/usr/bin/env python3
"""Flattens the real Moss stylesheets for the Tasks screen into one app.css and copies the
fonts, so both UI candidates load exactly the same CSS. Usage: build-assets.py <out-dir>"""
import re, shutil, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
WEB = ROOT / "apps/web"
ENTRIES = [
    WEB / "src/styles/tokens.css",
    ROOT / "packages/ui/src/styles.css",
    WEB / "src/styles/components-forms.css",
    WEB / "src/styles/components-keyline.css",
    WEB / "src/styles.css",
    WEB / "src/styles/kit-tasks.css",
    WEB / "src/tasks/tasks.css",
]
IMPORT = re.compile(r'@import\s+"([^"]+)";')


def flatten(path: Path) -> str:
    def inline(match: re.Match) -> str:
        return flatten((path.parent / match.group(1)).resolve())

    return IMPORT.sub(inline, path.read_text())


out = Path(sys.argv[1])
out.mkdir(parents=True, exist_ok=True)
(out / "app.css").write_text("\n".join(flatten(p) for p in ENTRIES))
shutil.copytree(WEB / "public/fonts", out / "fonts", dirs_exist_ok=True)
