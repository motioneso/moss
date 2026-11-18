import { h } from "./dom.mjs";
import { check } from "./settings-ui.mjs";
import { SPORT_OPTIONS, followDisplayLabel, targetKey } from "./settings-logic.mjs";

function group({ label, emptyLabel, options, selected, onToggle, disabled, idPrefix }) {
  const body =
    options.length > 0
      ? h(
          "ul",
          { class: "sp-src__assign-list" },
          options.map((option) => {
            const key = targetKey(option.target);
            return h(
              "li",
              { class: "sp-src__assign-item" },
              check({
                id: `${idPrefix}-${key}`,
                label: option.label,
                checked: selected.has(key),
                disabled,
                className: "sp-src__check",
                onChange: () => onToggle(option.target)
              }).el
            );
          })
        )
      : h("p", { class: "sp-src__hint sp-src__hint--tight" }, emptyLabel);
  return h(
    "fieldset",
    { class: "sp-src__assign-group" },
    h("legend", { class: "sp-src__assign-legend" }, label),
    body
  );
}

/** Checkbox groups for choosing what a source covers: sports, followed leagues, followed teams. */
export function assignmentPicker({ store, selected, onToggle, disabled, idPrefix }) {
  const options = (follows) =>
    follows.map((follow) => ({
      target: { kind: "follow", followId: follow.id },
      label: followDisplayLabel(follow, store.competitionsByKey, store.teamsByCompetition)
    }));
  const common = { selected, onToggle, disabled };
  return h(
    "div",
    { class: "sp-src__assign-groups" },
    group({
      label: "Sports",
      options: SPORT_OPTIONS.map(({ key, label }) => ({
        target: { kind: "sport", sportKey: key },
        label
      })),
      idPrefix: `${idPrefix}-sport`,
      ...common
    }),
    group({
      label: "Leagues",
      emptyLabel: "No followed leagues yet.",
      options: options(store.follows.filter((f) => f.teamKey === null)),
      idPrefix: `${idPrefix}-league`,
      ...common
    }),
    group({
      label: "Teams",
      emptyLabel: "No followed teams yet.",
      options: options(store.follows.filter((f) => f.teamKey !== null)),
      idPrefix: `${idPrefix}-team`,
      ...common
    })
  );
}

/** The coverage list shown on a source row and on a preview card. */
export function coverageList(ariaLabel, entries) {
  return h(
    "ul",
    { class: "sp-src__assignments", "aria-label": ariaLabel },
    entries.map((label) =>
      h("li", {}, h("span", { class: "sp-src__assignment-identity" }, h("span", {}, label)))
    )
  );
}
