import { noticeFor } from "./api.mjs";
import { dayTitle, esc, titleCase, todayIso } from "./format.mjs";
import {
  backLink,
  btn,
  caption,
  checkbox,
  empty,
  field,
  input,
  sectionHead,
  select
} from "./kit.mjs";

/**
 * Shared shell for the three single-meal screens. `extra` loads what the screen also needs, and
 * `body(recipe, state)` draws the form. A successful save returns to the Plan.
 */
function mealScreen(ctx, { title, extra, body, reset }) {
  const s = {
    kind: "loading",
    id: null,
    recipe: null,
    extra: null,
    busy: false,
    failed: null,
    pick: {}
  };

  async function load() {
    try {
      s.recipe = await ctx.api.read("meals.meal.get", { mealId: s.id });
      s.kind = "ready";
    } catch {
      s.kind = "error";
    }
    ctx.draw();
    if (s.kind === "ready" && extra) {
      try {
        s.extra = await extra(ctx.api);
      } catch {
        s.kind = "error";
      }
      ctx.draw();
    }
  }

  async function save(tool, params) {
    if (s.busy) return;
    s.busy = true;
    s.failed = null;
    ctx.draw();
    const outcome = await ctx.api.write(tool, params);
    s.busy = false;
    if (outcome.kind !== "succeeded") {
      s.failed = noticeFor(outcome);
      ctx.draw();
      return;
    }
    ctx.go({ view: "plan" });
  }

  const note = () => (s.failed ? caption(esc(s.failed), ' role="alert"') : "");

  function render() {
    if (s.kind === "loading") {
      return `<div class="mls-stack">${backLink}${caption("Loading this meal", ' role="status"')}</div>`;
    }
    if (s.kind === "error") {
      return `<div class="mls-stack">${backLink}${empty("Couldn't load this meal", "", btn("Try again", "retry-load", { variant: "secondary" }))}</div>`;
    }
    return `<div class="mls-stack">${backLink}${sectionHead(title, { rule: true })}${body(s, { save, note })}</div>`;
  }

  return {
    start: (id) => {
      s.id = id;
      s.kind = "loading";
      s.extra = null;
      s.failed = null;
      s.pick = reset ? reset() : {};
      void load();
    },
    render,
    acts: {
      back: () => ctx.go({ view: "plan" }),
      "retry-load": () => {
        s.kind = "loading";
        ctx.draw();
        void load();
      },
      ...ctx.extraActs?.(s, save)
    },
    state: s,
    input: () => {}
  };
}

const dayOfMeal = (s) => s.extra?.days.find((d) => d.meals.some((m) => m.mealId === s.id));
const selected = (s) => s.pick.eaters ?? s.recipe.meal.eaters.map((e) => e.memberId);
const mealName = (recipe) => esc(recipe.meal.title ?? recipe.meal.plainText ?? "");

/** Move one meal to another day or slot. */
export function moveScreen(ctx) {
  const extra = async (api) => (await api.read("meals.plan.current", { date: todayIso() })).plan;
  const screen = mealScreen(
    {
      ...ctx,
      extraActs: (s, save) => ({
        "pick-day": (el) => {
          s.pick.day = el.dataset.day;
          ctx.draw();
        },
        move: () => {
          const { recipe } = s;
          const chosen = s.pick.day ?? dayOfMeal(s)?.dayId ?? null;
          const slot = s.pick.slot ?? recipe.meal.slotName;
          if (chosen === null) return;
          void save("meals.meal.edit", {
            mealId: s.id,
            action: "move",
            targetDayId: chosen,
            ...(slot === recipe.meal.slotName ? {} : { targetSlotName: slot })
          });
        }
      })
    },
    {
      title: "Move this meal",
      extra,
      reset: () => ({ day: null, slot: null }),
      body: (s, { note }) => {
        const { recipe, extra: plan } = s;
        const chosen = s.pick.day ?? dayOfMeal(s)?.dayId ?? null;
        const slots = [...new Set(plan?.days.flatMap((d) => d.meals.map((m) => m.slotName)) ?? [])];
        if (!slots.includes(recipe.meal.slotName)) slots.unshift(recipe.meal.slotName);
        const slot = s.pick.slot ?? recipe.meal.slotName;
        const form =
          plan === null || plan === undefined
            ? caption("Loading the days", ' role="status"')
            : `<div class="mls-form"><div class="mls-row" role="group" aria-label="Day to move to">${plan.days
                .map((d) =>
                  btn(esc(dayTitle(d.date)), "pick-day", {
                    variant: d.dayId === chosen ? "primary" : "secondary",
                    sm: true,
                    data: `data-day="${esc(d.dayId)}"`
                  })
                )
                .join("")}</div>${field(
                "m-slot",
                "Meal",
                select(
                  "m-slot",
                  slots.map((n) => [n, titleCase(n)]),
                  slot
                )
              )}</div>`;
        return `<div class="mls-stack mls-stack--tight"><p class="mls-meal__title">${mealName(recipe)}</p>${form}${note()}${
          plan
            ? `<div class="mls-row">${btn("Move meal", "move", { disabled: s.busy || chosen === null })}</div>`
            : ""
        }</div>`;
      }
    }
  );
  const base = screen.input;
  screen.input = (name, value) => {
    if (name === "m-slot") screen.state.pick.slot = value;
    else base(name, value);
  };
  return screen;
}

