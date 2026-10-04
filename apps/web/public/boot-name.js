// Shows the saved assistant name on the pre-React loading screen and the tab title.
// Key matches ASSISTANT_NAME_STORAGE_KEY in src/api/use-assistant-name.ts.
(function () {
  try {
    var name = (localStorage.getItem("moss.assistantName") || "").trim();
    if (!name) return;
    document.title = name;
    var el = document.getElementById("boot-loading");
    if (el) el.textContent = "Loading " + name;
  } catch {
    return;
  }
})();
