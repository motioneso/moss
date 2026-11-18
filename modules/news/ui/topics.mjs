import { h, button, badge, icon, PATHS } from "./dom.mjs";
import { describedTopicsGate, topicErrorMessage } from "./domain.mjs";
import { gate, status, failure, iconBox, textRow } from "./parts.mjs";

/** The "Topics across the web" list, its add and edit form, and the web search gate. */
export function describedTopics({ api, navigate, state, refresh, retryRow }) {
  const root = h("div", {});
  let adding = false;
  let editingId = null;
  let label = "";
  let guidance = "";
  let busy = null; // "create" | "edit" | null
  let removingId = null;
  let message = null;
  let error = null;
  let removeFailed = false;

  const resetForm = () => {
    adding = false;
    editingId = null;
    label = "";
    guidance = "";
  };

  async function submit() {
    const trimmed = label.trim();
    if (!trimmed || busy) return;
    message = null;
    error = null;
    const operation = editingId ? "edit" : "create";
    busy = operation;
    paint();
    try {
      if (editingId) {
        await api.updateTopic(editingId, { label: trimmed, guidance: guidance.trim() });
      } else {
        const text = guidance.trim();
        await api.createTopic(text ? { label: trimmed, guidance: text } : { label: trimmed });
      }
      await refresh();
      resetForm();
      message = operation === "create" ? "Topic added" : "Changes saved";
    } catch (caught) {
      error = topicErrorMessage(caught);
    }
    busy = null;
    paint();
  }

  async function remove(topic) {
    removingId = topic.id;
    removeFailed = false;
    paint();
    try {
      await api.removeTopic(topic.id);
      await refresh();
      message = "Topic removed";
    } catch {
      removeFailed = true;
    }
    removingId = null;
    paint();
  }

  function row(topic) {
    const locked = busy !== null || removingId === topic.id;
    return h(
      "li",
      { class: "nw-set__item" },
      h(
        "div",
        { class: "nw-set__item-row" },
        h(
          "div",
          { class: "nw-set__identity" },
          iconBox(PATHS.tag),
          h("span", { class: "nw-set__item-label" }, topic.label),
          topic.guidance ? h("span", { class: "nw-set__item-meta" }, topic.guidance) : null,
          topic.validationStatus !== "approved" ? badge("Needs revalidation", "amber") : null
        ),
        h(
          "div",
          { class: "nw-set__actions" },
          button("Edit", {
            variant: "secondary",
            size: "sm",
            "aria-label": `Edit ${topic.label}`,
            disabled: locked,
            onClick: () => {
              resetForm();
              editingId = topic.id;
              label = topic.label;
              guidance = topic.guidance ?? "";
              message = null;
              error = null;
              paint();
            }
          }),
          button("Remove", {
            variant: "secondary",
            size: "sm",
            "aria-label": `Remove ${topic.label}`,
            disabled: locked,
            onClick: () => void remove(topic)
          })
        )
      )
    );
  }

  function form() {
    const cancel = () => {
      resetForm();
      error = null;
      message = null;
      paint();
    };
    const submitLabel =
      busy === "create"
        ? "Checking…"
        : busy === "edit"
          ? "Saving…"
          : editingId
            ? "Save changes"
            : "Add topic";
    const save = button(submitLabel, {
      size: "sm",
      type: "submit",
      disabled: busy !== null || !label.trim()
    });
    const first = textRow({
      id: "nw-addtopic-label",
      label: "Topic in your own words",
      value: label,
      placeholder: "mechanical watches",
      disabled: busy !== null,
      onInput: (value) => {
        label = value;
        message = null;
        save.disabled = busy !== null || !label.trim();
      }
    });
    const second = textRow({
      id: "nw-addtopic-guidance",
      label: "Optional guidance — what to include or leave out",
      value: guidance,
      placeholder: "not smartwatches",
      disabled: busy !== null,
      onInput: (value) => {
        guidance = value;
        message = null;
      },
      buttons: [
        save,
        button("Cancel", {
          variant: "secondary",
          size: "sm",
          disabled: busy !== null,
          onClick: cancel
        })
      ]
    });
    return h(
      "div",
      { class: "nw-set__candidate" },
      h(
        "div",
        { class: "jds-card jds-card--sunken jds-card--pad-lg" },
        h(
          "div",
          { class: "nw-set__add-head" },
          h("h4", { class: "jds-eyebrow" }, editingId ? "Edit topic" : "Add a topic"),
          button("Close", {
            variant: "secondary",
            size: "sm",
            "aria-expanded": "true",
            onClick: cancel
          })
        ),
        h(
          "form",
          {
            class: "nw-set__exform",
            onSubmit: (event) => {
              event.preventDefault();
              void submit();
            }
          },
          ...first.nodes,
          ...second.nodes
        )
      )
    );
  }

  function addControl() {
    const availability = state.pers?.availability ?? null;
    if (adding || editingId) return form();
    if (availability?.freeformTopicsEnabled) {
      return h(
        "div",
        { class: "nw-set__add-section" },
        button([icon(PATHS.plus, 14), "Add a topic"], {
          variant: "secondary",
          size: "sm",
          "aria-expanded": "false",
          onClick: () => {
            resetForm();
            adding = true;
            paint();
          }
        })
      );
    }
    // The gate always names why web search is off, so the disabled button is never a mystery.
    return h(
      "div",
      { class: "nw-set__addrow" },
      button("Add topic", { variant: "secondary", size: "sm", disabled: true }),
      availability ? gate(describedTopicsGate(availability.webSearchReason), navigate) : null
    );
  }

  function paint() {
    const topics = state.pers?.customTopics ?? [];
    const needsAttention = topics.some((topic) => topic.validationStatus !== "approved");
    root.replaceChildren(
      topics.length > 0
        ? h("ul", { class: "nw-set__list" }, topics.map(row))
        : h("p", { class: "nw-set__hint" }, "News still uses your selected sources."),
      removeFailed ? failure("Could not remove that topic. Try again.") : null,
      needsAttention ? retryRow() : null,
      addControl(),
      busy ? status(busy === "create" ? "Checking topic…" : "Saving changes…") : null,
      message ? status(message, " is-success") : null,
      error ? failure(error) : null
    );
  }

  return { el: root, paint };
}
