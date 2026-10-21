"""Synthetic checks only: python3 verify.py. Requires existing Python Playwright/Firefox.

Does not install the add-on or open Outlook. Artifacts go to a temporary directory.
"""
from pathlib import Path
import shutil
import tempfile

from playwright.sync_api import sync_playwright

SOURCE = Path(__file__).resolve().parent
EXTRACT = "(() => {" + (SOURCE / "read-message.js").read_text() + "return " + (SOURCE / "extract.js").read_text().split("\n", 1)[1] + "})()"
WATCH = (SOURCE / "watch.js").read_text()
CALENDAR = (SOURCE / "calendar-watch.js").read_text()
MESSAGE = '''<article><h3>Synthetic subject</h3><h3>From: Example Sender</h3>
<h3>Wed 10/21/2026 2:00 PM</h3><div role="document" aria-label="Message body">
<p>Synthetic body</p><span hidden>HIDDEN SECRET</span>
<span style="display:none">DISPLAY SECRET</span>
<span aria-hidden="true">ARIA SECRET</span><button>CONTROL SECRET</button>
</div></article>'''


def verify_nested_headers(page):
    phrase = "MOSS BODY TEST nested"
    inner = MESSAGE.replace('<h3>Synthetic subject</h3>', '').replace(
        'From: Example Sender', 'Example Sender&lt;sender@example.invalid&gt;').replace(
        'Synthetic body', phrase + '<p>MOSS BODY END</p>')
    page.set_content('<section><h2>' + phrase + '</h2>' + inner + '</section>')
    capture = page.evaluate(EXTRACT)
    assert capture["subject"] == phrase, "Nested sender header hid the outer subject"
    assert capture["sender"] == 'Example Sender<sender@example.invalid>'
    assert page.evaluate("phrase => __mossReadOpenedMessage(phrase).ok", phrase)
    # Missing subject stays unknown rather than taking the sender as its value.
    page.set_content(inner)
    assert page.evaluate(EXTRACT)["subject"] == ""
    assert page.evaluate("phrase => __mossReadOpenedMessage(phrase).reason", phrase) == "identity"
    # An Inbox title or heading inside the body must not provide identity.
    page.set_content('<main><h2>' + phrase + '</h2>' + inner + '</main>')
    assert page.evaluate(EXTRACT)["subject"] == ""
    page.set_content(inner.replace('<p>MOSS BODY END</p>', '<h2>' + phrase + '</h2><p>MOSS BODY END</p>'))
    assert page.evaluate(EXTRACT)["subject"] == ""


