import { esc } from "./format.mjs";
import { amount, timeValue } from "./log-format.mjs";
import { btn, dialog, field, hint, input } from "./kit.mjs";

const MACROS = [
  ["caloriesKcal", "Calories"],
  ["proteinG", "Protein (g)"],
  ["carbohydratesG", "Carbs (g)"],
  ["fatG", "Fat (g)"]
];

const cancel = btn("Cancel", "dialog-close", { variant: "secondary" });
const TIME = /^\d{2}:\d{2}$/;

/** A typed figure. Blank is unknown (null). Undefined means the text is not a figure. */
function readFigure(text) {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  const value = Number(trimmed);
  return Number.isFinite(value) && value >= 0 && value <= 1_000_000 ? value : undefined;
}

export const newAddForm = (defaultTime) => ({
  description: "",
  serving: "",
  time: defaultTime,
  problem: null
});

export function addDialog(form, busy) {
  const body = `<div class="mls-form">${field(
    "a-desc",
    "What you ate",
    input("a-desc", form.description, {
      placeholder: "Two eggs on toast",
      extra: 'maxlength="500"'
    })
  )}<div class="mls-form-grid">${field(
    "a-serving",
    "Portion",
    input("a-serving", form.serving, { placeholder: "Optional", extra: 'maxlength="200"' })
  )}${field("a-time", "Time", input("a-time", form.time, { type: "time" }))}</div>${
    form.problem ? hint(form.problem) : ""
  }</div>`;
  return dialog({
    id: "mls-log-add",
    title: "Log a meal",
    body,
    footer: `${cancel}${btn("Log", "save-add", { disabled: busy })}`
  });
}

/** Checks the add form. Returns `{input}` for the form fields, or `{problem}`. */
export function readAdd(form) {
  if (form.description.trim() === "") return { problem: "Enter what you ate first" };
  if (!TIME.test(form.time)) return { problem: "Enter the time of the meal" };
  return {
    input: {
      description: form.description.trim(),
      servingNote: form.serving.trim() === "" ? null : form.serving.trim(),
      time: form.time
    }
  };
}

const blank = (text) => (text === "-" ? "" : text);

function draftOf(item) {
  const n = item.nutrients;
  return {
    label: item.label,
    portion: item.portionNote ?? "",
    caloriesKcal: blank(amount(n.caloriesKcal)),
    proteinG: blank(amount(n.proteinG, 1)),
    carbohydratesG: blank(amount(n.carbohydratesG, 1)),
    fatG: blank(amount(n.fatG, 1))
  };
}

/** The dialog keeps the entry as it was opened, so the save carries the revision the person saw. */
export const newEditForm = (entry) => ({
  entry,
  description: entry.description,
  time: timeValue(entry),
  drafts: entry.items.map(draftOf),
  problem: null
});

export function editDialog(form, busy) {
  const items = form.drafts
    .map((draft, i) => {
      const figures = MACROS.map(([key, label]) =>
        field(
          `e-${key}-${i}`,
          label,
          input(`e-${key}-${i}`, draft[key], { extra: 'inputmode="decimal"' })
        )
      ).join("");
      return `<fieldset class="mls-item-form"><legend class="jds-eyebrow">Food ${i + 1}</legend><div class="mls-form-grid">${field(
        `e-label-${i}`,
        "Name",
        input(`e-label-${i}`, draft.label, { extra: 'maxlength="120"' })
      )}${field(
        `e-portion-${i}`,
        "Portion",
        input(`e-portion-${i}`, draft.portion, { extra: 'maxlength="200"' })
      )}</div><div class="mls-figures">${figures}</div></fieldset>`;
    })
    .join("");
  const body = `<div class="mls-form">${field(
    "e-desc",
    "What you ate",
    input("e-desc", form.description, { extra: 'maxlength="500"' })
  )}${field("e-time", "Time", input("e-time", form.time, { type: "time" }))}${items}${
    form.problem ? hint(form.problem) : ""
  }</div>`;
  return dialog({
    id: "mls-log-edit",
    title: "Edit meal",
    body,
    footer: `${cancel}${btn("Save", "save-edit", { disabled: busy })}`
  });
}

/** Sets one edit-form field from an input name such as `e-desc` or `e-proteinG-1`. */
export function setEditField(form, name, value) {
  if (name === "e-desc") form.description = value;
  else if (name === "e-time") form.time = value;
  else {
    const match = /^e-([A-Za-z]+)-(\d+)$/.exec(name);
    if (match && form.drafts[Number(match[2])]) form.drafts[Number(match[2])][match[1]] = value;
  }
}

/** Checks the edit form. Only a food the person changed is sent; null leaves the food alone. */
export function readEdit(form) {
  const { entry } = form;
  if (form.description.trim() === "") return { problem: "Enter what you ate first" };
  if (!TIME.test(form.time)) return { problem: "Enter the time of the meal" };
  const items = [];
  let any = false;
  for (let i = 0; i < form.drafts.length; i += 1) {
    const draft = form.drafts[i];
    const original = draftOf(entry.items[i]);
    const patch = {};
    if (draft.label.trim() === "") return { problem: "Every food needs a name" };
    if (draft.label.trim() !== original.label) patch.label = draft.label.trim();
    if (draft.portion.trim() !== original.portion) {
      patch.portionNote = draft.portion.trim() === "" ? null : draft.portion.trim();
    }
    const nutrients = {};
    for (const [key, label] of MACROS) {
      if (draft[key] === original[key]) continue;
      const figure = readFigure(draft[key]);
      if (figure === undefined)
        return { problem: `${label} must be a number, or blank if unknown` };
      nutrients[key] = figure;
    }
    if (Object.keys(nutrients).length > 0) patch.nutrients = nutrients;
    if (Object.keys(patch).length > 0) any = true;
    items.push(Object.keys(patch).length > 0 ? patch : null);
  }
  return {
    input: {
      entryId: entry.entryId,
      expectedRevision: entry.estimateRevision,
      ...(form.description.trim() !== entry.description
        ? { description: form.description.trim() }
        : {}),
      ...(any ? { items } : {})
    },
    time: form.time,
    timeChanged: form.time !== timeValue(entry)
  };
}

export const deleteDialog = (entry, busy) =>
  dialog({
    id: "mls-log-delete",
    title: "Delete this meal",
    body: `<p>${esc(entry.description)} is removed from the Log. This cannot be undone here.</p>`,
    footer: `${cancel}${btn("Delete", "confirm-delete", { variant: "danger", disabled: busy })}`
  });
