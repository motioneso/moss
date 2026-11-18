import { amountText, esc, parseAmount } from "./format.mjs";
import { btn, checkbox, dialog, field, input, select } from "./kit.mjs";

export const SECTION_LABELS = {
  produce: "Produce",
  meat_fish: "Meat and fish",
  dairy_eggs: "Dairy and eggs",
  bakery: "Bakery",
  frozen: "Frozen",
  pantry: "Pantry",
  spices: "Spices",
  drinks: "Drinks",
  household: "Household",
  other: "Other"
};
export const SECTION_ORDER = Object.keys(SECTION_LABELS);
const SECTION_OPTIONS = SECTION_ORDER.map((key) => [key, SECTION_LABELS[key]]);
const BAD_AMOUNT = "Start the amount with a number, such as 2 or 500 g";

/** What the shopper buys: the edited purchase amount, else the recipes' need. */
export function buyText(line) {
  if (line.purchase !== null) return amountText(line.purchase.quantity, line.purchase.unit);
  return line.quantity !== null ? amountText(line.quantity, line.unit) : "";
}

const problem = (text) => (text ? `<p class="jds-hint jds-hint--error" role="alert">${esc(text)}</p>` : "");
const cancel = btn("Cancel", "dialog-close", { variant: "secondary" });

export function addDialog(form, busy) {
  return dialog({
    id: "mls-add",
    title: "Add to the list",
    body: `<div class="mls-form">${field("f-name", "Item", input("f-name", form.name, { extra: 'maxlength="80" placeholder="Dish soap"' }))}<div class="mls-form-grid">${field("f-amount", "Amount", input("f-amount", form.amount, { extra: 'placeholder="Optional"' }))}${field("f-section", "Section", select("f-section", SECTION_OPTIONS, form.section))}</div>${problem(form.problem)}</div>`,
    footer: `${cancel}${btn("Add", "save-add", { disabled: busy })}`
  });
}

/** The tool input for an add, or `{problem}`. */
export function addInput(form) {
  if (form.name.trim() === "") return { problem: "Enter the item first" };
  const out = { action: "add", name: form.name.trim(), section: form.section };
  if (form.amount.trim() !== "") {
    const parsed = parseAmount(form.amount);
    if (parsed === null) return { problem: BAD_AMOUNT };
    out.quantity = parsed.quantity;
    if (parsed.unit !== null) out.unit = parsed.unit;
  }
  return { input: out };
}

export function editDialog(line, form, busy) {
  const needs = line.quantity !== null ? amountText(line.quantity, line.unit) : "";
  const hint =
    !line.manual && needs !== "" && needs !== buyText(line)
      ? `<span class="jds-hint">Recipes need ${esc(needs)}</span>`
      : "";
  const sources = line.sources.length > 0 ? `For ${line.sources.map((x) => x.label).join(", ")}` : "";
  return dialog({
    id: "mls-edit",
    title: `Edit ${esc(line.name)}`,
    body: `${sources ? `<div class="jds-dialog__desc">${esc(sources)}</div>` : ""}<div class="mls-form">${field("f-name", "Item", input("f-name", form.name, { extra: 'maxlength="80"' }))}<div class="mls-form-grid"><div class="jds-field"><label class="jds-label" for="f-amount">${line.manual ? "Amount" : "Amount to buy"}</label>${input("f-amount", form.amount)}${hint}</div>${field("f-section", "Section", select("f-section", SECTION_OPTIONS, form.section))}</div>${problem(form.problem)}</div>`,
    footer: `${line.manual ? btn("Remove", "remove-line", { variant: "danger", disabled: busy, data: `data-line="${esc(line.lineId)}"` }) : ""}${cancel}${btn("Save", "save-edit", { disabled: busy })}`
  });
}

export function editInput(line, form) {
  if (form.name.trim() === "") return { problem: "Enter the item first" };
  const out = { action: "update", lineId: line.lineId };
  if (form.name.trim() !== line.name) out.name = form.name.trim();
  if (form.section !== line.section) out.section = form.section;
  if (form.amount.trim() !== buyText(line)) {
    const parsed = parseAmount(form.amount);
    if (parsed === null) return { problem: BAD_AMOUNT };
    out.quantity = parsed.quantity;
    if (parsed.unit !== null) out.unit = parsed.unit;
  }
  return { input: out };
}

export function boughtPicks(lines) {
  return Object.fromEntries(
    lines.map((line) => [line.lineId, { take: line.checkedAt !== null, amount: buyText(line) }])
  );
}

function group(name, lines, picks) {
  if (lines.length === 0) return "";
  return `<section class="mls-stack mls-stack--tight" aria-label="${esc(name)}"><p class="jds-eyebrow jds-eyebrow--strong">${esc(name)}</p><ul class="mls-list">${lines
    .map((line) => {
      const pick = picks[line.lineId];
      return `<li class="mls-line mls-line--bought">${checkbox(`Bought ${line.name}`, pick.take, "pick", `data-line="${esc(line.lineId)}"`)}<span class="mls-line__body"><span class="mls-line__name">${esc(line.name)}</span><span class="jds-caption">${esc(SECTION_LABELS[line.section])}</span></span><input id="pick-${esc(line.lineId)}" class="jds-input jds-input--sm mls-line__input" data-in="pick:${esc(line.lineId)}" aria-label="${esc(`Amount of ${line.name}`)}" value="${esc(pick.amount)}"${pick.take ? "" : " disabled"} /></li>`;
    })
    .join("")}</ul></section>`;
}

export function boughtDialog(lines, picks, problemText, busy) {
  const chosen = lines.filter((line) => picks[line.lineId].take);
  return dialog({
    id: "mls-bought",
    title: "Bought",
    body: `<div class="mls-stack">${group("Ticked", lines.filter((l) => l.checkedAt !== null), picks)}${group("Not ticked", lines.filter((l) => l.checkedAt === null), picks)}${problem(problemText)}</div>`,
    footer: `${cancel}${btn(chosen.length > 0 ? `Move ${chosen.length} to the Pantry` : "Move to the Pantry", "save-bought", { disabled: busy || chosen.length === 0 })}`
  });
}

/** The `lines` for meals.list.bought, or `{problem}`. */
export function boughtInput(lines, picks) {
  const out = [];
  for (const line of lines.filter((l) => picks[l.lineId].take)) {
    const pick = picks[line.lineId];
    const entry = { lineId: line.lineId };
    if (pick.amount.trim() !== buyText(line) && pick.amount.trim() !== "") {
      const parsed = parseAmount(pick.amount);
      if (parsed === null) return { problem: `Start the amount for ${line.name} with a number, such as 2 or 500 g` };
      entry.quantity = parsed.quantity;
      if (parsed.unit !== null) entry.unit = parsed.unit;
    }
    out.push(entry);
  }
  return { lines: out };
}