def verify_auto_body(browser, run):
    reader = (SOURCE / "read-message.js").read_text()
    auto = (SOURCE / "auto-body.js").read_text()
    page = browser.new_page()
    page.route("**/*", lambda route: route.fulfill(content_type="text/html", body="<main></main>"))
    page.goto("https://outlook.office.com/mail/inbox")
    # Controlled clock advances the production callback without repeated waits.
    page.evaluate("""() => {
      window.now = 0; Date.now = () => now;
      window.setInterval = fn => { window.scanBody = fn; return 1; };
      window.clearInterval = () => {};
      window.clicks = 0;
    }""")
    page.evaluate(reader)
    page.evaluate(auto)
    phrase = "MOSS BODY TEST 3141"
    message = ('<section><h2>' + phrase + '</h2>' + MESSAGE.replace('<h3>Synthetic subject</h3>', '').replace(
        "From: Example Sender", "Example Sender&lt;sender@example.invalid&gt;") + '</section>').replace(
        "Synthetic body", phrase + "<p>" + "Invented paragraph. " * 100 + "</p><p>MOSS BODY END</p>")
    fixture = '<div role="listbox" aria-label="Message list"><div role="option">Unrelated synthetic mail</div></div><section id="pane"></section>'

    def reset():
        page.evaluate("__mossAutoBodyProbe.stop()")
        page.evaluate('history.replaceState({}, "", "/mail/inbox"); window.now = 0; window.clicks = 0;')
        page.set_content(fixture)

    def start():
        return page.evaluate("phrase => __mossAutoBodyProbe.start(phrase)", phrase)

    def arrival(count=1):
        page.evaluate("""({phrase,count}) => {
          for (let i=0;i<count;i++) {
            const row = document.createElement('div'); row.setAttribute('role','option');
            row.textContent = phrase;
            row.addEventListener('click', () => { clicks++; history.pushState({}, '', '/mail/inbox/id/synthetic'); });
            document.querySelector('[role=listbox]').append(row);
          }
        }""", dict(phrase=phrase, count=count))

    def ticks(count=1):
        for _ in range(count):
            page.evaluate("window.scanBody()")
        return page.evaluate("__mossAutoBodyProbe.snapshot()")

    reset()
    assert start()["running"]
    ticks(3)
    assert page.evaluate("clicks") == 0
    arrival()
    ticks()
    assert page.evaluate("clicks") == 1
    page.locator("#pane").evaluate("(node, html) => node.innerHTML = html", message)
    assert ticks()["capture"] is None  # stable second snapshot required
    captured = ticks()
    assert not captured["running"] and captured["phase"] == "captured"
    assert captured["capture"]["body"].endswith("MOSS BODY END")
    assert len(captured["capture"]["body"]) > 1800
    ticks(3)
    assert page.evaluate("clicks") == 1

    # Popup renders the captured fixture through mocked browser APIs.
    popup = browser.new_page(viewport={"width": 900, "height": 1500})
    popup.goto((SOURCE / "popup.html").as_uri())
    popup.evaluate("state => window.syntheticBodyState = state", captured)
    popup.evaluate("""() => {
      window.probeUrl = 'https://outlook.office.com/mail/inbox'; window.autoCalls = 0;
      window.__mossAutoBodyProbe = {
        snapshot: () => syntheticBodyState,
        stop: () => (syntheticBodyState = {...syntheticBodyState, running:false, capture:null}),
        start: phrase => (syntheticBodyState = {...syntheticBodyState, running:true, capture:null, phrase}),
      };
      window.browser = {tabs:{query:async()=>[{id:1,url:probeUrl}]}, scripting:{executeScript:async options => {
        autoCalls++;
        if (options.files) {window.installed = options.files; return [{result:null}];}
        return [{result:options.func(...options.args)}];
      }}};
    }""")
    popup.locator("#auto-read").click()
    popup.locator("#auto-result").wait_for(state="visible")
    assert popup.locator("#auto-body").inner_text().endswith("MOSS BODY END")
    popup.locator("#auto-result").screenshot(path=str(run / "screenshots/final_execution_10_body.png"))
    popup.locator("#auto-stop").click()
    popup.wait_for_function('!document.querySelector("#auto-stop").disabled')
    assert popup.locator("#auto-result").is_hidden()
    assert popup.locator("#auto-body").inner_text() == ""
    popup.locator("#auto-phrase").fill(phrase)
    popup.locator("#auto-start").click()
    popup.wait_for_function('document.querySelector("#auto-status").textContent.startsWith("Running")')
    assert popup.evaluate("installed") == ["read-message.js", "auto-body.js"]
    assert popup.evaluate("syntheticBodyState.phrase") == phrase
    calls = popup.evaluate("autoCalls")
    for url in ["https://outlook.office.com.evil.invalid/mail/", "http://outlook.office.com/mail/", "https://outlook.office.com/calendar/"]:
        popup.evaluate("url => probeUrl = url", url)
        popup.locator("#auto-start").click()
        popup.wait_for_function('document.querySelector("#auto-status").textContent.includes("active tab")')
    assert popup.evaluate("autoCalls") == calls
    popup.evaluate("""() => { probeUrl = 'https://outlook.office.com/mail/';
      browser.scripting.executeScript = async () => [{error:{message:'synthetic'}}]; }""")
    popup.locator("#auto-read").click()
    popup.wait_for_function('document.querySelector("#auto-status").textContent.includes("reach")')
    assert popup.locator("#auto-result").is_hidden()
    popup.close()
    assert page.evaluate("__mossAutoBodyProbe.snapshot().capture !== null")
    assert page.evaluate("__mossAutoBodyProbe.stop().capture") is None

    for variant in ["baseline", "duplicate", "stale", "no-end", "ambiguous", "compose", "stop", "interaction", "timeout", "route"]:
        reset()
        if variant == "baseline":
            arrival()
            assert not start()["running"]
        else:
            assert start()["running"]
            if variant == "stop":
                page.evaluate("__mossAutoBodyProbe.stop()")
                arrival()
            elif variant == "interaction":
                page.locator('[role=option]').click()  # trusted Playwright pointer event
                arrival()
            elif variant == "timeout":
                page.evaluate("now = 300001")
                arrival()
            elif variant == "route":
                page.evaluate("history.pushState({}, '', '/mail/drafts')")
                arrival()
            else:
                arrival(2 if variant == "duplicate" else 1)
                ticks()
                content = message
                if variant == "stale": content = content.replace(phrase, "Other synthetic subject", 1)
                if variant == "no-end": content = content.replace("MOSS BODY END", "incomplete")
                if variant == "ambiguous": content += message
                if variant == "compose": content = '<div contenteditable="true">' + message + '</div>'
                page.locator("#pane").evaluate("(node, html) => node.innerHTML = html", content)
        result = ticks(3)
        assert result["capture"] is None, variant
        expected_reasons = {"stale":"Subject heading", "no-end":"Final body marker", "ambiguous":"Several readable", "compose":"No readable"}
        if variant in expected_reasons:
            assert expected_reasons[variant] in result["reason"], variant
        assert page.evaluate("clicks") == (1 if variant in ["stale", "no-end", "ambiguous", "compose"] else 0), variant
        page.evaluate("now = 400000")
        result = ticks()
        assert not result["running"], variant
        if variant in expected_reasons:
            assert expected_reasons[variant] in result["reason"], variant

    # Removing subject identity verification must break the stale-pane assertion.
    reset()
    guard = 'if (expectedPhrase && !subject.toLowerCase().includes(expectedPhrase.toLowerCase())) return { ok: false, reason: "identity" };'
    assert guard in reader
    page.evaluate(reader.replace(guard, ""))
    start()
    arrival()
    ticks()
    page.locator("#pane").evaluate("(node, html) => node.innerHTML = html", message.replace(phrase, "Other subject", 1))
    assert ticks(2)["capture"] is not None, "Removing identity guard must expose stale-pane capture"
    page.close()


