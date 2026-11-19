/* global document, window */
// The Finance settings screen, opened from the cog in the Finance header.
import { moduleClient } from "./guest-bridge.mjs";
import { financeApi } from "./api.mjs";
import { esc, button, badge, sectionHead, masthead, note, loadingLine, errorState } from "./html.mjs";
import { actorLabel, tierLabel, weekWindow } from "./settings-model.mjs";

const client = moduleClient();
const api = financeApi(client);
const root = document.getElementById("root");

const state = { setup: null, rules: null, categories: [], activity: null, error: false, message: "", busy: "" };
let seq = 0;

const row = (title, body, aside = "") =>
  `<li class="fnm-row"><div class="fnm-txmain"><strong>${esc(title)}</strong>${body ? `<span class="jds-hint">${esc(body)}</span>` : ""}</div>${aside}</li>`;

function view() {
  if (state.error) return errorState("Your settings can't be edited until both are confirmed.", button("Try again", { act: "reload" }));
  if (!state.setup) return loadingLine("Loading settings");
  const t = state.setup.tiers;
  const tiers = `<ul class="fnm-feed">${row("Sort purchases from merchants you've seen", "", badge(tierLabel(t.sorting)))}${row("Sort purchases from new merchants", "", badge(tierLabel(t.sortingNew)))}</ul>`;
  const bank = state.setup.keysConfigured
    ? "Bank keys are saved. Each person connects their own bank from Accounts."
    : "No bank keys are saved yet. An admin adds them in the admin module settings.";
  const names = new Map(state.categories.map((c) => [c.id, c.name]));
  const rules = (state.rules ?? []).length
    ? `<ul class="fnm-feed">${state.rules.map((r) => row(r.payeeKey, `Goes to ${names.get(r.categoryId) ?? "an archived category"}`, badge(r.enabled ? "On" : "Off", r.enabled ? "success" : "neutral"))).join("")}</ul>`
    : `<p class="jds-hint">No merchant rules yet.</p>`;
  const act = (state.activity ?? []).length
    ? `<ul class="fnm-feed">${state.activity.map((a) => row(a.summary, `${actorLabel(a.actor)} · ${new Date(a.at).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" })}${a.undone ? " · Undone" : ""}`, a.undoable ? button("Undo", { act: "undo", variant: "quiet", extra: ` data-id="${esc(a.id)}"${state.busy ? " disabled" : ""}` }) : "")).join("")}</ul>`
    : `<p class="jds-hint">Nothing has changed this week.</p>`;
  return `${masthead({ eyebrowText: "Finance", title: "Settings" })}${state.message ? note("info", state.message) : ""}${sectionHead("How much Moss does alone")}${tiers}${sectionHead("Bank connection", "Admins only")}<p>${esc(bank)}</p>${sectionHead("Merchant rules")}${rules}${sectionHead("Activity", "This week")}${act}`;
}

function render() {
  root.innerHTML = view();
  void client.resize(Math.ceil(document.documentElement.scrollHeight)).catch(() => {});
}

async function load() {
  const mine = ++seq;
  state.error = false;
  try {
    const { from, to } = weekWindow();
    const [setup, rules, ctx, activity] = await Promise.all([
      api.call("GET", "/finance/setup/status"),
      api.call("GET", "/finance/rules?limit=200"),
      api.call("GET", "/finance/manual/context"),
      api.call("GET", `/finance/activity?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&limit=50`)
    ]);
    if (mine !== seq) return;
    Object.assign(state, { setup, rules: rules.rules, categories: ctx.categories ?? [], activity: activity.activity });
  } catch {
    if (mine === seq) state.error = true;
  }
  render();
}

root.addEventListener("click", (event) => {
  const el = event.target instanceof window.Element ? event.target.closest("[data-act]") : null;
  if (!el) return;
  if (el.dataset.act === "reload") return void load();
  if (el.dataset.act === "undo") {
    state.busy = el.dataset.id;
    state.message = "";
    render();
    void api
      .call("POST", "/finance/activity/undo", { activityId: el.dataset.id })
      .then(() => ((state.busy = ""), load()))
      .catch(() => {
        state.busy = "";
        state.message = "Couldn't undo that. It may have changed since.";
        render();
      });
  }
});

render();
void load();
