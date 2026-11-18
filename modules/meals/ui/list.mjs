/* global document, navigator, window */
import { noticeFor } from "./api.mjs";
import { amountText, esc, PANTRY_LABEL, todayIso } from "./format.mjs";
import { badge, btn, caption, checkbox, dialog, empty, recovery } from "./kit.mjs";
import {
  addDialog, addInput, boughtDialog, boughtInput, boughtPicks, buyText, editDialog, editInput,
  SECTION_LABELS, SECTION_ORDER
} from "./list-dialogs.mjs";

const TOAST_MS = 8000;

function sourcesText(line) {
  if (line.notInPlan) return "No longer in the plan";
  if (line.sources.length > 0) return `For ${line.sources.map((s) => s.label).join(", ")}`;
  return line.convertedFrom.join(", ");
}

/** The Shopping list area: lines by store section, ticking, add and edit, Bought, Undo. */
export function listScreen(ctx) {
  const s = {
    kind: "loading", list: null, plan: null, busy: false, failed: null, toast: null,
    dialog: null, form: null, lineId: null, picks: {}, problem: null
  };
  let toastTimer = null;
  let wake = null;

  async function load() {
    try {
      s.list = await ctx.api.read("meals.list.get");
      s.kind = "ready";
    } catch {
      if (s.kind !== "ready") s.kind = "error";
    }
    try {
      s.plan = (await ctx.api.read("meals.plan.current", { date: todayIso() })).plan;
    } catch {
      s.plan = null;
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

  async function run(tool, params, toastFor, opts) {
    if (s.busy) return false;
    s.busy = true;
    s.failed = null;
    ctx.draw();
    const outcome = await ctx.api.write(tool, params, opts);
    s.busy = false;
    if (outcome.kind === "succeeded") {
      const raw = outcome.result;
      const result = "list" in raw ? raw : { list: raw };
      s.list = result.list;
      showToast(toastFor ? toastFor(result) : null);
      ctx.draw();
      return true;
    }
    s.failed = noticeFor(outcome);
    ctx.draw();
    return false;
  }

  const lineOf = (id) => s.list.lines.find((l) => l.lineId === id);
  const closeDialog = () => {
    s.dialog = null;
    s.form = null;
    s.problem = null;
  };

  async function remove(id) {
    const line = lineOf(id);
    const done = await run("meals.list.edit", { action: "remove", lineId: id }, (r) => ({
      text: `Removed ${line.name}`,
      undo: r.undo
    }));
    if (done) closeDialog();
    ctx.draw();
  }

  const open = () => s.list.lines.filter((l) => l.boughtAt === null);
  const shopping = () => open().filter((l) => !l.coveredByPantry);

  const acts = {
    "retry-load": () => {
      s.kind = "loading";
      ctx.draw();
      void load();
    },
    tick: (el) => {
      const line = lineOf(el.dataset.line);
      return run("meals.list.edit", { action: line.checkedAt === null ? "tick" : "untick", lineId: line.lineId });
    },
    "hit": (el) => (s.busy ? undefined : acts.tick(el)),
    edit: (el) => {
      const line = lineOf(el.dataset.line);
      s.lineId = line.lineId;
      s.form = { name: line.name, amount: buyText(line), section: line.section };
      s.dialog = "edit";
      ctx.focus("f-name");
      ctx.draw();
    },
    "remove-line": (el) => remove(el.dataset.line),
    add: () => {
      s.form = { name: "", amount: "", section: "other" };
      s.dialog = "add";
      ctx.focus("f-name");
      ctx.draw();
    },
    "save-add": async () => {
      const r = addInput(s.form);
      if (r.problem) {
        s.form.problem = r.problem;
        return ctx.draw();
      }
      if (await run("meals.list.edit", r.input)) closeDialog();
      ctx.draw();
    },
    "save-edit": async () => {
      const r = editInput(lineOf(s.lineId), s.form);
      if (r.problem) {
        s.form.problem = r.problem;
        return ctx.draw();
      }
      if (await run("meals.list.edit", r.input)) closeDialog();
      ctx.draw();
    },
    bought: () => {
      s.picks = boughtPicks(shopping());
      s.problem = null;
      s.dialog = "bought";
      ctx.draw();
    },
    pick: (el) => {
      s.picks[el.dataset.line].take = el.checked;
      ctx.draw();
    },
    "save-bought": async () => {
      const r = boughtInput(shopping(), s.picks);
      if (r.problem) {
        s.problem = r.problem;
        return ctx.draw();
      }
      const done = await run("meals.list.bought", { lines: r.lines }, (res) => ({
        text: `${res.undo.count} bought and moved to the Pantry`,
        undo: res.undo
      }));
      if (done) closeDialog();
      ctx.draw();
    },
    build: () => run("meals.list.build", { planId: s.plan.planId }),
    clear: () => {
      s.dialog = "clear";
      ctx.draw();
    },
    "confirm-clear": async () => {
      closeDialog();
      s.busy = true;
      s.failed = null;
      ctx.draw();
      const outcome = await ctx.api.write("meals.list.clear", { listId: s.list.listId }, { confirmed: true });
      s.busy = false;
      s.failed = noticeFor(outcome);
      await load();
    },
    "dialog-close": () => {
      closeDialog();
      ctx.draw();
    },
    "ask-moss": () => ctx.chat("Add to my shopping list: "),
    undo: async () => {
      const token = s.toast?.undo;
      showToast(null);
      if (!token) return ctx.draw();
      const outcome = await ctx.api.write("meals.undo", { actionId: token.actionId });
      await load();
      if (outcome.kind === "succeeded") {
        const skipped = outcome.result.skipped ?? 0;
        if (skipped > 0) {
          showToast({
            text: `Undone. ${skipped} Pantry ${skipped === 1 ? "amount" : "amounts"} you changed ${skipped === 1 ? "was" : "were"} left alone.`,
            undo: null
          });
          ctx.draw();
        }
      } else {
        s.failed = noticeFor(outcome);
        ctx.draw();
      }
    }
  };

  function input(name, value) {
    if (name.startsWith("pick:")) {
      s.picks[name.slice(5)].amount = value;
    } else if (s.form) {
      const key = { "f-name": "name", "f-amount": "amount", "f-section": "section" }[name];
      if (key) s.form[key] = value;
    }
  }

  function row(line) {
    const ticked = line.checkedAt !== null;
    const buy = buyText(line);
    const need = !line.manual && line.quantity !== null && line.purchase !== null ? amountText(line.quantity, line.unit) : "";
    const meta = sourcesText(line);
    const hit = `data-act="hit" data-line="${esc(line.lineId)}"`;
    return `<li class="mls-line${ticked ? " mls-line--done" : ""}">${checkbox(`Got ${line.name}`, ticked, "tick", `data-line="${esc(line.lineId)}"`, s.busy)}<span class="mls-line__body mls-line__hit" ${hit}><span class="mls-line__name">${esc(line.name)}</span>${
      meta ? `<span class="jds-caption">${esc(meta)}</span>` : ""
    }${line.sources.length > 0 && line.convertedFrom.length > 0 ? `<span class="jds-caption">${esc(line.convertedFrom.join(", "))}</span>` : ""}${
      line.manual || line.notInPlan
        ? `<span class="mls-row">${line.manual ? badge("Added") : ""}${line.notInPlan ? badge("Not in the plan", { tone: "amber" }) : ""}</span>`
        : ""
    }</span><span class="mls-line__amount mls-line__hit" ${hit}><span class="mls-num">${esc(buy)}</span>${
      need !== "" && need !== buy ? `<span class="jds-caption">Needs ${esc(need)}</span>` : ""
    }</span><span class="mls-line__tools">${btn("Edit", "edit", { variant: "quiet", sm: true, disabled: s.busy, data: `aria-label="Edit ${esc(line.name)}" data-line="${esc(line.lineId)}"` })}${
      line.manual ? btn("Remove", "remove-line", { variant: "quiet", sm: true, disabled: s.busy, data: `aria-label="Remove ${esc(line.name)}" data-line="${esc(line.lineId)}"` }) : ""
    }</span></li>`;
  }

  const section = (name, lines) => {
    const done = lines.filter((l) => l.checkedAt !== null).length;
    return `<section class="mls-section" aria-label="${esc(name)}"><div class="mls-block-head"><h3 class="jds-card-title">${esc(name)}</h3><span class="jds-caption">${done > 0 ? `${done} of ${lines.length}` : lines.length}</span></div><ul class="mls-list mls-list--shop">${lines.map(row).join("")}</ul></section>`;
  };

  function render() {
    if (s.kind === "loading") return caption("Loading the shopping list", ' role="status"');
    if (s.kind === "error") {
      return recovery("Couldn't load the shopping list", "Check the connection, then try again.", btn("Try again", "retry-load", { variant: "secondary", sm: true }));
    }
    const list = s.list;
    const lines = open();
    const buying = shopping();
    const covered = lines.filter((l) => l.coveredByPantry);
    const ticked = buying.filter((l) => l.checkedAt !== null);
    const percent = buying.length > 0 ? Math.round((ticked.length / buying.length) * 100) : 0;
    const offerBuild =
      s.plan !== null && s.plan.planId !== list.planId && s.plan.days.some((d) => d.meals.some((m) => m.status === "ready"));
    const build = offerBuild ? btn("Build from the plan", "build", { variant: "secondary", disabled: s.busy }) : "";
    const controls = `${build}${btn("Add item", "add", { variant: "secondary" })}${btn("Clear list", "clear", { variant: "quiet", disabled: s.busy || list.lines.length === 0 })}${btn(ticked.length > 0 ? `Bought (${ticked.length})` : "Bought", "bought", { disabled: s.busy || lines.length === 0 })}`;
    let body;
    if (lines.length === 0) {
      body = empty("Nothing to buy", "", `${build}${btn("Add item", "add")}`);
    } else {
      const sections = SECTION_ORDER.map((key) => {
        const group = buying.filter((l) => l.section === key);
        return group.length > 0 ? section(SECTION_LABELS[key], group) : "";
      }).join("");
      const have =
        covered.length > 0
          ? `<section class="mls-section" aria-label="You have this"><div class="mls-block-head"><h3 class="jds-card-title">You have this</h3><span class="jds-caption">${covered.length}</span></div><ul class="mls-list">${covered
              .map(
                (l) =>
                  `<li class="mls-line mls-line--plain"><span class="mls-line__body"><span class="mls-line__name">${esc(l.name)}</span>${sourcesText(l) ? `<span class="jds-caption">${esc(sourcesText(l))}</span>` : ""}</span><span class="mls-line__amount"><span class="mls-num">${esc(buyText(l))}</span><span class="jds-caption">In the Pantry</span></span></li>`
              )
              .join("")}</ul></section>`
          : "";
      body = `<div class="mls-planbar"><div class="mls-progress"><span class="jds-caption"><strong class="mls-num">${ticked.length}</strong> of ${buying.length} got</span>${badge(esc(PANTRY_LABEL[list.pantryMode]), { outline: true })}<div class="jds-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent}" aria-label="Shopping progress"><div class="jds-progress__fill" style="width:${percent}%"></div></div></div><div class="mls-row mls-hide-phone">${controls}</div></div>${
        s.failed ? caption(esc(s.failed), ' role="alert"') : ""
      }<div class="mls-stack">${sections}${have}</div><div class="mls-sticky">${controls}</div>`;
    }
    const toast = s.toast
      ? `<div class="jds-toast mls-toast" role="status"><div class="jds-toast__body"><div class="jds-toast__title">${esc(s.toast.text)}</div></div>${s.toast.undo ? btn("Undo", "undo", { variant: "quiet", sm: true }) : ""}</div><div class="mls-toast-room"></div>`
      : "";
    let dlg = "";
    if (s.dialog === "add") dlg = addDialog(s.form, s.busy);
    else if (s.dialog === "edit" && lineOf(s.lineId)) dlg = editDialog(lineOf(s.lineId), s.form, s.busy);
    else if (s.dialog === "bought") dlg = boughtDialog(buying, s.picks, s.problem, s.busy);
    else if (s.dialog === "clear") {
      dlg = dialog({
        id: "mls-clear",
        title: "Clear the list",
        body: "<p>Every line on the shopping list is removed.</p>",
        footer: `${btn("Cancel", "dialog-close", { variant: "secondary" })}${btn("Clear list", "confirm-clear", { variant: "danger" })}`
      });
    }
    return `<div class="mls-stack">${body}${s.failed && lines.length === 0 ? caption(esc(s.failed), ' role="alert"') : ""}${toast}${dlg}</div>`;
  }

  return {
    start: () => {
      s.toast = null;
      s.failed = null;
      closeDialog();
      void load();
      void keepAwake();
    },
    stop: () => {
      clearTimeout(toastTimer);
      wake?.release?.().catch?.(() => {});
      wake = null;
    },
    render,
    acts,
    input
  };

  /** Keeps a touch screen on while the list shows, so it stays readable in a shop. */
  async function keepAwake() {
    if (!window.matchMedia?.("(pointer: coarse)").matches || !navigator.wakeLock) return;
    try {
      wake = await navigator.wakeLock.request("screen");
    } catch {
      wake = null;
    }
  }
}
