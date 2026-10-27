// Local fixture interactions only. No API calls or persistent changes.
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
let statusTimer;
function status(message) {
  const node = $(".mock-status");
  if (!node) return;
  node.textContent = message;
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => (node.textContent = ""), 4000);
}
function showChat(open) {
  const dock = $(".chatd");
  if (!dock) return;
  dock.hidden = !open;
  $(".mock-body").classList.toggle("has-chat", open);
  $$("[data-chat-toggle]").forEach((b) => b.setAttribute("aria-pressed", String(open)));
}
showChat($(".mock-body")?.classList.contains("has-chat"));
$$("[data-chat-toggle]").forEach((b) =>
  b.addEventListener("click", () => showChat($(".chatd").hidden))
);
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
function menuOpen(open, focus = true, last = false) {
  const menu = $("#type-options");
  const trigger = $("[data-type-trigger]");
  if (!menu) return;
  menu.hidden = !open;
  trigger.setAttribute("aria-expanded", String(open));
  if (focus) {
    if (open) (last ? $$("button", menu).at(-1) : $("[aria-checked='true']", menu))?.focus();
    else trigger.focus();
  }
}
$("[data-type-trigger]")?.addEventListener("click", () => menuOpen($("#type-options").hidden));
$("[data-type-trigger]")?.addEventListener("keydown", (event) => {
  if (["ArrowDown", "ArrowUp"].includes(event.key)) {
    event.preventDefault();
    menuOpen(true, true, event.key === "ArrowUp");
  }
});
$("#type-options")?.addEventListener("keydown", (event) => {
  const items = $$("button", event.currentTarget);
  const current = items.indexOf(document.activeElement);
  if (event.key === "Escape") {
    event.preventDefault();
    menuOpen(false);
  }
  if (event.key === "Tab") menuOpen(false);
  if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
    event.preventDefault();
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? items.length - 1
          : (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    items[next].focus();
  }
});
document.addEventListener("pointerdown", (event) => {
  if (!event.target.closest(".type-picker")) menuOpen(false, false);
});
$$("[data-type]").forEach((b) =>
  b.addEventListener("click", () => {
    $("[data-type-label]").textContent = b.dataset.type;
    $("[data-type-trigger]").setAttribute("aria-label", `Recording type: ${b.dataset.type}`);
    $$("[data-type]").forEach((item) => {
      const checked = item === b;
      item.setAttribute("aria-checked", String(checked));
      $(".menu-check", item).textContent = checked ? "✓" : "";
    });
    menuOpen(false);
    status(`Type changed to ${b.dataset.type}`);
  })
);
function tabs(buttons, panelFor) {
  const choose = (button) =>
    buttons.forEach((item) => {
      const active = item === button;
      item.setAttribute("aria-selected", String(active));
      item.tabIndex = active ? 0 : -1;
      $(panelFor(item)).hidden = !active;
    });
  buttons.forEach((button, index) => {
    button.addEventListener("click", () => {
      choose(button);
      updateEntry();
    });
    button.addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const next =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? buttons.length - 1
            : (index + (event.key === "ArrowRight" ? 1 : -1) + buttons.length) % buttons.length;
      choose(buttons[next]);
      buttons[next].focus();
      updateEntry();
    });
  });
}
tabs($$("[data-record-tab]"), (b) => `#${b.dataset.recordTab}-panel`);
tabs($$("[data-entry-tab]"), (b) => `#entry-${b.dataset.entryTab}-panel`);
$("[data-review-note]")?.addEventListener("click", (event) => {
  const panel = $("#note-changes");
  panel.hidden = !panel.hidden;
  event.currentTarget.textContent = panel.hidden ? "Review changes" : "Hide changes";
  event.currentTarget.setAttribute("aria-expanded", String(!panel.hidden));
});
const savedRows = new Map();
function countChanges() {
  const rows = $$("[data-change]:not([data-undone])");
  const notes = rows.filter((r) => r.dataset.change === "note").length;
  const memories = rows.length - notes;
  $("[data-changes-count]").textContent =
    `${notes} ${notes === 1 ? "note" : "notes"} · ${memories} ${memories === 1 ? "memory" : "memories"}`;
  $("[data-undo-all]").disabled = rows.length === 0;
}
function undoRow(row) {
  if (!row || row.dataset.undone) return;
  savedRows.set(row.dataset.change, [...row.childNodes]);
  row.replaceChildren();
  row.dataset.undone = "true";
  const line = document.createElement("div");
  line.className = "undo-state";
  const label = document.createElement("span");
  label.textContent = row.dataset.change === "note" ? "Note change undone" : "Memory removed";
  const restore = document.createElement("button");
  restore.className = "jds-btn jds-btn--link";
  restore.textContent = "Restore";
  restore.addEventListener("click", () => {
    row.replaceChildren(...savedRows.get(row.dataset.change));
    delete row.dataset.undone;
    countChanges();
  });
  line.append(label, restore);
  row.append(line);
  countChanges();
}
$$("[data-undo]").forEach((b) =>
  b.addEventListener("click", () => undoRow(b.closest("[data-change]")))
);
$("[data-undo-all]")?.addEventListener("click", () => {
  $$("[data-change]").forEach(undoRow);
  status("Note and memory changes undone");
});
function editDialog(title, fields, save) {
  const previousFocus = document.activeElement;
  const dialog = document.createElement("dialog");
  dialog.className = "mock-dialog";
  const form = document.createElement("form");
  form.method = "dialog";
  const heading = document.createElement("h2");
  heading.id = "edit-heading";
  heading.textContent = title;
  dialog.setAttribute("aria-labelledby", heading.id);
  form.append(heading);
  const controls = fields.map(({ label, value, multiline }) => {
    const wrap = document.createElement("label");
    wrap.className = "jds-field";
    const text = document.createElement("span");
    text.className = "jds-label";
    text.textContent = label;
    const input = document.createElement(multiline ? "textarea" : "input");
    input.className = multiline ? "jds-textarea" : "jds-input";
    input.value = value;
    input.required = true;
    wrap.append(text, input);
    form.append(wrap);
    return input;
  });
  const actions = document.createElement("div");
  actions.className = "dialog-actions";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "jds-btn jds-btn--quiet";
  cancel.textContent = "Cancel";
  cancel.onclick = () => dialog.close();
  const submit = document.createElement("button");
  submit.className = "jds-btn jds-btn--primary";
  submit.textContent = "Save changes";
  actions.append(cancel, submit);
  form.append(actions);
  dialog.append(form);
  document.body.append(dialog);
  form.addEventListener("submit", () => save(controls.map((i) => i.value)));
  dialog.addEventListener("close", () => {
    dialog.remove();
    previousFocus?.focus();
  });
  dialog.showModal();
}
$("[data-change-note]")?.addEventListener("click", () =>
  editDialog(
    "Change note",
    [
      { label: "Destination", value: $(".destination").textContent },
      { label: "Added text", value: $(".added-copy").innerText, multiline: true }
    ],
    ([destination, text]) => {
      $(".destination").textContent = destination;
      $(".added-copy").textContent = text;
      status("Note change saved");
    }
  )
);
$$("[data-edit-memory]").forEach((b) =>
  b.addEventListener("click", () => {
    const text = $("p", b.closest("[data-change]"));
    editDialog(
      "Change memory",
      [{ label: "Memory", value: text.textContent, multiline: true }],
      ([value]) => {
        text.textContent = value;
        status("Memory updated");
      }
    );
  })
);
$("[data-flip-label]")?.addEventListener("click", (event) => {
  const work = $("[data-record-label]").textContent === "Personal";
  $$("[data-record-label], .change-kind .jds-badge").forEach(
    (n) => (n.textContent = work ? "Work" : "Personal")
  );
  event.currentTarget.textContent = work ? "Change to personal" : "Change to work";
  $(".destination").textContent = work ? "Work / Game prototype" : "Projects / Game prototype";
  status(
    work
      ? "Note moved to Work / Game prototype; memories marked Work"
      : "Note moved to Projects / Game prototype; memories marked Personal"
  );
});
function updateEntry() {
  if (!$("[data-entry-submit]")) return;
  const audio = $("[data-entry-tab='audio']").getAttribute("aria-selected") === "true";
  $("[data-entry-submit]").disabled = audio
    ? !$("#entry-audio").files.length
    : !$("#entry-transcript").value.trim();
  $("[data-entry-submit]").textContent = audio ? "Transcribe audio" : "Add recording";
}
$("#entry-transcript")?.addEventListener("input", updateEntry);
$("#entry-audio")?.addEventListener("change", () => {
  const file = $("#entry-audio").files[0];
  $("[data-audio-name]").hidden = !file;
  $("[data-audio-name]").textContent = file ? file.name : "";
  updateEntry();
});
$("[data-entry-form]")?.addEventListener("submit", (event) => {
  event.preventDefault();
  status("Preview: recording submitted");
});
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
function filterHistory() {
  const query = $("#history-search")?.value.trim().toLowerCase() ?? "";
  const type = $("#history-type")?.value ?? "";
  const rows = $$(".history-row");
  rows.forEach((row) => {
    row.hidden =
      !row.textContent.toLowerCase().includes(query) ||
      (type !== "" && row.dataset.recordingType !== type);
  });
  const empty = $(".history-empty");
  if (empty) empty.hidden = rows.some((row) => !row.hidden);
}
$("#history-search")?.addEventListener("input", filterHistory);
$("#history-type")?.addEventListener("change", filterHistory);
$("[data-settings]")?.addEventListener("click", () => status("Preview: Meetings settings"));
$("[data-preview-record]")?.addEventListener("click", () => status("Preview: new meeting"));
$("[data-search-transcript]")?.addEventListener("click", () =>
  editDialog("Search transcript", [{ label: "Find", value: "wind" }], ([query]) => {
    const turn = $$(".transcript-turn").find((n) =>
      n.textContent.toLowerCase().includes(query.toLowerCase())
    );
    if (turn) {
      turn.scrollIntoView({ block: "center" });
      status(`Found “${query}”`);
    } else status("No matches");
  })
);

const calendarDialog = $("#calendar-event");
function openCalendarEvent(linked) {
  if (!calendarDialog) return;
  $("[data-event-title]").textContent = linked ? "Website launch review" : "Project catch-up";
  $("[data-event-time]").textContent = linked
    ? "10:00 – 10:30 AM · 30 min"
    : "2:00 – 2:30 PM · 30 min";
  $("[data-calendar-meeting]").hidden = !linked;
  calendarDialog.showModal();
}
$("[data-calendar-open]")?.addEventListener("click", () => openCalendarEvent(true));
$("[data-calendar-unlinked]")?.addEventListener("click", () => openCalendarEvent(false));
$("[data-calendar-close]")?.addEventListener("click", () => calendarDialog.close());
if (calendarDialog) openCalendarEvent(true);
