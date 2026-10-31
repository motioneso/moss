// Household: first-run setup, people, Shared or Solo rules, Favourites, and the phase 4 and 5 views.
/* global window, document */

(function () {
  const A = window.MEALS_APP;
  const { F, S, h, btn, iconBtn, badge, eyebrow, caption, sectionHead, segmented } = A;
  const { loading, recovery, field, input, check, chip, removableChip, dialog, typing } = A;

  const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const COMMON_MEALS = ["Breakfast", "Lunch", "Dinner", "Snack"];

  S.setup = { mode: "household", names: ["Ben", "Maya"] };
  S.ruleOpen = null;
  S.memberDraft = null;
  S.memberUndo = null;
  S.learned = structuredClone(F.later.learned);
  S.importReading = false;
  S.importFor = ["m-ben"];
  S.kitchen = { ...F.later.kitchen, joined: false, copy: ["pi1", "pi2", "pi6"] };
  S.inviteStep = "ask";

  const members = () => S.data.members;
  const together = () => members().length > 1;

  // ---------- Facts ----------

  const ruleText = (r) => {
    if (r.rule === "shared") return "Shared every day";
    const days = r.soloDays;
    if (days.length === 7) return "Solo every day";
    if (days.join() === "Mon,Tue,Wed,Thu,Fri") return "Solo on weekdays, shared at weekends";
    if (!days.length) return "Shared every day";
    return `Solo on ${days.join(", ")}`;
  };

  const targetsText = (m) => {
    if (!m.target) return "";
    const macros = m.isSelf ? F.log.targets : null;
    const kcal = A.kcal(m.target);
    return macros ? `${kcal} · ${macros.protein} g protein · ${macros.carbs} g carbs · ${macros.fat} g fat` : kcal;
  };

  const accountView = (m) => {
    if (m.isSelf) return "You";
    if (!m.linkedAccount) return caption("Not linked");
    if (A.phase() >= 5 && !S.kitchen.joined) return h`<span class="mls-row">${m.linkedAccount}${badge("Invite sent", "amber", { icon: "mail" })}</span>`;
    return m.linkedAccount;
  };

  const memberView = (m) => h`
    <li class="mls-member">
      <span class="jds-avatar" aria-hidden="true">${m.name.slice(0, 1)}</span>
      <div class="mls-stack mls-stack--tight">
        <div class="mls-row">
          <h3 class="jds-card-title">${m.name}</h3>
          ${m.isSelf ? badge("You", "neutral") : ""}
        </div>
        <dl class="mls-facts">
          <dt class="jds-caption">Meals</dt>
          <dd>${m.pattern.join(", ") || caption("None")}</dd>
          <dt class="jds-caption">Never serve</dt>
          <dd>${m.restrictions.length ? h`<span class="mls-chips">${m.restrictions.map((r) => badge(r, "red"))}</span>` : caption("Nothing")}</dd>
          <dt class="jds-caption">Preferences</dt>
          <dd>${m.preferences.length ? m.preferences.join(", ") : caption("None yet")}</dd>
          <dt class="jds-caption">Daily target</dt>
          <dd>${targetsText(m) || caption("None")}</dd>
          <dt class="jds-caption">Moss account</dt>
          <dd>${accountView(m)}</dd>
        </dl>
        ${A.phase() >= 4 ? learnedView(m) : ""}
      </div>
      ${btn("Edit", { size: "sm", icon: "pencil", href: A.hrefFor(`household/member/${m.id}`) })}
    </li>`;

  // Phase 4: what Rating taught Moss, each line removable.
  const learnedView = (m) => {
    const lines = S.learned[m.id] || [];
    return h`
      <section class="mls-stack mls-stack--tiny" aria-label="What Moss learned about ${m.name}">
        ${eyebrow("What Moss learned")}
        ${
          lines.length
            ? h`<ul class="mls-list" role="list">
                ${lines.map(
                  (text, i) => h`
                    <li class="mls-line mls-line--plain mls-line--compact">
                      <span class="mls-line__body">${text}</span>
                      <span></span>
                      <span class="mls-line__tools">${iconBtn("x", "Forget this", { action: "hh-forget", data: { member: m.id, index: i } })}</span>
                    </li>`
                )}
              </ul>`
            : caption("Nothing yet.")
        }
      </section>`;
  };

  // ---------- Rules ----------

  const ruleView = (r) => {
    const open = S.ruleOpen === r.slot;
    const eaters = members().filter((m) => m.pattern.includes(r.slot));

    // Shared or Solo only means something when two or more people eat the meal.
    if (eaters.length < 2)
      return h`
        <li class="mls-rule">
          <span class="mls-line__name">${r.slot}</span>
          <span>${eaters.length ? `Only ${eaters[0].name}` : caption("Nobody eats this")}</span>
          <span></span>
        </li>`;
    return h`
      <li class="mls-rule">
        <span class="mls-line__name">${r.slot}</span>
        <span class="mls-stack mls-stack--tiny">
          <span>${ruleText(r)}</span>
          ${caption(A.names(eaters.map((m) => m.id)))}
        </span>
        ${
          open
            ? btn("Done", { size: "sm", variant: "primary", href: A.hrefFor("household") })
            : btn("Change", { size: "sm", href: A.hrefFor(`household/rule/${encodeURIComponent(r.slot)}`) })
        }
        ${
          open
            ? h`<div class="mls-rule__editor">
                ${segmented(
                  [
                    { value: "shared", label: "Shared" },
                    { value: "solo", label: "Solo" }
                  ],
                  r.rule,
                  { label: `${r.slot}: Shared or Solo`, action: "hh-rule", data: { slot: r.slot } }
                )}
                ${
                  r.rule === "solo"
                    ? h`<div class="mls-stack mls-stack--tiny">
                        ${eyebrow("Solo on")}
                        <div class="mls-chips" role="group" aria-label="Solo days">
                          ${WEEKDAYS.map((d) => chip(d, r.soloDays.includes(d), { action: "hh-rule-day", data: { slot: r.slot, day: d } }))}
                        </div>
                      </div>`
                    : ""
                }
              </div>`
            : ""
        }
      </li>`;
  };

  // ---------- Favourites ----------

  const favouritesView = () => h`
    <section class="mls-stack" aria-labelledby="hh-favs">
      <div id="hh-favs">
        ${sectionHead({
          number: together() ? "03" : "02",
          title: "Favourites",
          meta: A.phase() >= 4 ? btn("Import a recipe", { size: "sm", icon: "link-2", href: A.hrefFor("household/import") }) : "",
          rule: true
        })}
      </div>
      <div class="mls-columns">
        ${members().map((m) => {
          const favs = S.data.favourites[m.id] || [];
          return h`
            <section class="mls-stack mls-stack--tight" aria-label="${m.name}'s Favourites">
              ${eyebrow(m.name)}
              ${
                favs.length
                  ? h`<ul class="mls-list" role="list">
                      ${favs.map((rid, i) => {
                        const r = A.recipe(rid);
                        return h`
                          <li class="mls-line mls-line--plain">
                            <span class="mls-line__body">
                              <span class="mls-line__name">${r ? r.title : rid}</span>
                              ${A.phase() >= 4 ? caption(i % 2 ? "Not cooked in 6 weeks" : "Cooked last week") : ""}
                            </span>
                            <span></span>
                            <span class="mls-line__tools">${iconBtn("x", `Remove ${r ? r.title : rid} from ${m.name}'s Favourites`, { action: "hh-fav-remove", data: { member: m.id, recipe: rid } })}</span>
                          </li>`;
                      })}
                    </ul>`
                  : caption("No Favourites yet.")
              }
            </section>`;
        })}
      </div>
    </section>`;

  // ---------- Kitchen (phase 5) ----------

  const invitee = () => members().find((m) => m.linkedAccount === S.kitchen.invitePending);

  const kitchenRail = () => {
    if (A.phase() < 5) return "";
    const k = S.kitchen;
    return h`
      <section class="mls-stack mls-stack--tight">
        ${eyebrow("Kitchen")}
        <ul class="mls-list mls-stack mls-stack--tiny" role="list">
          <li class="mls-row mls-row--between"><span>${k.owner}</span>${caption("Owner")}</li>
          ${
            k.joined
              ? h`<li class="mls-row mls-row--between"><span>Maya</span>${caption("Member")}</li>`
              : h`<li class="mls-row mls-row--between"><span>${invitee()?.name || k.invitePending}</span>${badge("Invite sent", "amber", { icon: "mail" })}</li>`
          }
        </ul>
        <div class="mls-row">
          ${
            k.joined
              ? btn("Remove Maya", { size: "sm", variant: "quiet", icon: "x", action: "hh-kitchen-remove" })
              : btn("Cancel invite", { size: "sm", variant: "quiet", icon: "x", action: "hh-invite-cancel" })
          }
        </div>
      </section>`;
  };

  // ---------- Page ----------

  const rail = () => h`
    <aside class="mls-rail">
      <section class="mls-stack mls-stack--tight">
        ${eyebrow("At the table")}
        <ul class="mls-list mls-stack mls-stack--tiny" role="list">
          ${members().map((m) => h`<li class="mls-row mls-row--between"><span>${m.name}</span>${caption(`${m.pattern.length} meals a day`)}</li>`)}
        </ul>
        ${btn("Add a person", { size: "sm", icon: "user-plus", href: A.hrefFor("household/member/new") })}
      </section>
      ${kitchenRail()}
    </aside>`;

  const renderHousehold = () => {
    const state = A.reviewState();
    if (state === "loading") return A.page("household", loading("Loading the household"));
    if (state === "error")
      return A.page(
        "household",
        recovery({
          title: "Couldn't load the household",
          msg: "Check the connection, then try again.",
          actions: btn("Try again", { size: "sm", icon: "refresh-cw", href: A.hrefFor("household", { state: "ready" }) })
        })
      );
    if (state === "empty" || !members().length) return renderSetup();

    const rules = S.data.slotRules.filter((r) => members().some((m) => m.pattern.includes(r.slot)));
    return A.page(
      "household",
      h`
      <div class="mls-grid">
        <div class="mls-stack mls-stack--loose">
          <section class="mls-stack mls-stack--tight" aria-labelledby="hh-people">
            <div id="hh-people">${sectionHead({ number: "01", title: "People", meta: caption(String(members().length)), rule: true })}</div>
            <ul class="mls-list" role="list">${members().map(memberView)}</ul>
          </section>
          ${
            together()
              ? h`<section class="mls-stack mls-stack--tight" aria-labelledby="hh-rules">
                  <div id="hh-rules">${sectionHead({ number: "02", title: "Who eats together", rule: true })}</div>
                  <ul class="mls-list" role="list">${rules.map(ruleView)}</ul>
                </section>`
              : ""
          }
          ${favouritesView()}
        </div>
        ${rail()}
      </div>`
    );
  };

  // ---------- First-run setup ----------

  const renderSetup = () => {
    const s = S.setup;
    return A.page(
      "household",
      h`
      <div class="mls-setup mls-stack mls-stack--loose">
        ${sectionHead({ title: "Who's eating?", rule: true })}
        ${A.radioCards(
          "hh-mode",
          [
            { value: "solo", label: "Just me" },
            { value: "household", label: "Me and others" }
          ],
          s.mode,
          { action: "hh-setup-mode", label: "Who's eating" }
        )}
        <div class="mls-stack mls-stack--tight">
          ${field("Your name", input({ id: "hs-name-0", value: s.names[0], data: { setupName: 0 } }), { id: "hs-name-0" })}
          ${
            s.mode === "household"
              ? h`
                ${s.names.slice(1).map(
                  (n, i) => h`
                    <div class="jds-field">
                      <label class="jds-label" for="hs-name-${i + 1}">${i === 0 ? "Who else eats with you" : "And"}</label>
                      <div class="mls-inline-add">
                        ${input({ id: `hs-name-${i + 1}`, value: n, placeholder: "Name", data: { setupName: i + 1 } })}
                        ${iconBtn("x", `Remove ${n || "this person"}`, { action: "hh-setup-remove", data: { index: i + 1 } })}
                      </div>
                    </div>`
                )}
                <div class="mls-row">${btn("Add a person", { size: "sm", icon: "user-plus", action: "hh-setup-add" })}</div>`
              : ""
          }
        </div>
        <div class="mls-row">${btn("Continue", { variant: "primary", action: "hh-setup-done" })}</div>
      </div>`
    );
  };

  // ---------- Member dialog ----------

  const allMealNames = () => {
    const names = new Set(COMMON_MEALS);
    members().forEach((m) => m.pattern.forEach((p) => names.add(p)));
    (S.memberDraft?.pattern || []).forEach((p) => names.add(p));
    return [...names];
  };

  const draftFor = (id) => {
    if (S.memberDraft && S.memberDraft.id === id) return S.memberDraft;
    const base =
      id === "new"
        ? { id: "new", name: "", isSelf: false, pattern: ["Breakfast", "Lunch", "Dinner"], restrictions: [], preferences: [], target: null, linkedAccount: null }
        : structuredClone(members().find((m) => m.id === id));
    S.memberDraft = base;
    return base;
  };

  const chipEditor = (key, label, placeholder) => {
    const d = S.memberDraft;
    return h`
      <div class="jds-field">
        <span class="jds-label">${label}</span>
        ${
          d[key].length
            ? h`<div class="mls-chips">${d[key].map((v) => removableChip(v, { action: "hh-chip-remove", data: { key, value: v } }))}</div>`
            : ""
        }
        <div class="mls-inline-add">
          ${input({ id: `hm-${key}`, sm: true, placeholder, ariaLabel: `Add to ${label}` })}
          ${btn("Add", { size: "sm", icon: "plus", action: "hh-chip-add", data: { key } })}
        </div>
      </div>`;
  };

  const memberDialog = ({ memberId }) => {
    const known = memberId === "new" || members().some((m) => m.id === memberId);
    if (!known)
      return dialog({
        title: "Person not found",
        body: caption("They may have been removed."),
        foot: btn("Close", { action: "close-dialog" })
      });
    const d = draftFor(memberId);
    const macros = F.log.targets;
    return dialog({
      title: memberId === "new" ? "Add a person" : `Edit ${d.name}`,
      wide: true,
      body: h`
        <div class="mls-form">
          ${field("Name", input({ id: "hm-name", value: d.name, placeholder: "Name" }), { id: "hm-name" })}
          <div class="jds-field">
            <span class="jds-label">Meals</span>
            <div class="mls-chips" role="group" aria-label="Meals they eat">
              ${allMealNames().map((n) => chip(n, d.pattern.includes(n), { action: "hh-pattern", data: { meal: n } }))}
            </div>
            <div class="mls-inline-add">
              ${input({ id: "hm-meal", sm: true, placeholder: "Second breakfast", ariaLabel: "Name another meal" })}
              ${btn("Add", { size: "sm", icon: "plus", action: "hh-pattern-add" })}
            </div>
          </div>
          ${chipEditor("restrictions", "Never serve", "Peanuts, pork, gluten")}
          ${chipEditor("preferences", "Preferences", "Spicy food, no olives")}
          <div class="mls-form-grid">
            ${field("Calories a day", input({ id: "hm-target", value: d.target ?? "", placeholder: "Optional", num: true, inputmode: "numeric" }), { id: "hm-target" })}
            ${d.isSelf ? field("Protein a day, g", input({ id: "hm-protein", value: macros.protein, num: true, inputmode: "numeric" }), { id: "hm-protein" }) : ""}
          </div>
          ${
            d.isSelf
              ? h`<div class="mls-form-grid">
                  ${field("Carbs a day, g", input({ id: "hm-carbs", value: macros.carbs, num: true, inputmode: "numeric" }), { id: "hm-carbs" })}
                  ${field("Fat a day, g", input({ id: "hm-fat", value: macros.fat, num: true, inputmode: "numeric" }), { id: "hm-fat" })}
                </div>`
              : ""
          }
          ${
            d.isSelf
              ? ""
              : d.linkedAccount
                ? h`<div class="jds-field">
                    <span class="jds-label">Moss account</span>
                    <div class="mls-row">${caption(d.linkedAccount)}${btn("Unlink", { size: "sm", variant: "quiet", action: "hh-unlink" })}</div>
                  </div>`
                : field(
                    "Moss account",
                    h`<div class="mls-inline-add">
                      ${input({ id: "hm-account", sm: true, type: "email", placeholder: "Email of their Moss account", ariaLabel: "Email of their Moss account" })}
                      ${btn(A.phase() >= 5 ? "Invite" : "Link", { size: "sm", icon: A.phase() >= 5 ? "mail" : "link-2", action: "hh-link" })}
                    </div>`,
                    { id: "hm-account" }
                  )
          }
        </div>`,
      foot: h`
        ${memberId !== "new" && !d.isSelf ? h`<span class="mls-foot-start">${btn(`Remove ${d.name}`, { variant: "quiet", icon: "trash-2", action: "hh-member-remove", data: { member: d.id } })}</span>` : ""}
        ${btn("Cancel", { action: "hh-member-cancel" })}
        ${btn(memberId === "new" ? "Add" : "Save", { variant: "primary", action: "hh-member-save" })}`
    });
  };

  // ---------- Recipe import (phase 4) ----------

  const importDialog = () =>
    dialog({
      title: "Import a recipe",
      wide: true,
      body: h`
        <div class="mls-stack">
          ${A.reviewState() === "ai-off" ? recovery({ title: "Moss can't read recipes right now", msg: "The AI provider is not answering.", role: "status" }) : ""}
          ${field("Recipe link", input({ id: "hi-link", value: "https://example.com/recipes/sheet-pan-gnocchi", type: "url", disabled: S.importReading }), { id: "hi-link" })}
          ${S.importReading ? h`<p class="mls-row" role="status">${typing()}${caption("Reading the recipe")}</p>` : ""}
          <div class="mls-row">${btn("Use a photo instead", { size: "sm", icon: "camera", action: "hh-import-read", disabled: A.reviewState() === "ai-off" })}</div>
        </div>`,
      foot: h`${btn("Cancel", { action: "close-dialog" })}${btn("Read the recipe", { variant: "primary", action: "hh-import-read", disabled: S.importReading || A.reviewState() === "ai-off" })}`
    });

  const importReviewDialog = () =>
    dialog({
      title: "Sheet-pan gnocchi with sausage",
      desc: "30 min · Serves 4 · 9 ingredients",
      wide: true,
      body: h`
        <div class="mls-stack">
          <ul class="mls-list" role="list">
            ${["1 lb shelf-stable gnocchi", "4 Italian sausages", "1 pint cherry tomatoes", "1 red onion", "2 tbsp olive oil"].map(
              (t) => h`<li class="mls-line mls-line--plain mls-line--compact"><span class="mls-line__body">${t}</span><span></span><span></span></li>`
            )}
          </ul>
          ${caption("And 4 more")}
          <div class="jds-field">
            <span class="jds-label">Favourite of</span>
            <div class="mls-chips" role="group" aria-label="Favourite of">
              ${members().map((m) => chip(m.name, S.importFor.includes(m.id), { action: "hh-import-for", data: { member: m.id } }))}
            </div>
          </div>
        </div>`,
      foot: h`${btn("Back", { variant: "quiet", icon: "chevron-left", href: A.hrefFor("household/import") })}${btn("Save recipe", { variant: "primary", icon: "check", action: "hh-import-save" })}`
    });

  // ---------- Kitchen dialogs (phase 5) ----------

  const inviteDialog = () => {
    if (S.inviteStep === "copy") {
      const mine = S.data.pantry.filter((p) => p.section !== "Leftovers");
      return dialog({
        title: "Join Ben's Kitchen",
        desc: "Your own Kitchen is put away. Pick what to bring.",
        wide: true,
        body: h`
          <ul class="mls-list" role="list">
            ${mine.map(
              (p) => h`
                <li class="mls-line mls-line--compact">
                  ${check("", S.kitchen.copy.includes(p.id), { action: "hh-copy", data: { item: p.id }, ariaLabel: `Bring ${p.name}` })}
                  <span class="mls-line__body">${p.name}</span>
                  <span></span>
                  <span></span>
                </li>`
            )}
          </ul>`,
        foot: h`${btn("Back", { variant: "quiet", icon: "chevron-left", action: "hh-invite-back" })}${btn(S.kitchen.copy.length ? `Join and bring ${S.kitchen.copy.length}` : "Join", { variant: "primary", action: "hh-invite-join" })}`
      });
    }
    return dialog({
      title: "Ben invited you to share their Kitchen",
      desc: "Plans, the Pantry and the Shopping list become shared.",
      foot: h`${btn("Decline", { action: "hh-invite-decline" })}${btn("Accept", { variant: "primary", action: "hh-invite-accept" })}`
    });
  };

  const leaveDialog = () =>
    dialog({
      title: "Leave Ben's Kitchen?",
      desc: "Your own Kitchen comes back as you left it.",
      foot: h`${btn("Cancel", { action: "close-dialog" })}${btn("Leave", { variant: "danger", icon: "log-out", action: "hh-leave" })}`
    });

  // ---------- Routes ----------

  const base = () => "household";

  A.route("household", { render: renderHousehold, sample: "household", label: "Household", enter: () => (S.ruleOpen = null) });
  A.route("household/setup", { render: renderSetup, sample: "household/setup", label: "Household: first-run setup" });
  A.route("household/rule/:slot", {
    render: renderHousehold,
    sample: "household/rule/Lunch",
    label: "Household: Shared or Solo",
    enter: (p) => (S.ruleOpen = p.slot)
  });
  A.route("household/member/:memberId", {
    page: base,
    dialog: memberDialog,
    sample: "household/member/m-maya",
    label: "Household: edit a person",
    enter: () => (S.memberDraft = null)
  });
  A.route("household/import", {
    page: base,
    dialog: importDialog,
    sample: "household/import",
    label: "Household: import a recipe",
    phase: 4,
    enter: () => (S.importReading = false)
  });
  A.route("household/import/review", { page: base, dialog: importReviewDialog, sample: "household/import/review", label: "Household: check an imported recipe", phase: 4 });
  A.route("household/invite", {
    page: base,
    dialog: inviteDialog,
    sample: "household/invite",
    label: "Household: Kitchen invite",
    phase: 5,
    enter: () => (S.inviteStep = "ask")
  });
  A.route("household/leave", { page: base, dialog: leaveDialog, sample: "household/leave", label: "Household: leave a Kitchen", phase: 5 });

  // Setup names are read on input so a re-render keeps what was typed.
  document.addEventListener("input", (event) => {
    const i = event.target.dataset.setupName;
    if (i !== undefined) S.setup.names[Number(i)] = event.target.value;
  });

  // ---------- Actions ----------

  const value = (id) => document.getElementById(id)?.value.trim() || "";

  // Keeps typed fields when a chip re-renders the dialog.
  const keepDraft = () => {
    const d = S.memberDraft;
    if (!d) return;
    if (document.getElementById("hm-name")) d.name = value("hm-name");
    if (document.getElementById("hm-target")) {
      const t = Number(value("hm-target"));
      d.target = value("hm-target") && Number.isFinite(t) ? t : null;
    }
  };

  Object.assign(A.actions, {
    "hh-forget": (el) => {
      S.learned[el.dataset.member].splice(Number(el.dataset.index), 1);
      A.toast("Moss will stop using that.", { icon: "check" });
      A.render();
    },
    "hh-rule": (el) => {
      const r = S.data.slotRules.find((x) => x.slot === el.dataset.slot);
      r.rule = el.dataset.value;
      if (r.rule === "solo" && !r.soloDays.length) r.soloDays = WEEKDAYS.slice();
      A.render();
    },
    "hh-rule-day": (el) => {
      const r = S.data.slotRules.find((x) => x.slot === el.dataset.slot);
      const d = el.dataset.day;
      r.soloDays = r.soloDays.includes(d) ? r.soloDays.filter((x) => x !== d) : WEEKDAYS.filter((x) => x === d || r.soloDays.includes(x));
      if (!r.soloDays.length) r.rule = "shared";
      A.render();
    },
    "hh-fav-remove": (el) => {
      const { member, recipe } = el.dataset;
      S.data.favourites[member] = S.data.favourites[member].filter((r) => r !== recipe);
      A.toast(`Removed from ${A.member(member).name}'s Favourites.`, { icon: "x", tone: "drift" });
      A.render();
    },
    "hh-setup-mode": (el) => {
      S.setup.mode = el.value;
      if (el.value === "household" && S.setup.names.length < 2) S.setup.names.push("");
      A.render();
    },
    "hh-setup-add": () => {
      S.setup.names.push("");
      A.render();
      document.getElementById(`hs-name-${S.setup.names.length - 1}`)?.focus();
    },
    "hh-setup-remove": (el) => {
      S.setup.names.splice(Number(el.dataset.index), 1);
      A.render();
    },
    "hh-setup-done": () => {
      const names = (S.setup.mode === "solo" ? S.setup.names.slice(0, 1) : S.setup.names).map((n) => n.trim()).filter(Boolean);
      if (!names.length) {
        document.getElementById("hs-name-0").focus();
        return;
      }
      S.data.members = names.map((name, i) => ({
        id: i === 0 ? "m-ben" : `m-${Date.now()}-${i}`,
        name,
        isSelf: i === 0,
        pattern: ["Breakfast", "Lunch", "Dinner"],
        restrictions: [],
        preferences: [],
        target: null,
        linkedAccount: null
      }));
      S.data.members.forEach((m) => (S.data.favourites[m.id] = S.data.favourites[m.id] || []));
      A.go("household", { state: "ready" });
    },
    "hh-pattern": (el) => {
      keepDraft();
      const d = S.memberDraft;
      const n = el.dataset.meal;
      d.pattern = d.pattern.includes(n) ? d.pattern.filter((p) => p !== n) : [...d.pattern, n];
      A.render();
    },
    "hh-pattern-add": () => {
      keepDraft();
      const n = value("hm-meal");
      if (!n) return document.getElementById("hm-meal").focus();
      if (!S.memberDraft.pattern.includes(n)) S.memberDraft.pattern.push(n);
      A.render();
    },
    "hh-chip-add": (el) => {
      keepDraft();
      const key = el.dataset.key;
      const v = value(`hm-${key}`);
      if (!v) return document.getElementById(`hm-${key}`).focus();
      if (!S.memberDraft[key].includes(v)) S.memberDraft[key].push(v);
      A.render();
      document.getElementById(`hm-${key}`)?.focus();
    },
    "hh-chip-remove": (el) => {
      keepDraft();
      const { key, value: v } = el.dataset;
      S.memberDraft[key] = S.memberDraft[key].filter((x) => x !== v);
      A.render();
    },
    "hh-link": () => {
      keepDraft();
      const email = value("hm-account");
      if (!email.includes("@")) return document.getElementById("hm-account").focus();
      S.memberDraft.linkedAccount = email;
      if (A.phase() >= 5) A.toast(`Invite sent to ${email}.`, { icon: "mail" });
      A.render();
    },
    "hh-unlink": () => {
      keepDraft();
      S.memberDraft.linkedAccount = null;
      A.render();
    },
    "hh-member-cancel": () => {
      S.memberDraft = null;
      A.closeDialog();
    },
    "hh-member-save": () => {
      keepDraft();
      const d = S.memberDraft;
      if (!d.name) return document.getElementById("hm-name").focus();
      if (d.id === "new") {
        const id = `m-${Date.now()}`;
        S.data.members.push({ ...d, id });
        S.data.favourites[id] = [];
        A.toast(`${d.name} added.`, { icon: "user-plus" });
      } else {
        Object.assign(
          S.data.members.find((m) => m.id === d.id),
          d
        );
      }
      S.memberDraft = null;
      A.go("household");
    },
    "hh-member-remove": (el) => {
      const m = A.member(el.dataset.member);
      S.memberUndo = structuredClone(S.data.members);
      S.data.members = S.data.members.filter((x) => x.id !== m.id);
      S.memberDraft = null;
      A.toast(`${m.name} removed.`, { icon: "trash-2", tone: "drift", undo: "hh-member-undo", ms: 7000 });
      A.go("household");
    },
    "hh-member-undo": () => {
      if (!S.memberUndo) return;
      S.data.members = S.memberUndo;
      S.memberUndo = null;
      A.toast("Put back.", { icon: "undo-2", tone: "drift" });
      A.render();
    },
    "hh-import-read": () => {
      S.importReading = true;
      A.render();
      setTimeout(() => {
        S.importReading = false;
        if (A.current().path === "household/import") A.go("household/import/review");
      }, 1400);
    },
    "hh-import-for": (el) => {
      const id = el.dataset.member;
      S.importFor = S.importFor.includes(id) ? S.importFor.filter((x) => x !== id) : [...S.importFor, id];
      A.render();
    },
    "hh-import-save": () => {
      S.data.recipes["r-imported"] = { title: "Sheet-pan gnocchi with sausage", minutes: 30, baseServings: 4, kcal: 640, ingredients: [], steps: [] };
      S.importFor.forEach((id) => S.data.favourites[id].push("r-imported"));
      A.toast("Recipe saved. Moss can plan it now.", { icon: "check" });
      A.go("household");
    },
    "hh-invite-cancel": () => {
      S.kitchen.invitePending = null;
      A.toast("Invite cancelled.", { icon: "x", tone: "drift" });
      A.render();
    },
    "hh-kitchen-remove": () => {
      S.kitchen.joined = false;
      A.toast("Maya left the Kitchen. Her own Kitchen is back.", { icon: "log-out", tone: "drift" });
      A.render();
    },
    "hh-invite-accept": () => {
      S.inviteStep = "copy";
      A.render();
    },
    "hh-invite-back": () => {
      S.inviteStep = "ask";
      A.render();
    },
    "hh-invite-decline": () => {
      A.toast("Invite declined.", { icon: "x", tone: "drift" });
      A.go("household");
    },
    "hh-copy": (el) => {
      const id = el.dataset.item;
      S.kitchen.copy = el.checked ? [...S.kitchen.copy, id] : S.kitchen.copy.filter((x) => x !== id);
      A.render();
    },
    "hh-invite-join": () => {
      S.kitchen.joined = true;
      A.toast("You joined Ben's Kitchen.", { icon: "users" });
      A.go("household");
    },
    "hh-leave": () => {
      S.kitchen.joined = false;
      A.toast("Your own Kitchen is back.", { icon: "log-out", tone: "drift" });
      A.go("household");
    }
  });
})();
