import { noticeFor } from "./api.mjs";
import {
  dailyTarget,
  esc,
  joinTitled,
  sharingRule,
  slotsEaten,
  titleCase,
  words
} from "./format.mjs";
import {
  avatar,
  badge,
  btn,
  caption,
  dialog,
  empty,
  eyebrow,
  field,
  hint,
  input,
  sectionHead
} from "./kit.mjs";

const emptyForm = { name: "", never: "", likes: "", meals: "", calories: "" };

function formOf(member) {
  if (member === null) return { ...emptyForm };
  return {
    name: member.name,
    never: member.restrictions.join(", "),
    likes: member.preferences.join(", "),
    meals: member.mealPattern.join(", "),
    calories: member.calorieTarget != null ? String(member.calorieTarget) : ""
  };
}

/** The Household area: everyone at the table, what each person eats, and who eats together. */
export function householdScreen(ctx) {
  const s = {
    kind: "loading",
    kitchen: null,
    busy: false,
    failed: null,
    editing: null,
    removing: null,
    form: { ...emptyForm },
    problem: null
  };

  async function load() {
    try {
      s.kitchen = await ctx.api.read("meals.kitchen.get", {});
      s.kind = "ready";
    } catch {
      if (s.kind !== "ready") s.kind = "error";
    }
    ctx.draw();
  }

  async function write(tool, params, options) {
    s.busy = true;
    s.failed = null;
    ctx.draw();
    const outcome = await ctx.api.write(tool, params, options);
    s.busy = false;
    if (outcome.kind !== "succeeded") s.failed = noticeFor(outcome);
    return outcome.kind === "succeeded";
  }

  function save() {
    if (s.busy) return;
    const f = s.form;
    if (f.name.trim() === "") {
      s.problem = "Enter a name first";
      ctx.draw();
      return;
    }
    const target = f.calories.trim() === "" ? null : Number(f.calories.trim());
    if (target !== null && (!Number.isInteger(target) || target < 800 || target > 6000)) {
      s.problem = "Enter a daily calorie target from 800 to 6000, or leave it blank";
      ctx.draw();
      return;
    }
    const member = s.editing === "new" ? null : s.editing;
    const mealPattern = words(f.meals);
    const params = {
      ...(member === null ? {} : { memberId: member.memberId }),
      name: f.name.trim(),
      restrictions: words(f.never),
      ...(member !== null || f.likes.trim() !== "" ? { preferences: words(f.likes) } : {}),
      ...(mealPattern.length > 0 ? { mealPattern } : {}),
      ...(member !== null || target !== null ? { calorieTarget: target } : {})
    };
    void write("meals.household.save", params).then(async (done) => {
      if (done) {
        s.editing = null;
        s.problem = null;
        await load();
      } else ctx.draw();
    });
  }

  const acts = {
    "retry-load": () => {
      s.kind = "loading";
      ctx.draw();
      void load();
    },
    "add-person": () => {
      s.editing = "new";
      s.form = formOf(null);
      s.problem = null;
      ctx.draw();
    },
    "edit-person": (el) => {
      s.editing = s.kitchen.members.find((m) => m.memberId === el.dataset.member) ?? null;
      s.form = formOf(s.editing);
      s.problem = null;
      ctx.draw();
    },
    "remove-person": (el) => {
      s.removing = s.kitchen.members.find((m) => m.memberId === el.dataset.member) ?? null;
      ctx.draw();
    },
    "confirm-remove": async () => {
      const member = s.removing;
      s.removing = null;
      if (member === null) return;
      if (
        await write("meals.household.remove", { memberId: member.memberId }, { confirmed: true })
      ) {
        await load();
      } else ctx.draw();
    },
    "save-person": save,
    "dialog-close": () => {
      s.editing = null;
      s.removing = null;
      s.problem = null;
      ctx.draw();
    }
  };

  function input_(name, value) {
    const key = {
      "p-name": "name",
      "p-never": "never",
      "p-likes": "likes",
      "p-meals": "meals",
      "p-calories": "calories"
    }[name];
    if (key) s.form[key] = value;
  }

  function facts(member) {
    const target = dailyTarget(member);
    const never =
      member.restrictions.length > 0
        ? `<span class="mls-chips">${member.restrictions.map((item) => badge(esc(item), { tone: "red" })).join("")}</span>`
        : "Nothing";
    return `<dl class="mls-facts"><dt class="jds-caption">Meals</dt><dd>${
      member.mealPattern.length > 0 ? esc(joinTitled(member.mealPattern)) : "None"
    }</dd><dt class="jds-caption">Never serve</dt><dd>${never}</dd><dt class="jds-caption">Preferences</dt><dd>${
      member.preferences.length > 0 ? esc(member.preferences.join(", ")) : "None yet"
    }</dd><dt class="jds-caption">Daily target</dt><dd>${esc(target ?? "None")}</dd><dt class="jds-caption">Moss account</dt><dd>${
      member.isSelf ? "You" : esc(member.linkedAccountEmail ?? "Not linked")
    }</dd></dl>`;
  }

  function person(member) {
    const d = `data-member="${esc(member.memberId)}"`;
    const quiet = (label, act) =>
      btn(label, act, {
        variant: "quiet",
        sm: true,
        disabled: s.busy,
        data: `${d} aria-label="${label} ${esc(member.name)}"`
      });
    return `<li class="mls-member">${avatar(member.name)}<div class="mls-stack mls-stack--tight"><div class="mls-row"><h3 class="jds-card-title">${esc(member.name)}</h3>${
      member.isSelf && member.name !== "You" ? badge("You") : ""
    }</div>${facts(member)}</div>${quiet("Edit", "edit-person")}${
      member.isSelf ? "<span></span>" : quiet("Remove", "remove-person")
    }</li>`;
  }

  function together(kitchen) {
    const rows = slotsEaten(kitchen.members)
      .map((slot) => {
        const eaters = kitchen.members.filter((m) => m.mealPattern.includes(slot));
        const rule = kitchen.slotRules.find((entry) => entry.slotName === slot);
        return `<dt class="jds-caption">${esc(titleCase(slot))}</dt><dd>${
          eaters.length === 1 ? `Only ${esc(eaters[0].name)}` : esc(sharingRule(rule))
        }</dd>`;
      })
      .join("");
    return `<section class="mls-stack">${sectionHead("Who eats together", { number: "02", rule: true })}<dl class="mls-facts">${rows}</dl></section>`;
  }

  function personDialog() {
    const member = s.editing === "new" ? null : s.editing;
    const f = s.form;
    const body = `<div class="mls-form">${field("p-name", "Name", input("p-name", f.name, { label: "Name", extra: 'maxlength="80"' }))}${field(
      "p-never",
      "Never serve",
      input("p-never", f.never, { label: "Never serve", placeholder: "peanuts, shellfish" })
    )}${field("p-likes", "Preferences", input("p-likes", f.likes, { label: "Preferences", placeholder: "vegetarian, no mushrooms" }))}<div class="mls-form-grid">${field(
      "p-meals",
      "Meals a day",
      input("p-meals", f.meals, { label: "Meals a day", placeholder: "breakfast, lunch, dinner" })
    )}${field(
      "p-calories",
      "Daily calories",
      input("p-calories", f.calories, {
        label: "Daily calories",
        placeholder: "Optional",
        extra: 'inputmode="numeric"'
      })
    )}</div>${s.problem ? hint(s.problem) : ""}</div>`;
    return dialog({
      id: "mls-person",
      title: member === null ? "Add a person" : `Edit ${esc(member.name)}`,
      body,
      footer: `${btn("Cancel", "dialog-close", { variant: "secondary" })}${btn("Save", "save-person", { disabled: s.busy })}`
    });
  }

  function removeDialog() {
    return dialog({
      id: "mls-remove",
      title: `Remove ${esc(s.removing.name)}`,
      body: "<p>They are taken off the household and out of the plans they eat in. This cannot be undone here.</p>",
      footer: `${btn("Cancel", "dialog-close", { variant: "secondary" })}${btn("Remove", "confirm-remove", { variant: "danger", disabled: s.busy })}`
    });
  }

  function render() {
    if (s.kind === "loading") return caption("Loading the household", ' role="status"');
    if (s.kind === "error") {
      return empty(
        "Couldn't load the household",
        "",
        btn("Try again", "retry-load", { variant: "secondary" })
      );
    }
    const kitchen = s.kitchen;
    const count = kitchen.members.length;
    return `<div class="mls-stack"><div class="mls-grid"><div class="mls-stack"><section class="mls-stack">${sectionHead(
      "People",
      {
        number: "01",
        meta: count === 1 ? "1 person" : `${count} people`,
        rule: true
      }
    )}${s.failed ? caption(esc(s.failed), ' role="alert"') : ""}<ul class="mls-members">${kitchen.members.map(person).join("")}</ul></section>${
      count > 1 ? together(kitchen) : ""
    }</div><aside class="mls-rail"><div class="mls-stack mls-stack--tight">${eyebrow("At the table")}<ul class="mls-table">${kitchen.members
      .map(
        (m) =>
          `<li><span>${esc(m.name)}</span><span class="jds-caption">${
            m.mealPattern.length === 1 ? "1 meal a day" : `${m.mealPattern.length} meals a day`
          }</span></li>`
      )
      .join("")}</ul></div>${btn("Add person", "add-person", { disabled: s.busy })}</aside></div>${
      s.editing !== null ? personDialog() : ""
    }${s.removing !== null ? removeDialog() : ""}</div>`;
  }

  return {
    start: () => {
      s.editing = null;
      s.removing = null;
      s.failed = null;
      void load();
    },
    render,
    acts,
    input: input_
  };
}
