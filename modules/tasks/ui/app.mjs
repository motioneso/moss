/* global document, window, Option */
import { moduleClient } from "./guest-bridge.mjs";
import { localDay } from "./local-date.mjs";
import { taskFields, taskGroups, viewMode } from "./model.mjs";
import {
  assistantTrackedCount,
  driftMark,
  effortLabel,
  isAssistantSource,
  trackingNote,
  assigneeLabel
} from "./row-marks.mjs";
import { taskFilters } from "./filters.mjs";
import { tagManager } from "./tags.mjs";
import { listDeletion } from "./delete-list.mjs";
import { captureDraft } from "./capture.mjs";
import { findOrCreateTag } from "./task-tags.mjs";
import { interpretedSearch } from "./search.mjs";
import { quickCapture } from "./quick-add.mjs";
import { taskActivity } from "./activity.mjs";
import { taskSettings } from "./settings.mjs";
import { taskDetails } from "./details.mjs";

const client = moduleClient();
const $ = (id) => document.getElementById(id);
const state = {
  assistantName: "",
  tasks: [],
  timeZone: null,
  editorTimeZone: null,
  lists: [],
  editing: null,
  busy: false,
  returnFocus: null,
  pendingTag: null,
  baseline: "",
  leave: null,
  focusAfter: null,
  listDrafts: new Map()
};
const settings = taskSettings({
  api,
  run,
  isBusy: () => state.busy,
  resize: () => void client.resize(document.documentElement.scrollHeight).catch(() => {})
});
const capture = captureDraft({
  api,
  run,
  text,
  button,
  focus: (node) => {
    state.focusAfter = node;
  },
  today: () => localDay(new Date(), state.editorTimeZone)
});
const activity = taskActivity({
  api,
  run,
  bindForm,
  saved: savedExtra,
  text,
  focus: (node) => {
    state.focusAfter = node;
  }
});
const details = taskDetails({
  api,
  run,
  taskRow,
  isBusy: () => state.busy,
  focus: (node) => {
    state.focusAfter = node;
  },
  tagButton: (tag, assigned) =>
    button(
      `#${tag.name}`,
      async () => {
        if (assigned) await api("DELETE", `/tasks/${state.editing.id}/tags/${tag.id}`);
        else await api("POST", `/tasks/${state.editing.id}/tags`, { tagId: tag.id });
        await refreshDetails();
      },
      { pressed: assigned, variant: assigned ? "primary" : "secondary" }
    )
});
const labels = { todo: "Open", done: "Done", suggested: "Suggested", archived: "Archived" };
const search = interpretedSearch({
  api,
  run,
  changed: render,
  focus: (node) => {
    state.focusAfter = node;
  }
});
const filters = taskFilters(render, search.intent);
const quick = quickCapture({
  api,
  run,
  load,
  bindForm,
  defaultListId: () => filters.captureListId(state.lists),
  openDetails: (title) => openEditor(null, title),
  focus: (node) => {
    state.focusAfter = node;
  }
});
const deleting = listDeletion({
  api,
  lists: () => state.lists,
  changed: async () => {
    await load();
    manageLists();
  },
  focus: (node) => {
    state.focusAfter = node;
  }
});
const tags = tagManager({
  api,
  run,
  changed: load,
  bindForm,
  focus: (node) => {
    state.focusAfter = node;
  }
});
const show = (id, visible) => {
  $(id).hidden = !visible;
};
function text(tag, content, className = "") {
  const node = document.createElement(tag);
  node.textContent = content;
  node.className = className;
  return node;
}
function button(label, action, { variant = "secondary", pressed } = {}) {
  const node = text("button", label, `jds-btn jds-btn--${variant}`);
  node.type = "button";
  if (pressed !== undefined) node.setAttribute("aria-pressed", String(pressed));
  node.addEventListener("click", () => run(action));
  return node;
}
function options(id, items, first) {
  const select = $(id);
  const previous = select.value;
  select.replaceChildren();
  if (first !== undefined) select.add(new Option(first, ""));
  for (const item of items) select.add(new Option(item.name, item.id));
  if ([...select.options].some((option) => option.value === previous)) select.value = previous;
}
async function api(method, path, body = null) {
  return client.request(method, path, body);
}
async function run(action) {
  if (state.busy) return;
  state.busy = true;
  state.actionFocus = document.activeElement;
  const controls = [...document.querySelectorAll("button, input, select, textarea")];
  const disabled = controls.map((node) => node.disabled);
  controls.forEach((node) => {
    node.disabled = true;
  });
  $("tasks-app").setAttribute("aria-busy", "true");
  try {
    await action();
  } catch {
    const message = $("tags-editor").hidden
      ? "Could not finish. Check your connection, then try again. Your unsaved changes are kept."
      : "Could not save or load these tags. Check the connection and use a name that is unique in this list, then retry. Your unsaved names are kept.";
    $("notice").textContent = message;
    if (!$("editor").hidden) {
      $("edit-error").textContent = message;
      show("edit-error", true);
    }
    if (!$("tags-editor").hidden) {
      $("tags-error").textContent = message;
      show("tags-error", true);
    }
  } finally {
    state.busy = false;
    controls.forEach((node, index) => {
      node.disabled = disabled[index];
    });
    document.querySelectorAll("button, input, select, textarea").forEach((node) => {
      if (!controls.includes(node)) node.disabled = false;
    });
    capture.lock();
    quick.sync();
    search.sync();
    activity.sync();
    settings.sync();
    details.sync();
    $("tasks-app").removeAttribute("aria-busy");
    state.focusAfter?.focus();
    state.focusAfter = null;
    void client.resize(document.documentElement.scrollHeight).catch(() => {});
  }
}
async function load() {
  show("page-error", false);
  try {
    const [tasks, lists, preferences, calendar] = await Promise.all([
      api("GET", "/tasks"),
      api("GET", "/tasks/lists"),
      api("GET", "/tasks/preferences"),
      api("GET", "/tasks/local-day")
    ]);
    // Do not enable date edits without the confirmed account timezone.
    if (typeof calendar.timezone !== "string" || !calendar.timezone)
      throw new Error("Account timezone unavailable");
    localDay(new Date(), calendar.timezone);
    state.timeZone = calendar.timezone;
    state.tasks = tasks.tasks;
    state.lists = lists.lists;
    options("task-list", state.lists);
    $("view").value = viewMode(preferences.preferences.defaultView);
    show("overview", $("editor").hidden && $("lists-editor").hidden && $("tags-editor").hidden);
    render();
    $("notice").textContent = "Tasks are up to date.";
  } catch (error) {
    show("page-error", true);
    throw error;
  }
}
function taskRow(task) {
  const row = text("div", "", "tasks-row");
  const done = text("input", "");
  done.type = "checkbox";
  done.checked = task.status === "done";
  done.setAttribute("aria-label", `${done.checked ? "Reopen" : "Complete"} ${task.title}`);
  done.addEventListener("change", () => {
    done.checked = task.status === "done";
    void run(async () => {
      await api("PATCH", `/tasks/${task.id}`, { status: task.status === "done" ? "todo" : "done" });
      if (state.editing) await refreshDetails();
      else await load();
    });
  });
  const content = text("div", "", "tasks-row-title");
  content.append(button(task.title, () => openEditor(task.id), { variant: "link" }));
  const list = state.lists.find((item) => item.id === task.listId)?.name ?? "";
  const meta = [
    list,
    labels[task.status],
    task.dueAt ? `Due ${localDay(task.dueAt, state.timeZone)} (${state.timeZone})` : "",
    task.recurrence ? `Repeats ${task.recurrence.freq}` : "",
    ...task.tags.map((tag) => `#${tag.name}`)
  ].filter(Boolean);
  content.append(text("div", meta.join(" · "), "jds-caption"));
  const drift = driftMark(task, new Date(), state.timeZone);
  const marks = [
    effortLabel(task.effort) && `${effortLabel(task.effort)} effort`,
    isAssistantSource(task.source) && `From ${task.source}`
  ].filter(Boolean);
  if (drift || marks.length) {
    const line = text("div", "", "tasks-row-marks");
    if (drift) {
      const pill = text("span", "", `jds-drift jds-drift--${drift.kind}`);
      pill.append(text("span", "", "jds-drift__dot"), drift.label);
      line.append(pill);
    }
    if (marks.length) line.append(text("span", marks.join(" · "), "jds-caption"));
    content.append(line);
  }
  row.append(done, content);
  if (task.status === "suggested") {
    const actions = text("div", "", "tasks-actions");
    for (const [label, status] of [
      ["Accept", "todo"],
      ["Dismiss", "archived"]
    ]) {
      actions.append(
        button(label, async () => {
          await api("PATCH", `/tasks/${task.id}`, { status });
          await load();
        })
      );
    }
    row.append(actions);
  }
  return row;
}
function render() {
  const tasks = filters.apply(state.tasks, state.lists, state.timeZone);
  search.render(state.lists);
  const result = $("task-results");
  result.replaceChildren();
  result.className = $("view").value === "matrix" ? "tasks-matrix" : "";
  show("empty", tasks.length === 0);
  const tracked = trackingNote(assistantTrackedCount(tasks), state.assistantName);
  $("tracking-note").textContent = tracked;
  show("tracking-note", tracked !== "");
  for (const { title, subtitle, tasks: grouped } of taskGroups(tasks, $("view").value)) {
    const section = text("section", "", "tasks-section");
    const heading = text("h2", `${title} (${grouped.length})`);
    section.append(heading);
    if (subtitle) section.append(text("p", subtitle, "jds-caption"));
    for (const task of grouped) section.append(taskRow(task));
    if (!grouped.length) section.append(text("p", "Nothing here.", "jds-caption"));
    result.append(section);
  }
  void client.resize(document.documentElement.scrollHeight).catch(() => {});
}
function draftSnapshot() {
  return JSON.stringify(
    // Rendered subtask checkboxes are saved actions, not editor draft fields.
    // Capture's editable subtask rows are tracked in its own snapshot below.
    [...document.querySelectorAll("#editor input[id], #editor select[id], #editor textarea[id]")]
      .map((node) => [node.id, node.value])
      .concat([["capture-draft", capture.snapshot()]])
  );
}
function markSaved() {
  state.baseline = draftSnapshot();
}
function savedExtra(id) {
  state.baseline = JSON.stringify(
    JSON.parse(state.baseline).map(([key, value]) => [key, key === id ? "" : value])
  );
}
function hasDraft() {
  return (
    (!$("editor").hidden && state.baseline !== draftSnapshot()) ||
    (!$("lists-editor").hidden && (state.listDrafts.size > 0 || $("list-name").value !== "")) ||
    tags.hasDraft()
  );
}
function leaveEditor(action) {
  if (hasDraft()) {
    state.leave = action;
    show("discard-draft", true);
    state.focusAfter = $("keep-editing").querySelector("button");
  } else return action();
}
async function openEditor(id = null, title = "") {
  if (!state.timeZone) throw new Error("Reload Tasks to load the saved timezone");
  return leaveEditor(() => editTask(id, title));
}
async function editTask(id, title) {
  state.editorTimeZone = state.timeZone;
  const task = id ? (await api("GET", `/tasks/${id}`)).task : null;
  if ($("editor").hidden) state.returnFocus = state.actionFocus;
  state.editing = task;
  state.pendingTag = null;
  activity.reset(task?.id ?? null);
  details.reset(task);
  $("task-form").reset();
  capture.reset();
  show("new-task-extras", !task);
  for (const [name, value] of Object.entries(editorValues(task)))
    $("task-form").elements.namedItem(name).value = value;
  $("editor-heading").textContent = task ? "Task details" : "New task";
  show("overview", false);
  show("editor", true);
  show("edit-error", false);
  show("task-extras", false);
  for (const name of ["subtask-title", "tag-name", "comment"]) $(name).value = "";
  markSaved();
  if (!task) $("title").value = title;
  state.focusAfter = $("title");
  if (task) await extras();
  else await capture.loadTags($("task-list").value);
}
function closeEditor() {
  state.editing = null;
  capture.reset();
  show("editor", false);
  show("overview", true);
  render();
  if (state.returnFocus?.isConnected) state.focusAfter = state.returnFocus;
}
async function extras() {
  show("task-extras", true);
  await Promise.all([details.load(state.editing), activity.load()]);
}
function editorValues(task) {
  return {
    title: task?.title ?? "",
    description: task?.description ?? "",
    status: task?.status ?? "todo",
    priority: String(task?.priority ?? ""),
    effort: task?.effort ?? "",
    listId: task?.listId ?? filters.defaultListId(state.lists),
    dueAt: localDay(task?.dueAt, state.editorTimeZone),
    doAt: localDay(task?.doAt, state.editorTimeZone),
    repeat: task?.recurrence?.freq ?? "never"
  };
}
function reconcileEditor(task) {
  const values = editorValues(task);
  const baseline = new Map(JSON.parse(state.baseline));
  for (const [name, value] of Object.entries(values)) {
    const control = $("task-form").elements.namedItem(name);
    // Only untouched controls follow server changes. Keep the latest server value
    // as the baseline even when a local draft wins, so discard detection stays true.
    if (control.value === baseline.get(control.id)) control.value = value;
    baseline.set(control.id, value);
  }
  state.baseline = JSON.stringify([...baseline]);
  state.editing = task;
}
async function refreshDetails() {
  // A child completion can also complete its parent. Re-read it before updating
  // panels; a later form save must not write an obsolete status back over it.
  const current = await Promise.allSettled([api("GET", `/tasks/${state.editing.id}`)]);
  if (current[0].status === "fulfilled") reconcileEditor(current[0].value.task);
  // Even a failed task/overview refresh must not hide independently loaded panels.
  const results = await Promise.allSettled([load(), extras()]);
  const failed = [...current, ...results].find((result) => result.status === "rejected");
  if (failed) throw failed.reason;
}
function manageLists() {
  deleting.close();
  show("overview", false);
  show("lists-editor", true);
  $("list-names").replaceChildren(
    ...state.lists.map((list) => {
      const form = text("form", "", "tasks-inline");
      const label = text("label", `Rename ${list.name}`, "jds-label");
      const input = text("input", "", "jds-input");
      input.id = `rename-${list.id}`;
      label.htmlFor = input.id;
      input.value = state.listDrafts.get(list.id) ?? list.name;
      input.addEventListener("input", () => {
        if (input.value === list.name) state.listDrafts.delete(list.id);
        else state.listDrafts.set(list.id, input.value);
      });
      input.required = true;
      input.maxLength = 100;
      const save = text("button", "Save name", "jds-btn jds-btn--secondary");
      save.type = "submit";
      const remove = button(`Delete ${list.name}`, () => {
        if (state.lists.length <= 1) {
          $("notice").textContent = "Your last list is kept. Create another list first.";
          return;
        }
        leaveEditor(() => deleting.open(list));
      });
      remove.id = `delete-list-${list.id}`;
      form.append(
        label,
        input,
        save,
        button(`Manage tags in ${list.name}`, () => leaveEditor(() => tags.open(list))),
        remove
      );
      bindForm(form, async () => {
        await api("PATCH", `/tasks/lists/${list.id}`, { name: input.value });
        state.listDrafts.delete(list.id);
        await load();
        manageLists();
      });
      return form;
    })
  );
  state.focusAfter = $("list-name");
}
const actions = {
  "retry-new-tags": () => capture.loadTags($("task-list").value),
  "clear-filters": () => {
    search.clear();
    filters.clear();
  },
  "confirm-delete-list": () => deleting.confirm(),
  "keep-list": () => deleting.close(),
  reload: load,
  new: () => openEditor(),
  "close-editor": () => leaveEditor(closeEditor),
  "keep-editing": () => {
    show("discard-draft", false);
    state.leave = null;
    state.focusAfter = !$("tags-editor").hidden
      ? $("manage-tag-name")
      : $("editor").hidden
        ? $("list-name")
        : $("title");
  },
  "discard-changes": async () => {
    // A failed child write may already have persisted the parent and some parts.
    if (capture.started()) await load();
    const leave = state.leave;
    state.leave = null;
    show("discard-draft", false);
    state.listDrafts.clear();
    $("list-name").value = "";
    for (const list of state.lists) {
      const input = $(`rename-${list.id}`);
      if (input) input.value = list.name;
    }
    tags.discard();
    if (leave) await leave();
  },
  "manage-lists": manageLists,
  "close-tags": () =>
    leaveEditor(() => {
      tags.close();
      manageLists();
    }),
  "close-lists": () =>
    leaveEditor(() => {
      show("lists-editor", false);
      show("overview", true);
    }),
  chat: () =>
    client.chat(
      state.editing
        ? `Help me with task ${state.editing.id}: ${state.editing.title}`
        : "Help me plan my tasks"
    )
};
document.querySelectorAll("[data-action]").forEach((node) => {
  const action = actions[node.dataset.action];
  if (action) node.addEventListener("click", () => run(action));
});
$("task-list").addEventListener("change", () => {
  if (!state.editing) void run(() => capture.loadTags($("task-list").value));
});
$("list-options").addEventListener("toggle", () => {
  void client.resize(document.documentElement.scrollHeight).catch(() => {});
});
$("view").addEventListener("change", () =>
  run(async () => {
    await api("PATCH", "/tasks/preferences", { defaultView: $("view").value });
    await load();
  })
);
function bindForm(form, action) {
  const save = (event) => {
    event.preventDefault();
    if (form.reportValidity()) void run(action);
  };
  // The opaque package sandbox blocks native form submission before its submit
  // event. Handle submit-button activation (including implicit Enter clicks)
  // directly; all writes still use the authenticated public host bridge.
  form.querySelector('button[type="submit"]').addEventListener("click", save);
  form.addEventListener("submit", save);
}
function submit(id, action) {
  bindForm($(id), action);
}
submit("task-form", async () => {
  const form = Object.fromEntries(new FormData($("task-form")));
  // run() disables controls; FormData omits them, so read the named controls explicitly.
  for (const control of $("task-form").elements)
    if (control.name) form[control.name] = control.value;
  const previous = state.editing;
  const fields = taskFields(
    form,
    previous,
    previous ? undefined : capture.today(),
    state.editorTimeZone
  );
  const response = previous
    ? await api("PATCH", `/tasks/${previous.id}`, fields)
    : await capture.save(fields);
  state.editing = response.task;
  await load();
  closeEditor();
});
submit("subtask-form", async () => {
  await api("POST", "/tasks", {
    title: $("subtask-title").value,
    parentTaskId: state.editing.id,
    listId: state.editing.listId
  });
  $("subtask-title").value = "";
  savedExtra("subtask-title");
  await refreshDetails();
});
submit("tag-form", async () => {
  const name = $("tag-name").value.trim().replace(/^#/, "").toLowerCase();
  if (!state.pendingTag || state.pendingTag.name !== name) {
    state.pendingTag = await findOrCreateTag(api, state.editing.listId, name);
  }
  await api("POST", `/tasks/${state.editing.id}/tags`, { tagId: state.pendingTag.id });
  state.pendingTag = null;
  $("tag-name").value = "";
  savedExtra("tag-name");
  await refreshDetails();
});
submit("list-form", async () => {
  await api("POST", "/tasks/lists", { name: $("list-name").value });
  $("list-name").value = "";
  await load();
  manageLists();
});
void client
  .theme()
  .then((theme) => {
    if (typeof theme?.theme === "string") document.documentElement.dataset.theme = theme.theme;
    if (typeof theme?.colorMode === "string")
      document.documentElement.dataset.colorMode = theme.colorMode;
    // The host passes the signed-in name and the assistant's name along with the theme.
    $("task-assignee").textContent = assigneeLabel(theme?.displayName);
    if (typeof theme?.assistantName === "string") {
      state.assistantName = theme.assistantName;
      if (state.tasks) render();
    }
  })
  .catch(() => {});
window.addEventListener("beforeunload", (event) => {
  if (hasDraft()) {
    event.preventDefault();
    event.returnValue = "";
  }
});
window.addEventListener("pagehide", () => client.dispose(), { once: true });
void run(load);
