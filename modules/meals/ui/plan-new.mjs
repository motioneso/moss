import { noticeFor } from "./api.mjs";
import { esc, PANTRY_LABEL, todayIso } from "./format.mjs";
import { backLink, btn, caption, empty, field, hint, input, select } from "./kit.mjs";

const MAX_DAYS = 28;

/** Starts a plan: first day, how many days, Pantry mode and an optional note. */
export function planNewScreen(ctx) {
  const s = { kind: "loading", form: null, busy: false, problem: null, key: null };

  async function load() {
    let mode = "prefer";
    try {
      mode = (await ctx.api.read("meals.kitchen.get", {})).defaultPantryMode;
    } catch {
      // The form still works; the Pantry mode starts on the usual default.
    }
    s.form = { startDate: todayIso(), days: "7", mode, note: "" };
    s.kind = "ready";
    ctx.draw();
  }

  async function start() {
    const f = s.form;
    const count = Number(f.days);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(f.startDate)) {
      s.problem = "Pick a first day.";
      ctx.draw();
      return;
    }
    if (!Number.isInteger(count) || count < 1 || count > MAX_DAYS) {
      s.problem = `Days must be 1 to ${MAX_DAYS}.`;
      ctx.draw();
      return;
    }
    if (s.busy) return;
    s.busy = true;
    s.problem = null;
    ctx.draw();
    const outcome = await ctx.api.write("meals.plan.create", {
      startDate: f.startDate,
      days: count,
      pantryMode: f.mode,
      idempotencyKey: s.key,
      ...(f.note.trim() === "" ? {} : { requestText: f.note.trim() })
    });
    s.busy = false;
    if (outcome.kind !== "succeeded") {
      s.problem = noticeFor(outcome);
      ctx.draw();
      return;
    }
    ctx.go({ view: "plan" });
  }

  const acts = {
    back: () => ctx.go({ view: "plan" }),
    cancel: () => ctx.go({ view: "plan" }),
    start,
    "retry-load": () => load()
  };

  function input_(name, value) {
    const key = { "n-date": "startDate", "n-days": "days", "n-mode": "mode", "n-note": "note" }[
      name
    ];
    if (key) s.form[key] = value;
  }

  function render() {
    if (s.kind === "loading") {
      return `<div class="mls-stack">${backLink}${caption("Loading", ' role="status"')}</div>`;
    }
    if (s.kind === "error") {
      return `<div class="mls-stack">${backLink}${empty("Couldn't load this page", "", btn("Try again", "retry-load", { variant: "secondary" }))}</div>`;
    }
    const f = s.form;
    const modes = Object.keys(PANTRY_LABEL).map((value) => [value, PANTRY_LABEL[value]]);
    return `<div class="mls-stack">${backLink}<div class="mls-form"><div class="mls-form-grid">${field(
      "n-date",
      "First day",
      input("n-date", f.startDate, { type: "date" })
    )}${field(
      "n-days",
      "Days",
      input("n-days", f.days, { type: "number", extra: `min="1" max="${MAX_DAYS}"` })
    )}</div>${field("n-mode", "Pantry", select("n-mode", modes, f.mode))}${field(
      "n-note",
      "Anything you want",
      `<textarea id="n-note" class="jds-textarea" rows="3" maxlength="1000" data-in="n-note" placeholder="Optional">${esc(f.note)}</textarea>`
    )}${s.problem ? hint(s.problem) : ""}<div class="mls-row">${btn("Start the plan", "start", {
      disabled: s.busy
    })}${btn("Cancel", "cancel", { variant: "secondary" })}</div></div></div>`;
  }

  return {
    start: () => {
      s.kind = "loading";
      s.problem = null;
      s.busy = false;
      s.key = crypto.randomUUID();
      void load();
    },
    render,
    acts,
    input: input_
  };
}
