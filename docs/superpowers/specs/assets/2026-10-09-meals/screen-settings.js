// Settings: units, the default Pantry mode, which model each task uses, and phase 5 reminders and drafts.
/* global window */

(function () {
  const A = window.MEALS_APP;
  const { F, S, h, btn, eyebrow, caption, sectionHead, segmented, radioCards, toggle, select, field } = A;
  const { loading, recovery } = A;

  S.reminders = { defrost: true, startDinner: false };
  S.weeklyDraft = { on: false, day: "Sunday" };

  const UNITS = [
    { value: "us", label: "US" },
    { value: "metric", label: "Metric" }
  ];
  const DRAFT_DAYS = ["Friday", "Saturday", "Sunday"];

  // Next occurrence of a weekday after today, for the draft caption.
  const nextDraft = (day) => {
    const want = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"].indexOf(day);
    for (let n = 1; n <= 7; n += 1) {
      const iso = A.addDays(F.TODAY, n);
      if (new Date(`${iso}T00:00:00Z`).getUTCDay() === want) return A.fmtDay(iso);
    }
    return "";
  };

  // ---------- Sections ----------

  const unitsView = () => h`
    <section class="mls-stack mls-stack--tight" aria-labelledby="st-units">
      <div id="st-units">${sectionHead({ title: "Units", rule: true })}</div>
      <div>${segmented(UNITS, S.units, { label: "Units", action: "st-units" })}</div>
    </section>`;

  const pantryView = () => h`
    <section class="mls-stack mls-stack--tight" aria-labelledby="st-pantry">
      <div id="st-pantry">${sectionHead({ title: "Pantry mode for new plans", rule: true })}</div>
      ${radioCards("st-mode", A.plan.PANTRY_MODES, S.pantryModeDefault, { label: "Pantry mode for new plans", action: "st-mode" })}
    </section>`;

  const remindersView = () => h`
    <section class="mls-stack mls-stack--tight" aria-labelledby="st-reminders">
      <div id="st-reminders">${sectionHead({ title: "Reminders", rule: true })}</div>
      <div class="mls-stack mls-stack--tight">
        ${toggle("Defrost the night before", S.reminders.defrost, { action: "st-reminder", data: { key: "defrost" } })}
        ${toggle("Time to start dinner", S.reminders.startDinner, { action: "st-reminder", data: { key: "startDinner" } })}
      </div>
    </section>`;

  const draftView = () => {
    const d = S.weeklyDraft;
    return h`
      <section class="mls-stack mls-stack--tight" aria-labelledby="st-draft">
        <div id="st-draft">${sectionHead({ title: "Weekly draft", rule: true })}</div>
        ${toggle("Draft next week's plan", d.on, { action: "st-draft" })}
        ${
          d.on
            ? h`<div class="mls-row mls-row--baseline">
                ${field("Day", select(DRAFT_DAYS, d.day, { id: "st-draft-day", action: "st-draft-day" }), { id: "st-draft-day" })}
                ${caption(`Next draft ${nextDraft(d.day)}`)}
              </div>`
            : ""
        }
      </section>`;
  };

  const modelsRail = () => h`
    <aside class="mls-rail">
      <section class="mls-stack mls-stack--tight">
        ${eyebrow("Models")}
        ${A.reviewState() === "ai-off" ? recovery({ title: "Moss can't reach a model right now", msg: "Plans, estimates and photos wait until it's back.", role: "status" }) : ""}
        <ul class="mls-list mls-stack mls-stack--tight" role="list">
          ${F.models.map(
            (m) => h`
              <li class="mls-stack mls-stack--tiny">
                <span>${m.task}</span>
                ${caption(`${m.tier} · ${m.model}`)}
              </li>`
          )}
        </ul>
        <div class="mls-row">${btn("Open AI settings", { variant: "link", size: "sm", action: "shell-elsewhere" })}</div>
      </section>
    </aside>`;

  // ---------- Page ----------

  const renderSettings = () => {
    const state = A.reviewState();
    if (state === "loading") return A.page("settings", loading("Loading settings"));
    if (state === "error")
      return A.page(
        "settings",
        recovery({
          title: "Couldn't load settings",
          msg: "Check the connection, then try again.",
          actions: btn("Try again", { size: "sm", icon: "refresh-cw", href: A.hrefFor("settings", { state: "ready" }) })
        })
      );

    return A.page(
      "settings",
      h`
      <div class="mls-stack">
        ${A.masthead({ title: "Settings", tone: "default", compact: true })}
        <div class="mls-grid">
          <div class="mls-stack mls-stack--loose">
            ${unitsView()}
            ${pantryView()}
            ${A.phase() >= 5 ? remindersView() : ""}
            ${A.phase() >= 5 ? draftView() : ""}
          </div>
          ${modelsRail()}
        </div>
      </div>`
    );
  };

  // ---------- Routes ----------

  A.route("settings", { render: renderSettings, sample: "settings", label: "Settings" });

  // ---------- Actions ----------

  Object.assign(A.actions, {
    "st-units": (el) => {
      S.units = el.dataset.value;
      A.render();
    },
    "st-mode": (el) => {
      S.pantryModeDefault = el.value;
      S.newPlan.mode = el.value;
      A.render();
    },
    "st-reminder": (el) => {
      S.reminders[el.dataset.key] = el.checked;
    },
    "st-draft": (el) => {
      S.weeklyDraft.on = el.checked;
      A.render();
    },
    "st-draft-day": (el) => {
      S.weeklyDraft.day = el.value;
      A.render();
    }
  });
})();
