const fields = ["subject", "sender", "date", "body"];
const status = document.getElementById("status");
const result = document.getElementById("result");
const preview = document.getElementById("preview");
let generation = 0;

function clearPreview() {
  generation += 1;
  result.hidden = true;
  for (const field of fields) document.getElementById(field).textContent = "";
  status.textContent = "Preview cleared. Nothing saved.";
}

document.getElementById("clear").addEventListener("click", clearPreview);
preview.addEventListener("click", async () => {
  clearPreview();
  const request = generation;
  preview.disabled = true;
  status.textContent = "Checking opened message…";
  try {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    const url = new URL(tab.url);
    if (url.protocol !== "https:" || !["outlook.office.com", "outlook.office365.com", "outlook.live.com"].includes(url.hostname)) {
      if (request === generation) status.textContent = "Open Outlook Web in the active tab first.";
      return;
    }
    const injections = await browser.scripting.executeScript({ target: { tabId: tab.id }, files: ["extract.js"] });
    if (request !== generation) return;
    const capture = injections.length === 1 && !injections[0].error && injections[0].result;
    if (!capture || !capture.ok) {
      status.textContent = capture?.reason === "ambiguous"
        ? "Several message bodies are open. Open just the synthetic message on its own."
        : "Couldn't identify one readable message. Open a synthetic email; close drafts and try again.";
      return;
    }
    for (const field of fields) document.getElementById(field).textContent = capture[field] || "Not found";
    result.hidden = false;
    status.textContent = capture.truncated ? "Local preview only. Body limited to 12,000 characters." : "Local preview only. Nothing saved or uploaded.";
  } catch {
    if (request === generation) status.textContent = "Firefox couldn't read this tab. Reload Outlook and try again; your browser policy may block extensions.";
  } finally {
    preview.disabled = false;
  }
});

const watchStatus = document.getElementById("watch-status");
const watchResults = document.getElementById("watch-results");
const watchButtons = ["watch-start", "watch-read", "watch-stop"].map((id) => document.getElementById(id));

async function watchCommand(command) {
  for (const button of watchButtons) button.disabled = true;
  watchResults.replaceChildren();
  try {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    const url = new URL(tab.url);
    if (url.protocol !== "https:" || !["outlook.office.com", "outlook.office365.com", "outlook.live.com"].includes(url.hostname)) {
      watchStatus.textContent = "Open Outlook Web Inbox or Calendar in the active tab first.";
      return;
    }
    const calendar = /(^|\/)calendar(\/|$)/i.test(url.pathname);
    const mode = calendar ? "calendar" : "inbox";
    if (command === "start") {
      const installed = await browser.scripting.executeScript({ target: { tabId: tab.id }, files: [calendar ? "calendar-watch.js" : "watch.js"] });
      if (installed.some((item) => item.error)) throw Error("injection");
    }
    const injections = await browser.scripting.executeScript({
      target: { tabId: tab.id },
      func: (action, phrase, calendarMode) => {
        const watcher = calendarMode ? globalThis.__mossCalendarProbe : globalThis.__mossInboxProbe;
        if (!watcher) return null;
        if (action === "start") return watcher.start(phrase);
        if (action === "stop") return watcher.stop();
        return watcher.snapshot();
      },
      args: [command, document.getElementById("phrase").value, calendar],
    });
    if (injections.length !== 1 || injections[0].error) throw Error("injection");
    const state = injections[0].result;
    if (!state) {
      watchStatus.textContent = "No watcher in this tab. Click Start watching on Inbox or Calendar.";
      return;
    }
    watchStatus.textContent = `${state.running ? "Running" : "Stopped"} (${mode}): ${state.reason}. Scans: ${state.scans}; rendered items: ${state.candidates}; phrase matches: ${state.matched}; newly observed/changed: ${state.observed}.${calendar ? ` No longer displayed: ${state.disappeared}.` : ""} Last scan: ${state.lastScan || "none"}.`;
    for (const row of state.rows) {
      const li = document.createElement("li");
      li.textContent = `${row.kind} (${row.time})\n${row.summary}`;
      watchResults.append(li);
    }
  } catch {
    watchStatus.textContent = "Couldn't reach the watcher. Reloading Outlook stops and clears it; then start again.";
  } finally {
    for (const button of watchButtons) button.disabled = false;
  }
}

document.getElementById("watch-start").addEventListener("click", () => watchCommand("start"));
document.getElementById("watch-read").addEventListener("click", () => watchCommand("read"));
document.getElementById("watch-stop").addEventListener("click", () => watchCommand("stop"));
