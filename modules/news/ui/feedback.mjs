import { h, button, note, fill } from "./dom.mjs";
import { failure, status } from "./parts.mjs";

const stamp = (iso, locale) => {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "Date unavailable";
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(date);
};

/** The stories the person marked more or less like this. Hidden until there is something to manage. */
export function storyPreferences({ api, refreshOverview, locale }) {
  const root = h("div", {});
  let items = [];
  let loadFailed = false;
  let loading = false;
  let notice = null;
  let editingId = null;
  let editText = "";
  let busy = null; // { id, kind: "save" | "remove" }
  let rowError = null; // { id, kind }

  async function load() {
    loading = true;
    paint();
    try {
      items = (await api.feedback()).feedback ?? [];
      loadFailed = false;
    } catch {
      loadFailed = true;
    }
    loading = false;
    paint();
  }

  async function save(item) {
    const reason = editText.trim();
    if (!reason || busy) return;
    notice = null;
    rowError = null;
    busy = { id: item.id, kind: "save" };
    paint();
    try {
      const { feedback } = await api.updateFeedback(item.id, reason);
      items = items.map((entry) => (entry.id === item.id ? feedback : entry));
      editingId = null;
      notice = `Reason saved for ${headline(item)}.`;
      void refreshOverview();
    } catch {
      rowError = { id: item.id, kind: "save" };
    }
    busy = null;
    paint();
  }

  async function remove(item) {
    if (busy) return;
    notice = null;
    rowError = null;
    busy = { id: item.id, kind: "remove" };
    paint();
    try {
      await api.removeFeedback(item.id);
      items = items.filter((entry) => entry.id !== item.id);
      notice = `Preference removed for ${headline(item)}.`;
      void refreshOverview();
    } catch {
      rowError = { id: item.id, kind: "remove" };
    }
    busy = null;
    paint();
  }

  const headline = (item) => item.headline ?? "News story";

  function row(item) {
    const mine = busy?.id === item.id;
    const less = item.kind === "less_like_this";
    const editing = editingId === item.id;
    return h(
      "li",
      { class: "nw-set__feedback-item" },
      h(
        "div",
        {},
        h("strong", {}, headline(item)),
        h(
          "div",
          { class: "nw-set__item-meta" },
          `${item.sourceLabel ?? "Unknown source"} · ${less ? "Less like this" : "More like this"}`
        ),
        h("div", { class: "nw-set__item-meta" }, stamp(item.updatedAt, locale))
      ),
      less && !editing ? h("div", { class: "nw-set__feedback-reason" }, item.reason ?? "") : null,
      less && editing
        ? h(
            "form",
            {
              class: "nw-set__feedback-edit",
              onSubmit: (event) => {
                event.preventDefault();
                void save(item);
              }
            },
            h("label", { for: `news-feedback-${item.id}` }, "Reason"),
            h("textarea", {
              id: `news-feedback-${item.id}`,
              maxlength: "500",
              disabled: mine,
              value: editText,
              onInput: (event) => {
                editText = event.target.value;
              }
            }),
            h(
              "div",
              { class: "nw-set__addrow" },
              button(mine ? "Saving reason…" : "Save reason", {
                size: "sm",
                type: "submit",
                disabled: mine
              }),
              button("Cancel", {
                variant: "quiet",
                size: "sm",
                disabled: mine,
                onClick: () => {
                  editingId = null;
                  paint();
                }
              })
            )
          )
        : null,
      h(
        "div",
        { class: "nw-set__feedback-actions" },
        less && !editing
          ? button("Edit reason", {
              variant: "secondary",
              size: "sm",
              disabled: mine,
              onClick: () => {
                notice = null;
                rowError = null;
                editingId = item.id;
                editText = item.reason ?? "";
                paint();
              }
            })
          : null,
        button(mine && busy.kind === "remove" ? "Removing…" : "Remove", {
          variant: "quiet",
          size: "sm",
          disabled: mine,
          onClick: () => void remove(item)
        })
      ),
      mine ? status(busy.kind === "save" ? "Saving reason…" : "Removing preference…") : null,
      rowError?.id === item.id && rowError.kind === "save"
        ? failure("Could not save that reason. Try again.")
        : null,
      rowError?.id === item.id && rowError.kind === "remove"
        ? failure("Could not remove that preference. Try again.")
        : null
    );
  }

  function paint() {
    if (items.length === 0 && !notice && !loadFailed) {
      fill(root);
      return;
    }
    fill(
      root,
      h(
        "section",
        { class: "nw-set", "aria-label": "Story preferences" },
        h(
          "div",
          { class: "nw-set__head" },
          h("h2", { class: "jds-section-title" }, "Story preferences"),
          h(
            "p",
            { class: "jds-section-sub" },
            "What shapes your News: major stories about subjects you asked to see less of may still appear."
          )
        ),
        notice ? status(notice) : null,
        loadFailed
          ? note(
              "Could not load your News feedback. ",
              button("Retry feedback", {
                variant: "quiet",
                size: "sm",
                disabled: loading,
                onClick: () => void load()
              })
            )
          : null,
        h("ul", { class: "nw-set__list" }, items.map(row))
      )
    );
  }

  return { el: root, load };
}
