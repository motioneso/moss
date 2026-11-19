import { dayTitle, esc, failureText, isReplaceable, isShown, titleCase } from "./format.mjs";
import { badge, btn, indicator, recovery, sectionHead, select } from "./kit.mjs";

const COOK_LIMITS = [15, 20, 30, 45, 60, 90, 120];
const DOUBLE_CHECK = "Always double check.";

function fit(meal) {
  const rows = meal.eaters.filter((eater) => eater.fit !== null);
  if (rows.length === 0) return "";
  return `<div class="mls-fit">${rows
    .map((eater) => {
      const f = eater.fit;
      const percent = Math.min(100, Math.round((f.estimatedKcal / f.targetKcal) * 100));
      return `<span class="mls-fit__name jds-caption" title="${esc(eater.name)}">${esc(eater.name)}</span><div class="jds-progress${f.band === "over" ? " jds-progress--amber" : ""}" role="meter" aria-valuemin="0" aria-valuemax="${f.targetKcal}" aria-valuenow="${f.estimatedKcal}" aria-label="${esc(`${eater.name}: ${f.estimatedKcal} of ${f.targetKcal} kcal`)}"><div class="jds-progress__fill" style="width:${percent}%"></div></div><span class="mls-num jds-caption">${f.estimatedKcal} / ${f.targetKcal}</span>`;
    })
    .join("")}</div>`;
}

function safety(meal) {
  const failed = meal.eaters.filter((eater) => eater.safety === "fail");
  const reasons = meal.eaters.flatMap((eater) =>
    eater.safetyReason ? [`${eater.name}: ${eater.safetyReason}`] : []
  );
  const checked = meal.eaters.some((eater) => eater.safety === "pass");
  if (failed.length === 0 && !checked && meal.checkLabelCount === 0) return "";
  const lead =
    failed.length > 0
      ? `Found something from the Never serve list for ${failed.map((e) => e.name).join(" and ")}.`
      : "Nothing from the Never serve list was found outright.";
  const label =
    meal.checkLabelCount === 0
      ? ""
      : meal.checkLabelCount === 1
        ? " Check the label on 1 ingredient."
        : ` Check the label on ${meal.checkLabelCount} ingredients.`;
  return `<p class="mls-safety jds-caption">${esc(
    `${lead}${reasons.length > 0 ? ` ${reasons.join(". ")}` : ""}${label} ${DOUBLE_CHECK}`
  )}</p>`;
}

function mealTools(meal, busy) {
  if (meal.cookedAt !== null || meal.kind !== "recipe") return "";
  const d = `data-meal="${esc(meal.mealId)}"`;
  const tool = (label, act) =>
    btn(label, act, { variant: "quiet", sm: true, disabled: busy, data: d });
  return `<div class="mls-meal__tools">${tool(meal.locked ? "Unlock" : "Lock", meal.locked ? "unlock" : "lock")}${tool("Quick swap", "quick-swap")}${
    isReplaceable(meal) ? tool("Regenerate", "regen-meal") : ""
  }</div>`;
}

function meal(m, writes, busy) {
  if (m.status === "failed") {
    const blocked = m.eaters.flatMap((e) =>
      e.safety === "fail" && e.safetyReason ? [`${e.name}: ${e.safetyReason}.`] : []
    );
    const message = [failureText(m.failureReason), ...blocked].filter(Boolean).join(" ");
    const retry =
      writes && isReplaceable(m)
        ? btn("Retry", "regen-meal", {
            variant: "secondary",
            sm: true,
            disabled: busy,
            data: `data-meal="${esc(m.mealId)}"`
          })
        : "";
    return `<div class="mls-meal">${recovery(`No ${esc(m.slotName)} yet`, message ? esc(message) : null, retry)}</div>`;
  }
  if (!isShown(m)) {
    const writing = m.status === "writing";
    return `<div class="mls-meal" role="status"><span class="mls-writing">${indicator(
      writing ? "ready" : "idle",
      writing ? "Writing" : "Waiting",
      writing
    )}</span></div>`;
  }
  const servings = m.servings % 1 === 0 ? m.servings : m.servings.toFixed(1);
  const head =
    m.kind === "recipe" && m.title !== null
      ? `<div class="mls-row"><a class="mls-meal__title" href="#" data-act="open-recipe" data-meal="${esc(m.mealId)}">${esc(m.title)}</a>${m.locked ? badge("Locked", { outline: true }) : ""}</div>`
      : `<p class="mls-meal__text">${esc(m.plainText)}</p>`;
  return `<article class="mls-meal">${head}${fit(m)}${safety(m)}<p class="mls-meal__meta jds-caption">${
    m.eaters.length > 0 ? `<span>${esc(m.eaters.map((e) => e.name).join(", "))}</span>` : ""
  }<span>Serves ${servings}</span>${m.cookMinutes !== null ? `<span>${m.cookMinutes}&nbsp;min</span>` : ""}</p>${
    writes ? mealTools(m, busy) : ""
  }</article>`;
}

