/* global document */

// Keep the last server-confirmed value visible after failed reads or writes.
// Loading this preference must never block the task list or silently save a default.
export function taskSettings({ api, run, resize }) {
  const $ = (id) => document.getElementById(id);
  const toggle = $("assistant-auto-execute");
  const retry = $("retry-task-settings").querySelector("button");
  let confirmed = null;
  let pending = false;
  function sync() {
    toggle.checked = confirmed ?? false;
    toggle.disabled = pending || confirmed === null;
    retry.disabled = pending;
  }
  function accept(result) {
    if (typeof result?.enabled !== "boolean") throw new Error("Invalid task preference");
    confirmed = result.enabled;
  }
  async function load() {
    if (pending) return;
    pending = true;
    $("task-settings-saved").hidden = true;
    $("task-settings-loading").hidden = false;
    $("task-settings-load-error").hidden = true;
    sync();
    try {
      accept(await api("GET", "/tasks/agency-auto-execute"));
    } catch {
      $("task-settings-load-message").textContent =
        confirmed === null
          ? "Could not load task settings. Your saved preference is unavailable."
          : "Could not refresh task settings. Your last saved preference is shown.";
      $("task-settings-load-error").hidden = false;
    } finally {
      pending = false;
      $("task-settings-loading").hidden = true;
      sync();
      resize();
    }
  }
  toggle.addEventListener("change", () => {
    const enabled = toggle.checked;
    // run() serializes all page actions. Revert immediately in case another
    // action is already running and therefore this activation cannot be saved.
    sync();
    if (confirmed === null || pending) return;
    void run(async () => {
      pending = true;
      $("task-settings-save-error").hidden = true;
      $("task-settings-saved").hidden = true;
      sync();
      try {
        accept(await api("PATCH", "/tasks/agency-auto-execute", { enabled }));
        $("task-settings-saved").hidden = false;
      } catch {
        $("task-settings-save-error").hidden = false;
      } finally {
        pending = false;
        sync();
      }
    });
  });
  retry.addEventListener("click", () => void load());
  $("task-settings").addEventListener("toggle", () => {
    if ($("task-settings").open) void load();
    resize();
  });
  sync();
  return { sync };
}
