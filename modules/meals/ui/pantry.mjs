import { noticeFor } from "./api.mjs";
import { amountText, esc } from "./format.mjs";
import { btn, caption, empty, recovery } from "./kit.mjs";
import { itemDialog, itemForm, itemInput, staplesDialog } from "./pantry-dialogs.mjs";

const TOAST_MS = 8000;
const SOURCE_TEXT = {
  manual: "Added by you",
  bought: "Bought",
  leftover: "Leftover",
  receipt: "From a receipt"
};

/** The Pantry area: what the household has on hand, find, add, edit, remove with Undo, and Staples. */
export function pantryScreen(ctx) {
  const s = {
    kind: "loading",
    pantry: null,
    busy: false,
    failed: null,
    toast: null,
    dialog: null,
    itemId: null,
    form: null,
    find: "",
    staple: ""
  };
  let toastTimer = null;

  async function load() {
    try {
      s.pantry = await ctx.api.read("meals.pantry.get");
      s.kind = "ready";
    } catch {
      if (s.kind !== "ready") s.kind = "error";
    }
    ctx.draw();
  }

  function showToast(toast) {
    s.toast = toast;
    clearTimeout(toastTimer);
    if (toast) {
      toastTimer = setTimeout(() => {
        s.toast = null;
        ctx.draw();
      }, TOAST_MS);
    }
  }

  async function run(params, toastFor) {
    if (s.busy) return false;
    s.busy = true;
    s.failed = null;
    ctx.draw();
    const outcome = await ctx.api.write("meals.pantry.edit", params);
    s.busy = false;
    if (outcome.kind === "succeeded") {
      s.pantry = outcome.result.pantry;
      showToast(toastFor ? toastFor(outcome.result) : null);
      ctx.draw();
      return true;
    }
    s.failed = noticeFor(outcome);
    ctx.draw();
    return false;
  }

  const itemOf = (id) => s.pantry.items.find((i) => i.itemId === id);
  const closeDialog = () => {
    s.dialog = null;
    s.form = null;
    s.itemId = null;
    s.staple = "";
  };

  async function removeItem(id) {
    const item = itemOf(id);
    const done = await run({ action: "remove", itemId: id }, (r) => ({
      text: `Removed ${item.name}`,
      undo: r.undo
    }));
    if (done) closeDialog();
    ctx.draw();
  }

  const acts = {
    "retry-load": () => {
      s.kind = "loading";
      ctx.draw();
      void load();
    },
    add: () => {
      s.form = itemForm(null);
      s.dialog = "item";
      s.itemId = null;
      ctx.focus("f-name");
      ctx.draw();
    },
    edit: (el) => {
      s.itemId = el.dataset.item;
      s.form = itemForm(itemOf(s.itemId));
      s.dialog = "item";
      ctx.focus("f-name");
      ctx.draw();
    },
    "save-item": async () => {
      const r = itemInput(s.itemId ? itemOf(s.itemId) : null, s.form);
      if (r.problem) {
        s.form.problem = r.problem;
        return ctx.draw();
      }
      if (await run(r.input)) closeDialog();
      ctx.draw();
    },
    "remove-item": (el) => removeItem(el.dataset.item),
    remove: (el) => removeItem(el.dataset.item),
    staples: () => {
      s.dialog = "staples";
      s.failed = null;
      s.staple = "";
      ctx.focus("f-staple");
      ctx.draw();
    },
    "add-staple": async () => {
      const name = s.staple.trim();
      if (name === "") return;
      if (await run({ action: "add", target: "staple", name })) s.staple = "";
      ctx.draw();
    },
    "remove-staple": (el) =>
      run({ action: "remove", target: "staple", stapleId: el.dataset.staple }),
    "dialog-close": () => {
      closeDialog();
      s.failed = null;
      ctx.draw();
    },
    "ask-moss": () => ctx.chat("Add to my Pantry: "),
    undo: async () => {
      const token = s.toast?.undo;
      showToast(null);
      if (!token) return ctx.draw();
      const outcome = await ctx.api.write("meals.undo", { actionId: token.actionId });
      await load();
      if (outcome.kind !== "succeeded") {
        s.failed = noticeFor(outcome);
        ctx.draw();
      }
    }
  };

  function input(name, value) {
    if (name === "find") s.find = value;
    else if (name === "f-staple") s.staple = value;
    else if (s.form) {
      const key = { "f-name": "name", "f-amount": "amount", "f-unit": "unit" }[name];
      if (key) s.form[key] = value;
    }
  }

  function row(item) {
    const amount =
      item.quantity !== null
        ? `<span class="mls-num">${esc(amountText(item.quantity, item.unit))}</span>`
        : '<span class="jds-caption">Some</span>';
    const tools = `${btn("Edit", "edit", { variant: "quiet", sm: true, disabled: s.busy, data: `aria-label="Edit ${esc(item.name)}" data-item="${esc(item.itemId)}"` })}${btn("Remove", "remove", { variant: "quiet", sm: true, disabled: s.busy, data: `aria-label="Remove ${esc(item.name)}" data-item="${esc(item.itemId)}"` })}`;
    return `<li class="mls-line mls-line--plain mls-line--tools"><span class="mls-line__body"><span class="mls-line__name">${esc(item.name)}</span><span class="jds-caption">${SOURCE_TEXT[item.source] ?? ""}</span></span><span class="mls-line__amount">${amount}</span><span class="mls-line__tools">${tools}</span></li>`;
  }

  function rail(pantry) {
    const list =
      pantry.staples.length > 0
        ? `<ul class="mls-table">${pantry.staples.map((st) => `<li><span>${esc(st.name)}</span></li>`).join("")}</ul>`
        : caption("No Staples yet.");
    return `<aside class="mls-rail" aria-label="Staples"><section class="mls-stack mls-stack--tight"><p class="jds-eyebrow">Staples</p>${list}${btn("Edit Staples", "staples", { variant: "link", sm: true })}</section></aside>`;
  }

  function render() {
    if (s.kind === "loading") return caption("Loading the Pantry", ' role="status"');
    if (s.kind === "error") {
      return recovery(
        "Couldn't load the Pantry",
        "Check the connection, then try again.",
        btn("Try again", "retry-load", { variant: "secondary", sm: true })
      );
    }
    const pantry = s.pantry;
    const needle = s.find.trim().toLowerCase();
    const shown =
      needle === ""
        ? pantry.items
        : pantry.items.filter((i) => i.name.toLowerCase().includes(needle));
    const add = btn("Add item", "add");
    let body;
    if (pantry.items.length === 0) {
      body = `<div class="mls-grid">${empty("The Pantry is empty", "", add)}${rail(pantry)}</div>`;
    } else {
      const main =
        shown.length > 0
          ? `<section class="mls-section" aria-label="On hand"><div class="mls-block-head"><h3 class="jds-card-title">On hand</h3><span class="jds-caption">${shown.length}</span></div><ul class="mls-list">${shown.map(row).join("")}</ul></section>`
          : empty("No item matches", "");
      body = `<div class="mls-planbar"><div class="mls-find"><input id="find" type="search" class="jds-input jds-input--sm" data-in="find" value="${esc(s.find)}" aria-label="Find an item" placeholder="Find an item" /><span class="jds-caption"><strong class="mls-num">${shown.length}</strong> ${shown.length === 1 ? "item" : "items"}</span></div><div class="mls-row mls-hide-phone">${add}</div></div>${
        s.failed && !s.dialog ? caption(esc(s.failed), ' role="alert"') : ""
      }<div class="mls-grid"><div class="mls-stack">${main}</div>${rail(pantry)}</div><div class="mls-sticky">${add}</div>`;
    }
    const toast = s.toast
      ? `<div class="jds-toast mls-toast" role="status"><div class="jds-toast__body"><div class="jds-toast__title">${esc(s.toast.text)}</div></div>${s.toast.undo ? btn("Undo", "undo", { variant: "quiet", sm: true }) : ""}</div><div class="mls-toast-room"></div>`
      : "";
    let dlg = "";
    if (s.dialog === "item") dlg = itemDialog(s.itemId ? itemOf(s.itemId) : null, s.form, s.busy);
    else if (s.dialog === "staples")
      dlg = staplesDialog(pantry.staples, s.staple, s.busy, s.failed);
    return `<div class="mls-stack">${body}${s.failed && pantry.items.length === 0 && !s.dialog ? caption(esc(s.failed), ' role="alert"') : ""}${toast}${dlg}</div>`;
  }

  return {
    start: () => {
      s.toast = null;
      s.failed = null;
      closeDialog();
      void load();
    },
    stop: () => clearTimeout(toastTimer),
    render,
    acts,
    input
  };
}
