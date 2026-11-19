/* global document */
import { noticeFor } from "./api.mjs";
import { dayTitle, esc, todayIso } from "./format.mjs";
import { btn, caption, empty, eyebrow, recovery } from "./kit.mjs";
import {
  addDialog,
  deleteDialog,
  editDialog,
  newAddForm,
  newEditForm,
  readAdd,
  readEdit,
  setEditField
} from "./log-dialogs.mjs";
import { amount, entryCalories, occasionOf, OCCASIONS, shiftDay, timeText } from "./log-format.mjs";

const POLL_MS = 5000;

function zone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

function nowTime() {
  const now = new Date();
  return `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
}

const newKey = () => `log-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

function figure(label, value, target, unit) {
  return `<div class="mls-figure"><span class="jds-caption">${label}</span><span class="mls-figure__value mls-num">${amount(
    value,
    1
  )}${value !== null ? `<span class="jds-caption">${` ${unit}`}</span>` : ""}</span>${
    target !== null
      ? `<span class="jds-caption mls-num">${`of ${amount(target)} ${unit}`}</span>`
      : ""
  }</div>`;
}

function totals(day) {
  const { totals: sum, targets, calorieFit } = day;
  if (sum === null) return "";
  const n = sum.nutrients;
  const fit =
    calorieFit === null
      ? ""
      : `<span class="jds-caption">${
          calorieFit.band === "on"
            ? "On target"
            : `${amount(Math.abs(calorieFit.differenceKcal))} kcal ${calorieFit.band}`
        }</span>`;
  return `<section class="mls-totals" aria-label="Day totals"><div class="mls-figure mls-figure--lead">${eyebrow("Calories")}<span class="mls-figure__big mls-num">${amount(
    n.caloriesKcal
  )}</span>${
    targets.caloriesKcal !== null
      ? `<span class="jds-caption mls-num">${`of ${amount(targets.caloriesKcal)} kcal`}</span>`
      : ""
  }${fit}</div>${figure("Protein", n.proteinG, targets.proteinG, "g")}${figure(
    "Carbs",
    n.carbohydratesG,
    targets.carbG,
    "g"
  )}${figure("Fat", n.fatG, targets.fatG, "g")}</section>`;
}

/** The Log area: one day of meals by part of the day, the totals against targets, add, edit, retry, delete. */
export function logScreen(ctx) {
  const s = {
    kind: "loading",
    date: todayIso(),
    forDate: null,
    day: null,
    busy: false,
    failed: null,
    dialog: null,
    form: null,
    open: new Set()
  };
  let timer = null;
  let gen = 0;

  async function load() {
    const asked = s.date;
    const mine = gen;
    try {
      const day = await ctx.api.read("meals.log.list", { localDate: asked });
      if (asked === s.date) {
        s.day = day;
        s.forDate = asked;
        s.kind = "ready";
      }
    } catch {
      if (!(s.kind === "ready" && s.forDate === asked)) s.kind = "error";
    }
    if (mine !== gen) return;
    if (s.dialog === null || s.busy) ctx.draw();
    schedule();
  }

  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (document.visibilityState === "visible" && ctx.current() === "log" && !s.busy) {
        void load();
      } else schedule();
    }, POLL_MS);
  }

  function setDate(date) {
    s.date = date;
    s.kind = s.forDate === date ? "ready" : "loading";
    ctx.draw();
    void load();
  }

  async function run(tool, params, options) {
    if (s.busy) return false;
    s.busy = true;
    s.failed = null;
    ctx.draw();
    const outcome = await ctx.api.write(tool, params, options);
    s.busy = false;
    if (outcome.kind !== "succeeded") {
      s.failed = noticeFor(outcome);
      ctx.draw();
      return false;
    }
    await load();
    return true;
  }

  const consumedAt = (time) => `${s.date}T${time}:00`;
  const entryOf = (el) => s.day.entries.find((e) => e.entryId === el.dataset.entry);

  const acts = {
    "retry-load": () => {
      s.kind = "loading";
      ctx.draw();
      void load();
    },
    prev: () => setDate(shiftDay(s.date, -1)),
    next: () => setDate(shiftDay(s.date, 1)),
    today: () => setDate(todayIso()),
    "ask-moss": () => ctx.chat("Log a meal: "),
    "open-add": () => {
      s.dialog = "add";
      s.form = newAddForm(s.date === todayIso() ? nowTime() : "12:00");
      s.form.key = newKey();
      ctx.draw();
    },
    "save-add": async () => {
      const checked = readAdd(s.form);
      if (checked.problem) {
        s.form.problem = checked.problem;
        ctx.draw();
        return;
      }
      const { description, servingNote, time } = checked.input;
      const tz = zone();
      const done = await run("meals.log.add", {
        description,
        ...(servingNote !== null ? { servingNote } : {}),
        consumedAt: consumedAt(time),
        ...(tz !== null ? { timeZone: tz } : {}),
        captureKind: "text",
        idempotencyKey: s.form.key
      });
      if (done) closeDialog();
    },
    "open-edit": (el) => {
      s.dialog = "edit";
      s.form = newEditForm(entryOf(el));
      ctx.draw();
    },
    "save-edit": async () => {
      // A background estimate can move the revision while the dialog is open.
      try {
        const fresh = await ctx.api.read("meals.log.list", { localDate: s.date });
        const now = fresh.entries.find((e) => e.entryId === s.form.entry.entryId);
        if (now) s.form.entry = { ...s.form.entry, estimateRevision: now.estimateRevision };
      } catch {
        // The save below reports any real failure.
      }
      const checked = readEdit(s.form);
      if (checked.problem) {
        s.form.problem = checked.problem;
        ctx.draw();
        return;
      }
      const tz = zone();
      const done = await run("meals.log.correct", {
        ...checked.input,
        ...(checked.timeChanged ? { consumedAt: consumedAt(checked.time) } : {}),
        ...(checked.timeChanged && tz !== null ? { timeZone: tz } : {})
      });
      if (done) closeDialog();
    },
    retry: (el) => run("meals.log.reestimate", { entryId: el.dataset.entry }),
    "ask-delete": (el) => {
      s.dialog = "delete";
      s.form = entryOf(el);
      ctx.draw();
    },
    "confirm-delete": async () => {
      const entry = s.form;
      closeDialog(false);
      await run("meals.log.delete", { entryId: entry.entryId }, { confirmed: true });
    },
    foods: (el) => {
      const id = el.dataset.entry;
      if (s.open.has(id)) s.open.delete(id);
      else s.open.add(id);
      ctx.draw();
    },
    "dialog-close": () => closeDialog()
  };

  function closeDialog(draw = true) {
    s.dialog = null;
    s.form = null;
    if (draw) ctx.draw();
  }

  function input_(name, value) {
    if (s.dialog === "add") {
      const key = { "a-desc": "description", "a-serving": "serving", "a-time": "time" }[name];
      if (key) s.form[key] = value;
    } else if (s.dialog === "edit") setEditField(s.form, name, value);
  }

  function dayNav() {
    const today = todayIso();
    return `<div class="mls-row"><div class="mls-row">${btn("Previous", "prev", {
      variant: "quiet",
      sm: true,
      data: 'aria-label="Previous day"'
    })}<h3 class="jds-card-title">${s.date === today ? "Today" : esc(dayTitle(s.date))}</h3>${btn(
      "Next",
      "next",
      {
        variant: "quiet",
        sm: true,
        disabled: s.date >= today,
        data: 'aria-label="Next day"'
      }
    )}</div>${s.date !== today ? btn("Back to today", "today", { variant: "link", sm: true }) : ""}</div>`;
  }

  function entryRow(entry) {
    const state = entry.estimateState;
    const hasItems = entry.items.length > 0;
    const open = s.open.has(entry.entryId);
    const d = `data-entry="${esc(entry.entryId)}"`;
    const note = [
      timeText(entry),
      entry.servingNote,
      state === "pending" ? "Estimating" : null,
      state === "failed" ? "Could not estimate" : null,
      state === "needs_details" ? "Needs a detail" : null
    ]
      .filter(Boolean)
      .join(", ");
    const tool = (label, act, extra = "") =>
      btn(label, act, {
        variant: "quiet",
        sm: true,
        disabled: s.busy,
        data: `${d}${extra ? ` ${extra}` : ""}`
      });
    const items =
      open && hasItems
        ? `<ul class="mls-table">${entry.items
            .map(
              (item) =>
                `<li><span>${esc([item.label, item.portionNote].filter(Boolean).join(", "))}</span><span class="mls-num">${`${amount(
                  item.nutrients.caloriesKcal
                )} kcal`}</span></li>`
            )
            .join("")}</ul>`
        : "";
    return `<li class="mls-entry"><div class="mls-entry__main"><span class="mls-line__body"><span class="mls-line__name">${esc(
      entry.description
    )}</span><span class="jds-caption">${esc(note)}</span></span><span class="mls-line__amount"><span class="mls-num">${esc(
      entryCalories(entry)
    )}</span><span class="jds-caption">kcal</span></span></div>${
      state === "needs_details" && entry.clarificationQuestion !== null
        ? `<p class="jds-caption mls-safety">${esc(entry.clarificationQuestion)}</p>`
        : ""
    }${items}<div class="mls-line__tools">${
      hasItems ? tool(open ? "Hide foods" : "Show foods", "foods") : ""
    }${state === "failed" ? tool("Retry", "retry", `aria-label="Retry ${esc(entry.description)}"`) : ""}${tool(
      "Edit",
      "open-edit",
      `aria-label="Edit ${esc(entry.description)}"`
    )}${tool("Delete", "ask-delete", `aria-label="Delete ${esc(entry.description)}"`)}</div></li>`;
  }

  function dayView() {
    const day = s.day;
    const add = btn("Log a meal", "open-add");
    const uncounted = day.totals?.entriesWithoutEstimate ?? 0;
    const body =
      day.entries.length === 0
        ? empty("Nothing logged", "", add)
        : `${totals(day)}${
            uncounted > 0
              ? caption(
                  uncounted === 1
                    ? "1 meal is not counted yet."
                    : `${uncounted} meals are not counted yet.`
                )
              : ""
          }${OCCASIONS.map(([value, label]) => {
            const rows = day.entries.filter((entry) => occasionOf(entry) === value);
            if (rows.length === 0) return "";
            return `<section class="mls-section" aria-label="${label}"><div class="mls-block-head"><h3 class="jds-card-title">${label}</h3><span class="jds-caption">${rows.length}</span></div><ul class="mls-list">${rows
              .map(entryRow)
              .join("")}</ul></section>`;
          }).join("")}<div class="mls-sticky">${add}</div>`;
    return `<div class="mls-stack"><div class="mls-planbar">${dayNav()}<div class="mls-row mls-hide-phone">${add}</div></div>${
      s.failed ? caption(esc(s.failed), ' role="alert"') : ""
    }${body}${
      s.dialog === "add"
        ? addDialog(s.form, s.busy)
        : s.dialog === "edit"
          ? editDialog(s.form, s.busy)
          : s.dialog === "delete"
            ? deleteDialog(s.form, s.busy)
            : ""
    }</div>`;
  }

  function render() {
    const nav = `<div class="mls-planbar">${dayNav()}</div>`;
    if (s.kind === "loading" || (s.kind === "ready" && s.forDate !== s.date)) {
      return `<div class="mls-stack">${nav}${caption("Loading the Log", ' role="status"')}</div>`;
    }
    if (s.kind === "error") {
      return `<div class="mls-stack">${nav}${recovery(
        "Couldn't load the Log",
        "Check the connection, then try again.",
        btn("Try again", "retry-load", { variant: "secondary", sm: true })
      )}</div>`;
    }
    return dayView();
  }

  return {
    start: () => {
      gen += 1;
      clearTimeout(timer);
      s.failed = null;
      s.dialog = null;
      s.form = null;
      s.kind = s.forDate === s.date ? "ready" : "loading";
      void load();
    },
    stop: () => {
      gen += 1;
      clearTimeout(timer);
    },
    render,
    acts,
    input: input_
  };
}
