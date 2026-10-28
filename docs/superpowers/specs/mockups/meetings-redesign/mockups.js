/* global document, window, ResizeObserver */
// Local design fixtures only: no API, auth, persisted writes or actual audio.
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
let statusTimer;
function status(message) {
  const node = $(".mock-status");
  node.textContent = message;
  window.clearTimeout(statusTimer);
  statusTimer = window.setTimeout(() => (node.textContent = ""), 3500);
}
$("[data-theme-toggle]")?.addEventListener("click", (event) => {
  const dark = document.documentElement.dataset.colorMode !== "dark";
  document.documentElement.dataset.colorMode = dark ? "dark" : "light";
  event.currentTarget.textContent = dark ? "Light" : "Dark";
});
$("[data-park-toggle]")?.addEventListener("click", (event) => {
  const canyon = document.documentElement.dataset.theme !== "canyon";
  document.documentElement.dataset.theme = canyon ? "canyon" : "forest";
  event.currentTarget.textContent = canyon ? "Canyon" : "Forest";
});
function filterHistory() {
  const query = $("#history-search").value.trim().toLowerCase();
  const type = $("#history-type").value;
  const rows = $$("[data-history-row]");
  rows.forEach((row) => {
    const excerpt = $(".search-hit", row);
    excerpt.hidden = true;
    excerpt.textContent = "";
    const title = $(".meeting-link, strong", row).textContent.toLowerCase();
    const transcriptMatch =
      !row.hasAttribute("data-locked") &&
      query &&
      row.dataset.transcript.toLowerCase().includes(query);
    row.hidden =
      !(title.includes(query) || transcriptMatch) || (type && row.dataset.recordingType !== type);
    if (!row.hidden && transcriptMatch) {
      excerpt.textContent = `“…${row.dataset.transcript}”`;
      excerpt.hidden = false;
    }
  });
  $(".history-empty").hidden = rows.some((row) => !row.hidden);
}
$("#history-search")?.addEventListener("input", filterHistory);
$("#history-type")?.addEventListener("change", filterHistory);
$("[data-new-meeting]")?.addEventListener("click", () => status("Preview: new meeting"));
$("[data-settings]")?.addEventListener("click", () => status("Preview: Meetings settings"));
const meeting = $("[data-meeting]");
const formatTime = (value) =>
  `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
function seek(value) {
  const position = $("#audio-position");
  if (!position) return;
  position.value = value;
  $("[data-audio-time]").textContent = formatTime(Number(value));
  $$("[data-seek]").forEach((line) =>
    line.setAttribute("aria-current", String(line.dataset.seek === String(value)))
  );
}
document.addEventListener("click", (event) => {
  const line = event.target.closest("[data-seek]");
  if (line) seek(line.dataset.seek);
});
$("#audio-position")?.addEventListener("input", (event) => seek(event.currentTarget.value));
$("[data-play]")?.addEventListener("click", () =>
  status("Preview: playback at the selected moment")
);
function selectView(button) {
  $$("[data-view]", meeting).forEach((item) => {
    item.setAttribute("aria-selected", String(item === button));
    item.tabIndex = item === button ? 0 : -1;
  });
  $(".meeting-panes", meeting).dataset.active = button.dataset.view;
}
$$("[data-view]").forEach((button, index, buttons) => {
  button.addEventListener("click", () => selectView(button));
  button.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? buttons.length - 1
          : (index + (event.key === "ArrowRight" ? 1 : -1) + buttons.length) % buttons.length;
    selectView(buttons[next]);
    buttons[next].focus();
  });
});
if (meeting?.classList.contains("mode-side")) {
  new ResizeObserver(([entry]) => {
    const narrow = entry.contentRect.width <= 680;
    $$(".meeting-panes > section", meeting).forEach((panel) => {
      if (narrow) {
        panel.setAttribute("role", "tabpanel");
        panel.setAttribute("aria-labelledby", panel.id.replace("panel", "tab"));
      } else {
        panel.removeAttribute("role");
        panel.setAttribute(
          "aria-labelledby",
          panel.id === "notes-panel" ? "notes-heading" : "transcript-heading"
        );
      }
    });
  }).observe(meeting);
}
const divider = $(".pane-divider");
function resizeTranscript(value) {
  value = Math.min(65, Math.max(25, value));
  $(".meeting-panes").style.setProperty("--transcript-width", `${value}%`);
  divider.setAttribute("aria-valuenow", String(Math.round(value)));
}
divider?.addEventListener("keydown", (event) => {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  resizeTranscript(
    event.key === "Home"
      ? 25
      : event.key === "End"
        ? 65
        : Number(divider.getAttribute("aria-valuenow")) + (event.key === "ArrowRight" ? 2 : -2)
  );
});
divider?.addEventListener("pointerdown", (event) => {
  divider.setPointerCapture(event.pointerId);
  divider.dataset.dragging = "true";
});
divider?.addEventListener("pointermove", (event) => {
  if (divider.dataset.dragging !== "true") return;
  const rect = $(".meeting-panes").getBoundingClientRect();
  resizeTranscript(((event.clientX - rect.left) / rect.width) * 100);
});
["pointerup", "pointercancel", "lostpointercapture"].forEach((name) =>
  divider?.addEventListener(name, () => delete divider.dataset.dragging)
);
const originalSummaryMarkup = $(".summary-lines")?.innerHTML;
let edited = false;
const editDialog = $("#edit-summary");
const regenerateDialog = $("#regenerate-dialog");
const sensitiveDialog = $("#sensitive-dialog");
function markEdited(value) {
  edited = value;
  $("[data-edited]").hidden = !value;
}
function regenerate() {
  $(".summary-lines").innerHTML = originalSummaryMarkup;
  markEdited(false);
  status("Preview: summary regenerated");
}

$("[data-edit-summary]")?.addEventListener("click", () => {
  $("#summary-edit").value = $$(".summary-line > span:first-child")
    .map((node) => node.textContent)
    .join("\n");
  editDialog.returnValue = "";
  editDialog.showModal();
  $("#summary-edit").focus();
});
editDialog?.addEventListener("close", () => {
  if (editDialog.returnValue === "save") {
    // Keep one moment per editable summary line, including newly added lines.
    const lines = $("#summary-edit")
      .value.split("\n")
      .filter((line) => line.trim());
    const container = $(".summary-lines");
    const template = $(".summary-line", container).cloneNode(true);
    container.replaceChildren();
    lines.forEach((text, index) => {
      const line = template.cloneNode(true);
      line.dataset.seek = String(index * 198);
      $("span:first-child", line).textContent = text;
      $(".line-time", line).textContent = formatTime(index * 198);
      container.append(line);
    });
    if (!lines.length) container.append(template);
    markEdited(true);
  }
  $("[data-edit-summary]").focus();
});
function openRegenerateWarning() {
  regenerateDialog.returnValue = "";
  regenerateDialog.showModal();
}
$("[data-regenerate]")?.addEventListener("click", () =>
  edited ? openRegenerateWarning() : regenerate()
);
regenerateDialog?.addEventListener("close", () => {
  if (regenerateDialog.returnValue === "replace") regenerate();
  $("[data-regenerate]").focus();
});
if ($("[data-warning]")) {
  $(".summary-line > span:first-child").textContent =
    "Keep Thursday as the target, but ask Alex to confirm signup before noon.";
  markEdited(true);
  openRegenerateWarning();
}
$("[data-sensitive]")?.addEventListener("click", () => {
  sensitiveDialog.returnValue = "";
  sensitiveDialog.showModal();
});
sensitiveDialog?.addEventListener("close", () => {
  if (sensitiveDialog.returnValue === "mark") {
    const control = $("[data-sensitive]");
    const link = document.createElement("a");
    link.className = "jds-btn jds-btn--secondary";
    link.href = "sensitive-lock.html";
    link.textContent = "Lock";
    control.replaceWith(link);
    link.focus();
    status("Preview: marked as sensitive");
  } else $("[data-sensitive]").focus();
});
$("[data-password-form]")?.addEventListener("submit", (event) => {
  event.preventDefault();
  // This is an intentionally fake review password, never the user's app password.
  const accepted = $("#app-password").value === "preview";
  $("#app-password").value = "";
  window.location.href = accepted ? "sensitive-unlocked.html" : "sensitive-error.html";
});
$("[data-search-transcript]")?.addEventListener("click", () => {
  const existing = $("#transcript-search");
  if (existing) {
    existing.focus();
    return;
  }
  const input = document.createElement("input");
  input.id = "transcript-search";
  input.className = "jds-input transcript-search";
  input.type = "search";
  input.placeholder = "Find in transcript…";
  input.setAttribute("aria-label", "Find in transcript");
  input.addEventListener("input", () =>
    $$(".transcript-line").forEach(
      (line) =>
        ((line.closest(".transcript-entry") || line).hidden = !line.textContent
          .toLowerCase()
          .includes(input.value.toLowerCase()))
    )
  );
  $(".transcript-lines").before(input);
  input.focus();
});
const dock = $(".chatd");
let chatOpener;
function showChat(open) {
  if (!dock) return;
  const mobile = window.matchMedia("(max-width: 920px)").matches;
  dock.hidden = !open;
  $(".mock-body").classList.toggle("has-chat", open);
  $$("[data-chat-toggle]").forEach((button) => button.setAttribute("aria-pressed", String(open)));
  $("main")?.toggleAttribute("inert", open && mobile);
  $(".mock-sidebar")?.toggleAttribute("inert", open && mobile);
  $(".mock-topbar")?.toggleAttribute("inert", open && mobile);
  $(".review-nav")?.toggleAttribute("inert", open && mobile);
  dock.setAttribute("role", open && mobile ? "dialog" : "complementary");
  if (open && mobile) dock.setAttribute("aria-modal", "true");
  else dock.removeAttribute("aria-modal");
  if (open) $("#chat-input").focus({ preventScroll: true });
  else chatOpener?.focus({ preventScroll: true });
}
$$("[data-chat-toggle]").forEach((button) =>
  button.addEventListener("click", () => {
    if (dock.hidden) chatOpener = button;
    showChat(dock.hidden);
  })
);
dock?.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    event.preventDefault();
    showChat(false);
  }
  if (event.key === "Tab" && dock.getAttribute("aria-modal") === "true") {
    const controls = $$("button:not([disabled]), textarea", dock);
    const first = controls[0],
      last = controls.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }
});
window.matchMedia("(max-width: 920px)").addEventListener("change", () => {
  if (dock && !dock.hidden) showChat(true);
});
if ($(".has-chat") && window.innerWidth > 920) showChat(true);
else if (dock) showChat(false);
$("[data-chat-form]")?.addEventListener("submit", (event) => {
  event.preventDefault();
  const input = $("#chat-input");
  if (!input.value.trim()) return;
  const message = document.createElement("div");
  message.className = "chatd-msg chatd-msg--me";
  const bubble = document.createElement("div");
  bubble.className = "chatd-bubble";
  bubble.textContent = input.value;
  message.append(bubble);
  $(".chatd__body").append(message);
  input.value = "";
  message.scrollIntoView({ block: "nearest" });
});
