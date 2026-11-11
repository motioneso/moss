/* global document */
// Keep the static status visible until both the bridge and the Rust screen start.
// Dynamic imports let a failed JS download reach the same fallback as failed Wasm.
const startup = document.querySelector("#email-startup");
try {
  const [{ default: init }] = await Promise.all([import("./email.js"), import("./bridge.mjs")]);
  await init({ module_or_path: new URL("./email_bg.wasm", import.meta.url) });
  startup?.remove();
} catch {
  startup?.setAttribute("role", "alert");
  if (startup) {
    startup.querySelector(".jds-empty__title").textContent = "Email settings could not start";
    startup.querySelector(".jds-empty__sub").textContent =
      "Use Reload page above to try again. Nothing has been changed.";
  }
}
