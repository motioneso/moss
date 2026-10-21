"""Synthetic checks only: python3 verify.py. Requires existing Python Playwright/Firefox.

Does not install the add-on or open Outlook. Artifacts go to a temporary directory.
"""
from pathlib import Path
import shutil
import tempfile

from playwright.sync_api import sync_playwright

SOURCE = Path(__file__).resolve().parent
EXTRACT = (SOURCE / "extract.js").read_text()
MESSAGE = '''<article><h3>Synthetic subject</h3><h3>From: Example Sender</h3>
<h3>Wed 10/21/2026 2:00 PM</h3><div role="document" aria-label="Message body">
<p>Synthetic body</p><span hidden>HIDDEN SECRET</span>
<span style="display:none">DISPLAY SECRET</span>
<span aria-hidden="true">ARIA SECRET</span><button>CONTROL SECRET</button>
</div></article>'''


def main():
    workspace = Path(tempfile.mkdtemp(prefix="o365-firefox-synthetic-"))
    run = workspace / "final_runs/run_1"
    (run / "screenshots").mkdir(parents=True)
    shutil.copyfile(__file__, run / "final_script.py")
    shutil.copyfile(__file__, workspace / "final_script.py")
    points = ["Single message and surrounding content isolation", "Missing/ambiguous/compose rejection",
              "Bounded body", "Popup text rendering, clear and host validation", "Injection error handling"]
    (workspace / "plan.md").write_text("\n".join(f"- [ ] CP{i}: {p}" for i, p in enumerate(points, 1)))
    log = []

    def passed(number):
        log.append(f"step {number} action: PASS {points[number - 1]}")

    with sync_playwright() as playwright:
        browser = playwright.firefox.launch(headless=True)
        page = browser.new_page(viewport={"width": 1280, "height": 1800})
        page.set_content('<nav>INBOX SECRET</nav><div role="listbox">ROW SECRET</div>' + MESSAGE
                         + '<div role="textbox" contenteditable="true" aria-label="Message body">DRAFT SECRET</div>')
        capture = page.evaluate(EXTRACT)
        assert capture == dict(ok=True, subject="Synthetic subject", sender="From: Example Sender",
                               date="Wed 10/21/2026 2:00 PM", body="Synthetic body", truncated=False), capture
        passed(1)
        for html, reason in [(MESSAGE + MESSAGE, "ambiguous"), ('<p>No email</p>', "missing"),
                             ('<div role="textbox" contenteditable="true">' + MESSAGE + '</div>', "missing"),
                             ('<div hidden>' + MESSAGE + '</div>', "missing")]:
            page.set_content(html)
            assert page.evaluate(EXTRACT) == dict(ok=False, reason=reason)
        passed(2)
        page.set_content(MESSAGE.replace("Synthetic body", "x" * 13000))
        bounded = page.evaluate(EXTRACT)
        assert bounded["truncated"] and len(bounded["body"]) == 12000
        passed(3)

        # Mock only the browser API: this is popup logic verification, not proof
        # of Firefox extension installation or activeTab permission behavior.
        page.add_init_script('''window.probeUrl = "https://outlook.office.com/mail/";
window.calls = 0; window.failInjection = false;
window.browser = {tabs:{query:async()=>[{id:1,url:window.probeUrl}]},
scripting:{executeScript:async()=>{window.calls++;return window.failInjection
 ? [{error:{message:"synthetic failure"}}]
 : [{result:{ok:true,subject:"<img src=x onerror=alert(1)>",sender:"Example",date:"Wed",body:"Synthetic body"}}];}}};''')
        page.goto((SOURCE / "popup.html").as_uri())
        page.locator("#preview").click()
        page.locator("#result").wait_for(state="visible")
        assert page.locator("#subject").inner_text() == "<img src=x onerror=alert(1)>"
        assert page.locator("img").count() == 0
        page.locator("body").screenshot(path=str(run / "screenshots/final_execution_4_popup.png"))
        page.locator("#clear").click()
        assert page.locator("#result").is_hidden() and page.locator("#body").inner_text() == ""
        for url in ["https://outlook.office.com.evil.invalid/", "http://outlook.office.com/", "https://example.invalid/"]:
            page.evaluate("url => window.probeUrl = url", url)
            page.locator("#preview").click()
            page.wait_for_function('document.querySelector("#status").textContent.includes("active tab")')
        assert page.evaluate("window.calls") == 1
        passed(4)
        page.evaluate('window.probeUrl = "https://outlook.office.com/mail/"; window.failInjection = true')
        page.locator("#preview").click()
        page.wait_for_function('document.querySelector("#status").textContent.includes("identify")')
        assert page.locator("#result").is_hidden()
        page.evaluate('() => { window.browser.scripting.executeScript = async () => {throw Error("synthetic") }; }')
        page.locator("#preview").click()
        page.wait_for_function('document.querySelector("#status").textContent.includes("policy")')
        passed(5)
        browser.close()
    (workspace / "plan.md").write_text("\n".join(f"- [x] CP{i}: {p}; see log step {i}" for i, p in enumerate(points, 1)))
    (run / "final_script_log.txt").write_text("\n".join(log) + "\nSynthetic checks passed; actual add-on and Outlook unverified.\n")
    print("\n".join(log))
    print(f"Evidence: {workspace}")


if __name__ == "__main__":
    main()
