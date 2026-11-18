/* global document */
import { moduleClient } from "./guest-bridge.mjs";
import { weatherApi } from "./api.mjs";
import { locationHint, unitDescription, savedMessage, readBrowserPosition } from "./view.mjs";

const api = weatherApi(moduleClient());
const root = document.getElementById("root");

const state = {
  phase: "loading",
  location: null,
  unit: "imperial",
  source: null,
  search: "",
  candidates: [],
  searched: false,
  busy: false,
  finding: false,
  note: "",
  noteTone: "ready"
};

const esc = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
  );

function render() {
  if (state.phase === "loading") {
    root.innerHTML = `<section class="pane__card" aria-busy="true"><p class="pane__carddesc" role="status">Loading weather settings…</p></section>`;
    return;
  }
  if (state.phase === "error") {
    root.innerHTML = `<section class="pane__card"><header class="pane__cardhead"><div class="pane__cardheadmain"><h3 class="pane__cardtitle">Weather</h3></div></header>
      <p class="pane__carddesc" role="status">Weather settings couldn't load.</p>
      <button type="button" class="jds-btn jds-btn--sm" id="retry">Try again</button></section>`;
    document.getElementById("retry").onclick = load;
    return;
  }
  const disabled = state.busy || state.finding ? "disabled" : "";
  const unitOpt = (value, label) =>
    `<button type="button" class="jds-segmented__opt" data-unit="${value}" aria-pressed="${state.unit === value}" ${state.busy ? "disabled" : ""}>${label}</button>`;
  const searchEmpty = !state.search.trim();
  root.innerHTML = `
  <section class="pane__card">
    <header class="pane__cardhead"><div class="pane__cardheadmain">
      <h3 class="pane__cardtitle">Weather</h3>
      <div class="pane__carddesc">Temperatures on Today and in the briefing, and the place they are for.</div>
    </div></header>
    <div class="pane__cardbody">
      <div class="set-row">
        <div class="set-row__main">
          <div class="set-row__name">Unit</div>
          <div class="set-row__desc">${esc(unitDescription(state.unit))}</div>
        </div>
        <div class="set-row__control">
          <div class="jds-segmented" role="group" aria-label="Unit">${unitOpt("imperial", "Fahrenheit")}${unitOpt("metric", "Celsius")}</div>
        </div>
      </div>
      <div class="fld">
        <div class="fld__lbl" id="loc-lbl">Location</div>
        <div class="fld__row" role="group" aria-labelledby="loc-lbl">
          <button type="button" class="jds-btn jds-btn--sm" id="find" ${disabled}>${state.finding ? "Finding you..." : "Use my location"}</button>
          <input class="jds-input" id="query" value="${esc(state.search)}" aria-label="Search for a weather location" placeholder="Or search: city, region, or country" ${disabled} />
          <button type="button" class="jds-btn jds-btn--sm" id="go" ${searchEmpty || state.busy || state.finding ? "disabled" : ""}>Search</button>
        </div>
        <div class="fld__hint">${esc(locationHint(state.location, state.source))}</div>
      </div>
      ${state.candidates
        .map(
          (
            c,
            i
          ) => `<div class="set-row"><div class="set-row__main"><div class="set-row__name">${esc(c.label)}</div></div>
          <div class="set-row__control"><button type="button" class="jds-btn jds-btn--sm" data-pick="${i}" ${state.busy ? "disabled" : ""}>Use this place</button></div></div>`
        )
        .join("")}
      ${state.searched && !state.candidates.length ? `<p class="fld__hint" role="status">No places matched that search.</p>` : ""}
      ${state.note ? `<p class="weather-note weather-note--${state.noteTone}" role="status">${esc(state.note)}</p>` : ""}
    </div>
  </section>`;
  for (const b of root.querySelectorAll("[data-unit]")) b.onclick = () => setUnit(b.dataset.unit);
  for (const b of root.querySelectorAll("[data-pick]")) {
    b.onclick = () => save(state.candidates[Number(b.dataset.pick)], "search");
  }
  const query = document.getElementById("query");
  query.oninput = () => {
    state.search = query.value;
    document.getElementById("go").disabled = !state.search.trim() || state.busy || state.finding;
  };
  query.onkeydown = (e) => {
    if (e.key === "Enter" && state.search.trim()) runSearch();
  };
  document.getElementById("go").onclick = runSearch;
  document.getElementById("find").onclick = useMyLocation;
}

const fail = (error) => {
  state.note = error instanceof Error && error.message ? error.message : "Weather request failed";
  state.noteTone = "drift";
};

async function run(work) {
  state.busy = true;
  state.note = "";
  render();
  try {
    await work();
  } catch (error) {
    fail(error);
  }
  state.busy = false;
  state.finding = false;
  render();
}

async function load() {
  state.phase = "loading";
  render();
  try {
    const [location, unit] = await Promise.all([api.location(), api.unit()]);
    state.location = location.location ?? null;
    state.unit = unit.unit === "metric" ? "metric" : "imperial";
    state.phase = "ready";
  } catch {
    state.phase = "error";
  }
  render();
}

const runSearch = () =>
  run(async () => {
    const found = await api.search(state.search.trim());
    state.candidates = found.candidates ?? [];
    state.searched = true;
  });

const save = (place, source) =>
  run(async () => {
    const saved = await api.saveLocation(place);
    state.location = saved.location ?? null;
    state.source = state.location ? source : null;
    state.candidates = [];
    state.searched = false;
    state.note = savedMessage(state.location);
    state.noteTone = "ready";
  });

const setUnit = (unit) =>
  run(async () => {
    const saved = await api.saveUnit(unit);
    state.unit = saved.unit === "metric" ? "metric" : "imperial";
  });

async function useMyLocation() {
  state.finding = true;
  state.note = "";
  render();
  try {
    const position = await readBrowserPosition();
    const { location } = await api.reverse(position.coords.latitude, position.coords.longitude);
    state.finding = false;
    await save(location, "auto");
  } catch (error) {
    state.finding = false;
    fail(error);
    render();
  }
}

load();
