// Log: one day of what I ate, with totals against my targets, quick add and corrections.
/* global window, document */

(function () {
  const A = window.MEALS_APP;
  const { F, S, h, btn, iconBtn, badge, eyebrow, caption } = A;
  const { empty, loading, recovery, field, input, dialog, typing } = A;

  S.logDay = F.TODAY;

  // Earlier days are canned so the date arrows have something to show.
  const EARLIER = {
    "2026-11-03": [
      { id: "y1", time: "7:30 AM", text: "Huevos rancheros", kcal: 560, protein: 28, carbs: 48, fat: 26, status: "estimated" },
      { id: "y2", time: "12:50 PM", text: "Chicken burrito bowl", kcal: 640, protein: 48, carbs: 70, fat: 16, status: "estimated" },
      { id: "y3", time: "7:20 PM", text: "Black bean tacos, three", kcal: 780, protein: 30, carbs: 92, fat: 30, status: "estimated" },
      { id: "y4", time: "9:00 PM", text: "Square of dark chocolate", kcal: 60, protein: 1, carbs: 5, fat: 4, status: "corrected" }
    ],
    "2026-11-02": [
      { id: "z1", time: "8:10 AM", text: "Overnight oats with berries", kcal: 420, protein: 14, carbs: 62, fat: 12, status: "estimated" },
      { id: "z2", time: "7:05 PM", text: "Lemon chicken traybake", kcal: 720, protein: 54, carbs: 40, fat: 34, status: "estimated" }
    ]
  };

  const WEEK = [
    { date: "2026-11-02", label: "Mon" },
    { date: "2026-11-03", label: "Tue" },
    { date: "2026-11-04", label: "Wed" }
  ];

  const aiOff = () => A.reviewState() === "ai-off";
  const isToday = () => S.logDay === F.TODAY;
  const entriesFor = (day) => (day === F.TODAY ? S.data.log.entries : EARLIER[day] || []);
  const findEntry = (id) => [...S.data.log.entries, ...Object.values(EARLIER).flat()].find((e) => e.id === id);

  const totals = (entries) =>
    entries.reduce(
      (t, e) => ({
        kcal: t.kcal + (e.kcal || 0),
        protein: t.protein + (e.protein || 0),
        carbs: t.carbs + (e.carbs || 0),
        fat: t.fat + (e.fat || 0)
      }),
      { kcal: 0, protein: 0, carbs: 0, fat: 0 }
    );

  // ---------- Pieces ----------

  const dateBar = () => h`
    <div class="mls-planbar">
      <div class="mls-datebar">
        ${iconBtn("chevron-left", "Previous day", { action: "log-day", data: { step: -1 }, secondary: true, size: "md" })}
        <h2 class="jds-card-title">${isToday() ? `Today, ${A.fmtShort(S.logDay)}` : A.fmtDay(S.logDay)}</h2>
        ${iconBtn("chevron-right", "Next day", { action: "log-day", data: { step: 1 }, secondary: true, size: "md", disabled: isToday() })}
        ${isToday() ? "" : btn("Today", { size: "sm", variant: "quiet", action: "log-today" })}
      </div>
      ${A.phase() >= 5 ? badge("Only you see this", "neutral", { icon: "lock" }) : ""}
    </div>`;

  const meter = (label, value, target, unit) => {
    const pct = target ? Math.min(100, Math.round((value / target) * 100)) : 0;
    return h`
      <div class="mls-stack mls-stack--tiny">
        ${eyebrow(label)}
        <span class="mls-num mls-num--lg">${value.toLocaleString("en-US")}${unit ? h`<span class="jds-caption">\u00a0${unit}</span>` : ""}</span>
        <div class="jds-progress" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100" aria-label="${label} against target">
          <div class="jds-progress__fill" style="width: ${pct}%"></div>
        </div>
        ${caption(`of ${target.toLocaleString("en-US")}${unit ? `\u00a0${unit}` : ""}`)}
      </div>`;
  };

  const totalsView = (entries) => {
    const t = totals(entries);
    const g = F.log.targets;
    return h`
      <section class="mls-totals" aria-label="Totals">
        ${meter("Calories", t.kcal, g.calories, "kcal")}
        ${meter("Protein", t.protein, g.protein, "g")}
        ${meter("Carbs", t.carbs, g.carbs, "g")}
        ${meter("Fat", t.fat, g.fat, "g")}
      </section>`;
  };

  const statusView = (e) => {
    if (e.status === "estimating") return h`<span class="mls-row" role="status">${typing()}${caption("Estimating")}</span>`;
    if (e.status === "waiting") return caption("Estimated when Moss is back");
    if (e.status === "corrected") return caption("Corrected");
    return caption("Estimated");
  };

  const entryView = (e) => h`
    <li class="mls-entry">
      <span class="jds-caption">${e.time}</span>
      <span class="mls-line__body">
        <span class="mls-line__name">${e.text}</span>
        ${statusView(e)}
      </span>
      <span class="mls-line__amount">
        ${e.kcal == null ? caption("No estimate yet") : h`<span class="mls-num">${A.kcal(e.kcal)}</span>${caption(`${e.protein}\u00a0g protein · ${e.carbs}\u00a0g carbs · ${e.fat}\u00a0g fat`)}`}
      </span>
      <span class="mls-line__tools">${iconBtn("pencil", `Correct ${e.text}`, { href: A.hrefFor(`log/edit/${e.id}`), disabled: e.status === "estimating" })}</span>
    </li>`;

  const quickAdd = () => h`
    <div class="mls-inline-add">
      ${input({ id: "lg-text", placeholder: "Two eggs on toast", ariaLabel: "What did you eat?" })}
      ${btn("Log it", { variant: "primary", icon: "plus", action: "log-add" })}
    </div>`;

  const rail = () => {
    const g = F.log.targets;
    return h`
      <aside class="mls-rail">
        <section class="mls-stack mls-stack--tight">
          ${eyebrow("This week")}
          <ul class="mls-list mls-stack mls-stack--tight" role="list">
            ${WEEK.map((d) => {
              const kcal = totals(entriesFor(d.date)).kcal;
              return h`<li class="mls-row mls-row--between">
                ${d.date === S.logDay ? h`<span class="jds-label" aria-current="date">${d.label}</span>` : btn(d.label, { variant: "link", size: "sm", action: "log-goto", data: { date: d.date } })}
                ${caption(kcal ? `${kcal.toLocaleString("en-US")} of ${g.calories.toLocaleString("en-US")}` : "Nothing logged")}
              </li>`;
            })}
          </ul>
        </section>
        <section class="mls-stack mls-stack--tight">
          ${eyebrow("Targets")}
          <dl class="mls-list mls-stack mls-stack--tiny">
            ${[
              ["Calories", A.kcal(g.calories)],
              ["Protein", `${g.protein}\u00a0g`],
              ["Carbs", `${g.carbs}\u00a0g`],
              ["Fat", `${g.fat}\u00a0g`]
            ].map(([k, v]) => h`<div class="mls-row mls-row--between"><dt class="jds-caption">${k}</dt><dd class="mls-num">${v}</dd></div>`)}
          </dl>
          ${btn("Change targets", { variant: "link", size: "sm", href: A.hrefFor("household/member/m-rowan") })}
        </section>
      </aside>`;
  };

  // ---------- Page ----------

  const renderLog = () => {
    const state = A.reviewState();
    if (state === "loading") return A.page("log", loading("Loading your log"));
    if (state === "error")
      return A.page(
        "log",
        recovery({
          title: "Couldn't load your log",
          msg: "Check the connection, then try again.",
          actions: btn("Try again", { size: "sm", icon: "refresh-cw", href: A.hrefFor("log", { state: "ready" }) })
        })
      );

    const entries = state === "empty" ? [] : entriesFor(S.logDay);
    return A.page(
      "log",
      h`
      ${dateBar()}
      <div class="mls-grid">
        <div class="mls-stack">
          ${aiOff() ? recovery({ title: "Moss can't estimate calories right now", msg: "Entries are kept and estimated when it's back.", role: "status" }) : ""}
          ${entries.length ? totalsView(entries) : ""}
          ${isToday() ? quickAdd() : ""}
          ${
            entries.length
              ? h`<ul class="mls-list" role="list">${entries.map(entryView)}</ul>`
              : empty({ icon: "notebook-pen", title: "Nothing logged" })
          }
        </div>
        ${rail()}
      </div>`
    );
  };

  // ---------- Correction dialog ----------

  const editDialog = ({ entryId }) => {
    const e = findEntry(entryId);
    if (!e)
      return dialog({
        title: "Entry not found",
        body: caption("It may have been deleted."),
        foot: btn("Close", { action: "close-dialog" })
      });
    return dialog({
      title: "Correct an entry",
      body: h`
        <div class="mls-form">
          ${field("What you ate", input({ id: "le-text", value: e.text }), { id: "le-text" })}
          <div class="mls-form-grid">
            ${field("Time", input({ id: "le-time", value: e.time }), { id: "le-time" })}
            ${field("Calories", input({ id: "le-kcal", value: e.kcal ?? "", num: true, inputmode: "numeric" }), { id: "le-kcal" })}
          </div>
          <div class="mls-form-grid mls-form-grid--3">
            ${field("Protein, g", input({ id: "le-protein", value: e.protein ?? "", num: true, inputmode: "numeric" }), { id: "le-protein" })}
            ${field("Carbs, g", input({ id: "le-carbs", value: e.carbs ?? "", num: true, inputmode: "numeric" }), { id: "le-carbs" })}
            ${field("Fat, g", input({ id: "le-fat", value: e.fat ?? "", num: true, inputmode: "numeric" }), { id: "le-fat" })}
          </div>
        </div>`,
      foot: h`
        <span class="mls-foot-start">${btn("Delete", { variant: "quiet", icon: "trash-2", action: "log-delete", data: { entry: e.id } })}</span>
        ${btn("Cancel", { action: "close-dialog" })}
        ${btn("Save", { variant: "primary", action: "log-save", data: { entry: e.id } })}`
    });
  };

  // ---------- Routes ----------

  A.route("log", { render: renderLog, sample: "log", label: "Log" });
  A.route("log/edit/:entryId", { page: () => "log", dialog: editDialog, sample: "log/edit/e3", label: "Log: correct an entry" });

  // ---------- Actions ----------

  const value = (id) => document.getElementById(id)?.value.trim() || "";
  const num = (id) => {
    const n = Number(value(id));
    return value(id) && Number.isFinite(n) ? n : null;
  };

  const shiftDay = (iso, n) => {
    const d = new Date(`${iso}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  };

  Object.assign(A.actions, {
    "log-day": (el) => {
      const next = shiftDay(S.logDay, Number(el.dataset.step));
      if (next > F.TODAY) return;
      S.logDay = next;
      A.render();
    },
    "log-today": () => {
      S.logDay = F.TODAY;
      A.render();
    },
    "log-goto": (el) => {
      S.logDay = el.dataset.date;
      A.render();
    },
    "log-add": () => {
      const text = value("lg-text");
      if (!text) return document.getElementById("lg-text").focus();
      const entry = { id: `e-${Date.now()}`, time: "Now", text, kcal: null, protein: null, carbs: null, fat: null, status: aiOff() ? "waiting" : "estimating" };
      S.data.log.entries.push(entry);
      A.render();
      if (aiOff()) return;
      setTimeout(() => {
        Object.assign(entry, { kcal: 310, protein: 18, carbs: 26, fat: 14, status: "estimated" });
        A.render();
      }, 1600);
    },
    "log-save": (el) => {
      const e = findEntry(el.dataset.entry);
      Object.assign(e, {
        text: value("le-text") || e.text,
        time: value("le-time") || e.time,
        kcal: num("le-kcal"),
        protein: num("le-protein"),
        carbs: num("le-carbs"),
        fat: num("le-fat"),
        status: "corrected"
      });
      A.go("log");
    },
    "log-delete": (el) => {
      const e = findEntry(el.dataset.entry);
      const list = [S.data.log.entries, ...Object.values(EARLIER)].find((l) => l.includes(e));
      list.splice(list.indexOf(e), 1);
      A.toast(`${e.text} deleted.`, { icon: "trash-2", tone: "drift" });
      A.go("log");
    }
  });
})();
