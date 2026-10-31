// Plan: the week, writing animation, day and meal controls, and every plan dialog.
/* global window, document */

(function () {
  const A = window.MEALS_APP;
  const { F, S, h, icon, btn, iconBtn, badge, eyebrow, caption, masthead, sectionHead, segmented } = A;
  const { empty, loading, recovery, field, input, textarea, select, check, radioCards, chip, menu, dialog, stepper, typing } = A;

  const SLOT_ORDER = ["Breakfast", "Lunch", "Dinner", "Post-gym"];
  const NEXT_START = "2026-11-09";
  const PANTRY_MODES = [
    { value: "ignore", label: "Ignore the Pantry", description: "Plan freely and buy everything." },
    { value: "prefer", label: "Prefer what's on hand", description: "Use what you have first." },
    { value: "only", label: "Only what's on hand", description: "A clear-out week. Buy nothing new." }
  ];
  const modeLabel = (v) => PANTRY_MODES.find((m) => m.value === v)?.label || "";

  S.week = 0;
  S.mealWriting = {};
  S.slotWriting = {};
  S.swapOffset = 0;
  S.quickLimit = 15;
  S.newPlan = { start: NEXT_START, days: 7, mode: S.pantryModeDefault, asks: [] };

  // ---------- Plan data helpers ----------

  const weekStart = () => (S.week === 0 ? F.plan.start : NEXT_START);
  const viewedPlan = () => S.plans.find((p) => p.start === weekStart()) || null;
  const aiOff = () => A.reviewState() === "ai-off";

  const shareFor = (memberId, slot) => {
    for (const day of F.plan.days)
      for (const meal of day.meals)
        if (meal.slot === slot) {
          const f = meal.fit.find((x) => x.memberId === memberId);
          if (f) return f.share;
        }
    const m = A.member(memberId);
    return Math.round(m.target / m.pattern.length);
  };

  const fitFor = (eaters, slot, recipeId, seed = 0) => {
    const r = A.recipe(recipeId);
    const ratio = Math.min(1.08, Math.max(0.86, r.kcal / 600)) + ((seed % 3) - 1) * 0.02;
    return eaters.map((id) => {
      const share = shareFor(id, slot);
      return { memberId: id, share, kcal: Math.round((share * ratio) / 10) * 10 };
    });
  };

  const setRecipe = (meal, recipeId, seed) => {
    Object.assign(meal, {
      kind: "recipe",
      recipeId,
      text: null,
      favouriteOf: null,
      fit: fitFor(meal.eaters, meal.slot, recipeId, seed)
    });
  };

  const usedInPlan = (plan) => new Set(plan.days.flatMap((d) => d.meals.map((m) => m.recipeId)).filter(Boolean));

  const pool = (slot, exclude = []) => {
    const base = F.swapPool[slot] || F.swapPool.Dinner;
    return base.filter((id) => !exclude.includes(id));
  };

  // New plans reuse this week's shape, with fresh dinners so last week is not repeated.
  const NEXT_DINNERS = ["r-shakshuka", "r-gnocchi", "r-orzo", "r-friedrice", "r-salmon", "r-curry", "r-roast"];

  const buildPlan = (start, count, o = {}) => {
    const id = `plan-${start}`;
    const days = [];
    for (let i = 0; i < count; i += 1) {
      const date = A.addDays(start, i);
      const dow = (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7;
      const template = F.plan.days[dow];
      const meals = template.meals.map((m, j) => {
        const copy = structuredClone(m);
        Object.assign(copy, { id: `${id}-${i}-${j}`, cooked: false, locked: false });
        if (copy.slot === "Dinner" && copy.kind === "recipe") setRecipe(copy, NEXT_DINNERS[i % NEXT_DINNERS.length], i);
        return copy;
      });
      days.push({ date, cookLimit: template.cookLimit, lunchOverride: template.lunchOverride, meals });
    }
    const plan = {
      id,
      start,
      pantryMode: o.mode || S.pantryModeDefault,
      writtenBy: F.plan.writtenBy,
      request: o.request || "",
      days
    };
    S.plans = S.plans.filter((p) => p.start !== start);
    S.plans.push(plan);
    return plan;
  };

  const writeNewPlan = (start, count, o = {}) => {
    const plan = buildPlan(start, count, o);
    S.week = start === F.plan.start ? 0 : 1;
    S.planId = plan.id;
    A.startWriting(
      plan.days.map((d) => d.date),
      o
    );
    return plan;
  };

  // Rewrites unlocked, uncooked meals on the given days with fresh choices.
  const rewriteDays = (plan, dates) => {
    const used = usedInPlan(plan);
    plan.days
      .filter((d) => dates.includes(d.date))
      .forEach((day, i) => {
        day.meals.forEach((meal, j) => {
          if (meal.locked || meal.cooked || meal.kind === "text") return;
          const choices = pool(meal.slot, [meal.recipeId]).filter((id) => !used.has(id) || meal.slot !== "Dinner");
          const pick = choices[(i + j) % Math.max(choices.length, 1)];
          if (pick) setRecipe(meal, pick, i + j);
        });
      });
    A.startWriting(dates);
  };

  const futureDates = (plan) => plan.days.filter((d) => d.date >= F.TODAY).map((d) => d.date);

  const listChanged = () => A.toast("Shopping list updated.", { icon: "shopping-basket" });

  const cap = (t) => t.charAt(0).toUpperCase() + t.slice(1);

  // A swap edits the list in place. Ticks stay, and only the lines the swap touched are marked.
  const swapOnList = (fromId, toId) => {
    const from = fromId ? A.recipe(fromId) : null;
    const to = A.recipe(toId);
    const sameName = (l, name) => l.name.toLowerCase() === name.toLowerCase();
    let added = 0;
    let dropped = 0;
    if (from)
      for (const i of from.ingredients) {
        const l = S.data.list.find((x) => sameName(x, i.name) && x.sources.includes(from.title));
        if (!l) continue;
        l.sources = l.sources.filter((t) => t !== from.title);
        const still = to.ingredients.find((j) => sameName(l, j.name));
        if (still) {
          l.sources.push(to.title);
          if (still.text !== l.buy) Object.assign(l, { was: l.buy, buy: still.text, need: still.text });
        } else if (!l.sources.length && !l.manual) {
          if (l.checked) l.changed = "Not needed now";
          else {
            S.data.list = S.data.list.filter((x) => x !== l);
            dropped++;
          }
        }
      }
    for (const i of to.ingredients) {
      if (A.onHand(i.name) || S.data.list.some((x) => sameName(x, i.name))) continue;
      S.data.list.push({ id: `ls${Date.now()}${added}`, name: cap(i.name), need: i.text, buy: i.text, section: i.section, sources: [to.title], manual: false, staple: false, checked: false, checkLabel: Boolean(i.checkLabel), changed: "New" });
      added++;
    }
    return { added, dropped, kept: S.data.list.filter((l) => l.checked).length };
  };

  // Swap one meal, update the list, and offer one step back.
  const swapMeal = (meal, day, recipeId, title) => {
    S.planUndo = { mealId: meal.id, meal: structuredClone(meal), list: structuredClone(S.data.list) };
    const fromId = meal.recipeId;
    setRecipe(meal, recipeId, day.meals.indexOf(meal));
    S.newMealId = meal.id;
    const { added, dropped } = swapOnList(fromId, recipeId);
    const parts = [added && `${added} added`, dropped && `${dropped} dropped`].filter(Boolean).join(", ");
    A.go("plan");
    A.toast(`List: ${parts || "no change"}. Ticks kept.`, { title: title || `Swapped to ${A.recipe(recipeId).title}`, icon: "shuffle", undo: "plan-swap-undo", ms: 7000 });
  };

  // ---------- Meal ----------

  // One row per eater: name, a meter of this meal against their share, and the numbers.
  const fitLine = (meal) =>
    meal.fit.length
      ? h`<div class="mls-fit">${meal.fit.map((f) => {
          const name = A.member(f.memberId).name;
          const over = f.kcal - f.share > f.share * 0.05;
          return h`
            <span class="mls-fit__name jds-caption" title="${name}">${name}</span>
            <div class="jds-progress${over ? " jds-progress--amber" : ""}" role="meter" aria-valuemin="0" aria-valuemax="${f.share}" aria-valuenow="${f.kcal}" aria-label="${name}: ${f.kcal} of ${f.share} kcal">
              <div class="jds-progress__fill" style="width: ${Math.min(100, Math.round((f.kcal / f.share) * 100))}%"></div>
            </div>
            <span class="mls-num jds-caption">${f.kcal} / ${f.share}${over ? " over" : ""}</span>`;
        })}</div>`
      : "";

  // Branded ingredients whose label the eaters with a Never-serve rule must read.
  const safetyOf = (meal) => {
    const r = meal.kind === "recipe" ? A.recipe(meal.recipeId) : null;
    const labels = r ? r.ingredients.filter((i) => i.checkLabel).map((i) => i.name) : [];
    return meal.eaters.map((id) => {
      const m = A.member(id);
      return { member: m, never: m.restrictions, labels: m.restrictions.length ? labels : [] };
    });
  };

  const safetyReason = (meal) => {
    const rows = safetyOf(meal).filter((s) => s.labels.length);
    if (!rows.length) return "";
    const labels = [...new Set(rows.flatMap((s) => s.labels))];
    const why = rows.map((s) => `${s.never.join(", ").toLowerCase()} for ${s.member.name}`).join(", ");
    return `Check the ${labels.join(" and ")} label: ${why}`;
  };

  // The first swap that needs no label read. Every swap already passes the Never-serve rules.
  const safeSwapFor = (meal) => pool(meal.slot, [meal.recipeId]).find((id) => !A.recipe(id).ingredients.some((i) => i.checkLabel));

  const safetyNote = (meal) => {
    const why = safetyReason(meal);
    if (!why) return "";
    return h`
      <div class="mls-safety">
        <span class="mls-safety__why jds-caption">${icon("shield-alert", 14)}<span>${why}</span></span>
        ${meal.cooked || A.isPast(A.findMeal(meal.id).day.date) ? "" : btn("Safe swap", { variant: "link", size: "sm", action: "plan-safe-swap", data: { meal: meal.id }, disabled: aiOff() || !safeSwapFor(meal) })}
      </div>`;
  };

    const mealMenu = (meal, day) => {
    const favItems = S.data.members.map((m) => ({
      label: meal.favouriteOf === m.id ? `Not ${m.name}'s favourite` : `${m.name}'s favourite`,
      icon: "heart",
      action: "plan-favourite-toggle",
      data: { meal: meal.id, member: m.id }
    }));
    const recipeItems =
      meal.kind === "recipe"
        ? [
            { label: "Open recipe", icon: "chef-hat", action: "go", data: { to: `recipe/${meal.id}` } },
            { label: "Regenerate this meal", icon: "refresh-cw", action: "plan-regen-meal", data: { meal: meal.id }, disabled: aiOff() },
            ...favItems
          ]
        : [];
    return menu(`More for ${A.mealTitle(meal)}`, [
      ...recipeItems,
      { label: "Move", icon: "arrow-left-right", action: "go", data: { to: `plan/move/${meal.id}` } },
      { label: "Change who eats", icon: "users", action: "go", data: { to: `plan/eaters/${meal.id}` } },
      { label: meal.kind === "text" ? "Edit text" : "Use plain text", icon: "pencil", action: "go", data: { to: `plan/text/${meal.id}` } },
      { label: "Place a favourite here", icon: "star", action: "go", data: { to: `plan/favourite/${day.date}/${meal.slot}` } }
    ]);
  };

  const mealView = (meal, day) => {
    if (S.mealWriting[meal.id])
      return h`<div class="mls-meal" role="status"><span class="mls-writing">${typing()}${caption("Writing a new meal")}</span></div>`;
    if (S.slotFailed[meal.id])
      return h`<div class="mls-meal">${recovery({
        title: "No safe meal yet",
        msg: `Every option broke ${A.names(meal.eaters)}'s restrictions.`,
        actions: btn("Retry", { size: "sm", icon: "refresh-cw", action: "plan-retry-slot", data: { meal: meal.id }, disabled: aiOff() })
      })}</div>`;
    const past = A.isPast(day.date);
    const isNew = S.newMealId === meal.id;
    const fav = meal.favouriteOf ? A.member(meal.favouriteOf) : null;
    const rated = S.rated[meal.id];
    const r = meal.kind === "recipe" ? A.recipe(meal.recipeId) : null;
    const tools =
      past || meal.cooked
        ? ""
        : h`<div class="mls-meal__actions">
            ${iconBtn(meal.locked ? "lock" : "lock-open", meal.locked ? "Unlock" : "Lock", { action: "plan-lock", data: { meal: meal.id }, pressed: meal.locked, active: meal.locked })}
            ${meal.kind === "recipe" ? iconBtn("shuffle", "Swap", { href: A.hrefFor(`plan/swap/${meal.id}`), disabled: aiOff() }) : ""}
            ${mealMenu(meal, day)}
          </div>`;
    const expiring = A.phase() >= 3 && r && r.ingredients.some((i) => i.name === "baby spinach" || i.name === "sour cream");
    const serves = meal.eaters.length;
    return h`
      <article class="mls-meal${isNew ? " mls-meal--new" : ""}${meal.locked ? " mls-meal--locked" : ""}">
        ${
          r
            ? h`<a class="mls-meal__title" href="${A.hrefFor(`recipe/${meal.id}`)}">${r.title}</a>`
            : h`<p class="mls-meal__text">${meal.text}</p>`
        }
        ${fitLine(meal)}
        ${
          fav || meal.cooked || meal.locked || rated || expiring
            ? h`<div class="mls-row">
                ${meal.cooked ? badge("Cooked", "forest", { icon: "check" }) : ""}
                ${meal.locked && !meal.cooked ? badge("Locked", "neutral", { icon: "lock" }) : ""}
                ${fav ? badge(`${fav.name}'s favourite`, "neutral", { icon: "heart" }) : ""}
                ${expiring ? badge("Uses food expiring soon", "amber", { icon: "clock" }) : ""}
                ${rated ? caption(`Rated ${Object.entries(rated).map(([id, n]) => `${A.member(id).name} ${n} of 5`).join(", ")}`) : ""}
              </div>`
            : ""
        }
        ${safetyNote(meal)}
        <div class="mls-meal__foot">
          <span class="mls-meal__meta jds-caption">
            ${meal.fit.length ? "" : h`<span>${A.names(meal.eaters)}</span>`}
            ${r ? h`<span class="mls-fit__item">${icon("users", 12)}Serves ${serves}</span><span class="mls-fit__item">${icon("clock", 12)}${r.minutes} min</span>` : ""}
          </span>
          ${tools}
        </div>
      </article>`;
  };

  // ---------- Day ----------

  const slotsOf = (day) => SLOT_ORDER.filter((slot) => day.meals.some((m) => m.slot === slot));

  const sharingLabel = (day, slot) => {
    const meals = day.meals.filter((m) => m.slot === slot);
    return meals.length > 1 || meals.some((m) => m.sharing === "solo" && S.data.members.length > 1 && m.eaters.length === 1)
      ? "Solo"
      : "Shared";
  };

  const dayTotalsView = (day) => h`
    <div class="mls-day__totals">
      ${A.dayTotals(day)
        .filter((t) => t.total > 0)
        .map(
          (t) =>
            h`<span class="mls-fit__item jds-caption"><strong>${t.member.name}</strong> <span class="mls-num">${t.total.toLocaleString("en-US")} of ${t.target.toLocaleString("en-US")} kcal</span>${t.total > t.target ? badge(`${t.total - t.target} over`, "amber") : ""}</span>`
        )}
    </div>`;

  const dayMenu = (day) =>
    menu(`More for ${A.fmtDay(day.date)}`, [
      { label: "Regenerate this day", icon: "refresh-cw", action: "plan-regen-day", data: { date: day.date }, disabled: aiOff() || A.isWriting() },
      { label: "Day settings", description: "Cook-time limit, Shared or Solo", icon: "settings", action: "go", data: { to: `plan/day/${day.date}` } }
    ]);

  const dayView = (day, index) => {
    const number = String(index + 1).padStart(2, "0");
    const isToday = day.date === F.TODAY;
    const w = S.writing[day.date];
    const queued = A.isWriting() && S.writingQueue.includes(day.date);
    const writingThis = A.writingNow() === day.date;
    const failed = S.failed[day.date];
    const stopped = S.stopped.includes(day.date);

    let meta = isToday ? badge("Today", "forest") : "";
    if (writingThis) meta = h`<span class="jds-indicator jds-indicator--live"><span class="jds-indicator__dot"></span><span>Writing</span></span>`;
    else if (queued) meta = h`<span class="jds-indicator jds-indicator--idle"><span class="jds-indicator__dot"></span><span>Waiting</span></span>`;

    const head = h`
      <div class="mls-day__head">
        ${sectionHead({ number, title: A.fmtDay(day.date), meta, as: "h3" })}
        <div class="mls-day__tools">
          ${day.cookLimit ? badge(`${day.cookLimit} min limit`, "steel", { icon: "timer" }) : ""}
          ${day.lunchOverride === "shared" ? badge("Lunch together", "steel", { icon: "users" }) : ""}
          ${!queued && !failed && !stopped ? dayMenu(day) : ""}
        </div>
      </div>`;

    const cls = `mls-day${isToday ? " mls-day--today" : ""}`;

    if (failed)
      return h`<section class="${cls}">${head}${recovery({
        title: `Moss could not finish ${A.weekday(day.date)}`,
        msg: "The rest of the week is kept.",
        actions: btn("Retry", { size: "sm", icon: "refresh-cw", action: "plan-retry-day", data: { date: day.date }, disabled: aiOff() })
      })}</section>`;

    if (stopped)
      return h`<section class="${cls}">${head}<div class="mls-row">${caption("Not written")}${btn("Write this day", { size: "sm", icon: "refresh-cw", action: "plan-retry-day", data: { date: day.date }, disabled: aiOff() })}</div></section>`;

    if (queued && !writingThis) return h`<section class="${cls}">${head}</section>`;

    const shown = w ? day.meals.slice(0, w.shown) : day.meals;
    const slots = slotsOf(day);
    let writingMarked = false;
    const slotView = (slot) => {
      const meals = shown.filter((m) => m.slot === slot);
      const pending = w ? day.meals.filter((m) => m.slot === slot).length - meals.length : 0;
      let pendingView = "";
      if (pending > 0) {
        pendingView = writingMarked ? caption("Waiting") : h`<span class="mls-writing" role="status">${typing()}${caption("Writing")}</span>`;
        writingMarked = true;
      }
      return h`
        <div class="mls-slot">
          <div class="mls-slot__label">${eyebrow(slot, "strong")}${caption(sharingLabel(day, slot))}</div>
          ${meals.map((m) => mealView(m, day))}
          ${pendingView}
        </div>`;
    };
    return h`
      <section class="${cls}" aria-label="${A.fmtDay(day.date)}">
        ${head}
        ${w ? "" : dayTotalsView(day)}
        <div class="mls-slots" style="--mls-slot-count: ${slots.length}">${slots.map(slotView)}</div>
      </section>`;
  };

  const pastRow = (day, index) => h`
    <div class="mls-past mls-row mls-row--between">
      ${sectionHead({ number: String(index + 1).padStart(2, "0"), title: A.fmtDay(day.date), meta: caption(`${day.meals.filter((m) => m.cooked).length} of ${day.meals.length} cooked`), as: "h3" })}
    </div>`;

  // ---------- Plan page ----------

  const tonight = (plan) => {
    const day = plan.days.find((d) => d.date === F.TODAY);
    return day ? day.meals.find((m) => m.slot === "Dinner") : null;
  };

  const range = (plan) => {
    const end = plan.days[plan.days.length - 1].date;
    return `${A.fmtShort(plan.start)} to ${A.fmtShort(end).split(" ")[0] === A.fmtShort(plan.start).split(" ")[0] ? A.fmtShort(end).split(" ")[1] : A.fmtShort(end)}`;
  };

  const weekNav = (label) => h`
    <div class="mls-datebar">
      ${iconBtn("chevron-left", "Previous week", { action: "plan-week", data: { week: 0 }, disabled: S.week === 0 })}
      <strong class="mls-num">${label}</strong>
      ${iconBtn("chevron-right", "Next week", { action: "plan-week", data: { week: 1 }, disabled: S.week === 1 })}
    </div>`;

  const planBar = (plan) => {
    const started = plan.days.some((d) => A.isPast(d.date) || d.date === F.TODAY);
    if (A.isWriting() && plan.days.some((d) => S.writingQueue.includes(d.date))) {
      const total = plan.days.length;
      const done = plan.days.filter((d) => !S.writingQueue.includes(d.date)).length;
      const now = A.writingNow();
      return h`
        <div class="mls-planbar">
          ${weekNav(range(plan))}
          <div class="mls-progress">
            <span class="jds-caption" role="status">Writing ${A.weekday(now)}, ${done} of ${total} days done</span>
            <div class="jds-progress" role="progressbar" aria-valuemin="0" aria-valuemax="${total}" aria-valuenow="${done}" aria-label="Days written"><div class="jds-progress__fill" style="width: ${Math.round((done / total) * 100)}%"></div></div>
            ${btn("Stop", { size: "sm", variant: "quiet", icon: "x", action: "plan-stop" })}
          </div>
        </div>`;
    }
    const budget = A.phase() >= 4 ? F.later.budget : null;
    return h`
      <div class="mls-planbar">
        <div class="mls-row">
          ${weekNav(range(plan))}
          ${badge(modeLabel(plan.pantryMode), "outline", { icon: "refrigerator" })}
          ${budget ? badge(`About $${budget.estimate} of $${budget.weekly}`, "pine", { icon: "piggy-bank" }) : ""}
        </div>
        <div class="mls-row">
          ${budget ? btn("Rebalance the week", { size: "sm", variant: "quiet", icon: "refresh-cw", action: "plan-rebalance", disabled: aiOff() }) : ""}
          ${btn(started ? "Re-plan from today" : "Regenerate unlocked", { size: "sm", icon: "refresh-cw", href: A.hrefFor("plan/replan"), disabled: aiOff() })}
          ${btn("New plan", { size: "sm", variant: "primary", icon: "plus", href: A.hrefFor("plan/new"), disabled: aiOff() })}
        </div>
      </div>`;
  };

  const aiBanner = () =>
    recovery({
      role: "status",
      title: "Moss can't write meals right now",
      msg: "The AI provider is not answering. Planning, swaps and receipt reading are paused.",
      actions: h`${btn("Try again", { size: "sm", icon: "refresh-cw", action: "plan-ai-retry" })}${btn("AI settings", { size: "sm", variant: "quiet", href: A.hrefFor("settings") })}`
    });

  const liveMarker = () =>
    A.phase() >= 5
      ? h`<p class="mls-row"><span class="jds-indicator jds-indicator--live"><span class="jds-indicator__dot"></span><span>Maya changed Thursday's dinner just now</span></span></p>`
      : "";

  const renderPlan = () => {
    const state = A.reviewState();
    if (state === "loading") return A.page("plan", loading("Loading this week"));
    if (state === "error")
      return A.page(
        "plan",
        recovery({
          title: "Couldn't load this week",
          msg: "Check the connection, then try again.",
          actions: btn("Try again", { size: "sm", icon: "refresh-cw", href: A.hrefFor("plan", { state: "ready" }) })
        })
      );
    const plan = state === "empty" && S.week === 0 ? null : viewedPlan();
    if (!plan) {
      const start = weekStart();
      return A.page(
        "plan",
        h`${weekNav(`${A.fmtShort(start)} to ${A.fmtShort(A.addDays(start, 6)).split(" ")[1]}`)}
        ${empty({
          icon: "utensils",
          title: S.week === 0 ? "Plan your first week" : "Next week is open",
          action: btn("New plan", { variant: "primary", icon: "plus", href: A.hrefFor("plan/new"), disabled: aiOff() })
        })}`
      );
    }

    const t = tonight(plan);
    const writing = A.isWriting() && plan.days.some((d) => S.writingQueue.includes(d.date));
    const head = t
      ? masthead({
          eyebrow: `Tonight · Written by ${plan.writtenBy}`,
          title: A.mealTitle(t),
          lede: t.kind === "recipe" ? `${A.recipe(t.recipeId).minutes} minutes, for ${A.names(t.eaters)}.` : "",
          aside: h`<div class="mls-hero__actions">
            ${t.kind === "recipe" ? btn("Cook tonight", { variant: "field", icon: "chef-hat", href: A.hrefFor(`recipe/${t.id}`) }) : ""}
            ${btn("Something quicker", { variant: "field", icon: "zap", href: A.hrefFor("plan/quick"), disabled: aiOff() })}
          </div>`
        })
      : masthead({
          eyebrow: `${range(plan)} · ${writing ? "Moss is writing" : `Written by ${plan.writtenBy}`}`,
          title: writing ? "Writing your week" : `Week of ${A.fmtShort(plan.start)}`,
          lede: plan.request || "",
          aside: writing
            ? ""
            : h`<div class="mls-hero__actions">${btn("Shopping list", { variant: "field", icon: "shopping-basket", href: A.hrefFor("list") })}</div>`
        });

    const days = plan.days.map((day, i) => ({ day, i }));
    const past = days.filter(({ day }) => A.isPast(day.date));
    const rest = days.filter(({ day }) => !A.isPast(day.date));

    return A.page(
      "plan",
      h`
      <div class="mls-hero">${head}</div>
      ${aiOff() ? aiBanner() : ""}
      ${planBar(plan)}
      ${plan.request && t ? h`<p class="jds-caption">Asked for: ${plan.request}</p>` : ""}
      ${liveMarker()}
      <div class="mls-week">
        ${
          past.length
            ? h`${S.showPast ? past.map(({ day, i }) => dayView(day, i)) : past.map(({ day, i }) => pastRow(day, i))}
              <div class="mls-row">${btn(S.showPast ? "Hide earlier days" : "Show earlier days", { size: "sm", variant: "quiet", icon: S.showPast ? "chevron-down" : "chevron-right", action: "plan-past" })}</div>`
            : ""
        }
        ${rest.map(({ day, i }) => dayView(day, i))}
      </div>`
    );
  };

  // ---------- Dialogs ----------

  const footer = (primary, o = {}) =>
    h`${btn("Cancel", { variant: "quiet", action: "close-dialog" })}${btn(primary, { variant: o.danger ? "danger" : "primary", action: o.action, disabled: o.disabled, data: o.data })}`;

  const newPlanDialog = () => {
    const n = S.newPlan;
    return dialog({
      title: "New plan",
      wide: true,
      body: h`
        <div class="mls-stack">
          <div class="mls-form-grid">
            ${field("Start", input({ id: "np-start", type: "date", value: n.start, data: { bind: "np-start" } }), { id: "np-start" })}
            <div class="jds-field">
              <span class="jds-label">Days</span>
              ${stepper(n.days, { label: "Days to plan", unit: "days", action: "np-days", min: 1 })}
            </div>
          </div>
          <div class="jds-field">
            <span class="jds-label">Pantry</span>
            ${radioCards("np-mode", PANTRY_MODES, n.mode, { label: "Pantry mode", action: "np-mode" })}
          </div>
          ${field("Anything to ask for", textarea({ id: "np-ask", rows: 2, placeholder: "Quick dinners Tuesday, a roast on Sunday", data: { bind: "np-ask" } }), { id: "np-ask" })}
          <div class="jds-field">
            <span class="jds-label">Bring back from last week</span>
            <div class="mls-chips">${F.lastWeek.map((title) => chip(title, n.asks.includes(title), { action: "np-ask-toggle", data: { title } }))}</div>
          </div>
        </div>`,
      foot: footer("Write plan", { action: "np-submit", disabled: aiOff() })
    });
  };

  const replanDialog = () => {
    const plan = viewedPlan();
    if (!plan) return "";
    const dates = futureDates(plan);
    const locked = plan.days.filter((d) => dates.includes(d.date)).flatMap((d) => d.meals).filter((m) => m.locked).length;
    const started = dates.length < plan.days.length;
    return dialog({
      title: started ? "Re-plan from today" : "Regenerate unlocked meals",
      desc: `${A.fmtDay(dates[0])} to ${A.fmtDay(dates[dates.length - 1])}. Earlier days stay as they are.`,
      body: h`
        <div class="mls-stack">
          ${locked ? h`<p class="mls-row">${icon("lock", 14)}${caption(`${locked} locked ${locked === 1 ? "meal stays" : "meals stay"}.`)}</p>` : ""}
          <div class="jds-field">
            <span class="jds-label">Pantry</span>
            ${radioCards("rp-mode", PANTRY_MODES, started ? "prefer" : plan.pantryMode, { label: "Pantry mode" })}
          </div>
          ${field("Anything to change", textarea({ id: "rp-ask", rows: 2, placeholder: "Use up the mushrooms" }), { id: "rp-ask" })}
        </div>`,
      foot: footer(started ? "Re-plan" : "Regenerate", { action: "plan-replan-submit", disabled: aiOff() })
    });
  };

  // What a swap would do to the shopping list, without doing it.
  const listPreview = (fromId, toId) => {
    const from = fromId ? A.recipe(fromId) : null;
    const to = A.recipe(toId);
    const onList = (name) => S.data.list.find((l) => l.name.toLowerCase() === name.toLowerCase());
    const adds = to.ingredients.filter((i) => !A.onHand(i.name) && !onList(i.name)).map((i) => i.name);
    const drops = from
      ? from.ingredients
          .map((i) => onList(i.name))
          .filter((l) => l && !l.manual && l.sources.length === 1 && l.sources[0] === from.title && !to.ingredients.some((j) => j.name.toLowerCase() === l.name.toLowerCase()))
          .map((l) => l.name.toLowerCase())
      : [];
    const parts = [adds.length && `adds ${adds.join(", ")}`, drops.length && `drops ${drops.join(", ")}`].filter(Boolean);
    return parts.length ? `List ${parts.join("; ")}` : "No change to the list";
  };

  const choiceRow = (recipeId, meal, o = {}) => {
    const r = A.recipe(recipeId);
    const have = r.ingredients.filter((i) => A.onHand(i.name));
    const buy = r.ingredients.filter((i) => !A.onHand(i.name));
    const fit = fitFor(meal.eaters, meal.slot, recipeId);
    return h`
      <div class="mls-line">
        <span class="jds-empty__mark">${icon("utensils", 16)}</span>
        <div class="mls-line__body">
          <span class="mls-line__name">${r.title}</span>
          <span class="jds-caption">${r.minutes} min · ${fit.map((f) => `${A.member(f.memberId).name} ${f.kcal} kcal`).join(" · ")}</span>
          ${
            o.showBuy
              ? h`<span class="jds-caption">${buy.length ? `To buy: ${buy.map((i) => i.name).join(", ")}` : "Nothing to buy"}</span>`
              : h`<span class="jds-caption">Uses ${have.length} ${have.length === 1 ? "thing" : "things"} you have</span>`
          }
          ${o.listFrom !== undefined ? h`<span class="jds-caption">${listPreview(o.listFrom, recipeId)}</span>` : ""}
        </div>
        <span></span>
        ${btn("Choose", { size: "sm", action: o.action, data: { meal: meal.id, recipe: recipeId } })}
      </div>`;
  };

  const swapDialog = ({ mealId }) => {
    const found = A.findMeal(mealId);
    if (!found) return "";
    const { meal } = found;
    const choices = pool(meal.slot, [meal.recipeId]);
    const start = S.swapOffset % Math.max(choices.length, 1);
    const three = [0, 1, 2].map((k) => choices[(start + k) % choices.length]).filter((v, i, arr) => v && arr.indexOf(v) === i);
    return dialog({
      title: `Swap ${A.mealTitle(meal)}`,
      desc: `${A.weekday(found.day.date)} ${meal.slot.toLowerCase()} for ${A.names(meal.eaters)}`,
      body: h`<div class="mls-section">${three.map((id) => choiceRow(id, meal, { action: "plan-swap-choose", listFrom: meal.recipeId || null }))}</div>`,
      foot: h`${btn("Three more", { variant: "quiet", icon: "refresh-cw", action: "plan-swap-more", disabled: aiOff() })}${btn("Cancel", { action: "close-dialog" })}`
    });
  };

  const quickDialog = () => {
    const plan = S.plans.find((p) => p.start === F.plan.start);
    const t = tonight(plan);
    if (!t) return "";
    const choices = Object.keys(F.recipes).filter((id) => A.recipe(id).minutes <= S.quickLimit && !["r-yoghurt", "r-oats"].includes(id));
    return dialog({
      title: "Something quicker tonight",
      desc: `In place of ${A.mealTitle(t)}`,
      body: h`
        <div class="mls-stack">
          ${segmented(
            [15, 20, 30].map((n) => ({ value: String(n), label: `${n} min` })),
            String(S.quickLimit),
            { label: "Time limit", action: "plan-quick-limit" }
          )}
          <div class="mls-section">${choices.slice(0, 3).map((id) => choiceRow(id, t, { action: "plan-quick-choose", showBuy: true }))}</div>
        </div>`,
      foot: btn("Keep tonight's meal", { action: "close-dialog" })
    });
  };

  const moveDialog = ({ mealId }) => {
    const found = A.findMeal(mealId);
    if (!found) return "";
    const plan = S.plans.find((p) => p.days.includes(found.day));
    const days = plan.days.filter((d) => !A.isPast(d.date));
    return dialog({
      title: `Move ${A.mealTitle(found.meal)}`,
      body: h`
        <div class="mls-form-grid">
          ${field("Day", select(days.map((d) => ({ value: d.date, label: A.fmtDay(d.date) })), found.day.date, { id: "mv-day" }), { id: "mv-day" })}
          ${field("Meal", select(SLOT_ORDER, found.meal.slot, { id: "mv-slot" }), { id: "mv-slot", hint: "Whatever is there moves to this meal's place." })}
        </div>`,
      foot: footer("Move", { action: "plan-move-submit", data: { meal: mealId } })
    });
  };

  const eatersDialog = ({ mealId }) => {
    const found = A.findMeal(mealId);
    if (!found) return "";
    const { meal } = found;
    return dialog({
      title: `Who eats ${A.mealTitle(meal)}`,
      body: h`
        <div class="mls-stack">
          <div class="mls-stack mls-stack--tight">
            ${S.data.members.map((m) => check(m.name, meal.eaters.includes(m.id), { data: { eater: m.id } }))}
          </div>
          <div class="jds-field">
            <span class="jds-label">Anyone left out</span>
            ${radioCards(
              "eat-left",
              [
                { value: "own", label: "Plan them their own meal", description: "A one-off meal sized for them." },
                { value: "none", label: "Nothing for them", description: "They are out or eating elsewhere." }
              ],
              "own",
              { label: "Anyone left out" }
            )}
          </div>
        </div>`,
      foot: footer("Save", { action: "plan-eaters-submit", data: { meal: mealId } })
    });
  };

  const textDialog = ({ mealId }) => {
    const found = A.findMeal(mealId);
    if (!found) return "";
    const { meal, day } = found;
    return dialog({
      title: `${A.weekday(day.date)} ${meal.slot.toLowerCase()}`,
      body: h`
        <div class="mls-stack">
          ${field("Plain text", input({ id: "tx-text", value: meal.kind === "text" ? meal.text : "", placeholder: "Eating out" }), { id: "tx-text" })}
          <div class="mls-chips">${["Eating out", "Leftovers", "Takeaway", "Skip"].map((t) => chip(t, meal.text === t, { action: "plan-text-pick", data: { text: t } }))}</div>
        </div>`,
      foot: h`
        ${meal.kind === "text" ? btn("Plan a meal here", { variant: "quiet", icon: "refresh-cw", action: "plan-text-to-meal", data: { meal: mealId }, disabled: aiOff() }) : ""}
        ${btn("Cancel", { variant: "quiet", action: "close-dialog" })}
        ${btn("Save", { variant: "primary", action: "plan-text-submit", data: { meal: mealId } })}`
    });
  };

  const dayDialog = ({ date }) => {
    const day = A.findDay(date);
    if (!day) return "";
    const isWeekday = !["Saturday", "Sunday"].includes(A.weekday(date));
    const lunchShared = day.lunchOverride === "shared" || !isWeekday;
    return dialog({
      title: A.fmtDay(date),
      body: h`
        <div class="mls-stack">
          ${field(
            "Cook-time limit",
            select(
              [{ value: "", label: "No limit" }, ...[15, 20, 30, 45, 60].map((n) => ({ value: String(n), label: `${n} minutes` }))],
              day.cookLimit ? String(day.cookLimit) : "",
              { id: "dd-limit" }
            ),
            { id: "dd-limit" }
          )}
          <div class="jds-field">
            <span class="jds-label">Lunch</span>
            ${segmented(
              [
                { value: "shared", label: "Shared" },
                { value: "solo", label: "Solo" }
              ],
              lunchShared ? "shared" : "solo",
              { label: "Lunch on this day", action: "dd-lunch", data: { date } }
            )}
          </div>
        </div>`,
      foot: h`
        ${btn("Regenerate this day", { variant: "quiet", icon: "refresh-cw", action: "plan-regen-day", data: { date }, disabled: aiOff() })}
        ${btn("Cancel", { variant: "quiet", action: "close-dialog" })}
        ${btn("Save", { variant: "primary", action: "dd-submit", data: { date } })}`
    });
  };

  const favouriteDialog = ({ date, slot }) => {
    const day = A.findDay(date);
    if (!day) return "";
    return dialog({
      title: `A favourite for ${A.weekday(date)} ${slot.toLowerCase()}`,
      body: h`
        <div class="mls-stack">
          ${S.data.members.map(
            (m) => h`
              <div class="mls-section">
                <div class="mls-block-head">${eyebrow(m.name, "strong")}</div>
                ${(S.data.favourites[m.id] || []).map((id) => {
                  const r = A.recipe(id);
                  return h`<div class="mls-line">
                    <span class="jds-empty__mark">${icon("heart", 16)}</span>
                    <div class="mls-line__body"><span class="mls-line__name">${r.title}</span><span class="jds-caption">${r.minutes} min</span></div>
                    <span></span>
                    ${btn("Place", { size: "sm", action: "plan-favourite-place", data: { date, slot, recipe: id, member: m.id } })}
                  </div>`;
                })}
              </div>`
          )}
        </div>`,
      foot: btn("Cancel", { action: "close-dialog" })
    });
  };

  // ---------- Routes ----------

  const base = () => "plan";

  A.route("plan", { render: renderPlan, sample: "plan", label: "Plan: this week" });
  A.route("plan/next", {
    render: renderPlan,
    sample: "plan/next",
    label: "Plan: next week, not planned",
    enter: () => {
      S.week = 1;
    }
  });
  A.route("plan/writing", {
    render: renderPlan,
    sample: "plan/writing",
    label: "Plan: days filling in",
    enter: () => writeNewPlan(NEXT_START, 7, { request: "Quick dinners midweek. Fish once." })
  });
  A.route("plan/failed", {
    render: renderPlan,
    sample: "plan/failed",
    label: "Plan: a day and a meal could not be written",
    enter: () => {
      S.week = 0;
      S.failed["2026-11-06"] = true;
      S.slotFailed.p20 = true;
    }
  });
  A.route("plan/new", { page: base, dialog: newPlanDialog, sample: "plan/new", label: "Plan: new plan" });
  A.route("plan/replan", { page: base, dialog: replanDialog, sample: "plan/replan", label: "Plan: re-plan from today" });
  A.route("plan/quick", { page: base, dialog: quickDialog, sample: "plan/quick", label: "Plan: something quicker tonight" });
  A.route("plan/swap/:mealId", { page: base, dialog: swapDialog, sample: "plan/swap/p14", label: "Plan: swap a meal" });
  A.route("plan/move/:mealId", { page: base, dialog: moveDialog, sample: "plan/move/p19", label: "Plan: move a meal" });
  A.route("plan/eaters/:mealId", { page: base, dialog: eatersDialog, sample: "plan/eaters/p14", label: "Plan: change who eats" });
  A.route("plan/text/:mealId", { page: base, dialog: textDialog, sample: "plan/text/p24", label: "Plan: plain-text meal" });
  A.route("plan/day/:date", { page: base, dialog: dayDialog, sample: "plan/day/2026-11-05", label: "Plan: day settings" });
  A.route("plan/favourite/:date/:slot", {
    page: base,
    dialog: favouriteDialog,
    sample: "plan/favourite/2026-11-07/Dinner",
    label: "Plan: place a favourite"
  });

  // ---------- Actions ----------

  A.planSafety = { safetyOf, safeSwapFor };

  const mealOf = (el) => A.findMeal(el.dataset.meal);

  Object.assign(A.actions, {
    "plan-week": (el) => {
      S.week = Number(el.dataset.week);
      const plan = viewedPlan();
      if (plan) S.planId = plan.id;
      A.go("plan");
    },
    "plan-past": () => {
      S.showPast = !S.showPast;
      A.render();
    },
    "plan-lock": (el) => {
      const { meal } = mealOf(el);
      meal.locked = !meal.locked;
      A.render();
    },
    "plan-stop": () => {
      A.stopWriting();
      A.toast("Stopped. Finished days are kept.", { icon: "x", tone: "drift" });
      A.render();
    },
    "plan-retry-day": (el) => {
      A.startWriting([el.dataset.date]);
      A.go("plan");
    },
    "plan-retry-slot": (el) => {
      const id = el.dataset.meal;
      delete S.slotFailed[id];
      S.mealWriting[id] = true;
      A.render();
      setTimeout(() => {
        delete S.mealWriting[id];
        S.newMealId = id;
        A.render();
      }, 1400);
    },
    "plan-regen-meal": (el) => {
      const { meal, day } = mealOf(el);
      S.mealWriting[meal.id] = true;
      A.render();
      setTimeout(() => {
        const next = pool(meal.slot, [meal.recipeId])[0];
        if (next) setRecipe(meal, next, day.meals.indexOf(meal));
        delete S.mealWriting[meal.id];
        S.newMealId = meal.id;
        A.render();
        listChanged();
      }, 1400);
    },
    "plan-regen-day": (el) => {
      const date = el.dataset.date;
      const plan = S.plans.find((p) => p.days.some((d) => d.date === date));
      rewriteDays(plan, [date]);
      A.go("plan");
    },
    "plan-favourite-toggle": (el) => {
      const { meal } = mealOf(el);
      const id = el.dataset.member;
      const favs = S.data.favourites[id];
      if (meal.favouriteOf === id) {
        meal.favouriteOf = null;
        S.data.favourites[id] = favs.filter((r) => r !== meal.recipeId);
      } else {
        meal.favouriteOf = id;
        if (!favs.includes(meal.recipeId)) favs.push(meal.recipeId);
        A.toast(`Saved as ${A.member(id).name}'s favourite.`, { icon: "heart" });
      }
      A.render();
    },
    "plan-ai-retry": () => A.go(A.current().path, { state: "ready" }),
    "plan-rebalance": () => {
      const plan = viewedPlan();
      rewriteDays(plan, futureDates(plan).slice(1));
      A.toast("Rebalancing the rest of the week.", { icon: "refresh-cw" });
    },
    "np-days": (el) => {
      S.newPlan.days = Math.max(1, Math.min(14, S.newPlan.days + Number(el.dataset.step)));
      A.render();
    },
    "np-mode": (el) => {
      S.newPlan.mode = el.value;
    },
    "np-ask-toggle": (el) => {
      const t = el.dataset.title;
      S.newPlan.asks = S.newPlan.asks.includes(t) ? S.newPlan.asks.filter((x) => x !== t) : [...S.newPlan.asks, t];
      el.setAttribute("aria-pressed", String(S.newPlan.asks.includes(t)));
    },
    "np-submit": () => {
      const start = document.getElementById("np-start").value || NEXT_START;
      const ask = document.getElementById("np-ask").value.trim();
      const request = [ask, ...S.newPlan.asks.map((t) => `Bring back ${t.toLowerCase()}.`)].filter(Boolean).join(" ");
      writeNewPlan(start, S.newPlan.days, { mode: S.newPlan.mode, request });
      A.go("plan");
    },
    "plan-replan-submit": () => {
      const plan = viewedPlan();
      const mode = document.querySelector('input[name="rp-mode"]:checked')?.value;
      if (mode) plan.pantryMode = mode;
      rewriteDays(plan, futureDates(plan));
      A.go("plan");
    },
    "plan-swap-more": () => {
      S.swapOffset += 3;
      A.render();
    },
    "plan-swap-choose": (el) => {
      const { meal, day } = mealOf(el);
      swapMeal(meal, day, el.dataset.recipe);
    },
    "plan-safe-swap": (el) => {
      const { meal, day } = mealOf(el);
      const pick = safeSwapFor(meal);
      if (pick) swapMeal(meal, day, pick, `Safe swap: ${A.recipe(pick).title}`);
    },
    "plan-swap-undo": () => {
      const u = S.planUndo;
      if (!u) return;
      const found = A.findMeal(u.mealId);
      if (found) Object.assign(found.meal, u.meal);
      S.data.list = u.list;
      S.planUndo = null;
      S.newMealId = null;
      A.toast("Put the meal and the list back.", { icon: "undo-2", tone: "drift" });
      A.render();
    },
    "plan-quick-limit": (el) => {
      S.quickLimit = Number(el.dataset.value);
      A.render();
    },
    "plan-quick-choose": (el) => {
      const { meal } = mealOf(el);
      const r = A.recipe(el.dataset.recipe);
      const buy = r.ingredients.filter((i) => !A.onHand(i.name));
      setRecipe(meal, el.dataset.recipe, 0);
      S.newMealId = meal.id;
      buy.forEach((i, k) =>
        S.data.list.push({
          id: `lq${Date.now()}${k}`,
          name: i.name.charAt(0).toUpperCase() + i.name.slice(1),
          need: i.text,
          buy: i.text,
          section: i.section,
          sources: [r.title],
          manual: false,
          staple: false,
          checked: false,
          checkLabel: Boolean(i.checkLabel)
        })
      );
      A.go("plan");
      A.toast(buy.length ? `${buy.length} ${buy.length === 1 ? "item" : "items"} added to the shopping list.` : "Everything is on hand.", {
        title: `Tonight: ${r.title}`,
        icon: "zap"
      });
    },
    "plan-move-submit": (el) => {
      const { meal, day } = mealOf(el);
      const date = document.getElementById("mv-day").value;
      const slot = document.getElementById("mv-slot").value;
      const target = A.findDay(date);
      const other = target.meals.find((m) => m.slot === slot && m !== meal);
      day.meals = day.meals.filter((m) => m !== meal);
      if (other) {
        target.meals = target.meals.filter((m) => m !== other);
        other.slot = meal.slot;
        day.meals.push(other);
      }
      meal.slot = slot;
      target.meals.push(meal);
      S.newMealId = meal.id;
      A.go("plan");
      listChanged();
    },
    "plan-eaters-submit": (el) => {
      const { meal, day } = mealOf(el);
      const picked = [...document.querySelectorAll("#dialog-root input[data-eater]")].filter((c) => c.checked).map((c) => c.dataset.eater);
      if (!picked.length) {
        A.toast("Pick at least one person.", { tone: "error", icon: "circle-alert" });
        return;
      }
      const left = meal.eaters.filter((id) => !picked.includes(id));
      const own = document.querySelector('input[name="eat-left"]:checked')?.value === "own";
      meal.eaters = picked;
      meal.sharing = picked.length > 1 ? "shared" : "solo";
      if (meal.kind === "recipe") meal.fit = fitFor(picked, meal.slot, meal.recipeId);
      if (own && meal.kind === "recipe")
        left.forEach((id, k) => {
          const extra = structuredClone(meal);
          Object.assign(extra, { id: `${meal.id}-own-${k}`, eaters: [id], sharing: "solo", locked: false, favouriteOf: null });
          setRecipe(extra, pool(meal.slot, [meal.recipeId])[k] || meal.recipeId, k);
          day.meals.push(extra);
          S.newMealId = extra.id;
        });
      A.go("plan");
      listChanged();
    },
    "plan-text-pick": (el) => {
      document.getElementById("tx-text").value = el.dataset.text;
    },
    "plan-text-submit": (el) => {
      const { meal } = mealOf(el);
      const text = document.getElementById("tx-text").value.trim();
      if (!text) {
        A.toast("Type something, or plan a meal here.", { tone: "error", icon: "circle-alert" });
        return;
      }
      Object.assign(meal, { kind: "text", text, recipeId: null, fit: [], favouriteOf: null });
      A.go("plan");
      listChanged();
    },
    "plan-text-to-meal": (el) => {
      const { meal, day } = mealOf(el);
      S.mealWriting[meal.id] = true;
      A.go("plan");
      setTimeout(() => {
        setRecipe(meal, pool(meal.slot)[day.meals.indexOf(meal) % pool(meal.slot).length], 1);
        delete S.mealWriting[meal.id];
        S.newMealId = meal.id;
        A.render();
        listChanged();
      }, 1400);
    },
    "dd-lunch": (el) => {
      const day = A.findDay(el.dataset.date);
      day.pendingLunch = el.dataset.value;
      el.parentElement.querySelectorAll(".jds-segmented__opt").forEach((b) => b.setAttribute("aria-pressed", String(b === el)));
    },
    "dd-submit": (el) => {
      const day = A.findDay(el.dataset.date);
      const limit = document.getElementById("dd-limit").value;
      day.cookLimit = limit ? Number(limit) : null;
      if (day.pendingLunch) day.lunchOverride = day.pendingLunch === "shared" ? "shared" : null;
      delete day.pendingLunch;
      A.go("plan");
    },
    "plan-favourite-place": (el) => {
      const day = A.findDay(el.dataset.date);
      const meal = day.meals.find((m) => m.slot === el.dataset.slot);
      if (meal) {
        setRecipe(meal, el.dataset.recipe, 0);
        meal.favouriteOf = el.dataset.member;
        meal.locked = true;
        S.newMealId = meal.id;
      }
      A.go("plan");
      listChanged();
    }
  });

  A.plan = { viewedPlan, setRecipe, fitFor, tonight, SLOT_ORDER, PANTRY_MODES, modeLabel };
})();
