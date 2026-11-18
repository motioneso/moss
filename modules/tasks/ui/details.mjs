/* global document */
// Detail reads recover separately. A failed refresh retains the last successful
// rows; opening another task clears them before its first request.
export function taskDetails({ api, run, taskRow, tagButton, focus, isBusy }) {
  const $ = (id) => document.getElementById(id);
  const show = (id, visible) => {
    $(id).hidden = !visible;
  };
  let task = null;
  let listTags = [];
  let staleSubtasks = false;
  function sync() {
    $("subtasks")
      .querySelectorAll("button, input")
      .forEach((node) => {
        node.disabled = staleSubtasks || isBusy();
      });
  }
  function renderTags() {
    const assigned = new Set(task.tags.map((tag) => tag.id));
    const tags = new Map([...task.tags, ...listTags].map((tag) => [tag.id, tag]));
    $("task-tags").replaceChildren(
      ...[...tags.values()].map((tag) => tagButton(tag, assigned.has(tag.id)))
    );
  }
  function reset(next) {
    task = next;
    listTags = [];
    staleSubtasks = false;
    $("subtasks").replaceChildren();
    $("task-tags").replaceChildren();
    for (const name of ["subtasks", "task-tags"]) {
      for (const suffix of ["error", "empty", "loading"]) show(`${name}-${suffix}`, false);
    }
    if (task) renderTags();
  }
  async function read(name, path, apply) {
    show(`${name}-loading`, true);
    try {
      const result = await api("GET", path);
      const empty = apply(result);
      show(`${name}-empty`, empty);
      show(`${name}-error`, false);
      if (name === "subtasks") staleSubtasks = false;
    } catch {
      if (name === "subtasks") staleSubtasks = true;
      show(`${name}-error`, true);
      show(`${name}-empty`, false);
    } finally {
      show(`${name}-loading`, false);
      sync();
    }
  }
  function subtasks() {
    return read("subtasks", `/tasks/${task.id}/subtasks`, ({ tasks }) => {
      $("subtasks").replaceChildren(...tasks.map(taskRow));
      return tasks.length === 0;
    });
  }
  function tags() {
    return read("task-tags", `/tasks/lists/${task.listId}/tags`, (result) => {
      listTags = result.tags;
      renderTags();
      return task.tags.length === 0 && listTags.length === 0;
    });
  }
  for (const [name, load] of [
    ["subtasks", subtasks],
    ["task-tags", tags]
  ]) {
    document.querySelector(`[data-action="retry-${name}"]`).addEventListener("click", () =>
      run(async () => {
        await load();
        if ($(`${name}-error`).hidden) focus($(name === "subtasks" ? "subtask-title" : "tag-name"));
      })
    );
  }
  return {
    reset,
    sync,
    async load(next) {
      task = next;
      // A task refresh may change assignments even if suggestions cannot refresh.
      renderTags();
      await Promise.all([subtasks(), tags()]);
    }
  };
}
