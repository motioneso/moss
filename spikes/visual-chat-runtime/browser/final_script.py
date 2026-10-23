"""Check the isolated runtime in a fresh Firefox; no Moss API or model calls."""

import argparse
import json
import shutil
from pathlib import Path
from urllib.parse import urlsplit

from playwright.sync_api import sync_playwright


def check(url: str, output_dir: Path) -> None:
    """Verify rendered fixture facts, fallback and observed runtime loading.

    Args:
        url: Running development or preview URL on a claimed dev port.
        output_dir: Fresh scratch directory for this execution's receipt and screenshot.
    """
    output_dir.mkdir(parents=True, exist_ok=False)
    screenshots = output_dir / "screenshots"
    screenshots.mkdir()
    shutil.copyfile(__file__, output_dir / "final_script.py")
    log = output_dir / "final_script_log.txt"
    requests = []
    errors = []
    origin = urlsplit(url)

    def record(line: str) -> None:
        print(line, flush=True)
        with log.open("a") as handle:
            handle.write(line + "\n")

    try:
        with sync_playwright() as playwright:
            browser = playwright.firefox.launch(headless=True)
            page = browser.new_page(viewport={"width": 1280, "height": 1800})
            page.on("request", lambda request: requests.append(request.url))
            page.on("pageerror", lambda error: errors.append(str(error)))
            cases = [("allocation", "Time to allocate", True),
                     ("rearranged", "Resources", True),
                     ("unknown", "Visual unavailable", False),
                     ("truncated", "Visual unavailable", False),
                     ("query", "Visual unavailable", False),
                     ("unknown-fact", "Visual unavailable", False)]
            for step, (case, expected, valid) in enumerate(cases, 1):
                page.goto(f"{url.rstrip('/')}/?case={case}", wait_until="networkidle")
                page.get_by_text(expected, exact=True).wait_for()
                assert page.get_by_test_id("answer").is_visible()
                if valid:
                    assert page.locator(".jds-card").count() == 1
                    assert "6 hours" in page.locator(".jds-card").inner_text()
                    assert "Projects: 5" in page.locator(".jds-card").inner_text()
                    if case == "rearranged":
                        assert "$420" in page.locator(".jds-card").inner_text()
                else:
                    assert "Available time: 6 hours" in page.locator("main").inner_text()
                    assert "root =" not in page.locator("main").inner_text()
                page.locator("summary").click()
                assert page.get_by_test_id("fallback").is_visible()
                assert "Example data" in page.get_by_test_id("fallback").inner_text()
                page.locator("main").screenshot(path=str(screenshots / f"final_execution_{step}_{case}.png"))
                record(f"step {step} action: {case}: rendered {expected}; answer and host facts retained")
            external = [value for value in requests if urlsplit(value).netloc != origin.netloc]
            devtools = [value for value in requests if "openuidev" in value and "devtools" in value]
            mounts = page.locator("[data-openui-devtools-auto-mount]").count()
            record(f"step 7 action: network: external={len(external)}, devtools={len(devtools)}, mounts={mounts}, page_errors={len(errors)}")
            assert not external, f"External requests: {external}"
            assert not devtools and mounts == 0, f"Automatic devtools: {devtools}, mounts={mounts}"
            assert not errors, f"Page errors: {errors}"
            browser.close()
            record("PASS: two actual OpenUI compositions, four fallbacks; observed loader checks passed")
    finally:
        (output_dir / "requests.json").write_text(json.dumps({"requests": requests, "pageErrors": errors}, indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", required=True)
    parser.add_argument("--output-dir", required=True, type=Path)
    arguments = parser.parse_args()
    check(arguments.url, arguments.output_dir)
