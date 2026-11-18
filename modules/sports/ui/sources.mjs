/* global document */
import { h, button, clear } from "./dom.mjs";
import { badge, check, note, sectionHead } from "./settings-ui.mjs";
import { assignmentPicker, coverageList } from "./source-pick.mjs";
import { mountAddSource, sourceError } from "./source-add.mjs";
import {
  HEALTH_BADGE,
  PHOTO_STATUS_TEXT,
  SPORT_OPTIONS,
  assignmentFailureCopy,
  assignmentTarget,
  confirmBody,
  showRebuild,
  targetDisplayLabel,
  targetKey
} from "./settings-logic.mjs";

/** The "News sources" section of the Sports settings screen. */
export function mountSources({ api, store }) {
  let sources = null;
  let loadFailed = false;
  let editingId = null;
  let selection = new Map();
  let assignPreview = null;
  let assignAck = false;
  let recipePreview = null;
  let recipeAck = false;
  let adding = false;
  let working = null;
  let failure = null;

  const root = h("section", { class: "sp-src", "aria-label": "Sports news sources" });
  const body = h("div", {});
  root.append(
    h(
      "div",
      { class: "sp-src__head" },
      sectionHead("News sources", "sp-src-title"),
      h(
        "p",
        { class: "jds-section-sub" },
        "Choose which sports, leagues, and teams each source covers. Matching publishers are mixed together in Sports news."
      )
    ),
    body
  );

  const label = (target) =>
    targetDisplayLabel(target, store.follows, store.competitionsByKey, store.teamsByCompetition);

  async function load() {
    try {
      sources = (await api.sources()).sources ?? [];
      loadFailed = false;
    } catch {
      loadFailed = true;
    }
    paint();
  }

  /** Runs one action, shows its busy label, and reports a failure in plain words. */
  async function run(key, errorText, action) {
    working = key;
    failure = null;
    paint();
    try {
      await action();
    } catch {
      failure = errorText;
    }
    working = null;
    paint();
  }

  const isWorking = (prefix, id) => working === `${prefix}:${id}`;
  const anyWorking = () => working !== null;

  function startEditing(source) {
    editingId = source.id;
    selection = new Map(
      source.assignments.flatMap((a) => {
        const target = assignmentTarget(a);
        return target ? [[targetKey(target), target]] : [];
      })
    );
    assignPreview = null;
    assignAck = false;
    failure = null;
    paint();
  }

  function startEditingEspn(source) {
    const targets = source.usesDefaultCoverage
      ? SPORT_OPTIONS.map(({ key }) => ({ kind: "sport", sportKey: key }))
      : source.assignments;
    editingId = source.id;
    selection = new Map(targets.map((t) => [targetKey(t), t]));
    failure = null;
    paint();
  }

  function stopEditing() {
    editingId = null;
    assignPreview = null;
    assignAck = false;
    paint();
  }

  function toggleTarget(target) {
    const key = targetKey(target);
    if (selection.has(key)) selection.delete(key);
    else selection.set(key, target);
    assignPreview = null;
    assignAck = false;
    paint();
  }

  const picker = (idPrefix) =>
    assignmentPicker({
      store,
      selected: new Set(selection.keys()),
      onToggle: toggleTarget,
      disabled: anyWorking(),
      idPrefix
    });

  function icon() {
    return h(
      "span",
      { class: "sp-src__item-icon", "aria-hidden": "true" },
      h("span", { class: "sp-src__item-glyph" }, "N")
    );
  }

  function espnRow(espn) {
    const editing = editingId === espn.id;
    const busy = isWorking("espn", espn.id);
    let coverage = "Inactive for headlines.";
    if (espn.usesDefaultCoverage) coverage = "Coverage: All sports";
    else if (espn.enabled) coverage = `Coverage: ${espn.assignments.map(label).join(", ")}`;
    const li = h(
      "li",
      { class: "sp-src__item" },
      h(
        "div",
        { class: "sp-src__item-row" },
        h(
          "div",
          { class: "sp-src__identity" },
          icon(),
          h("span", { class: "sp-src__item-label" }, espn.label),
          badge("Built-in", "steel")
        ),
        h(
          "div",
          { class: "sp-src__actions" },
          button(editing ? "Close" : "Edit coverage", {
            variant: "secondary",
            size: "sm",
            "aria-label": "Edit coverage for ESPN",
            disabled: busy,
            onClick: () => (editing ? stopEditing() : startEditingEspn(espn))
          })
        )
      ),
      h("p", { class: "sp-src__meta-line" }, coverage)
    );
    if (editing) {
      li.append(
        h(
          "div",
          { class: "sp-src__assign" },
          picker("sp-edit-espn"),
          h(
            "div",
            { class: "sp-src__addrow" },
            button(busy ? "Saving…" : "Save coverage", {
              size: "sm",
              disabled: busy,
              onClick: () =>
                run(`espn:${espn.id}`, "Could not update ESPN coverage. Try again.", async () => {
                  await api.saveEspnCoverage([...selection.values()]);
                  editingId = null;
                  await load();
                })
            }),
            button("Cancel", {
              variant: "secondary",
              size: "sm",
              disabled: busy,
              onClick: stopEditing
            })
          ),
          failure === "Could not update ESPN coverage. Try again." ? sourceError(failure) : null
        )
      );
    }
    return li;
  }

  function candidateBlock(
    result,
    ariaLabel,
    ack,
    setAck,
    confirmLabel,
    savingLabel,
    onConfirm,
    saving
  ) {
    const card = h("div", { class: "sp-src__candidate" });
    card.append(
      coverageList(
        ariaLabel,
        result.candidate.targets.map((t) => t.label)
      )
    );
    if (result.candidate.targets.length === 0) {
      card.append(h("p", { class: "sp-src__hint" }, "This source will be left unassigned."));
    }
    card.append(
      check({
        id: `${ariaLabel.replace(/\W+/g, "-").toLowerCase()}-ack`,
        label: result.authorizationAcknowledgement,
        checked: ack,
        disabled: saving,
        className: "sp-src__check",
        onChange: (value) => {
          setAck(value);
          paint();
        }
      }).el,
      button(saving ? savingLabel : confirmLabel, {
        size: "sm",
        disabled: !ack || saving,
        onClick: onConfirm
      })
    );
    return card;
  }

  const previewOk = (p, id) =>
    p?.sourceId === id &&
    p.result.status === "ok" &&
    p.result.candidate &&
    p.result.confirmationId &&
    p.result.authorizationAcknowledgement;

  function customRow(source) {
    const hb = HEALTH_BADGE[source.healthState];
    const editing = editingId === source.id;
    const removing = isWorking("remove", source.id);
    const retrying = isWorking("retry", source.id);
    const rebuilding = isWorking("rebuild", source.id);
    const stopping = isWorking("photos", source.id);
    const recoveryBusy = anyWorking() && !stopping;
    const li = h("li", { class: "sp-src__item" });
    const actions = h("div", { class: "sp-src__actions" });
    if (source.healthState !== "healthy") {
      actions.append(
        button(retrying ? "Checking…" : "Retry", {
          variant: "secondary",
          size: "sm",
          "aria-label": `Retry ${source.label}`,
          disabled: anyWorking(),
          onClick: () =>
            run(`retry:${source.id}`, "Could not retry that source. Try again.", async () => {
              await api.retrySource(source.id);
              await load();
            })
        })
      );
    }
    if (showRebuild(source)) {
      actions.append(
        button(rebuilding ? "Checking…" : "Rebuild", {
          variant: "secondary",
          size: "sm",
          "aria-label": `Rebuild ${source.label}`,
          disabled: anyWorking(),
          onClick: () =>
            run(`rebuild:${source.id}`, "Could not rebuild that source. Try again.", async () => {
              recipePreview = { sourceId: source.id, result: await api.previewRecipe(source.id) };
              recipeAck = false;
            })
        })
      );
    }
    actions.append(
      button(editing ? "Close" : "Edit coverage", {
        variant: "secondary",
        size: "sm",
        "aria-label": `Edit coverage for ${source.label}`,
        disabled: anyWorking(),
        onClick: () => (editing ? stopEditing() : startEditing(source))
      }),
      button(removing ? "Removing…" : "Remove", {
        variant: "secondary",
        size: "sm",
        "aria-label": `Remove ${source.label}`,
        disabled: anyWorking(),
        onClick: () =>
          run(`remove:${source.id}`, "Could not remove that source. Try again.", async () => {
            await api.removeSource(source.id);
            if (editingId === source.id) editingId = null;
            await load();
          })
      })
    );
    li.append(
      h(
        "div",
        { class: "sp-src__item-row" },
        h(
          "div",
          { class: "sp-src__identity" },
          icon(),
          h("span", { class: "sp-src__item-label" }, source.label),
          hb ? badge(hb.label, hb.tone) : null
        ),
        actions
      )
    );
    const photos = h(
      "p",
      { class: "sp-src__meta-line" },
      PHOTO_STATUS_TEXT[source.photoStatus] ?? ""
    );
    if (source.photosFoundByMoss) {
      photos.append(
        " ",
        button(stopping ? "Stopping…" : "Stop using Moss's photos", {
          variant: "quiet",
          size: "sm",
          "aria-label": `Stop using Moss's photos for ${source.label}`,
          disabled: recoveryBusy || stopping,
          onClick: () =>
            run(
              `photos:${source.id}`,
              "Could not stop using those photos. Try again.",
              async () => {
                await api.stopPhotos(source.id);
                await load();
              }
            )
        })
      );
    }
    li.append(photos);
    if (source.healthMessage)
      li.append(h("p", { class: "sp-src__health-message" }, source.healthMessage));
    if (source.healthState === "auth_required") {
      li.append(
        note("This publisher needs credentials. Authenticated sources are not supported yet.")
      );
    }
    if (source.assignments.length > 0) {
      li.append(
        coverageList(
          `Coverage for ${source.label}`,
          source.assignments.map((a) => {
            const target = assignmentTarget(a);
            return target ? label(target) : "Assigned team or league";
          })
        )
      );
    } else {
      li.append(
        h("p", { class: "sp-src__hint sp-src__hint--tight" }, "Unassigned — not used yet.")
      );
    }
    if (previewOk(recipePreview, source.id)) {
      const result = recipePreview.result;
      li.append(
        candidateBlock(
          result,
          "Rebuilt coverage",
          recipeAck,
          (v) => (recipeAck = v),
          "Confirm rebuild",
          "Saving…",
          () =>
            run(`recipe:${source.id}`, "Could not rebuild that source. Try again.", async () => {
              await api.confirmRecipe(source.id, confirmBody(result));
              recipePreview = null;
              recipeAck = false;
              await load();
            }),
          isWorking("recipe", source.id)
        )
      );
    } else if (recipePreview?.sourceId === source.id && recipePreview.result.status !== "ok") {
      li.append(sourceError("The source recipe could not be rebuilt."));
    }
    if (editing) li.append(editPanel(source));
    return li;
  }

  function editPanel(source) {
    const panel = h("div", { class: "sp-src__assign" });
    const checking = isWorking("assign-preview", source.id);
    panel.append(
      picker(`sp-edit-${source.id}`),
      h(
        "div",
        { class: "sp-src__addrow" },
        button(checking ? "Checking…" : "Review changes", {
          size: "sm",
          disabled: anyWorking(),
          onClick: () =>
            run(
              `assign-preview:${source.id}`,
              "Could not update assignments. Try again.",
              async () => {
                assignPreview = {
                  sourceId: source.id,
                  result: await api.previewAssignments(source.id, [...selection.values()])
                };
                assignAck = false;
              }
            )
        })
      )
    );
    if (previewOk(assignPreview, source.id)) {
      const result = assignPreview.result;
      panel.append(
        candidateBlock(
          result,
          "Coverage after saving",
          assignAck,
          (v) => (assignAck = v),
          "Save assignments",
          "Saving…",
          () =>
            run(`assign:${source.id}`, "Could not update assignments. Try again.", async () => {
              await api.confirmAssignments(source.id, confirmBody(result));
              editingId = null;
              assignPreview = null;
              assignAck = false;
              await load();
            }),
          isWorking("assign", source.id)
        )
      );
    } else if (assignPreview?.sourceId === source.id && assignPreview.result.status !== "ok") {
      panel.append(sourceError(assignmentFailureCopy(assignPreview.result)));
    }
    if (failure === "Could not update assignments. Try again.") panel.append(sourceError(failure));
    return panel;
  }

  const addFlow = mountAddSource({ api, store, onAdded: load });

  function paint() {
    const focusId = document.activeElement?.id;
    clear(body);
    if (loadFailed) body.append(sourceError("Could not load your sports news sources. Try again."));
    if (sources === null && !loadFailed) body.append(note("Loading sources…"));
    if (sources !== null) {
      const espn = sources.find((s) => s.kind === "builtin");
      const custom = sources.filter((s) => s.kind === "custom");
      if (espn || custom.length > 0) {
        body.append(
          h("ul", { class: "sp-src__list" }, espn ? espnRow(espn) : null, custom.map(customRow))
        );
      }
      if (custom.length === 0) body.append(note("No custom sources yet."));
    }
    if (failure && !failure.startsWith("Could not update")) body.append(sourceError(failure));
    body.append(
      h(
        "div",
        { class: "sp-src__add-section" },
        adding
          ? [
              h(
                "div",
                { class: "sp-src__add-head" },
                h("p", { class: "sp-src__subheading" }, "Add a source"),
                button("Close", {
                  variant: "secondary",
                  size: "sm",
                  onClick: () => {
                    adding = false;
                    paint();
                  }
                })
              ),
              addFlow.el
            ]
          : button("+ Add a source", {
              variant: "secondary",
              size: "sm",
              onClick: () => {
                adding = true;
                paint();
              }
            })
      )
    );
    if (focusId) document.getElementById(focusId)?.focus();
  }

  paint();
  load();
  return { el: root, reload: load, repaint: paint };
}
