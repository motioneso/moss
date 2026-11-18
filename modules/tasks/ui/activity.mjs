/* global document */
// Activity reads fail independently of tags and subtasks. Only acknowledged posts
// clear the draft; a failed refresh retries the read without repeating the write.
export function taskActivity({ api, run, bindForm, saved, focus, text }) {
  const $ = (id) => document.getElementById(id);
  const show = (id, visible) => {
    $(id).hidden = !visible;
  };
  let taskId = null;
  function sync() {
    $("activity-form").querySelector('button[type="submit"]').disabled = !$("comment").value.trim();
  }
  function reset(id) {
    taskId = id;
    $("activity").replaceChildren();
    for (const id of ["activity-error", "comment-error", "activity-empty"]) show(id, false);
    sync();
  }
  async function load() {
    show("activity-loading", true);
    try {
      const result = await api("GET", `/tasks/${taskId}/activity`);
      const entries = result.activity.filter((item) => item.activityType === "comment");
      $("activity").replaceChildren(
        ...entries.map((item) =>
          text(
            "li",
            `${item.body ?? item.activityType} · ${item.createdAt.slice(0, 16).replace("T", " ")} UTC`,
            "tasks-comment-text"
          )
        )
      );
      show("activity-error", false);
      show("activity-empty", entries.length === 0);
    } catch {
      show("activity-error", true);
      show("activity-empty", false);
    } finally {
      show("activity-loading", false);
    }
  }
  async function post() {
    const body = $("comment").value.trim();
    if (!body || !taskId) return;
    show("comment-error", false);
    try {
      await api("POST", `/tasks/${taskId}/activity`, { activityType: "comment", body });
    } catch {
      show("comment-error", true);
      focus($("comment"));
      return;
    }
    $("comment").value = "";
    saved("comment");
    await load();
    focus($("comment"));
  }
  bindForm($("activity-form"), post);
  $("comment").addEventListener("input", sync);
  $("comment").addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      void run(post);
    }
  });
  document.querySelector('[data-action="retry-activity"]').addEventListener("click", () =>
    run(async () => {
      await load();
      focus($("comment"));
    })
  );
  return { reset, load, sync };
}
