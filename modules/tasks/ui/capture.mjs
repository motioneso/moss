/* global document */
import { tagSuggestions } from "./task-tags.mjs";
export const normalizeTagName = (value) => value.trim().replace(/^#/, "").toLowerCase();
export const cleanSubtasks = (values) => values.map((value) => value.trim()).filter(Boolean);

// Keep receipts for acknowledged writes. A lost response still needs server-side
// idempotency; this cannot promise exactly-once delivery across network failures.
export function newTaskSave(api) {
  let progress = null;
  return {
    started: () => progress !== null,
    reset: () => {
      progress = null;
    },
    async save(fields, draft) {
      if (!progress) {
        const result = await api("POST", "/tasks", fields);
        progress = {
          task: result.task,
          fields: structuredClone(fields),
          steps: cleanSubtasks(draft.steps),
          // Draft tags were normalized when committed in the editor.
          tags: [...new Set(draft.tags.filter(Boolean))],
          subtasksDone: false,
          tagIds: new Map(),
          assigned: new Set()
        };
      } else {
        // Compare with acknowledged input, not the returned task: completing a
        // recurring task can advance its schedule server-side. Replaying the old
        // status/schedule during a child retry would undo that advance.
        const changes = Object.fromEntries(
          Object.entries(fields).filter(
            ([key, value]) =>
              key !== "listId" && JSON.stringify(value) !== JSON.stringify(progress.fields[key])
          )
        );
        if (Object.keys(changes).length) {
          const result = await api("PATCH", `/tasks/${progress.task.id}`, changes);
          progress.task = result.task;
          Object.assign(progress.fields, structuredClone(changes));
        }
      }
      const p = progress;
      if (p.steps.length && !p.subtasksDone) {
        await api("POST", `/tasks/${p.task.id}/breakdown`, { steps: p.steps });
        p.subtasksDone = true;
      }
      const tagPath = `/tasks/lists/${p.task.listId}/tags`;
      let available = p.tags.some((name) => !p.tagIds.has(name))
        ? (await api("GET", tagPath)).tags
        : [];
      const matching = (name) =>
        available.find((tag) => tag.name.toLowerCase() === name.toLowerCase());
      for (const name of p.tags) {
        if (p.assigned.has(name)) continue;
        if (!p.tagIds.has(name)) {
          let tag = matching(name);
          if (!tag) {
            try {
              tag = (await api("POST", tagPath, { name })).tag;
            } catch (error) {
              // A concurrent creator (or a lost creation response) may have won.
              // Reuse only a tag actually returned by the public list route.
              available = (await api("GET", tagPath)).tags;
              tag = matching(name);
              if (!tag) throw error;
            }
          }
          p.tagIds.set(name, tag.id);
        }
        await api("POST", `/tasks/${p.task.id}/tags`, { tagId: p.tagIds.get(name) });
        p.assigned.add(name);
      }
      return { task: p.task };
    }
  };
}

export function captureDraft({ api, run, text, button, focus }) {
  const $ = (id) => document.getElementById(id);
  const save = newTaskSave(api);
  let steps = [];
  let tags = [];
  let available = [];
  function lock() {
    const locked = save.started();
    $("task-list").disabled = locked;
    $("capture-progress").hidden = !locked;
    $("new-task-extras")
      .querySelectorAll("input, button")
      .forEach((node) => {
        node.disabled = locked;
      });
  }
  function renderSuggestions() {
    const target = $("new-tag-suggestions");
    target.replaceChildren(
      ...tagSuggestions(available, tags).map((tag) =>
        button(`Add #${tag.name}`, () => {
          // Existing names are values, not uncommitted input to normalize again.
          const name = tag.name.toLowerCase();
          if (!tags.includes(name)) tags.push(name);
          render();
          focus($("new-tag-name"));
        })
      )
    );
    lock();
  }
  async function loadTags(listId) {
    available = [];
    renderSuggestions();
    const warning = $("new-tags-error");
    warning.hidden = true;
    if (!listId) return;
    try {
      available = (await api("GET", `/tasks/lists/${listId}/tags`)).tags;
    } catch {
      warning.hidden = false;
    }
    renderSuggestions();
  }
  function render() {
    $("new-subtasks").replaceChildren(
      ...steps.map((value, index) => {
        const row = text("div", "", "tasks-inline");
        const input = text("input", "", "jds-input");
        input.value = value;
        input.maxLength = 500;
        input.setAttribute("aria-label", `Subtask ${index + 1}`);
        input.addEventListener("input", () => {
          steps[index] = input.value;
        });
        row.append(
          input,
          button(`Remove subtask ${index + 1}`, () => {
            steps.splice(index, 1);
            render();
            focus($("add-new-subtask").querySelector("button"));
          })
        );
        return row;
      })
    );
    $("new-tags").replaceChildren(
      ...tags.map((name) =>
        button(`Remove #${name}`, () => {
          tags = tags.filter((tag) => tag !== name);
          render();
          focus($("new-tag-name"));
        })
      )
    );
    renderSuggestions();
    lock();
  }
  function addTag({ moveFocus = true } = {}) {
    const name = normalizeTagName($("new-tag-name").value);
    if (!name) return;
    if (!tags.includes(name)) tags.push(name);
    $("new-tag-name").value = "";
    render();
    if (moveFocus) focus($("new-tag-name"));
  }
  $("add-new-subtask").addEventListener("click", () =>
    run(() => {
      steps.push("");
      render();
      focus($("new-subtasks").lastElementChild.querySelector("input"));
    })
  );
  $("add-new-tag").addEventListener("click", () => run(addTag));
  $("new-tag-name").addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === ",") {
      event.preventDefault();
      if (!save.started()) void run(addTag);
    }
  });
  // Enter in a subtask draft must not submit the parent form implicitly.
  $("new-subtasks").addEventListener("keydown", (event) => {
    if (event.key === "Enter") event.preventDefault();
  });
  return {
    lock,
    loadTags,
    started: save.started,
    snapshot: () => JSON.stringify({ steps, tags }),
    reset() {
      steps = [];
      tags = [];
      available = [];
      $("new-tags-error").hidden = true;
      save.reset();
      $("new-tag-name").value = "";
      render();
    },
    async save(fields) {
      // Include a tag still in the input when Save task is clicked.
      if (!save.started()) addTag({ moveFocus: false });
      try {
        return await save.save(fields, { steps, tags });
      } catch (error) {
        focus(document.querySelector('#task-form button[type="submit"]'));
        throw error;
      } finally {
        lock();
      }
    }
  };
}
