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

export function visibleTasks(tasks, { listId = "", status = "todo", tag = "", search = "" }) {
  const needle = search.trim().toLowerCase();
  return tasks.filter(
    (task) =>
      !task.parentTaskId &&
      (!listId || task.listId === listId) &&
      (status === "all" || task.status === status) &&
      (!tag || task.tags.some((item) => item.name === tag)) &&
      (!needle || `${task.title}\n${task.description ?? ""}`.toLowerCase().includes(needle))
  );
}

export function quadrant(task, now = Date.now()) {
  const important = task.priority !== null && task.priority >= 4;
  const urgent = task.dueAt !== null && Date.parse(task.dueAt) <= now + 48 * 3600 * 1000;
  return important ? (urgent ? "do" : "schedule") : urgent ? "delegate" : "eliminate";
}

export const quadrants = [
  ["do", "Do first", "Important and urgent"],
  ["schedule", "Schedule", "Important, less urgent"],
  ["delegate", "Delegate", "Urgent, less important"],
  ["eliminate", "Eliminate", "Less urgent, less important"]
];

// Match the existing persisted preference contract.
export const viewMode = (value) => (value === "matrix" ? "matrix" : "priority");
