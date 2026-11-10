#!/usr/bin/env python3
"""Copies the current app's stylesheets, unchanged, into one app.css for the Rust shell, plus
the fonts, textures and theme boot script. Usage: build-assets.py <out-dir>

The entry list mirrors the cascade order the web app loads for the frame, Today and the chat
drawer: the boot screen and styles/index.css first, then the CSS each of those components imports."""
import re, shutil, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
WEB = ROOT / "apps/web"
STYLES = WEB / "src/styles"
ENTRIES = [
    STYLES / "boot.css",
    STYLES / "index.css",
    STYLES / "kit-chat-unread.css",
    STYLES / "kit-chat.css",
    STYLES / "kit-chat-attach.css",
    STYLES / "kit-chat-skills.css",
    WEB / "src/chat/chat-model-pill.css",
    *(STYLES / f"{name}.css" for name in [
        "wellness-1", "wellness-2", "wellness-3", "kit-tasks-modal", "kit-today",
        "kit-today-hero", "kit-today-timeline", "kit-today-desks", "kit-today-feeds",
        "kit-today-misc", "kit-evening-loops", "kit-briefing-reader", "kit-day-plan-review",
        "kit-evening-planning",
    ]),
]
ALIASES = {"@moss/ui/styles.css": ROOT / "packages/ui/src/styles.css"}
IMPORT = re.compile(r'@import\s+"([^"]+)";')


def flatten(path: Path, seen: set) -> str:
    if path in seen:
        return ""
    seen.add(path)

    def inline(match: re.Match) -> str:
        target = ALIASES.get(match.group(1)) or (path.parent / match.group(1)).resolve()
        return flatten(target, seen)

    return IMPORT.sub(inline, path.read_text())


out = Path(sys.argv[1])
out.mkdir(parents=True, exist_ok=True)
seen: set = set()
(out / "app.css").write_text(
    "\n".join(flatten(p, seen) for p in ENTRIES) + "\n" + (Path(__file__).parent / "shell-extra.css").read_text()
)
for folder in ["fonts", "textures"]:
    shutil.copytree(WEB / "public" / folder, out / folder, dirs_exist_ok=True)
shutil.copy(WEB / "public/boot-theme.js", out / "boot-theme.js")
shutil.copy(WEB / "public/icons/icon.svg", out / "icon.svg")
