/* global document, window */
import { moduleClient } from "./guest-bridge.mjs";
const client = moduleClient();
const $ = (id) => document.getElementById(id);
// Only fixed path failures become guidance; never display arbitrary backend text.
const pathFailures = new Map([
  [
    "Path does not exist or cannot be resolved",
    "That folder couldn't be found or opened. Check the path and permissions."
  ],
  [
    "Path is not within an allowed notes root",
    "That folder is outside your allowed notes folders. Choose an allowed folder."
  ]
]);
let known = false;
let busy = false;
let linked = null;
let browsing = false;
let confirming = false;
let focusAfter = null;
const action = (id) => document.querySelector(`[data-action="${id}"] button`);
function render() {
  $("folder-state").hidden = !known;
  $("chooser").hidden = !browsing || !known;
  $("unlink-confirm").hidden = !confirming || !known;
  for (const button of document.querySelectorAll("button")) button.disabled = busy;
  action("browse").disabled = busy || !known;
  action("unlink").hidden = !linked;
  action("unlink").disabled = busy || !known;
  $("folder-path").disabled = busy;
  $("linked-path").textContent = linked || "No folder linked";
  action("browse").textContent = linked ? "Change folder" : "Browse…";
  void client.resize(document.documentElement.scrollHeight).catch(() => {});
}
async function request(method, path, body) {
  const reply = await client.request(method, `/${path}`, body);
  if (reply.status >= 400) {
    const error = new Error("Notes request failed");
    error.status = reply.status;
    if (reply.status === 400) error.folderMessage = pathFailures.get(reply.body?.error);
    throw error;
  }
  return reply.body;
}
async function run(operation) {
  if (busy) return;
  busy = true;
  render();
  try {
    await operation();
  } catch {
    $("notice").textContent = "Couldn't finish this request. Check your connection and try again.";
  } finally {
    busy = false;
    render();
    focusAfter?.focus();
    focusAfter = null;
  }
}
async function load() {
  known = false;
  browsing = false;
  confirming = false;
  $("notice").textContent = "Checking linked folder…";
  $("load-error").hidden = true;
  render();
  try {
    const source = await request("GET", "notes-source");
    const status = await request("GET", "notes-last-sync");
    linked = source.path;
    const sync = status.lastSync;
    $("sync-status").textContent = sync
      ? `${sync.ingested} ingested · ${sync.skipped} unchanged · ${sync.errors} errors · ${sync.at}${sync.lastError ? ` · ${sync.lastError}` : ""}`
      : linked
        ? "Folder linked. No saved sync status."
        : "Choose a folder on the server to include your notes as context.";
    known = true;
    $("notice").textContent = "";
  } catch {
    $("load-error").hidden = false;
    throw new Error("Folder read failed");
  }
}
async function list(path) {
  $("browse-error").textContent = "";
  try {
    const result = await request(
      "GET",
      `notes-source/directories${path ? `?path=${encodeURIComponent(path)}` : ""}`
    );
    $("browse-path").textContent = result.path || "Allowed folders";
    $("folder-path").value = result.path || "";
    $("directories").replaceChildren();
    for (const folder of result.directories) {
      const row = document.createElement("li");
      // All dynamic text is account data, never interpreted as HTML.
      const button = document.createElement("button");
      button.type = "button";
      button.className = "jds-btn jds-btn--secondary";
      button.textContent = folder.name;
      button.addEventListener("click", () => run(() => list(folder.path)));
      row.append(button);
      $("directories").append(row);
    }
    if (!result.directories.length) {
      const row = document.createElement("li");
      row.textContent = "No subfolders here. You can link the folder shown above.";
      $("directories").append(row);
    }
  } catch (error) {
    $("directories").replaceChildren();
    $("browse-error").textContent =
      error.status === 503
        ? "No allowed folders are available. Ask the server administrator to configure notes folders for your account."
        : error.folderMessage ||
          "Couldn't open that folder. Choose an allowed folder, or check its path and permissions.";
  }
}
async function save(path) {
  if (!known) return;
  $("browse-error").textContent = "";
  try {
    const result = await request("PUT", "notes-source", { path });
    linked = result.path;
    browsing = false;
    confirming = false;
    $("sync-status").textContent = linked
      ? "Folder linked. Sync is not available in this checkpoint."
      : "No folder linked.";
    $("notice").textContent = linked ? "Folder linked" : "Folder unlinked";
    focusAfter = action("browse");
  } catch (error) {
    if (path !== null && (error.status === 400 || error.status === 503)) {
      $("browse-error").textContent =
        error.status === 503
          ? "No allowed folders are available. Ask the server administrator to configure notes folders for your account."
          : error.folderMessage ||
            "Couldn't link that folder. Choose an allowed folder, or check its path and permissions.";
      $("notice").textContent = "Folder was not changed.";
      focusAfter = $("folder-path");
      return;
    }
    // A transport failure may follow a committed selection. Force an authoritative
    // read before allowing a second write rather than guessing which path won.
    known = false;
    browsing = false;
    confirming = false;
    $("load-error").hidden = false;
    throw new Error("Folder save failed", { cause: error });
  }
}
action("reload").onclick = () => run(load);
action("browse").onclick = () =>
  run(async () => {
    if (!known) return;
    browsing = true;
    confirming = false;
    render();
    $("chooser-heading").focus();
    await list(null);
  });
action("roots").onclick = () => run(() => list(null));
action("list-path").onclick = () => run(() => list($("folder-path").value));
action("cancel").onclick = () => {
  browsing = false;
  render();
  action("browse").focus();
};
action("unlink").onclick = () => {
  if (!known || busy) return;
  confirming = true;
  browsing = false;
  render();
  $("unlink-heading").focus();
};
action("cancel-unlink").onclick = () => {
  confirming = false;
  render();
  action("unlink").focus();
};
action("confirm-unlink").onclick = () => run(() => save(null));
action("link").onclick = () => run(() => save($("folder-path").value));
$("folder-path").onkeydown = (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    action("link").click();
  }
};
window.addEventListener("pagehide", () => client.dispose(), { once: true });
void client
  .theme()
  .then((theme) => {
    if (typeof theme?.theme === "string") document.documentElement.dataset.theme = theme.theme;
    if (typeof theme?.colorMode === "string")
      document.documentElement.dataset.colorMode = theme.colorMode;
  })
  .catch(() => {});
new window.ResizeObserver(() => {
  void client.resize(document.documentElement.scrollHeight).catch(() => {});
}).observe(document.body);
run(load);
