import { h, icon, PATHS, sectionHead, button, linkButton } from "./dom.mjs";

const label = (core) => core.charAt(0).toUpperCase() + core.slice(1);
const CORES = /^[a-z]{1,20}$/;

/** Note dates show as a short month and day, or "Today" when the note has none yet. */
export function noteDate(iso, locale = {}) {
  if (!iso) return "Today";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "Today";
  try {
    return new Intl.DateTimeFormat(locale.locale, {
      month: "short",
      day: "numeric",
      timeZone: locale.timezone
    }).format(date);
  } catch {
    return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date);
  }
}

/** Draws "For your next session" into `root`. Note text stays in the page and never leaves
 * through logs or errors. Returns `{ refresh }`. */
export function renderTherapyNotes(root, { api, locale = {} }) {
  let run = 0;
  let saving = false;
  const textarea = h("textarea", {
    rows: 1,
    "aria-label": "Note for your next session",
    placeholder: "Something to talk through…"
  });
  const add = button("Add", { class: "jds-btn jds-btn--primary wl-fs13", disabled: true });
  add.style.cssText = "padding: 5px 12px; min-height: unset";
  const problem = h("div", {
    class: "wl-modal__note wl-modal__note--error",
    role: "alert",
    hidden: true
  });
  const list = h("div", { class: "wl-tnotes" });

  const sync = () => {
    add.disabled = saving || textarea.value.trim() === "";
  };

  async function save() {
    const text = textarea.value.trim();
    if (!text || saving) return;
    saving = true;
    sync();
    problem.hidden = true;
    try {
      await api.call("POST", "/wellness/therapy-notes", { body: text });
      textarea.value = "";
      await refresh();
    } catch {
      problem.textContent = "Couldn't save that note. It's still in the box, so try again.";
      problem.hidden = false;
    } finally {
      saving = false;
      sync();
    }
  }

  async function remove(id) {
    problem.hidden = true;
    try {
      await api.call("DELETE", `/wellness/therapy-notes/${encodeURIComponent(id)}`);
      await refresh();
    } catch {
      problem.textContent = "Couldn't remove that note. Try again.";
      problem.hidden = false;
    }
  }

  textarea.addEventListener("input", sync);
  textarea.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) void save();
  });
  add.addEventListener("click", () => void save());

  root.replaceChildren(
    sectionHead("05", "For your next session"),
    h(
      "div",
      { class: "wl-therapy" },
      h(
        "p",
        { class: "wl-therapy__intro" },
        "Things you want to bring up in therapy — jot them when they're fresh, and they'll be waiting when you sit down."
      ),
      h(
        "div",
        { class: "wl-tadd" },
        h("span", { class: "wl-tadd__ic" }, icon(PATHS.notebookPen)),
        textarea,
        h("span", { class: "wl-tadd__btn" }, add)
      ),
      problem,
      list
    )
  );

  function noteRow(note) {
    const core =
      typeof note.linkedEmotion === "string" && CORES.test(note.linkedEmotion)
        ? note.linkedEmotion
        : null;
    const meta = h(
      "div",
      { class: "wl-tnote__meta" },
      h("span", { class: "wl-tnote__date" }, noteDate(note.createdAt, locale))
    );
    if (core) {
      meta.append(
        h(
          "span",
          { class: "wl-tnote__link", style: `--em-tint: var(--wellness-${core}-tint)` },
          h("span", { class: "d" }),
          `Linked to a ${label(core)} check-in`
        )
      );
    }
    return h(
      "div",
      { class: "wl-tnote" },
      h("span", { class: "wl-tnote__mark" }, icon(PATHS.message, { size: 15 })),
      h(
        "div",
        { class: "wl-tnote__main" },
        h("div", { class: "wl-tnote__tx" }, note.body ?? ""),
        meta
      ),
      h(
        "button",
        {
          type: "button",
          class: "wl-tnote__x",
          "aria-label": "Remove",
          onclick: () => void remove(note.id)
        },
        icon(PATHS.trash, { size: 15 })
      )
    );
  }

  async function refresh() {
    const mine = ++run;
    if (list.childElementCount === 0) {
      list.replaceChildren(
        h("p", { class: "wl-subtle-text", role: "status" }, "Loading session notes…")
      );
    }
    try {
      const reply = await api.call("GET", "/wellness/therapy-notes");
      if (mine !== run) return;
      const notes = Array.isArray(reply?.notes) ? reply.notes : [];
      if (notes.length === 0) {
        list.replaceChildren(
          h(
            "div",
            { class: "wl-tdone" },
            h("span", { class: "ic" }, icon(PATHS.check, { size: 14, stroke: 2.6 })),
            "Nothing queued — add a note above."
          )
        );
      } else list.replaceChildren(...notes.map(noteRow));
    } catch {
      if (mine !== run) return;
      list.replaceChildren(
        h(
          "div",
          { class: "wl-tdone" },
          h(
            "span",
            { class: "wl-subtle-text", role: "status" },
            "Couldn't load notes. ",
            linkButton("Try again", refresh)
          )
        )
      );
    }
  }

  void refresh();
  return { refresh };
}
