import { noticeFor } from "./api.mjs";
import { esc, failureText } from "./format.mjs";
import { btn, caption, empty, masthead, sectionHead } from "./kit.mjs";

const back = '<a class="mls-back" href="#" data-act="back">Back to the plan</a>';
const num = (value) => (Number.isInteger(value) ? String(value) : value.toFixed(1));
const quantity = (value) => (value === null ? "none" : num(value));

/** One planned meal as a recipe, with the cooking controls under it. */
export function recipeScreen(ctx) {
  const s = { kind: "loading", recipe: null, id: null, busy: false, failed: null, toast: null };
  let toastTimer = null;

  async function load(quiet = false) {
    if (!quiet) {
      s.kind = "loading";
      ctx.draw();
    }
    try {
      s.recipe = await ctx.api.read("meals.meal.get", { mealId: s.id });
      s.kind = "ready";
    } catch {
      s.kind = "error";
    }
    ctx.draw();
  }

  async function run(tool, params) {
    s.busy = true;
    s.failed = null;
    ctx.draw();
    const outcome = await ctx.api.write(tool, params);
    s.busy = false;
    if (outcome.kind === "succeeded") return outcome.result;
    s.failed = noticeFor(outcome);
    ctx.draw();
    return null;
  }

  const showToast = (toast) => {
    s.toast = toast;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      s.toast = null;
      ctx.draw();
    }, 12000);
  };

  async function setServings(servings) {
    const result = await run("meals.meal.servings", { mealId: s.id, servings });
    if (result !== null) {
      s.recipe = result;
      ctx.draw();
    }
  }

  const acts = {
    back: () => ctx.go({ view: "plan" }),
    "retry-load": () => load(),
    "servings-down": () => setServings(s.recipe.meal.servings - 0.5),
    "servings-up": () => setServings(s.recipe.meal.servings + 0.5),
    "servings-reset": () => setServings(null),
    rate: async (el) => {
      const current = el.dataset.current === "" ? null : Number(el.dataset.current);
      const stars = Number(el.dataset.stars);
      const result = await run("meals.meal.rate", {
        mealId: s.id,
        ratings: [{ memberId: el.dataset.member, stars: current === stars ? null : stars }]
      });
      if (result !== null) {
        s.recipe = result;
        ctx.draw();
      }
    },
    favourite: async (el) => {
      if (s.recipe.recipeId === null) return;
      const result = await run("meals.favourites.edit", {
        action: el.dataset.on === "true" ? "remove" : "add",
        memberId: el.dataset.member,
        recipeId: s.recipe.recipeId
      });
      if (result !== null) await load(true);
    },
    cooked: async () => {
      const result = await run("meals.meal.cooked", { mealId: s.id });
      if (result === null) return;
      const changes = result.pantryChanges ?? [];
      showToast({
        text:
          changes.length === 0
            ? "Marked cooked. Nothing came out of the Pantry."
            : `Marked cooked. Took ${changes
                .map(
                  (c) =>
                    `${c.name} ${quantity(c.before)} to ${quantity(c.after)}${c.unit ? ` ${c.unit}` : ""}`
                )
                .join(", ")}.`,
        undo: result.undo,
        logOffer: result.logOffer
      });
      await load(true);
    },
    undo: async () => {
      const token = s.toast?.undo;
      s.toast = null;
      if (!token) return;
      const result = await run("meals.undo", { actionId: token.actionId });
      if (result !== null) await load(true);
    },
    "log-portion": async () => {
      const offer = s.toast?.logOffer;
      s.toast = null;
      if (!offer) return;
      await run("meals.log.add", {
        description: offer.description,
        servingNote: offer.servingNote,
        consumedAt: new Date().toISOString(),
        captureKind: "text",
        idempotencyKey: crypto.randomUUID()
      });
      ctx.draw();
    }
  };

  function cooking(recipe) {
    const meal = recipe.meal;
    const cooked = meal.cookedAt !== null;
    const base = recipe.baseServings ?? meal.servings;
    const shown = meal.servings;
    const busy = s.busy;
    return `<section class="mls-cook">${sectionHead("Cooking", { number: "03", rule: true })}<div class="mls-cook__row"><span class="mls-cook__who">Servings</span>${btn(
      "-",
      "servings-down",
      {
        variant: "secondary",
        sm: true,
        disabled: busy || cooked || shown <= 0.5,
        data: 'aria-label="Fewer servings"'
      }
    )}<span class="mls-num" role="status">${num(shown)}</span>${btn("+", "servings-up", {
      variant: "secondary",
      sm: true,
      disabled: busy || cooked || shown >= 24,
      data: 'aria-label="More servings"'
    })}${
      recipe.servingsOverride !== null
        ? btn(`Reset to ${num(base)}`, "servings-reset", {
            variant: "quiet",
            sm: true,
            disabled: busy || cooked
          })
        : ""
    }</div><div class="mls-cook__row">${
      cooked
        ? '<span class="jds-caption" role="status">Cooked</span>'
        : btn("Mark cooked", "cooked", { disabled: busy })
    }</div>${meal.eaters
      .map(
        (eater) =>
          `<div class="mls-cook__row"><span class="mls-cook__who">${esc(eater.name)}</span><div class="mls-stars" role="group" aria-label="${esc(`Rating for ${eater.name}`)}">${[
            1, 2, 3, 4, 5
          ]
            .map((stars) =>
              btn(String(stars), "rate", {
                variant: eater.rating === stars ? "primary" : "secondary",
                sm: true,
                disabled: busy,
                data: `aria-pressed="${eater.rating === stars}" aria-label="${stars} ${stars === 1 ? "star" : "stars"} for ${esc(eater.name)}" data-member="${esc(eater.memberId)}" data-current="${eater.rating ?? ""}" data-stars="${stars}"`
              })
            )
            .join("")}</div>${btn(eater.favourite ? "Favourite" : "Make favourite", "favourite", {
            variant: eater.favourite ? "primary" : "secondary",
            sm: true,
            disabled: busy || recipe.recipeId === null,
            data: `aria-pressed="${eater.favourite}" data-member="${esc(eater.memberId)}" data-on="${eater.favourite}"`
          })}</div>`
      )
      .join("")}${s.failed ? caption(esc(s.failed), ' role="alert"') : ""}${
      s.toast
        ? `<div class="jds-toast mls-toast" role="status"><div class="jds-toast__body"><div class="jds-toast__title">${esc(s.toast.text)}</div></div>${
            s.toast.logOffer
              ? btn("Log my portion", "log-portion", { variant: "quiet", sm: true })
              : ""
          }${s.toast.undo ? btn("Undo", "undo", { variant: "quiet", sm: true }) : ""}</div><div class="mls-toast-room"></div>`
        : ""
    }</section>`;
  }

  function render() {
    if (s.kind === "loading")
      return `<div class="mls-stack">${back}${caption("Loading the recipe", ' role="status"')}</div>`;
    if (s.kind === "error") {
      return `<div class="mls-stack">${back}${empty("Couldn't load this recipe", "", btn("Try again", "retry-load", { variant: "secondary" }))}</div>`;
    }
    const recipe = s.recipe;
    const meal = recipe.meal;
    if (meal.status !== "ready") {
      return `<div class="mls-stack">${back}${empty(
        meal.status === "failed"
          ? "This meal could not be written"
          : "Moss is still writing this meal",
        esc(failureText(meal.failureReason) ?? "")
      )}</div>`;
    }
    const eaters = meal.eaters.map((e) => e.name).join(" and ");
    const lede = [
      meal.cookMinutes !== null ? `${meal.cookMinutes} min` : null,
      `For ${eaters}`,
      `Serves ${num(meal.servings)}`
    ]
      .filter((part) => part !== null)
      .join(" · ");
    const missing = recipe.ingredients.filter((line) => line.missing);
    const note =
      missing.length > 0
        ? caption(`Still to buy: ${esc(missing.map((l) => l.name).join(", "))}`, ' role="status"')
        : meal.quickMaxMinutes !== null
          ? caption("Nothing still to buy. Everything is on hand.", ' role="status"')
          : "";
    const lines = recipe.ingredients
      .map(
        (line) =>
          `<li class="mls-ingredient"><span class="mls-num mls-ingredient__amount">${esc(line.display ?? "")}</span><span class="mls-ingredient__name">${esc(line.name)}${
            line.originalText !== line.name && line.originalText !== line.display
              ? `<span class="jds-caption mls-ingredient__original">As written: ${esc(line.originalText)}</span>`
              : ""
          }${line.checkLabel ? '<span class="jds-caption mls-ingredient__original">Check the label</span>' : ""}</span></li>`
      )
      .join("");
    const steps = recipe.steps
      .map(
        (step, index) =>
          `<li class="mls-step"><span class="mls-num jds-caption">${String(index + 1).padStart(2, "0")}</span><span>${esc(step)}</span></li>`
      )
      .join("");
    return `<div class="mls-stack">${back}${masthead({
      eyebrow: esc(meal.slotName.toUpperCase()),
      title: esc(meal.title ?? meal.plainText ?? "Meal"),
      lede: esc(lede)
    })}<div class="mls-grid"><section class="mls-stack">${sectionHead("Ingredients", { number: "01", rule: true })}${note}<ul class="mls-ingredients">${lines}</ul></section><section class="mls-stack">${sectionHead("Method", { number: "02", rule: true, meta: `${recipe.steps.length} steps` })}<ol class="mls-steps">${steps}</ol></section></div>${cooking(recipe)}</div>`;
  }

  return {
    start: (id) => {
      s.id = id;
      s.toast = null;
      s.failed = null;
      void load();
    },
    stop: () => clearTimeout(toastTimer),
    render,
    acts,
    input: () => {}
  };
}
