/* global document */
// The route and package currently use UTC; actor-local days await the public locale port.
export function matchesSearchIntent(task, intent, taskQuadrant) {
  if (intent.status && task.status !== intent.status) return false;
  if (intent.effort && task.effort !== intent.effort) return false;
  if (intent.priority !== null && task.priority !== intent.priority) return false;
  if (intent.quadrant && taskQuadrant !== intent.quadrant) return false;
  if (intent.listIds.length && !intent.listIds.includes(task.listId)) return false;
  if (intent.tagNames.length) {
    const names = new Set(task.tags.map((tag) => tag.name.toLowerCase()));
    if (!intent.tagNames.every((name) => names.has(name.toLowerCase()))) return false;
  }
  const due = intent.due;
  if (!due) return true;
  if (due.kind === "none") return task.dueAt === null;
  if (!task.dueAt) return false;
  const today = new Date().toISOString().slice(0, 10);
  const key = new Date(task.dueAt).toISOString().slice(0, 10);
  if (due.kind === "overdue") return key < today;
  if (due.kind === "today") return key === today;
  if (due.kind === "this_week") {
    const end = new Date(`${today}T00:00:00.000Z`);
    end.setUTCDate(end.getUTCDate() + 6);
    return key >= today && key <= end.toISOString().slice(0, 10);
  }
  return (
    (due.dueAfter === null || key >= due.dueAfter) &&
    (due.dueBefore === null || key <= due.dueBefore)
  );
}

export function hasSearchIntent(intent) {
  return Boolean(
    intent.text ||
    intent.effort ||
    intent.priority !== null ||
    intent.quadrant ||
    intent.due ||
    intent.listIds.length ||
    intent.tagNames.length
  );
}
function dueLabel(due) {
  if (due.kind === "none") return "No due date";
  if (due.kind === "overdue") return "Due: overdue";
  if (due.kind === "today") return "Due: today";
  if (due.kind === "this_week") return "Due: this week";
  if (due.dueAfter && due.dueBefore) return `Due: ${due.dueAfter} to ${due.dueBefore}`;
  if (due.dueAfter) return `Due after: ${due.dueAfter}`;
  if (due.dueBefore) return `Due before: ${due.dueBefore}`;
  return "Due date";
}
export function searchChips(intent, lists) {
  if (!intent) return [];
  return [
    ...["text", "effort", "priority", "quadrant"]
      .filter((key) => intent[key] !== null && intent[key] !== "")
      .map((key) => ({ key, label: `${key[0].toUpperCase()}${key.slice(1)}: ${intent[key]}` })),
    ...(intent.due ? [{ key: "due", label: dueLabel(intent.due) }] : []),
    ...intent.listIds.map((id) => ({
      key: `list:${id}`,
      label: `List: ${lists.find((list) => list.id === id)?.name ?? id}`
    })),
    ...intent.tagNames.map((name) => ({ key: `tag:${name}`, label: `#${name}` }))
  ];
}
export function removeSearchChip(intent, key) {
  const next = key.startsWith("list:")
    ? { ...intent, listIds: intent.listIds.filter((id) => id !== key.slice(5)) }
    : key.startsWith("tag:")
      ? { ...intent, tagNames: intent.tagNames.filter((name) => name !== key.slice(4)) }
      : { ...intent, [key]: null };
  return hasSearchIntent(next) ? next : null;
}

export function interpretedSearch({ api, run, changed, focus }) {
  const $ = (id) => document.getElementById(id);
  let intent = null;
  let warning = "";
  function clear() {
    intent = null;
    warning = "";
  }
  $("search").addEventListener("input", () => {
    clear();
    changed();
  });
  async function interpret() {
    const query = $("search").value.trim();
    if (!query) return;
    try {
      const response = await api("POST", "/tasks/search/interpret", { query });
      if (response.intent.status) $("status-filter").value = response.intent.status;
      const next = { ...response.intent, status: null };
      intent = hasSearchIntent(next) ? next : null;
      warning = response.warnings[0] ?? (intent ? "" : "No structured filter found.");
    } catch {
      intent = null;
      warning =
        "Natural-language filtering is unavailable. You can still search by title or description.";
    }
    changed();
    focus($("search"));
  }
  $("interpret-search").addEventListener("click", () => run(interpret));
  $("search").addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void run(interpret);
    }
  });
  return {
    intent: () => intent,
    clear,
    render(lists) {
      $("search-warning").textContent = warning;
      $("search-warning").hidden = !warning;
      $("search-intent").replaceChildren(
        ...searchChips(intent, lists).map(({ key, label }) => {
          const button = document.createElement("button");
          button.type = "button";
          button.className = "jds-btn jds-btn--secondary";
          button.textContent = `${label} ×`;
          button.setAttribute("aria-label", `Remove filter ${label}`);
          button.addEventListener("click", () =>
            run(() => {
              intent = removeSearchChip(intent, key);
              changed();
              focus($("search"));
            })
          );
          return button;
        })
      );
    }
  };
}
