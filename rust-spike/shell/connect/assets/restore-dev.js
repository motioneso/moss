/* global window, document, fetch */
"use strict";
// Transport for the real dev example; native builds use wry IPC and the OS file chooser.
window.ipc = {
  async postMessage(body) {
    const action = JSON.parse(body);
    if (action.do === "restore-run") window.moss.show({ screen: "restoring" });
    const response = await fetch("/action", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body
    });
    if (!response.ok) {
      window.moss.show({
        screen: "restore",
        error: "Moss could not finish restoring. Try again.",
        code: "app_restore_failed"
      });
      return;
    }
    const state = await response.json();
    if (state.open) window.location.assign(state.open);
    else window.moss.show(state);
  }
};
window.mossRestoreChoose = () => {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".mossbak";
  input.setAttribute("aria-label", "Choose backup file");
  input.hidden = true;
  document.body.append(input);
  input.addEventListener("change", async () => {
    if (input.files.length) {
      const response = await fetch("/choose", {
        method: "POST",
        headers: { "x-moss-filename": input.files[0].name },
        body: input.files[0]
      });
      window.moss.show(await response.json());
    }
    input.remove();
  });
  input.click();
};
