/* global document */

// Acknowledged creation and list refresh are separate steps: only retry the latter
// if the task was saved but the following read failed. Lost create responses still
// need server idempotency before they can be retried without ambiguity.
export function quickCapture({ api, run, load, bindForm, defaultListId, openDetails, focus }) {
  const title = document.getElementById("quick-title");
  const form = document.getElementById("quick-task-form");
  const add = form.querySelector('button[type="submit"]');
  const details = document.getElementById("quick-details").querySelector("button");
  const error = document.getElementById("quick-error");
  let savedTitle = null;
  function sync() {
    add.disabled = savedTitle === null && !title.value.trim();
    add.textContent = savedTitle === null ? "Add task" : "Refresh saved task";
    title.disabled = savedTitle !== null;
    details.disabled = savedTitle !== null;
  }
  title.addEventListener("input", sync);
  bindForm(form, async () => {
    const submitted = title.value.trim();
    if (savedTitle === null && !submitted) return;
    error.hidden = true;
    try {
      if (savedTitle === null) {
        const listId = defaultListId();
        await api("POST", "/tasks", { title: submitted, ...(listId ? { listId } : {}) });
        savedTitle = submitted;
      }
      await load();
      if (title.value.trim() === savedTitle) title.value = "";
      savedTitle = null;
      focus(title);
    } catch {
      error.textContent =
        savedTitle === null
          ? "Could not add the task. Your title is kept. Check your connection and try again."
          : "Your task was saved, but the list could not refresh. Choose Refresh saved task to load it without creating another task.";
      error.hidden = false;
      focus(savedTitle === null ? title : add);
    }
    sync();
  });
  details.addEventListener("click", () => run(() => openDetails(title.value)));
  sync();
  return { sync };
}