def main():
    workspace = Path(tempfile.mkdtemp(prefix="o365-firefox-synthetic-"))
    run = workspace / "final_runs/run_1"
    (run / "screenshots").mkdir(parents=True)
    shutil.copyfile(__file__, run / "final_script.py")
    shutil.copyfile(__file__, workspace / "final_script.py")
    points = ["Single message and surrounding content isolation", "Missing/ambiguous/compose rejection",
              "Bounded body", "Popup text rendering, clear and host validation", "Injection error handling",
              "Automatic list observation, filtering, deduplication and stop", "Watcher popup controls and route shutdown",
              "Calendar appearance/change/disappearance and filtering", "Calendar popup mode and control wiring",
              "One-shot body arrival, route change, stable complete capture and popup",
              "Body isolation, ambiguity, interaction, stop and timeout guards",
              "Nested sender and outer subject identification"]
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
        verify_nested_headers(page)
        passed(12)

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
        verify_auto_body(browser, run)
        passed(10)
        passed(11)
        browser.close()
    (workspace / "plan.md").write_text("\n".join(f"- [x] CP{i}: {p}; see log step {i}" for i, p in enumerate(points, 1)))
    (run / "final_script_log.txt").write_text("\n".join(log) + "\nSynthetic checks passed; automatic body mode in live Outlook unverified.\n")
    print("\n".join(log))
    print(f"Evidence: {workspace}")


if __name__ == "__main__":
    main()
