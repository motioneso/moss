// Meals prototype core: hash router, shared markup helpers, review tools and the
// plan-writing simulation. Screens register themselves from the screen-*.js files.
/* global window, document, location, history */

(function () {
  const F = window.MEALS_FAKE;
  const ICONS = window.MEALS_ICONS;

  // ---------- Markup ----------

  class Raw {
    constructor(value) {
      this.value = value;
    }
    toString() {
      return this.value;
    }
  }

  const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  const esc = (value) => String(value).replace(/[&<>"']/g, (c) => ESCAPES[c]);

  const part = (value) => {
    if (value === null || value === undefined || value === false) return "";
    if (value instanceof Raw) return value.value;
    if (Array.isArray(value)) return value.map(part).join("");
    return esc(value);
  };

  // Tagged template: interpolations are escaped unless already markup.
  const h = (strings, ...values) =>
    new Raw(strings.reduce((out, s, i) => out + s + (i < values.length ? part(values[i]) : ""), ""));

  const raw = (value) => new Raw(value);

  const attrs = (map) =>
    raw(
      Object.entries(map)
        .filter(([, v]) => v !== null && v !== undefined && v !== false)
        .map(([k, v]) => (v === true ? ` ${k}` : ` ${k}="${esc(v)}"`))
        .join("")
    );

  const dataAttrs = (data) =>
    attrs(Object.fromEntries(Object.entries(data || {}).map(([k, v]) => [`data-${k}`, v])));

  // ---------- Primitives (markup mirrors packages/ui/src) ----------

  const icon = (name, size = 16) =>
    raw(
      `<svg class="mls-icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ""}</svg>`
    );

  // Button: variant primary | secondary | quiet | link | danger | field | accentSoft.
  const btn = (label, opts = {}) => {
    const cls = ["jds-btn", `jds-btn--${opts.variant || "secondary"}`];
    if (opts.size) cls.push(`jds-btn--${opts.size}`);
    if (opts.block) cls.push("jds-btn--block");
    if (opts.active) cls.push("jds-btn--active");
    const inner = h`${opts.icon ? h`<span class="jds-btn__icon">${icon(opts.icon, 16)}</span>` : ""}<span>${label}</span>`;
    const common = {
      class: cls.join(" "),
      title: opts.title,
      "aria-label": opts.ariaLabel,
      "aria-pressed": opts.pressed === undefined ? null : String(opts.pressed),
      "data-action": opts.action
    };
    if (opts.href && !opts.disabled) return h`<a${attrs({ ...common, href: opts.href })}${dataAttrs(opts.data)}>${inner}</a>`;
    return h`<button${attrs({ ...common, type: opts.type || "button", disabled: opts.disabled })}${dataAttrs(opts.data)}>${inner}</button>`;
  };

  const iconBtn = (name, label, opts = {}) => {
    const cls = ["jds-iconbtn"];
    if (opts.size !== "md") cls.push("jds-iconbtn--sm");
    if (opts.secondary) cls.push("jds-iconbtn--secondary");
    if (opts.active) cls.push("jds-iconbtn--active");
    const common = {
      class: cls.join(" "),
      "aria-label": label,
      title: label,
      "aria-pressed": opts.pressed === undefined ? null : String(opts.pressed),
      "data-action": opts.action
    };
    if (opts.href && !opts.disabled)
      return h`<a${attrs({ ...common, href: opts.href })}${dataAttrs(opts.data)}>${icon(name, 16)}</a>`;
    return h`<button${attrs({ ...common, type: "button", disabled: opts.disabled })}${dataAttrs(opts.data)}>${icon(name, 16)}</button>`;
  };

  // Badge tone: neutral | forest | pine | amber | red | steel | outline.
  const badge = (text, tone = "neutral", opts = {}) =>
    h`<span class="jds-badge jds-badge--${tone}${opts.pill ? " jds-badge--pill" : ""}">${opts.icon ? icon(opts.icon, 12) : ""}${text}</span>`;

  const eyebrow = (text, mod) => h`<span class="jds-eyebrow${mod ? ` jds-eyebrow--${mod}` : ""}">${text}</span>`;

  const caption = (text) => h`<span class="jds-caption">${text}</span>`;

  const masthead = (o) => h`
    <header class="jds-masthead${o.tone === "default" ? "" : " jds-masthead--field"}${o.compact ? " jds-masthead--compact" : ""}">
      <div class="jds-masthead__row">
        <div class="jds-masthead__main">
          ${o.eyebrow ? h`<p class="jds-masthead__eyebrow">${o.eyebrow}</p>` : ""}
          <h1 class="jds-masthead__title"><span>${o.title}</span>${o.accent ? h` <span class="jds-masthead__accent">${o.accent}</span>` : ""}</h1>
          ${o.lede ? h`<p class="jds-masthead__lede">${o.lede}</p>` : ""}
        </div>
        ${o.aside ? h`<div class="jds-masthead__aside">${o.aside}</div>` : ""}
      </div>
    </header>`;

  const sectionHead = (o) => h`
    <div class="jds-section-head${o.rule ? " jds-section-head--rule" : ""}${o.center ? " jds-section-head--center" : ""}">
      ${o.number !== undefined ? h`<span class="jds-section-head__number">${o.number}</span>` : ""}
      <${raw(o.as || "h2")} class="jds-section-head__title">${o.title}</${raw(o.as || "h2")}>
      ${o.meta ? h`<span class="jds-section-head__meta">${o.meta}</span>` : ""}
    </div>`;

  const segmented = (options, value, o = {}) => h`
    <div class="jds-segmented${o.field ? " jds-segmented--field" : ""}" role="group" aria-label="${o.label || ""}">
      ${options.map(
        (opt) =>
          h`<button type="button" class="jds-segmented__opt" aria-pressed="${String(opt.value === value)}"${attrs({ "data-action": o.action, disabled: opt.disabled, title: opt.title })}${dataAttrs({ value: opt.value, ...(o.data || {}) })}>${opt.label}</button>`
      )}
    </div>`;

  const empty = (o) => h`
    <div class="jds-empty">
      ${o.icon ? h`<span class="jds-empty__mark">${icon(o.icon, 22)}</span>` : ""}
      <div class="jds-empty__title">${o.title}</div>
      ${o.sub ? h`<div class="jds-empty__sub">${o.sub}</div>` : ""}
      ${o.action ? h`<div class="mls-row">${o.action}</div>` : ""}
    </div>`;

  // Loading: one quiet line, no spinner, per the design-system empty and loading rules.
  const loading = (text) => h`<p class="jds-caption" role="status">${text}</p>`;

  const recovery = (o) => h`
    <div class="jds-recovery" role="${o.role || "alert"}">
      <span class="jds-recovery__icon">${icon(o.icon || "triangle-alert", 18)}</span>
      <div>
        <div class="jds-recovery__title">${o.title}</div>
        ${o.msg ? h`<div class="jds-recovery__msg">${o.msg}</div>` : ""}
        ${o.actions ? h`<div class="jds-recovery__actions">${o.actions}</div>` : ""}
      </div>
    </div>`;

  const field = (label, control, o = {}) => h`
    <div class="jds-field">
      <label class="jds-label"${attrs({ for: o.id })}>${label}</label>
      ${control}
      ${o.hint ? h`<span class="jds-hint${o.error ? " jds-hint--error" : ""}">${o.hint}</span>` : ""}
    </div>`;

  const input = (o = {}) =>
    h`<input${attrs({ class: `jds-input${o.num ? " jds-input--num" : ""}${o.sm ? " jds-input--sm" : ""}`, id: o.id, type: o.type || "text", value: o.value, placeholder: o.placeholder, name: o.name, min: o.min, max: o.max, step: o.step, "aria-label": o.ariaLabel, disabled: o.disabled, inputmode: o.inputmode })}${dataAttrs(o.data)} />`;

  const textarea = (o = {}) =>
    h`<textarea${attrs({ class: "jds-textarea", id: o.id, rows: o.rows || 3, placeholder: o.placeholder, "aria-label": o.ariaLabel, disabled: o.disabled })}${dataAttrs(o.data)}>${o.value || ""}</textarea>`;

  const select = (options, value, o = {}) => h`
    <span class="jds-selectwrap">
      <select${attrs({ class: "jds-select", id: o.id, "aria-label": o.ariaLabel, "data-action": o.action, disabled: o.disabled })}${dataAttrs(o.data)}>
        ${options.map((opt) => {
          const v = typeof opt === "string" ? opt : opt.value;
          const l = typeof opt === "string" ? opt : opt.label;
          return h`<option value="${v}"${v === value ? raw(" selected") : ""}>${l}</option>`;
        })}
      </select>
      <span class="jds-selectwrap__chev">${icon("chevron-down", 14)}</span>
    </span>`;

  const check = (label, checked, o = {}) => h`
    <label class="jds-check">
      <input type="checkbox"${attrs({ id: o.id, checked, "data-action": o.action, disabled: o.disabled, "aria-label": o.ariaLabel })}${dataAttrs(o.data)} />
      <span class="jds-check__box">${icon("check", 12)}</span>
      ${label ? h`<span>${label}</span>` : ""}
    </label>`;

  const toggle = (label, on, o = {}) => h`
    <label class="jds-switch">
      <input type="checkbox" role="switch"${attrs({ checked: on, "data-action": o.action, disabled: o.disabled })}${dataAttrs(o.data)} />
      <span class="jds-switch__track"><span class="jds-switch__thumb"></span></span>
      <span class="jds-switch__label">${label}</span>
    </label>`;

  const radioCards = (name, options, value, o = {}) => h`
    <div class="jds-radio-cards" role="radiogroup"${attrs({ "aria-label": o.label })}>
      ${options.map(
        (opt) => h`
          <label class="jds-radio-card">
            <input type="radio" name="${name}" value="${opt.value}"${attrs({ checked: opt.value === value, "data-action": o.action, disabled: opt.disabled })}${dataAttrs(o.data)} />
            <span class="jds-radio-card__label">${opt.label}</span>
            ${opt.description ? h`<span class="jds-radio-card__description">${opt.description}</span>` : ""}
          </label>`
      )}
    </div>`;

  const chip = (label, pressed, o = {}) =>
    h`<button type="button" class="jds-chip jds-chip--toggle" aria-pressed="${String(Boolean(pressed))}"${attrs({ "data-action": o.action })}${dataAttrs(o.data)}>${label}</button>`;

  const removableChip = (label, o = {}) =>
    h`<span class="jds-chip">${label}<button type="button" class="jds-chip__x" aria-label="Remove ${label}"${attrs({ "data-action": o.action })}${dataAttrs(o.data)}>${icon("x", 12)}</button></span>`;

  // Menu: trigger plus list; behaviour lives in the document handlers below.
  // The list sets its own display, so a bare wrapper carries the hidden flag.
  const menu = (label, items, o = {}) => h`
    <div class="jds-menu">
      <button type="button" class="jds-menu__trigger" aria-label="${label}" title="${label}" aria-expanded="false" aria-haspopup="menu" data-menu-trigger>${icon(o.icon || "ellipsis", 16)}</button>
      <div data-menu-panel hidden><div class="jds-menu__list${o.top ? " jds-menu__list--top" : ""}" role="menu" aria-label="${label}">
        ${items.map((item) =>
          item.separator
            ? ""
            : h`<button type="button" role="menuitem" tabindex="-1"${attrs({ "data-action": item.action, disabled: item.disabled })}${dataAttrs(item.data)}>${item.icon ? icon(item.icon, 16) : ""}${
                item.description
                  ? h`<span class="jds-menu__text"><span>${item.label}</span><span class="jds-menu__desc">${item.description}</span></span>`
                  : item.label
              }</button>`
        )}
      </div></div>
    </div>`;

  const dialog = (o) => h`
    <div class="jds-dialog-scrim" data-dialog-scrim>
      <div class="jds-dialog${o.wide ? " mls-dialog-wide" : ""}" role="dialog" aria-modal="true" aria-labelledby="dlg-title" tabindex="-1">
        <div class="jds-dialog__head">
          <div class="jds-dialog__heading">
            <div class="jds-dialog__title" id="dlg-title">${o.title}</div>
            <button type="button" class="jds-iconbtn" aria-label="Close" data-action="close-dialog">${icon("x", 18)}</button>
          </div>
          ${o.desc ? h`<div class="jds-dialog__desc">${o.desc}</div>` : ""}
        </div>
        <div class="jds-dialog__body">${o.body}</div>
        ${o.foot ? h`<div class="jds-dialog__foot">${o.foot}</div>` : ""}
      </div>
    </div>`;

  const stepper = (value, o = {}) => h`
    <span class="mls-stepper" role="group" aria-label="${o.label}">
      ${iconBtn("minus", `Fewer ${o.unit || ""}`.trim(), { action: o.action, data: { ...(o.data || {}), step: -1 }, secondary: true, disabled: value <= (o.min ?? 1) })}
      <span class="mls-stepper__value" aria-live="polite">${value}</span>
      ${iconBtn("plus", `More ${o.unit || ""}`.trim(), { action: o.action, data: { ...(o.data || {}), step: 1 }, secondary: true })}
    </span>`;

  const typing = () =>
    h`<span class="mls-dots" aria-hidden="true"><span class="jds-typing-dot"></span><span class="jds-typing-dot"></span><span class="jds-typing-dot"></span></span>`;

  // ---------- Data helpers ----------

  const S = {
    data: structuredClone(F),
    plans: [],
    planId: F.plan.id,
    showPast: false,
    units: "us",
    pantryModeDefault: "prefer",
    // Days being written: date -> { shown, failed }.
    writing: {},
    writingQueue: [],
    timer: null,
    stopped: [],
    failed: {},
    slotFailed: {},
    newMealId: null,
    servings: {},
    review: { collapsed: window.matchMedia("(max-width: 720px)").matches },
    rated: {},
    leftovers: true,
    logPortion: true
  };

  S.plans.push(S.data.plan);

  const activePlan = () => S.plans.find((p) => p.id === S.planId) || S.plans[0];
  const allDays = () => S.plans.flatMap((p) => p.days);
  const findDay = (date) => allDays().find((d) => d.date === date);

  const member = (id) => S.data.members.find((m) => m.id === id);
  const names = (ids) => {
    const list = ids.map((id) => member(id)?.name || "Someone");
    return list.length <= 1 ? list.join("") : `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`;
  };
  const recipe = (id) => S.data.recipes[id];
  const allMeals = () => allDays().flatMap((d) => d.meals.map((m) => ({ ...m, date: d.date })));
  const findMeal = (id) => {
    for (const day of allDays()) {
      const m = day.meals.find((x) => x.id === id);
      if (m) return { meal: m, day };
    }
    return null;
  };
  const mealTitle = (m) => (m.kind === "text" ? m.text : recipe(m.recipeId)?.title || "Meal");

  const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const parseDate = (iso) => {
    const [y, m, d] = iso.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d));
  };
  const fmtDay = (iso) => {
    const d = parseDate(iso);
    return `${DAY_NAMES[d.getUTCDay()]}, ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
  };
  const fmtShort = (iso) => {
    const d = parseDate(iso);
    return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
  };
  const weekday = (iso) => DAY_NAMES[parseDate(iso).getUTCDay()];
  const addDays = (iso, n) => {
    const d = parseDate(iso);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  };
  const isPast = (iso) => iso < F.TODAY;
  const kcal = (n) => `${n.toLocaleString("en-US")}\u00a0kcal`;

  // Pantry item matching an ingredient name, loosely, or null.
  const onHand = (name) => {
    const n = name.toLowerCase();
    return (
      S.data.pantry.find((p) => {
        const pn = p.name.toLowerCase();
        return pn === n || pn.includes(n) || n.includes(pn);
      }) || null
    );
  };

  const dayTotals = (day) =>
    S.data.members.map((m) => {
      const total = day.meals.reduce(
        (sum, meal) => sum + meal.fit.filter((f) => f.memberId === m.id).reduce((a, f) => a + f.kcal, 0),
        0
      );
      return { member: m, total, target: m.target };
    });

  // ---------- Router ----------

  const routes = [];
  const actions = {};

  const route = (pattern, def) => routes.push({ pattern, parts: pattern.split("/"), ...def });

  const parseHash = () => {
    const hash = location.hash.replace(/^#\/?/, "");
    const [path, query = ""] = hash.split("?");
    const params = Object.fromEntries(new URLSearchParams(query));
    return { path: path || "plan", query: params };
  };

  const match = (path) => {
    const parts = path.split("/");
    for (const r of routes) {
      if (r.parts.length !== parts.length) continue;
      const params = {};
      const ok = r.parts.every((p, i) => {
        if (p.startsWith(":")) {
          params[p.slice(1)] = decodeURIComponent(parts[i]);
          return true;
        }
        return p === parts[i];
      });
      if (ok) return { route: r, params };
    }
    return null;
  };

  // Review settings ride in the hash query so every state has its own address.
  const current = () => parseHash();
  const reviewState = () => current().query.state || "ready";
  const phase = () => Number(current().query.phase || 2);

  const hrefFor = (path, extra = {}) => {
    const q = { ...current().query, ...extra };
    for (const k of Object.keys(q)) if (q[k] === null || q[k] === "" || q[k] === undefined) delete q[k];
    if (q.state === "ready") delete q.state;
    if (q.phase === "2" || q.phase === 2) delete q.phase;
    const qs = new URLSearchParams(q).toString();
    return `#/${path}${qs ? `?${qs}` : ""}`;
  };

  const go = (path, extra) => {
    const next = hrefFor(path, extra);
    if (location.hash === next) render();
    else location.hash = next;
  };

  // ---------- Shell ----------

  const AREAS = [
    { value: "plan", label: "Plan" },
    { value: "list", label: "Shopping list" },
    { value: "pantry", label: "Pantry" },
    { value: "household", label: "Household" },
    { value: "log", label: "Log" }
  ];

  const NAV = [
    {
      items: [
        { label: "Today", icon: "house" },
        { label: "Tasks", icon: "check-square" },
        { label: "Calendar", icon: "calendar-days" }
      ]
    },
    {
      label: "Modules",
      items: [
        { label: "Meals", icon: "utensils", active: true },
        { label: "Finance", icon: "landmark" },
        { label: "News", icon: "newspaper" },
        { label: "Wellness", icon: "heart-pulse" }
      ]
    }
  ];

  const renderShell = () => {
    document.getElementById("shell-nav").innerHTML = part(
      NAV.map(
        (group) => h`
        <div class="nav-group">
          ${group.label ? h`<p class="nav-group__label">${group.label}</p>` : ""}
          ${group.items.map(
            (item) =>
              h`<a class="module-link${item.active ? " active" : ""}" href="${item.active ? hrefFor("plan") : "#"}"${item.active ? raw(' aria-current="page"') : raw(' data-action="shell-elsewhere"')}>${icon(item.icon, 17)}<span class="module-link__label">${item.label}</span></a>`
          )}
        </div>`
      )
    );
    document.getElementById("open-nav").innerHTML = part(icon("menu", 20));
    document.getElementById("chat-button").innerHTML = part(icon("message-square", 19));
    document.getElementById("settings-cog").innerHTML = part(icon("settings", 16));
  };

  const areaTabs = (area) => h`
    <div class="mls-tabs">
      ${segmented(AREAS, area, { label: "Meals areas", action: "area" })}
    </div>`;

  // A page is the area tabs plus the screen body.
  const page = (area, body) => h`<div class="mls-page">${areaTabs(area)}${body}</div>`;

  // ---------- Toasts ----------

  let toastTimer = null;
  const toast = (msg, o = {}) => {
    const root = document.getElementById("toast-root");
    root.innerHTML = part(h`
      <div class="jds-toast jds-toast--${o.tone || "ready"}" role="status">
        <span class="jds-toast__icon">${icon(o.icon || "check", 18)}</span>
        <div class="jds-toast__body">
          ${o.title ? h`<div class="jds-toast__title">${o.title}</div>` : ""}
          <div class="jds-toast__msg">${msg}</div>
        </div>
        ${o.undo ? btn("Undo", { variant: "quiet", size: "sm", action: o.undo }) : ""}
      </div>`);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      root.innerHTML = "";
    }, o.ms || 4200);
  };

  // ---------- Plan writing simulation ----------

  const TICK_MS = 700;

  // Start writing the given dates in order. Each tick reveals one meal.
  const startWriting = (dates, o = {}) => {
    clearTimeout(S.timer);
    S.writingQueue = dates.slice();
    for (const date of dates) {
      S.writing[date] = { shown: 0 };
      delete S.failed[date];
    }
    S.stopped = [];
    S.writeOptions = o;
    scheduleTick();
  };

  const writingNow = () => S.writingQueue[0] || null;
  const isWriting = () => S.writingQueue.length > 0;

  const scheduleTick = () => {
    clearTimeout(S.timer);
    if (!isWriting()) return;
    S.timer = setTimeout(tick, TICK_MS);
  };

  const tick = () => {
    const date = writingNow();
    if (!date) return;
    const day = findDay(date);
    const state = S.writing[date];
    if (!day || !state) return;
    if (S.writeOptions?.failDate === date && state.shown >= 2) {
      // Canned failure for the failed-day review state.
      S.failed[date] = true;
      delete S.writing[date];
      S.writingQueue.shift();
      S.writeOptions.failDate = null;
    } else {
      state.shown += 1;
      S.newMealId = day.meals[state.shown - 1]?.id || null;
      if (state.shown >= day.meals.length) {
        delete S.writing[date];
        S.writingQueue.shift();
      }
    }
    if (!isWriting()) {
      S.newMealId = null;
      const failedCount = Object.keys(S.failed).length;
      if (S.writeOptions?.done) S.writeOptions.done();
      else if (failedCount)
        toast("One day could not be written. Retry it from the day.", { tone: "error", icon: "circle-alert" });
      else toast("Plan ready.", { title: "Moss finished the week" });
    }
    render();
    scheduleTick();
  };

  // Review tool: finish the day being written now.
  const finishCurrentDay = () => {
    const date = writingNow();
    if (!date) return;
    const day = findDay(date);
    S.writing[date].shown = day.meals.length - 1;
    tick();
  };

  const stopWriting = () => {
    clearTimeout(S.timer);
    S.stopped = S.writingQueue.slice();
    for (const date of S.writingQueue) delete S.writing[date];
    S.writingQueue = [];
    S.newMealId = null;
  };

  // ---------- Review tools ----------

  const STATES = [
    { value: "ready", label: "Filled in" },
    { value: "empty", label: "Empty" },
    { value: "loading", label: "Loading" },
    { value: "error", label: "Failed to load" },
    { value: "ai-off", label: "AI unavailable" },
    { value: "long", label: "Long text" }
  ];

  const PHASES = [
    { value: "2", label: "Phase 2: core planning" },
    { value: "3", label: "Phase 3: Pantry smarts (later)" },
    { value: "4", label: "Phase 4: learning and money (later)" },
    { value: "5", label: "Phase 5: sharing (later)" }
  ];

  const THEMES = [
    { value: "", label: "Park Press" },
    { value: "sage", label: "Sage" },
    { value: "teal", label: "Teal" },
    { value: "canyon", label: "Canyon" },
    { value: "dusk", label: "Dusk" },
    { value: "dark", label: "Dark" }
  ];

  // Every reviewable address. The click-through test walks this list.
  const reviewRoutes = () => routes.filter((r) => r.sample).map((r) => ({ path: r.sample, label: r.label, phase: r.phase || 2 }));

  const renderReview = () => {
    const el = document.getElementById("review");
    if (current().query.embed) {
      el.hidden = true;
      return;
    }
    el.hidden = false;
    el.dataset.collapsed = String(S.review.collapsed);
    const { path, query } = current();
    const matched = match(path);
    const later = matched && matched.route.phase && matched.route.phase > 2;
    if (S.review.collapsed) {
      el.innerHTML = part(btn("Review tools", { variant: "quiet", size: "sm", icon: "chevron-left", action: "review-toggle" }));
      return;
    }
    const screens = reviewRoutes();
    el.innerHTML = part(h`
      <div class="mls-review__body">
        <div class="mls-row mls-row--between">
          ${eyebrow("Review tools, not product UI", "gold")}
          ${iconBtn("x", "Hide review tools", { action: "review-toggle" })}
        </div>
        ${field("Screen", select(screens.map((s) => ({ value: s.path, label: s.label })), screens.some((s) => s.path === path) ? path : "", { id: "rv-screen", action: "review-screen" }), { id: "rv-screen" })}
        ${later ? badge(`Later: phase ${matched.route.phase}`, "amber") : ""}
        ${field("State", select(STATES, query.state || "ready", { id: "rv-state", action: "review-state" }), { id: "rv-state" })}
        ${field("Features", select(PHASES, String(query.phase || 2), { id: "rv-phase", action: "review-phase" }), { id: "rv-phase" })}
        ${field("Theme", select(THEMES, query.theme || "", { id: "rv-theme", action: "review-theme" }), { id: "rv-theme" })}
        <div class="mls-row">
          ${btn("Phone view", { size: "sm", icon: "smartphone", action: "review-phone" })}
          ${btn("Next event", { size: "sm", icon: "zap", action: "review-next", disabled: !isWriting(), title: "Finish the day being written now" })}
        </div>
      </div>`);
  };

  const renderPhone = () => {
    const root = document.getElementById("phone-root");
    if (!S.phone || current().query.embed) {
      root.innerHTML = "";
      return;
    }
    const src = `index.html${hrefFor(current().path, { embed: "1" })}`;
    root.innerHTML = part(h`
      <div class="mls-phone" role="dialog" aria-label="Phone view">
        <div class="mls-stack mls-stack--tight">
          <div class="mls-row mls-row--between">
            ${eyebrow("Phone view, 390 px", "gold")}
            ${btn("Close phone view", { size: "sm", variant: "quiet", icon: "x", action: "review-phone" })}
          </div>
          <iframe class="mls-phone__frame" title="Meals at phone width" src="${src}"></iframe>
        </div>
      </div>`);
  };

  // ---------- Render ----------

  let lastPath = null;

  const render = () => {
    const { path, query } = current();
    document.documentElement.dataset.theme = query.theme || "";
    if (!query.theme) delete document.documentElement.dataset.theme;
    const found = match(path) || match("plan");
    const { route: r, params } = found;
    if (r.enter && lastPath !== path) r.enter(params);
    const main = document.getElementById("main");
    const pageRoute = r.page ? match(r.page(params)) : null;
    const host = pageRoute || found;
    main.innerHTML = part(host.route.render(host.params, query));
    const dialogRoot = document.getElementById("dialog-root");
    dialogRoot.innerHTML = r.dialog ? part(r.dialog(params, query)) : "";
    if (lastPath !== path) {
      if (r.dialog) dialogRoot.querySelector(".jds-dialog")?.focus();
      else window.scrollTo(0, 0);
    }
    lastPath = path;
    renderReview();
    renderPhone();
  };

  const closeDialog = () => {
    const { path } = current();
    const r = match(path);
    if (r && r.route.page) go(r.route.page(r.params));
  };

  // ---------- Events ----------

  const closeMenus = (except) => {
    document.querySelectorAll("[data-menu-panel]:not([hidden])").forEach((panel) => {
      if (panel === except) return;
      panel.hidden = true;
      panel.parentElement.querySelector("[data-menu-trigger]")?.setAttribute("aria-expanded", "false");
    });
  };

  document.addEventListener("click", (event) => {
    const trigger = event.target.closest("[data-menu-trigger]");
    if (trigger) {
      const panel = trigger.parentElement.querySelector("[data-menu-panel]");
      const open = panel.hidden;
      closeMenus(panel);
      panel.hidden = !open;
      trigger.setAttribute("aria-expanded", String(open));
      if (open) panel.querySelector("button:not([disabled])")?.focus();
      return;
    }
    if (!event.target.closest(".jds-menu__list")) closeMenus();
    if (event.target.matches("[data-dialog-scrim]")) {
      closeDialog();
      return;
    }
    const el = event.target.closest("[data-action]");
    if (!el || el.tagName === "SELECT" || (el.tagName === "INPUT" && el.type !== "button")) return;
    const fn = actions[el.dataset.action];
    if (!fn) return;
    event.preventDefault();
    if (el.closest(".jds-menu__list")) closeMenus();
    fn(el, event);
  });

  document.addEventListener("change", (event) => {
    const el = event.target.closest("[data-action]");
    if (!el) return;
    const fn = actions[el.dataset.action];
    if (fn) fn(el, event);
  });

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (document.querySelector("[data-menu-panel]:not([hidden])")) {
      closeMenus();
      return;
    }
    if (S.phone) {
      S.phone = false;
      renderPhone();
      return;
    }
    if (document.querySelector("#dialog-root .jds-dialog")) closeDialog();
  });

  // The long-text data is built at load, so entering or leaving that state reloads.
  const loadedLong = reviewState() === "long";
  window.addEventListener("hashchange", () => {
    if ((reviewState() === "long") !== loadedLong) location.reload();
    else render();
  });

  // ---------- Core actions ----------

  Object.assign(actions, {
    area: (el) => go(el.dataset.value),
    "close-dialog": () => closeDialog(),
    go: (el) => go(el.dataset.to),
    "shell-elsewhere": () => toast("Other modules are outside this prototype.", { icon: "info", tone: "drift" }),
    "review-toggle": () => {
      S.review.collapsed = !S.review.collapsed;
      renderReview();
    },
    "review-screen": (el) => {
      const target = reviewRoutes().find((s) => s.path === el.value);
      if (target) go(target.path, target.phase > 2 && phase() < target.phase ? { phase: String(target.phase) } : {});
    },
    "review-state": (el) => go(current().path, { state: el.value }),
    "review-phase": (el) => go(current().path, { phase: el.value }),
    "review-theme": (el) => go(current().path, { theme: el.value }),
    "review-phone": () => {
      S.phone = !S.phone;
      renderPhone();
    },
    "review-next": () => finishCurrentDay()
  });

  // The shell renders the scrim only while the drawer is open.
  document.getElementById("open-nav").addEventListener("click", () => {
    document.getElementById("moss-main-navigation").classList.add("open");
    const scrim = document.createElement("div");
    scrim.className = "sidebar-scrim";
    scrim.setAttribute("aria-hidden", "true");
    scrim.addEventListener("click", () => {
      document.getElementById("moss-main-navigation").classList.remove("open");
      scrim.remove();
    });
    document.getElementById("moss-main-navigation").after(scrim);
  });
  document.getElementById("chat-button").addEventListener("click", () =>
    toast("Chat runs the same Meals actions. It is outside this prototype.", { icon: "message-square", tone: "drift" })
  );

  // A number stays with the unit or word after it, and × with the number after it: "3 lb", "2 × 1 lb", "1½ cups".
  const keepUnit = (text) =>
    String(text)
      .replace(/(\d[\d.,/¼½¾⅓⅔⅛⅜⅝⅞]*) (?=\S)/g, "$1\u00a0")
      .replace(/× (?=\d)/g, "×\u00a0");

  // ---------- Public surface for screen files ----------

  window.MEALS_APP = {
    keepUnit,
    F,
    S,
    h,
    raw,
    esc,
    part,
    attrs,
    icon,
    btn,
    iconBtn,
    badge,
    eyebrow,
    caption,
    masthead,
    sectionHead,
    segmented,
    empty,
    loading,
    recovery,
    field,
    input,
    textarea,
    select,
    check,
    toggle,
    radioCards,
    chip,
    removableChip,
    menu,
    dialog,
    stepper,
    typing,
    toast,
    activePlan,
    allDays,
    findDay,
    member,
    names,
    recipe,
    allMeals,
    findMeal,
    mealTitle,
    fmtDay,
    fmtShort,
    weekday,
    addDays,
    isPast,
    kcal,
    onHand,
    dayTotals,
    route,
    actions,
    go,
    hrefFor,
    current,
    reviewState,
    phase,
    page,
    render,
    closeDialog,
    startWriting,
    stopWriting,
    isWriting,
    writingNow,
    reviewRoutes
  };

  // Screens register on load; render once every deferred script has run.
  document.addEventListener("DOMContentLoaded", () => {
    renderShell();
    if (!location.hash) history.replaceState(null, "", "#/plan");
    render();
  });
})();
