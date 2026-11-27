/* global el, heading, muted, button, post */
"use strict";

// Approved M5 New computer panel. Selection belongs to the shell, never a backups list.
function restoreScreen(s) {
  const words = el("textarea", {
    class: "jds-input",
    id: "restore-words",
    "aria-label": "Recovery key words",
    rows: "4",
    autocomplete: "off",
    autocapitalize: "none",
    spellcheck: "false"
  });
  const facts = s.facts || {};
  const restore = button("Restore", "primary", () => {
    const value = words.value;
    words.value = "";
    post({ do: "restore-run", words: value });
  });
  restore.disabled = !facts.file;
  const choose = button("Choose file", "secondary", () => {
    if (window.mossRestoreChoose) window.mossRestoreChoose();
    else post({ do: "restore-pick" });
  });
  const definition = el("dl", { class: "restore-facts" });
  for (const [label, value] of [
    ["From", facts.machine ? `Moss on ${facts.machine}` : "Choose a backup file"],
    ["Made", facts.made ? new Date(facts.made * 1000).toLocaleString() : "—"],
    ["Version", facts.version || "—"],
    ["Accounts", facts.accounts ?? "—"],
    ["Restores to", "A new Moss on this computer"]
  ]) {
    definition.append(el("dt", {}, label), el("dd", {}, String(value)));
  }
  return [
    heading("Restore a backup"),
    el(
      "div",
      { class: "restore-split" },
      el(
        "div",
        { class: "restore-form" },
        el(
          "div",
          { class: "restore-file" },
          el("div", {}, el("strong", {}, "Backup file"), muted(facts.file || "No file chosen")),
          choose
        ),
        el(
          "div",
          { class: "jds-field" },
          el("label", { class: "jds-label", for: "restore-words" }, "Recovery key"),
          words
        ),
        s.error
          ? el("p", { class: "connect-error", role: "alert", "data-code": s.code }, s.error)
          : "",
        el(
          "div",
          { class: "connect-actions" },
          button("Back", "quiet", () => post({ do: "first-run" })),
          restore
        )
      ),
      el(
        "div",
        {},
        el("p", { class: "jds-eyebrow" }, "This backup"),
        definition,
        muted(s.destination),
        muted(
          "Your existing Moss stays as it is. Sign in with your restored account after Restore."
        )
      )
    )
  ];
}

function restoringScreen() {
  return [
    heading("Restoring your Moss"),
    muted("Checking the backup and restoring to a new Moss on this computer…"),
    el("p", { role: "status" }, "Keep Moss open until this finishes.")
  ];
}

function restoreDoneScreen() {
  return [
    heading("Your Moss is ready"),
    muted("Your backup has been restored. Sign in with your existing Moss account."),
    el(
      "div",
      { class: "connect-actions" },
      button("Sign in", "primary", () => post({ do: "restore-open" }))
    )
  ];
}
