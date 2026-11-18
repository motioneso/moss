import { h, button, note } from "./dom.mjs";
import {
  PREVIEW_REQUEST_ERROR,
  addSourceErrorMessage,
  previewOutcomeMessage,
  zipPreviewCandidates
} from "./domain.mjs";
import { failure, newsIcon, textRow } from "./parts.mjs";

/** Add a source: type an address, check it, pick the match, confirm. */
export function addSourceFlow({ api, refresh }) {
  const root = h("div", { class: "nw-set__addflow" });
  let input = "";
  let preview = null;
  let selected = null;
  let added = null;
  let busy = null; // "preview" | "confirm" | null
  let confirmError = null;
  let previewError = false;

  async function check() {
    const text = input.trim();
    if (!text || busy) return;
    added = null;
    preview = null;
    confirmError = null;
    previewError = false;
    busy = "preview";
    paint();
    try {
      preview = await api.previewSource(text);
      selected = preview.candidateIds?.[0] ?? null;
    } catch {
      previewError = true;
    }
    busy = null;
    paint();
  }

  async function confirm() {
    if (!preview?.confirmationId || !selected || busy) return;
    confirmError = null;
    busy = "confirm";
    paint();
    try {
      await api.confirmSource({ confirmationId: preview.confirmationId, candidateId: selected });
      input = "";
      preview = null;
      selected = null;
      added = "Source added — it now contributes to your News page.";
      await refresh();
    } catch (caught) {
      confirmError =
        caught?.status && caught.message !== "News request failed"
          ? caught.message
          : "Could not add that source. Try again.";
    }
    busy = null;
    paint();
  }

  function reset() {
    preview = null;
    selected = null;
    confirmError = null;
    paint();
  }

  function candidateList(candidates) {
    const many = candidates.length > 1;
    return h(
      "ul",
      { class: "nw-set__list", role: many ? "radiogroup" : null },
      candidates.map(({ candidate, candidateId }) =>
        h(
          "li",
          { class: "nw-set__item" },
          h(
            "div",
            { class: "nw-set__item-row" },
            many
              ? h("input", {
                  type: "radio",
                  name: "nw-addsource-candidate",
                  id: `nw-cand-${candidateId}`,
                  checked: selected === candidateId,
                  disabled: busy !== null,
                  onChange: () => {
                    selected = candidateId;
                  }
                })
              : null,
            h(
              "div",
              { class: "nw-set__identity" },
              newsIcon(),
              h(
                "label",
                { class: "nw-set__item-label", for: `nw-cand-${candidateId}` },
                candidate.label
              ),
              h("span", { class: "nw-set__item-meta" }, candidate.canonicalDomain)
            )
          ),
          candidate.redirectNote ? note(candidate.redirectNote) : null
        )
      )
    );
  }

  function paint() {
    const checkButton = button(busy === "preview" ? "Checking…" : "Check", {
      size: "sm",
      type: "submit",
      disabled: busy !== null || !input.trim()
    });
    const row = textRow({
      id: "nw-addsource-input",
      label: "Source homepage or domain",
      value: input,
      placeholder: "politico.com or r/technology",
      disabled: busy !== null,
      onInput: (value) => {
        input = value;
        added = null;
        checkButton.disabled = busy !== null || !input.trim();
      },
      buttons: [checkButton]
    });
    const message = preview ? previewOutcomeMessage(preview) : null;
    const errorText = message ?? confirmError ?? (previewError ? PREVIEW_REQUEST_ERROR : null);
    const candidates = preview ? zipPreviewCandidates(preview) : [];
    root.replaceChildren(
      h(
        "form",
        {
          class: "nw-set__exform",
          onSubmit: (event) => {
            event.preventDefault();
            void check();
          }
        },
        ...row.nodes
      ),
      preview?.error
        ? h(
            "p",
            {
              class: "nw-set__exerr",
              role: "alert",
              "data-error-code": preview.error.code,
              "data-error-class": preview.error.class
            },
            addSourceErrorMessage(preview.error)
          )
        : errorText
          ? failure(errorText)
          : null,
      candidates.length > 0
        ? h(
            "div",
            { class: "nw-set__candidate" },
            h(
              "div",
              { class: "jds-card jds-card--sunken jds-card--pad-lg" },
              preview.duplicateOfSourceId
                ? note("That source is already in your personalized sources.")
                : null,
              candidates.length > 1
                ? h(
                    "p",
                    { class: "nw-set__hint" },
                    "We found more than one match — pick the right one."
                  )
                : null,
              candidateList(candidates),
              h(
                "div",
                { class: "nw-set__addrow" },
                button(busy === "confirm" ? "Adding…" : "Add this source", {
                  size: "sm",
                  disabled: busy !== null || !selected,
                  onClick: () => void confirm()
                }),
                button("Cancel", {
                  variant: "secondary",
                  size: "sm",
                  disabled: busy !== null,
                  onClick: reset
                })
              )
            )
          )
        : null,
      added ? note(added) : null
    );
  }

  paint();
  return { el: root };
}
