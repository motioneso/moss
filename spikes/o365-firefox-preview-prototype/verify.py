"""Synthetic checks only: python3 verify.py. Requires existing Python Playwright/Firefox.

Does not install the add-on or open Outlook. Artifacts go to a temporary directory.
"""
from pathlib import Path
import shutil
import tempfile

from playwright.sync_api import sync_playwright

SOURCE = Path(__file__).resolve().parent
EXTRACT = (SOURCE / "extract.js").read_text()
WATCH = (SOURCE / "watch.js").read_text()
CALENDAR = (SOURCE / "calendar-watch.js").read_text()
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
              "Bounded body", "Popup text rendering, clear and host validation", "Injection error handling",
              "Automatic list observation, filtering, deduplication and stop", "Watcher popup controls and route shutdown",
              "Calendar appearance/change/disappearance and filtering", "Calendar popup mode and control wiring"]
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

        # Exercise popup controls with the same injected-function interface, but
        # a fake watcher. Real injected script/permission behavior is still manual.
        page.evaluate('''() => {
          window.__mossInboxProbe = {
            state: {running:false, reason:"Ready", scans:0, candidates:0, matched:0, observed:0, lastScan:"", rows:[]},
            start(phrase) { this.state = {...this.state, running:true, phrase, reason:"Watching synthetic items", lastScan:"now", scans:1, candidates:1, matched:1,
              rows:[{kind:"Already visible at start",time:"now",summary:"MOSS TEST <img src=x>"}]}; return this.state; },
            snapshot() {return this.state;},
            stop() {this.state = {...this.state,running:false,reason:"Stopped and cleared",rows:[]};return this.state;}
          };
          window.browser.scripting.executeScript = async (options) => {
            if (options.files) {window.lastScript = options.files[0]; return [{result:null}];}
            return [{result:options.func(...options.args)}];
          };
        }''')
        page.locator("#watch-start").click()
        page.wait_for_function('document.querySelector("#watch-status").textContent.startsWith("Running")')
        assert page.locator("#watch-results").inner_text().endswith("MOSS TEST <img src=x>")
        assert page.locator("img").count() == 0
        page.locator("#watch-read").click()
        page.wait_for_function('!document.querySelector("#watch-read").disabled')
        assert page.locator("#watch-results li").count() == 1
        page.locator("body").screenshot(path=str(run / "screenshots/final_execution_7_watch_popup.png"))
        page.locator("#watch-stop").click()
        page.wait_for_function('document.querySelector("#watch-status").textContent.startsWith("Stopped")')
        assert page.locator("#watch-results li").count() == 0
        page.evaluate('''() => {
          window.probeUrl = "https://outlook.office.com/calendar/view/week";
          window.__mossCalendarProbe = {...window.__mossInboxProbe,
            state:{...window.__mossInboxProbe.state,disappeared:0}};
        }''')
        page.locator("#watch-start").click()
        page.wait_for_function('document.querySelector("#watch-status").textContent.startsWith("Running (calendar)")')
        assert page.evaluate("window.lastScript") == "calendar-watch.js"
        assert "No longer displayed: 0" in page.locator("#watch-status").inner_text()
        page.locator("body").screenshot(path=str(run / "screenshots/final_execution_9_calendar_popup.png"))
        page.locator("#watch-stop").click()
        page.wait_for_function('document.querySelector("#watch-status").textContent.startsWith("Stopped (calendar)")')
        assert page.locator("#watch-results li").count() == 0
        passed(9)

        inbox = browser.new_page(viewport={"width": 1280, "height": 1800})
        inbox.route("**/*", lambda route: route.fulfill(content_type="text/html", body='''<main>
<div role="listbox" aria-label="Message list"><div role="option">MOSS TEST baseline</div>
<div role="option">UNRELATED ROW</div><div role="option" hidden>MOSS TEST hidden</div></div>
<div role="listbox" aria-label="Recipients"><div role="option">MOSS TEST recipient</div></div>
<div role="document" aria-label="Message body">MOSS TEST body excluded</div></main>'''))
        inbox.goto("https://outlook.office.com/mail/inbox")
        # Prove the phrase-filter assertion actually fails when its guard is
        # removed; the mutation runs on synthetic content in this isolated tab.
        inbox.evaluate(WATCH.replace('if (!summary || !summary.toLowerCase().includes(phrase.toLowerCase())) continue;', 'if (!summary) continue;'))
        unfiltered = inbox.evaluate('__mossInboxProbe.start("MOSS TEST")')
        try:
            assert [row["summary"] for row in unfiltered["rows"]] == ["MOSS TEST baseline"]
        except AssertionError:
            pass
        else:
            raise AssertionError("Removing the filter did not break the isolation assertion")
        inbox.evaluate('() => { __mossInboxProbe.stop(); delete globalThis.__mossInboxProbe; }')
        inbox.evaluate(WATCH)
        assert inbox.evaluate("__mossInboxProbe.snapshot().scans") == 0
        state = inbox.evaluate('__mossInboxProbe.start("MOSS TEST")')
        assert state["running"] and state["matched"] == 1 and state["observed"] == 0
        assert [row["summary"] for row in state["rows"]] == ["MOSS TEST baseline"]
        # Close the popup page: the independent tab's real interval must continue.
        page.close()
        inbox.evaluate('''() => {
          const row = document.createElement("div"); row.setAttribute("role","option");
          row.textContent = "MOSS TEST arrived automatically";
          document.querySelector('[aria-label="Message list"]').prepend(row);
        }''')
        inbox.wait_for_function('__mossInboxProbe.snapshot().observed === 1')
        scans = inbox.evaluate("__mossInboxProbe.snapshot().scans")
        inbox.wait_for_function("n => __mossInboxProbe.snapshot().scans > n", arg=scans)
        assert inbox.evaluate("__mossInboxProbe.snapshot().observed") == 1
        # Loading the file again must not reset or duplicate the running watcher.
        inbox.evaluate(WATCH)
        assert len(inbox.evaluate("__mossInboxProbe.snapshot().rows")) == 2
        state = inbox.evaluate("__mossInboxProbe.stop()")
        assert not state["running"] and state["rows"] == [] and state["phrase"] == ""
        scans = state["scans"]
        inbox.wait_for_timeout(2200)
        assert inbox.evaluate("__mossInboxProbe.snapshot().scans") == scans
        passed(6)
        inbox.evaluate('__mossInboxProbe.start("MOSS TEST")')
        inbox.evaluate('history.pushState({}, "", "/mail/drafts")')
        inbox.wait_for_function("!__mossInboxProbe.snapshot().running")
        state = inbox.evaluate("__mossInboxProbe.snapshot()")
        assert state["rows"] == [] and "route changed" in state["reason"]
        passed(7)

        calendar = browser.new_page(viewport={"width": 1280, "height": 1800})
        calendar.route("**/*", lambda route: route.fulfill(content_type="text/html", body='''<nav>
<button aria-label="MOSS TEST navigation 1:00 PM">Navigation</button></nav><main>
<button id="event" aria-label="MOSS TEST baseline, 1:00 PM to 2:00 PM">MOSS TEST baseline</button>
<button aria-label="Private event, 3:00 PM">Private event</button>
<button hidden aria-label="MOSS TEST hidden, 4:00 PM">hidden</button>
<div role="dialog"><button aria-label="MOSS TEST draft, 5:00 PM">Draft</button></div>
<button aria-label="Search MOSS TEST">Search</button></main>'''))
        calendar.goto("https://outlook.office.com/calendar/view/week")
        # As with the inbox guard, removal must make the filter assertion fail.
        calendar.evaluate(CALENDAR.replace('label.toLowerCase().includes(phrase.toLowerCase())', 'true'))
        unfiltered = calendar.evaluate('__mossCalendarProbe.start("MOSS TEST")')
        try:
            assert unfiltered["matched"] == 1
        except AssertionError:
            pass
        else:
            raise AssertionError("Removing calendar phrase filtering did not break its assertion")
        calendar.evaluate('() => { __mossCalendarProbe.stop(); delete globalThis.__mossCalendarProbe; }')
        calendar.evaluate(CALENDAR)
        assert calendar.evaluate("__mossCalendarProbe.snapshot().scans") == 0
        state = calendar.evaluate('__mossCalendarProbe.start("MOSS TEST")')
        assert state["running"] and state["matched"] == 1 and state["observed"] == 0
        assert [row["summary"] for row in state["rows"]] == ["MOSS TEST baseline, 1:00 PM to 2:00 PM"]
        calendar.evaluate('''() => {
          const event = document.createElement("button"); event.id="new-event";
          event.setAttribute("aria-label","MOSS TEST new, All day");
          document.querySelector("main").append(event);
        }''')
        calendar.wait_for_function("__mossCalendarProbe.snapshot().observed === 1")
        calendar.evaluate('document.getElementById("new-event").setAttribute("aria-label","MOSS TEST updated, All day")')
        calendar.wait_for_function("__mossCalendarProbe.snapshot().observed === 2 && __mossCalendarProbe.snapshot().disappeared === 1")
        assert any("not proof of cancellation" in row["kind"] for row in calendar.evaluate("__mossCalendarProbe.snapshot().rows"))
        calendar.evaluate('document.getElementById("new-event").remove()')
        calendar.wait_for_function("__mossCalendarProbe.snapshot().disappeared === 2")
        scans = calendar.evaluate("__mossCalendarProbe.snapshot().scans")
        calendar.wait_for_function("n => __mossCalendarProbe.snapshot().scans > n", arg=scans)
        assert calendar.evaluate("__mossCalendarProbe.snapshot().disappeared") == 2
        calendar.evaluate(CALENDAR)
        assert calendar.evaluate("__mossCalendarProbe.snapshot().observed") == 2
        stopped = calendar.evaluate("__mossCalendarProbe.stop()")
        assert not stopped["running"] and stopped["rows"] == [] and stopped["phrase"] == ""
        calendar.evaluate('__mossCalendarProbe.start("MOSS TEST")')
        calendar.evaluate('history.pushState({}, "", "/calendar/view/day")')
        calendar.wait_for_function("!__mossCalendarProbe.snapshot().running")
        assert calendar.evaluate("__mossCalendarProbe.snapshot().rows") == []
        passed(8)
        browser.close()
    (workspace / "plan.md").write_text("\n".join(f"- [x] CP{i}: {p}; see log step {i}" for i, p in enumerate(points, 1)))
    (run / "final_script_log.txt").write_text("\n".join(log) + "\nSynthetic checks passed; actual calendar watcher in Outlook unverified.\n")
    print("\n".join(log))
    print(f"Evidence: {workspace}")


if __name__ == "__main__":
    main()
