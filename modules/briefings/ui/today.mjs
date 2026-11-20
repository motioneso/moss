/* global document, ResizeObserver, window, CSS */
import { moduleClient } from "./guest-bridge.mjs";
import { briefingsApi } from "./api.mjs";
import { CATCH_UP_FAILED, sectionHtml } from "./today-view.mjs";
import { replyPrompt } from "./view.mjs";

const root = document.getElementById("root");
const client = moduleClient();
const api = briefingsApi(client);
const locale = navigator.language || undefined;
const state = {
  phase: "loading",
  data: null,
  busy: "",
  error: "",
  // In-memory only. After a reload the saved ratings decide what shows.
  catchState: { marks: {}, expanded: false, failed: "" }
};
let lastHeight = -1;

// Measured at once rather than on the next frame, because the browser does not run frames for a
// frame that sits below the fold, which would leave its rows clipped until scrolled into view.
function resize() {
  const height = Math.ceil(root.getBoundingClientRect().bottom + window.scrollY);
  if (height !== lastHeight) {
    lastHeight = height;
    void client.resize(height).catch(() => {});
  }
}

function draw() {
  const focused = document.activeElement?.closest?.("[data-task]")?.dataset.task;
  root.innerHTML = sectionHtml(state, locale);
  if (focused && !state.busy)
    root.querySelector(`[data-task="${CSS.escape(focused)}"] [data-act]`)?.focus();
  resize();
}

async function load() {
  try {
    state.data = await api.today();
    state.phase = "ready";
  } catch {
    state.phase = "error";
  }
  draw();
}

async function act(taskId, action) {
  if (state.busy) return;
  state.busy = taskId;
  state.error = "";
  draw();
  try {
    await api.triage(taskId, action);
  } catch {
    state.error = "Could not save that. Try again.";
  }
  state.busy = "";
  // The saved state decides what shows, so a refused or lost change reads true after the reload.
  await load();
}

async function catchAct(itemId, action) {
  if (state.busy) return;
  const marks = state.catchState.marks;
  const mark = marks[itemId] ?? {};
  const runId = state.data.run.id;
  state.busy = itemId;
  state.catchState.failed = "";
  draw();
  try {
    if (action === "undo") {
      await api.catchUp(runId, itemId, "undo", {
        ...(mark.feedbackId ? { feedbackId: mark.feedbackId } : {}),
        ...(mark.taskId ? { taskId: mark.taskId } : {})
      });
      delete marks[itemId];
    } else {
      const body = mark.stray ? { strayTaskId: mark.stray } : {};
      const done = await api.catchUp(runId, itemId, action, body);
      marks[itemId] = { status: done.status, feedbackId: done.feedbackId, taskId: done.taskId };
    }
  } catch (error) {
    state.catchState.failed = error?.status === 404 ? error.message : CATCH_UP_FAILED;
    // A failed rating can leave a task behind. Keep its id so a retry reuses it.
    if (error?.taskId) marks[itemId] = { ...mark, stray: error.taskId };
  }
  state.busy = "";
  draw();
}

root.addEventListener("click", (event) => {
  const catchButton = event.target.closest?.("[data-catch]");
  if (catchButton && !catchButton.disabled) {
    if (catchButton.dataset.catch === "more") {
      state.catchState.expanded = true;
      draw();
    } else {
      void catchAct(catchButton.closest("[data-entry]").dataset.entry, catchButton.dataset.catch);
    }
    return;
  }
  const button = event.target.closest?.("[data-act], [data-reply]");
  if (!button || button.disabled) return;
  if (button.dataset.reply) {
    void client.chat(replyPrompt(button.dataset.reply)).catch(() => {});
  } else if (button.dataset.act === "retry") {
    state.phase = "loading";
    draw();
    void load();
  } else {
    void act(button.closest("[data-task]").dataset.task, button.dataset.act);
  }
});
const observer = new ResizeObserver(resize);
observer.observe(root);
window.addEventListener(
  "pagehide",
  () => {
    observer.disconnect();
    client.dispose();
  },
  { once: true }
);
void client
  .theme()
  .then((theme) => {
    document.documentElement.dataset.theme = theme.theme;
    document.documentElement.dataset.colorMode = theme.colorMode;
  })
  .catch(() => {});
draw();
void load();
void document.fonts.ready.then(resize);
