// Recipe: scaled amounts beside the original wording, servings, steps, Mark cooked and Rating.
/* global window */

(function () {
  const A = window.MEALS_APP;
  const { S, h, icon, btn, iconBtn, badge, eyebrow, caption, sectionHead, segmented } = A;
  const { empty, loading, recovery, check, toggle, chip, dialog, stepper } = A;

  S.leftovers = S.leftovers || {};
  S.logPortion = S.logPortion === undefined ? true : S.logPortion;
  S.rateDraft = {};
  S.subbed = {};
  S.asWritten = false;

  const aiOff = () => A.reviewState() === "ai-off";
  const self = () => S.data.members.find((m) => m.isSelf);

  // ---------- Amounts and units ----------

  const FRACTIONS = [
    [0.25, "¼"],
    [1 / 3, "⅓"],
    [0.5, "½"],
    [2 / 3, "⅔"],
    [0.75, "¾"]
  ];
  const PLURAL = ["cup", "can", "head", "clove", "bag", "slice", "portion", "pack", "bunch", "fillet", "tortilla"];
  const TO_METRIC = { oz: [28.35, "g"], lb: [453.6, "g"], cup: [240, "ml"], tbsp: [15, "ml"], tsp: [5, "ml"], gal: [3785, "ml"] };

  const usNum = (n) => {
    let whole = Math.floor(n);
    let rest = n - whole;
    if (rest > 0.88) {
      whole += 1;
      rest = 0;
    }
    const frac = rest < 0.12 ? "" : FRACTIONS.reduce((best, f) => (Math.abs(f[0] - rest) < Math.abs(best[0] - rest) ? f : best))[1];
    return whole ? `${whole}${frac}` : frac || "0";
  };

  const metric = (value, unit) => {
    if (value >= 1000) return `${(value / 1000).toFixed(1).replace(/\.0$/, "")} ${unit === "g" ? "kg" : "l"}`;
    const step = value < 20 ? 1 : value < 100 ? 5 : 10;
    return `${Math.round(value / step) * step} ${unit}`;
  };

  const amount = (ing, factor) => {
    if (ing.qty == null) return "To taste";
    const q = ing.qty * factor;
    if (S.units === "metric" && TO_METRIC[ing.unit]) {
      const [k, u] = TO_METRIC[ing.unit];
      return metric(q * k, u);
    }
    const unit = ing.unit && q > 1 && PLURAL.includes(ing.unit) ? `${ing.unit}s` : ing.unit;
    return `${usNum(q)}${unit ? ` ${unit}` : ""}`;
  };

  const sentence = (s) => s.charAt(0).toUpperCase() + s.slice(1);

  // Servings start from what each eater's portion adds up to, in half servings.
  const startServings = (meal) => {
    const r = A.recipe(meal.recipeId);
    const total = meal.fit.reduce((sum, f) => sum + f.kcal, 0) || r.kcal * r.baseServings;
    return Math.max(1, Math.round((total / r.kcal) * 2) / 2);
  };
  const servingsFor = (meal) => S.servings[meal.id] ?? startServings(meal);
  const servingsText = (n) => `${String(n).replace(".5", "½")} ${n > 1 ? "servings" : "serving"}`;

  // Phase 3: substitutes for ingredients the Pantry lacks.
  const SUBS = {
    "bok choy": "baby spinach",
    "white miso": "tahini and soy sauce",
    "sour cream": "Greek yoghurt",
    halloumi: "feta",
    "fresh mozzarella": "burrata",
    "coconut milk": "Greek yoghurt",
    "cremini mushrooms": "button mushrooms"
  };

  // Phase 4: USDA cross-check, flagged and never applied.
  const USDA = { "r-salmon": 720, "r-stroganoff": 540, "r-curry": 640 };

  // ---------- Pantry subtraction preview ----------

  const MASS = { oz: 1, lb: 16 };
  const VOLUME = { tsp: 1, tbsp: 3, cup: 48, gal: 768 };
  const CUP_OZ = { rice: 7, "rolled oats": 3, farro: 7, "greek yoghurt": 8.5, "sour cream": 8.5, milk: 8 };

  const convert = (qty, from, to, name) => {
    if (from === to) return qty;
    if (MASS[from] && MASS[to]) return (qty * MASS[from]) / MASS[to];
    if (VOLUME[from] && VOLUME[to]) return (qty * VOLUME[from]) / VOLUME[to];
    const density = CUP_OZ[name.toLowerCase()];
    if (density && VOLUME[from] && MASS[to]) return (((qty * VOLUME[from]) / VOLUME.cup) * density) / MASS[to];
    return null;
  };

  const pantryPreview = (meal) => {
    const r = A.recipe(meal.recipeId);
    const factor = servingsFor(meal) / r.baseServings;
    return r.ingredients
      .map((ing) => {
        const item = A.onHand(ing.name);
        if (!item) return null;
        if (item.qty == null || ing.qty == null) return { item, ing, after: null, note: "Amount not tracked" };
        const used = convert(ing.qty * factor, ing.unit, item.unit, item.name);
        if (used == null) return { item, ing, after: null, note: "Different unit, left as is" };
        return { item, ing, after: Math.max(0, item.qty - used) };
      })
      .filter(Boolean);
  };

  const qtyText = (qty, unit) => {
    if (qty === 0) return "None left";
    const plural = unit && qty > 1 && PLURAL.includes(unit) ? `${unit}s` : unit;
    return `${usNum(qty)}${plural ? ` ${plural}` : ""}`;
  };

  // ---------- Recipe page ----------

  const ingredientRow = (ing, meal, factor) => {
    const item = A.onHand(ing.name);
    const sub = A.phase() >= 3 && !item && SUBS[ing.name];
    const using = S.subbed[`${meal.id}:${ing.name}`];
    return h`
      <li class="mls-ing">
        <span class="mls-ing__amount">${S.asWritten ? "" : amount(ing, factor)}</span>
        <span class="mls-ing__body">
          ${S.asWritten ? h`<span>${ing.text}</span>` : h`<span>${using ? h`<s>${sentence(ing.name)}</s> ${sentence(using)}` : sentence(ing.name)}</span>`}
          ${
            item || ing.checkLabel || sub
              ? h`<span class="mls-row">
                  ${item ? badge("In the Pantry", "forest", { icon: "check" }) : ""}
                  ${ing.checkLabel ? h`<span title="Moss suggested a brand. Check its label against everyone's restrictions.">${badge("Check the label", "outline", { icon: "info" })}</span>` : ""}
                  ${
                    sub && !using
                      ? btn(`Use ${sub} instead`, { variant: "link", size: "sm", action: "rc-sub", data: { meal: meal.id, name: ing.name, sub } })
                      : ""
                  }
                </span>`
              : ""
          }
        </span>
      </li>`;
  };

  // One line per eater: their Never-serve rules, and any label they must read.
  const safetyView = (meal) => {
    const rows = A.planSafety.safetyOf(meal).filter((s) => s.never.length);
    if (!rows.length) return "";
    const swap = !meal.cooked && rows.some((s) => s.labels.length) && A.planSafety.safeSwapFor(meal);
    return h`
      <section class="mls-safety-list" aria-label="Safety">
        ${rows.map(
          (s) => h`
            <span class="mls-safety__why jds-caption${s.labels.length ? "" : " mls-safety__why--ok"}">
              ${icon(s.labels.length ? "shield-alert" : "shield-check", 14)}
              <span><strong>${s.member.name}:</strong> ${s.labels.length ? `check the ${s.labels.join(" and ")} label for ${s.never.join(", ").toLowerCase()}` : `no ${s.never.join(", ").toLowerCase()}`}</span>
            </span>`
        )}
        ${swap ? btn("Safe swap", { variant: "link", size: "sm", action: "plan-safe-swap", data: { meal: meal.id }, disabled: aiOff() }) : ""}
      </section>`;
  };

  const portionsLine = (meal) => {
    const r = A.recipe(meal.recipeId);
    return meal.fit
      .map((f) => `${A.member(f.memberId).name} ${(f.kcal / r.kcal).toFixed(1).replace(".0", "")}`)
      .join(", ");
  };

  const renderRecipe = ({ mealId }) => {
    const state = A.reviewState();
    const back = btn("The week", { variant: "link", icon: "chevron-left", href: A.hrefFor("plan") });
    const wrap = (body) => A.page("plan", h`<div class="mls-back">${back}</div>${body}`);
    if (state === "loading") return wrap(loading("Loading the recipe"));
    if (state === "error")
      return wrap(
        recovery({
          title: "Couldn't load this recipe",
          msg: "Check the connection, then try again.",
          actions: btn("Try again", { size: "sm", icon: "refresh-cw", href: A.hrefFor(`recipe/${mealId}`, { state: "ready" }) })
        })
      );
    const found = A.findMeal(mealId);
    if (!found || found.meal.kind !== "recipe" || state === "empty") {
      const meal = found && found.meal;
      return wrap(
        empty({
          icon: "chef-hat",
          title: meal && meal.kind === "text" ? meal.text : "No recipe here",
          sub: meal ? `${A.fmtDay(found.day.date)}, ${meal.slot.toLowerCase()}` : "",
          action: meal ? btn("Plan a meal here", { variant: "primary", icon: "plus", href: A.hrefFor(`plan/text/${meal.id}`) }) : ""
        })
      );
    }

    const { meal, day } = found;
    const r = A.recipe(meal.recipeId);
    const servings = servingsFor(meal);
    const factor = servings / r.baseServings;
    const isTonight = day.date === A.F.TODAY && meal.slot === "Dinner";
    const rated = S.rated[meal.id];
    const usda = A.phase() >= 4 && USDA[meal.recipeId];
    const overridden = S.servings[meal.id] !== undefined && S.servings[meal.id] !== startServings(meal);

    const actions = meal.cooked
      ? h`${badge("Cooked", "forest", { icon: "check" })}${rated ? "" : btn("Rate", { icon: "star", href: A.hrefFor(`recipe/${meal.id}/rate`) })}`
      : h`
          ${btn("Mark cooked", { variant: "primary", icon: "check", href: A.hrefFor(`recipe/${meal.id}/cooked`) })}
          ${btn("Swap", { icon: "shuffle", href: A.hrefFor(`plan/swap/${meal.id}`), disabled: aiOff() })}
          ${btn(meal.locked ? "Locked" : "Lock", { icon: meal.locked ? "lock" : "lock-open", action: "plan-lock", data: { meal: meal.id }, pressed: meal.locked })}`;

    return wrap(h`
      <div class="mls-recipe__head">
        ${A.masthead({
          tone: "default",
          compact: true,
          eyebrow: isTonight ? `Tonight · ${meal.slot}` : `${A.fmtDay(day.date)} · ${meal.slot}`,
          title: r.title,
          lede: `${r.minutes} min · For ${A.names(meal.eaters)} · ${A.kcal(r.kcal)} a serving`,
          aside: h`<div class="mls-hero__actions">${actions}</div>`
        })}
        <div class="mls-row">
          ${S.data.members
            .filter((m) => meal.eaters.includes(m.id))
            .map((m) => chip(h`${icon("heart", 14)}${m.name}'s favourite`, meal.favouriteOf === m.id, { action: "plan-favourite-toggle", data: { meal: meal.id, member: m.id } }))}
          ${usda ? h`<span title="USDA data differs by more than 15%. Moss keeps its own estimate.">${badge(`USDA says ${A.kcal(usda)}`, "amber", { icon: "triangle-alert" })}</span>` : ""}
          ${rated ? caption(`Rated ${Object.entries(rated).map(([id, n]) => `${A.member(id).name} ${n} of 5`).join(", ")}`) : ""}
        </div>
      </div>

      ${safetyView(meal)}

      <div class="mls-recipe">
        <section class="mls-stack" aria-labelledby="rc-ing">
          ${sectionHead({ number: "01", title: "Ingredients", meta: caption(`Portions: ${portionsLine(meal)}`), rule: true })}
          <div class="mls-row mls-row--between">
            <span class="mls-row">
              ${stepper(String(servings).replace(".5", "½"), { label: "Servings", unit: "servings", action: "rc-servings", data: { meal: meal.id }, min: 1 })}
              <span class="jds-caption">${servings > 1 ? "servings" : "serving"}</span>
              ${overridden ? btn(`Reset to ${String(startServings(meal)).replace(".5", "½")}`, { variant: "link", size: "sm", action: "rc-servings-reset", data: { meal: meal.id } }) : ""}
            </span>
            <span class="mls-row">
              ${segmented(
                [
                  { value: "scaled", label: "Scaled" },
                  { value: "written", label: "As written" }
                ],
                S.asWritten ? "written" : "scaled",
                { label: "Ingredient text", action: "rc-written" }
              )}
              ${
                S.asWritten
                  ? ""
                  : segmented(
                      [
                        { value: "us", label: "US" },
                        { value: "metric", label: "Metric" }
                      ],
                      S.units,
                      { label: "Units", action: "rc-units" }
                    )
              }
            </span>
          </div>
          <ul class="mls-section mls-list" role="list">${r.ingredients.map((ing) => ingredientRow(ing, meal, factor))}</ul>
        </section>

        <section class="mls-stack">
          ${sectionHead({ number: "02", title: "Method", meta: caption(`${r.steps.length} steps`), rule: true })}
          <ol class="mls-steps">${r.steps.map((step) => h`<li><span>${step}</span></li>`)}</ol>
        </section>
      </div>`);
  };

  // ---------- Mark cooked ----------

  const cookedDialog = ({ mealId }) => {
    const found = A.findMeal(mealId);
    if (!found || found.meal.kind !== "recipe") return "";
    const { meal } = found;
    const r = A.recipe(meal.recipeId);
    const rows = pantryPreview(meal);
    const me = self();
    const myFit = meal.fit.find((f) => f.memberId === me.id);
    const left = S.leftovers[meal.id];
    return dialog({
      title: "Mark cooked",
      desc: `${r.title}, ${servingsText(servingsFor(meal))}`,
      body: h`
        <div class="mls-stack">
          <div class="mls-stack mls-stack--tight">
            ${eyebrow("Out of the Pantry")}
            ${
              rows.length
                ? h`<ul class="mls-section mls-list" role="list">
                    ${rows.map(
                      (row) => h`
                        <li class="mls-line">
                          <span>${icon("package", 16)}</span>
                          <span class="mls-line__body"><span class="mls-line__name">${row.item.name}</span></span>
                          <span class="mls-line__amount">
                            ${
                              row.after == null
                                ? caption(row.note)
                                : h`<span class="mls-num">${qtyText(row.item.qty, row.item.unit)} ${icon("chevron-right", 12)} ${qtyText(row.after, row.item.unit)}</span>`
                            }
                          </span>
                          <span></span>
                        </li>`
                    )}
                  </ul>`
                : caption("Nothing in this recipe is in the Pantry.")
            }
          </div>
          ${
            A.phase() >= 3
              ? h`<div class="mls-stack mls-stack--tight">
                  ${toggle("Save leftovers to the Pantry", Boolean(left), { action: "rc-leftovers" })}
                  ${left ? h`<span class="mls-row">${stepper(left, { label: "Leftover portions", unit: "portions", action: "rc-leftovers-step", data: { meal: meal.id }, min: 1 })}${caption(left > 1 ? "portions" : "portion")}</span>` : ""}
                </div>`
              : ""
          }
          ${
            myFit
              ? check(`Log my portion, ${A.kcal(myFit.kcal)}`, S.logPortion, { action: "rc-log" })
              : ""
          }
        </div>`,
      foot: h`${btn("Cancel", { action: "close-dialog" })}${btn("Mark cooked", { variant: "primary", icon: "check", action: "rc-cooked", data: { meal: meal.id } })}`
    });
  };

  // ---------- Rating ----------

  const rateDialog = ({ mealId }) => {
    const found = A.findMeal(mealId);
    if (!found || found.meal.kind !== "recipe") return "";
    const { meal } = found;
    const draft = S.rateDraft[meal.id] || {};
    const any = Object.keys(draft).length > 0;
    return dialog({
      title: `How was ${A.recipe(meal.recipeId).title}?`,
      body: h`
        <div class="mls-section">
          ${meal.eaters.map((id) => {
            const n = draft[id] || 0;
            const m = A.member(id);
            return h`
              <div class="mls-rate-row">
                <span class="mls-line__name">${m.name}</span>
                <span class="mls-stars" role="radiogroup" aria-label="${m.name}'s rating">
                  ${[1, 2, 3, 4, 5].map((k) =>
                    iconBtn("star", `${k} of 5`, { action: "rc-rate", data: { meal: meal.id, member: id, stars: k }, active: k <= n, pressed: k === n, size: "md" })
                  )}
                </span>
                ${n && n <= 2 ? h`<span class="jds-hint">Moss will almost never plan this again.</span>` : ""}
              </div>`;
          })}
        </div>`,
      foot: h`${btn("Skip", { variant: "quiet", action: "rc-rate-skip", data: { meal: meal.id } })}${btn("Save", { variant: "primary", action: "rc-rate-save", data: { meal: meal.id }, disabled: !any })}`
    });
  };

  // ---------- Routes ----------

  const recipePage = ({ mealId }) => `recipe/${mealId}`;

  A.route("recipe/:mealId", { render: renderRecipe, sample: "recipe/p14", label: "Recipe: tonight's dinner" });
  A.route("recipe/:mealId/cooked", { page: recipePage, dialog: cookedDialog, sample: "recipe/p14/cooked", label: "Recipe: mark cooked" });
  A.route("recipe/:mealId/rate", {
    page: recipePage,
    dialog: rateDialog,
    sample: "recipe/p14/rate",
    label: "Recipe: rate per eater",
    enter: ({ mealId }) => {
      const found = A.findMeal(mealId);
      if (found) found.meal.cooked = true;
    }
  });

  // ---------- Actions ----------

  const mealOf = (el) => A.findMeal(el.dataset.meal).meal;

  Object.assign(A.actions, {
    "rc-servings": (el) => {
      const meal = mealOf(el);
      S.servings[meal.id] = Math.max(1, servingsFor(meal) + Number(el.dataset.step) * 0.5);
      A.render();
    },
    "rc-servings-reset": (el) => {
      delete S.servings[el.dataset.meal];
      A.render();
    },
    "rc-units": (el) => {
      S.units = el.dataset.value;
      A.render();
    },
    "rc-sub": (el) => {
      S.subbed[`${el.dataset.meal}:${el.dataset.name}`] = el.dataset.sub;
      A.render();
    },
    "rc-leftovers": (el) => {
      const meal = A.findMeal(A.current().path.split("/")[1]).meal;
      S.leftovers[meal.id] = el.checked ? 1 : 0;
      A.render();
    },
    "rc-leftovers-step": (el) => {
      const id = el.dataset.meal;
      S.leftovers[id] = Math.max(1, (S.leftovers[id] || 1) + Number(el.dataset.step));
      A.render();
    },
    "rc-log": (el) => {
      S.logPortion = el.checked;
    },
    "rc-written": (el) => {
      S.asWritten = el.dataset.value === "written";
      A.render();
    },
    "rc-cooked-undo": () => {
      const u = S.cookedUndo;
      if (!u) return;
      S.data.pantry = u.pantry;
      S.data.log.entries = u.entries;
      A.findMeal(u.mealId).meal.cooked = false;
      S.cookedUndo = null;
      A.toast("Not cooked. Pantry put back.", { icon: "undo-2", tone: "drift" });
      A.go(`recipe/${u.mealId}`);
    },
    "rc-cooked": (el) => {
      const meal = mealOf(el);
      const r = A.recipe(meal.recipeId);
      S.cookedUndo = { mealId: meal.id, pantry: structuredClone(S.data.pantry), entries: structuredClone(S.data.log.entries) };
      pantryPreview(meal).forEach((row) => {
        if (row.after != null) row.item.qty = Math.round(row.after * 100) / 100;
        row.item.updated = "just now";
      });
      const left = A.phase() >= 3 ? S.leftovers[meal.id] : 0;
      if (left)
        S.data.pantry.push({ id: `pi-left-${meal.id}`, name: r.title, qty: left, unit: left > 1 ? "portions" : "portion", section: "Leftovers", source: "leftover", updated: "just now" });
      meal.cooked = true;
      const myFit = meal.fit.find((f) => f.memberId === self().id);
      if (S.logPortion && myFit) {
        const entry = { id: `e-${meal.id}`, time: "7:15 PM", text: `${r.title}, my portion`, kcal: null, protein: null, carbs: null, fat: null, status: "estimating" };
        S.data.log.entries.push(entry);
        setTimeout(() => {
          Object.assign(entry, { kcal: myFit.kcal, protein: 52, carbs: 64, fat: 31, status: "estimated" });
          A.render();
        }, 1600);
      }
      A.toast(left ? `Pantry updated. ${left} leftover ${left > 1 ? "portions" : "portion"} saved.` : "Pantry updated.", { title: "Cooked", icon: "check", tone: "ready", undo: "rc-cooked-undo", ms: 7000 });
      A.go(`recipe/${meal.id}/rate`);
    },
    "rc-rate": (el) => {
      const draft = (S.rateDraft[el.dataset.meal] = S.rateDraft[el.dataset.meal] || {});
      draft[el.dataset.member] = Number(el.dataset.stars);
      A.render();
    },
    "rc-rate-skip": (el) => {
      delete S.rateDraft[el.dataset.meal];
      A.go(`recipe/${el.dataset.meal}`);
    },
    "rc-rate-save": (el) => {
      S.rated[el.dataset.meal] = { ...S.rateDraft[el.dataset.meal] };
      delete S.rateDraft[el.dataset.meal];
      A.toast("Ratings saved.", { icon: "star", tone: "ready" });
      A.go(`recipe/${el.dataset.meal}`);
    }
  });

  A.recipeTools = { amount, servingsFor, startServings };
})();
