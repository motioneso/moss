/* global document */
import { moduleClient } from "./guest-bridge.mjs";
import { scratchpadApi } from "./api.mjs";
const client = moduleClient();
const api = scratchpadApi(client);
const root = document.getElementById("root");
root.innerHTML = `<div class="sc-settings">
<button class="jds-btn jds-btn--quiet sc-back" id="back">‹ Modules</button>
<div class="jds-section-head jds-section-head--rule"><h2 class="jds-section-head__title">Scratchpad</h2></div>
<p id="state" role="status">Loading your settings…</p>
<div id="controls" hidden>
<div class="set-row"><div class="set-row__main"><div class="sc-row-title">Shortcut</div></div><div class="set-row__control sc-controls"><button class="jds-btn jds-btn--secondary sc-kbd" id="shortcut" aria-label="Change Scratchpad shortcut"></button><button class="jds-btn jds-btn--link" id="reset">Reset to default</button></div></div>
<div class="set-row"><div class="set-row__main"><div class="sc-row-title">Copy to my notes folder</div><div class="set-row__desc" id="folder"></div></div><div class="set-row__control"><label class="jds-switch"><input type="checkbox" id="sync" aria-label="Copy to my notes folder"/><span class="jds-switch__track"><span class="jds-switch__thumb"></span></span></label></div></div>
</div><button class="jds-btn jds-btn--secondary" id="retry" hidden>Try again</button></div>`;
const state = root.querySelector("#state");
const shortcut = root.querySelector("#shortcut");
const sync = root.querySelector("#sync");
let note;
let recording = false;
let busy = false;
const label = (value) =>
  value
    .split("+")
    .map(
      (p) =>
        ({ mod: "Ctrl / Cmd", ctrl: "Ctrl", cmd: "Cmd", meta: "Cmd", shift: "Shift", alt: "Alt" })[
          p
        ] ?? p.toUpperCase()
    )
    .join(" + ");
function render() {
  shortcut.textContent = recording ? "Press your shortcut…" : label(note.shortcut);
  shortcut.setAttribute("aria-pressed", String(recording));
  sync.checked = note.syncToNotes;
  sync.disabled = !note.notesFolderConfigured || busy;
  shortcut.disabled = busy;
  root.querySelector("#reset").disabled = busy;
}
async function load() {
  root.querySelector("#retry").hidden = true;
  try {
    note = await api.read();
    root.querySelector("#controls").hidden = false;
    root.querySelector("#folder").textContent = note.notesFolderConfigured
      ? "Keep a copy in your connected notes folder."
      : "No notes folder connected. ";
    if (!note.notesFolderConfigured) {
      const connect = document.createElement("button");
      connect.className = "jds-btn jds-btn--link";
      connect.textContent = "Connect one";
      connect.addEventListener(
        "click",
        () => void client.navigate("/settings?section=connections")
      );
      root.querySelector("#folder").append(connect);
    }
    state.textContent = "";
    render();
  } catch {
    state.textContent = "Couldn't load your settings.";
    root.querySelector("#retry").hidden = false;
  }
}
async function save(settings) {
  if (busy) return;
  busy = true;
  recording = false;
  render();
  state.textContent = "Saving…";
  try {
    Object.assign(note, await api.settings(settings));
    state.textContent = "Saved";
  } catch (error) {
    state.textContent =
      error.body?.code === "scratchpad_shortcut_invalid"
        ? "Use Ctrl, Cmd or Alt plus a key. Ctrl / Cmd + K is reserved."
        : error.body?.code === "scratchpad_notes_folder_missing"
          ? "Connect a notes folder first."
          : "Couldn't save your settings. Try again.";
  } finally {
    busy = false;
    render();
  }
}
shortcut.addEventListener("click", () => {
  recording = true;
  render();
});
shortcut.addEventListener("blur", () => {
  recording = false;
  if (note) render();
});
shortcut.addEventListener("keydown", (event) => {
  if (!recording) return;
  if (event.key === "Escape") {
    recording = false;
    render();
    return;
  }
  if (["Control", "Meta", "Alt", "Shift", "Tab"].includes(event.key)) return;
  event.preventDefault();
  const parts = [];
  if (event.ctrlKey || event.metaKey) parts.push("mod");
  if (event.altKey) parts.push("alt");
  if (event.shiftKey) parts.push("shift");
  if (!event.ctrlKey && !event.metaKey && !event.altKey) {
    state.textContent = "Use Ctrl, Cmd or Alt plus a key.";
    return;
  }
  parts.push(event.key.toLowerCase());
  void save({ shortcut: parts.join("+") });
});
root
  .querySelector("#reset")
  .addEventListener("click", () => void save({ shortcut: "mod+shift+s" }));
sync.addEventListener("change", () => void save({ syncToNotes: sync.checked }));
root.querySelector("#retry").addEventListener("click", () => void load());
root.querySelector("#back").addEventListener("click", () => void client.navigate("/modules"));
await client
  .theme()
  .then((t) => {
    document.documentElement.dataset.colorMode = t.colorMode;
  })
  .catch(() => {});
await load();