function dayTools(day, busy, ui) {
  const people = new Map();
  for (const m of day.meals) for (const e of m.eaters) people.set(e.memberId, e.name);
  const slots = [...new Set(day.meals.map((m) => m.slotName))];
  const known = COOK_LIMITS.includes(day.cookTimeLimitMinutes);
  const limits = [
    ["", "No cook-time limit"],
    ...COOK_LIMITS.map((n) => [String(n), `${n} min limit`]),
    ...(day.cookTimeLimitMinutes !== null && !known
      ? [[String(day.cookTimeLimitMinutes), `${day.cookTimeLimitMinutes} min limit`]]
      : [])
  ];
  const slot = ui.oneOffSlot[day.dayId] ?? slots[0] ?? "dinner";
  const member = ui.oneOffMember[day.dayId] ?? [...people.keys()][0] ?? "";
  return `<div class="mls-row">${select(
    `limit-${day.dayId}`,
    limits,
    day.cookTimeLimitMinutes === null ? "" : String(day.cookTimeLimitMinutes),
    { label: "Cook-time limit", disabled: busy, model: `limit:${day.dayId}` }
  )}${
    slots.length > 0 && people.size > 0
      ? `${select(
          `slot-${day.dayId}`,
          slots.map((s) => [s, titleCase(s)]),
          slot,
          { label: "One-off meal slot", disabled: busy, model: `slot:${day.dayId}` }
        )}${select(`who-${day.dayId}`, [...people.entries()], member, {
          label: "One-off meal for",
          disabled: busy,
          model: `who:${day.dayId}`
        })}${btn("Add One-off", "one-off", { variant: "quiet", sm: true, disabled: busy || member === "", data: `data-day="${esc(day.dayId)}"` })}`
      : ""
  }</div>`;
}

function groups(meals) {
  const map = new Map();
  for (const m of meals) map.set(m.slotName, [...(map.get(m.slotName) ?? []), m]);
  return [...map.entries()];
}

export function daySection({ day, index, today, planActive, showSharing, writes, busy, ui }) {
  const isToday = day.date === today;
  const title = dayTitle(day.date);
  let meta = "";
  if (day.status === "writing") meta = indicator("ready", "Writing", true);
  else if (day.status === "pending" && planActive) meta = indicator("idle", "Waiting");
  else if (day.status === "pending") meta = '<span class="jds-caption">Not written</span>';
  else if (isToday) meta = badge("Today", { tone: "forest" });
  if (writes && day.status === "ready" && day.meals.some(isReplaceable)) {
    const regen = btn("Regenerate day", "regen-day", {
      variant: "quiet",
      sm: true,
      disabled: busy,
      data: `data-day="${esc(day.dayId)}"`
    });
    meta = meta ? `<span class="mls-row">${meta}${regen}</span>` : regen;
  }
  const head = sectionHead(esc(title), {
    number: String(index + 1).padStart(2, "0"),
    meta,
    level: 3
  });
  const cls = isToday ? "mls-day mls-day--today" : "mls-day";
  const unwritten = day.meals.some((m) => m.status === "pending" || m.status === "writing");
  const dayCard =
    day.status === "failed" && (day.meals.length === 0 || unwritten)
      ? recovery(
          `Moss could not finish ${esc(title.split(",")[0])}`,
          failureText(day.failureReason),
          writes
            ? btn("Retry", "retry-day", {
                variant: "secondary",
                sm: true,
                data: `data-day="${esc(day.dayId)}"`
              })
            : ""
        )
      : "";
  if (dayCard && day.meals.length === 0) {
    return `<section class="${cls}" aria-label="${esc(title)}">${head}${dayCard}</section>`;
  }
  const totals = day.dayFit.flatMap((entry) => {
    const name = day.meals
      .flatMap((m) => m.eaters)
      .find((e) => e.memberId === entry.memberId)?.name;
    return name ? [{ name, fit: entry.fit }] : [];
  });
  const slots = groups(day.meals);
  return `<section class="${cls}" aria-label="${esc(title)}">${head}${dayCard}${
    totals.length > 0
      ? `<div class="mls-day__totals">${totals
          .map(
            (t) =>
              `<span class="jds-caption"><strong>${esc(t.name)}</strong> <span class="mls-num">${t.fit.estimatedKcal.toLocaleString("en-US")} of ${t.fit.targetKcal.toLocaleString("en-US")}&nbsp;kcal</span></span>`
          )
          .join("")}</div>`
      : ""
  }${writes ? dayTools(day, busy, ui) : ""}${
    slots.length > 0
      ? `<div class="mls-slots" style="--mls-slot-count:${slots.length}">${slots
          .map(([slot, meals]) => {
            const solo = meals.length > 1 || meals[0]?.sharing === "solo";
            return `<div class="mls-slot"><div class="mls-slot__label"><p class="jds-eyebrow jds-eyebrow--strong">${esc(titleCase(slot))}</p>${
              showSharing ? `<span class="jds-caption">${solo ? "Solo" : "Shared"}</span>` : ""
            }${
              writes
                ? btn(solo ? "Make Shared" : "Make Solo", "sharing", {
                    variant: "quiet",
                    sm: true,
                    disabled: busy,
                    data: `data-day="${esc(day.dayId)}" data-slot="${esc(slot)}" data-to="${solo ? "shared" : "solo"}"`
                  })
                : ""
            }</div>${meals.map((m) => meal(m, writes, busy)).join("")}</div>`;
          })
          .join("")}</div>`
      : ""
  }</section>`;
}
