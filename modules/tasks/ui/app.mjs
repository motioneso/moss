/* global document, window, Option */
import { moduleClient } from "./guest-bridge.mjs";
import { taskFields, visibleTasks, quadrant, quadrants, viewMode } from "./model.mjs";
import { tagManager } from "./tags.mjs";
import { listDeletion } from "./delete-list.mjs";

const client = moduleClient();
const $ = (id) => document.getElementById(id);
const state = {
  tasks: [],
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
const labels = { todo: "Open", done: "Done", suggested: "Suggested", archived: "Archived" };
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
    $("tasks-app").removeAttribute("aria-busy");
    state.focusAfter?.focus();
    state.focusAfter = null;
    void client.resize(document.documentElement.scrollHeight).catch(() => {});
  }
}
async function load() {
  show("page-error", false);
  try {
    const [tasks, lists, preferences] = await Promise.all([
      api("GET", "/tasks"),
      api("GET", "/tasks/lists"),
      api("GET", "/tasks/preferences")
    ]);
    state.tasks = tasks.tasks;
    state.lists = lists.lists;
    options("list-filter", state.lists, "All lists");
    options("task-list", state.lists);
    const tags = [
      ...new Set(state.tasks.flatMap((task) => task.tags.map((tag) => tag.name)))
    ].sort();
    options(
      "tag-filter",
      tags.map((name) => ({ id: name, name })),
      "All tags"
    );
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
      await load();
      if (state.editing) await extras();
    });
  });
  const content = text("div", "", "tasks-row-title");
  content.append(button(task.title, () => openEditor(task.id), { variant: "link" }));
  const list = state.lists.find((item) => item.id === task.listId)?.name ?? "";
  const meta = [
    list,
    labels[task.status],
    task.dueAt ? `Due ${task.dueAt.slice(0, 10)} (UTC)` : "",
    task.recurrence ? `Repeats ${task.recurrence.freq}` : "",
    ...task.tags.map((tag) => `#${tag.name}`)
  ].filter(Boolean);
  content.append(text("div", meta.join(" · "), "jds-caption"));
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
  const tasks = visibleTasks(state.tasks, {
    listId: $("list-filter").value,
    status: $("status-filter").value,
    tag: $("tag-filter").value,
    search: $("search").value
  });
  const result = $("task-results");
  result.replaceChildren();
  result.className = $("view").value === "matrix" ? "tasks-matrix" : "";
  show("empty", tasks.length === 0);
  const groups =
    $("view").value === "matrix" ? quadrants : state.lists.map((list) => [list.id, list.name, ""]);
  for (const [key, title, subtitle] of groups) {
    const grouped = tasks.filter((task) =>
      $("view").value === "matrix" ? quadrant(task) === key : task.listId === key
    );
    if (!grouped.length && $("view").value === "priority") continue;
    const section = text("section", "", "tasks-section");
    const heading = text("h2", `${title} (${grouped.length})`);
    section.append(heading);
    if (subtitle) section.append(text("p", subtitle, "jds-caption"));
    for (const task of grouped) section.append(taskRow(task));
    if (!grouped.length) section.append(text("p", "Nothing here.", "jds-caption"));
    result.append(section);
  }
}
function draftSnapshot() {
  return JSON.stringify(
    [...document.querySelectorAll("#editor input, #editor select, #editor textarea")].map(
      (node) => [node.id, node.value]
    )
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
async function openEditor(id = null) {
  return leaveEditor(() => editTask(id));
}
async function editTask(id) {
  const task = id ? (await api("GET", `/tasks/${id}`)).task : null;
  if ($("editor").hidden) state.returnFocus = state.actionFocus;
  state.editing = task;
  state.pendingTag = null;
  $("task-form").reset();
  const defaults = {
    title: "",
    description: "",
    status: "todo",
    priority: "",
    effort: "",
    listId: $("list-filter").value || state.lists[0]?.id || ""
  };
  for (const key of Object.keys(defaults))
    $("task-form").elements.namedItem(key).value = task?.[key] ?? defaults[key];
  $("due-at").value = task?.dueAt?.slice(0, 10) ?? "";
  $("do-at").value = task?.doAt?.slice(0, 10) ?? "";
  $("repeat").value = task?.recurrence?.freq ?? "never";
  $("editor-heading").textContent = task ? "Task details" : "New task";
  show("overview", false);
  show("editor", true);
  show("edit-error", false);
  show("task-extras", false);
  for (const name of ["subtask-title", "tag-name", "comment"]) $(name).value = "";
  markSaved();
  state.focusAfter = $("title");
  if (task) await extras();
}
function closeEditor() {
  state.editing = null;
  show("editor", false);
  show("overview", true);
  render();
  if (state.returnFocus?.isConnected) state.focusAfter = state.returnFocus;
}
async function extras() {
  const task = state.editing;
  const [subtasks, tags, activity] = await Promise.all([
    api("GET", `/tasks/${task.id}/subtasks`),
    api("GET", `/tasks/lists/${task.listId}/tags`),
    api("GET", `/tasks/${task.id}/activity`)
  ]);
  $("subtasks").replaceChildren(...subtasks.tasks.map(taskRow));
  $("activity").replaceChildren(
    ...activity.activity.map((item) =>
      text(
        "li",
        `${item.body ?? item.activityType} · ${item.createdAt.slice(0, 16).replace("T", " ")} UTC`
      )
    )
  );
  const assigned = new Set(task.tags.map((tag) => tag.id));
  $("task-tags").replaceChildren(
    ...tags.tags.map((tag) =>
      button(
        `#${tag.name}`,
        async () => {
          if (assigned.has(tag.id)) await api("DELETE", `/tasks/${task.id}/tags/${tag.id}`);
          else await api("POST", `/tasks/${task.id}/tags`, { tagId: tag.id });
          await refreshEditor();
        },
        { pressed: assigned.has(tag.id), variant: assigned.has(tag.id) ? "primary" : "secondary" }
      )
    )
  );
  show("task-extras", true);
}
async function refreshEditor() {
  state.editing = (await api("GET", `/tasks/${state.editing.id}`)).task;
  await load();
  await extras();
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
document
  .querySelectorAll("[data-action]")
  .forEach((node) => node.addEventListener("click", () => run(actions[node.dataset.action])));
for (const id of ["list-filter", "status-filter", "tag-filter", "search"])
  $(id).addEventListener("input", render);
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
  const response = await api(
    previous ? "PATCH" : "POST",
    previous ? `/tasks/${previous.id}` : "/tasks",
    taskFields(form, previous)
  );
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
  await refreshEditor();
});
submit("tag-form", async () => {
  const name = $("tag-name").value.trim().replace(/^#/, "").toLowerCase();
  if (!state.pendingTag || state.pendingTag.name !== name) {
    state.pendingTag = (
      await api("POST", `/tasks/lists/${state.editing.listId}/tags`, { name })
    ).tag;
  }
  await api("POST", `/tasks/${state.editing.id}/tags`, { tagId: state.pendingTag.id });
  state.pendingTag = null;
  $("tag-name").value = "";
  savedExtra("tag-name");
  await refreshEditor();
});
submit("activity-form", async () => {
  await api("POST", `/tasks/${state.editing.id}/activity`, {
    activityType: "comment",
    body: $("comment").value
  });
  $("comment").value = "";
  savedExtra("comment");
  await extras();
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
