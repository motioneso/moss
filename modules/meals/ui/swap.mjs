/* global document */
import { noticeFor } from "./api.mjs";
import { esc } from "./format.mjs";
import { backLink, btn, caption, empty, indicator, sectionHead } from "./kit.mjs";

const POLL_MS = 3000;
const waiting = (choice) => choice.status === "pending" || choice.status === "writing";

/** Three replacement recipes for one meal. A choice shows once it is written and checked for everyone who eats it. */
export function swapScreen(ctx) {
  const s = { kind: "loading", id: null, recipe: null, busy: false, failed: null };
  let timer = null;
  let gen = 0;

  async function load() {
    const mine = gen;
    let recipe = null;
    try {
      recipe = await ctx.api.read("meals.meal.get", { mealId: s.id });
    } catch {
      // Keep what is on screen unless nothing has loaded yet.
    }
    if (mine !== gen) return;
    if (recipe) {
      s.recipe = recipe;
      s.kind = "ready";
    } else if (s.kind !== "ready") s.kind = "error";
    ctx.draw();
    schedule();
  }

  function schedule() {
    clearTimeout(timer);
    if (s.kind === "ready" && s.recipe.swapChoices.some(waiting)) {
      timer = setTimeout(() => {
        if (document.visibilityState === "visible" && ctx.current() === "swap") void load();
        else schedule();
      }, POLL_MS);
    }
  }

  async function run(input) {
    if (s.busy) return false;
    s.busy = true;
    s.failed = null;
    ctx.draw();
    const outcome = await ctx.api.write("meals.meal.swap", { mealId: s.id, ...input });
    s.busy = false;
    if (outcome.kind !== "succeeded") s.failed = noticeFor(outcome);
    await load();
    return outcome.kind === "succeeded";
  }

  const acts = {
    back: () => ctx.go({ view: "plan" }),
    "retry-load": () => {
      s.kind = "loading";
      ctx.draw();
      void load();
    },
    find: () => run({ action: "request_choices" }),
    choose: async (el) => {
      if (await run({ action: "choose", choiceId: el.dataset.choice })) ctx.go({ view: "plan" });
    }
  };

  function choice(c) {
    if (waiting(c)) {
      return `<li class="mls-choice" role="status">${indicator(c.status === "writing" ? "ready" : "idle", "Writing", true)}</li>`;
    }
    if (c.status === "failed") {
      return `<li class="mls-choice">${caption("Moss could not write this one.")}</li>`;
    }
    return `<li class="mls-choice"><strong class="mls-meal__title">${esc(c.title)}</strong><p class="mls-meal__meta jds-caption"><span>${esc(
      c.eaters.map((e) => e.name).join(", ")
    )}</span>${c.cookMinutes !== null ? `<span>${c.cookMinutes}&nbsp;min</span>` : ""}</p>${
      c.status === "ready"
        ? btn("Choose", "choose", {
            sm: true,
            disabled: s.busy,
            data: `data-choice="${esc(c.choiceId)}"`
          })
        : ""
    }</li>`;
  }

  function render() {
    if (s.kind === "loading") {
      return `<div class="mls-stack">${backLink}${caption("Loading the options", ' role="status"')}</div>`;
    }
    if (s.kind === "error") {
      return `<div class="mls-stack">${backLink}${empty("Couldn't load this meal", "", btn("Try again", "retry-load", { variant: "secondary" }))}</div>`;
    }
    const { recipe } = s;
    const choices = recipe.swapChoices;
    return `<div class="mls-stack">${backLink}${sectionHead(
      `Swap ${esc(recipe.meal.title ?? "this meal")}`,
      {
        meta: esc(recipe.meal.slotName),
        rule: true
      }
    )}${
      choices.length > 0
        ? `<ul class="mls-choices" aria-label="Replacement options">${choices.map(choice).join("")}</ul>`
        : ""
    }${s.failed ? caption(esc(s.failed), ' role="alert"') : ""}${
      !choices.some(waiting)
        ? `<div class="mls-row">${btn(
            choices.length > 0 ? "Find different options" : "Find options",
            "find",
            {
              variant: "secondary",
              sm: true,
              disabled: s.busy
            }
          )}</div>`
        : ""
    }</div>`;
  }

  return {
    start: (id) => {
      gen += 1;
      clearTimeout(timer);
      s.id = id;
      s.kind = "loading";
      s.failed = null;
      void load();
    },
    stop: () => {
      gen += 1;
      clearTimeout(timer);
    },
    render,
    acts,
    input: () => {}
  };
}
