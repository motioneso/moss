import { esc } from "./format.mjs";
import { btn, caption, dialog, field, input } from "./kit.mjs";

const problem = (text) =>
  text ? `<p class="jds-hint jds-hint--error" role="alert">${esc(text)}</p>` : "";
const cancel = btn("Cancel", "dialog-close", { variant: "secondary" });

/** An amount typed into the Amount box. Null when it is not a number above 0. */
function readQuantity(text) {
  const value = Number(text.trim());
  return Number.isFinite(value) && value > 0 && value <= 1_000_000 ? value : null;
}

export function itemForm(item) {
  return {
    name: item?.name ?? "",
    amount: item?.quantity != null ? String(item.quantity) : "",
    unit: item?.unit ?? "",
    problem: null
  };
}

export function itemDialog(item, form, busy) {
  const body = `<div class="mls-form">${field("f-name", "Item", input("f-name", form.name, { extra: 'maxlength="80" placeholder="Basmati rice"' }))}<div class="mls-form-grid">${field("f-amount", "Amount", input("f-amount", form.amount, { extra: 'inputmode="decimal" placeholder="Optional"' }))}${field("f-unit", "Unit", input("f-unit", form.unit, { extra: 'maxlength="24" placeholder="lb, can, bag"' }))}</div><p class="jds-hint">Leave the amount blank when you have some but no measured amount.</p>${problem(form.problem)}</div>`;
  const remove = item
    ? btn("Remove", "remove-item", {
        variant: "danger",
        disabled: busy,
        data: `data-item="${esc(item.itemId)}"`
      })
    : "";
  return dialog({
    id: "mls-item",
    title: item ? `Edit ${esc(item.name)}` : "Add to the Pantry",
    body,
    footer: `${remove}${cancel}${btn(item ? "Save" : "Add", "save-item", { disabled: busy })}`
  });
}

/** The tool input for a save, or `{problem}`. */
export function itemInput(item, form) {
  if (form.name.trim() === "") return { problem: "Enter the item first" };
  const quantity = form.amount.trim() === "" ? null : readQuantity(form.amount);
  if (form.amount.trim() !== "" && quantity === null) {
    return { problem: "Enter the amount as a number above 0, or leave it blank for some" };
  }
  return {
    input: {
      action: item ? "update" : "add",
      ...(item ? { itemId: item.itemId } : {}),
      name: form.name.trim(),
      quantity,
      unit: quantity === null || form.unit.trim() === "" ? null : form.unit.trim()
    }
  };
}

export function staplesDialog(staples, name, busy, failed) {
  const list =
    staples.length > 0
      ? `<ul class="mls-list">${staples
          .map(
            (st) =>
              `<li class="mls-line mls-line--plain"><span class="mls-line__body"><span class="mls-line__name">${esc(st.name)}</span></span><span class="mls-line__tools">${btn("Remove", "remove-staple", { variant: "quiet", sm: true, disabled: busy, data: `aria-label="Stop keeping ${esc(st.name)}" data-staple="${esc(st.stapleId)}"` })}</span></li>`
          )
          .join("")}</ul>`
      : caption("No Staples yet.");
  const add = `<div class="mls-inline-add">${input("f-staple", name, { label: "New Staple", extra: 'maxlength="80" placeholder="Add a Staple" data-enter="add-staple"' })}${btn("Add", "add-staple", { variant: "secondary", disabled: busy || name.trim() === "" })}</div>`;
  return dialog({
    id: "mls-staples",
    title: "Staples",
    body: `<div class="jds-dialog__desc">Things you always have, such as salt, oil and water. They never go on the shopping list.</div><div class="mls-stack">${list}${add}${problem(failed)}</div>`,
    footer: btn("Done", "dialog-close")
  });
}