/** Change who eats one meal. */
export function eatersScreen(ctx) {
  return mealScreen(
    {
      ...ctx,
      extraActs: (s, save) => ({
        toggle: (el) => {
          const on = selected(s);
          const id = el.dataset.member;
          s.pick.eaters = on.includes(id) ? on.filter((x) => x !== id) : [...on, id];
          ctx.draw();
        },
        "save-eaters": () =>
          void save("meals.meal.edit", {
            mealId: s.id,
            action: "set_eaters",
            eaterIds: selected(s)
          })
      })
    },
    {
      title: "Who eats this",
      extra: (api) => api.read("meals.kitchen.get", {}),
      reset: () => ({ eaters: null }),
      body: (s, { note }) => {
        const kitchen = s.extra;
        const chosen = selected(s);
        const form =
          kitchen === null
            ? caption("Loading the household", ' role="status"')
            : `<div class="mls-form">${kitchen.members
                .map((p) =>
                  checkbox(
                    p.name,
                    chosen.includes(p.memberId),
                    "toggle",
                    `data-member="${esc(p.memberId)}"`,
                    false,
                    esc(p.name)
                  )
                )
                .join("")}</div>`;
        return `<div class="mls-stack mls-stack--tight"><p class="mls-meal__title">${mealName(s.recipe)}</p>${form}${note()}${
          kitchen
            ? `<div class="mls-row">${btn("Save eaters", "save-eaters", { disabled: s.busy || chosen.length === 0 })}</div>`
            : ""
        }</div>`;
      }
    }
  );
}

/** Set one meal slot to plain text, or clear the text. */
export function textScreen(ctx) {
  const value = (s) => s.pick.text ?? s.recipe.meal.plainText ?? "";
  const screen = mealScreen(
    {
      ...ctx,
      extraActs: (s, save) => ({
        "save-text": () =>
          void save("meals.day.edit", { mealId: s.id, action: "set_text", text: value(s).trim() }),
        "clear-text": () => void save("meals.day.edit", { mealId: s.id, action: "clear_text" })
      })
    },
    {
      title: "Text for this meal",
      reset: () => ({ text: null }),
      body: (s, { note }) =>
        `<div class="mls-stack mls-stack--tight"><div class="mls-form">${field(
          "t-text",
          "Text for this meal",
          input("t-text", value(s), {
            label: "Text for this meal",
            placeholder: "eating out",
            extra: 'maxlength="200"'
          })
        )}</div>${note()}<div class="mls-row">${btn("Save text", "save-text", {
          disabled: s.busy || value(s).trim() === ""
        })}${
          s.recipe.meal.kind === "text"
            ? btn("Clear text", "clear-text", { variant: "secondary", disabled: s.busy })
            : ""
        }</div></div>`
    }
  );
  const base = screen.input;
  screen.input = (name, v) => {
    if (name === "t-text") {
      screen.state.pick.text = v;
      ctx.draw();
    } else base(name, v);
  };
  return screen;
}
