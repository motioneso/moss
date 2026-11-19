/* global document */
import { noticeFor } from "./api.mjs";
import {
  dateRange,
  esc,
  isWriting,
  PANTRY_LABEL,
  PAUSE_TEXT,
  plural,
  todayIso,
  tonight
} from "./format.mjs";
import { badge, btn, caption, dialog, empty, field, input, masthead, recovery } from "./kit.mjs";
import { daySection } from "./plan-day.mjs";

const POLL_MS = 4000;

/** The Plan area: tonight's dinner, then the plan day by day as Moss writes it. */
export function planScreen(ctx) {
  const s = {
    kind: "loading",
    plan: null,
    busy: false,
    failed: null,
    dialog: null,
    quickMeal: null,
    quickMinutes: "15",
    ui: { oneOffSlot: {}, oneOffMember: {} },
    notice: null
  };
  let timer = null;

  async function load() {
    try {
      const result = await ctx.api.read("meals.plan.current", { date: todayIso() });
      if (result.plan === null) {
        s.kind = "empty";
        s.plan = null;
      } else {
        s.kind = "ready";
        s.plan = result.plan;
      }
    } catch {
      if (s.kind !== "ready") s.kind = "error";
    }
    ctx.draw();
    schedule();
  }

  function schedule() {
    clearTimeout(timer);
    if (s.kind === "ready" && isWriting(s.plan)) {
      timer = setTimeout(() => {
        if (document.visibilityState === "visible" && ctx.current() === "plan") void load();
        else schedule();
      }, POLL_MS);
    }
  }

  async function run(tool, params, { confirmed = false, keepFailure = false } = {}) {
    if (s.busy) return null;
    s.busy = true;
    s.failed = null;
    ctx.draw();
    const outcome = await ctx.api.write(tool, params, { confirmed });
    s.busy = false;
    s.failed = noticeFor(outcome);
    if (keepFailure && outcome.kind === "succeeded") s.failed = null;
    await load();
    return outcome;
  }

  const control = (input) => run("meals.plan.control", { planId: s.plan.planId, ...input });
  const dayOf = (el) => el.dataset.day;

  const acts = {
    swap: async (el) => {
      const outcome = await run("meals.meal.swap", {
        mealId: el.dataset.meal,
        action: "request_choices"
      });
      if (outcome?.kind === "succeeded") ctx.go({ view: "swap", id: el.dataset.meal });
    },
    move: (el) => ctx.go({ view: "move", id: el.dataset.meal }),
    eaters: (el) => ctx.go({ view: "eaters", id: el.dataset.meal }),
    text: (el) => ctx.go({ view: "text", id: el.dataset.meal }),
    "new-plan": () => ctx.go({ view: "new" }),
    "open-recipe": (el) => ctx.go({ view: "recipe", id: el.dataset.meal }),
    lock: (el) => run("meals.meal.edit", { mealId: el.dataset.meal, action: "lock" }),
    unlock: (el) => run("meals.meal.edit", { mealId: el.dataset.meal, action: "unlock" }),
    "regen-meal": (el) => control({ action: "regenerate", mealId: el.dataset.meal }),
    "regen-day": (el) => control({ action: "regenerate", dayId: dayOf(el) }),
    "retry-day": (el) => control({ action: "retry_day", dayId: dayOf(el) }),
    stop: () => control({ action: "stop" }),
    resume: () => control({ action: "resume" }),
    "delete-plan": () => {
      s.dialog = "delete";
      ctx.draw();
    },
    "confirm-delete": () => {
      s.dialog = null;
      return run("meals.plan.delete", { planId: s.plan.planId }, { confirmed: true });
    },
    sharing: (el) =>
      run("meals.day.edit", {
        dayId: dayOf(el),
        action: "set_sharing",
        slotName: el.dataset.slot,
        sharing: el.dataset.to
      }),
    "one-off": (el) => {
      const day = dayOf(el);
      const plan = s.plan.days.find((d) => d.dayId === day);
      const slots = [...new Set(plan.meals.map((m) => m.slotName))];
      const people = [...new Set(plan.meals.flatMap((m) => m.eaters.map((e) => e.memberId)))];
      return run("meals.day.edit", {
        dayId: day,
        action: "add_one_off",
        slotName: s.ui.oneOffSlot[day] ?? slots[0] ?? "dinner",
        memberId: s.ui.oneOffMember[day] ?? people[0] ?? ""
      });
    },
    "ask-moss": () => ctx.chat("Plan my meals for the next week"),
    "open-regen": () => {
      s.dialog = "regen";
      ctx.draw();
    },
    "open-replan": () => {
      s.dialog = "replan";
      ctx.draw();
    },
    "quick-swap": (el) => {
      s.quickMeal = el.dataset.meal;
      s.quickMinutes = "15";
      s.dialog = "quick";
      ctx.draw();
    },
    "dialog-close": () => {
      s.dialog = null;
      ctx.draw();
    },
    "confirm-regen": () => {
      s.dialog = null;
      return control({ action: "regenerate" });
    },
    "confirm-replan": () => {
      s.dialog = null;
      return control({
        action: "replan",
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone
      });
    },
    "confirm-quick": async () => {
      const maxMinutes = Number(s.quickMinutes);
      if (!Number.isInteger(maxMinutes) || maxMinutes < 5 || maxMinutes > 240) {
        s.failed = "Quick swap needs a time between 5 and 240 minutes.";
        ctx.draw();
        return;
      }
      const mealId = s.quickMeal;
      s.dialog = null;
      s.quickMeal = null;
      await run("meals.meal.swap", { mealId, action: "quick", maxMinutes });
    }
  };

  function input_(name, value) {
    if (name === "quick-minutes") s.quickMinutes = value;
    else if (name.startsWith("limit:"))
      void run("meals.day.edit", {
        dayId: name.slice(6),
        action: "set_cook_limit",
        minutes: value === "" ? null : Number(value)
      });
    else if (name.startsWith("slot:")) {
      s.ui.oneOffSlot[name.slice(5)] = value;
      ctx.draw();
    } else if (name.startsWith("who:")) {
      s.ui.oneOffMember[name.slice(4)] = value;
      ctx.draw();
    }
  }

  function render() {
    if (s.kind === "loading") return caption("Loading your plan", ' role="status"');
    if (s.kind === "error") {
      return recovery(
        "Couldn't load your plan",
        "Check the connection, then try again.",
        btn("Try again", "retry-load", { variant: "secondary", sm: true })
      );
    }
    if (s.kind === "empty") {
      return `${empty("Plan your first week", "", `<div class="mls-row">${btn("Plan with Moss", "ask-moss")}${btn("Start a plan", "new-plan", { variant: "secondary" })}</div>`)}${
        s.notice ? caption(esc(s.notice), ' role="status"') : ""
      }`;
    }
    return plan();
  }

  function plan() {
    const p = s.plan;
    const today = todayIso();
    const writing = isWriting(p);
    const last = p.days[p.days.length - 1]?.date ?? p.startDate;
    const range = dateRange(p.startDate, last);
    const dinner = tonight(p, today);
    const people = new Set(
      p.days.flatMap((d) => d.meals.flatMap((m) => m.eaters.map((e) => e.memberId)))
    );
    const hasDaysToCome = p.days.some((d) => d.date >= today);
    const locked = p.days.reduce((sum, d) => sum + d.meals.filter((m) => m.locked).length, 0);
    const lockedText =
      locked > 0 ? ` ${locked === 1 ? "1 locked meal stays" : `${locked} locked meals stay`}.` : "";
    const done = p.progress.ready;
    const total = p.progress.total;
    const current =
      p.days.find((d) => d.status === "writing") ?? p.days.find((d) => d.status === "pending");
    const lead = writing
      ? masthead({ eyebrow: `${esc(range)} · Moss is writing`, title: "Writing your plan" })
      : dinner !== null
        ? masthead({
            eyebrow: "Tonight · Dinner",
            title: esc(dinner.title),
            lede: esc(
              `${dinner.cookMinutes !== null ? `${dinner.cookMinutes} minutes, for ` : "For "}${dinner.eaters.map((e) => e.name).join(" and ")}.`
            )
          })
        : "";
    const tools = !writing
      ? `<div class="mls-row">${p.replaceable > 0 ? btn("Regenerate", "open-regen", { variant: "secondary", sm: true, disabled: s.busy }) : ""}${
          hasDaysToCome
            ? btn("Re-plan the rest of the week", "open-replan", {
                variant: "secondary",
                sm: true,
                disabled: s.busy
              })
            : ""
        }${btn("New plan", "new-plan", { variant: "quiet", sm: true })}${btn("Delete plan", "delete-plan", { variant: "quiet", sm: true, disabled: s.busy })}</div>`
      : "";
    const progress = writing
      ? `<div class="mls-progress"><span class="jds-caption" role="status">${current ? `Writing day ${p.days.indexOf(current) + 1}, ` : ""}${done} of ${total} days done</span><div class="jds-progress" role="progressbar" aria-valuemin="0" aria-valuemax="${total}" aria-valuenow="${done}" aria-label="Days written"><div class="jds-progress__fill" style="width:${Math.round((done / Math.max(total, 1)) * 100)}%"></div></div>${btn("Stop", "stop", { variant: "quiet", sm: true, disabled: s.busy })}</div>`
      : "";
    const stopped =
      p.state !== "active" && p.days.some((d) => d.status === "pending")
        ? recovery(
            p.state === "stopped" ? "Writing stopped" : "Writing paused",
            esc(
              p.state === "paused" && p.pausedReason !== null
                ? PAUSE_TEXT[p.pausedReason]
                : `${done} of ${total} days are written.`
            ),
            btn("Resume", "resume", { variant: "secondary", sm: true, disabled: s.busy }),
            "status"
          )
        : "";
    return `<div class="mls-stack">${lead}<div class="mls-planbar"><div class="mls-row"><strong class="mls-num">${esc(range)}</strong>${badge(esc(PANTRY_LABEL[p.pantryMode]), { outline: true })}</div>${tools}${progress}</div>${stopped}${
      s.failed ? caption(esc(s.failed), ' role="alert"') : ""
    }<div class="mls-week">${p.days
      .map((day, index) =>
        daySection({
          day,
          index,
          today,
          planActive: p.state === "active",
          showSharing: people.size > 1,
          writes: true,
          busy: s.busy,
          ui: s.ui
        })
      )
      .join("")}</div>${dialogs(p, lockedText)}</div>`;
  }

  function dialogs(p, lockedText) {
    const cancel = btn("Cancel", "dialog-close", { variant: "secondary" });
    if (s.dialog === "regen") {
      return dialog({
        id: "mls-regen",
        title: "Regenerate the plan",
        body: `<p>${plural(p.replaceable, "meal")} will be replaced.${esc(lockedText)}</p>`,
        footer: `${cancel}${btn("Regenerate", "confirm-regen", { disabled: s.busy })}`
      });
    }
    if (s.dialog === "delete") {
      return dialog({
        id: "mls-delete",
        title: "Delete the plan",
        body: "<p>The plan and its meals are removed. This cannot be undone here.</p>",
        footer: `${cancel}${btn("Delete plan", "confirm-delete", { variant: "danger", disabled: s.busy })}`
      });
    }
    if (s.dialog === "replan") {
      return dialog({
        id: "mls-replan",
        title: "Re-plan the rest of the week",
        body: `<p>Moss writes the days still to come again, using what is in the Pantry now. Days already written stay.${esc(lockedText)}</p>`,
        footer: `${cancel}${btn("Re-plan", "confirm-replan", { disabled: s.busy })}`
      });
    }
    if (s.dialog === "quick") {
      return dialog({
        id: "mls-quick",
        title: "Quick swap",
        body: `${field("quick-minutes", "Ready in at most, minutes", input("quick-minutes", s.quickMinutes, { type: "number", extra: 'min="5" max="240"' }))}<p>Moss prefers what is on hand. The new recipe shows what is still to buy.</p>`,
        footer: `${cancel}${btn("Swap it", "confirm-quick", { disabled: s.busy })}`
      });
    }
    return "";
  }

  acts["retry-load"] = () => {
    s.kind = "loading";
    ctx.draw();
    void load();
  };

  return {
    start: () => {
      s.notice = null;
      void load();
    },
    stop: () => clearTimeout(timer),
    render,
    acts,
    input: input_,
    setNotice: (text) => {
      s.notice = text;
      ctx.draw();
    }
  };
}
