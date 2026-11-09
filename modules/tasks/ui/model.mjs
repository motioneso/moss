import { matchesSearchIntent } from "./search.mjs";

// Keep unchanged timestamps and recurrence rules byte-for-byte on unrelated edits.
// Date controls currently use UTC until the public actor-locale contract exists.
export function taskFields(form, previous = null, today = new Date().toISOString().slice(0, 10)) {
  const fields = {
    title: form.title.trim(),
    description: form.description || null,
    listId: form.listId,
    priority: form.priority ? Number(form.priority) : null,
    effort: form.effort || null
  };
  if (!previous || previous.status !== form.status) fields.status = form.status;
  for (const name of ["dueAt", "doAt"]) {
    if (!previous || form[name] !== (previous[name]?.slice(0, 10) ?? "")) {
      fields[name] = form[name] ? `${form[name]}T12:00:00.000Z` : null;
    }
  }
  if (!previous || form.repeat !== (previous.recurrence?.freq ?? "never")) {
    fields.recurrence =
      form.repeat === "never"
        ? null
        : {
            freq: form.repeat,
            interval: 1,
            occurrence_date: form.dueAt || today
          };
  }
  return fields;
}

export function filterTasks(
  tasks,
  { lists = [], listStates = {}, status = "todo", tagFilter = [], search = "", searchIntent = null }
) {
  const needle = (searchIntent ? (searchIntent.text ?? "") : search).trim().toLowerCase();
  const soloIds = lists.filter((list) => listStates[list.id] === "solo").map((list) => list.id);
  const listCounts = Object.fromEntries(lists.map((list) => [list.id, 0]));
  const allTags = new Set();
  const visible = [];
  for (const task of tasks) {
    for (const tag of task.tags) allTags.add(tag.name);
    if (task.parentTaskId !== null) continue;
    if (status !== "all" && task.status !== status) continue;
    // Manual tags are alternatives, matching the legacy screen's tag set.
    if (tagFilter.length && !task.tags.some((tag) => tagFilter.includes(tag.name))) continue;
    if (Object.hasOwn(listCounts, task.listId)) listCounts[task.listId]++;
    if (listStates[task.listId] === "excluded") continue;
    if (soloIds.length && !soloIds.includes(task.listId)) continue;
    if (
      needle &&
      !task.title.toLowerCase().includes(needle) &&
      !task.description?.toLowerCase().includes(needle)
    )
      continue;
    if (searchIntent && !matchesSearchIntent(task, searchIntent, quadrant(task))) continue;
    visible.push(task);
  }
  return {
    visibleTasks: visible,
    soloIds,
    listCounts,
    listCountTotal: Object.values(listCounts).reduce((sum, count) => sum + count, 0),
    allTags: [...allTags].sort((a, b) => a.localeCompare(b))
  };
}

// Retain the original single-picker interface for callers while sharing one filter model.
export function visibleTasks(tasks, { listId = "", tag = "", ...filters }) {
  return filterTasks(tasks, {
    ...filters,
    ...(listId ? { lists: [{ id: listId }], listStates: { [listId]: "solo" } } : {}),
    ...(tag ? { tagFilter: [tag] } : {})
  }).visibleTasks;
}

export function quadrant(task, now = Date.now()) {
  const important = task.priority !== null && task.priority >= 4;
  const urgent = task.dueAt !== null && Date.parse(task.dueAt) <= now + 48 * 3600 * 1000;
  return important ? (urgent ? "do" : "schedule") : urgent ? "delegate" : "eliminate";
}

export const quadrants = [
  ["do", "Do First", "Important & urgent"],
  ["schedule", "Schedule", "Important, not urgent"],
  ["delegate", "Delegate", "Urgent, not important"],
  ["eliminate", "Later", "Neither"]
];

// Match the existing persisted preference contract.
export const viewMode = (value) => (value === "matrix" ? "matrix" : "priority");

// Preserve the legacy screen's priority buckets and due-time/title ordering.
// Filter creates new arrays: changing a view must not reorder saved state.
function byDueThenTitle(a, b) {
  const left = a.dueAt ? Date.parse(a.dueAt) : Number.MAX_SAFE_INTEGER;
  const right = b.dueAt ? Date.parse(b.dueAt) : Number.MAX_SAFE_INTEGER;
  return left - right || a.title.localeCompare(b.title);
}

export const priorities = [
  [5, "Critical"],
  [4, "High"],
  [3, "Medium"],
  [2, "Low"],
  [1, "Someday"],
  [null, "No priority"]
];

export function taskGroups(tasks, view, now = Date.now()) {
  if (view === "matrix") {
    return quadrants.map(([key, title, subtitle]) => ({
      key,
      title,
      subtitle,
      tasks: tasks.filter((task) => quadrant(task, now) === key).sort(byDueThenTitle)
    }));
  }
  return priorities
    .map(([key, title]) => ({
      key,
      title,
      subtitle: "",
      tasks: tasks.filter((task) => task.priority === key).sort(byDueThenTitle)
    }))
    .filter((group) => group.tasks.length);
}
