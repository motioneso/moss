/* global document, getComputedStyle */
const icons = {
  brand:
    '<rect x="4" y="5.5" width="13" height="3" rx="1.5" fill="currentColor" stroke="none"/><rect x="4" y="10.5" width="16" height="3" rx="1.5" fill="var(--gold)" stroke="none"/><rect x="4" y="15.5" width="9" height="3" rx="1.5" fill="currentColor" stroke="none"/>',
  computer: '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4"/>',
  chat: '<path d="M21 11a8 8 0 0 1-8 8H6l-4 3 1-7a8 8 0 1 1 18-4Z"/>',
  folder: '<path d="M3 6a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v10H3Z"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 3v4m10-4v4M3 11h18"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1 1m12 12 1 1M5 19l1-1M18 6l1-1"/>',
  resize: '<path d="M8 3H3v5m13 13h5v-5M3 3l6 6m12 12-6-6"/>',
  arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  document: '<path d="M6 3h8l4 4v14H6Z M14 3v5h4M9 12h6m-6 4h6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  up: '<path d="M12 19V5m-6 6 6-6 6 6"/>'
};
document
  .querySelectorAll("[data-icon]")
  .forEach(
    (el) =>
      (el.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[el.dataset.icon]}</svg>`)
  );
document
  .querySelectorAll("[data-screen]")
  .forEach((el) => el.append(document.getElementById("screen-template").content.cloneNode(true)));
const $ = (id) => document.getElementById(id);
const stage = document.querySelector(".stage");
const descriptions = {
  preview: ["01 / Full-screen chat", "A recent still in the margin. Chat stays the main event."],
  watch: [
    "02 / Open alongside chat",
    "A closer look, without leaving the conversation or taking control."
  ],
  control: ["03 / Take over", "Moss input is paused. Return control explicitly when you’re ready."],
  drawer: ["04 / Small drawer", "A compact Computer strip keeps the conversation roomy."],
  phone: ["05 / Phone", "The same chat, with a small preview that opens inline."]
};
const states = {
  working: [
    "Working",
    "Checking the coastal shortlist.",
    "",
    "2 min ago",
    "Checking routes and nearby walks"
  ],
  sleeping: [
    "Sleeping",
    "Resting until it’s needed.",
    "Wake to continue.",
    "1 hr ago",
    "Computer is sleeping"
  ],
  waking: [
    "Waking",
    "Getting the computer ready.",
    "Getting ready…",
    "1 hr ago",
    "Waking the computer…"
  ],
  paused: [
    "Paused",
    "Waiting for your next step.",
    "Return control to continue.",
    "2 min ago",
    "Computer input is paused"
  ],
  disconnected: [
    "Disconnected",
    "We’ve lost the connection.",
    "Reconnect to continue.",
    "8 min ago",
    "Computer connection lost"
  ],
  disabled: [
    "Off",
    "Computer is turned off.",
    "Enable Computer to continue.",
    "Before disabling",
    "Computer is turned off"
  ]
};
let scene = "preview";
let state = "working";
let ownerControl = false;
let inputPaused = false;
let returnScene = "preview";
function render() {
  stage.dataset.scene = scene;
  const current = [...states[state]];
  if (state === "working" && ownerControl) {
    current[0] = "You have control";
    current[4] = "You’re using the computer · Moss input paused";
  }
  if (state === "working" && inputPaused && !ownerControl) {
    current[0] = "Paused";
    current[4] = "Computer input is paused";
  }
  $("scene-title").textContent = descriptions[scene][0];
  $("scene-description").textContent = descriptions[scene][1];
  document.querySelectorAll(".scenes button").forEach((button) => {
    const active = button.dataset.scene === scene;
    button.setAttribute("aria-pressed", String(active));
    button.className = `jds-btn jds-btn--${active ? "secondary" : "quiet"} jds-btn--sm`;
  });
  document.querySelectorAll("[data-status]").forEach((el) => (el.textContent = current[0]));
  document.querySelectorAll("[data-capture]").forEach((el) => (el.textContent = current[3]));
  $("computer-copy").replaceChildren(document.createTextNode(current[1]));
  $("activity-text").textContent = current[4];
  const expanded = scene === "watch" || scene === "control";
  const unavailable = ["sleeping", "waking", "disconnected", "disabled"].includes(state);
  const paused = inputPaused || state === "paused";
  $("preview-open").setAttribute("aria-expanded", String(expanded));
  $("viewer-subtitle").textContent = ownerControl ? "You have control" : "Watching";
  $("controller-label").textContent = unavailable
    ? current[0]
    : ownerControl
      ? "You have control"
      : paused
        ? "Input is paused"
        : "Moss has control";
  $("control-button").textContent = unavailable
    ? {
        sleeping: "Wake computer",
        waking: "Waking…",
        disconnected: "Reconnect",
        disabled: "Enable computer"
      }[state]
    : ownerControl || paused
      ? "Return to Moss"
      : "Take over";
  $("control-button").disabled = state === "waking";
  $("viewer-screen").hidden = unavailable;
  $("state-message").hidden = !unavailable;
  $("state-title").textContent =
    {
      sleeping: "A little rest.",
      waking: "Waking up…",
      disconnected: "Connection lost.",
      disabled: "Computer is off."
    }[state] || "";
  $("state-copy").textContent = current[2];
  $("open-computer").firstChild.textContent =
    state === "sleeping" ? "Wake & open computer " : "Open computer ";
  $("resize-chat").setAttribute(
    "aria-label",
    scene === "drawer" ? "Expand chat" : "Show small drawer"
  );
  $("status-badge").className =
    `jds-badge jds-badge--${["working"].includes(state) && !paused ? "forest" : "neutral"}`;
}
function chooseScene(next) {
  if (
    ["watch", "control"].includes(scene) &&
    !["watch", "control"].includes(next) &&
    ownerControl
  ) {
    ownerControl = false;
    inputPaused = false;
  }
  scene = next;
  if (next === "control") {
    state = "working";
    ownerControl = true;
    inputPaused = true;
    $("state").value = "working";
  }
  if (next === "watch" && ownerControl) scene = "control";
  render();
}
function openViewer() {
  returnScene = ["phone", "drawer"].includes(scene) ? scene : "preview";
  if (state === "sleeping") {
    state = "waking";
    $("state").value = "waking";
  }
  chooseScene(ownerControl ? "control" : "watch");
  $("close-viewer").focus();
}
document
  .querySelectorAll(".scenes button")
  .forEach((button) => button.addEventListener("click", () => chooseScene(button.dataset.scene)));
for (const id of ["preview-open", "open-computer", "compact-open"])
  $(id).addEventListener("click", openViewer);
$("close-viewer").addEventListener("click", () => {
  chooseScene(returnScene);
  if (getComputedStyle($("compact-open")).display !== "none") $("compact-open").focus();
  else $("preview-open").focus();
});
$("control-button").addEventListener("click", () => {
  if (state === "sleeping") {
    state = "waking";
  } else if (["disabled", "disconnected"].includes(state)) {
    state = "waking";
  } else if (ownerControl || inputPaused || state === "paused") {
    ownerControl = false;
    inputPaused = false;
    state = "working";
    scene = "watch";
  } else {
    ownerControl = true;
    inputPaused = true;
    scene = "control";
  }
  $("state").value = state;
  render();
});
$("state").addEventListener("change", (event) => {
  state = event.target.value;
  ownerControl = false;
  inputPaused = state === "paused";
  if (scene === "control") scene = "watch";
  render();
});
$("theme").addEventListener("change", (event) => {
  document.documentElement.dataset.colorMode = event.target.value === "dark" ? "dark" : "light";
  document.documentElement.dataset.theme = event.target.value === "teal" ? "teal" : "";
});
$("resize-chat").addEventListener("click", () =>
  chooseScene(scene === "drawer" ? "preview" : "drawer")
);
$("chat-options").addEventListener("click", () => chooseScene("preview"));
$("attach").addEventListener(
  "click",
  () =>
    ($("composer-hint").textContent =
      "Design sample · “Coastal weekend” is already attached above.")
);
$("composer").addEventListener("submit", (event) => {
  event.preventDefault();
  const field = document.querySelector("textarea");
  const text = field.value.trim();
  if (!text) {
    field.focus();
    return;
  }
  const row = document.createElement("div");
  row.className = "chatd-msg chatd-msg--me";
  const bubble = document.createElement("div");
  bubble.className = "chatd-bubble";
  bubble.textContent = text;
  row.append(bubble);
  $("messages").append(row);
  field.value = "";
  row.scrollIntoView({ block: "nearest" });
  $("composer-hint").textContent = "Example message added locally · nothing was sent.";
});
render();
