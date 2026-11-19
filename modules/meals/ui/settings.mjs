/* global document */
import { moduleClient } from "./guest-bridge.mjs";
import { mealsApi, noticeFor } from "./api.mjs";
import { esc } from "./format.mjs";
import { btn, caption, empty, sectionHead } from "./kit.mjs";

const client = moduleClient();
const api = mealsApi(client);
const root = document.getElementById("root");

const UNITS = [
  ["us", "US"],
  ["metric", "Metric"]
];

const PANTRY = [
  ["ignore", "Ignore the Pantry", "Plan freely and buy everything."],
  ["prefer", "Prefer what's on hand", "Use what you have first."],
  ["only", "Only what's on hand", "A clear-out week. Buy nothing new."]
];

let state = { kind: "loading" };
let saving = false;
let failed = null;

const masthead =
  '<header class="jds-masthead jds-masthead--compact"><div class="jds-masthead__row"><div class="jds-masthead__main"><h1 class="jds-masthead__title"><span>Settings</span></h1></div></div></header>';

function units(value) {
  return `<div class="jds-segmented" role="group" aria-label="Units">${UNITS.map(
    ([v, text]) =>
      `<button type="button" class="jds-segmented__opt" aria-pressed="${v === value}" data-act="units" data-value="${v}"${saving ? " disabled" : ""}>${text}</button>`
  ).join("")}</div>`;
}

function pantry(value) {
  return `<div class="jds-radio-cards" role="radiogroup" aria-label="Pantry mode for new plans"${saving ? ' aria-disabled="true"' : ""}>${PANTRY.map(
    ([v, label, text]) =>
      `<label class="jds-radio-card"><input type="radio" name="meals-pantry-mode" value="${v}" data-act="pantry"${value === v ? " checked" : ""}${saving ? " disabled" : ""}><span class="jds-radio-card__label">${esc(label)}</span><span class="jds-radio-card__description">${esc(text)}</span></label>`
  ).join("")}</div>`;
}

function body() {
  if (state.kind === "loading") return caption("Loading settings", ' role="status"');
  if (state.kind === "error") {
    return empty("Couldn't load settings", "", btn("Try again", "retry", { variant: "secondary" }));
  }
  const k = state.kitchen;
  return `${failed ? caption(esc(failed), ' role="alert"') : ""}<section class="mls-stack mls-stack--tight">${sectionHead("Units", { rule: true })}${units(k.unitsSystem)}</section><section class="mls-stack mls-stack--tight">${sectionHead("Pantry mode for new plans", { rule: true })}${pantry(k.defaultPantryMode)}</section>`;
}

function draw() {
  root.innerHTML = `<div class="mls-stack">${masthead}${body()}</div>`;
  void client.resize(document.documentElement.scrollHeight).catch(() => {});
}

async function load() {
  try {
    const kitchen = await api.read("meals.kitchen.get", {});
    state = { kind: "ready", kitchen };
  } catch {
    state = { kind: "error" };
  }
  draw();
}

async function save(patch) {
  if (saving) return;
  saving = true;
  failed = null;
  draw();
  const outcome = await api.write("meals.kitchen.save", patch);
  saving = false;
  if (outcome.kind !== "succeeded") failed = noticeFor(outcome);
  await load();
}

root.addEventListener("click", (event) => {
  const el = event.target.closest("[data-act]");
  if (!el || el.disabled) return;
  if (el.dataset.act === "retry") {
    state = { kind: "loading" };
    draw();
    void load();
  } else if (el.dataset.act === "units") void save({ unitsSystem: el.dataset.value });
});

root.addEventListener("change", (event) => {
  const el = event.target;
  if (el.dataset?.act === "pantry") void save({ defaultPantryMode: el.value });
});

draw();
void load();
