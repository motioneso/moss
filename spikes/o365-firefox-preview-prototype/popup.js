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
