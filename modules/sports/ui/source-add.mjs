/* global document */
import { h, button, clear } from "./dom.mjs";
import { check, note } from "./settings-ui.mjs";
import { assignmentPicker, coverageList } from "./source-pick.mjs";
import {
  PREVIEW_REJECTION_COPY,
  confirmBody,
  targetDisplayLabel,
  targetKey
} from "./settings-logic.mjs";

export function sourceError(text) {
  return h("p", { class: "sp-src__err", role: "alert" }, h("span", {}, text));
}

/** The "Add a source" flow. A site is checked first and only saved after the person confirms. */
export function mountAddSource({ api, store, onAdded }) {
  let selected = new Map();
  let preview = null;
  let accepted = false;
  let added = false;
  let previewing = false;
  let confirming = false;
  let failure = null;

  const root = h("div", { class: "sp-src__addflow" });
  const field = h("input", {
    id: "sp-addsource-input",
    class: "jds-input",
    type: "text",
    placeholder: "theathletic.com or r/nfl"
  });
  const checkBtn = button("Check", { size: "sm", type: "submit", disabled: true });
  const dynamic = h("div", {});
  const form = h(
    "form",
    { class: "sp-src__form" },
    h(
      "label",
      { class: "sp-src__label", for: "sp-addsource-input" },
      "Publication homepage or domain"
    ),
    h("div", { class: "sp-src__row" }, field, checkBtn)
  );
  root.append(form, dynamic);

  const busy = () => previewing || confirming;

  function errorText() {
    if (preview?.status === "rejected") {
      return (
        (preview.reason ? PREVIEW_REJECTION_COPY[preview.reason] : undefined) ??
        "That publication can't be added."
      );
    }
    if (preview?.status === "unavailable")
      return "Adding sources needs a configured JSON-capable AI model.";
    return failure;
  }

  function candidateCard() {
    const c = preview.candidate;
    const dupe = Boolean(preview.duplicateOfSourceId);
    const card = h("div", {
      class: "sp-src__candidate jds-card jds-card--sunken jds-card--pad-lg"
    });
    if (dupe) {
      card.append(
        h(
          "p",
          { class: "sp-src__dupe", role: "status" },
          h(
            "span",
            {},
            h("b", {}, "Already added."),
            ` ${c.label} is one of your custom sources, so there is nothing to add. Edit its coverage in the list above instead.`
          )
        )
      );
    }
    card.append(
      h(
        "div",
        { class: "sp-src__candidate-head" },
        h("p", { class: "sp-src__candidate-label" }, c.label),
        h("span", { class: "jds-badge jds-badge--neutral jds-badge--pill" }, "Preview")
      )
    );
    if (c.sampleHeadlines?.length > 0) {
      card.append(
        h(
          "div",
          { class: "sp-src__candidate-block" },
          h("p", { class: "jds-eyebrow" }, "Sample headlines"),
          h(
            "ul",
            { class: "sp-src__candidate-list" },
            c.sampleHeadlines.map((x) => h("li", {}, x))
          )
        )
      );
    }
    if (c.targets.length > 0) {
      card.append(
        h(
          "div",
          { class: "sp-src__candidate-block" },
          h("p", { class: "jds-eyebrow" }, "Coverage"),
          coverageList(
            "Coverage",
            c.targets.map((t) => t.label)
          )
        )
      );
    }
    if (preview.authorizationAcknowledgement && !dupe) {
      card.append(
        check({
          id: "sp-addsource-ack",
          label: preview.authorizationAcknowledgement,
          checked: accepted,
          disabled: busy(),
          className: "sp-src__check",
          onChange: (value) => {
            accepted = value;
            paint();
          }
        }).el
      );
    }
    card.append(
      h(
        "div",
        { class: "sp-src__addrow" },
        dupe
          ? null
          : button(confirming ? "Adding…" : "Add this source", {
              size: "sm",
              disabled: busy() || !accepted,
              onClick: confirm
            }),
        button(dupe ? "Close" : "Cancel", {
          variant: "secondary",
          size: "sm",
          disabled: busy(),
          onClick: reset
        })
      )
    );
    return card;
  }

  function paint() {
    const focusId = document.activeElement?.id;
    clear(dynamic);
    checkBtn.disabled = busy() || !field.value.trim();
    checkBtn.textContent = previewing ? "Checking…" : "Check";
    field.disabled = busy();
    if (field.value.trim()) {
      dynamic.append(
        h("p", { class: "sp-src__hint" }, "Coverage (optional. Leave blank to add unassigned):"),
        assignmentPicker({
          store,
          selected: new Set(selected.keys()),
          onToggle: toggleTarget,
          disabled: busy(),
          idPrefix: "sp-addsource-assign"
        })
      );
    }
    const text = errorText();
    if (text) dynamic.append(sourceError(text));
    if (preview?.status === "ok" && preview.candidate) dynamic.append(candidateCard());
    if (added) dynamic.append(note("Source added."));
    if (focusId) document.getElementById(focusId)?.focus();
  }

  function toggleTarget(target) {
    const key = targetKey(target);
    if (selected.has(key)) selected.delete(key);
    else selected.set(key, target);
    preview = null;
    accepted = false;
    paint();
  }

  function reset() {
    preview = null;
    selected = new Map();
    accepted = false;
    failure = null;
    paint();
  }

  async function confirm() {
    if (
      !preview?.confirmationId ||
      !preview.candidate ||
      !preview.authorizationAcknowledgement ||
      !accepted
    )
      return;
    confirming = true;
    failure = null;
    paint();
    try {
      await api.confirmSource(confirmBody(preview));
      field.value = "";
      preview = null;
      selected = new Map();
      accepted = false;
      added = true;
      confirming = false;
      paint();
      onAdded();
      return;
    } catch (error) {
      failure = error?.detail ?? "Could not add that source. Try again.";
    }
    confirming = false;
    paint();
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const url = field.value.trim();
    if (!url || busy()) return;
    added = false;
    preview = null;
    failure = null;
    previewing = true;
    paint();
    try {
      preview = await api.previewSource({
        url,
        assignments: [...selected.values()].map((target) => ({ target }))
      });
      accepted = false;
    } catch {
      failure = "Could not check that publication. Try again.";
    }
    previewing = false;
    paint();
  });

  field.addEventListener("input", () => {
    added = false;
    paint();
  });

  paint();
  return {
    el: root,
    label: (t) =>
      targetDisplayLabel(t, store.follows, store.competitionsByKey, store.teamsByCompetition)
  };
}
